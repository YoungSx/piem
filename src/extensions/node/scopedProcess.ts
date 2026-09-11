import { EXTENSION_CONFIG_ROOT } from "../extensionConfigStore";
import { unavailable } from "./unavailable";

const MAX_KEYS = 64;
const MAX_VALUE_BYTES = 4096;
const MAX_TOTAL_BYTES = 16_384;
let nextPid = 0;

/** A private environment and identity; neither reads nor changes the real process. */
export function createScopedProcess(assertActive: () => void) {
	const values = Object.create(null) as Record<string, string>;
	const encoder = new TextEncoder();
	const byteLength = (text: string): number => encoder.encode(text).byteLength;
	let totalBytes = 0;
	const write = (key: PropertyKey, value: unknown): true => {
		assertActive();
		if (typeof key !== "string" || typeof value === "symbol") throw new TypeError("Environment keys and values must convert to strings.");
		const text = String(value);
		// Conversion can call extension code, which may have disposed this scope.
		assertActive();
		if (key.length > MAX_TOTAL_BYTES || text.length > MAX_VALUE_BYTES || byteLength(text) > MAX_VALUE_BYTES) throw new RangeError("Extension environment value exceeds its byte limit.");
		const previous = values[key];
		if (previous === undefined && Object.keys(values).length >= MAX_KEYS) throw new RangeError("Extension environment has too many keys.");
		const previousBytes = previous === undefined ? 0 : byteLength(key) + byteLength(previous);
		const nextBytes = totalBytes - previousBytes + byteLength(key) + byteLength(text);
		if (nextBytes > MAX_TOTAL_BYTES) throw new RangeError("Extension environment exceeds its total byte limit.");
		Object.defineProperty(values, key, { value: text, writable: true, enumerable: true, configurable: true });
		totalBytes = nextBytes;
		return true;
	};
	write("PI_CODING_AGENT_DIR", EXTENSION_CONFIG_ROOT);
	write("PI_AGENT_HOME", EXTENSION_CONFIG_ROOT);

	// Guard reflection too: spreading or retaining env must not bypass retirement.
	const reads = {
		get(target: object, key: PropertyKey): unknown { assertActive(); return Reflect.get(target, key); },
		has(target: object, key: PropertyKey) { assertActive(); return Reflect.has(target, key); },
		ownKeys(target: object) { assertActive(); return Reflect.ownKeys(target); },
		getOwnPropertyDescriptor(target: object, key: PropertyKey) { assertActive(); return Reflect.getOwnPropertyDescriptor(target, key); },
		getPrototypeOf(target: object) { assertActive(); return Reflect.getPrototypeOf(target); },
		isExtensible(target: object) { assertActive(); return Reflect.isExtensible(target); },
	};
	const env = new Proxy<typeof values>(values, {
		...reads,
		set: (_target, key, value: unknown) => write(key, value),
		defineProperty(_target, key, descriptor) {
			assertActive();
			if (!("value" in descriptor) || "get" in descriptor || "set" in descriptor || descriptor.writable !== true || descriptor.enumerable !== true || descriptor.configurable !== true) {
				return unavailable("non-writable, hidden, fixed or accessor environment properties");
			}
			return write(key, descriptor.value);
		},
		deleteProperty(target, key) {
			assertActive();
			if (typeof key === "string" && target[key] !== undefined) totalBytes -= byteLength(key) + byteLength(target[key]);
			return Reflect.deleteProperty(target, key);
		},
		setPrototypeOf() { assertActive(); return unavailable("changing the extension environment prototype"); },
		preventExtensions() { assertActive(); return unavailable("freezing the extension environment"); },
	});
	const process = Object.freeze({
		env,
		// A stable local identifier, not an OS pid or a parent/child relationship.
		pid: ++nextPid,
		platform: "browser",
		arch: "web",
		versions: Object.freeze({}),
		argv: Object.freeze<string[]>([]),
		cwd: (): string => { assertActive(); return "/vault"; },
		exit: (): never => { assertActive(); return unavailable("process.exit"); },
	});
	return new Proxy<typeof process>(process, reads);
}
