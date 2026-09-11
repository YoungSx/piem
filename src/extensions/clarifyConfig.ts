import type { ExtensionConfigProjection } from "./extensionConfigStore";
import { configuredModels } from "./configuredModels";
import { resolveModelChoice, type PiemSettings } from "../settings";

export interface ClarifyModelHost {
	getSettings(): PiemSettings;
	/** Writes the settings file. Must reject when nothing was persisted. */
	persist(): Promise<void>;
	/** Throws when a newer host has taken over this conversation. */
	assertOwner(): void;
}

/**
 * `pi-clarify`'s `clarify.json`, projected onto the plugin's own setting.
 *
 * The pinned rewrite model predates this store and already has a home in
 * {@link PiemSettings.clarifyModelId}, which the settings normalizer validates
 * against the configured model list. Storing the same choice a second time as
 * extension text would let the two disagree — and the stored copy is the one
 * with no validation — so the file is a view over the setting rather than a
 * separate value.
 *
 * A write therefore keeps the setting's invariant rather than the file's:
 * upstream will happily pin any provider/model pair its registry can name, but
 * this host only offers configured, credentialed models, so an unresolvable
 * pair is refused instead of stored and left to fail on the next request.
 *
 * Read and write are deliberately asymmetric, and this is not an oversight to
 * be tidied into symmetry: `write` refuses what this host cannot serve, so a
 * pin that could never work is never persisted, while `read` reports what was
 * actually pinned, so a pin that *stopped* working says so. Upstream's
 * `resolveRewriteModel` already handles a config naming a model its registry
 * cannot find — it names the pair and how to reset it. Filtering that pair out
 * here would instead make a broken pin indistinguishable from no pin at all,
 * and the user would see `/clarify` quietly fall back to the session model
 * after, say, deleting that provider's API key.
 *
 * Hence the two different resolvers: `read` goes through `resolveModelChoice`,
 * which needs only the provider row to still exist and returns undefined
 * (never throws) once it is gone; `write` goes through `configuredModels`,
 * which additionally demands a credential and an unambiguous provider/model
 * pair.
 */
export function clarifyModelProjection(host: ClarifyModelHost): ExtensionConfigProjection {
	return {
		owner: "pi-clarify",
		file: "clarify.json",
		read: () => {
			const settings = host.getSettings();
			const choiceId = settings.clarifyModelId;
			const pinned = choiceId ? resolveModelChoice(settings, choiceId) : undefined;
			return pinned ? JSON.stringify({ provider: pinned.provider, model: pinned.id }) : undefined;
		},
		write: async text => {
			host.assertOwner();
			const settings = host.getSettings();
			const previous = settings.clarifyModelId;
			if (text === undefined) {
				if (previous === undefined) return;
				delete settings.clarifyModelId;
			} else {
				const parsed: unknown = JSON.parse(text);
				const provider: unknown = parsed && typeof parsed === "object" ? Reflect.get(parsed, "provider") : undefined;
				const model: unknown = parsed && typeof parsed === "object" ? Reflect.get(parsed, "model") : undefined;
				if (typeof provider !== "string" || typeof model !== "string") throw new Error("A pinned rewrite model needs provider and model names.");
				const choice = configuredModels(settings).find(item => item.model.provider === provider && item.model.id === model);
				if (!choice) throw new Error(`Not a configured model with credentials: ${provider}/${model}`);
				if (previous === choice.choiceId) return;
				settings.clarifyModelId = choice.choiceId;
			}
			try { await host.persist(); }
			catch (error) {
				// Only this conversation's own optimistic value is rolled back; a
				// newer host may already own the settings object.
				if (settings === host.getSettings()) {
					if (previous === undefined) delete settings.clarifyModelId; else settings.clarifyModelId = previous;
				}
				throw error;
			}
		},
	};
}
