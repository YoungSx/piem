import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Notice, type App, type Component } from "obsidian";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { NativeChatSession } from "../session/NativeChatSession";
import { MAX_DRAFT_LENGTH, type DraftStore } from "../session/DraftStore";
import { listModelChoices, resolveModelChoice, type PiemSettings } from "../settings";
import { getT, resolveLanguage, type LanguageHost } from "../i18n";
import { ChatComposer } from "./ChatComposer";
import { MessageList } from "./MessageList";
import { ModelSwitcher } from "./ModelSwitcher";
import { ThinkingLevelSelector } from "./ThinkingLevelSelector";
import { TranslatorProvider } from "./TranslatorContext";
import { IconButton } from "./ObsidianIcon";
import { useSessionDraft } from "./useSessionDraft";
import { nativeChatProjection } from "./nativeChatProjection";
import type { ChatInputController } from "./ChatInputController";
import { appendToDraft } from "./noteReference";

export interface NativeChatAppProps {
	session: NativeChatSession;
	app: App;
	component: Component;
	getSettings: () => PiemSettings;
	inputController?: ChatInputController;
	draftStore?: DraftStore;
	onNewSession: () => Promise<void>;
	onOpenHistory: () => void;
	onOpenOriginal?: () => Promise<void>;
	onReopen: () => Promise<void>;
	onOpenSettings?: () => void;
}

/** The preview's UI speaks directly to Pi; the original chat keeps its extension contract. */
export function NativeChatApp({ session, app, component, getSettings, inputController, draftStore, onNewSession, onOpenHistory, onOpenOriginal, onReopen, onOpenSettings }: NativeChatAppProps): React.JSX.Element {
	const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
	const projection = nativeChatProjection(snapshot.view);
	const settings = getSettings();
	const language = resolveLanguage(app.vault as LanguageHost, settings.language);
	const t = getT(language);
	const draft = useSessionDraft(draftStore, session.id);
	const [submitting, setSubmitting] = useState(false);
	const admission = useRef(false);
	const [error, setError] = useState<string>();
	const draftText = useRef(draft.draft);
	draftText.current = draft.draft;
	const focusRequested = useCallback((focus: (() => void) | null) => inputController?.setFocusHandler(focus), [inputController]);
	const [anchor, setAnchor] = useState<string>();
	const modelId = projection.agent.model?.modelId;
	const model = modelId ? resolveModelChoice(settings, modelId) : undefined;
	const row = settings.models.find(choice => choice.id === modelId);
	const provider = settings.providers.find(candidate => candidate.id === row?.providerId);
	const isConfigured = !!model && !!provider && !!(provider.apiKey.trim() || provider.oauthFlow);
	const thinkingLevel = model ? clampThinkingLevel(model, projection.agent.thinkingLevel ?? "off") : "off";
	const report = useCallback((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)), []);
	const act = (work: () => void | Promise<unknown>) => { try { void Promise.resolve(work()).catch(report); } catch (failure) { report(failure); } };

	const send = useCallback(async () => {
		if (admission.current || !draft.ready || !draft.draft.trim() || snapshot.closed || projection.busy || !isConfigured) return;
		if (draft.references.length) { new Notice(t.t("nativeChat.referencesUnavailable")); return; }
		admission.current = true;
		setSubmitting(true);
		setError(undefined);
		const sent = { text: draft.draft, references: draft.references };
		try {
			await session.submit(sent.text);
			// Admission is durable. Preserve edits made while admission was pending.
			await draft.consumeDraft(sent);
		} catch (failure) { report(failure); }
		finally { admission.current = false; setSubmitting(false); }
	}, [draft, snapshot.closed, projection.busy, isConfigured, session, t, report]);

	useEffect(() => {
		inputController?.setSubmitHandler(() => void send());
		return () => inputController?.setSubmitHandler(null);
	}, [inputController, send]);
	useEffect(() => {
		if (!inputController || !draft.ready) return;
		inputController.setPrefillHandler((text, references) => {
			if (references?.length) { new Notice(t.t("nativeChat.referencesUnavailable")); return "reported"; }
			const next = appendToDraft(draftText.current, text);
			if (next.length > MAX_DRAFT_LENGTH) { new Notice(t.t("noteReference.draftFull", { limit: MAX_DRAFT_LENGTH })); return "reported"; }
			draftText.current = next;
			draft.setDraft(next);
			return true;
		}, session.id);
		return () => inputController.suspendPrefill();
	}, [draft, session.id, inputController, t]);
	useLayoutEffect(() => { inputController?.notifyPrefillCommitted(); }, [draft.draft, inputController]);
	useEffect(() => () => { inputController?.setPrefillHandler(null); inputController?.setFocusHandler(null); }, [inputController]);

	return <TranslatorProvider language={language}>
		<div className="piem-chat" aria-busy={(!snapshot.paused && !snapshot.closed && projection.busy) || submitting}>
			<header className="piem-chat__header" aria-label={t.t("chat.headerAria")}>
				<h2 className="piem-chat__title">{t.t("nativeChat.title")}</h2>
				<div className="piem-chat__header-actions">
				<IconButton icon="history" label={t.t("nativeChat.history")} onClick={onOpenHistory} />
				<IconButton icon="plus" label={t.t("nativeChat.newChat")} onClick={() => act(onNewSession)} />
				</div>
			</header>
			<div className="piem-chat__banner piem-chat__banner--notice" role="note"><span className="piem-chat__banner-text">{t.t("nativeChat.disclosure")}</span>
				{onOpenOriginal && <button type="button" className="piem-chat__banner-action" onClick={() => act(onOpenOriginal)}>{t.t("nativeChat.openOriginal")}</button>}
			</div>
			{(error || snapshot.error) && <div className="piem-chat__banner piem-chat__banner--error" role="alert"><span className="piem-chat__banner-text">{snapshot.error ?? error}</span></div>}
			{snapshot.closed && <button type="button" className="piem-chat__banner-action" onClick={() => act(onReopen)}>{t.t("nativeChat.reopen")}</button>}
			{snapshot.paused && projection.busy && !snapshot.closed && <button type="button" className="piem-chat__banner-action" onClick={() => act(() => session.resume())}>{t.t("nativeChat.resume")}</button>}
			{(projection.retry || projection.isCompacting) && <div role="status">{t.t(projection.retry ? "nativeChat.retrying" : "nativeChat.compacting")}</div>}
			<MessageList messages={projection.messages} isStreaming={projection.busy && !snapshot.paused && !snapshot.closed}
				pendingToolCalls={projection.pendingToolCalls} isCompacting={projection.isCompacting}
				app={app} component={component} sourcePath="" composerAnchorId={anchor}
				isConfigured={isConfigured} showAgentDetails={settings.showAgentDetails} traceExpand={settings.traceExpand} onOpenSettings={onOpenSettings} />
			<ChatComposer canQueue={false} input={draft.draft} onInputChange={draft.setDraft} isSubmitting={submitting || projection.busy}
				isStreaming={projection.busy && !snapshot.closed} isCompacting={projection.isCompacting && !snapshot.closed} isRewinding={submitting}
				isInitializing={!draft.ready || snapshot.closed} isConfigured={isConfigured} commands={[]}
				sendShortcut={settings.sendShortcut} onSend={() => void send()} onAbort={() => act(() => session.abort())}
				onFocusRequested={focusRequested}
				onAnchorIdChange={setAnchor}
				onAddImages={() => new Notice(t.t("nativeChat.imagesUnavailable"))}
				modelSwitcher={<ModelSwitcher target={{ modelChoices: listModelChoices(settings), activeModelId: modelId,
					provider: model?.provider ?? "", modelId: model?.id ?? "" }} onOpenSettings={onOpenSettings}
					onSelect={id => { const next = resolveModelChoice(getSettings(), id); if (next) act(() => session.configure({ model: { provider: next.provider, modelId: id }, thinkingLevel: clampThinkingLevel(next, thinkingLevel) })); }} />}
				thinkingSelector={<ThinkingLevelSelector target={{ thinkingLevel, thinkingLevels: model ? getSupportedThinkingLevels(model) : ["off"] }}
					onSelect={level => { if (model) act(() => session.configure({ thinkingLevel: clampThinkingLevel(model, level) })); }} />}
			/>
		</div>
	</TranslatorProvider>;
}
