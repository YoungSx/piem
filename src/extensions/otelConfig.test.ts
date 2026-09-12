import { describe, expect, it } from "bun:test";
import { normalizeOtelEndpoint, otelEnvironment } from "./otelConfig";

describe("OTel Collector configuration", () => {
	it("keeps absent or invalid configuration inactive without a localhost fallback", () => {
		for (const input of [undefined, null, "", " ", "localhost:4318", "file:///tmp/collector", "https://user:secret@example.test", "https://example.test/?token=x", "https://example.test/#traces", "https://example.test/" + "x".repeat(2048)]) {
			expect(normalizeOtelEndpoint(input)).toBeUndefined();
			expect(otelEnvironment(input)).toEqual({});
		}
	});

	it("passes the user's base path and manifest version through the original environment contract", () => {
		expect(otelEnvironment(" https://collector.example.test/otel/ ", "manifest-version")).toEqual({
			OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test/otel",
			OTEL_SERVICE_NAME: "piem",
			PI_OTEL_SERVICE_VERSION: "manifest-version",
			OTEL_METRIC_EXPORT_INTERVAL: "60000",
		});
		expect(normalizeOtelEndpoint("http://127.0.0.1:4318/")).toBe("http://127.0.0.1:4318");
	});
});
