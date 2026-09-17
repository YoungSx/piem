import { App, Modal, Notice, Setting } from "obsidian";
import type { TextComponent, ToggleComponent } from "obsidian";
import type { ConnectionTestResult } from "../../connectionTest";
import {
	describeProviderConfig,
	emptyModelConfig,
	type ModelConfig,
	type ProviderConfig,
} from "../../modelConfig";
import { getBuiltinModels, getBuiltinProviders } from "../../net/builtinCatalog";
import type { ProviderListing } from "../../net/modelListingCache";
import type { ModelsDevIndex } from "../../net/modelsDev";
import { CatalogSuggest, type CatalogSuggestion } from "./CatalogSuggest";
import { findCatalogCapabilityHint } from "./catalogCapabilityHint";
import { adviseCapabilities, type CapabilityField } from "./capabilityAdvice";
import { CAPABILITY_FIELDS, attachCapabilityAdvice, type CapabilityAdviceRow } from "./capabilityAdviceRow";
import { createCollapsibleSection } from "./collapsibleSection";
import type { Translator } from "../../i18n";
import { attachTestButton, type TestRowHandle } from "./testResult";
import { createModalStatus, DiscardGuard, submitOnEnter, type ModalStatus } from "./modalGuards";
import { createEffectLine } from "./effectLine";

/**
 * Add/edit form for one configured model.
 *
 * A model is edited in a modal rather than inline for the same reason providers
 * are: the form has to validate and offer a live connection test, and a panel
 * that rebuilds itself on every keystroke cannot host either.
 *
 * The provider is chosen from a dropdown of already-configured providers. That
 * is the one-to-one interaction the schema's one-to-many shape allows us to
 * relax later without another migration.
 */

export interface ModelModalOptions {
	app: App;
	/** Existing model to edit, or undefined to add one. */
	model?: ModelConfig;
	/** Providers available to bind to. Must be non-empty. */
	providers: readonly ProviderConfig[];
	/** Copy for every label, description, and button in this form. */
	t: Translator;
	/** Runs a live request against the draft. */
	test(draft: ModelConfig): Promise<ConnectionTestResult>;
	/** Persists the result. Called only on a valid submit. */
	onSubmit(model: ModelConfig): Promise<void>;
	/**
	 * Asks one endpoint which models it serves, for the id suggestions.
	 *
	 * Injected rather than reached for, exactly as {@link test} is: it decides
	 * which transport the request travels, which is a setting this form has no
	 * business reading. Optional so a caller that has no network — a test, or a
	 * future embedder — gets an empty suggestion list and nothing worse.
	 *
	 * Expected to resolve for an unreachable endpoint rather than reject; see
	 * {@link ModelListingCache}.
	 */
	listModels?(provider: ProviderConfig, signal: AbortSignal): Promise<ProviderListing>;
	/** Listings already collected this session, shown before any new probe returns. */
	knownListings?(): readonly ProviderListing[];
	/**
	 * Fetches the live models.dev capability index, shared per session. Optional
	 * for the same reason {@link listModels} is — a caller with no network gets no
	 * capability hints and every control on its default, which is editable.
	 * Expected to reject on failure; this form treats that silently, the way it
	 * treats a failed listing probe.
	 */
	fetchModelsDev?(signal: AbortSignal): Promise<ModelsDevIndex>;
}

/**
 * Builds the model-id suggestion list.
 *
 * Two sources, in priority order. First, what the user's own endpoints said when
 * asked — the authority on what they will actually accept, and the only source
 * that knows anything about a private gateway. Then whatever
 * {@link ../../net/builtinCatalog} carries, which since the catalog was trimmed
 * to the fallback pair is one id: enough to keep this loop and its attribution
 * honest, not enough to be a source. An endpoint that implements no listing
 * therefore offers nothing to pick from, which is correct — the field takes any
 * id typed into it, and a suggestion for a model that endpoint does not serve
 * would be worse than an empty list.
 *
 * Suggestions are scoped to the selected provider. The listing is a per-endpoint
 * answer — an OpenAI-compatible proxy fronts Claude and lists the Claude ids
 * under itself — so the selected provider's listing already carries every id
 * that endpoint accepts, and another provider's listing names ids its own
 * endpoint may not serve. Leaving those in made the list ignore a provider
 * switch, which read as the suggest being broken.
 *
 * The builtin fallback pair stays unscoped: it answers when no endpoint did.
 *
 * An id offered by several sources appears once, with every source named in the
 * description, rather than being attributed to whichever was probed first.
 */
export function buildModelSuggestions(
	listings: readonly ProviderListing[] = [],
	selectedProviderId?: string,
): CatalogSuggestion[] {
	const sourcesById = new Map<string, string[]>();

	const add = (id: string, source: string): void => {
		const sources = sourcesById.get(id);
		if (!sources) {
			sourcesById.set(id, [source]);
			return;
		}
		if (!sources.includes(source)) {
			sources.push(source);
		}
	};

	for (const listing of listings) {
		if (selectedProviderId !== undefined && listing.provider.id !== selectedProviderId) {
			continue;
		}
		for (const id of listing.modelIds) {
			add(id, describeProviderConfig(listing.provider));
		}
	}
	for (const provider of getBuiltinProviders()) {
		for (const model of getBuiltinModels(provider)) {
			add(model.id, provider);
		}
	}

	return [...sourcesById].map(([value, sources]) => ({ value, description: sources.join(", ") }));
}

/**
 * Validates a draft, returning a message or undefined.
 *
 * Exported and DOM-free so the rules are unit-testable: this is the panel's only
 * guard against saving a row that can never serve a request.
 */
export function validateModelDraft(
	draft: ModelConfig,
	providers: readonly ProviderConfig[],
	t: Translator,
): string | undefined {
	if (!draft.providerId) {
		return t.t("modelModal.chooseProvider");
	}
	if (!providers.some((provider) => provider.id === draft.providerId)) {
		return t.t("modelModal.providerMissing");
	}
	if (!draft.modelApiId.trim()) {
		return t.t("modelModal.modelIdRequired");
	}
	return undefined;
}

export class ModelModal extends Modal {
	private readonly draft: ModelConfig;
	private readonly isNew: boolean;
	private readonly options: ModelModalOptions;
	private testRow: TestRowHandle | null = null;
	/** Aborts any listing probe still outstanding when the form closes. */
	private probes = new AbortController();
	/** Listings this form has collected, seeded from the session's existing ones. */
	private listings: readonly ProviderListing[] = [];
	private reasoningToggle: ToggleComponent | null = null;
	private imagesToggle: ToggleComponent | null = null;
	/** The live models.dev answers, once its fetch lands; absent until then. */
	private modelsDevIndex: ModelsDevIndex | undefined;
	/** Input fields for the numeric limits, so an adopted recommendation can fill one. */
	private contextWindowInput: TextComponent | null = null;
	private maxTokensInput: TextComponent | null = null;
	/** One advice line per capability control, attached where the control is built. */
	private adviceRows: Partial<Record<CapabilityField, CapabilityAdviceRow>> = {};
	/** The draft as it stood at open, serialized — the baseline the dirty check compares against. */
	private originalDraft: string;
	private readonly guard: DiscardGuard;
	private status: ModalStatus | null = null;

	constructor(options: ModelModalOptions) {
		super(options.app);
		this.options = options;
		this.isNew = options.model === undefined;
		this.draft = options.model ? { ...options.model } : emptyModelConfig(options.providers[0]?.id ?? "");
		this.originalDraft = JSON.stringify(this.trimmedDraft());
		this.guard = new DiscardGuard(() => {
			this.status?.showError(options.t.t("discard.warning"));
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("piem-settings-modal");
		const { t } = this.options;
		this.setTitle(t.t(this.isNew ? "modelModal.addTitle" : "modelModal.editTitle"));

		this.probes = new AbortController();
		this.listings = this.options.knownListings?.() ?? [];
		// Opening this form is the deliberate action that earns a request, so the
		// selected provider is asked now — one endpoint, not a fan-out across every
		// configured one. Nothing waits on it: suggestions render from what is
		// already known, and the answer joins the list when it arrives.
		this.probeSelectedProvider();
		// Same trigger as the listing probe: opening the form is the deliberate
		// action that earns the one shared request. The session cache collapses
		// every later open into a no-op.
		this.fetchCapabilityIndex();
		// Editing starts from a stored choice, so the catalog's answer is reported
		// but never applied over it; a form opened to add starts with an empty id,
		// which has no recommendation to show either way.
		this.refreshCatalogAdvice();

		new Setting(contentEl)
			.setName(t.t("modelModal.provider"))
			.setDesc(t.t("modelModal.providerDesc"))
			.addDropdown((dropdown) => {
				for (const provider of this.options.providers) {
					dropdown.addOption(provider.id, describeProviderConfig(provider));
				}
				dropdown.setValue(this.draft.providerId);
				dropdown.onChange((providerId) => {
					this.draft.providerId = providerId;
					this.onEdit();
					this.testRow?.reset();
					// Picking a different endpoint is the second deliberate action that
					// earns a request. Still one endpoint, still nothing awaited here.
					this.probeSelectedProvider();
				});
			});

		new Setting(contentEl)
			.setName(t.t("modelModal.modelId"))
			.setDesc(t.t("modelModal.modelIdDesc"))
			.addText((text) => {
				// A model id, not prose: sentence-casing it would show an id no
				// server accepts.
				text.setPlaceholder(t.t("modelModal.modelIdPlaceholder"));
				text.setValue(this.draft.modelApiId);
				text.onChange((value) => {
					this.draft.modelApiId = value;
					this.onEdit();
					this.testRow?.reset();
					// The id decides what the catalog can say about anything else on
					// the form; a changed id is a changed question, so every advice
					// line is re-asked — and any answer left from the last id is
					// overwritten, the exact failure issue #160 reported.
					this.refreshCatalogAdvice();
				});
				// Read through a closure rather than passed as a snapshot, so a probe
				// that lands after this field was built still shows up, and so a
				// provider switch re-scopes the list: the suggest re-reads on every
				// keystroke, and never triggers a request itself.
				new CatalogSuggest(this.app, text.inputEl, () => buildModelSuggestions(this.listings, this.draft.providerId), (value) => {
					this.draft.modelApiId = value;
					this.onEdit();
					this.testRow?.reset();
					this.refreshCatalogAdvice();
				});
			});

		new Setting(contentEl)
			.setName(t.t("modelModal.displayName"))
			.setDesc(t.t("modelModal.displayNameDesc"))
			.addText((text) => {
				text.setPlaceholder(this.draft.modelApiId || t.t("modelModal.displayNamePlaceholder"));
				text.setValue(this.draft.displayName);
				text.onChange((value) => {
					this.draft.displayName = value;
					this.onEdit();
				});
				submitOnEnter(text.inputEl, () => void this.submit());
			});

		// The four capability fields fold behind the identity three (provider, ID,
		// display name), which stay flat: a new model cannot be saved without them,
		// so hiding anything required would trade one scroll for a click and a
		// hunt. Collapsed only when there is nothing to read — a new model starts
		// with every capability open to recommendation, and an edit starts open
		// when any stored value leaves the default.
		const capabilityBody = createCollapsibleSection(contentEl, {
			label: t.t("modelModal.capabilityGroup"),
			description: t.t("modelModal.capabilityGroupHint"),
			open:
				this.isNew ||
				this.draft.contextWindow !== undefined ||
				this.draft.maxTokens !== undefined ||
				this.draft.reasoning ||
				this.draft.supportsImages,
		});

		const contextWindowSetting = new Setting(capabilityBody)
			.setName(t.t("modelModal.contextWindow"))
			.setDesc(t.t("modelModal.contextWindowDesc"));
		// A number this field will silently drop — 0, negative, or not a number —
		// has to say so where the typing happened, not after a save that never
		// picked the value up.
		const contextWindowHint = createEffectLine(contextWindowSetting.descEl);
		this.adviceRows.contextWindow = attachCapabilityAdvice<number>(contextWindowSetting, t, (value) => {
			this.draft.contextWindow = value;
			this.contextWindowInput?.setValue(String(value));
			this.onEdit();
			this.testRow?.reset();
			this.refreshCatalogAdvice();
		});
		contextWindowSetting.addText((text) => {
			text.inputEl.type = "number";
			text.setPlaceholder(t.t("modelModal.contextWindowPlaceholder"));
			text.setValue(this.draft.contextWindow ? String(this.draft.contextWindow) : "");
			this.contextWindowInput = text;
			text.onChange((value) => {
				const parsed = Number.parseInt(value, 10);
				const valid = Number.isInteger(parsed) && parsed > 0;
				this.draft.contextWindow = valid ? parsed : undefined;
				contextWindowHint.setText(value.trim() !== "" && !valid ? t.t("modelModal.positiveNumberHint") : "");
				this.onEdit();
			});
			submitOnEnter(text.inputEl, () => void this.submit());
		});

		const maxTokensSetting = new Setting(capabilityBody)
			.setName(t.t("modelModal.maxTokens"))
			.setDesc(t.t("modelModal.maxTokensDesc"));
		const maxTokensHint = createEffectLine(maxTokensSetting.descEl);
		this.adviceRows.maxTokens = attachCapabilityAdvice<number>(maxTokensSetting, t, (value) => {
			this.draft.maxTokens = value;
			this.maxTokensInput?.setValue(String(value));
			this.onEdit();
			this.testRow?.reset();
			this.refreshCatalogAdvice();
		});
		maxTokensSetting.addText((text) => {
			text.inputEl.type = "number";
			text.setPlaceholder(t.t("modelModal.maxTokensPlaceholder"));
			text.setValue(this.draft.maxTokens ? String(this.draft.maxTokens) : "");
			this.maxTokensInput = text;
			text.onChange((value) => {
				const parsed = Number.parseInt(value, 10);
				const valid = Number.isInteger(parsed) && parsed > 0;
				this.draft.maxTokens = valid ? parsed : undefined;
				maxTokensHint.setText(value.trim() !== "" && !valid ? t.t("modelModal.positiveNumberHint") : "");
				this.onEdit();
			});
			submitOnEnter(text.inputEl, () => void this.submit());
		});

		const thinkingSetting = new Setting(capabilityBody)
			.setName(t.t("modelModal.supportsThinking"))
			.setDesc(t.t("modelModal.supportsThinkingDesc"));
		// The advice line lives in the description area, appended after `setDesc`
		// — which replaces the description's contents — and is rewritten in place
		// as the id changes rather than re-rendering the form, which would throw
		// focus out of the field.
		this.adviceRows.reasoning = attachCapabilityAdvice<boolean>(thinkingSetting, t, (value) => {
			this.draft.reasoning = value;
			this.reasoningToggle?.setValue(value);
			this.onEdit();
			this.testRow?.reset();
			this.refreshCatalogAdvice();
		});
		thinkingSetting.addToggle((toggle) => {
			this.reasoningToggle = toggle;
			toggle.setValue(this.draft.reasoning);
			toggle.onChange((reasoning) => {
				// An explicit choice, adopted or clicked, outranks nothing the form
				// would later overwrite: the catalog only ever advises now.
				this.draft.reasoning = reasoning;
				this.onEdit();
				this.testRow?.reset();
				this.refreshCatalogAdvice();
			});
		});

		const imagesSetting = new Setting(capabilityBody)
			.setName(t.t("modelModal.supportsImages"))
			.setDesc(t.t("modelModal.supportsImagesDesc"));
		this.adviceRows.images = attachCapabilityAdvice<boolean>(imagesSetting, t, (value) => {
			this.draft.supportsImages = value;
			this.imagesToggle?.setValue(value);
			this.onEdit();
			this.testRow?.reset();
			this.refreshCatalogAdvice();
		});
		imagesSetting.addToggle((toggle) => {
			this.imagesToggle = toggle;
			toggle.setValue(this.draft.supportsImages);
			toggle.onChange((supportsImages) => {
				this.draft.supportsImages = supportsImages;
				this.onEdit();
				this.testRow?.reset();
				this.refreshCatalogAdvice();
			});
		});

		// Placed above the save row so a failing verdict is read before committing.
		const testSetting = new Setting(contentEl)
			.setName(t.t("modelModal.connection"))
			.setDesc(t.t("modelModal.connectionDesc"));
		this.testRow = attachTestButton(testSetting, t, () => this.runTest());

		// Between the last field and the buttons: a failing verdict is read on the
		// way to save, and it stays until the next edit instead of expiring.
		this.status = createModalStatus(contentEl);

		// Sticks to the modal's bottom edge so the save row stays reachable however
		// far the body has scrolled.
		new Setting(contentEl)
			.setClass("piem-settings-modal-footer")
			.addButton((button) => {
				button.setButtonText(t.t("modelModal.cancel"));
				// Cancel is an explicit discard, so it earns its close.
				button.onClick(() => {
					this.guard.allowClose();
					this.close();
				});
			})
			.addButton((button) => {
				button.setButtonText(t.t(this.isNew ? "modelModal.add" : "modelModal.save"));
				button.setCta();
				button.onClick(() => void this.submit());
			});
	}

	/**
	 * A stray Esc must not silently throw away a half-filled form: the first
	 * press warns and stays, the second — or a clean draft — closes.
	 */
	close(): void {
		if (this.guard.shouldClose(this.isDirty())) {
			super.close();
		}
	}

	onClose(): void {
		// Stops this form waiting on a listing it can no longer show. The request
		// itself is left to finish inside the cache, so reopening the form reuses
		// the answer instead of starting over.
		this.probes.abort();
		this.contentEl.empty();
	}

	/**
	 * Re-reads the recommendation sources for the current model id and rewrites
	 * the four advice lines.
	 *
	 * One doctrine, four controls: **advise, never write.** The catalog reports
	 * what it knows; the value stays the user's until they adopt a recommendation
	 * by clicking for it. Before issue #160 this method ran two contradictory
	 * rules — toggles re-applied on every id edit, numbers filled once and then
	 * went silent forever, gated on the field being blank. A changed id therefore
	 * left the previous model's number sitting under the new one with nothing said
	 * about it, and `contextWindow` is not decoration: it feeds the context gauge
	 * and the compaction threshold.
	 *
	 * Every line is rewritten on every call, including to empty. A line left
	 * standing from a previous id is exactly the stale claim this replaced, so
	 * {@link adviseCapabilities} returning nothing for a field is an instruction to
	 * clear it, not an absence of instruction.
	 */
	private refreshCatalogAdvice(): void {
		const hint = findCatalogCapabilityHint(this.draft.modelApiId, this.modelsDevIndex);
		const advice = adviseCapabilities(
			{
				contextWindow: this.draft.contextWindow,
				maxTokens: this.draft.maxTokens,
				reasoning: this.draft.reasoning,
				images: this.draft.supportsImages,
			},
			hint,
			this.draft.modelApiId.trim() !== "",
		);
		for (const field of CAPABILITY_FIELDS) {
			this.adviceRows[field]?.render(advice.find((entry) => entry.field === field));
		}
	}

	/**
	 * Starts the shared models.dev fetch, if this form was handed the option.
	 *
	 * When it lands, the advice re-runs against the live index: every line
	 * re-reports for the current id, which may turn a snapshot-backed claim into
	 * a live-backed one, or into a warning once the live index stops backing the
	 * stored value. Nothing is applied — the doctrine is advise, never write, so
	 * a fetch that merely arrived late cannot move a stored number. Failure is
	 * silent, exactly like a failed listing probe: the snapshot still speaks.
	 */
	private fetchCapabilityIndex(): void {
		if (!this.options.fetchModelsDev) {
			return;
		}
		const signal = this.probes.signal;
		void this.options.fetchModelsDev(signal).then(
			(index) => {
				if (signal.aborted) {
					return;
				}
				this.modelsDevIndex = index;
				this.refreshCatalogAdvice();
			},
			() => {
				// Offline, aborted, or models.dev moved on. The snapshot is the
				// only source today, which is what the form already showed.
			},
		);
	}

	/**
	 * Asks the selected provider for its model ids, in the background.
	 *
	 * Fires on open and on a provider change — both deliberate user actions — and
	 * never on the typing path. The cache behind it collapses repeats, so switching
	 * back and forth between two providers costs two requests in total.
	 *
	 * Failure is silent by design: the suggestion list is simply shorter, and the
	 * connection-test button is the deliberate way to find out why an endpoint is
	 * unhappy. An abort is silent too — the form is gone.
	 */
	private probeSelectedProvider(): void {
		if (!this.options.listModels) {
			return;
		}
		const provider = this.options.providers.find((entry) => entry.id === this.draft.providerId);
		if (!provider) {
			return;
		}
		const signal = this.probes.signal;
		// Invoked as a property rather than through an extracted reference, so an
		// implementation that is a real method keeps its receiver.
		void this.options.listModels(provider, signal).then(
			() => {
				if (signal.aborted) {
					return;
				}
				// Re-read the cache rather than appending the one result: it is the
				// authority on which fingerprint is current, so a provider whose URL
				// was corrected does not end up listed under both.
				this.listings = this.options.knownListings?.() ?? this.listings;
			},
			() => {
				// Unreachable endpoint or a closed form. Nothing to add either way.
			},
		);
	}

	/**
	 * Runs the connection test against the trimmed draft.
	 *
	 * Validation happens here rather than inside the shared button so the message
	 * is this form's own wording, and so a test never leaves as a request that is
	 * certain to fail for a reason the panel already knows.
	 */
	private async runTest(): Promise<ConnectionTestResult> {
		const draft = this.trimmedDraft();
		const problem = validateModelDraft(draft, this.options.providers, this.options.t);
		if (problem) {
			return { ok: false, detail: problem };
		}
		return this.options.test(draft);
	}

	/** Trims on read so a stray space never reaches the wire or the store. */
	private trimmedDraft(): ModelConfig {
		return {
			...this.draft,
			modelApiId: this.draft.modelApiId.trim(),
			displayName: this.draft.displayName.trim(),
		};
	}

	/** One fresh edit clears the old verdict — it no longer describes this draft. */
	private onEdit(): void {
		this.guard.edited();
		this.status?.clear();
	}

	/** True when the draft no longer matches what the form opened with. */
	private isDirty(): boolean {
		return JSON.stringify(this.trimmedDraft()) !== this.originalDraft;
	}

	private async submit(): Promise<void> {
		const { t } = this.options;
		const draft = this.trimmedDraft();
		const problem = validateModelDraft(draft, this.options.providers, t);
		if (problem) {
			// Inline first, so the problem survives being read; the Notice is the
			// redundant shout for a user whose eyes were elsewhere.
			this.status?.showError(problem);
			new Notice(problem);
			return;
		}
		this.status?.clear();
		try {
			await this.options.onSubmit(draft);
			new Notice(t.t(this.isNew ? "modelModal.added" : "modelModal.saved"));
			this.guard.allowClose();
			this.close();
		} catch (cause) {
			const message = t.t("modelModal.couldNotSave", { message: cause instanceof Error ? cause.message : String(cause) });
			this.status?.showError(message);
			new Notice(message);
		}
	}
}
