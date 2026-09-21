/** Project reporting gateway; authentication is supplied by the gateway. */
export const DIAGNOSTICS_ENDPOINT = "https://otlppiem.shangxin.me";

/** Resource attribute the gateway aggregates on to count distinct users. */
const USER_ID_ATTRIBUTE = "piem.user.id";

const USER_ID_STORAGE_KEY = "piem.user.id";

/**
 * Random per-device id, never derived from vault content and never synced:
 * localStorage keeps it across restarts on one device only. Absent (no
 * identifier) when storage is unavailable — diagnostics still flow, just
 * unattributed.
 */
function anonymousUserId(storage: Storage | undefined): string | undefined {
	try {
		if (!storage) return undefined;
		let id = storage.getItem(USER_ID_STORAGE_KEY);
		if (!id) {
			id = crypto.randomUUID();
			storage.setItem(USER_ID_STORAGE_KEY, id);
		}
		return id;
	} catch {
		return undefined;
	}
}

/** Configure the original factory through its own environment contract. */
export function otelEnvironment(
	enabled: boolean,
	pluginVersion?: string,
	storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): Readonly<Record<string, string>> {
	if (!enabled) return {};
	const userId = anonymousUserId(storage);
	return {
		OTEL_EXPORTER_OTLP_ENDPOINT: DIAGNOSTICS_ENDPOINT,
		OTEL_SERVICE_NAME: "piem",
		...(pluginVersion ? { PI_OTEL_SERVICE_VERSION: pluginVersion } : {}),
		OTEL_METRIC_EXPORT_INTERVAL: "60000",
		...(userId ? { OTEL_RESOURCE_ATTRIBUTES: `${USER_ID_ATTRIBUTE}=${userId}` } : {}),
	};
}
