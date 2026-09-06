import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { App, Component } from "obsidian";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub, lastMenu, resetMenus } from "../testUtils/obsidianStub";
import type { ChatSnapshot, ObsidianAgentService } from "../agent/ObsidianAgentService";
import type { SuggestionScope } from "../agent/quickActionSuggestionRequest";
import type { QuickAction } from "./quickActionSuggestions";
import type { DraftStore } from "../session/DraftStore";
import type { ActiveSessionInfo } from "../session/ObsidianSessionManager";
import { SubagentRegistry } from "../subagent/registry";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { ChatApp } = await import("./ChatApp");
const { ChatInputController } = await import("./ChatInputController");
const { DEFAULT_SETTINGS, describeModelTarget } = await import("../settings");
const { getT } = await import("../i18n");
const { createRoot } = await import("react-dom/client");

/**
 * The keyboard route around the disabled Send button.
 *
 * Send is disabled without an API key, which is the right answer for the
 * button: a control that can only produce an error banner is a trap. But ⌘↵
 * never touches that disabled state — the composer listens for it on the
 * textarea directly, and the submit command reaches `sendPrompt` through
 * {@link ChatInputController}. Both routes bypass the button entirely.
 *
 * So the button's `disabled` and `sendPrompt`'s unconfigured branch are two
 * halves of one fix, and removing either breaks the other's half of the
 * contract: drop the branch and the keyboard becomes a silent dead end, drop
 * the `disabled` and the trap comes back. This file pins both together, plus
 * the part easiest to lose in a refactor — that the unconfigured send
 * deliberately does *not* clear the draft, because a request that cannot go out
 * must not cost the user their text.
 *
 * Two assertions carry that last point, because the obvious one does not. The
 * configured path clears the draft and then hands the prompt back when the send
 * fails, so a textarea that merely holds *some* text cannot tell "never
 * cleared" from "cleared and restored". What separates them is that the restore
 * hands back the *trimmed* prompt, and that `clearDraft` reaches the draft
 * store. Both are checked below.
 */

const t = getT("en");
/**
 * The copy the real service produces when the active target has no key,
 * assembled the way `sendPrompt` assembles it. Built here rather than pasted so
 * the assertion pins the route the string travels — service to snapshot to
 * banner — instead of pinning today's wording.
 */
const NEEDS_KEY_MESSAGE = t.t("target.needsKeyToSend", { target: describeModelTarget(DEFAULT_SETTINGS, t) });

const SESSION_ID = "session-under-test";

/**
 * happy-dom hangs `KeyboardEvent` and friends off its window rather than
 * installing them as globals, so tests reach for them through it.
 */
const { window: domWindow } = globalThis as unknown as {
	window: { KeyboardEvent: typeof KeyboardEvent; Event: typeof Event; HTMLTextAreaElement: typeof HTMLTextAreaElement };
};

/**
 * Stand-in for {@link ObsidianAgentService}, mirroring only the missing-key path.
 *
 * `sendPrompt` refuses the way the real one does — same error string, subscribers
 * notified, `false` returned — so the banner assertion exercises real wiring
 * rather than a value the test planted in the snapshot itself. Returning `false`
 * also matters for the draft assertions: it is what makes the configured path's
 * restore fire, which is the case they have to stay distinguishable from.
 */
class FakeAgentService {
	/** Every prompt that reached the service, so a bypassed route shows up as an absence. */
	readonly sentPrompts: string[] = [];
	private snapshot: ChatSnapshot;
	private readonly listeners = new Set<(snapshot: ChatSnapshot) => void>();

	constructor(
		private readonly app: App,
		overrides: Partial<ChatSnapshot> = {},
		private readonly failSends = false,
	) {
		this.snapshot = { ...baseSnapshot(), ...overrides };
	}

	getSnapshot(): ChatSnapshot {
		return this.snapshot;
	}

	subscribe(listener: (snapshot: ChatSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async initialize(): Promise<void> {}

	async listSessions(): Promise<ActiveSessionInfo[]> {
		return [];
	}

	getApp(): App {
		return this.app;
	}

	async sendPrompt(prompt: string): Promise<boolean> {
		this.sentPrompts.push(prompt);
		if (this.failSends) {
			return false;
		}
		if (!this.snapshot.isConfigured) {
			this.snapshot = { ...this.snapshot, errorMessage: NEEDS_KEY_MESSAGE };
			this.notify();
			return false;
		}
		return true;
	}

	// Everything below exists because `ChatApp` wires a handler to it. None of it
	// is reached by these tests, and a body that did something would only invite
	// a reader to trust it.
	abort(): void {}
	dismissMessages(): void {}
	notifyImagesBlocked(): void {}
	/** Logged, so a wall offer's button that reached the service shows up as a count. */
	readonly tidyCalls: number[] = [];

	async compactNow(): Promise<void> {
		this.tidyCalls.push(this.tidyCalls.length + 1);
	}
	async retryFrom(): Promise<boolean> {
		return false;
	}

	/**
	 * Logged like `sentPrompts`, so a test can prove an armed send took the edit
	 * path and *only* it — the two routes append different turns, and a leak from
	 * one into the other is the bug the assertions exist to catch. `failSends`
	 * declines it the same way it declines `sendPrompt`, reusing the constructor
	 * switch rather than a second knob for one behaviour.
	 */
	readonly editResends: Array<{ index: number; prompt: string; images: ImageContent[] }> = [];

	async editAndResend(index: number, prompt: string, images: ImageContent[] = []): Promise<boolean> {
		this.editResends.push({ index, prompt, images });
		return !this.failSends;
	}
	/**
	 * The queue take-back, and what it hands back.
	 *
	 * Modelled on the real one: removing an entry and reporting what the composer
	 * should show are one operation, and which of the two chips was pressed is
	 * only visible in whether the caller uses the return value.
	 */
	readonly queueRemovals: string[] = [];
	queuedTakeBacks = new Map<string, { text: string; images: ImageContent[] }>();

	removeQueuedPrompt(id: string): { text: string; images: ImageContent[] } | null {
		this.queueRemovals.push(id);
		return this.queuedTakeBacks.get(id) ?? null;
	}
	/** The steer chip's own call, kept apart because it is a different intent. */
	readonly queueSteers: string[] = [];

	async steerQueuedPrompt(id: string): Promise<void> {
		this.queueSteers.push(id);
	}
	/** Recorded so a test can prove the fork action reached the service. */
	readonly forkRequests: number[] = [];
	readonly resumeCalls: number[] = [];
	readonly resumeDismissals: number[] = [];

	async forkSessionAt(index: number): Promise<boolean> {
		this.forkRequests.push(index);
		return true;
	}

	async resumeInterruptedRun(): Promise<void> {
		this.resumeCalls.push(this.resumeCalls.length + 1);
	}

	dismissInterruptedRun(): void {
		this.resumeDismissals.push(this.resumeDismissals.length + 1);
	}
	async openSession(): Promise<void> {}
	async newSession(): Promise<void> {}
	async renameSession(): Promise<void> {}
	async deleteSession(): Promise<void> {}
	pinContextRef(): void {}
	unpinContextRef(): void {}
	setFollowActiveNote(): void {}

	/**
	 * The subagent registry, as an empty one.
	 *
	 * `ChatApp` subscribes to it unconditionally — the entry icon has to appear
	 * the moment something is delegated, and a snapshot-shaped guard would make
	 * the panel's own wiring optional. An empty registry is the honest stand-in:
	 * nothing was spawned in these tests, so the icon renders nothing, which is
	 * exactly the state every assertion below was written against.
	 */
	getSubagentRegistry(): SubagentRegistry {
		return this.subagentRegistry;
	}

	private readonly subagentRegistry = new SubagentRegistry();

	/**
	 * Suggestion wiring. Each request is logged with its scope, so a placement
	 * that should have stayed quiet shows up as an absence, and answered from
	 * `suggestionResults` — `null` is the service's failure shape, which is how
	 * a test exercises "no fallback" without a network. `peekedSuggestions`
	 * stands in for the service's cache, keyed by the active note path the
	 * snapshot carries — the way the real cache is keyed — so a visit to a note
	 * with no entry reads as a miss rather than surfacing another note's answer.
	 */
	readonly suggestionRequests: SuggestionScope[] = [];
	suggestionResults: (QuickAction[] | null)[] = [];
	peekedSuggestions: Record<string, QuickAction[]> = {};
	/** When set, `suggestQuickActions` holds its answer until this resolves — the gate a test lifts to interleave renders. */
	suggestionsGate: Promise<void> | null = null;

	peekQuickActionSuggestions(scope: SuggestionScope): QuickAction[] | undefined {
		if (scope !== "empty") {
			return undefined;
		}
		const activePath = this.snapshot.contextRefs.find((ref) => ref.kind === "active")?.path ?? "";
		return this.peekedSuggestions[activePath];
	}

	async suggestQuickActions(scope: SuggestionScope): Promise<QuickAction[] | null> {
		this.suggestionRequests.push(scope);
		const result = this.suggestionResults.shift() ?? null;
		if (this.suggestionsGate) {
			await this.suggestionsGate;
		}
		return result;
	}

	/** Pushes a partial snapshot the way the real service's events do. */
	emit(overrides: Partial<ChatSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...overrides };
		this.notify();
	}
	/** Model ids the switcher asked for, so a menu that reaches nothing shows up. */
	readonly switchedModels: string[] = [];

	async setActiveModel(modelId: string): Promise<void> {
		this.switchedModels.push(modelId);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener(this.snapshot);
		}
	}
}

/**
 * Draft store that only records, so a test can watch for the `clear` the
 * unconfigured branch is supposed to skip. This is the direct observable: the
 * textarea alone cannot see a clear that a restore immediately undid.
 */
class RecordingDraftStore {
	readonly clearedSessions: string[] = [];
	private readonly texts = new Map<string, string>();

	async get(sessionId: string): Promise<string> {
		return this.texts.get(sessionId) ?? "";
	}

	async set(sessionId: string, text: string): Promise<void> {
		this.texts.set(sessionId, text);
	}

	async clear(sessionId: string): Promise<void> {
		this.clearedSessions.push(sessionId);
		this.texts.delete(sessionId);
	}

	async flush(): Promise<void> {}
}

/**
 * The only `app` reads `ChatApp` performs while rendering: the active note, for
 * Markdown link resolution, and whether the host can open plugin settings.
 * `setting` is left off, so the panel takes its no-shortcut path — nothing here
 * depends on that button existing.
 */
function fakeApp(): App {
	return {
		workspace: {
			getActiveViewOfType: () => null,
		},
	} as unknown as App;
}

interface Mounted {
	host: HTMLElement;
	service: FakeAgentService;
	inputController: InstanceType<typeof ChatInputController>;
	draftStore: RecordingDraftStore;
	unmount: () => Promise<void>;
}

async function mountChat(
	options: {
		withDraftStore?: boolean;
		snapshot?: Partial<ChatSnapshot>;
		failSends?: boolean;
		/** Queued answers for `suggestQuickActions`; must be set before mount, since the first request can fire during it. */
		suggestionResults?: (QuickAction[] | null)[];
		/** Chips `peekQuickActionSuggestions` serves, keyed by active note path; staged before mount for the same reason. */
		peekedSuggestions?: Record<string, QuickAction[]>;
		/**
		 * Held `suggestQuickActions` answers behind this gate, which must exist
		 * before mount: the suggestion effect fires during it, and a gate added
		 * after would miss the request entirely.
		 */
		suggestionsGate?: Promise<void>;
		/**
		 * Supplies the "open the monitor" callback, without which the entry icon is
		 * never rendered at all — the panel treats its absence as "this host has no
		 * monitor to open".
		 */
		withSubagentEntry?: boolean;
	} = {},
): Promise<Mounted> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const service = new FakeAgentService(fakeApp(), options.snapshot, options.failSends);
	if (options.suggestionResults) {
		service.suggestionResults = options.suggestionResults;
	}
	if (options.peekedSuggestions) {
		service.peekedSuggestions = options.peekedSuggestions;
	}
	if (options.suggestionsGate) {
		service.suggestionsGate = options.suggestionsGate;
	}
	const inputController = new ChatInputController();
	const draftStore = new RecordingDraftStore();
	const root = createRoot(host);
	// The cast is the point of the fake: `ObsidianAgentService` owns an `Agent`, a
	// session manager and a settings reader, none of which this contract involves.
	// TypeScript cannot express "the subset ChatApp calls", so the shape is
	// enforced by the compile of every method above instead.
	root.render(
		<ChatApp
			service={service as unknown as ObsidianAgentService}
			inputController={inputController}
			component={{} as Component}
			// Omitted by default so the draft is plain component state; the tests that
			// watch for a skipped `clearDraft` opt into the store.
			draftStore={options.withDraftStore ? (draftStore as unknown as DraftStore) : undefined}
			onOpenSubagents={options.withSubagentEntry ? () => undefined : undefined}
		/>,
	);
	await flushRender();
	return {
		host,
		service,
		inputController,
		draftStore,
		unmount: async () => {
			root.unmount();
			await flushRender();
		},
	};
}

/**
 * Records one settled subagent against a conversation, the way a spawn would.
 *
 * Goes through `registry.spawn` rather than reaching into its map, so the change
 * event that drives the panel's re-render fires the way it does in production.
 */
function seedSubagent(registry: SubagentRegistry, ownerId: string): void {
	registry.spawn({
		id: registry.nextId(),
		role: "general",
		signal: new AbortController().signal,
		parentSignal: undefined,
		ownerId,
		abort: () => undefined,
		dispose: () => undefined,
		start: () => Promise.resolve({ text: "done", turns: 1, usage: { tokens: 0, cost: 0, requests: 1 } as never, messages: [] }),
		task: `task for ${ownerId}`,
		depth: 1,
		modelId: "test-model",
		thinkingLevel: "off",
	});
}

function composer(host: HTMLElement): HTMLTextAreaElement {
	const textarea = host.querySelector("textarea");
	if (!textarea) {
		throw new Error("composer textarea did not mount");
	}
	return textarea;
}

function sendButton(host: HTMLElement): HTMLButtonElement {
	const button = host.querySelector<HTMLButtonElement>(".piem-chat__send-button");
	if (!button) {
		throw new Error("send button did not mount");
	}
	return button;
}

/**
 * Types into the controlled textarea the way a user does.
 *
 * React owns the value, and it tracks the last one it wrote: assigning
 * `textarea.value` directly leaves that record in place, so the following
 * `input` looks like a no-op and onChange never fires. Going through the
 * prototype's own setter is what makes React see a real change, and
 * `Reflect.set` with the element as receiver invokes it without ever holding the
 * unbound accessor as a value.
 */
async function typeDraft(textarea: HTMLTextAreaElement, text: string): Promise<void> {
	if (!Reflect.set(domWindow.HTMLTextAreaElement.prototype, "value", text, textarea)) {
		throw new Error("textarea value setter rejected the write");
	}
	textarea.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
	await flushRender();
}

/** Presses the send shortcut on the textarea, where the composer's capture listener sits. */
async function pressSendShortcut(textarea: HTMLTextAreaElement, modifier: "metaKey" | "ctrlKey"): Promise<void> {
	textarea.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true, cancelable: true }));
	await flushRender();
}

describe("ChatApp keyboard submit without an API key", () => {
	let mounted: Mounted | undefined;

	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		await mounted?.unmount();
		mounted = undefined;
		document.body.replaceChildren();
	});

	it("still sends on Cmd+Enter, so the disabled button is not a dead end for the keyboard", async () => {
		mounted = await mountChat();
		const textarea = composer(mounted.host);
		await typeDraft(textarea, "  Summarize this note  ");

		await pressSendShortcut(textarea, "metaKey");

		expect(mounted.service.sentPrompts).toEqual(["Summarize this note"]);
	});

	it("accepts Ctrl+Enter on the platforms that use it", async () => {
		mounted = await mountChat();
		const textarea = composer(mounted.host);
		await typeDraft(textarea, "Outline this");

		await pressSendShortcut(textarea, "ctrlKey");

		expect(mounted.service.sentPrompts).toEqual(["Outline this"]);
	});

	it("leaves the draft byte-for-byte alone, rather than clearing it and handing back a trimmed copy", async () => {
		mounted = await mountChat();
		const textarea = composer(mounted.host);
		// Padded on purpose. The prompt the service receives is trimmed, so the
		// configured path's clear-then-restore would come back without this
		// whitespace — which is what makes an untouched draft observable at all.
		await typeDraft(textarea, "  A question worth keeping\n");

		await pressSendShortcut(textarea, "metaKey");

		expect(mounted.service.sentPrompts).toEqual(["A question worth keeping"]);
		expect(composer(mounted.host).value).toBe("  A question worth keeping\n");
	});

	it("never reaches the draft store, since the send it could not make must not evict the text", async () => {
		mounted = await mountChat({ withDraftStore: true });
		await typeDraft(composer(mounted.host), "Still unsent");

		await pressSendShortcut(composer(mounted.host), "metaKey");

		// The direct observable for the deliberately-skipped `clearDraft()`: a clear
		// that a failed send immediately undid looks identical in the textarea.
		expect(mounted.draftStore.clearedSessions).toEqual([]);
		expect(await mounted.draftStore.get(SESSION_ID)).toBe("Still unsent");
	});

	it("surfaces the service's missing-key error in the banner", async () => {
		mounted = await mountChat();
		await typeDraft(composer(mounted.host), "Anything");

		await pressSendShortcut(composer(mounted.host), "metaKey");

		const banner = mounted.host.querySelector(".piem-chat__banner--error");
		expect(banner?.getAttribute("role")).toBe("alert");
		expect(banner?.querySelector(".piem-chat__banner-text")?.textContent).toBe(NEEDS_KEY_MESSAGE);
	});

	it("disables Send in the same state, and names the reason where a disabled control can still be read", async () => {
		mounted = await mountChat();
		await typeDraft(composer(mounted.host), "A full draft, no key");

		const button = sendButton(mounted.host);
		expect(button.disabled).toBe(true);
		// The accessible name explains the disabled state; the native Obsidian
		// tooltip mirrors it without adding a second browser tooltip.
		expect(button.getAttribute("aria-label")).toBe(t.t("chat.sendNeedsKey"));
		expect(button.getAttribute("title")).toBeNull();
	});

	it("routes the submit command down the same path, since it also never sees the button", async () => {
		mounted = await mountChat({ withDraftStore: true });
		await typeDraft(composer(mounted.host), " Sent by command ");

		mounted.inputController.submit();
		await flushRender();

		expect(mounted.service.sentPrompts).toEqual(["Sent by command"]);
		expect(composer(mounted.host).value).toBe(" Sent by command ");
		expect(mounted.draftStore.clearedSessions).toEqual([]);
	});

	it("sends once per shortcut, not once per listener", async () => {
		mounted = await mountChat();
		const textarea = composer(mounted.host);
		await typeDraft(textarea, "Only once");

		await pressSendShortcut(textarea, "metaKey");

		// The composer's native handler stops propagation, so React's own onKeyDown
		// never fires a second send for the same keypress.
		expect(mounted.service.sentPrompts).toHaveLength(1);
	});

	it("ignores the shortcut when the draft is empty, key or no key", async () => {
		mounted = await mountChat();

		await pressSendShortcut(composer(mounted.host), "metaKey");

		expect(mounted.service.sentPrompts).toEqual([]);
	});
});

/**
 * The model switcher's route from the composer to the service.
 *
 * `ModelSwitcher.test.tsx` covers what the menu offers and what it forwards; the
 * gap this closes is the wiring between them — that the panel mounts the switcher
 * *inside the send row* and hands its selection to the service. Both halves have
 * been silently absent before: a switcher rendered in the header would pass every
 * one of its own tests, and so would one whose `onSelect` went nowhere.
 */
describe("ChatApp model switcher", () => {
	let mounted: Mounted | undefined;

	beforeEach(() => {
		resetMenus();
		document.body.replaceChildren();
	});

	afterEach(async () => {
		await mounted?.unmount();
		mounted = undefined;
		document.body.replaceChildren();
	});

	it("sits in the send row, left of Send", async () => {
		mounted = await mountChat();

		const bar = mounted.host.querySelector(".piem-chat__composer-bar");
		const controls = Array.from(bar?.children ?? [], (child) => child.className);
		expect(controls[0]).toContain("piem-chat__model-switcher");
		// Adjacent, not merely on the same row: the thinking level qualifies the
		// model like the endpoint does, so the pair reads as one cluster before Send.
		expect(controls[1]).toContain("piem-chat__thinking-switcher");
		expect(controls[2]).toContain("piem-chat__send-button");
	});

	it("keeps the thinking selector out of the row when the model cannot think", async () => {
		mounted = await mountChat({ snapshot: { thinkingLevels: ["off"] } });

		const bar = mounted.host.querySelector(".piem-chat__composer-bar");
		const controls = Array.from(bar?.children ?? [], (child) => child.className);
		expect(controls[1]).toContain("piem-chat__send-button");
	});

	it("names the active model, which the header no longer does", async () => {
		mounted = await mountChat();

		expect(mounted.host.querySelector(".piem-chat__model-switcher-name")?.textContent).toBe("Opus 5");
		expect(mounted.host.querySelector(".piem-chat__model")).toBeNull();
	});

	it("hands a selection to the service, which is what repoints the next request", async () => {
		mounted = await mountChat();

		mounted.host.querySelector<HTMLButtonElement>(".piem-chat__model-switcher")?.click();
		await flushRender();
		lastMenu().click("Sonnet 5 · Anthropic");

		expect(mounted.service.switchedModels).toEqual(["m-sonnet"]);
	});
});

describe("ChatApp quick actions", () => {
	/** A configured target with an active note, so both suggestion rows can appear. */
	const readySnapshot: Partial<ChatSnapshot> = {
		isConfigured: true,
		contextRefs: [{ kind: "active", path: "Ideas/active-note.md", isPinned: false }],
	};

	function quickActionChips(host: HTMLElement): HTMLButtonElement[] {
		return Array.from(host.querySelectorAll<HTMLButtonElement>(".piem-chat__quick-action"));
	}

	it("sends a tapped suggestion as the user's own prompt, without touching the draft", async () => {
		const { host, service } = await mountChat({ snapshot: readySnapshot, withDraftStore: true });
		await typeDraft(composer(host), "my own half-finished thought");

		const chips = quickActionChips(host);
		expect(chips.some((chip) => chip.textContent === "Summarize this note")).toBe(true);
		chips.find((chip) => chip.textContent === "Summarize this note")?.click();
		await flushRender();

		// The tap sends the full prompt, and the user's typed draft survives it.
		expect(service.sentPrompts).toEqual(["Summarize the main points of the active note."]);
		expect(composer(host).value).toBe("my own half-finished thought");
	});

	it("restores a declined suggestion into the draft rather than losing the tap", async () => {
		const { host } = await mountChat({ snapshot: readySnapshot, failSends: true });

		quickActionChips(host)[0]?.click();
		await flushRender();

		expect(composer(host).value).toContain("Summarize the main points of the active note.");
	});

	it("shapes the empty-screen suggestions around the active note the model is told about", async () => {
		const withNote = await mountChat({ snapshot: readySnapshot });
		expect(quickActionChips(withNote.host).some((chip) => chip.textContent === "Summarize this note")).toBe(true);
		await withNote.unmount();

		const withoutNote = await mountChat({ snapshot: { isConfigured: true, contextRefs: [] } });
		expect(quickActionChips(withoutNote.host).some((chip) => chip.textContent === "Draft a new note")).toBe(true);
		await withoutNote.unmount();
	});

	it("offers no suggestions while the panel has no credential", async () => {
		const { host } = await mountChat();

		expect(quickActionChips(host)).toHaveLength(0);
	});
});

describe("ChatApp model-suggested quick actions", () => {
	/** The active note's path, shared by the snapshot and the cache staging keyed on it. */
	const NOTE_A_PATH = "Ideas/active-note.md";
	/** A configured target with an active note, so both suggestion rows can appear. */
	const readySnapshot: Partial<ChatSnapshot> = {
		isConfigured: true,
		contextRefs: [{ kind: "active", path: NOTE_A_PATH, isPinned: false }],
	};

	const agentChips: QuickAction[] = [
		{ id: "suggested-0", label: "Agent chip", prompt: "The model's own prompt." },
		{ id: "suggested-1", label: "Another", prompt: "A second one." },
	];

	function quickActionChips(host: HTMLElement): HTMLButtonElement[] {
		return Array.from(host.querySelectorAll<HTMLButtonElement>(".piem-chat__quick-action"));
	}

	function assistantReply(text: string) {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	it("swaps the empty screen's built-ins for the model's chips once the request lands", async () => {
		const { host, service } = await mountChat({ snapshot: readySnapshot, suggestionResults: [agentChips] });

		await flushRender(() => quickActionChips(host).some((chip) => chip.textContent === "Agent chip"));

		// The built-ins gave way: the model's row replaced them wholesale.
		expect(quickActionChips(host).some((chip) => chip.textContent === "Summarize this note")).toBe(false);
		expect(service.suggestionRequests).toEqual(["empty"]);
	});

	it("keeps the built-ins on the empty screen when the suggestion request fails", async () => {
		const { host, service } = await mountChat({ snapshot: readySnapshot, suggestionResults: [null] });

		await flushRender();

		// The empty screen's contract: a failure costs nothing visible.
		expect(service.suggestionRequests).toEqual(["empty"]);
		expect(quickActionChips(host).some((chip) => chip.textContent === "Summarize this note")).toBe(true);
		expect(quickActionChips(host).some((chip) => chip.textContent === "Agent chip")).toBe(false);
	});

	/*
	 * Stale-while-revalidate (issue #200): a previous visit's answer shows at
	 * once, the request still goes out, and its answer replaces the row — or,
	 * when it cannot, the cached row is what survives. The assertions below pin
	 * each leg of that contract; the request-on-hit leg matters most, because a
	 * cache that short-circuited would freeze the chips at their first wording.
	 */
	it("shows the cached chips immediately and still sends the freshening request", async () => {
		const cachedChips: QuickAction[] = [{ id: "suggested-0", label: "Cached chip", prompt: "From the last visit." }];
		let releaseRequest!: () => void;
		// The gate is staged before mount so the moment between "request sent"
		// and "answer back" is visible; an instant answer would overwrite the
		// cached row before any assertion could see it, which is the very
		// behavior the contract says happens first.
		const gate = new Promise<void>((resolve) => {
			releaseRequest = resolve;
		});
		const { host, service } = await mountChat({
			snapshot: readySnapshot,
			peekedSuggestions: { [NOTE_A_PATH]: cachedChips },
			suggestionResults: [agentChips],
			suggestionsGate: gate,
		});

		// Before the request resolves, the cached row is what fills the gap —
		// the built-ins had their turn only when there was nothing cached.
		expect(quickActionChips(host).some((chip) => chip.textContent === "Cached chip")).toBe(true);
		expect(service.suggestionRequests).toEqual(["empty"]);

		releaseRequest();
		await flushRender(() => quickActionChips(host).some((chip) => chip.textContent === "Agent chip"));
		expect(quickActionChips(host).some((chip) => chip.textContent === "Cached chip")).toBe(false);
	});

	it("keeps the cached chips on screen when the freshening request fails", async () => {
		const cachedChips: QuickAction[] = [{ id: "suggested-0", label: "Cached chip", prompt: "From the last visit." }];
		const { host } = await mountChat({
			snapshot: readySnapshot,
			peekedSuggestions: { [NOTE_A_PATH]: cachedChips },
			suggestionResults: [null],
		});

		await flushRender();

		// The request could not; the cache answers instead — the row never blanks.
		expect(quickActionChips(host).some((chip) => chip.textContent === "Cached chip")).toBe(true);
	});

	it("drops the previous note's cached chips when the switched-to note has no cache entry", async () => {
		const cachedChips: QuickAction[] = [{ id: "suggested-0", label: "Cached chip", prompt: "From the last visit." }];
		let releaseRequest!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseRequest = resolve;
		});
		const { host, service } = await mountChat({
			snapshot: readySnapshot,
			peekedSuggestions: { [NOTE_A_PATH]: cachedChips },
			suggestionResults: [agentChips, null],
			suggestionsGate: gate,
		});

		// Note A's visit: its cached row fills the gap while the request is held.
		expect(quickActionChips(host).some((chip) => chip.textContent === "Cached chip")).toBe(true);

		// Switch to a note the cache has never answered: its key reads as a miss.
		service.emit({ contextRefs: [{ kind: "active", path: "Ideas/other-note.md", isPinned: false }] });
		await flushRender();

		// Stale means *this* note's previous answer, never the previous note's:
		// the row falls back to the built-ins now, and the fresh request for the
		// new note still goes out.
		expect(quickActionChips(host).some((chip) => chip.textContent === "Cached chip")).toBe(false);
		expect(quickActionChips(host).some((chip) => chip.textContent === "Summarize this note")).toBe(true);
		expect(service.suggestionRequests).toEqual(["empty", "empty"]);

		releaseRequest();
		await flushRender();
	});

	it("shows the model's follow-ups after a reply settles", async () => {
		const { host, service } = await mountChat({ snapshot: { ...readySnapshot, isStreaming: true }, suggestionResults: [agentChips] });

		service.emit({ isStreaming: false, messages: [assistantReply("The reply the reader just read.")] as ChatSnapshot["messages"] });

		await flushRender(() => quickActionChips(host).some((chip) => chip.textContent === "Agent chip"));
		expect(service.suggestionRequests).toEqual(["reply"]);
	});

	it("leaves the post-reply row empty when the suggestion request fails", async () => {
		const { host, service } = await mountChat({ snapshot: { ...readySnapshot, isStreaming: true }, suggestionResults: [null] });

		service.emit({ isStreaming: false, messages: [assistantReply("The reply the reader just read.")] as ChatSnapshot["messages"] });
		await flushRender();

		// No fallback here, by the placement's contract: a nicety that failed shows nothing.
		expect(quickActionChips(host)).toHaveLength(0);
	});

	it("does not fire a speculative request when opening an already-settled conversation", async () => {
		const { service } = await mountChat({ snapshot: { ...readySnapshot, messages: [assistantReply("An old reply.")] as ChatSnapshot["messages"] } });

		await flushRender();

		expect(service.suggestionRequests).toEqual([]);
	});

	it("does not leak a previous conversation's chips across a session switch", async () => {
		const { host, service } = await mountChat({ snapshot: readySnapshot, suggestionResults: [agentChips] });
		await flushRender(() => quickActionChips(host).some((chip) => chip.textContent === "Agent chip"));

		// A new session bumps the revision; the old chips are tagged with revision 0.
		service.emit({ sessionRevision: 1 });
		await flushRender();

		// The reply-scope chips are stale, so the empty screen is back on its built-ins.
		expect(quickActionChips(host).some((chip) => chip.textContent === "Agent chip")).toBe(false);
		expect(quickActionChips(host).some((chip) => chip.textContent === "Summarize this note")).toBe(true);
	});
});

describe("ChatApp session fork", () => {
	let mounted: Mounted | undefined;

	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		await mounted?.unmount();
		mounted = undefined;
		document.body.replaceChildren();
	});

	/** A settled question-and-answer pair, the only shape the compare action is offered on. */
	const answered: Partial<ChatSnapshot> = {
		isConfigured: true,
		messages: [
			{ role: "user", content: [{ type: "text", text: "Original question" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "One possible answer." }],
				api: "anthropic-messages",
				provider: "deepseek",
				model: "deepseek-v4-pro",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			},
		] as ChatSnapshot["messages"],
	};

	function forkButton(host: HTMLElement): HTMLButtonElement {
		const button = host.querySelector<HTMLButtonElement>('[aria-label="Fork a new chat from here"]');
		if (!button) {
			throw new Error("fork button did not mount");
		}
		return button;
	}

	it("offers the fork action beside the newest reply's regenerate", async () => {
		// Issue #273: the fork answers "carry this exchange onward", so it rides
		// the reply's actions row beside regenerate and inherits that button's
		// newest-reply gate.
		mounted = await mountChat({ snapshot: answered });

		expect(forkButton(mounted.host)).toBeDefined();
		expect(mounted.host.querySelector('[aria-label="Edit and resend"]')).toBeDefined();
	});

	it("forks at the reply that was pressed, after the confirm dialog", async () => {
		// The button opens the confirmation first; only its press reaches the
		// service, with the reply's index.
		mounted = await mountChat({ snapshot: answered });

		forkButton(mounted.host).click();
		await flushRender();

		// By text rather than class: the composer's send button carries mod-cta too.
		const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>(".mod-cta")).find(
			(button) => button.textContent === "Fork",
		);
		expect(confirm?.textContent).toBe("Fork");
		confirm?.click();
		await flushRender();

		expect(mounted.service.forkRequests).toEqual([1]);
	});

	it("reaches the service only once the dialog is confirmed", async () => {
		mounted = await mountChat({ snapshot: answered });

		forkButton(mounted.host).click();
		await flushRender();

		// Cancelling leaves the conversation alone.
		const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent === "Cancel",
		);
		cancel?.click();
		await flushRender();

		expect(mounted.service.forkRequests).toEqual([]);
	});

	it("hides the fork action while a turn is in flight", async () => {
		// It swaps which session the panel is writing to; queueing that behind a
		// running reply would file the reply against a chat the reader left.
		mounted = await mountChat({ snapshot: { ...answered, isStreaming: true } });

		expect(mounted.host.querySelector('[aria-label="Fork a new chat from here"]')).toBeNull();
	});
});

describe("ChatApp interrupted reply", () => {
	let mounted: Mounted | undefined;

	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		await mounted?.unmount();
		mounted = undefined;
		document.body.replaceChildren();
	});

	it("offers to continue, and reaches the service's own recovery", async () => {
		mounted = await mountChat({ snapshot: { isConfigured: true, canResumeInterrupted: true } });

		const banner = mounted.host.querySelector(".piem-chat__banner--recovery");
		expect(banner?.querySelector(".piem-chat__banner-text")?.textContent).toContain("cut off before it finished");
		banner?.querySelector<HTMLButtonElement>(".piem-chat__banner-action")?.click();
		await flushRender();

		expect(mounted.service.resumeCalls).toEqual([1]);
	});

	it("withdraws the offer through its own dismissal, not the shared one", async () => {
		// Acknowledging a standing offer must not clear an outcome the service
		// reported alongside it.
		mounted = await mountChat({ snapshot: { isConfigured: true, canResumeInterrupted: true } });

		mounted.host.querySelector<HTMLButtonElement>(".piem-chat__banner--recovery .piem-chat__banner-dismiss")?.click();
		await flushRender();

		expect(mounted.service.resumeDismissals).toEqual([1]);
	});

	it("stands down while a turn is in flight", async () => {
		// `continue()` would be refused mid-run, so the offer must not invite it.
		mounted = await mountChat({ snapshot: { isConfigured: true, canResumeInterrupted: true, isStreaming: true } });

		expect(mounted.host.querySelector(".piem-chat__banner--recovery")).toBeNull();
	});
});

describe("ChatApp edit and resend", () => {
	/** A settled question-and-answer pair, the only shape the edit is offered on. */
	const answered: Partial<ChatSnapshot> = {
		isConfigured: true,
		messages: [userQuestion("What is in my vault?"), assistantReply("Notes about pi.")] as ChatSnapshot["messages"],
	};

		function userQuestion(text: string) {
		return {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
	}

	function assistantReply(text: string) {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function editButton(host: HTMLElement): HTMLButtonElement {
		const button = host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]');
		if (!button) {
			throw new Error("edit button did not mount");
		}
		return button;
	}

	it("arms the edit: the question returns to the composer and the notice states the rewrite", async () => {
		const { host } = await mountChat({ snapshot: answered });

		editButton(host).click();
		await flushRender();

		expect(composer(host).value).toBe("What is in my vault?");
		expect(host.querySelector(".piem-chat__editing")?.textContent).toContain("sending replaces this reply");
	});

	it("sends an armed edit through editAndResend, not sendPrompt", async () => {
		const { host, service } = await mountChat({ snapshot: answered });

		editButton(host).click();
		await flushRender();
		await typeDraft(composer(host), "Which notes mention pi?");
		sendButton(host).click();
		await flushRender();

		expect(service.editResends).toEqual([{ index: 0, prompt: "Which notes mention pi?", images: [] }]);
		expect(service.sentPrompts).toEqual([]);
	});

	it("clears the composer on an accepted edit, and the notice with it", async () => {
		const { host } = await mountChat({ snapshot: answered });

		editButton(host).click();
		await flushRender();
		await typeDraft(composer(host), "Rewritten question.");
		sendButton(host).click();
		await flushRender();

		expect(composer(host).value).toBe("");
		expect(host.querySelector(".piem-chat__editing")).toBeNull();
	});

	it("keeps the armed state and the text on a declined edit, so the words survive the failure", async () => {
		const { host } = await mountChat({ snapshot: answered, failSends: true });

		editButton(host).click();
		await flushRender();
		await typeDraft(composer(host), "Rewritten question.");
		sendButton(host).click();
		await flushRender();

		expect(composer(host).value).toBe("Rewritten question.");
		expect(host.querySelector(".piem-chat__editing")).not.toBeNull();
	});

	it("cancels back to the draft the edit displaced, rather than an empty composer", async () => {
		const { host } = await mountChat({ snapshot: answered });

		await typeDraft(composer(host), "Half a thought set aside.");
		editButton(host).click();
		await flushRender();

		const cancel = host.querySelector<HTMLButtonElement>('[aria-label="Cancel edit"]');
		expect(cancel).not.toBeNull();
		cancel?.click();
		await flushRender();

		expect(composer(host).value).toBe("Half a thought set aside.");
		expect(host.querySelector(".piem-chat__editing")).toBeNull();
	});

	/**
	 * The answered pair, but the question went out with a picture. Content is a
	 * real part array, the only shape `handleEditMessage` can restage from.
	 */
	const answeredWithImage: Partial<ChatSnapshot> = {
		isConfigured: true,
		messages: [
			{
				...userQuestion("What is in this picture?"),
				content: [
					{ type: "text", text: "What is in this picture?" },
					{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
				],
			},
			assistantReply("A very small diagram.") as ChatSnapshot["messages"][number],
		] as ChatSnapshot["messages"],
	};

	it("restages the original turn's images into the composer when the edit is armed", async () => {
		const { host } = await mountChat({ snapshot: answeredWithImage });

		editButton(host).click();
		await flushRender();

		// The rewrite is visible and editable, same as its words: the composer
		// is the one place the user can still unstage one before resending.
		expect(host.querySelectorAll(".piem-chat__pending-image")).toHaveLength(1);
	});

	it("sends the restaged images through editAndResend, not sendPrompt", async () => {
		const { host, service } = await mountChat({ snapshot: answeredWithImage });

		editButton(host).click();
		await flushRender();
		await typeDraft(composer(host), "And this one?");
		sendButton(host).click();
		await flushRender();

		expect(service.editResends).toEqual([
			{ index: 0, prompt: "And this one?", images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
		]);
		expect(service.sentPrompts).toEqual([]);
	});

	it("cancelling the edit discards the restaged images and restores the stage the edit displaced", async () => {
		const { host } = await mountChat({ snapshot: answeredWithImage });

		// Stage a fresh picture first, so the cancel has a displaced stage to
		// bring back — distinct from the restaged original the edit owns.
		const png = new File([new Uint8Array([0x89, 0x50])], "note.png", { type: "image/png" });
		const paste = new domWindow.Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: { files: [png] } });
		composer(host).dispatchEvent(paste);
		await flushRender();
		expect(host.querySelectorAll(".piem-chat__pending-image")).toHaveLength(1);

		editButton(host).click();
		await flushRender();
		// Still one: the displaced stage was swapped out for the restage, not
		// merged — the composer shows exactly what the resend will carry.
		expect(host.querySelectorAll(".piem-chat__pending-image")).toHaveLength(1);

		const cancel = host.querySelector<HTMLButtonElement>('[aria-label="Cancel edit"]');
		cancel?.click();
		await flushRender();

		expect(composer(host).value).toBe("");
		expect(host.querySelectorAll(".piem-chat__pending-image")).toHaveLength(1);
	});

	it("disarms silently when the transcript moves under the armed index, instead of rewriting a stranger's turn", async () => {
		// The armed state is validated per render, so a rewind below it — here,
		// the turn replaced by the service's own emit — can no longer be named by
		// the index. The send must append, never rewrite.
		const { host, service } = await mountChat({ snapshot: answered });

		editButton(host).click();
		await flushRender();
		service.emit({ messages: [userQuestion("The newer question."), assistantReply("Its answer.")] as ChatSnapshot["messages"] });
		await flushRender();

		expect(host.querySelector(".piem-chat__editing")).toBeNull();
		await typeDraft(composer(host), "A fresh question.");
		sendButton(host).click();
		await flushRender();

		expect(service.sentPrompts).toEqual(["A fresh question."]);
		expect(service.editResends).toEqual([]);
	});

	it("sends a tapped quick action as its own turn while an edit is armed, leaving the armed words as a plain draft", async () => {
		// The post-reply chips only render after the streaming→settled transition,
		// so the turn is armed first, the reply then settles with suggestions, and
		// the tap is what must append.
		const { host, service } = await mountChat({
			snapshot: { ...answered, isStreaming: true },
			suggestionResults: [[{ id: "chip-0", label: "Summarize this note", prompt: "Summarize this note" }]],
		});

		service.emit({
			isStreaming: false,
			messages: [userQuestion("What is in my vault?"), assistantReply("Notes about pi.")] as ChatSnapshot["messages"],
		});
		await flushRender(() => host.querySelector(".piem-chat__quick-action") !== null);

		editButton(host).click();
		await flushRender();
		host.querySelector<HTMLButtonElement>(".piem-chat__quick-action")?.click();
		await flushRender();

		expect(service.sentPrompts).toEqual(["Summarize this note"]);
		expect(service.editResends).toEqual([]);
	});
});

describe("ChatApp queued mid-run sends", () => {
	let mounted: Mounted | undefined;

	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		await mounted?.unmount();
		mounted = undefined;
		document.body.replaceChildren();
	});

	const queued = { id: "queued-1", text: "Use the other note", imageCount: 1 };

	function chipAction(host: HTMLElement, label: string): HTMLButtonElement {
		const button = host.querySelector<HTMLButtonElement>(`.piem-chat__queue-action[aria-label="${label}"]`);
		if (!button) {
			throw new Error(`no queue chip action labelled ${label}`);
		}
		return button;
	}

	it("takes a queued message back into the composer, words and pictures together", async () => {
		mounted = await mountChat({ snapshot: { isStreaming: true, isConfigured: true, queuedPrompts: [queued] } });
		mounted.service.queuedTakeBacks.set("queued-1", {
			text: "Use the other note",
			images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
		});

		chipAction(mounted.host, "Take back to edit").click();
		await flushRender();

		expect(mounted.service.queueRemovals).toEqual(["queued-1"]);
		expect(composer(mounted.host).value).toBe("Use the other note");
		// Dropping the picture would answer a different question than the one the
		// chip was showing.
		expect(mounted.host.querySelectorAll(".piem-chat__pending-image")).toHaveLength(1);
	});

	it("appends the taken-back words rather than overwriting a draft in progress", async () => {
		mounted = await mountChat({ snapshot: { isStreaming: true, isConfigured: true, queuedPrompts: [queued] } });
		mounted.service.queuedTakeBacks.set("queued-1", { text: "Use the other note", images: [] });
		await typeDraft(composer(mounted.host), "half a thought");

		chipAction(mounted.host, "Take back to edit").click();
		await flushRender();

		// The ordinary case is an empty composer, since the send that queued this
		// emptied it. When it is not empty, appending is the only outcome that
		// loses neither the chip nor what the reader has started typing.
		expect(composer(mounted.host).value).toBe("half a thought\n\nUse the other note");
	});

	it("steers a queued message without touching the composer", async () => {
		// The words go to the model, not back to the reader, so the draft is not
		// this control's business — and nothing is restaged either.
		mounted = await mountChat({ snapshot: { isStreaming: true, isConfigured: true, queuedPrompts: [queued] } });
		mounted.service.queuedTakeBacks.set("queued-1", { text: "Use the other note", images: [] });
		await typeDraft(composer(mounted.host), "half a thought");

		chipAction(mounted.host, "Send now — cuts the reply short").click();
		await flushRender();

		expect(mounted.service.queueSteers).toEqual(["queued-1"]);
		expect(mounted.service.queueRemovals).toEqual([]);
		expect(composer(mounted.host).value).toBe("half a thought");
	});

	it("discards a queued message without touching the composer", async () => {
		mounted = await mountChat({ snapshot: { isStreaming: true, isConfigured: true, queuedPrompts: [queued] } });
		mounted.service.queuedTakeBacks.set("queued-1", { text: "Use the other note", images: [] });
		await typeDraft(composer(mounted.host), "half a thought");

		chipAction(mounted.host, "Discard").click();
		await flushRender();

		expect(mounted.service.queueRemovals).toEqual(["queued-1"]);
		expect(composer(mounted.host).value).toBe("half a thought");
		expect(mounted.host.querySelectorAll(".piem-chat__pending-image")).toHaveLength(0);
	});

	it("leaves the composer alone when the chip's entry has already gone out", async () => {
		// The chip can outlive its entry by one render: the queue departs the
		// moment the interrupted run lands, which can be between the render and
		// the click. Nothing to restore, and nothing to report.
		mounted = await mountChat({ snapshot: { isStreaming: true, isConfigured: true, queuedPrompts: [queued] } });

		chipAction(mounted.host, "Take back to edit").click();
		await flushRender();

		expect(mounted.service.queueRemovals).toEqual(["queued-1"]);
		expect(composer(mounted.host).value).toBe("");
	});
});

describe("ChatStatusBar run readout", () => {
	/** A settled question-and-answer pair to stream over. */
	const answered: Partial<ChatSnapshot> = {
		isConfigured: true,
		messages: [userQuestion("What is in my vault?"), assistantReply("Notes about pi.")] as ChatSnapshot["messages"],
	};

	function userQuestion(text: string) {
		return {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
	}

	function assistantReply(text: string) {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function toolResult() {
		return {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: Date.now(),
		};
	}

	function runReadout(host: HTMLElement): HTMLElement | null {
		return host.querySelector(".piem-chat__run");
	}

	it("times a run from its streaming edge and counts its finished tool calls", async () => {
		setSystemTime(1_000_000);
		const { host, service } = await mountChat({ snapshot: answered });

		service.emit({ isStreaming: true });
		await flushRender();
		setSystemTime(1_000_000 + 47_000);
		service.emit({
			isStreaming: true,
			messages: [userQuestion("What is in my vault?"), toolResult()] as ChatSnapshot["messages"],
		});
		await flushRender();

		const readout = runReadout(host);
		expect(readout?.textContent).toContain("0:47");
		expect(readout?.textContent).toContain("step 1");
	});

	it("hides the readout while the run is too young, then shows it", async () => {
		setSystemTime(1_000_000);
		const { host, service } = await mountChat({ snapshot: answered });

		service.emit({ isStreaming: true });
		await flushRender();
		expect(runReadout(host)).toBeNull();

		setSystemTime(1_000_000 + 3_000);
		service.emit({ isStreaming: true });
		await flushRender();

		expect(runReadout(host)?.textContent).toContain("0:03");
	});

	it("takes the readout down when the run settles", async () => {
		setSystemTime(1_000_000);
		const { host, service } = await mountChat({ snapshot: answered });

		service.emit({ isStreaming: true });
		await flushRender();
		setSystemTime(1_000_000 + 47_000);
		service.emit({ isStreaming: true });
		await flushRender();
		expect(runReadout(host)).not.toBeNull();

		setSystemTime(1_000_000 + 48_000);
		service.emit({ isStreaming: false });
		await flushRender();

		expect(runReadout(host)).toBeNull();
	});

	it("shows no measurement on a panel reopened mid-run", async () => {
		// Its first snapshot already streams, with no edge to witness. Starting the
		// clock there would count from the wrong moment; the next turn it saw begin
		// is the next turn it times.
		setSystemTime(1_000_000);
		const { host } = await mountChat({ snapshot: { ...answered, isStreaming: true } });
		setSystemTime(1_000_000 + 47_000);
		await flushRender();

		expect(runReadout(host)).toBeNull();
	});

	afterEach(() => {
		setSystemTime();
	});
});

function baseSnapshot(): ChatSnapshot {
	return {
		messages: [],
		isStreaming: false,
		pendingToolCalls: [],
		provider: DEFAULT_SETTINGS.provider,
		modelId: DEFAULT_SETTINGS.modelId,
		runningModelId: DEFAULT_SETTINGS.modelId,
		thinkingLevel: "off",
		thinkingLevels: ["off", "low", "high"],
		modelChoices: [
			{ id: "m-opus", name: "Opus 5", provider: "OpenRouter" },
			{ id: "m-sonnet", name: "Sonnet 5", provider: "Anthropic" },
		],
		activeModelId: "m-opus",
		// A session is needed for the draft store to be keyed at all; the store-less
		// tests do not read it.
		session: sessionInfo(),
		sessionRevision: 0,
		sessionRunStates: [],
		sendShortcut: DEFAULT_SETTINGS.sendShortcut,
		usage: { tokens: 0, cost: 0, requests: 0 },
		contextFill: null,
		isCompacting: false,
		compactionEvent: null,
		compactionRetained: 0,
		isRewinding: false,
		// The state this whole file is about: a target with no credential.
		isConfigured: false,
		showAgentDetails: false,
		traceExpand: "collapsed",
		language: "en",
		contextRefs: [],
		isFollowingActiveNote: true,
		availableCommands: [],
		queuedPrompts: [],
	} as ChatSnapshot;
}

function sessionInfo(): ActiveSessionInfo {
	return {
		id: SESSION_ID,
		path: `chats/${SESSION_ID}.jsonl`,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		messageCount: 0,
		firstMessage: "",
	};
}

/**
 * A fill sitting exactly on the compaction line — the same occupancy the gauge
 * colours red and the automatic compaction would act on. `near` is derived from
 * `ratio >= compactionRatio`, so the two numbers, not a third threshold, decide
 * whether the wall shows.
 */
function nearFill(): NonNullable<ChatSnapshot["contextFill"]> {
	return {
		tokens: 900,
		contextWindow: 1000,
		ratio: 0.9,
		compactionRatio: 0.9,
		heuristicOnly: false,
	};
}

describe("ChatApp subagent entry icon", () => {
	let mounted: Mounted | null = null;

	afterEach(async () => {
		await mounted?.unmount();
		mounted = null;
	});

	it("counts the runs this conversation ordered, and not another's", async () => {
		mounted = await mountChat({ withSubagentEntry: true });
		const registry = mounted.service.getSubagentRegistry();

		seedSubagent(registry, `chats/${SESSION_ID}.jsonl`);
		// A background conversation's child. It is in the same registry — there is
		// only one — and the icon must not fold it into this chat's count, nor offer
		// its row in a popover belonging to a transcript it was never part of.
		seedSubagent(registry, "chats/somewhere-else.jsonl");
		await flushRender();

		const badge = mounted.host.querySelector(".piem-chat__subagents-badge");
		expect(badge?.textContent).toBe("1");
		const button = mounted.host.querySelector<HTMLButtonElement>(".piem-chat__subagents-button");
		expect(button?.getAttribute("aria-label")).toContain("1");
	});

	it("stays absent while only another conversation has delegated", async () => {
		mounted = await mountChat({ withSubagentEntry: true });

		seedSubagent(mounted.service.getSubagentRegistry(), "chats/somewhere-else.jsonl");
		await flushRender();

		// No icon at all, which is the honest report for a chat that delegated
		// nothing: the monitor panel is where another chat's fan-out is visible.
		expect(mounted.host.querySelector(".piem-chat__subagents-button")).toBeNull();
	});
});

describe("ChatApp context wall", () => {
	let mounted: Mounted | undefined;

	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		await mounted?.unmount();
		mounted = undefined;
		document.body.replaceChildren();
	});

	it("offers the tidy action once occupancy reaches the compaction line", async () => {
		mounted = await mountChat({ snapshot: { contextFill: nearFill() } });

		const banner = mounted.host.querySelector(".piem-chat__banner--wall");
		expect(banner?.querySelector(".piem-chat__banner-text")?.textContent).toContain(t.t("chat.contextWall"));
		// It rides the standing polite region, not the alert channel.
		expect(banner?.parentElement?.getAttribute("aria-live")).toBe("polite");
	});

	it("stays silent below the line, since the gauge already owns the colouring", async () => {
		mounted = await mountChat({
			snapshot: { contextFill: { ...nearFill(), ratio: 0.89 } },
		});

		expect(mounted.host.querySelector(".piem-chat__banner--wall")).toBeNull();
	});

	it("runs the service's compaction when the tidy button is pressed", async () => {
		mounted = await mountChat({ snapshot: { contextFill: nearFill() } });

		mounted.host.querySelector<HTMLButtonElement>(".piem-chat__banner--wall .piem-chat__banner-action")?.click();
		await flushRender();

		expect(mounted.service.tidyCalls).toHaveLength(1);
	});

	it("clears only the offer on dismiss, not the service's reported outcomes", async () => {
		mounted = await mountChat({ snapshot: { contextFill: nearFill() } });

		mounted.host.querySelector<HTMLButtonElement>(".piem-chat__banner--wall .piem-chat__banner-dismiss")?.click();
		await flushRender();

		expect(mounted.host.querySelector(".piem-chat__banner--wall")).toBeNull();
	});

	it("yields to an outcome report, which still outranks a standing offer", async () => {
		mounted = await mountChat({ snapshot: { contextFill: nearFill() } });
		mounted.service.emit({ noticeMessage: "Nothing to compact yet." });
		await flushRender();

		expect(mounted.host.querySelector(".piem-chat__banner--notice")).not.toBeNull();
		expect(mounted.host.querySelector(".piem-chat__banner--wall")).toBeNull();
	});

	it("withdraws while a stream runs, since the tidy button would be a lie", async () => {
		mounted = await mountChat({ snapshot: { contextFill: nearFill() } });
		mounted.service.emit({ isStreaming: true });
		await flushRender();

		expect(mounted.host.querySelector(".piem-chat__banner--wall")).toBeNull();

		mounted.service.emit({ isStreaming: false });
		await flushRender();
		// The offer returns with the panel idle — the state is still true.
		expect(mounted.host.querySelector(".piem-chat__banner--wall")).not.toBeNull();
	});

	it("withdraws while a compaction is in flight, for the same reason", async () => {
		mounted = await mountChat({ snapshot: { contextFill: nearFill() } });
		mounted.service.emit({ isCompacting: true });
		await flushRender();

		expect(mounted.host.querySelector(".piem-chat__banner--wall")).toBeNull();
	});
});
