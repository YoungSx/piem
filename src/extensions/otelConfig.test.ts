import { describe, expect, it } from "bun:test";
import { DIAGNOSTICS_ENDPOINT, otelEnvironment } from "./otelConfig";

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

describe("project diagnostics configuration", () => {
	it("uses the fixed HTTPS gateway without client credentials or content flags", () => {
		const env = otelEnvironment(true, "manifest-version", memoryStorage());
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(DIAGNOSTICS_ENDPOINT);
		expect(env.OTEL_SERVICE_NAME).toBe("piem");
		expect(env.PI_OTEL_SERVICE_VERSION).toBe("manifest-version");
		expect(env.OTEL_METRIC_EXPORT_INTERVAL).toBe("60000");
	});

	it("attaches a stable anonymous user id in resource attributes", () => {
		const storage = memoryStorage();
		const first = otelEnvironment(true, undefined, storage);
		const second = otelEnvironment(true, undefined, storage);
		expect(first.OTEL_RESOURCE_ATTRIBUTES).toMatch(/^piem\.user\.id=[0-9a-f-]{36}$/);
		expect(second.OTEL_RESOURCE_ATTRIBUTES).toBe(first.OTEL_RESOURCE_ATTRIBUTES);
		// The id is minted once and kept in storage, so a later plugin restart
		// with fresh storage reads the same id instead of minting a new one.
		const resourceId = first.OTEL_RESOURCE_ATTRIBUTES!.split("=")[1] ?? "";
		expect(storage.getItem("piem.user.id")).toBe(resourceId);
	});

	it("omits the identifier when storage is unavailable", () => {
		const env = otelEnvironment(true, undefined, undefined);
		expect(env.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
	});

	it("ignores a leaked window global instead of reading another test's storage", () => {
		// bun test files share one process; a sibling file can define `window`.
		// The id comes only from the injected argument, so a leaked window must
		// not resurrect one.
		const previous = (globalThis as { window?: unknown }).window;
		Object.defineProperty(globalThis, "window", {
			value: { localStorage: memoryStorage() },
			configurable: true,
			writable: true,
		});
		try {
			const env = otelEnvironment(true, undefined, undefined);
			expect(env.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
		} finally {
			if (previous === undefined) delete (globalThis as { window?: unknown }).window;
			else Object.defineProperty(globalThis, "window", { value: previous, configurable: true, writable: true });
		}
	});

	it("ignores a leaked window global instead of reading another test's storage", () => {
		// bun test files share one process; a sibling file can define `window`.
		// The id comes only from the injected argument, so a leaked window must
		// not resurrect one.
		const previous = (globalThis as { window?: unknown }).window;
		Object.defineProperty(globalThis, "window", {
			value: { localStorage: memoryStorage() },
			configurable: true,
			writable: true,
		});
		try {
			const env = otelEnvironment(true, undefined, undefined);
			expect(env.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
		} finally {
			if (previous === undefined) delete (globalThis as { window?: unknown }).window;
			else Object.defineProperty(globalThis, "window", { value: previous, configurable: true, writable: true });
		}
	});

	it("keeps the upstream factory inactive when sharing is disabled", () => {
		expect(otelEnvironment(false, "manifest-version", memoryStorage())).toEqual({});
	});
});
