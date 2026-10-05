import { ItemView, Scope, type WorkspaceLeaf, type ViewStateResult } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import React from "react";
import { VIEW_TYPE_PIEM_CHAT } from "../constants";
import { BRAND_ICON_ID } from "../brandIcon";
import type { ObsidianAgentService } from "../agent/ObsidianAgentService";
import { ChatApp } from "./ChatApp";
import { PanelErrorBoundary } from "./PanelErrorBoundary";
import { ChatInputController, type PrefillResult } from "./ChatInputController";
import type { ContextReference } from "../agent/contextReference";
import { resolveWorkingNotePath, watchActiveNote } from "./activeNoteWatch";
import { watchSessionFile } from "./sessionFileWatch";
import { watchWindowFocus } from "./windowFocusWatch";
import type { DraftStore } from "../session/DraftStore";
import { getT } from "../i18n";
import type { AskUserBroker } from "../tools/askUserBroker";
import type { NativeChatManager } from "../session/NativeChatManager";
import type { NativeChatSession } from "../session/NativeChatSession";
import type { PiemSettings } from "../settings";
import { NativeChatApp } from "./NativeChatApp";

export interface NativeChatRoute {
	manager: NativeChatManager;
	getSettings: () => PiemSettings;
	newChat: () => Promise<void>;
	originalChat: () => Promise<void>;
	openHistory: () => void;
	openSettings: () => void;
}

export class PiemChatView extends ItemView {
	private readonly service: ObsidianAgentService;
	private readonly draftStore: DraftStore | undefined;
	private readonly inputController = new ChatInputController();
	/**
	 * Opens the subagent monitor, optionally already showing one run.
	 *
	 * Injected rather than reached for, because activating a leaf is the plugin's
	 * job: this view knows nothing about workspace layout, and a view that opened
	 * other views would be the second place that logic lives. Optional so a test
	 * can mount the panel without a workspace — the entry icon simply does not
	 * render, which is also the honest state when nothing can open it.
	 */
	private readonly openSubagents: ((subagentId?: string) => void) | undefined;
	/**
	 * Where `ask_user` parks a question for this transcript to answer. Passed down
	 * rather than reached for: the broker is shared with the tool set and the
	 * escalation modal, and only the plugin holds all three.
	 */
	private readonly askUserBroker: AskUserBroker | undefined;
	private root: Root | null = null;
	private nativePath?: string;
	private nativeSession?: NativeChatSession;
	private routeError?: string;
	private routeRevision = 0;

	constructor(
		leaf: WorkspaceLeaf,
		service: ObsidianAgentService,
		draftStore?: DraftStore,
		openSubagents?: (subagentId?: string) => void,
		askUserBroker?: AskUserBroker,
		private readonly native?: NativeChatRoute,
	) {
		super(leaf);
		this.service = service;
		this.draftStore = draftStore;
		this.openSubagents = openSubagents;
		this.askUserBroker = askUserBroker;
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "Enter", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.inputController.submit();
			return false;
		});
		// Tells the service which note the user is looking at, so every turn can name
		// it. Registered here rather than in `onOpen` because `registerEvent` is bound
		// to this component's load/unload, while `onOpen` can run again without an
		// intervening unload — handlers would accumulate one per open. Vault rename and
		// delete events keep pinned paths truthful when the file explorer changes them.
		for (const ref of watchActiveNote(
			this.app,
			(path) => { if (!this.nativePath) this.service.setActiveNotePath(path); },
			(oldPath, newPath) => this.service.renameContextPath(oldPath, newPath),
			(path) => this.service.forgetContextPath(path),
		)) {
			this.registerEvent(ref);
		}
		// Seeds the current note: the events only report changes from here on, and the
		// panel is usually opened while a note is already in focus.
		this.service.setActiveNotePath(resolveWorkingNotePath(this.app));
		// Catches renames made outside this plugin — another Obsidian window on the
		// same vault, a pi CLI, a hand edit — which the live session's in-memory
		// name never sees. Same constructor-not-onOpen reasoning as above. While the
		// panel is closed nothing displays the name, so no watcher runs then; the
		// seed below re-syncs on the next open instead.
		//
		// `register`, not `registerEvent`: this watcher debounces, so its teardown
		// is the vault listener *and* a pending timer. See {@link watchSessionFile}.
		this.register(
			watchSessionFile(
				this.app,
				() => this.nativePath ?? this.service.getActiveSessionPath(),
				() => void this.syncRoute(),
			),
		);
		// Seeds the name comparison the same way the note path is seeded: the events
		// only report that the file *may* have changed, and opening the panel is the
		// moment a name changed while it was closed becomes visible. The drift sync
		// also unions anything the other device landed while the panel was closed.
		void this.service.syncExternalSessionDrift();
		// Obsidian's own filesystem watcher misses events in some environments —
		// Flatpak portals block inotify, network mounts do not propagate, Linux
		// watch limits silently drop (its file explorer has the same blind spot).
		// Re-syncing on focus is the cheap net: the user just looked back at the
		// app, which is exactly when a change made elsewhere becomes relevant, and
		// the name comparison makes a no-op focus read invisible.
		//
		// The net hangs off the window this view's element belongs to — not the
		// module-global `window`, which is always the main one and would leave the
		// net deaf in a popout window, where the panel has its own. The watcher
		// follows the leaf when Obsidian migrates it between windows; reading the
		// window once at construction (or off `activeWindow`, which is whichever
		// window is focused *now*) is what goes stale.
		this.register(watchWindowFocus(this.contentEl, () => void this.syncRoute()));
	}

	private async syncRoute(): Promise<void> {
		if (this.nativePath) {
			if (this.nativeSession && !this.nativeSession.getSnapshot().closed) {
				try { await this.nativeSession.checkExternalChange(); } catch { /* The host publishes the storage failure. */ }
			}
		} else await this.service.syncExternalSessionDrift();
	}

	getState(): Record<string, unknown> { return this.nativePath ? { nativePath: this.nativePath } : {}; }

	private beginRoute(): number {
		this.nativeSession = undefined;
		this.routeError = undefined;
		this.inputController.setSubmitHandler(null);
		this.inputController.setFocusHandler(null);
		this.inputController.setPrefillHandler(null);
		// Unmount the previous form before any asynchronous file open can yield.
		if (this.root) flushSync(() => this.render());
		return ++this.routeRevision;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const path = state && typeof state === "object" && "nativePath" in state ? state.nativePath : undefined;
		this.nativePath = typeof path === "string" ? path : undefined;
		const revision = this.beginRoute();
		if (this.nativePath) {
			try {
				if (!(typeof __PIEM_NATIVE_CHAT_PREVIEW__ !== "undefined" && __PIEM_NATIVE_CHAT_PREVIEW__) || !this.native) throw new Error(getT(this.service.getSnapshot().language).t("nativeChat.previewRequired"));
				const session = await this.native.manager.open(this.nativePath);
				if (revision !== this.routeRevision) return;
				this.nativeSession = session;
			} catch (error) { if (revision === this.routeRevision) this.routeError = error instanceof Error ? error.message : String(error); }
		} else this.service.setActiveNotePath(resolveWorkingNotePath(this.app));
		if (revision !== this.routeRevision) return;
		this.render();
		await super.setState(state, result);
	}

	async showNative(path: string): Promise<void> {
		await this.leaf.setViewState({ type: VIEW_TYPE_PIEM_CHAT, active: true, state: { nativePath: path } });
	}
	async showLegacy(): Promise<void> {
		if (this.nativePath) await this.leaf.setViewState({ type: VIEW_TYPE_PIEM_CHAT, active: true, state: {} });
	}

	getViewType(): string {
		return VIEW_TYPE_PIEM_CHAT;
	}

	getDisplayText(): string {
		return getT(this.service.getSnapshot().language).t("view.tabTitle");
	}

	/**
	 * Repaints the tab header so a language change reaches the tab title.
	 *
	 * Obsidian only calls {@link getDisplayText} when it decides to redraw the
	 * header, so the title would otherwise keep the language it was opened in.
	 * `updateHeader` exists on `View` at runtime but is absent from the shipped
	 * type declarations, so it is feature-detected rather than declared — and a
	 * missing method costs only a stale tab title, never a crash.
	 */
	refreshHeader(): void {
		(this as unknown as { updateHeader?: () => void }).updateHeader?.();
		if (this.nativePath) this.render();
	}

	getIcon(): string {
		return BRAND_ICON_ID;
	}

	focusInput(): void {
		this.inputController.focus();
	}

	/**
	 * Queues a reference prefill for the composer.
	 *
	 * Safe to call before the React tree exists: the controller latches the text
	 * until `ChatApp` registers its handler, which is what makes
	 * `activateChatView()` + prefill work in a single awaited sequence.
	 */
	prefillComposer(text: string, session?: string, references?: readonly ContextReference[]): Promise<PrefillResult> {
		if (!this.root) return Promise.resolve(false);
		return this.inputController.prefill(text, session, references);
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("piem-chat-view");
		this.root = createRoot(this.contentEl);
		this.render();
	}

	private render(): void {
		if (!this.root) return;
		const native = (typeof __PIEM_NATIVE_CHAT_PREVIEW__ !== "undefined" && __PIEM_NATIVE_CHAT_PREVIEW__) && this.native;
		// One bad throw anywhere in the tree would otherwise unmount the root and
		// leave a blank panel for the rest of the Obsidian session. The boundary
		// turns that into a message plus a remount; what it caught goes to the
		// plugin log, because the console alone is invisible to most users.
		this.root.render(
			<PanelErrorBoundary
				// The fallback renders outside ChatApp's provider, so it re-asks the
				// snapshot instead of the context — same per-call resolution the rest
				// of the view's copy uses.
				getLanguage={() => this.service.getSnapshot().language}
				onError={(error) => console.error("piem: chat panel render failed", error)}
			>
				{this.nativePath ? ((typeof __PIEM_NATIVE_CHAT_PREVIEW__ !== "undefined" && __PIEM_NATIVE_CHAT_PREVIEW__) && native && this.nativeSession ? <NativeChatApp
					key={`${this.nativePath}:${this.routeRevision}`} session={this.nativeSession} app={this.app} component={this}
					getSettings={native.getSettings} inputController={this.inputController} draftStore={this.draftStore}
					onNewSession={native.newChat} onOpenOriginal={native.originalChat} onOpenHistory={native.openHistory} onOpenSettings={native.openSettings}
					onReopen={async () => {
						const path = this.nativePath;
						if (!path) return;
						const revision = this.beginRoute();
						try {
							const session = await native.manager.reopen(path);
							if (revision !== this.routeRevision) return;
							this.nativeSession = session;
						} catch (error) { if (revision === this.routeRevision) this.routeError = String(error); }
						if (revision === this.routeRevision) this.render();
					}}
				/> : <div className="piem-chat"><div role={this.routeError ? "alert" : "status"}>{this.routeError ?? getT(this.service.getSnapshot().language).t("chatStatus.opening")}</div></div>) : <ChatApp
					service={this.service}
					inputController={this.inputController}
					component={this}
					draftStore={this.draftStore}
					onOpenSubagents={this.openSubagents}
					askUserBroker={this.askUserBroker}
					onNewSession={native ? () => void native.newChat() : undefined}
				/>}
			</PanelErrorBoundary>,
		);
	}

	async onClose(): Promise<void> {
		this.routeRevision++;
		this.inputController.setSubmitHandler(null);
		this.inputController.setFocusHandler(null);
		this.inputController.setPrefillHandler(null);
		// Unmount first: the app writes the pending draft in its unmount effect,
		// which this then waits on so a panel closed mid-sentence keeps its text.
		this.root?.unmount();
		this.root = null;
		await this.draftStore?.flush();
	}
}
