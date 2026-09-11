import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
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
		const host = await createExtensionHost([{ id: "unsupported", factory: pi => { pi.on("before_provider_request", () => {}); } }], callbacks);
		try {
			// The handler is not merely uncalled — the extension is not loaded at all,
			// because a filter that never runs makes the extension wrong, not reduced.
			expect(host.hasHandlers("before_provider_request")).toBe(false);
			expect(reportFor(host, "unsupported").error?.message).toContain("extension event before_provider_request");
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
			{ id: "unsupported", factory: pi => { pi.on("before_provider_request", () => {}); } },
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
			pi.on("before_provider_request", () => {});
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

	it("says nothing about an ignored flag, which the extension cannot observe anyway", async () => {
		const host = await createExtensionHost([{ id: "flagged", factory: pi => {
			pi.registerFlag("verbose", { type: "boolean", default: false });
			pi.registerCommand("flagged", { handler: async () => {} });
		} }], callbacks);
		try {
			expect(host.commands.map(command => command.name)).toEqual(["flagged"]);
			expect(host.loadReports).toEqual([]);
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
