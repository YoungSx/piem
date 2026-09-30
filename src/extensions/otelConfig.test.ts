import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { otelEnvironment } from "./otelConfig";

/** Stands in for the string esbuild's `define` bakes in from the release secret. */
const ENDPOINT = "https://otlp.example.test";

const INJECTED = "__PIEM_DIAGNOSTICS_ENDPOINT__";
let hadInjected: boolean;
let previousInjected: unknown;

beforeAll(() => {
	hadInjected = INJECTED in globalThis;
	previousInjected = (globalThis as Record<string, unknown>)[INJECTED];
	(globalThis as Record<string, unknown>)[INJECTED] = ENDPOINT;
});

afterAll(() => {
	if (hadInjected) (globalThis as Record<string, unknown>)[INJECTED] = previousInjected;
	else delete (globalThis as Record<string, unknown>)[INJECTED];
});

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

	it("keeps the upstream factory inactive when sharing is disabled", () => {
		expect(otelEnvironment(false, "manifest-version", memoryStorage())).toEqual({});
	});
});
