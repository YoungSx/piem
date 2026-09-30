/** Replaced by esbuild's `define` at build time; the repo does not own the URL. */
declare const __PIEM_DIAGNOSTICS_ENDPOINT__: string | undefined;

/**
 * The reporting gateway, baked in by the release build from
 * `PIEM_DIAGNOSTICS_ENDPOINT`. Empty in dev builds, in `bun test`, and in a
 * release whose secret was missing — diagnostics are off there rather than
 * pointed somewhere guessed. `release.yml` fails the build rather than letting
 * that ship.
 *
 * Read per call, not once at module load, only so tests can install the global;
 * the value is a build-time constant and never changes at runtime.
 */
function diagnosticsEndpoint(): string {
	return typeof __PIEM_DIAGNOSTICS_ENDPOINT__ === "string" ? __PIEM_DIAGNOSTICS_ENDPOINT__ : "";
}

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

/**
 * The renderer's persistent storage, probed through `window` the way every
 * other localStorage consumer here does. A required argument at the call site
 * rather than a default inside {@link otelEnvironment}: bun test shares one
 * process, and a defaulted probe would pick up whatever `window` another test
 * file leaked into the global scope.
 */
export function hostStorage(): Storage | undefined {
	return typeof window !== "undefined" ? window.localStorage : undefined;
}

/** Configure the original factory through its own environment contract. */
export function otelEnvironment(enabled: boolean, pluginVersion?: string, storage?: Storage): Readonly<Record<string, string>> {
	const endpoint = diagnosticsEndpoint();
	if (!enabled || !endpoint) return {};
	const userId = anonymousUserId(storage);
	return {
		OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
		OTEL_SERVICE_NAME: "piem",
		...(pluginVersion ? { PI_OTEL_SERVICE_VERSION: pluginVersion } : {}),
		OTEL_METRIC_EXPORT_INTERVAL: "60000",
		...(userId ? { OTEL_RESOURCE_ATTRIBUTES: `${USER_ID_ATTRIBUTE}=${userId}` } : {}),
	};
}
