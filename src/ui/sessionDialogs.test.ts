import { describe, expect, it } from "bun:test";
import type { App } from "obsidian";
import { installDom } from "../testUtils/dom";
import { installObsidianStub, lastSuggestModal, resetSuggestModals, type SuggestModalHandle } from "../testUtils/obsidianStub";
import { getT } from "../i18n";
import type { ActiveSessionInfo } from "../session/ObsidianSessionManager";
import type { SessionSearchResult } from "../session/sessionSearch";

installObsidianStub();
installDom();

const { openSessionPicker, sessionTitle, describeSession } = await import("./sessionDialogs");
const t = getT("en");
const app = {} as App;

function session(path: string, name: string, updatedAt = "2026-01-02T03:04:05.000Z"): ActiveSessionInfo {
	return { id: path, path, name, createdAt: "2026-01-01T00:00:00.000Z", updatedAt, messageCount: 2, firstMessage: "" };
}

function openedWithOpener(path: string, firstMessage: string): ActiveSessionInfo {
	return { ...session(path, ""), firstMessage };
}

function hit(path: string, snippet: string, matchCount = 1): SessionSearchResult {
	return { sessionId: path, path, entryId: "e1", entryType: "message", timestamp: 1, snippet, matchCount };
}

const SESSIONS = [session("a.jsonl", "Vector search notes"), session("b.jsonl", "Grocery list")];

interface PickerSetup {
	picker: SuggestModalHandle;
	openedPaths: string[];
	deleted: ActiveSessionInfo[];
	queries: string[];
	settle: (query: string, hits: SessionSearchResult[]) => void;
	rowTexts: () => string[];
}

/**
 * Opens the picker with a search function whose promises the test resolves by
 * hand, which is what makes the ordering assertions below possible.
 */
function setup(options: { search?: boolean; sessions?: ActiveSessionInfo[] } = {}): PickerSetup {
	resetSuggestModals();
	const openedPaths: string[] = [];
	const deleted: ActiveSessionInfo[] = [];
	const queries: string[] = [];
	const waiting = new Map<string, (hits: SessionSearchResult[]) => void>();
	openSessionPicker(
		app,
		options.sessions ?? SESSIONS,
		{
			onOpen: (path) => openedPaths.push(path),
			onDelete: (item) => deleted.push(item),
			searchSessions:
				options.search === false
					? undefined
					: (text) => {
							queries.push(text);
							return new Promise<SessionSearchResult[]>((resolve) => waiting.set(text, resolve));
						},
		},
		t,
	);
	const picker = lastSuggestModal()!;
	return {
		picker,
		openedPaths,
		deleted,
		queries,
		settle: (query, hits) => waiting.get(query)?.(hits),
		rowTexts: () => Array.from(picker.resultContainerEl.children).map((row) => row.textContent ?? ""),
	};
}

async function flush(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

describe("sessionTitle", () => {
	it("uses the opener verbatim until it outruns a label", () => {
		expect(sessionTitle(session("a.jsonl", "Vector search notes"), t)).toBe("Vector search notes");
	});

	it("caps a several-hundred-character opener to one line's worth of text", () => {
		const title = sessionTitle(openedWithOpener("a.jsonl", "很".repeat(300)), t);

		expect(title).toHaveLength(61);
		expect(title.endsWith("…")).toBe(true);
		expect(title.slice(0, 60)).toBe("很".repeat(60));
	});

	it("falls back to the opener only when no name exists", () => {
		expect(sessionTitle(openedWithOpener("a.jsonl", "first line\nsecond line"), t)).toBe("first line");
	});

	it("caps a long explicit name the same way", () => {
		const title = sessionTitle(session("a.jsonl", "x".repeat(200)), t);

		expect(title).toHaveLength(61);
		expect(title.endsWith("…")).toBe(true);
	});

	it("lets exactly sixty characters pass without an ellipsis", () => {
		const label = "y".repeat(60);

		expect(sessionTitle(session("a.jsonl", label), t)).toBe(label);
		expect(sessionTitle(openedWithOpener("a.jsonl", label), t)).toBe(label);
	});

	it("passes the capped title to everything that phrases a session", () => {
		const described = describeSession(openedWithOpener("a.jsonl", "很".repeat(300)), t);

		expect(described.startsWith("很".repeat(60) + "…")).toBe(true);
		expect(described).toContain("·");
	});
});

describe("openSessionPicker", () => {
	it("lists every chat before anything is typed", async () => {
		const { picker, rowTexts } = setup();
		await picker.rerender();

		expect(rowTexts()).toHaveLength(2);
		expect(rowTexts()[0]).toContain("Vector search notes");
	});

	it("paints title matches without waiting for the scan", async () => {
		const { picker, rowTexts, queries } = setup();
		await picker.type("grocery");

		// The scan has been started but nothing has resolved it, so these rows can
		// only have come from the already-loaded list.
		expect(queries).toEqual(["grocery"]);
		expect(rowTexts()).toHaveLength(1);
		expect(rowTexts()[0]).toContain("Grocery list");
	});

	it("adds a chat that only matches on what was said, with a snippet", async () => {
		const { picker, rowTexts, settle } = setup();
		await picker.type("embeddings");
		expect(rowTexts()).toHaveLength(0);

		settle("embeddings", [hit("a.jsonl", "we compared embeddings", 3)]);
		await flush();

		expect(rowTexts()).toHaveLength(1);
		expect(rowTexts()[0]).toContain("Vector search notes");
		expect(rowTexts()[0]).toContain("we compared embeddings");
		expect(rowTexts()[0]).toContain("3 matching messages");
	});

	it("ignores a scan that lands after the query moved on", async () => {
		const { picker, rowTexts, settle } = setup();
		await picker.type("embeddings");
		await picker.type("grocery");

		settle("embeddings", [hit("a.jsonl", "stale result")]);
		await flush();

		expect(rowTexts()).toHaveLength(1);
		expect(rowTexts()[0]).toContain("Grocery list");
		expect(rowTexts()[0]).not.toContain("stale result");
	});

	it("aborts the superseded scan", async () => {
		const aborts: string[] = [];
		resetSuggestModals();
		openSessionPicker(
			app,
			SESSIONS,
			{
				onOpen: () => undefined,
				onDelete: () => undefined,
				searchSessions: (text, options) => {
					options.signal.addEventListener("abort", () => aborts.push(text));
					return new Promise<SessionSearchResult[]>(() => undefined);
				},
			},
			t,
		);
		const picker = lastSuggestModal()!;
		await picker.type("first");
		await picker.type("second");

		expect(aborts).toEqual(["first"]);
	});

	it("scans a query once and reuses the result", async () => {
		const { picker, queries, settle } = setup();
		await picker.type("embeddings");
		settle("embeddings", [hit("a.jsonl", "hit")]);
		await flush();
		await picker.rerender();

		expect(queries).toEqual(["embeddings"]);
	});

	it("keeps the title matches when the scan fails", async () => {
		resetSuggestModals();
		openSessionPicker(
			app,
			SESSIONS,
			{
				onOpen: () => undefined,
				onDelete: () => undefined,
				searchSessions: () => Promise.reject(new Error("disk on fire")),
			},
			t,
		);
		const picker = lastSuggestModal()!;
		await picker.type("grocery");
		await flush();

		expect(Array.from(picker.resultContainerEl.children)).toHaveLength(1);
	});

	it("opens the chosen chat by path, and deletes on shift", async () => {
		const { picker, openedPaths, deleted } = setup();
		await picker.type("grocery");
		await picker.choose(0);
		await picker.choose(0, { shiftKey: true });

		expect(openedPaths).toEqual(["b.jsonl"]);
		expect(deleted.map((item) => item.path)).toEqual(["b.jsonl"]);
	});

	it("opens a content-only hit by its own path", async () => {
		const { picker, openedPaths, settle } = setup();
		await picker.type("embeddings");
		settle("embeddings", [hit("a.jsonl", "we compared embeddings")]);
		await flush();
		await picker.choose(0);

		expect(openedPaths).toEqual(["a.jsonl"]);
	});

	it("renders a several-hundred-character opener as the capped title, not the paragraph", async () => {
		const { picker } = setup({ sessions: [openedWithOpener("a.jsonl", "很".repeat(300))] });
		await picker.rerender();

		// The title span alone: the row also carries the timestamp line, which has
		// its own width and isn't the thing under test.
		const title = picker.resultContainerEl.querySelector<HTMLElement>(".piem-session-value")?.textContent ?? "";
		expect(title).toHaveLength(61);
		expect(title.endsWith("…")).toBe(true);
	});

	it("says it searches transcripts only when it can", async () => {
		expect(setup().picker.getPlaceholder()).toBe(t.t("session.searchContentPlaceholder"));
		expect(setup({ search: false }).picker.getPlaceholder()).toBe(t.t("session.searchPlaceholder"));
	});

	it("keeps the open and delete hints", async () => {
		expect(setup().picker.getInstructions().map((item) => item.purpose)).toEqual([
			t.t("session.pickerOpenHint"),
			t.t("session.pickerDeleteHint"),
		]);
	});

	it("aborts the running scan when the picker closes", async () => {
		const aborts: string[] = [];
		resetSuggestModals();
		openSessionPicker(
			app,
			SESSIONS,
			{
				onOpen: () => undefined,
				onDelete: () => undefined,
				searchSessions: (text, options) => {
					options.signal.addEventListener("abort", () => aborts.push(text));
					return new Promise<SessionSearchResult[]>(() => undefined);
				},
			},
			t,
		);
		const picker = lastSuggestModal()!;
		await picker.type("embeddings");
		picker.close();

		expect(aborts).toEqual(["embeddings"]);
	});
});

describe("openSessionPicker run-state dots", () => {
	function openWithStates(states: ReadonlyArray<{ path: string; state: "idle" | "running" | "waiting-input" | "error" }>): SuggestModalHandle {
		resetSuggestModals();
		openSessionPicker(
			app,
			SESSIONS,
			{
				onOpen: () => undefined,
				onDelete: () => undefined,
			},
			t,
			states,
		);
		return lastSuggestModal()!;
	}

	function dot(picker: SuggestModalHandle, state: string): HTMLElement | null {
		return picker.resultContainerEl.querySelector<HTMLElement>(`.piem-session-run-dot--${state}`);
	}

	it("marks a busy session with a labelled dot and leaves idle rows clean", async () => {
		const picker = openWithStates([
			{ path: "a.jsonl", state: "running" },
			{ path: "b.jsonl", state: "idle" },
		]);
		await picker.rerender();

		expect(dot(picker, "running")).not.toBeNull();
		expect(dot(picker, "running")?.getAttribute("aria-label")).toBe(t.t("session.runStateRunning"));
		expect(dot(picker, "waiting-input")).toBeNull();
		expect(dot(picker, "error")).toBeNull();
		// Idle paints nothing: the row keeps its plain title only.
		expect(dot(picker, "idle")).toBeNull();
	});

	it("shows the alert states a paused or failed session wears", async () => {
		const picker = openWithStates([
			{ path: "a.jsonl", state: "waiting-input" },
			{ path: "b.jsonl", state: "error" },
		]);
		await picker.rerender();

		expect(dot(picker, "waiting-input")?.getAttribute("aria-label")).toBe(t.t("session.runStateWaitingInput"));
		expect(dot(picker, "error")?.getAttribute("aria-label")).toBe(t.t("session.runStateError"));
	});
});
