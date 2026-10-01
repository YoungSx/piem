import { Platform } from "obsidian";

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
 * `os.type` and `os.name` as the OpenTelemetry resource conventions define them
 * (semconv 1.41, `signal_type: entity`): `os.type` is a closed enum, and its
 * members contain no iOS or Android — both are Darwin and Linux underneath, so
 * they report `darwin`/`linux` there and keep the distinction a human reads in
 * `os.name`, whose own examples are exactly "iOS", "Android", "Ubuntu".
 *
 * `os.version` and `os.description` are deliberately absent. The renderer is a
 * web view, so the only source is `navigator.userAgent`, and a version scraped
 * out of a UA string is a guess wearing a semconv key. An absent recommended
 * field is honest; a wrong one is not.
 *
 * Nothing is reported for a platform Obsidian does not name: `Platform` exposes
 * flags, not a platform identity, and guessing one would put a fabricated
 * `os.type` into every span from that device.
 */
function operatingSystemAttributes(): Record<string, string> {
	if (Platform.isIosApp) return { "os.type": "darwin", "os.name": "iOS" };
	if (Platform.isAndroidApp) return { "os.type": "linux", "os.name": "Android" };
	if (Platform.isMacOS) return { "os.type": "darwin", "os.name": "macOS" };
	if (Platform.isWin) return { "os.type": "windows", "os.name": "Windows" };
	if (Platform.isLinux) return { "os.type": "linux", "os.name": "Linux" };
	return {};
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
	const attributes: Record<string, string> = operatingSystemAttributes();
	const userId = anonymousUserId(storage);
	if (userId) attributes[USER_ID_ATTRIBUTE] = userId;
	// `pi-otel` percent-decodes both halves of every pair (config.ts `keyValues`),
	// so encode here rather than assuming a value can never need it.
	const encoded = Object.entries(attributes)
		.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
		.join(",");
	return {
		OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
		OTEL_SERVICE_NAME: "piem",
		...(pluginVersion ? { PI_OTEL_SERVICE_VERSION: pluginVersion } : {}),
		OTEL_METRIC_EXPORT_INTERVAL: "60000",
		...(encoded ? { OTEL_RESOURCE_ATTRIBUTES: encoded } : {}),
	};
}
