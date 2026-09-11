import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { App, DataAdapter, Component } from "obsidian";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ObsidianAgentService as ObsidianAgentServiceType } from "../agent/ObsidianAgentService";
import type { PiemSettings } from "../settings";
import type { UserSkillsLoad } from "../skills/userSkills";
import type { StaticExtension } from "../extensions/extensionHost";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { VIEW_TYPE_PIEM_CHAT } from "../constants";
import { flushRender, installDom } from "../testUtils/dom";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { ChatApp } = await import("./ChatApp");
const { PanelErrorBoundary } = await import("./PanelErrorBoundary");
const { ChatInputController } = await import("./ChatInputController");
const { ObsidianAgentService } = await import("../agent/ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { DraftStore } = await import("../session/DraftStore");
const { DEFAULT_SESSION_RETENTION } = await import("../session/retention");
const { DEFAULT_SESSION_DIR, getLegacySessionDir } = await import("../session/sessionDir");
const { DEFAULT_SETTINGS } = await import("../settings");
const { AskUserBroker } = await import("../tools/askUserBroker");
const { createRoot } = await import("react-dom/client");

// The default config folder is not spelled as one literal, matching
// `ObsidianSessionFileSystem.test.ts`: this fixture pins the *pre-migration*
// layout, so the name is a historical fact about old vaults rather than a read
// of the current `Vault#configDir` — which is what `hardcoded-config-path`
// exists to catch. The path is assembled through the plugin's own helper so the
// two cannot disagree about the shape below the config folder.
const SESSION_DIR = getLegacySessionDir(`.${"obsidian"}`, "piem");
const CHIPS_JSON = '[{"label":"Chip from the model","prompt":"The model prompt."}]';

/** One assistant message in the shape the stream events carry. */
function assistantMessage(model: Model<Api>, text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** One completed provider response carrying only `text`. */
function textReply(model: Model<Api>, text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	const message = assistantMessage(model, text);
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

/**
 * A streamFn whose replies hang until released, so a test can delete the
 * session while the run is genuinely in flight — the state the abort and
 * settle machinery is written for.
 */
function gatedStreamFn(): { streamFn: StreamFn; arrived: Promise<void>; release: () => void } {
	let onArrive: (() => void) | undefined;
	let onRelease: (() => void) | undefined;
	const arrived = new Promise<void>((resolve) => (onArrive = resolve));
	const released = new Promise<void>((resolve) => (onRelease = resolve));
	const streamFn: StreamFn = (model: Model<Api>) => {
		onArrive?.();
		const stream = createAssistantMessageEventStream();
		void released.then(() => {
			const message = assistantMessage(model, "late reply");
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		});
		return stream;
	};
	return { streamFn, arrived, release: () => onRelease?.() };
}

/** Concatenated text of a context's messages, so the test can see what was asked. */
function contextText(context: Context): string {
	return context.messages
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.filter((content): content is { type: "text"; text: string } => (content as { type?: string }).type === "text")
							.map((content) => content.text)
							.join("\n")
					: "",
		)
		.join("\n");
}

/** A streamFn that answers every request with the next scripted reply, recording each prompt. */
function scriptedStreamFn(replies: string[]): { streamFn: StreamFn; prompts: string[] } {
	const prompts: string[] = [];
	let call = 0;
	const streamFn: StreamFn = (model: Model<Api>, context: Context) => {
		prompts.push(contextText(context));
		const reply = replies[Math.min(call, replies.length - 1)] ?? "";
		call += 1;
		return textReply(model, reply);
	};
	return { streamFn, prompts };
}

/**
 * The smallest in-memory adapter the session manager needs.
 *
 * Folders are tracked rather than ignored, and `list` answers by parent rather
 * than by prefix. Both matter: pi's session repository checks that the session
 * directory exists before listing it, so an adapter that forgets `mkdir` makes
 * `listSessions()` answer "no sessions" forever — and a delete would then always
 * take the mint-a-replacement branch, leaving the adopt-the-replacement branch
 * this suite is here to guard permanently unvisited.
 */
function memoryAdapter(): DataAdapter {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
	return {
		async exists(path: string): Promise<boolean> {
			return files.has(path) || folders.has(path);
		},
		async mkdir(path: string): Promise<void> {
			const parts = path.split("/");
			for (let depth = 1; depth <= parts.length; depth += 1) {
				folders.add(parts.slice(0, depth).join("/"));
			}
		},
		async write(path: string, data: string): Promise<void> {
			files.set(path, data);
		},
		async append(path: string, data: string): Promise<void> {
			files.set(path, (files.get(path) ?? "") + data);
		},
		async read(path: string): Promise<string> {
			const content = files.get(path);
			if (content === undefined) {
				throw new Error(`Missing file: ${path}`);
			}
			return content;
		},
		async stat(path: string) {
			const content = files.get(path);
			if (content !== undefined) {
				return { type: "file" as const, ctime: 1, mtime: 1, size: content.length };
			}
			if (folders.has(path)) {
				return { type: "folder" as const, ctime: 1, mtime: 1, size: 0 };
			}
			return null;
		},
		async list(path: string) {
			return {
				files: [...files.keys()].filter((key) => parentOf(key) === path),
				folders: [...folders].filter((key) => parentOf(key) === path),
			};
		},
		async trashSystem(path: string): Promise<boolean> {
			files.delete(path);
			return true;
		},
		async trashLocal(path: string): Promise<void> {
			files.delete(path);
		},
		// Draft files are removed directly, bypassing the session file system's
		// trash step — side-car state, not a chat log.
		async remove(path: string): Promise<void> {
			files.delete(path);
		},
		async rename(path: string, newPath: string): Promise<void> {
			const content = files.get(path);
			if (content === undefined) {
				throw new Error(`Missing file: ${path}`);
			}
			files.delete(path);
			files.set(newPath, content);
		},
	} as unknown as DataAdapter;
}

/**
 * Wraps an adapter so every call resolves on a later macrotask, the way real
 * disk I/O does.
 *
 * Without this, an awaited service call runs its whole chain of notifies inside
 * one microtask drain and React commits only the final state — so the panel
 * never renders the states *between* two disk operations. Those are exactly the
 * states a delete passes through, and one of them (no focused session, empty
 * transcript) used to throw out of the empty-screen effect.
 */
function yieldingAdapter(inner: DataAdapter): DataAdapter {
	const target = inner as unknown as Record<string, unknown>;
	return new Proxy(target, {
		get(source, property: string) {
			const original = source[property];
			if (typeof original !== "function") {
				return original;
			}
			return async (...args: unknown[]): Promise<unknown> => {
				const result = await (original as (...called: unknown[]) => unknown).apply(source, args);
				return new Promise((resolve) => setTimeout(() => resolve(result), 0));
			};
		},
	}) as unknown as DataAdapter;
}

const NO_USER_SKILLS = async (): Promise<UserSkillsLoad> => ({ skills: [], diagnostics: [], searched: [] });

describe("ChatApp × real service (issue #168)", () => {
	/** Roots mounted by this suite, unmounted in afterEach so listeners die with the test. */
	const roots: { unmount: () => void }[] = [];
	const services: ObsidianAgentServiceType[] = [];
	const drafts: InstanceType<typeof DraftStore>[] = [];
	const brokers: InstanceType<typeof AskUserBroker>[] = [];
	/**
	 * What the panel's boundary caught, if anything.
	 *
	 * Production mounts `ChatApp` inside `PanelErrorBoundary`, so a render or
	 * effect throw shows as the crash message rather than as a blank panel — the
	 * DOM assertions below cannot tell the two apart on their own. An empty array
	 * is the stronger claim: nothing threw at all.
	 */
	const crashes: unknown[] = [];

	/** The chips row, as the user sees it. */
	function chips(target: HTMLElement): HTMLButtonElement[] {
		return Array.from(target.querySelectorAll<HTMLButtonElement>(".piem-chat__quick-action"));
	}

	async function mountPanel(
		scripted: { streamFn: StreamFn; prompts: string[] },
		options: { yieldIO?: boolean; extensionFactories?: readonly StaticExtension[]; askUserBroker?: InstanceType<typeof AskUserBroker> } = {},
	): Promise<{
		service: ObsidianAgentServiceType;
		prompts: string[];
		/** Mimics the user switching notes in the Obsidian workspace. */
		setActiveFile: (path: string | null) => void;
		draftStore: InstanceType<typeof DraftStore>;
	}> {
		const adapter = options.yieldIO ? yieldingAdapter(memoryAdapter()) : memoryAdapter();
		// The real view passes a DraftStore; the composer hook behaves
		// differently with and without one, so the white-screen repro has to
		// match production rather than the store-less harness. The store now
		// takes the session directory and keeps drafts under `drafts/`.
		const draftStore = new DraftStore(adapter, SESSION_DIR);
		drafts.push(draftStore);
		const settings: PiemSettings = {
			...DEFAULT_SETTINGS,
			providers: [
				{
						id: "p-test",
						name: "Test gateway",
						baseUrl: "https://gw.test/v1",
						protocol: "openai-completions",
						apiKey: "test-key",
						secretRef: "",
						source: "user",
						oauthFlow: "",
				},
			],
			models: [{ id: "m-test", providerId: "p-test", modelApiId: "test-model", displayName: "Test Model", reasoning: false, supportsImages: false }],
			activeModelId: "m-test",
			networkTransport: "requestUrl",
			showAgentDetails: false,
			sendShortcut: "enter",
			language: "en",
			sessionRetention: DEFAULT_SESSION_RETENTION,
			sessionDir: DEFAULT_SESSION_DIR,
			userSkillsDir: "",
		};
		const vaultFiles: Record<string, string> = { "Notes/todo.md": "- buy milk", "Notes/other.md": "- buy eggs" };
		const files = new Map<string, { path: string; extension: string }>();
		for (const path of Object.keys(vaultFiles)) {
			files.set(path, { path, extension: path.slice(path.lastIndexOf(".") + 1) });
		}
		let activeFile: { path: string; extension: string } | null = null;
		const app = {
			vault: {
				adapter,
				getName: () => "Test",
				getFiles: () => [...files.values()],
				getFileByPath: (path: string) => files.get(path) ?? null,
				getAbstractFileByPath: (path: string) => files.get(path) ?? null,
				read: async (file: { path: string }) => vaultFiles[file.path] ?? "",
				cachedRead: async (file: { path: string }) => vaultFiles[file.path] ?? "",
			},
			workspace: {
				getActiveViewOfType: () => null,
				getActiveFile: () => activeFile,
				getLeavesOfType: (type: string) => options.askUserBroker && type === VIEW_TYPE_PIEM_CHAT ? [{}] : [],
			},
		} as unknown as App;
		const sessionManager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		const service = new ObsidianAgentService(app, () => settings, sessionManager, {
			streamFn: scripted.streamFn,
			loadUserSkills: NO_USER_SKILLS,
			extensionFactories: options.extensionFactories,
			askUserBroker: options.askUserBroker,
		});
		services.push(service);

		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push(root);
		// The real panel's cold-start sequence: render (which subscribes), then
		// the initialize effect — not a hand-awaited `initialize` before mount.
		root.render(
			<PanelErrorBoundary getLanguage={() => "en"} onError={(error) => crashes.push(error)}>
				<ChatApp
					service={service}
					inputController={new ChatInputController()}
					component={{} as Component}
					draftStore={draftStore}
					askUserBroker={options.askUserBroker}
				/>
			</PanelErrorBoundary>,
		);
		await flushRender();
		return {
			service,
			draftStore,
			prompts: scripted.prompts,
			setActiveFile: (path: string | null) => {
				activeFile = path === null ? null : (files.get(path) ?? null);
			},
		};
	}

	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		while (roots.length > 0) {
			roots.pop()?.unmount();
		}
		await flushRender();
		for (const service of services.splice(0)) service.dispose();
		for (const broker of brokers.splice(0)) broker.clear();
		for (const store of drafts.splice(0)) { await store.flush(); store.dispose(); }
		document.body.replaceChildren();
		crashes.length = 0;
	});

	it.each(["before", "after"])("keeps ask_user in its own conversation when it arrives %s switching away", async (arrival) => {
		const broker = new AskUserBroker();
		brokers.push(broker);
		const prompt = "Ask where session A should file this note";
		const questions = [{ question: "Where should A's note go?", header: "Destination", options: [{ label: "Inbox" }, { label: "Archive" }] }];
		let releaseAsk: (() => void) | undefined;
		const streamFn: StreamFn = (model, context) => {
			// Empty-screen suggestions and the seed turns must never issue tools.
			if (!contextText(context).includes(prompt) || releaseAsk) return textReply(model, CHIPS_JSON);
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				...assistantMessage(model, ""),
				content: [{ type: "toolCall", id: "ask-a", name: "ask_user", arguments: { questions } }],
				stopReason: "toolUse",
			};
			let released = false;
			releaseAsk = () => {
				if (released) return;
				released = true;
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
			};
			return stream;
		};
		const { service } = await mountPanel({ streamFn, prompts: [] }, { askUserBroker: broker });
		await flushRender(() => service.getSnapshot().session !== undefined);
		// Both chats need content: switching away retires an unused blank sheet.
		await service.sendPrompt("Seed session A");
		const first = service.getSnapshot().session!;
		await service.newSession();
		await service.sendPrompt("Seed session B");
		const second = service.getSnapshot().session!;
		expect(second.id).not.toBe(first.id);
		await service.openSession(first.path);
		await flushRender();

		let queued = false;
		const unsubscribe = broker.subscribe(() => { queued = true; });
		let finished = false;
		const run = service.sendPrompt(prompt).finally(() => { finished = true; });
		try {
			await flushRender(() => releaseAsk !== undefined);
			if (arrival === "after") {
				await service.openSession(second.path);
				await flushRender();
			}
			releaseAsk?.();
			await flushRender(() => queued);
			if (arrival === "before") {
				expect(document.querySelector(".piem-ask-card--pending")?.textContent).toContain(questions[0]!.question);
				await service.openSession(second.path);
				await flushRender();
			}

			// B cannot see or answer A's question, and leaving A must not settle it.
			expect(service.getSnapshot().session?.id).toBe(second.id);
			expect(document.querySelectorAll(".piem-ask-card--pending").length).toBe(0);
			expect(document.querySelectorAll(".piem-ask-action").length).toBe(0);
			expect(broker.getPending(second.path)).toBeNull();
			expect(broker.getPending(first.path)?.questions).toEqual(questions);
			expect(finished).toBe(false);

			await service.openSession(first.path);
			await flushRender();
			expect(document.querySelector(".piem-ask-card--pending")?.textContent).toContain(questions[0]!.question);
			document.querySelector<HTMLButtonElement>(".piem-ask-action")!.click();
			await run;
			await flushRender();
			expect(broker.getPending(first.path)).toBeNull();
			expect(document.querySelector(".piem-ask-card__picked")?.textContent).toBe("Inbox");
			expect(service.getSnapshot().messages.some((message) => message.role === "toolResult" && message.toolName === "ask_user" && !message.isError)).toBe(true);

			await service.openSession(second.path);
			await flushRender();
			expect(document.querySelectorAll(".piem-ask-card").length).toBe(0);
			expect(service.getSnapshot().messages.some((message) => message.role === "toolResult" && message.toolName === "ask_user")).toBe(false);
			expect(crashes).toHaveLength(0);
		} finally {
			// Also release the scripted provider on failure, before waiting for abort.
			releaseAsk?.();
			await service.abortSession(first.path);
			broker.clear();
			await run;
			unsubscribe();
		}
	}, 15_000);

	it("carries extension text through the live editor and keeps drafts in their own conversations", async () => {
		const uiBySession = new Map<string, ExtensionUIContext>();
		const extension: StaticExtension = { id: "native-ui-test", factory: (pi) => {
			pi.on("session_start", (_event, ctx) => {
				if (ctx.hasUI) uiBySession.set(ctx.sessionManager.getSessionId(), ctx.ui);
			});
		} };
		const { service, draftStore } = await mountPanel(scriptedStreamFn([CHIPS_JSON]), { yieldIO: true, extensionFactories: [extension] });
		await flushRender(() => uiBySession.size > 0);
		const firstSession = service.getSnapshot().session!;
		const firstUI = uiBySession.get(firstSession.id)!;
		firstUI.setEditorText("A draft");
		firstUI.setWidget("next", ["A native suggestion"]);
		firstUI.setStatus("state", "A is ready");
		await flushRender();
		expect(document.querySelector("textarea")?.value).toBe("A draft");
		expect(document.querySelector(".piem-chat__extension-widget")?.textContent).toBe("A native suggestion");
		expect(document.querySelector(".piem-chat__extension-status")?.textContent).toBe("A is ready");
		const editor = document.querySelector("textarea")!;
		editor.setSelectionRange(2, 7);
		firstUI.pasteToEditor("changed");
		await flushRender();
		expect(editor.value).toBe("A changed");
		expect(await draftStore.get(firstSession.id)).toBe("A changed");

		const question = firstUI.input("Question for A").catch(() => undefined);
		await flushRender(() => document.querySelector("form") !== null);
		await service.newSession({ force: true });
		await flushRender(() => {
			const session = service.getSnapshot().session;
			return !!session && session.id !== firstSession.id && uiBySession.has(session.id);
		});
		await question;
		expect(document.querySelector("form")).toBeNull();
		expect(document.querySelector("textarea")?.value).toBe("");
		expect(() => firstUI.setEditorText("Late A write")).toThrow();
		const secondSession = service.getSnapshot().session!;
		uiBySession.get(secondSession.id)!.setEditorText("B draft");
		await flushRender();
		await service.openSession(firstSession.path);
		await flushRender(() => document.querySelector("textarea")?.value === "A changed");
		expect(await draftStore.get(secondSession.id)).toBe("B draft");
		expect(crashes).toHaveLength(0);
	});

	it("Stop cancels an extension dialog while leaving the registered completion provider usable", async () => {
		let liveUI: ExtensionUIContext | undefined;
		const extension: StaticExtension = { id: "native-stop-test", factory: (pi) => {
			pi.on("session_start", (_event, ctx) => {
				if (!ctx.hasUI) return;
				liveUI = ctx.ui;
				ctx.ui.addAutocompleteProvider((current) => ({ ...current, getSuggestions: async () => ({
					prefix: "", items: [{ value: "Follow up", label: "Continue here" }],
				}) }));
			});
		} };
		const { service } = await mountPanel(scriptedStreamFn([CHIPS_JSON]), { extensionFactories: [extension] });
		await flushRender(() => liveUI !== undefined);
		const pending = liveUI!.input("Waiting for an answer").catch(() => undefined);
		await flushRender(() => document.querySelector("form") !== null);
		service.abort();
		await pending;
		await flushRender();
		expect(document.querySelector("form")).toBeNull();
		document.querySelector<HTMLButtonElement>('button[aria-label="Show suggestions"]')!.click();
		await flushRender(() => document.querySelector('[role="option"]') !== null);
		document.querySelector<HTMLButtonElement>('[role="option"] button')!.click();
		await flushRender();
		expect(document.querySelector("textarea")?.value).toBe("Follow up");
		expect(crashes).toHaveLength(0);
	});

	it("the empty screen asks the model for chips on cold start and replaces the built-ins", async () => {
		const { service, prompts } = await mountPanel(scriptedStreamFn([CHIPS_JSON]));

		// Give the initialize → effect → request chain a few frames to settle.
		let sawModelChip = false;
		for (let i = 0; i < 10 && !sawModelChip; i += 1) {
			await flushRender();
			sawModelChip = chips(document.body).some((chip) => chip.textContent === "Chip from the model");
		}
		expect(sawModelChip).toBe(true);
		// And the request was actually for the empty screen.
		expect(prompts.some((prompt) => prompt.length > 0)).toBe(true);
		expect(service.getSnapshot().messages).toHaveLength(0);
	});

	it("deleteSession of the active session leaves the panel renderable, not blank (white-screen repro)", async () => {
		const { service } = await mountPanel(scriptedStreamFn([CHIPS_JSON]));
		await flushRender();

		// Give cold start a moment, then put one turn in so the session has content.
		let settled = false;
		for (let i = 0; i < 10 && !settled; i += 1) {
			await flushRender();
			settled = service.getSnapshot().session !== undefined;
		}
		expect(service.getSnapshot().session).toBeDefined();

		await service.sendPrompt("Hello there");
		await flushRender();
		const doomed = service.getSnapshot().session?.path ?? "";

		await service.deleteSession(doomed);
		await flushRender();

		// Whatever state the service landed in, the panel must have a renderable
		// snapshot — a thrown snapshot builder shows up as a blank panel.
		const snapshot = service.getSnapshot();
		expect(snapshot.session).toBeDefined();
		expect(snapshot.messages).toHaveLength(0);

		// The React tree must still be alive: a render throw unmounts the root and
		// leaves the panel blank, which is the white screen being chased here.
		expect(document.querySelector(".piem-chat")).not.toBeNull();
		expect(document.querySelector("textarea")).not.toBeNull();
	});

	it("deleting the last session still leaves the panel renderable (force-fallback path)", async () => {
		const { service } = await mountPanel(scriptedStreamFn([CHIPS_JSON]));

		let settled = false;
		for (let i = 0; i < 10 && !settled; i += 1) {
			await flushRender();
			settled = service.getSnapshot().session !== undefined;
		}
		expect(service.getSnapshot().session).toBeDefined();

		// The only session in the vault: no replacement exists, so the delete
		// must mint a fresh one via newSession({ force: true }).
		await service.deleteSession(service.getSnapshot().session?.path ?? "");
		await flushRender();

		const snapshot = service.getSnapshot();
		expect(snapshot.session).toBeDefined();
		expect(snapshot.messages).toHaveLength(0);
		expect(document.querySelector(".piem-chat")).not.toBeNull();
		expect(document.querySelector("textarea")).not.toBeNull();
	});

	it("deleting the active session mid-run leaves the panel renderable", async () => {
		const gated = gatedStreamFn();
		const { service } = await mountPanel({ streamFn: gated.streamFn, prompts: [] });

		let settled = false;
		for (let i = 0; i < 10 && !settled; i += 1) {
			await flushRender();
			settled = service.getSnapshot().session !== undefined;
		}
		const run = service.sendPrompt("Delete me while I answer");
		await gated.arrived;

		// Delete while the reply is still streaming.
		await service.deleteSession(service.getSnapshot().session?.path ?? "");
		await flushRender();

		const snapshot = service.getSnapshot();
		expect(snapshot.session).toBeDefined();
		expect(snapshot.messages).toHaveLength(0);
		expect(document.querySelector(".piem-chat")).not.toBeNull();
		expect(document.querySelector("textarea")).not.toBeNull();

		// The late reply has nowhere to land — its runtime was removed.
		gated.release();
		await run;
		await flushRender();
		expect(document.querySelector(".piem-chat")).not.toBeNull();
		expect(document.querySelector("textarea")).not.toBeNull();
	});

	it("deleting the active session renders its in-between states without tearing the panel down", async () => {
		// The three cases above delete the *only* session, so the service always
		// mints a replacement, and each one awaits the whole delete — React then
		// commits one render for the settled result. Neither is what production
		// does: a vault holds several chats, and disk I/O puts a macrotask between
		// every notify, so the panel renders the moment where the deleted session
		// is gone and its replacement has not been adopted yet. That frame — no
		// focused session, empty transcript, panel configured and idle — is what
		// the empty-screen suggestion effect fires on, and reading the suggestion
		// cache through the focused runtime threw there. A throw inside React's
		// commit phase unmounts the tree: the blank panel first, and after the
		// boundary landed, the crash message with its retry.
		const { service } = await mountPanel(scriptedStreamFn([CHIPS_JSON]), { yieldIO: true });

		let settled = false;
		for (let attempt = 0; attempt < 20 && !settled; attempt += 1) {
			await flushRender();
			settled = service.getSnapshot().session !== undefined;
		}
		expect(service.getSnapshot().session).toBeDefined();
		await service.sendPrompt("The chat that survives");
		await flushRender();
		const survivor = service.getSnapshot().session?.path ?? "";

		// A second chat, so the delete below has a replacement to adopt rather
		// than a blank sheet to mint.
		await service.newSession();
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await flushRender();
		}
		await service.sendPrompt("The chat being deleted");
		await flushRender();
		const doomed = service.getSnapshot().session?.path ?? "";
		expect(doomed).not.toBe(survivor);
		expect(await service.listSessions()).toHaveLength(2);

		// Renders interleaved with the delete, not after it: the point is that
		// every intermediate snapshot reaches the tree.
		const deletion = service.deleteSession(doomed);
		for (let attempt = 0; attempt < 40; attempt += 1) {
			await flushRender();
		}
		await deletion;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			await flushRender();
		}

		expect(crashes).toHaveLength(0);
		expect(document.querySelector(".piem-chat__crashed")).toBeNull();
		expect(document.querySelector(".piem-chat")).not.toBeNull();
		expect(document.querySelector("textarea")).not.toBeNull();
		// And the surviving chat is the one on screen, not a freshly minted blank.
		expect(service.getSnapshot().session?.path).toBe(survivor);
	});

	it("switching from note A to note B re-asks the model for empty-screen chips (issue #168)", async () => {
		const { service, setActiveFile, prompts } = await mountPanel(scriptedStreamFn([CHIPS_JSON]));

		// Open note A and let its suggestion request land before touching B, so
		// nothing is in flight when the interesting switch happens.
		setActiveFile("Notes/todo.md");
		service.setActiveNotePath("Notes/todo.md");
		for (let i = 0; i < 10 && prompts.length < 2; i += 1) {
			await flushRender();
		}
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("Notes/todo.md");

		// A→B never flips note *presence* — this is the switch the boolean
		// dependency silently ignored. The new request must name the new note.
		setActiveFile("Notes/other.md");
		service.setActiveNotePath("Notes/other.md");
		for (let i = 0; i < 10 && prompts.length < 3; i += 1) {
			await flushRender();
		}
		expect(prompts).toHaveLength(3);
		expect(prompts[2]).toContain("Notes/other.md");
	});
});
