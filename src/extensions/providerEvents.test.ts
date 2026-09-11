import { describe, expect, it } from "bun:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createExtensionHost } from "./extensionHost";
import { extensionCompactionEntry } from "./extensionEvents";

async function fixture(factory: ExtensionFactory) {
	let reads = 0;
	const host = await createExtensionHost([{ id: "provider-events", factory }], {
		getEntries: () => [], notify: () => {}, refreshSession: async () => { reads++; },
		getSessionId: () => "owner", getThinkingLevel: () => "off",
	});
	return { host, reads: () => reads };
}

describe("provider event bridge", () => {
	it("chains native payload mutations and replacements without sharing outgoing objects", async () => {
		let retained: { field: string } | undefined;
		const f = await fixture(pi => {
			pi.on("before_provider_request", event => {
				const payload = event.payload as { field: string };
				payload.field += "-mutated";
				return { ...payload, field: `${payload.field}-replaced` };
			});
			pi.on("before_provider_request", event => { retained = event.payload as { field: string }; });
		});
		try {
			const original = { field: "body" };
			const result = await f.host.beforeProviderRequest(original);
			expect(result).toEqual({ field: "body-mutated-replaced" });
			expect(original).toEqual({ field: "body" });
			retained!.field = "too late";
			expect(result).toEqual({ field: "body-mutated-replaced" });
			expect(f.reads()).toBe(1);
		} finally { f.host.dispose(); }
	});

	it("projects response metadata without sharing headers or carrying request secrets", async () => {
		const seen: unknown[] = [];
		const f = await fixture(pi => { pi.on("after_provider_response", event => {
			seen.push(structuredClone(event));
			event.headers["request-id"] = "mutated";
		}); });
		try {
			const response = { status: 200, headers: { "request-id": "server-id" }, apiKey: "not-for-extensions" };
			await f.host.afterProviderResponse(response);
			expect(seen).toEqual([{ type: "after_provider_response", status: 200, headers: { "request-id": "server-id" } }]);
			expect(response.headers["request-id"]).toBe("server-id");
			expect(f.reads()).toBe(1);
		} finally { f.host.dispose(); }
	});

	it("does no refresh or payload cloning when no handler subscribes", async () => {
		const f = await fixture(() => {});
		try {
			expect(await f.host.beforeProviderRequest(() => "not cloneable")).toBeUndefined();
			await f.host.afterProviderResponse({ status: 200, headers: {} });
			expect(f.reads()).toBe(0);
		} finally { f.host.dispose(); }
	});

	it.each(["before_provider_request", "after_provider_response"] as const)("surfaces a failing %s handler", async event => {
		const f = await fixture(pi => {
			const fail = () => { throw new Error("Provider handler failed"); };
			if (event === "before_provider_request") pi.on("before_provider_request", fail);
			else pi.on("after_provider_response", fail);
		});
		try {
			const work = event === "before_provider_request" ? f.host.beforeProviderRequest({}) : f.host.afterProviderResponse({ status: 200, headers: {} });
			await expect(work).rejects.toThrow("Provider handler failed");
		} finally { f.host.dispose(); }
	});

	it("revokes a cancelled payload callback before another handler can run", async () => {
		const entered = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		let later = 0;
		let staleRead: (() => string) | undefined;
		const f = await fixture(pi => {
			pi.on("before_provider_request", async (_event, ctx) => {
				staleRead = () => ctx.sessionManager.getSessionId();
				entered.resolve();
				await held.promise;
				return { late: true };
			});
			pi.on("before_provider_request", () => { later++; });
		});
		try {
			const work = f.host.beforeProviderRequest({});
			await entered.promise;
			f.host.cancel();
			await expect(work).rejects.toMatchObject({ name: "AbortError" });
			expect(staleRead).toThrow();
			held.resolve();
			await Promise.resolve();
			expect(later).toBe(0);
		} finally { held.resolve(); f.host.dispose(); }
	});

	it("exposes saved compaction data and explicitly refuses a CLI-only cursor", () => {
		const entry = extensionCompactionEntry({ type: "compaction", id: "saved-id", parentId: "parent", seq: 3,
			timestamp: 0, summary: "Summary", tokensBefore: 100, retainedTail: [] });
		expect(JSON.parse(JSON.stringify(entry))).toEqual({ type: "compaction", id: "saved-id", parentId: "parent", seq: 3,
			timestamp: "1970-01-01T00:00:00.000Z", summary: "Summary", tokensBefore: 100, retainedTail: [] });
		expect(() => entry.firstKeptEntryId).toThrow("CLI compaction cursors");
	});
});
