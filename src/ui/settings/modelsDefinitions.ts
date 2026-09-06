import { type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import { createFetchForTransport, type NetworkTransport } from "../../net/obsidianFetch";
import { createObsidianModels } from "../../net/streamFn";
import { ModelListingCache } from "../../net/modelListingCache";
import { testModelConnection, testProviderConnection } from "../../connectionTest";
import type { ConnectionTestResult } from "../../connectionTest";
import { fetchModelsDevIndex } from "../../net/modelsDev";
import {
	describeModelConfig,
	describeProviderConfig,
	modelsForProvider,
	type ModelConfig,
	type ProviderConfig,
} from "../../modelConfig";
import {
	describeModelDeletion,
	describeProviderDeletion,
	removeModel,
	removeProvider,
	replaceById,
} from "./configLists";
import { openConfirmDelete } from "./confirmDelete";
import { ModelModal } from "./ModelModal";
import { ProviderModal } from "./ProviderModal";
import { openSignInModal } from "./SignInModal";
import { createEffectLine } from "./effectLine";
import { describeMissingBuiltinModel, describeModelRow, describeProviderRow } from "./modelsCopy";
import { rowAction, type SettingsPanelHost } from "./panelHost";
import { signInTargetFor } from "../../auth/signInSession";
import { sectionNote } from "./sectionNote";

/**
 * Model count from which the list's search input earns its place. Below it,
 * scanning a handful of rows beats typing; past it the list outgrows one glance
 * and search starts saving time instead of costing it.
 */
const MODEL_SEARCH_MIN_ROWS = 8;

/**
 * The Models tab as definitions.
 *
 * Provider and model collections use `list`: the framework owns their search
 * input and keeps its query across `update()`, which replaces the former scheme
 * that wrote the query into a DOM attribute, read it back before `empty()`, then
 * rebuilt the same rows by hand. The mutable rows themselves stay `render`
 * definitions because editing/deleting opens modals and needs two icon actions;
 * they still carry a name and description, so the list search and global settings
 * search both index them.
 */
export function modelsDefinitions(host: SettingsPanelHost): SettingDefinitionItem[] {
	const { t } = host;
	const live = new ModelsLiveState(host);
	return [
		activeModelControl(host, live),
		providersList(host),
		modelsList(host, live),
		{
			type: "group",
			heading: t.t("settings.networkHeading"),
			items: [
				sectionNote(t.t("settings.networkHeadingDesc")),
				{
					name: t.t("settings.networkTransport"),
					desc: t.t("settings.networkTransportDesc"),
					control: {
						type: "dropdown",
						key: "networkTransport",
						options: {
							requestUrl: t.t("settings.transportRequestUrl"),
							fetch: t.t("settings.transportFetch"),
						},
					},
				},
				{
					// Sits with the transport rather than beside compaction, which is the
					// other cost-shaped setting: both rows here answer for one request's
					// wire form, while compaction answers for the conversation. A reader
					// looking for what happens to a prompt after it leaves finds it here.
					//
					// Three options rather than a toggle because "off" is not the opposite
					// of "on": the middle value is pi's own default and the cheaper store,
					// and a boolean would have to pick which two of the three to offer.
					name: t.t("settings.cacheRetention"),
					desc: t.t("settings.cacheRetentionDesc"),
					control: {
						type: "dropdown",
						key: "cacheRetention",
						options: {
							long: t.t("settings.cacheRetentionLong"),
							short: t.t("settings.cacheRetentionShort"),
							none: t.t("settings.cacheRetentionNone"),
						},
					},
				},
			],
		},
	];
}

/**
 * Which model actually answers, chosen here rather than announced above.
 *
 * The panel's answer to "which model replied", which the old layout could only
 * convey by which controls looked enabled. A vault configured against a builtin
 * this build no longer carries is silently answered by a different one — the
 * substitution warning hangs off this same row as an effect line, because it is
 * about this choice: the two facts are unreadable apart.
 *
 * `render` rather than `control` because a change rewrites every active suffix
 * on the model rows; `update()` would rebuild this select under a keyboard
 * user's arrow keys, exactly the focus loss the old panel avoided with its row
 * handles. `getSettingDefinitions()` also runs once at registration purely to
 * index — reading the selected model there would cost indexing a model
 * resolution.
 */
function activeModelControl(host: SettingsPanelHost, live: ModelsLiveState): SettingDefinitionItem {
	const { settings, t } = host;
	return {
		name: t.t("settings.activeModelHeading"),
		desc: t.t("settings.activeModelDesc"),
		visible: () => settings.models.length > 0,
		render: (setting) => {
			const missing = host.missingBuiltinModel();
			if (missing) {
				// The effect-line slot every other consequence in this panel uses, so
				// the substitution reads as a consequence of this row rather than as
				// a plugin fault. Warn rather than error: nothing is broken, something
				// was answered by a stand-in.
				const notice = createEffectLine(setting.descEl);
				notice.setText(describeMissingBuiltinModel(missing, host.describeTarget(), host.t));
				notice.addClass("piem-settings-effect--warn");
			}
			setting.addDropdown((dropdown) => {
				for (const model of settings.models) dropdown.addOption(model.id, describeModelRow(settings, model, t));
				dropdown.setValue(settings.activeModelId ?? settings.models[0]?.id ?? "");
				dropdown.onChange(async (modelId) => {
					settings.activeModelId = modelId;
					await host.save();
					// Each list row marks the active one and changes in place.
					live.refreshRows();
				});
			});
		},
	};
}

/**
 * Element handles that may be changed without rebuilding the page.
 *
 * The active-model dropdown is often driven with arrow keys. Calling `update()`
 * from its change handler would rebuild the select under those keys and throw
 * focus away; the old panel deliberately kept these references to avoid that.
 * Definitions keep the same local ownership — no DOM query, no module-global
 * cache — and their cleanup clears stale elements when Obsidian tears a page
 * down.
 */
class ModelsLiveState {
	readonly rows = new Map<string, HTMLElement>();

	constructor(private readonly host: SettingsPanelHost) {}

	refreshRows(): void {
		for (const [id, descEl] of this.rows) {
			const model = this.host.settings.models.find((entry) => entry.id === id);
			if (model) descEl.setText(describeModelRow(this.host.settings, model, this.host.t));
		}
	}
}

function providersList(host: SettingsPanelHost): SettingDefinitionItem {
	const { settings, t } = host;
	return {
		type: "list",
		heading: t.t("settings.providersHeading"),
		addItem: {
			name: t.t("settings.addProvider"),
			action: () => openProviderModal(host),
		},
		// No `emptyState`: a list holding the section note is never empty, so the
		// framework would never draw it. The note carries the empty sentence instead.
		items: [
			sectionNote(t.t("settings.providersDesc"), settings.providers.length === 0 ? t.t("settings.noProviders") : undefined),
			...settings.providers.map((provider) => providerDefinition(host, provider)),
		],
	};
}

function providerDefinition(host: SettingsPanelHost, provider: ProviderConfig): SettingGroupItem {
	const { settings, t } = host;
	const boundModels = modelsForProvider(settings.models, provider.id);
	// A subscription row carries no key to edit, so its control is the
	// sign-in dialog instead. Key rows get nothing here: their credential
	// is managed through the edit form, and a second door to it would only
	// invite two ideas about where a key is changed.
	const actions = host.signIn?.actionsFor(signInTargetFor(provider));
	// Deleting an OAuth row signs it out — the stored credential is the
	// plugin's own keychain entry and has no life after its provider. Resolved
	// before the dialog opens (the sign-in button's pattern) so the
	// consequences name what will actually happen on confirm.
	const deleteConsequences = (signedIn: boolean) =>
		describeProviderDeletion(
			boundModels,
			actions ? (signedIn ? "oauth" : "inline") : provider.secretRef !== "" ? "ref" : "inline",
			t,
		);
	const confirmDelete = (signedIn: boolean) => {
		openConfirmDelete(host.app, {
			subject: t.t("confirmDelete.providerSubject", { name: describeProviderConfig(provider) }),
			consequences: deleteConsequences(signedIn),
			t,
			// copySecret only makes sense for a plaintext key this row owns; an
			// OAuth row's credential lives in the keychain, not in data.json.
			copySecret:
				!actions && provider.secretRef === "" && provider.apiKey !== "" ? provider.apiKey : undefined,
			onConfirm: async () => {
				if (actions && signedIn) {
					await actions.signOut();
				}
				removeProvider(settings, provider.id);
				await host.save();
				host.refresh();
			},
		});
	};
	return {
		name: describeProviderConfig(provider),
		desc: describeProviderRow(provider, boundModels.length, t),
		render: (setting) => {
			if (actions) {
				setting.addExtraButton((button) => {
					rowAction(button, "key-round", t.t("signIn.rowAction"));
					button.onClick(() =>
						void actions.isSignedIn().then((signedIn) => {
							openSignInModal({
								app: host.app,
								target: describeProviderConfig(provider),
								method: actions.method,
								signedIn,
								canStore: host.signIn?.canStore() ?? false,
								t,
								signIn: (interaction) => actions.signIn(interaction),
								signOut: () => actions.signOut(),
								onChanged: () => host.refresh(),
							});
						}),
					);
				});
			}
			setting.addExtraButton((button) => {
				rowAction(button, "pencil", t.t("settings.editProvider"));
				button.onClick(() => openProviderModal(host, provider));
			});
			setting.addExtraButton((button) => {
				rowAction(button, "trash-2", t.t("settings.deleteProvider"));
				button.onClick(() => {
					// Same async probe as the sign-in button: the dialog's copy and
					// its onConfirm both depend on whether a credential is stored.
					if (actions) {
						void actions.isSignedIn().then(confirmDelete);
					} else {
						confirmDelete(false);
					}
				});
			});
		},
	};
}

function openProviderModal(host: SettingsPanelHost, provider?: ProviderConfig): void {
	const { settings, t } = host;
	new ProviderModal({
		app: host.app,
		provider,
		secretStorage: host.secretStorage,
		readSecret: (id) => host.readSecret(id),
		t,
		test: (draft) => testDraftProvider(host, draft),
		onSubmit: async (saved) => {
			if (provider) replaceById(settings.providers, saved);
			else settings.providers.push(saved);
			await host.save();
			host.refresh();
		},
	}).open();
}

function modelsList(host: SettingsPanelHost, live: ModelsLiveState): SettingDefinitionItem {
	const { settings, t } = host;
	const hasProviders = settings.providers.length > 0;
	return {
		type: "list",
		heading: t.t("settings.modelsHeading"),
		// Offered only once the list outgrows a glance. Below the threshold scanning a
		// handful of rows beats typing, and a search box over four models is a control
		// that costs more attention than it saves.
		search:
			settings.models.length < MODEL_SEARCH_MIN_ROWS
				? undefined
				: {
						placeholder: t.t("settings.modelsFilterPlaceholder"),
						match: (definition, query) => {
							const haystack = `${definition.name} ${typeof definition.desc === "string" ? definition.desc : (definition.desc?.textContent ?? "")}`;
							return haystack.toLowerCase().includes(query.trim().toLowerCase());
						},
					},
		addItem: {
			name: t.t("settings.addModel"),
			action: () => openModelModal(host),
		},
		items: [
			// Which sentence depends on whether anything can be bound yet: with no
			// provider there is nothing to bind a model to, and explaining what a model
			// is would answer a question the reader has not reached.
			sectionNote(
				t.t(hasProviders ? "settings.modelsDescWithProviders" : "settings.modelsDescNoProviders"),
				hasProviders && settings.models.length === 0 ? t.t("settings.noModels") : undefined,
			),
			...settings.models.map((model) => modelDefinition(host, model, live)),
		],
	};
}

function modelDefinition(host: SettingsPanelHost, model: ModelConfig, live: ModelsLiveState): SettingGroupItem {
	const { settings, t } = host;
	return {
		name: describeModelConfig(model),
		desc: describeModelRow(settings, model, t),
		render: (setting) => {
			live.rows.set(model.id, setting.descEl);
			setting.addExtraButton((button) => {
				rowAction(button, "pencil", t.t("settings.editModel"));
				button.onClick(() => openModelModal(host, model));
			});
			setting.addExtraButton((button) => {
				rowAction(button, "trash-2", t.t("settings.deleteModel"));
				button.onClick(() => {
					openConfirmDelete(host.app, {
						subject: t.t("confirmDelete.modelSubject", { name: describeModelConfig(model) }),
						consequences: describeModelDeletion(settings, model, t),
						t,
						onConfirm: async () => {
							removeModel(settings, model.id);
							await host.save();
							host.refresh();
						},
					});
				});
			});
			return () => {
				if (live.rows.get(model.id) === setting.descEl) live.rows.delete(model.id);
			};
		},
	};
}

function openModelModal(host: SettingsPanelHost, model?: ModelConfig): void {
	const { settings, t } = host;
	if (settings.providers.length === 0) return;
	new ModelModal({
		app: host.app,
		model,
		providers: settings.providers,
		t,
		test: (draft) => testDraftModel(host, draft),
		listModels: (provider, signal) => listingCacheFor(settings.networkTransport).ensure(provider, signal),
		knownListings: () => listingCacheFor(settings.networkTransport).known(),
		// The catalog request is pinned to `requestUrl` inside modelsDev; passing
		// the transport in here would silently override that decision.
		fetchModelsDev: (signal) => fetchModelsDevIndex({ signal }),
		onSubmit: async (saved) => {
			if (model) replaceById(settings.models, saved);
			else {
				settings.models.push(saved);
				settings.activeModelId ??= saved.id;
			}
			await host.save();
			host.refresh();
		},
	}).open();
}

/**
 * Model listings collected this session, one cache per transport.
 *
 * Module-level rather than owned by a build: the definitions are rebuilt on every
 * `update()`, so anything a build owns is gone by the next one — and a cache that
 * emptied whenever the user added a provider would re-probe on the next form,
 * which is the cost it exists to avoid.
 *
 * Keyed by transport rather than rebuilt on change, because the transport is part
 * of what the answer depended on. A probe that came back empty because `fetch`
 * was blocked by CORS should not keep a switch to `requestUrl` from trying again,
 * and both answers stay usable if the user switches back.
 */
const listingCaches = new Map<NetworkTransport, ModelListingCache>();

/**
 * Runs a provider test against the draft rather than the saved row.
 *
 * The draft's provider is registered in a throwaway `Models` collection, which
 * is what lets a user verify an edit before committing it — testing the stored
 * row would report on configuration they are in the middle of replacing.
 *
 * The bundle's `fetch` travels with the probe so the test uses the transport the
 * user selected. Without it the request would go out on the platform `fetch`,
 * which is the very thing the requestUrl transport exists to avoid — a test
 * could then fail on CORS while real turns work, or pass while they do not.
 */
async function testDraftProvider(host: SettingsPanelHost, draft: ProviderConfig): Promise<ConnectionTestResult> {
	const { models, fetch: fetchImpl } = createObsidianModels({
		transport: host.settings.networkTransport,
		providers: [draft],
	});
	return testProviderConnection(models, draft, host.settings.models, host.t, { fetch: fetchImpl });
}

/** Same, for a model draft: the provider it names is resolved from saved settings. */
async function testDraftModel(host: SettingsPanelHost, draft: ModelConfig): Promise<ConnectionTestResult> {
	const provider = host.settings.providers.find((entry) => entry.id === draft.providerId);
	if (!provider) {
		return { ok: false, detail: host.t.t("modelModal.providerMissing") };
	}
	const { models, fetch: fetchImpl } = createObsidianModels({
		transport: host.settings.networkTransport,
		providers: [provider],
	});
	return testModelConnection(models, draft, provider, host.t, { fetch: fetchImpl });
}

function listingCacheFor(transport: NetworkTransport): ModelListingCache {
	const existing = listingCaches.get(transport);
	if (existing) {
		return existing;
	}
	const cache = new ModelListingCache({ fetch: createFetchForTransport(transport) });
	listingCaches.set(transport, cache);
	return cache;
}
