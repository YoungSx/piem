import { describe, expect, it } from "bun:test";
import { NoteSessionIndex } from "./noteSessionIndex";

describe("NoteSessionIndex", () => {
	it("records and checks note session associations", () => {
		const index = new NoteSessionIndex(10);
		expect(index.has("notes/a.md")).toBe(false);

		index.record("notes/a.md", "sessions/session-1.jsonl", "Session 1");
		expect(index.has("notes/a.md")).toBe(true);
		// Same session is not a "prior" session
		expect(index.has("notes/a.md", "sessions/session-1.jsonl")).toBe(false);
		// Different session is a prior session
		expect(index.has("notes/a.md", "sessions/session-2.jsonl")).toBe(true);

		const record = index.get("notes/a.md");
		expect(record?.sessionPath).toBe("sessions/session-1.jsonl");
		expect(record?.sessionTitle).toBe("Session 1");
	});

	it("evicts oldest entries when exceeding maxEntries", () => {
		const index = new NoteSessionIndex(2);
		index.record("note1.md", "sess1.jsonl");
		index.record("note2.md", "sess2.jsonl");
		expect(index.has("note1.md")).toBe(true);
		expect(index.has("note2.md")).toBe(true);

		// Record third note, should evict note1
		index.record("note3.md", "sess3.jsonl");
		expect(index.has("note3.md")).toBe(true);
		expect(index.has("note1.md")).toBe(false);
		expect(index.has("note2.md")).toBe(true);
	});

	it("clears records correctly", () => {
		const index = new NoteSessionIndex(5);
		index.record("a.md", "s1.jsonl");
		index.clear();
		expect(index.has("a.md")).toBe(false);
	});
});
