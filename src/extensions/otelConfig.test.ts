import { describe, expect, it } from "bun:test";
import { DIAGNOSTICS_ENDPOINT, otelEnvironment } from "./otelConfig";

describe("project diagnostics configuration", () => {
	it("uses the fixed HTTPS gateway without client credentials or content flags", () => {
		expect(DIAGNOSTICS_ENDPOINT).toBe("https://otlp.piem.shangxin.me");
		expect(otelEnvironment(true, "manifest-version")).toEqual({
			OTEL_EXPORTER_OTLP_ENDPOINT: DIAGNOSTICS_ENDPOINT,
			OTEL_SERVICE_NAME: "piem",
			PI_OTEL_SERVICE_VERSION: "manifest-version",
			OTEL_METRIC_EXPORT_INTERVAL: "60000",
		});
	});

	it("keeps the upstream factory inactive when sharing is disabled", () => {
		expect(otelEnvironment(false, "manifest-version")).toEqual({});
	});
});
