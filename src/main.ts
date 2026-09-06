import { Notice, Plugin, type DataAdapter, type Editor, type WorkspaceLeaf } from "obsidian";
import { PiemSettingTab, normalizeSettings, type PiemSettings } from "./settings";
import { VIEW_TYPE_PIEM_CHAT, VIEW_TYPE_PIEM_LOGS, VIEW_TYPE_PIEM_SUBAGENTS, PLUGIN_ID } from "./constants";
import { createPluginLogger, type PluginLogger } from "./logging/pluginLogger";
import { getLogFilePath } from "./logging/logFile";
import { PiemLogView } from "./logging/logView";
import { persistedSettings, resolveSecretRefs } from "./settingsSecrets";
import { NOOP_LOGGER, type LoggerLike } from "./logging/Logger";
import { createSecretEnvironment, type SecretEnvironment } from "./keychainEnv";
import { createKeychainCredentialStore } from "./auth/credentialStore";
import { createSignInSession, type SignInSession } from "./auth/signInSession";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { createObsidianRequestUrlFetch } from "./net/obsidianFetch";
import { DraftStore } from "./session/DraftStore";
import { ObsidianSessionManager } from "./session/ObsidianSessionManager";
import { getLegacySessionDir, isLegacySessionDir } from "./session/sessionDir";
import { ObsidianAgentService } from "./agent/ObsidianAgentService";
import { McpManager } from "./mcp/mcpManager";
import { emptySkillLoadReport, type SkillLoadReport } from "./agent/skillLoader";
import { PiemChatView } from "./ui/PiemChatView";
import { PiemSubagentView } from "./ui/PiemSubagentView";
import { requestNoteReference, warnIfTruncated } from "./ui/noteReferenceCommand";
import { addAskPiemFileMenuEntry, askPiemFileMenuOptions } from "./ui/fileMenuEntry";
import { openSessionDeleteConfirm, openSessionPicker } from "./ui/sessionDialogs";
import { BRAND_ICON_ID, registerBrandIcon } from "./brandIcon";
import { registerVendorIcons } from "./net/vendorIcons";
import { getT, resolveLanguage, type LanguageHost, type Translator } from "./i18n";
import { AskUserBroker } from "./tools/askUserBroker";
import { AskUserModal } from "./ui/AskUserModal";
import { isChatPanelVisible } from "./ui/panelVisibility";

export default class PiemPlugin extends Plugin {
	// Fresh defaults until `onload` loads persisted data; `normalizeSettings` deep-copies
	// so the shared DEFAULT_SETTINGS object is never mutated in place.
	settings: PiemSettings = normalizeSettings(null);
	private agentService: ObsidianAgentService | null = null;
	/**
	 * Assembled once per load, before settings: the settings migration is the
	 * first code that can fail, and its catch block is where logging has to
	 * already exist. The level reads through the settings closure, so the
	 * object here never needs replacing.
	 */
	private pluginLogger: PluginLogger | null = null;
	/**
	 * Plugin-lifecycle logger, assigned right after `pluginLogger` exists and
	 * before anything that can fail. Defaults to no-op so field initializers and
	 * a shorted `onload` can still touch it without throwing.
	 */
	private log: LoggerLike = NOOP_LOGGER;
	private draftStore: DraftStore | null = null;
	/**
	 * The one `ask_user` queue, shared by three parties: the tool pushes questions
	 * into it, the chat panel renders the head, and {@link AskUserModal} answers it
	 * when the panel is not on screen. Built here because this is the only place
	 * that can see all three — the composition root.
	 *
	 * Held for teardown too: an unload while a question is open leaves a promise
	 * nobody would ever settle, and {@link AskUserBroker.clear} reports the one
	 * outcome the tool already knows how to handle.
	 */
	private askUserBroker: AskUserBroker | null = null;
	/**
	 * Escalated dialogs by request id, so one settled elsewhere can be taken off
	 * the screen. A map rather than a single slot because the broker serializes
	 * questions but not the frames: a retract can arrive for a request whose modal
	 * is already gone, and a stale entry must not close a newer one.
	 */
	private readonly openAskModals = new Map<string, AskUserModal>();
	/**
	 * Held so the settings tab can report on the chat folder.
	 *
	 * The panel asks where logs are actually being written and how many are there,
	 * and the manager is what resolves the stored folder. Nullable rather than
	 * asserted: the settings tab outlives a failed `onload`, and a dialog reporting
	 * on chats must not be the thing that throws.
	 */
	private sessionManager: ObsidianSessionManager | null = null;
	/**
	 * Resolved once per load. In-memory settings always hold plaintext; this
	 * decides whether a provider's credential is resolved from the keychain at
	 * load and blanked at save, or lives inline in `data.json`.
	 */
	private secretEnvironment: SecretEnvironment | null = null;
	/**
	 * One credential store for the session; see {@link requireCredentialStore}.
	 */
	private credentialStore: CredentialStore | null = null;
	/**
	 * The MCP client bridge. `onload` warms it with a fire-and-forget connect,
	 * which is also the first "ask" — the manager itself only pays for the
	 * servers, not the construction. Reads the server list and the transport
	 * through closures, so a settings change reaches the next connect without
	 * rebuilding the manager or dropping live connections.
	 */
	private mcpBridge: McpManager | null = null;
	/**
	 * The panel's sign-in facade, built on first ask. Stateless over its
	 * closures — see {@link signInSession} — so caching buys identity, not
	 * correctness.
	 */
	private signInBridge: SignInSession | null = null;

	/** The MCP bridge, constructing it on first use. */
	get mcpManager(): McpManager {
		this.mcpBridge ??= new McpManager(
			() => this.settings.mcpServers,
			() => this.settings.networkTransport,
			this.manifest.version,
		);
		return this.mcpBridge;
	}

	/**
	 * Detection is synchronous and total, so the resolved environment is cached
	 * directly. An earlier revision cached a Promise, which meant a rejection
	 * during detection was memoised and re-thrown on every later access — and
	 * because this sits on the `onload` path, that took the whole plugin down.
	 */
	private requireSecretEnvironment(): SecretEnvironment {
		this.secretEnvironment ??= createSecretEnvironment({ host: this.app, log: (message) => this.log.debug(message) });
		return this.secretEnvironment;
	}

	/**
	 * Where subscription credentials live, resolved once for the whole session.
	 *
	 * Cached for a reason beyond thrift: the store serializes OAuth refresh per
	 * provider, and two instances would be two locks — so two concurrent requests
	 * could each rotate the same refresh token and one rotation would already be
	 * revoked when it landed. Everything that touches a subscription therefore
	 * reads through this one accessor: the agent's models bundle, and the settings
	 * panel's sign-in.
	 */
	private requireCredentialStore(): CredentialStore {
		this.credentialStore ??= createKeychainCredentialStore({
			secrets: this.requireSecretEnvironment().pluginSecrets(),
			log: (message) => this.log.debug(message),
		});
		return this.credentialStore;
	}

	/**
	 * The settings panel's sign-in operations, over the one credential store.
	 *
	 * Assembled here rather than in the tab because every input is a plugin
	 * capability: the store is {@link requireCredentialStore}'s singleton, and
	 * the transport is the pinned `requestUrl` fetch the token exchanges must
	 * travel over. `available` is read live at every render rather than
	 * captured, so a device whose keychain probe failed reports honestly each
	 * time the dialog opens.
	 */
	get signInSession(): SignInSession {
		this.signInBridge ??= createSignInSession({
			credentials: this.requireCredentialStore(),
			fetch: createObsidianRequestUrlFetch(),
			canStore: () => this.requireSecretEnvironment().pluginSecrets().available,
		});
		return this.signInBridge;
	}

	/**
	 * Copy in the user's current language.
	 *
	 * Resolved per call rather than cached so a `Notice` fired after the setting
	 * changes speaks the new language. Command names cannot follow — Obsidian
	 * reads those once at registration — so those are captured in `onload` and
	 * only change on the next reload, which is the same behaviour every localized
	 * Obsidian plugin has.
	 */
	private t(): Translator {
		return getT(resolveLanguage(this.app.vault as LanguageHost, this.settings.language));
	}

	async onload(): Promise<void> {
		// Logging is assembled first: everything below it can fail, and the
		// catch blocks that report those failures need a logger that already
		// exists. The level closure reads `this.settings`, so it sees the
		// persisted value the moment `loadSettings` assigns it.
		registerBrandIcon();
		registerVendorIcons();
		this.pluginLogger = createPluginLogger({
			adapter: this.app.vault.adapter,
			configDir: this.app.vault.configDir,
			level: () => this.settings.logLevel,
		});
		this.log = this.requirePluginLogger().logger.child("plugin");
		await this.loadSettings();
		const t = this.t();

		// Warm the MCP cache before anything needs it: the panel's first open and
		// the first conversation then read verdicts and tools that already exist
		// instead of each racing their own handshake. Fire-and-forget is safe —
		// connect is per-server, never throws, and nothing here depends on the
		// result; an agent picks the tools up at its own rebuild point. The
		// per-server chain in the manager keeps this from racing another caller.
		void this.mcpManager.connect();

		// The manager reads the folder and the cap through this closure rather than
		// from a snapshot, so a change in the Sessions tab reaches the next chat
		// without reloading the plugin.
		const sessionManager = ObsidianSessionManager.forPlugin(this.app, this, () => this.settings);
		this.sessionManager = sessionManager;
		/*
		 * The escalation ladder, wired here and nowhere else.
		 *
		 * `isPanelVisible` is what decides between the two surfaces, and it asks
		 * about the screen rather than about the workspace's bookkeeping — a leaf
		 * collapsed into a sidebar or parked behind another tab is open and unread.
		 * `escalate` opens the dialog, `retract` takes it back off the screen when
		 * something else settled the question first: an abort, or the run being
		 * stopped while the dialog was still up.
		 *
		 * The language is resolved per question rather than captured, so a switch in
		 * the Appearance tab reaches the next dialog without a reload — the same
		 * reason the tool used to resolve it per tool-set build.
		 */
		const askUserBroker = new AskUserBroker({
			isPanelVisible: () => isChatPanelVisible(this.app),
			escalate: (request) => {
				const modal = new AskUserModal(
					this.app,
					request.questions,
					resolveLanguage(this.app.vault as LanguageHost, this.settings.language),
					(answers) => askUserBroker.answer(request.id, answers),
					() => askUserBroker.dismiss(request.id),
				);
				this.openAskModals.set(request.id, modal);
				modal.open();
			},
			retract: (request) => {
				const modal = this.openAskModals.get(request.id);
				this.openAskModals.delete(request.id);
				// `close` fires the modal's `onClose`, which reports a dismissal the
				// broker ignores: it has already dropped this request.
				modal?.close();
			},
		});
		this.askUserBroker = askUserBroker;
		this.agentService = new ObsidianAgentService(this.app, () => this.settings, sessionManager, {
			logger: this.requirePluginLogger().logger,
			askUserBroker,
			// The chat panel's model switcher writes `activeModelId`; this is what
			// makes that write survive a reload, and it reconfigures the running
			// agent on the way back. A mid-run write (issue #252) passes
			// `reconfigure: false` — `data.json` still goes to disk at once, but
			// the deferred flush owns the agent reconfigure.
			persistSettings: (options) => this.saveSettings(options),
			// MCP tools join the vault tools on every build or reconfigure; the
			// manager owns connecting and skips servers whose config is unchanged.
			getExternalTools: async () => {
				await this.mcpManager.connect();
				return this.mcpManager.buildAgentTools();
			},
			// What is already mounted, connect-free — the subagent side reads this
			// at spawn time so a child's set is the servers' current list without
			// ever paying (or awaiting) a handshake itself.
			getMountedExternalTools: () => this.mcpManager.buildAgentTools(),
			// The one instance for the session; see `requireCredentialStore`.
			credentials: this.requireCredentialStore(),
		});
		this.draftStore = DraftStore.forPlugin(this.app, this, this.requirePluginLogger().logger);

		this.registerView(
			VIEW_TYPE_PIEM_CHAT,
			(leaf) =>
				new PiemChatView(
					leaf,
					this.requireAgentService(),
					this.draftStore ?? undefined,
					(subagentId) => void this.activateSubagentView(subagentId),
					askUserBroker,
				),
		);
		this.registerView(VIEW_TYPE_PIEM_LOGS, (leaf) => this.createLogView(leaf));
		this.registerView(VIEW_TYPE_PIEM_SUBAGENTS, (leaf) => new PiemSubagentView(leaf, this.requireAgentService()));
		this.addSettingTab(new PiemSettingTab(this.app, this, this.requireSecretEnvironment()));
		this.addCommand({
			id: "open-chat",
			name: t.t("commands.openChat"),
			callback: () => {
				void this.activateChatView();
			},
		});
		this.addCommand({
			id: "open-logs",
			name: t.t("commands.openLogs"),
			callback: () => {
				void this.activateLogView();
			},
		});
		this.addCommand({
			id: "open-subagents",
			name: t.t("commands.openSubagents"),
			callback: () => {
				void this.activateSubagentView();
			},
		});
		this.addCommand({
			id: "new-chat",
			name: t.t("commands.newChat"),
			callback: () => {
				void this.startNewChat();
			},
		});
		this.addCommand({
			id: "search-chats",
			name: t.t("commands.searchChats"),
			callback: () => {
				void this.openSessionSearch();
			},
		});
		this.addCommand({
			id: "abort-chat",
			name: t.t("commands.stopResponse"),
			// `checking` asks whether the command should be listed at all, so the abort
			// must stay behind the `!checking` guard or merely opening the palette fires it.
			checkCallback: (checking) => {
				const service = this.agentService;
				if (!service || (service.getSnapshot().isStreaming === false && !service.getSnapshot().isCompacting)) {
					return false;
				}
				if (!checking) {
					service.abort();
				}
				return true;
			},
		});
		this.addCommand({
			id: "compact-chat",
			name: t.t("commands.tidyUp"),
			// `compactNow` existed but nothing reached it, so a full context could
			// only be resolved by waiting for the automatic threshold.
			checkCallback: (checking) => {
				const service = this.agentService;
				if (!service || service.getSnapshot().isStreaming || service.getSnapshot().isCompacting) {
					return false;
				}
				if (!checking) {
					void service.compactNow();
				}
				return true;
			},
		});
		this.addCommand({
			id: "focus-chat",
			name: t.t("commands.focusInput"),
			checkCallback: (checking) => {
				const view = this.findChatView();
				if (!view) {
					return false;
				}
				if (!checking) {
					view.focusInput();
				}
				return true;
			},
		});
		this.addCommand({
			id: "ask-about-selection",
			name: t.t("commands.askAboutSelection"),
			editorCallback: (editor, info) => {
				void this.askPiemAboutSelection(editor, info.file?.path ?? null);
			},
		});
		this.addCommand({
			id: "ask-about-note",
			name: t.t("commands.askAboutNote"),
			editorCallback: (editor, info) => {
				void this.askPiemAboutSelection(editor, info.file?.path ?? null, { selectionOnly: false });
			},
		});
		this.addRibbonIcon(BRAND_ICON_ID, t.t("commands.ribbonOpenChat"), () => {
			void this.activateChatView();
		});
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				const path = info.file?.path;
				if (!path || !editor.getSelection().trim()) {
					return;
				}
				menu.addItem((item) =>
					item
						.setTitle(t.t("commands.menuAskAboutSelection"))
						.setIcon(BRAND_ICON_ID)
						.onClick(() => {
							void this.askPiemAboutSelection(editor, path);
						}),
				);
			}),
		);
		// The explorer's and the search results' right-click menu. Folders get no
		// row — `addAskPiemFileMenuEntry` decides — because a pinned context ref
		// names a single file, and a folder row would be an affordance that could
		// only mislead.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				addAskPiemFileMenuEntry(menu, file, {
					...askPiemFileMenuOptions(t),
					onAsk: (target) => {
						void this.askPiemAboutFile(target.path);
					},
				});
			}),
		);
	}

	onunload(): void {
		// Fire-and-forget: `flush` never rejects, and a final record landing after
		// teardown still beats one lost to a dispose-then-queue race.
		void this.pluginLogger?.fileSink.flush();
		this.pluginLogger = null;
		this.agentService?.dispose();
		this.agentService = null;
		// The view's own teardown already flushed; this only cancels a debounce
		// that would otherwise fire against an unloaded plugin.
		this.draftStore?.dispose();
		this.draftStore = null;
		// Fire-and-forget: closing an SSE-less HTTP client does not reject, and
		// the plugin is going away either way.
		void this.mcpBridge?.dispose();
		this.mcpBridge = null;
		this.sessionManager = null;
		// Dismiss before dropping: every waiting promise is a tool call that would
		// never settle, and a dismissal is an outcome the model already handles.
		this.askUserBroker?.clear();
		this.askUserBroker = null;
		this.openAskModals.clear();
	}

	/** Chat logs stored in the folder now in effect. Zero before the first chat. */
	async countStoredSessions(): Promise<number> {
		return (await this.sessionManager?.countStoredSessions()) ?? 0;
	}

	/**
	 * The folder chat logs are being written to.
	 *
	 * Read from the manager rather than from settings so the row names the resolved
	 * folder, the one writes actually land in. Falls back to the raw setting only
	 * when there is no manager to ask.
	 */
	getActiveSessionDir(): string {
		return this.sessionManager?.getSessionDir() ?? this.settings.sessionDir;
	}

	/** The Logs tab's shortcut into the viewer. */
	openLogView(): void {
		void this.activateLogView();
	}

	/**
	 * Chats left in the folder earlier releases wrote to.
	 *
	 * Nothing is migrated, so this is how a user finds them: the folder sits inside
	 * the config directory, which Obsidian's file explorer does not show. Reports
	 * zero when that folder is the active one, since those chats are then in the
	 * chat list and there is nothing to point at.
	 */
	async countLegacySessions(): Promise<{ count: number; dir: string }> {
		const configDir = this.app.vault.configDir;
		const dir = getLegacySessionDir(configDir, this.manifest.id);
		// Compared through `isLegacySessionDir` rather than by string: the manager
		// hands back a normalized path, which the raw legacy path need not match.
		if (!this.sessionManager || isLegacySessionDir(this.getActiveSessionDir(), configDir, this.manifest.id)) {
			return { count: 0, dir };
		}
		return { count: await this.sessionManager.countSessionsIn(dir), dir };
	}

	/**
	 * Loads persisted settings and resolves every keychain reference into the
	 * plaintext in-memory shape every reader expects.
	 *
	 * Two passes, each with one job: `normalizeSettings` repairs the stored
	 * shapes, then `resolveSecretRefs` fills every reference-bound credential in
	 * from the keychain. The plugin never writes to the keychain, so there is
	 * nothing to reconcile here — a load is a read, and a dangling reference
	 * resolves to an empty key the panel reports.
	 */
	async loadSettings(): Promise<void> {
		const raw = await this.loadData() as Partial<PiemSettings> | null;
		this.settings = normalizeSettings(raw);
		resolveSecretRefs(this.settings, this.requireSecretEnvironment().keychain());
	}

	/**
	 * Persists settings.
	 *
	 * Credentials bound to a keychain entry go out with their plaintext field
	 * blanked — the entry is the durable home, and `data.json` keeps only the
	 * reference. Inline credentials (empty `secretRef`, the manual tier) keep
	 * their value, because there the plaintext is the storage.
	 *
	 * `reconfigure: false` (the mid-run write path, issue #252) skips the live
	 * reconfigure — the run in flight keeps the model it started on, and the
	 * deferred flush applies the change once it lands — while `data.json` still
	 * writes through, so a reload cannot resurrect the old choice.
	 */
	async saveSettings(options?: { reconfigure?: boolean }): Promise<void> {
		await this.saveData(persistedSettings(this.settings));
		if (options?.reconfigure !== false) {
			await this.agentService?.refreshConfiguration();
		}
		// The panel re-renders from the snapshot on its own, but the tab title is
		// drawn by Obsidian outside React, so a language change needs this nudge.
		this.findChatView()?.refreshHeader();
		this.findSubagentView()?.refreshHeader();
	}

	/**
	 * Re-reads skill files after the settings panel changed them on disk.
	 *
	 * Skills are vault content, not settings, so an import or deletion does not
	 * go through {@link saveSettings} — this is the call that tells the running
	 * agent its prompt changed.
	 */
	async refreshAgentSkills(): Promise<void> {
		await this.agentService?.refreshSkills();
	}

	/**
	 * Warnings from the agent's last skill load, for the Skills settings tab.
	 *
	 * The panel reads the agent's load rather than performing its own, so it can
	 * never report on a read the agent did not do. Falls back to an empty report
	 * when there is no service — the settings tab outlives a failed `onload`, and
	 * a dialog about skill files must not be the thing that throws.
	 */
	agentSkillLoad(): SkillLoadReport {
		return this.agentService?.getSkillLoad() ?? emptySkillLoadReport();
	}

	private async startNewChat(): Promise<void> {
		await this.activateChatView();
		await this.requireAgentService().newSession();
		this.findChatView()?.focusInput();
	}

	/**
	 * Opens the panel and prefills a reference to the note (and selection).
	 *
	 * `activateChatView` must be awaited before the prefill: the view mounts
	 * React asynchronously, and the controller latches the text until the
	 * composer registers, so ordering here is what keeps the reference from
	 * landing in a not-yet-existing input.
	 */
	private async askPiemAboutSelection(editor: Editor, path: string | null, options = { selectionOnly: true }): Promise<void> {
		const handled = requestNoteReference(editor, path, {
			...options,
			deliver: (text, truncated) => {
				void this.deliverReference(text);
				warnIfTruncated(truncated, this.t());
			},
		});
		if (handled) {
			return;
		}
		new Notice(this.t().t("commands.noActiveNote"));
	}

	/**
	 * Opens the panel and pins the file the user acted on.
	 *
	 * The file menu hands over a path only — no editor, no selection — so unlike
	 * `askPiemAboutSelection` there is nothing to prefill: the pin is the whole
	 * offer, and the composer stays empty for the user's question.
	 *
	 * The pin lands on the agent service, and before the panel opens. That order
	 * is what makes the timing a non-issue: the service exists from `onload`
	 * onward and holds the context refs itself, while a freshly mounting panel
	 * reads its first snapshot on subscribe (and a re-render on every later
	 * notify), so the pinned chip is there the moment the panel appears whether
	 * it was open or not. There is no session to wait for — pins are scoped to
	 * the service's in-memory context, not to a loaded conversation.
	 *
	 * A missing service means `onload` never got as far as building one, in which
	 * case the panel cannot be created either (its view factory requires the same
	 * service), so this reports the panel could not open and stops. Reaching for
	 * the shared "could not open" copy rather than a pin-specific leaf: the user
	 * asked for the panel, and the panel is what they did not get.
	 */
	private async askPiemAboutFile(path: string): Promise<void> {
		const service = this.agentService;
		if (!service) {
			new Notice(this.t().t("commands.couldNotOpenChat"));
			return;
		}
		service.pinContextRef(path);
		await this.activateChatView();
		this.findChatView()?.focusInput();
	}

	private async deliverReference(text: string): Promise<void> {
		await this.activateChatView();
		const view = this.findChatView();
		// Prefill first, then focus: the composer places the caret at the end of
		// its draft, so the user can type the question straight away.
		view?.prefillComposer(text);
		view?.focusInput();
	}

	/**
	 * The open chat view, when there is one.
	 *
	 * Reached from `saveSettings`, which persistence tests drive against a plugin
	 * stub that has no workspace — so the lookup is optional rather than assuming
	 * a fully constructed `App`.
	 */
	/**
	 * Opens the history picker from the palette, with content search wired in.
	 *
	 * Activates the panel first so the picker's own actions — open, delete — land
	 * on a mounted view rather than a service the user cannot see the result of.
	 */
	private async openSessionSearch(): Promise<void> {
		const service = this.requireAgentService();
		await this.activateChatView();
		const t = this.t();
		const sessions = await service.listSessions();
		openSessionPicker(
			this.app,
			sessions,
			{
				onOpen: (path) => void service.openSession(path),
				onDelete: (session) => openSessionDeleteConfirm(this.app, session, () => void service.deleteSession(session.path), t),
				searchSessions: (text, options) => service.searchSessions(text, options),
			},
			t,
			service.getSessionRunStates(),
		);
	}

	private findChatView(): PiemChatView | null {
		const view = this.app?.workspace?.getLeavesOfType(VIEW_TYPE_PIEM_CHAT)[0]?.view;
		return view instanceof PiemChatView ? view : null;
	}

	private async activateChatView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PIEM_CHAT)[0];
		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice(this.t().t("commands.couldNotOpenChat"));
			return;
		}

		await leaf.setViewState({ type: VIEW_TYPE_PIEM_CHAT, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	private requireAgentService(): ObsidianAgentService {
		if (!this.agentService) {
			throw new Error("Piem agent service is not initialized.");
		}
		return this.agentService;
	}

	private requirePluginLogger(): PluginLogger {
		if (!this.pluginLogger) {
			throw new Error("Piem logger is not initialized.");
		}
		return this.pluginLogger;
	}

	/** The log viewer over this load's ring buffer. */
	private createLogView(leaf: WorkspaceLeaf): PiemLogView {
		const pluginLogger = this.requirePluginLogger();
		const configDir = this.app.vault.configDir;
		return new PiemLogView(leaf, {
			buffer: pluginLogger.buffer,
			t: this.t(),
			filePath: getLogFilePath(configDir, PLUGIN_ID),
			revealFile: () => {
				// `revealInFinder` is desktop-only; the file hint names the path for
				// mobile users, who can reach it over sync instead.
				const adapter = this.app.vault.adapter as DataAdapter & { revealInFinder?: (path: string) => boolean };
				adapter.revealInFinder?.(getLogFilePath(configDir, PLUGIN_ID));
			},
		});
	}

	/**
	 * The subagent monitor's leaf, when one is open.
	 *
	 * Same optional-chained lookup as {@link findChatView}: persistence tests
	 * drive `saveSettings` against a plugin stub with no workspace at all.
	 */
	private findSubagentView(): PiemSubagentView | null {
		const view = this.app?.workspace?.getLeavesOfType(VIEW_TYPE_PIEM_SUBAGENTS)[0]?.view;
		return view instanceof PiemSubagentView ? view : null;
	}

	/**
	 * Opens the subagent monitor, optionally already showing one run.
	 *
	 * Returns the view so the caller can chain — the chat panel's entry icon
	 * activates the leaf and names a run in one awaited sequence, and a latched
	 * request means the naming survives a leaf that has not mounted React yet.
	 */
	async activateSubagentView(subagentId?: string): Promise<PiemSubagentView | null> {
		const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PIEM_SUBAGENTS)[0];
		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
		} else {
			const leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice(this.t().t("commands.couldNotOpenSubagents"));
				return null;
			}
			await leaf.setViewState({ type: VIEW_TYPE_PIEM_SUBAGENTS, active: true });
			await this.app.workspace.revealLeaf(leaf);
		}
		const view = this.findSubagentView();
		if (view && subagentId !== undefined) {
			view.showSubagent(subagentId);
		}
		return view;
	}

	private async activateLogView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PIEM_LOGS)[0];
		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice(this.t().t("commands.couldNotOpenLogs"));
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_PIEM_LOGS, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}

export { VIEW_TYPE_PIEM_CHAT };
