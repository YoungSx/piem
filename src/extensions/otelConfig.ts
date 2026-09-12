/** A Collector base URL, never a provider URL or a built-in reporting endpoint. */
export function normalizeOtelEndpoint(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text || text.length > 2048) return undefined;
	try {
		const url = new URL(text);
		if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return undefined;
		const normalized = url.href.replace(/\/+$/, "");
		return normalized.length <= 2048 ? normalized : undefined;
	} catch { return undefined; }
}

/** Configure the original factory through its own environment contract. */
export function otelEnvironment(endpoint: unknown, pluginVersion?: string): Readonly<Record<string, string>> {
	const url = normalizeOtelEndpoint(endpoint);
	if (!url) return {};
	return {
		OTEL_EXPORTER_OTLP_ENDPOINT: url,
		OTEL_SERVICE_NAME: "piem",
		...(pluginVersion ? { PI_OTEL_SERVICE_VERSION: pluginVersion } : {}),
		OTEL_METRIC_EXPORT_INTERVAL: "60000",
	};
}
