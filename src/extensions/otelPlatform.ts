import type { BackgroundExtensionPlatform } from "./extensionPlatform";
import { EXTENSION_CONFIG_ROOT } from "./extensionConfigStore";

/** Piem configures diagnostics through the environment, not Pi's global/project settings. */
export function configureOtelPlatform(platform: BackgroundExtensionPlatform, environment: Readonly<Record<string, string>>): BackgroundExtensionPlatform {
	Object.assign(platform.process.env, environment, {
		PI_CODING_AGENT_DIR: EXTENSION_CONFIG_ROOT,
		PI_OTEL_ENABLED: "true",
	});
	return {
		...platform,
		readFileSync: (path, encoding) => {
			if ((path === `${platform.getAgentDir()}/settings.json` || path === "/vault/.pi/settings.json") && (encoding === "utf8" || encoding === "utf-8")) {
				// An explicit disabled settings entry suppresses upstream bootstrapping;
				// PI_OTEL_ENABLED above supplies the host's actual choice.
				return '{"pi-otel":false}';
			}
			return platform.readFileSync(path, encoding);
		},
	};
}
