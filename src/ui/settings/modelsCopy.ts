import type { Translator } from "../../i18n";
import { describeProviderConfig, wireProtocolLabel, type ModelConfig, type ProviderConfig } from "../../modelConfig";
import type { SettingsPanelSettings } from "./panelHost";

/**
 * Wording for the Models tab, kept apart from the panel so it can be tested.
 */

/**
 * Explains that a configured builtin model is gone and what answered instead.
 *
 * Names the replacement rather than only the loss: the user's next prompt will be
 * answered by something, and not saying what makes the change look like the
 * plugin misbehaving. Points at configured providers because that path can still
 * reach the dropped model's endpoint — the capability was not removed, only the
 * builtin shortcut to it.
 */
export function describeMissingBuiltinModel(
	missing: { provider: string; modelId: string },
	replacement: string,
	t: Translator,
): string {
	return t.t("settings.missingBuiltinModel", {
		provider: missing.provider,
		modelId: missing.modelId,
		replacement,
	});
}

/**
 * Row description for a provider: protocol, credential state, and how many
 * models use it.
 *
 * Credential state follows the row's own axis. A subscription row
 * (`oauthFlow` set) authenticates by sign-in, so its phrase is signed-in or
 * not — a key field is not part of how it works, and asking about one would
 * invite a key that would never be read. Key state on an ordinary row is
 * three-way: bound-and-present, bound-but-dangling (the entry was deleted from
 * Obsidian's own UI, and the row is the only place that can say so), and
 * inline. A dangling binding shows as missing rather than "no key" because the
 * fix is not typing a key — it is re-picking an entry.
 */
export function describeProviderRow(provider: ProviderConfig, modelCount: number, t: Translator): string {
	const credential = provider.oauthFlow
		? t.t("settings.rowCredentialPending")
		: describeKeyRow(provider, t);
	const models = t.t(modelCount === 1 ? "settings.modelCount" : "settings.modelsCount", { count: modelCount });
	return `${provider.baseUrl} · ${wireProtocolLabel(provider.protocol, t)} · ${credential} · ${models}`;
}

/** The key-state phrase for an ordinary (key-authenticated) row. */
function describeKeyRow(provider: ProviderConfig, t: Translator): string {
	return provider.secretRef
		? t.t(provider.apiKey.trim() ? "settings.keyBound" : "settings.keyMissing")
		: t.t(provider.apiKey.trim() ? "settings.keySet" : "settings.noKey");
}

/** Row description for a model: its provider and the id sent to the server. */
export function describeModelRow(settings: SettingsPanelSettings, model: ModelConfig, t: Translator): string {
	const provider = settings.providers.find((entry) => entry.id === model.providerId);
	const providerName = provider ? describeProviderConfig(provider) : t.t("settings.providerMissing");
	const active = settings.activeModelId === model.id ? t.t("settings.activeSuffix") : "";
	return `${model.modelApiId} · ${providerName}${active}`;
}
