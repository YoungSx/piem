import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { installObsidianStub, platformMock } from "../testUtils/obsidianStub";

installObsidianStub();

const { otelEnvironment } = await import("./otelConfig");

/** Stands in for the string esbuild's `define` bakes in from the release secret. */
const ENDPOINT = "https://otlp.example.test";

const INJECTED = "__PIEM_DIAGNOSTICS_ENDPOINT__";
let hadInjected: boolean;
let previousInjected: unknown;

/** The stub's own defaults, restored around each platform a test sets. */
const NEUTRAL_PLATFORM = { ...platformMock };

beforeAll(() => {
	hadInjected = INJECTED in globalThis;
	previousInjected = (globalThis as Record<string, unknown>)[INJECTED];
	(globalThis as Record<string, unknown>)[INJECTED] = ENDPOINT;
});

afterAll(() => {
	if (hadInjected) (globalThis as Record<string, unknown>)[INJECTED] = previousInjected;
	else delete (globalThis as Record<string, unknown>)[INJECTED];
	Object.assign(platformMock, NEUTRAL_PLATFORM);
});

/**
 * Decodes `OTEL_RESOURCE_ATTRIBUTES` the way `pi-otel` does when it reads the
 * environment (its `keyValues` percent-decodes both halves of each pair), so
 * these assertions read the attributes the collector will actually see rather
 * than the wire format on the way there.
 */
function resourceAttributes(env: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(
		(env.OTEL_RESOURCE_ATTRIBUTES ?? "")
			.split(",")
			.filter(Boolean)
			.map((pair) => {
				const at = pair.indexOf("=");
				return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))];
			}),
	);
}

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() { return map.size; },
		clear: () => map.clear(),
		getItem: (key: string) => map.get(key) ?? null,
		key: (index: number) => [...map.keys()][index] ?? null,
		removeItem: (key: string) => map.delete(key),
		setItem: (key: string, value: string) => void map.set(key, value),
	} satisfies Storage;
}

/** Reports the environment as this platform, then hands it back for reading. */
function onPlatform(flags: Partial<typeof platformMock>): Record<string, string> {
	Object.assign(platformMock, NEUTRAL_PLATFORM, flags);
	return resourceAttributes(otelEnvironment(true, undefined, memoryStorage()));
}

describe("project diagnostics configuration", () => {
	it("reports to the endpoint the bundle was built with", () => {
		const env = otelEnvironment(true, "manifest-version", memoryStorage());
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(ENDPOINT);
		expect(env.OTEL_SERVICE_NAME).toBe("piem");
		expect(env.PI_OTEL_SERVICE_VERSION).toBe("manifest-version");
		expect(env.OTEL_METRIC_EXPORT_INTERVAL).toBe("60000");
	});

	it("reports nothing when the bundle carries no endpoint", () => {
		// Dev builds, `bun test`, and a release whose secret was empty all
		// define this to the empty string. Sending is the wrong answer either
		// way: there is no gateway to send to.
		delete (globalThis as Record<string, unknown>)[INJECTED];
		try {
			expect(otelEnvironment(true, "manifest-version", memoryStorage())).toEqual({});
		} finally {
			(globalThis as Record<string, unknown>)[INJECTED] = ENDPOINT;
		}
	});

	it("attaches a stable anonymous user id in resource attributes", () => {
		const storage = memoryStorage();
		const first = otelEnvironment(true, undefined, storage);
		const second = otelEnvironment(true, undefined, storage);
		expect(resourceAttributes(first)["piem.user.id"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(second.OTEL_RESOURCE_ATTRIBUTES).toBe(first.OTEL_RESOURCE_ATTRIBUTES);
		// The id is minted once and kept in storage, so a later plugin restart
		// with fresh storage reads the same id instead of minting a new one.
		expect(storage.getItem("piem.user.id")).toBe(resourceAttributes(first)["piem.user.id"] ?? null);
	});

	it("omits the identifier when storage is unavailable, keeping the platform", () => {
		const attributes = resourceAttributes(otelEnvironment(true, undefined, undefined));
		expect(attributes["piem.user.id"]).toBeUndefined();
		// Losing storage costs the attribution, not the whole resource: an
		// unattributed span still has to say which machine produced it.
		expect(attributes["os.type"]).toBeDefined();
	});

	it("keeps the upstream factory inactive when sharing is disabled", () => {
		expect(otelEnvironment(false, "manifest-version", memoryStorage())).toEqual({});
	});
});

describe("operating system resource attributes", () => {
	it("reports the desktop platforms under their semconv names", () => {
		expect(onPlatform({ isMacOS: true })).toMatchObject({ "os.type": "darwin", "os.name": "macOS" });
		expect(onPlatform({ isWin: true })).toMatchObject({ "os.type": "windows", "os.name": "Windows" });
		expect(onPlatform({ isLinux: true })).toMatchObject({ "os.type": "linux", "os.name": "Linux" });
	});

	it("maps the mobile apps onto the kernels their os.type enum admits", () => {
		// `os.type` has no iOS or Android member, so both report the Darwin and
		// Linux they run on; only `os.name` carries the distinction a person
		// reads, which is what the semconv examples show ("iOS", "Android").
		expect(onPlatform({ isIosApp: true, isMobileApp: true })).toMatchObject({ "os.type": "darwin", "os.name": "iOS" });
		expect(onPlatform({ isAndroidApp: true, isMobileApp: true })).toMatchObject({ "os.type": "linux", "os.name": "Android" });
	});

	it("reports no os rather than a guessed one on a platform it cannot name", () => {
		const attributes = onPlatform({ isMacOS: false, isWin: false, isLinux: false, isIosApp: false, isAndroidApp: false });
		expect(attributes["os.type"]).toBeUndefined();
		expect(attributes["os.name"]).toBeUndefined();
		// The platform is an optional fact; the user id still ships.
		expect(attributes["piem.user.id"]).toMatch(/^[0-9a-f-]{36}$/);
	});
});