import { describeModelConfig, type ModelConfig, type ProviderConfig } from "../../modelConfig";
import type { Translator } from "../../i18n";

/**
 * The list edits behind the settings panel's add/edit/delete rows.
 *
 * Kept apart from the rendering because these are the only operations that can
 * silently change where a request goes: deleting a provider takes its models
 * with it, and deleting the active model has to choose a successor. A mistake
 * there is invisible in the panel — the user sees a row disappear and has no
 * way to tell that the next prompt now travels to a different endpoint — so the
 * rules live in pure functions with tests rather than inside a click handler.
 */

/** The mutable slice these operations read and write. */
export interface ConfigLists {
	activeModelId?: string;
	providers: ProviderConfig[];
	models: ModelConfig[];
}

/** Replaces an entry with the same id, leaving list order untouched. */
export function replaceById<T extends { id: string }>(list: T[], updated: T): void {
	const index = list.findIndex((entry) => entry.id === updated.id);
	if (index === -1) {
		list.push(updated);
		return;
	}
	list[index] = updated;
}

/**
 * Removes a provider and everything that depended on it.
 *
 * Models are dropped with it because a model without a provider has no base URL
 * and no credential — leaving one selectable would produce a request that fails
 * with an error pointing at the wrong setting.
 */
export function removeProvider(lists: ConfigLists, providerId: string): void {
	lists.providers = lists.providers.filter((provider) => provider.id !== providerId);
	const orphaned = lists.models.filter((model) => model.providerId === providerId);
	lists.models = lists.models.filter((model) => model.providerId !== providerId);
	if (orphaned.some((model) => model.id === lists.activeModelId)) {
		reassignActiveModel(lists);
	}
}

export function removeModel(lists: ConfigLists, modelId: string): void {
	lists.models = lists.models.filter((model) => model.id !== modelId);
	if (lists.activeModelId === modelId) {
		reassignActiveModel(lists);
	}
}

/**
 * Picks a surviving model after the active one is deleted.
 *
 * Falling back to the first remaining model beats clearing the selection: an
 * empty `activeModelId` silently hands every request back to the builtin
 * catalog, which is a different endpoint than the user configured.
 */
function reassignActiveModel(lists: ConfigLists): void {
	const next = lists.models[0];
	if (next) {
		lists.activeModelId = next.id;
	} else {
		delete lists.activeModelId;
	}
}

/**
 * How the row being deleted holds its credential.
 *
 * The three shapes never coexist on disk (settingsSecrets' invariant), so the
 * deletion dialog can name exactly one fate. Inline plaintext dies with the
 * row; a keychain binding is dropped from the row but the entry is the user's
 * and stays; an OAuth flow's stored credential is the plugin's own keychain
 * entry and is signed out with it.
 */
export type ProviderCredentialShape = "inline" | "ref" | "oauth";

/** What the user loses by deleting a provider, stated before they confirm. */
export function describeProviderDeletion(
	boundModels: readonly ModelConfig[],
	shape: ProviderCredentialShape,
	t: Translator,
): string[] {
	const lines = [t.t("deletion.providerKeyRemoved")];
	if (boundModels.length > 0) {
		const names = boundModels.map(describeModelConfig).join(", ");
		lines.push(
			boundModels.length === 1
				? t.t("deletion.providerOneModel", { names })
				: t.t("deletion.providerManyModels", { count: boundModels.length, names }),
		);
	}
	// Only the non-plain shapes need an extra sentence: the inline case is
	// already stated by the first line (and answered by the copy button).
	if (shape === "ref") {
		lines.push(t.t("deletion.providerKeychainStays"));
	} else if (shape === "oauth") {
		lines.push(t.t("deletion.providerOauthSignOut"));
	}
	return lines;
}

/** What the user loses by deleting a model. */
export function describeModelDeletion(lists: ConfigLists, model: ModelConfig, t: Translator): string[] {
	const lines = [t.t("deletion.modelProviderStays")];
	if (lists.activeModelId === model.id) {
		// Name the successor: "another one is selected" makes the reader guess.
		// reassignActiveModel picks the first surviving model, so that is exactly
		// who takes over — and when none survives, say that plainly instead.
		const successor = lists.models.find((candidate) => candidate.id !== model.id);
		lines.push(
			successor
				? t.t("deletion.modelWasActive", { model: describeModelConfig(successor) })
				: t.t("deletion.modelWasLast"),
		);
	}
	return lines;
}
