import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtensionHost } from "./extensionHost";

const callbacks = { getEntries: () => [], notify: () => {} };

describe("static extension host contract", () => {
	it("rejects unsupported registrations and duplicate command names at load", async () => {
		await expect(createExtensionHost([{ id: "unsupported", factory: pi => { pi.on("before_provider_request", () => {}); } }], callbacks)).rejects.toThrow("extension event before_provider_request");
		const factory = (pi: ExtensionAPI) => pi.registerCommand("duplicate", { handler: async () => {} });
		await expect(createExtensionHost([{ id: "one", factory }, { id: "two", factory }], callbacks)).rejects.toThrow("Duplicate extension command");
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
