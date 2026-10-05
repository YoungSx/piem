import { expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { App } from "obsidian";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { NativeChatSession } from "./NativeChatSession";
import { nativeSessionHeader } from "./nativeSessionData";

class Adapter extends MemoryAdapter {
	failAppend = false;
	beforeRead?: () => Promise<void>;
	override async read(path: string) {
		await this.beforeRead?.();
		return super.read(path);
	}
	override async append(path: string, content: string) {
		if (this.failAppend) throw new Error("Disk full");
		return super.append(path, content);
	}
}

function fixture() {
	const adapter = new Adapter();
	const app = { vault: { adapter, create: async (path: string, content: string) => {
		if (await adapter.exists(path)) throw new Error("Already exists");
		await adapter.write(path, content);
	} } } as unknown as App;
	const faux = fauxProvider({ tokensPerSecond: Infinity });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const options = { models, registry: createRegistry(), env: { cwd: "/" } as ExecutionEnv,
		agent: { model: { provider: model.provider, modelId: model.id } } };
	return { adapter, app, faux, options };
}
const path = "native.jsonl";

test("native host uses official tasks, stable snapshots and read-only reopen", async () => {
	const f = fixture();
	let host = await NativeChatSession.create(f.app, path, f.options);
	try {
		expect(host.getSnapshot()).toBe(host.getSnapshot());
		let changes = 0;
		const unsubscribe = host.subscribe(() => changes++);
		f.faux.setResponses([fauxAssistantMessage("Native response")]);
		const submission = await host.submit("Hello");
		expect(await submission.wait(context)).toMatchObject({ status: "done" });
		expect(host.view.value.entries.some(entry => entry.kind === "pi.assistant")).toBe(true);
		expect(changes).toBeGreaterThan(0);
		unsubscribe();
		await host.close();
		const before = await f.adapter.read(path);
		host = await NativeChatSession.open(f.app, path, f.options);
		expect(host.getSnapshot().paused).toBe(true);
		expect(f.faux.state.callCount).toBe(1);
		expect(await f.adapter.read(path)).toBe(before);
		expect(await host.checkExternalChange()).toBe(false);
	} finally { await host.close(); }
});

test("native host seals on rejected admission without dispatching the model", async () => {
	const f = fixture();
	const host = await NativeChatSession.create(f.app, path, f.options);
	try {
		f.adapter.failAppend = true;
		await expect(host.submit("Do not send")).rejects.toThrow("Disk full");
		expect(host.getSnapshot()).toMatchObject({ closed: true, error: "Disk full" });
		expect(f.faux.state.callCount).toBe(0);
		await expect(host.submit("Again")).rejects.toThrow("Disk full");
	} finally { await host.close(); }
});

test("Stop during preflight prevents admission and leaves the host usable", async () => {
	const f = fixture();
	const host = await NativeChatSession.create(f.app, path, f.options);
	try {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.adapter.beforeRead = async () => { started.resolve(); await release.promise; };
		const submitting = host.submit("Cancelled before admission");
		await started.promise;
		await host.abort();
		f.adapter.beforeRead = undefined;
		release.resolve();
		await expect(submitting).rejects.toThrow();
		expect(host.view.value.entries.filter(entry => entry.kind === "pi.user")).toHaveLength(0);
		expect(f.faux.state.callCount).toBe(0);
		expect(host.getSnapshot().closed).toBe(false);
		f.faux.setResponses([fauxAssistantMessage("OK")]);
		await (await host.submit("Fresh input")).wait(context);
		expect(f.faux.state.callCount).toBe(1);
	} finally { await host.close(); }
});

test("external drift closes the host without rewriting the foreign bytes", async () => {
	const f = fixture();
	const host = await NativeChatSession.create(f.app, path, f.options);
	try {
		const external = `${await f.adapter.read(path)}foreign bytes`;
		await f.adapter.write(path, external);
		expect(await host.checkExternalChange()).toBe(true);
		expect(host.getSnapshot().closed).toBe(true);
		await expect(host.submit("No overwrite")).rejects.toThrow("changed on disk");
		expect(await f.adapter.read(path)).toBe(external);
		expect(f.faux.state.callCount).toBe(0);
	} finally { await host.close(); }
});

test("open refuses missing root and partial commit without repairing the source", async () => {
	const f = fixture();
	const header = nativeSessionHeader({ id: "empty", cwd: "/", createdAt: 1, storageVersion: 1 });
	await f.adapter.write(path, header);
	await expect(NativeChatSession.open(f.app, path, f.options)).rejects.toThrow("no root");
	expect(await f.adapter.read(path)).toBe(header);
	await f.adapter.write(path, `${header}{`);
	await expect(NativeChatSession.open(f.app, path, f.options)).rejects.toThrow("needs recovery");
	expect(await f.adapter.read(path)).toBe(`${header}{`);
});

async function toolFixture() {
	const f = fixture();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let writes = 0;
	f.options.registry.install(defineExtension({ name: "test-vault", tools: [defineTool({
		name: "write_note", description: "Write a note", parameters: Type.Object({}), replay: "unsafe",
		execute: async (_args, _api, callContext) => {
			writes++;
			await f.adapter.write("note.md", "Written once");
			started.resolve();
			const abort = () => release.resolve();
			callContext.abortSignal?.addEventListener("abort", abort, { once: true });
			try { await release.promise; }
			finally { callContext.abortSignal?.removeEventListener("abort", abort); }
			return { content: [{ type: "text" as const, text: "Saved" }] };
		},
	})] }));
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("write_note", {}), { stopReason: "toolUse" })]);
	const host = await NativeChatSession.create(f.app, path, f.options);
	return { ...f, host, started, release, writes: () => writes };
}

test("close preserves native recovery and unsafe tool side effects never replay", async () => {
	const f = await toolFixture();
	let reopened: NativeChatSession | undefined;
	try {
		await f.host.submit("Write");
		await f.started.promise;
		const cut = await f.adapter.read(path);
		await f.host.close();
		await f.adapter.write("copy.jsonl", cut);
		reopened = await NativeChatSession.open(f.app, "copy.jsonl", f.options);
		expect(f.faux.state.callCount).toBe(1);
		expect(reopened.getSnapshot().paused).toBe(true);
		f.faux.setResponses([fauxAssistantMessage("Recovered")]);
		await reopened.resume();
		await reopened.conversation.waitForIdle(context);
		expect(f.writes()).toBe(1);
		expect(JSON.stringify(reopened.view.value.entries)).toContain("interrupted");
	} finally { f.release.resolve(); await f.host.close(); await reopened?.close(); }
});

test("failure saving a tool result closes before another provider request", async () => {
	const f = await toolFixture();
	try {
		await f.host.submit("Write");
		await f.started.promise;
		const closed = Promise.withResolvers<void>();
		const unsubscribe = f.host.subscribe(() => { if (f.host.getSnapshot().closed) closed.resolve(); });
		f.adapter.failAppend = true;
		f.release.resolve();
		await closed.promise;
		unsubscribe();
		await f.host.close();
		expect(f.host.getSnapshot().error).toBe("Disk full");
		expect(f.faux.state.callCount).toBe(1);
		expect(f.writes()).toBe(1);
	} finally { f.release.resolve(); await f.host.close(); }
});

test("own commits during external-change reads do not close the host", async () => {
	const f = fixture();
	const host = await NativeChatSession.create(f.app, path, f.options);
	try {
		const captured = await f.adapter.read(path);
		const originalRead = f.adapter.read.bind(f.adapter);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let first = true;
		f.adapter.read = async file => {
			if (first) { first = false; started.resolve(); await release.promise; return captured; }
			return originalRead(file);
		};
		const checking = host.checkExternalChange();
		await started.promise;
		await host.configure({ cwd: "/Notes" });
		release.resolve();
		expect(await checking).toBe(false);
		expect(host.getSnapshot().closed).toBe(false);
		expect(await host.checkExternalChange()).toBe(false);
	} finally { await host.close(); }
});

test("viewing a running native file leaves its bytes and original writer untouched", async () => {
	const f = await toolFixture();
	let viewer: NativeChatSession | undefined;
	try {
		await f.host.submit("Write");
		await f.started.promise;
		const before = await f.adapter.read(path);
		viewer = await NativeChatSession.open(f.app, path, f.options);
		expect(await f.adapter.read(path)).toBe(before);
		expect(await f.host.checkExternalChange()).toBe(false);
		f.faux.setResponses([fauxAssistantMessage("Complete")]);
		f.release.resolve();
		await f.host.conversation.waitForIdle(context);
		expect(f.host.getSnapshot().closed).toBe(false);
		expect(f.faux.state.callCount).toBe(2);
		await expect(viewer.resume()).rejects.toThrow("changed on disk");
		expect(viewer.getSnapshot().closed).toBe(true);
	} finally { f.release.resolve(); await f.host.close(); await viewer?.close(); }
});

for (const action of ["stop", "close"] as const) {
	test(`${action} during activation prevents pending input from being accepted`, async () => {
		const f = fixture();
		const created = await NativeChatSession.create(f.app, path, f.options);
		await created.close();
		const host = await NativeChatSession.open(f.app, path, f.options);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let reads = 0;
		f.adapter.beforeRead = async () => { if (++reads === 2) { started.resolve(); await release.promise; } };
		try {
			const submitting = host.submit("Must not be accepted");
			const outcome = submitting.then(() => "accepted", () => "rejected");
			await started.promise;
			const stopping = action === "stop" ? host.abort() : host.close();
			f.adapter.beforeRead = undefined;
			release.resolve();
			await stopping;
			expect(await outcome).toBe("rejected");
			expect(host.view.value.entries.filter(entry => entry.kind === "pi.user")).toHaveLength(0);
			expect(f.faux.state.callCount).toBe(0);
			expect(host.getSnapshot().closed).toBe(action === "close");
		} finally { release.resolve(); f.adapter.beforeRead = undefined; await host.close(); }
	});
}
