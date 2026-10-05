import { afterEach, beforeEach, expect, test } from "bun:test";
import { installObsidianStub, resetNotices, shownNotices } from "./testUtils/obsidianStub";
import { installDom } from "./testUtils/dom";

// main reaches react-dom through its real View: use the shared realm before import.
installObsidianStub();
installDom();
const { default: PiemPlugin } = await import("./main");

interface ChatRoutes {
	startOriginalChat(): Promise<void>;
	startNewChat(): Promise<void>;
	openChatPath(path: string, native: boolean): Promise<void>;
}

const previewFlag = "__PIEM_NATIVE_CHAT_PREVIEW__";
let previousFlag: PropertyDescriptor | undefined;
beforeEach(() => {
	resetNotices();
	previousFlag = Object.getOwnPropertyDescriptor(globalThis, previewFlag);
	Object.defineProperty(globalThis, previewFlag, { value: true, configurable: true });
});
afterEach(() => {
	if (previousFlag) Object.defineProperty(globalThis, previewFlag, previousFlag);
	else Reflect.deleteProperty(globalThis, previewFlag);
});

function fixture(options: {
	initialize?: () => Promise<void>;
	newSession?: () => Promise<void>;
	openSession?: (path: string) => Promise<void>;
	createNative?: () => Promise<{ path: string }>;
} = {}) {
	const events: string[] = [];
	let visible = "native/current.jsonl";
	const service = {
		initialize: async () => { events.push("initialize"); await options.initialize?.(); },
		newSession: async () => { events.push("new original"); await options.newSession?.(); },
		openSession: async (path: string) => { events.push(`open ${path}`); await options.openSession?.(path); },
	};
	const view = {
		showLegacy: async () => { events.push("show original"); visible = "original"; },
		showNative: async (path: string) => { events.push(`show native ${path}`); visible = path; },
		focusInput: () => events.push("focus"),
	};
	// Same prototype seam as settingsPersistence/fileMenuEntry; all routing code is real.
	const plugin = Object.assign(Object.create(PiemPlugin.prototype), {
		activateChatView: async () => { events.push("activate"); },
		requireAgentService: () => service,
		findChatView: () => view,
		nativeChats: { create: async () => { events.push("create native"); return options.createNative?.() ?? { path: "native/new.jsonl" }; } },
	}) as ChatRoutes;
	return { plugin, events, visible: () => visible };
}

test("Open original waits for cold initialization and new-session admission before changing the visible route", async () => {
	const initialized = Promise.withResolvers<void>(), initializationStarted = Promise.withResolvers<void>();
	const created = Promise.withResolvers<void>(), creationStarted = Promise.withResolvers<void>();
	const f = fixture({
		initialize: () => { initializationStarted.resolve(); return initialized.promise; },
		newSession: () => { creationStarted.resolve(); return created.promise; },
	});
	const opening = f.plugin.startOriginalChat();
	try {
		await initializationStarted.promise;
		expect(f.events).toEqual(["activate", "initialize"]);
		expect(f.visible()).toBe("native/current.jsonl");
		initialized.resolve();
		await creationStarted.promise;
		expect(f.events).toEqual(["activate", "initialize", "new original"]);
		expect(f.visible()).toBe("native/current.jsonl");
		created.resolve();
		await opening;
		expect(f.events).toEqual(["activate", "initialize", "new original", "show original", "focus"]);
		expect(f.visible()).toBe("original");
	} finally { initialized.resolve(); created.resolve(); await opening; }
});

test("an original history selection changes the route only after initialization and openSession settle", async () => {
	const initialized = Promise.withResolvers<void>(), initializationStarted = Promise.withResolvers<void>();
	const opened = Promise.withResolvers<void>(), openStarted = Promise.withResolvers<void>();
	const f = fixture({
		initialize: () => { initializationStarted.resolve(); return initialized.promise; },
		openSession: () => { openStarted.resolve(); return opened.promise; },
	});
	const opening = f.plugin.openChatPath("chats/original.jsonl", false);
	try {
		await initializationStarted.promise;
		expect(f.events).toEqual(["initialize"]);
		expect(f.visible()).toBe("native/current.jsonl");
		initialized.resolve();
		await openStarted.promise;
		expect(f.events).toEqual(["initialize", "open chats/original.jsonl"]);
		expect(f.visible()).toBe("native/current.jsonl");
		opened.resolve(); await opening;
		expect(f.visible()).toBe("original");
		expect(f.events.at(-1)).toBe("show original");
	} finally { initialized.resolve(); opened.resolve(); await opening; }
});

test("failed original history loading preserves the current route and reports the error without another engine", async () => {
	const f = fixture({ openSession: async () => { throw new Error("Session unavailable"); } });
	await f.plugin.openChatPath("chats/missing.jsonl", false);
	expect(f.visible()).toBe("native/current.jsonl");
	expect(f.events).toEqual(["initialize", "open chats/missing.jsonl"]);
	expect(shownNotices.map(notice => notice.message)).toEqual(["Error: Session unavailable"]);
});

test("native creation I/O failure is reported and never falls back to an original conversation", async () => {
	const f = fixture({ createNative: async () => { throw new Error("Disk full"); } });
	await expect(f.plugin.startNewChat()).resolves.toBeUndefined();
	expect(f.events).toEqual(["activate", "create native"]);
	expect(f.visible()).toBe("native/current.jsonl");
	expect(shownNotices.map(notice => notice.message)).toEqual(["Error: Disk full"]);
});
