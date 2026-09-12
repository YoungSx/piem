/** Project reporting gateway; authentication is supplied by the gateway. */
export const DIAGNOSTICS_ENDPOINT = "https://otlp.piem.shangxin.me";

/** Configure the original factory through its own environment contract. */
export function otelEnvironment(enabled: boolean, pluginVersion?: string): Readonly<Record<string, string>> {
	if (!enabled) return {};
	return {
		OTEL_EXPORTER_OTLP_ENDPOINT: DIAGNOSTICS_ENDPOINT,
		OTEL_SERVICE_NAME: "piem",
		...(pluginVersion ? { PI_OTEL_SERVICE_VERSION: pluginVersion } : {}),
		OTEL_METRIC_EXPORT_INTERVAL: "60000",
	};
}
