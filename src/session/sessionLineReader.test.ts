import { expect, test } from "bun:test";
import type { DataAdapter } from "obsidian";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";

test("session readers retain vault guards and honor chord cancellation before and after opening", async () => {
	const adapter = new MemoryAdapter();
	const fs = new ObsidianSessionFileSystem(adapter as unknown as DataAdapter);
	await adapter.write("note.md", "first\r\nsecond");
	const outside = await fs.openTextLineReader("../outside", BACKGROUND_CONTEXT);
	expect(!outside.ok && outside.error.code).toBe("invalid");
	const controller = new AbortController();
	const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
	const opened = await fs.openTextLineReader("note.md", context);
	if (!opened.ok) throw opened.error;
	expect(await opened.value.readLine(context)).toEqual({ ok: true, value: { text: "first\r", terminated: true } });
	controller.abort();
	const cancelledRead = await opened.value.readLine(context);
	expect(!cancelledRead.ok && cancelledRead.error.code).toBe("aborted");
	const cancelledOpen = await fs.openTextLineReader("note.md", context);
	expect(!cancelledOpen.ok && cancelledOpen.error.code).toBe("aborted");
	await opened.value.close(context);
});
