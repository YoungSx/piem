import { afterAll, describe, expect, it } from "bun:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CommunityHost } from "./communityHost";
import { stubWindowTimers } from "../testUtils/windowStub";

const restore = stubWindowTimers();
afterAll(restore);

/**
 * Host-level contract for the two interception events.
 *
 * These assert the seam in isolation — that a handler's block/mutation/rewrite
 * survives the host's clone-and-scope discipline, and that an unsubscribed host
 * does no work. Whether pi's loop then honours the answer is a different claim,
 * and is asserted end-to-end against a real conversation in
 * `../agent/nativeExtensionService.test.ts`.
 */
async function fixture(factory: ExtensionFactory) {
	let reads = 0;
	const host = await CommunityHost.create({
		getEntries: () => [], getBranch: () => [], getModel: () => undefined,
		getThinkingLevel: () => "off", isIdle: () => true, notify: () => {},
		prepare: async () => { reads++; }, deliver: () => {},
		platform: { fetch: async () => { throw new Error("No network expected"); }, readConfig: () => undefined, onError: error => { throw error; } },
	}, [{ id: "tool-interception", factory }]);
	return { host, reads: () => reads };
}

const call = (input: Record<string, unknown>) => ({ type: "tool_call" as const, toolName: "read_note", toolCallId: "call-1", input });
const executed = (text: string) => ({
	type: "tool_result" as const, toolName: "read_note", toolCallId: "call-1", input: { path: "Note.md" },
	content: [{ type: "text" as const, text }], details: { ok: true }, isError: false,
});

describe("tool call interception", () => {
	it("blocks a call and carries the reason back to the caller", async () => {
		const f = await fixture(pi => {
			pi.on("tool_call", event => (event.input as { path?: string }).path === "Secret.md" ? { block: true, reason: "That note is off limits." } : undefined);
		});
		try {
			expect(await f.host.toolCall(call({ path: "Secret.md" }))).toEqual({ block: true, reason: "That note is off limits." });
			// A call the handler does not object to comes back with no opinion.
			expect(await f.host.toolCall(call({ path: "Note.md" }))).toBeUndefined();
		} finally { f.host.dispose(); await f.host.closed(); }
	});

	it("forwards an in-place input mutation to the very object the caller holds", async () => {
		const f = await fixture(pi => {
			pi.on("tool_call", event => { (event.input as { path: string }).path = "Rewritten.md"; });
		});
		try {
			// The identity of this object is the contract: pi hands the same one to
			// `tool.execute`, so a mutation is only real if it lands here.
			const input = { path: "Note.md" };
			expect(await f.host.toolCall(call(input))).toBeUndefined();
			expect(input.path).toBe("Rewritten.md");
		} finally { f.host.dispose(); await f.host.closed(); }
	});

	it("lets a later handler see an earlier handler's mutation", async () => {
		const seen: string[] = [];
		const f = await fixture(pi => {
			pi.on("tool_call", event => { (event.input as { path: string }).path += "-first"; });
			pi.on("tool_call", event => { seen.push((event.input as { path: string }).path); });
		});
		try {
			const input = { path: "Note.md" };
			await f.host.toolCall(call(input));
			expect(seen).toEqual(["Note.md-first"]);
			expect(input.path).toBe("Note.md-first");
		} finally { f.host.dispose(); await f.host.closed(); }
	});

	it("rewrites a result field by field, leaving untouched fields alone", async () => {
		const f = await fixture(pi => {
			pi.on("tool_result", () => ({ content: [{ type: "text", text: "redacted" }], isError: true }));
		});
		try {
			const result = await f.host.toolResult(executed("secret body"));
			expect(result?.content).toEqual([{ type: "text", text: "redacted" }]);
			expect(result?.isError).toBe(true);
			// `details` was not returned by the handler, so the executed value stands.
			expect(result?.details).toEqual({ ok: true });
		} finally { f.host.dispose(); await f.host.closed(); }
	});

	it("does not let a tool_result handler mutate the executed result in place", async () => {
		const f = await fixture(pi => {
			pi.on("tool_result", event => { event.content.push({ type: "text", text: "smuggled" }); });
		});
		try {
			const event = executed("body");
			await f.host.toolResult(event);
			// Unlike tool_call, tool_result has no documented mutation contract —
			// replacement is by returned field — so the caller's event is cloned.
			expect(event.content).toEqual([{ type: "text", text: "body" }]);
		} finally { f.host.dispose(); await f.host.closed(); }
	});

	it("surfaces a failing handler instead of passing the call through", async () => {
		const f = await fixture(pi => {
			pi.on("tool_call", () => { throw new Error("vetting failed"); });
			pi.on("tool_result", () => { throw new Error("rewrite failed"); });
		});
		try {
			await expect(f.host.toolCall(call({ path: "Note.md" }))).rejects.toThrow("vetting failed");
			await expect(f.host.toolResult(executed("body"))).rejects.toThrow("rewrite failed");
		} finally { f.host.dispose(); await f.host.closed(); }
	});

	it("does nothing at all when no extension subscribes", async () => {
		const f = await fixture(pi => { pi.on("agent_start", () => {}); });
		try {
			await f.host.start();
			const before = f.reads();
			const input = { path: "Note.md" };
			expect(await f.host.toolCall(call(input))).toBeUndefined();
			expect(await f.host.toolResult(executed("body"))).toBeUndefined();
			expect(input).toEqual({ path: "Note.md" });
			// No Vault refresh per tool call: these are the hot path.
			expect(f.reads()).toBe(before);
		} finally { f.host.dispose(); await f.host.closed(); }
	});

	it("does not read the Vault per call even when an extension does subscribe", async () => {
		const f = await fixture(pi => { pi.on("tool_call", () => undefined); pi.on("tool_result", () => undefined); });
		try {
			await f.host.start();
			const before = f.reads();
			await f.host.toolCall(call({ path: "Note.md" }));
			await f.host.toolResult(executed("body"));
			expect(f.reads()).toBe(before);
		} finally { f.host.dispose(); await f.host.closed(); }
	});

	it("refuses a stopped conversation's interception rather than applying it late", async () => {
		let release!: () => void;
		const entered = new Promise<void>(resolve => { release = resolve; });
		let unblock!: () => void;
		const held = new Promise<void>(resolve => { unblock = resolve; });
		const f = await fixture(pi => {
			pi.on("tool_call", async () => { release(); await held; return { block: true, reason: "too late" }; });
		});
		try {
			const pending = f.host.toolCall(call({ path: "Note.md" }));
			await entered;
			f.host.cancelInvocation();
			unblock();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		} finally { unblock(); f.host.dispose(); await f.host.closed(); }
	});

	it("still loads an extension that registers both events", async () => {
		const f = await fixture(pi => { pi.on("tool_call", () => undefined); pi.on("tool_result", () => undefined); });
		try { expect(f.host.tools).toEqual([]); }
		finally { f.host.dispose(); await f.host.closed(); }
	});
});
