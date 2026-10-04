import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { textLineReader } from "./textLineReader";

test("line reading preserves CRLF, empty lines and torn tails without inventing EOF records", async () => {
	for (const [content, lines] of [
		["", []],
		["\n", [{ text: "", terminated: true }]],
		["a\r\n\ntail", [{ text: "a\r", terminated: true }, { text: "", terminated: true }, { text: "tail", terminated: false }]],
		["a\n", [{ text: "a", terminated: true }]],
	] as const) {
		const reader = textLineReader(content, "note.md");
		for (const line of lines) expect(await reader.readLine(BACKGROUND_CONTEXT)).toEqual({ ok: true, value: line });
		expect(await reader.readLine(BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		await reader.close(BACKGROUND_CONTEXT);
	}
});

test("cancellation does not consume a line and close is idempotent", async () => {
	const reader = textLineReader("first\nsecond", "note.md");
	const controller = new AbortController();
	controller.abort();
	const cancelled = await reader.readLine(withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
	expect(!cancelled.ok && cancelled.error.code).toBe("aborted");
	expect(await reader.readLine(BACKGROUND_CONTEXT)).toEqual({ ok: true, value: { text: "first", terminated: true } });
	await reader.close(BACKGROUND_CONTEXT);
	await reader.close(BACKGROUND_CONTEXT);
	const closed = await reader.readLine(BACKGROUND_CONTEXT);
	expect(!closed.ok && closed.error.code).toBe("invalid");
});
