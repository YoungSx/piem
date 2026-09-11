import { describe, expect, it } from "bun:test";
import { createScopedProcess } from "./scopedProcess";

describe("private extension process", () => {
	it("isolates environments and virtual identities without reading or changing the host process", () => {
		const original = { ...process.env };
		const first = createScopedProcess(() => {});
		const second = createScopedProcess(() => {});
		expect(Object.getPrototypeOf(first.env)).toBeNull();
		expect({ ...first.env }).toEqual({ PI_CODING_AGENT_DIR: "/extensions/config", PI_AGENT_HOME: "/extensions/config" });
		first.env.PIEM_SCOPED_TEST = "private";
		expect(second.env.PIEM_SCOPED_TEST).toBeUndefined();
		expect(first.pid).not.toBe(second.pid);
		expect(Number.isSafeInteger(first.pid)).toBe(true);
		expect(first.cwd()).toBe("/vault");
		expect(first.platform).toBe("browser");
		expect(first.arch).toBe("web");
		expect(first.versions).toEqual({});
		expect(first.argv).toEqual([]);
		expect(Object.isFrozen(first.versions)).toBe(true);
		expect(Object.isFrozen(first.argv)).toBe(true);
		expect(Object.isFrozen(first)).toBe(true);
		expect(() => first.exit()).toThrow("does not support");
		expect(Reflect.set(first, "env", {})).toBe(false);
		expect(process.env).toEqual(original);
	});

	it("coerces values as Node does and treats prototype-like names as ordinary keys", () => {
		const { env } = createScopedProcess(() => {});
		for (const value of [12, false, null, undefined, { toString: () => "custom" }]) {
			Reflect.set(env, "VALUE", value);
			expect(env.VALUE).toBe(String(value));
		}
		expect(() => Reflect.set(env, "VALUE", Symbol("bad"))).toThrow(TypeError);
		expect(() => Reflect.set(env, Symbol("bad"), "value")).toThrow(TypeError);
		env.__proto__ = "private";
		Reflect.set(env, "constructor", "constructor value");
		expect(env.__proto__).toBe("private");
		expect(Reflect.get(env, "constructor")).toBe("constructor value");
		expect(Object.getPrototypeOf(env)).toBeNull();
		expect({}.constructor).toBe(Object);
		delete env.VALUE;
		expect("VALUE" in env).toBe(false);
	});

	it("limits keys including defaults and lets deletion release a slot", () => {
		const { env } = createScopedProcess(() => {});
		for (let i = 0; i < 62; i++) env[`KEY_${i}`] = "";
		expect(Object.keys(env)).toHaveLength(64);
		expect(() => { env.EXTRA = "value"; }).toThrow("too many keys");
		env.KEY_0 = "replaced";
		expect(env.KEY_0).toBe("replaced");
		delete env.KEY_0;
		env.EXTRA = "value";
		expect(Object.keys(env)).toHaveLength(64);
	});

	it("limits each value and total key/value storage by UTF-8 bytes", () => {
		const { env } = createScopedProcess(() => {});
		env.VALUE = "x".repeat(4096);
		expect(() => { env.VALUE = "x".repeat(4097); }).toThrow(RangeError);
		env.VALUE = "🌿".repeat(1024);
		expect(() => { env.VALUE = "🌿".repeat(1025); }).toThrow(RangeError);
		for (const key of Object.keys(env)) delete env[key];
		for (const key of ["A", "B", "C", "D"]) env[key] = "x".repeat(4095);
		expect(() => { env.E = ""; }).toThrow("total byte limit");
		expect(() => { env.A = "x".repeat(4096); }).toThrow("total byte limit");
		expect(env.A).toHaveLength(4095);
		delete env.A;
		env.E = "x".repeat(4095);
		expect(() => Reflect.set(env, "k".repeat(16_385), "")).toThrow(RangeError);
	});

	it("cannot bypass limits using property descriptors, accessors or prototypes", () => {
		const { env } = createScopedProcess(() => {});
		const descriptor = { value: 12, writable: true, enumerable: true, configurable: true };
		Object.defineProperty(env, "VALUE", descriptor);
		expect(env.VALUE).toBe("12");
		expect(() => Object.defineProperty(env, "VALUE", { ...descriptor, value: "x".repeat(4097) })).toThrow(RangeError);
		expect(env.VALUE).toBe("12");
		for (const invalid of [{ value: "hidden" }, { ...descriptor, writable: false }, { ...descriptor, configurable: false }, { get: () => "unbounded" }]) {
			expect(() => Object.defineProperty(env, "OTHER", invalid)).toThrow("does not support");
		}
		expect(() => Object.setPrototypeOf(env, {})).toThrow("does not support");
		expect(() => Object.preventExtensions(env)).toThrow("does not support");
		expect(Object.getPrototypeOf(env)).toBeNull();
		expect(Object.isExtensible(env)).toBe(true);
	});

	it("retires held references and rechecks after custom string conversion", () => {
		let active = true;
		const scoped = createScopedProcess(() => { if (!active) throw new Error("disposed"); });
		const env = scoped.env;
		const cwd = scoped.cwd;
		const exit = scoped.exit;
		expect(() => Reflect.set(env, "LATE", { toString() { active = false; return "late"; } })).toThrow("disposed");
		for (const access of [
			() => scoped.env, () => scoped.pid, () => env.LATE, () => Object.keys(env), () => "LATE" in env,
			() => Object.getOwnPropertyDescriptor(env, "LATE"), () => Object.getPrototypeOf(env), () => Object.isExtensible(env),
			() => Reflect.set(env, "LATE", "value"), () => Reflect.deleteProperty(env, "LATE"),
			() => Object.defineProperty(env, "LATE", { value: "value", enumerable: true, configurable: true, writable: true }),
			cwd, exit,
		]) expect(access).toThrow("disposed");
		active = true;
		expect(env.LATE).toBeUndefined();
	});
});
