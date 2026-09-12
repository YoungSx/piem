import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createExtensionHost } from "./extensionHost";

const callbacks = { getEntries: () => [], notify: () => {} };

/** One report per rejected or reduced extension, keyed by id for readable assertions. */
function reportFor(host: { loadReports: readonly { id: string; error?: Error; ignored: string[] }[] }, id: string) {
	const report = host.loadReports.find(candidate => candidate.id === id);
	if (!report) throw new Error(`No load report for ${id}: ${host.loadReports.map(r => r.id).join(", ") || "none"}`);
	return report;
}

describe("static extension host contract", () => {
	it("skips an extension registering an unsupported event without failing the host", async () => {
		const host = await createExtensionHost([{ id: "unsupported", factory: pi => { pi.on("before_provider_headers", () => {}); } }], callbacks);
		try {
			// The handler is not merely uncalled — the extension is not loaded at all,
			// because a filter that never runs makes the extension wrong, not reduced.
			expect(host.hasHandlers("before_provider_headers")).toBe(false);
			expect(reportFor(host, "unsupported").error?.message).toContain("extension event before_provider_headers");
		} finally { host.dispose(); }
	});

	it("skips the loser of a duplicate command name and keeps the winner runnable", async () => {
		let ran = 0;
		const factory = (pi: ExtensionAPI) => pi.registerCommand("duplicate", { handler: async () => { ran++; } });
		const host = await createExtensionHost([{ id: "one", factory }, { id: "two", factory }], callbacks);
		try {
			expect(host.commands.map(command => command.name)).toEqual(["duplicate"]);
			expect(host.loadReports.map(report => report.id)).toEqual(["two"]);
			expect(reportFor(host, "two").error?.message).toContain("Duplicate extension command");
			await host.run("duplicate");
			expect(ran).toBe(1);
		} finally { host.dispose(); }
	});

	it("loads the extensions after a rejected one instead of taking the host down with it", async () => {
		let ran = 0;
		const host = await createExtensionHost([
			{ id: "unsupported", factory: pi => { pi.on("before_provider_headers", () => {}); } },
			{ id: "working", factory: pi => pi.registerCommand("later", { handler: async () => { ran++; } }) },
		], callbacks);
		try {
			expect(host.commands.map(command => command.name)).toEqual(["later"]);
			await host.run("later");
			expect(ran).toBe(1);
			expect(host.loadReports).toHaveLength(1);
			expect(reportFor(host, "unsupported").error).toBeInstanceOf(Error);
		} finally { host.dispose(); }
	});

	it("reports a factory that throws and still loads the rest", async () => {
		const host = await createExtensionHost([
			{ id: "broken", factory: () => { throw new Error("factory exploded"); } },
			{ id: "working", factory: pi => pi.registerCommand("survivor", { handler: async () => {} }) },
		], callbacks);
		try {
			expect(host.commands.map(command => command.name)).toEqual(["survivor"]);
			expect(host.loadReports.map(report => report.id)).toEqual(["broken"]);
			expect(reportFor(host, "broken").error?.message).toContain("factory exploded");
		} finally { host.dispose(); }
	});

	it("releases a rejected extension's event subscriptions and flag defaults from shared state", async () => {
		let heard = 0;
		let survivor: ExtensionAPI | undefined;
		const rejected: ExtensionFactory = pi => {
			// Committed by Pi's loader before our validation rejects the extension:
			// the subscription is live and the flag default is in shared state.
			pi.events.on("tick", () => { heard++; });
			pi.registerFlag("verbose", { type: "boolean", default: true });
			pi.on("before_provider_headers", () => {});
		};
		const host = await createExtensionHost([
			{ id: "rejected", factory: rejected },
			{ id: "survivor", factory: pi => { survivor = pi; pi.registerFlag("verbose", { type: "boolean" }); } },
		], callbacks);
		try {
			expect(reportFor(host, "rejected").error).toBeInstanceOf(Error);
			// Emitted through a loaded extension, on the bus the rejected one subscribed to.
			survivor!.events.emit("tick", undefined);
			expect(heard).toBe(0);
			// Pi's contract for an unregistered flag, which is what the survivor must see.
			expect(survivor!.getFlag("verbose")).toBeUndefined();
		} finally { host.dispose(); }
	});

	it("retires one observer without skipping peers in an event already being dispatched", async () => {
		let enter!: () => void, release!: () => void;
		const entered = new Promise<void>(resolve => { enter = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const seen: string[] = [];
		let retiredEvents = 0, peerEvents = 0, peer: ExtensionAPI | undefined;
		const host = await createExtensionHost([
			{ id: "observer", factory: pi => {
				pi.events.on("tick", () => { retiredEvents++; });
				pi.on("before_agent_start", () => {});
				pi.on("agent_start", async () => { seen.push("observer"); enter(); await gate; });
				pi.on("agent_start", () => { seen.push("retired second handler"); });
			} },
			{ id: "peer", factory: pi => {
				peer = pi;
				pi.registerFlag("later", { type: "boolean", default: true });
				pi.events.on("tick", () => { peerEvents++; });
				pi.on("agent_start", () => { seen.push("peer"); });
				pi.registerCommand("still-running", { handler: async () => { seen.push("command"); } });
			} },
		], callbacks);
		try {
			expect(host.hasBeforeAgentStart).toBe(true);
			peer!.events.emit("tick", undefined);
			const dispatch = host.emitAgentEvent({ type: "agent_start" });
			await entered;
			host.removeObserver("observer"); host.removeObserver("observer");
			expect(host.hasBeforeAgentStart).toBe(false);
			release(); await dispatch;
			await host.emitAgentEvent({ type: "agent_start" });
			await host.run("still-running");
			peer!.events.emit("tick", undefined);
			expect(seen).toEqual(["observer", "peer", "peer", "command"]);
			expect(retiredEvents).toBe(1); expect(peerEvents).toBe(2);
			expect(peer!.getFlag("later")).toBe(true);
		} finally { release(); host.dispose(); }
	});

	it("refuses observer retirement for every non-event registration surface", async () => {
		const registrations: ExtensionFactory[] = [
			pi => pi.registerCommand("command", { handler: async () => {} }),
			pi => pi.registerTool({ name: "tool", label: "Tool", description: "Fixture", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }),
			pi => pi.registerShortcut("ctrl+k", { handler: () => {} }),
			pi => pi.registerFlag("flag", { type: "boolean", default: true }),
			pi => pi.registerMessageRenderer("message", () => undefined),
			pi => pi.registerEntryRenderer("entry", () => undefined),
			pi => pi.registerMarkdownTransformer(markdown => markdown),
		];
		for (const register of registrations) {
			let observed = 0;
			const host = await createExtensionHost([{ id: "mixed", factory: async pi => {
				await register(pi); pi.on("agent_start", () => { observed++; });
			} }], callbacks);
			try {
				expect(host.loadReports.every(report => !report.error)).toBe(true);
				expect(() => host.removeObserver("mixed")).toThrow("Only event-only extensions");
				await host.emitAgentEvent({ type: "agent_start" });
				expect(observed).toBe(1);
			} finally { host.dispose(); }
		}
	});

	it("loads an extension registering renderers and records what is never consulted", async () => {
		const host = await createExtensionHost([{ id: "renderer", factory: pi => {
			pi.registerMessageRenderer("custom", () => undefined);
			pi.registerEntryRenderer("custom", () => undefined);
			pi.registerMarkdownTransformer(markdown => markdown);
			pi.registerCommand("still-here", { handler: async () => {} });
		} }], callbacks);
		try {
			// Loaded, not skipped: everything else the extension registered works.
			expect(host.commands.map(command => command.name)).toEqual(["still-here"]);
			const report = reportFor(host, "renderer");
			expect(report.error).toBeUndefined();
			expect(report.ignored).toEqual(["message renderers", "entry renderers", "markdown transformer"]);
		} finally { host.dispose(); }
	});

	it("preserves registered flag defaults without reporting a degraded capability", async () => {
		let values: unknown[] = [];
		const host = await createExtensionHost([{ id: "flagged", factory: pi => {
			pi.registerFlag("verbose", { type: "boolean", default: true });
			pi.registerFlag("mode", { type: "string", default: "review" });
			pi.registerFlag("unset", { type: "boolean" });
			pi.registerCommand("flagged", { handler: async () => { values = [pi.getFlag("verbose"), pi.getFlag("mode"), pi.getFlag("unset"), pi.getFlag("unknown")]; } });
		} }], callbacks);
		try {
			expect(host.commands.map(command => command.name)).toEqual(["flagged"]);
			expect(host.loadReports).toEqual([]);
			await host.run("flagged");
			expect(values).toEqual([true, "review", undefined, undefined]);
		} finally { host.dispose(); }
	});

	it("keeps a failing context filter from silently forwarding unfiltered messages", async () => {
		const host = await createExtensionHost([{ id: "failure", factory: pi => { pi.on("context", () => { throw new Error("filter failed"); }); } }], callbacks);
		try { await expect(host.transformContext([])).rejects.toThrow("filter failed"); }
		finally { host.dispose(); }
	});

	it("invalidates captured commands, event subscriptions and capabilities on disposal", async () => {
		let captured: ExtensionAPI | undefined;
		let heard = 0;
		const host = await createExtensionHost([{ id: "subscriber", factory: pi => {
			captured = pi;
			pi.events.on("tick", () => { heard++; });
			pi.registerCommand("read", { handler: async (_args, ctx) => { ctx.sessionManager.getEntries(); } });
		} }], callbacks);
		captured!.events.emit("tick", undefined);
		expect(heard).toBe(1);
		await host.run("read");
		host.dispose();
		host.dispose();
		await expect(host.run("read")).rejects.toThrow("disposed");
		expect(() => captured!.events.emit("tick", undefined)).toThrow();
		expect(heard).toBe(1);
	});
});
