import { describe, expect, test } from "bun:test";
import type { Entry, JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import { aggregateSessionSearchHits, makeSnippet, projectSessionEntryText, type StoredSessionSearchHit } from "./sessionSearch";

const META = { id: "s1", path: "chats/s1.jsonl", cwd: "piem", createdAt: 0, modifiedAt: 0, sourceFormat: 4 } as JsonlSessionMetadata;

function messageEntry(message: unknown): Entry {
	return { type: "message", id: "e1", seq: 1, parentId: null, timestamp: 0, message } as Entry;
}

describe("projectSessionEntryText", () => {
	test("indexes user text, string or parts", () => {
		expect(projectSessionEntryText(META, messageEntry({ role: "user", content: "找回那次讨论", timestamp: 0 }))).toBe("找回那次讨论");
		const parts = messageEntry({ role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }], timestamp: 0 });
		expect(projectSessionEntryText(META, parts)).toBe("hello\nworld");
	});

	test("keeps tool calls, images and thinking out of the index", () => {
		const entry = messageEntry({
			role: "assistant",
			content: [
				{ type: "text", text: "visible" },
				{ type: "thinking", thinking: "secret plan" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "note.md" } },
				{ type: "image", data: "AAAABBBB", mimeType: "image/png" },
			],
			timestamp: 0,
		});
		const text = projectSessionEntryText(META, entry);
		expect(text).toBe("visible");
		expect(text).not.toContain("secret plan");
		expect(text).not.toContain("AAAABBBB");
	});

	test("indexes summaries and appends a label", () => {
		const compaction = { type: "compaction", id: "c1", seq: 2, parentId: null, timestamp: 0, summary: "earlier work", retainedTail: [], tokensBefore: 10 } as Entry;
		expect(projectSessionEntryText(META, compaction)).toBe("earlier work");
		expect(projectSessionEntryText(META, messageEntry({ role: "user", content: "body", timestamp: 0 }), "pinned")).toBe("body pinned");
	});

	test("configuration entries carry no searchable body", () => {
		const modelChange = { type: "model_change", id: "m1", seq: 3, parentId: null, timestamp: 0, provider: "anthropic", modelId: "claude" } as Entry;
		expect(projectSessionEntryText(META, modelChange)).toBe("");
	});
});

describe("makeSnippet", () => {
	test("returns short text unchanged", () => {
		expect(makeSnippet("  short body  ", "body")).toBe("short body");
	});

	test("centres the window on the match and marks both cuts", () => {
		const text = `${"a".repeat(300)}NEEDLE${"b".repeat(300)}`;
		const snippet = makeSnippet(text, "needle", 60);
		expect(snippet).toContain("NEEDLE");
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(64);
	});

	test("falls back to the head when the query is absent or empty", () => {
		const text = "x".repeat(400);
		expect(makeSnippet(text, "", 50).startsWith("…")).toBe(false);
		expect(makeSnippet(text, "zzz", 50).startsWith("…")).toBe(false);
	});
});

describe("aggregateSessionSearchHits", () => {
	const hit = (sessionId: string, entryId: string, snippet: string): StoredSessionSearchHit => ({
		sessionId, entryId, snippet, path: `chats/${sessionId}.jsonl`, entryType: "message", timestamp: 1,
	});

	test("folds one row per session and counts the matches", () => {
		const results = aggregateSessionSearchHits([hit("a", "1", "first"), hit("a", "2", "second"), hit("b", "3", "other")], "irst");
		expect(results.map((item) => item.sessionId)).toEqual(["a", "b"]);
		expect(results[0]?.matchCount).toBe(2);
		expect(results[0]?.entryId).toBe("1");
		expect(results[0]?.snippet).toBe("first");
	});

	test("stops folding new sessions at the cap", () => {
		const hits = ["a", "b", "c"].map((id) => hit(id, "1", "body"));
		expect(aggregateSessionSearchHits(hits, "body", 2)).toHaveLength(2);
	});

	test("carries the path a picker needs to open the chat", () => {
		expect(aggregateSessionSearchHits([hit("a", "1", "body")], "body")[0]?.path).toBe("chats/a.jsonl");
	});
});
