/**
 * The ambient half of pi's auth resolution, answered honestly for a plugin.
 *
 * pi consults an `AuthContext` only when a provider has *no* stored credential:
 * it is the seam through which a CLI finds `ANTHROPIC_API_KEY` in the shell or
 * `~/.aws/credentials` on disk. Neither is a source this plugin wants, and the
 * reason is the same one `src/net/streamFn.ts` gives for resolving to nothing
 * without an explicit key: a provider that silently works because of an
 * environment variable is a provider whose settings page is lying, and a missing
 * key should surface as *our* error, pointing at the field the user can fix.
 *
 * So both answers are constant, and that is the whole module. It exists as a
 * file rather than an inline literal because the alternative is worse than
 * verbose — pi's default is `defaultProviderAuthContext()`, which reads
 * `process.env` (absent in the mobile renderer) and probes the filesystem
 * through a `node:fs` import behind a variable specifier that no browser bundler
 * can follow. Left in place it is dead weight that answers "no" by throwing
 * inside a try/catch; replaced, the "no" is deliberate and the reason for it is
 * written down here.
 */

import type { AuthContext } from "@earendil-works/pi-ai";

/** The context every `Models` instance in this plugin is built with. */
export function pluginAuthContext(): AuthContext {
	return {
		// No ambient environment. See the module header: an env var that quietly
		// supplies a key makes the settings panel wrong.
		env: async () => undefined,
		// No filesystem probe. The vault is reachable through Obsidian's adapter,
		// not `node:fs`, and nothing pi looks for here (`~/.aws/credentials`,
		// gcloud ADC) lives in a vault anyway.
		fileExists: async () => false,
	};
}
