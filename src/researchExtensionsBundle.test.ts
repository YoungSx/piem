import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PiemSettings } from "./settings";
import { installDom } from "./testUtils/dom";
import { deferred, researchFixture, waitForResearch } from "./testUtils/researchExtensionBundleFixture";
import { SOURCE, SEARCH_TEXT } from "../scripts/smoke-research-extensions-fixtures.mjs";

installDom();
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
const textOf = (message: AgentMessage | undefined) => message && "content" in message
	? typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";

async function seededCheckpoint() {
	const f = await researchFixture({ protocol: "openai-completions", plan: { chat: [{ text: "Keep these original notes." }] } }, cleanup);
	await f.service.sendPrompt("Preserve the original notes");
	await f.idle();
	f.setPlan({ chat: [{ tool: { name: "context_checkpoint", args: { name: "verified-notes" } } }, { text: "The notes have a checkpoint." }] });
	await f.service.sendPrompt("Save this stage");
	await f.idle();
	return f;
}

describe("shipped research extensions in a permanently Node-free mobile realm", () => {
	it("uses native Responses search, configured credentials, and provider citations without Node or dynamic code", async () => {
		const f = await researchFixture({ plan: { chat: [{ tool: { name: "web_search", args: { query: "Obsidian plugins vault" } } }, { text: "The cited documentation explains vault access." }], search: {} } }, cleanup);
		expect(await f.service.sendPrompt("Find the official vault documentation")).toBe(true);
		await f.idle();
		const search = f.requests.filter(request => request.kind === "search");
		expect(search).toHaveLength(1);
		expect(search[0]!.url).toBe("https://research.test/v1/responses");
		expect(search[0]!.headers.authorization).toBe("Bearer research-fixture-key");
		expect(search[0]!.body.tools).toContainEqual({ type: "web_search" });
		const result = f.service.getSnapshot().messages.find(message => message.role === "toolResult" && message.toolName === "web_search");
		expect(textOf(result)).toContain(SEARCH_TEXT);
		expect(textOf(result)).toContain(SOURCE.url);
		const tools = f.requests.find(request => request.kind === "chat")!.body.tools!.map(tool => tool.name ?? tool.function?.name);
		for (const name of ["web_search", "context_checkpoint", "context_timeline", "context_compact", "switch_model"]) expect(tools).toContain(name);
		expect(tools).not.toContain("url_context");
		expect(new Set(f.required)).toEqual(new Set(["obsidian"]));
		expect(f.dynamic).toEqual([]);
		expect(await f.realm.evaluate("Promise.resolve().then(() => [typeof process, typeof Buffer, typeof globalThis.require, typeof window.process, typeof Bun])")).toEqual(Array(5).fill("undefined"));
	});

	it("reports search authentication failure without fabricated sources or a retry", async () => {
		const f = await researchFixture({ plan: { chat: [{ tool: { name: "web_search", args: { query: "Authentication failure" } } }, { text: "The search provider rejected the credential." }], search: { error: 401 } } }, cleanup);
		await f.service.sendPrompt("Search using an invalid credential");
		await f.idle();
		const result = f.service.getSnapshot().messages.find(message => message.role === "toolResult" && message.toolName === "web_search");
		expect(textOf(result)).toContain("401");
		if (result?.role !== "toolResult") throw new Error("Search did not return a tool result");
		expect(result.isError).toBe(true);
		expect(textOf(result)).not.toContain(SOURCE.url);
		expect(JSON.stringify(result)).not.toContain("research-fixture-key");
		expect(f.requests.filter(request => request.kind === "search")).toHaveLength(1);
	});

	it("leaves unsupported Completions search with its configured provider", async () => {
		const f = await researchFixture({ protocol: "openai-completions", plan: { chat: [{ tool: { name: "web_search", args: { query: "Do not switch providers" } } }, { text: "This provider protocol does not support native search." }] } }, cleanup);
		await f.service.sendPrompt("Search with this provider");
		await f.idle();
		const result = f.service.getSnapshot().messages.find(message => message.role === "toolResult" && message.toolName === "web_search");
		expect(textOf(result)).toMatch(/unsupported|does not support/i);
		expect(f.requests.filter(request => request.kind === "search")).toEqual([]);
		expect(f.requests.every(request => request.url === "https://research.test/v1/chat/completions")).toBe(true);
	});

	it("rewrites into the captured draft, strips the input marker, and restores a pinned model from saved settings", async () => {
		const rewritten = "Summarize Friday's meeting and list its action items.";
		const f = await researchFixture({ plan: { clarify: { text: rewritten } } }, cleanup);
		const path = f.service.getActiveSessionPath();
		let draft = "Please sort my meeting notes";
		cleanup.push(f.bindEditor(path, { read: () => draft, replace: text => { draft = text; } }));
		await f.idle(path);
		expect(f.service.isExtensionInput("/clarify")).toBe(true);
		expect(f.service.isExtensionInput("Make these notes clearer -clarify")).toBe(true);
		expect(f.service.isExtensionInput("Make these notes clearer -CLARIFY")).toBe(true);
		expect(f.service.isExtensionInput("Make these notes clearer -clarify, keep the links")).toBe(true);
		expect(await f.service.runExtensionCommand("clarify")).toBe(true);
		await f.idle();
		expect(draft).toBe(rewritten);
		expect(JSON.stringify(f.requests[0]!.body)).toContain("Please sort my meeting notes");
		expect(f.requests[0]!.headers.authorization).toBe("Bearer research-fixture-key");
		expect(f.service.getSnapshot().messages).toEqual([]);
		expect(f.requests.filter(request => request.kind === "chat")).toEqual([]);
		expect(await f.service.sendPrompt("Summarize next week's agenda -clarify")).toBe(true);
		await f.idle();
		expect(JSON.stringify(f.requests.at(-1)!.body)).not.toContain("-clarify");
		expect(f.service.getSnapshot().messages).toEqual([]);
		for (const input of ["Summarize the agenda -CLARIFY", "Summarize the agenda -clarify, keep the links"]) {
			expect(await f.service.sendPrompt(input)).toBe(true);
			await f.idle();
			expect(JSON.stringify(f.requests.at(-1)!.body).toLowerCase()).not.toContain("-clarify");
			expect(f.service.getSnapshot().messages).toEqual([]);
		}
		expect(await f.service.runExtensionCommand("clarify", "model research beta")).toBe(true);
		expect(f.plugin.settings.clarifyModelId).toBe("beta");
		const saved = structuredClone(f.record.savedData.at(-1)) as PiemSettings;
		expect(saved.clarifyModelId).toBe("beta");
		f.unload();
		const restored = await researchFixture({ memory: f.memory, settings: saved, plan: { clarify: { text: "Ready after reload." } } }, cleanup);
		// The chat never spoke a message, so it was never written: one that only
		// ever rewrote its own draft leaves no file, and the reload opens a fresh
		// blank sheet instead. The clarify pin lives in settings rather than in the
		// conversation, so it carries over — which is what the rest of this test
		// exercises.
		await restored.service.openSession(path);
		expect(restored.service.getActiveSessionPath()).not.toBe(path);
		const restoredPath = restored.service.getActiveSessionPath()!;
		let restoredDraft = "Keep me in this conversation";
		cleanup.push(restored.bindEditor(restoredPath, { read: () => restoredDraft, replace: text => { restoredDraft = text; } }));
		await restored.idle(restoredPath);
		expect(await restored.service.runExtensionCommand("clarify")).toBe(true);
		await restored.idle();
		expect(restoredDraft).toBe("Ready after reload.");
		expect(restored.requests.filter(request => request.kind === "clarify").map(request => request.body.model)).toEqual(["beta"]);
		expect(restored.plugin.settings.activeModelId).toBe("alpha");
		expect(await restored.service.runExtensionCommand("clarify", "model reset")).toBe(true);
		expect(restored.plugin.settings.clarifyModelId).toBeUndefined();
	});

	it("keeps a newer draft when an earlier rewrite finally arrives", async () => {
		const entered = deferred(), gate = deferred();
		cleanup.push(gate.resolve);
		const f = await researchFixture({ plan: { clarify: { text: "Late rewrite" } }, beforeResponse: async request => {
			if (request.kind === "clarify") { entered.resolve(); await gate.promise; }
		} }, cleanup);
		let draft = "Original draft";
		cleanup.push(f.bindEditor(f.service.getActiveSessionPath(), { read: () => draft, replace: text => { draft = text; } }));
		await f.idle();
		const rewriting = f.service.runExtensionCommand("clarify");
		await entered.promise;
		draft = "New words typed while waiting";
		gate.resolve();
		expect(await rewriting).toBe(false);
		await f.idle();
		expect(draft).toBe("New words typed while waiting");
		expect(f.service.getSnapshot().errorMessage).toContain("draft changed");
		expect(f.service.getSnapshot().errorMessage).toContain("Late rewrite");
		expect(f.requests.filter(request => request.kind === "chat")).toEqual([]);
	});

	for (const action of ["stop", "unload"] as const) {
		it(`discards an in-flight rewrite after ${action} without a late conversation request`, async () => {
			const entered = deferred(), gate = deferred();
			cleanup.push(gate.resolve);
			const f = await researchFixture({ plan: { clarify: { text: "Stale result" } }, beforeResponse: async request => {
				if (request.kind === "clarify") { entered.resolve(); await gate.promise; }
			} }, cleanup);
			const path = f.service.getActiveSessionPath();
			let draft = "Keep this draft";
			cleanup.push(f.bindEditor(path, { read: () => draft, replace: text => { draft = text; } }));
		await f.idle(path);
			const rewriting = f.service.runExtensionCommand("clarify");
			await entered.promise;
			const stopping = action === "stop" ? f.service.abortSession(path) : Promise.resolve(f.unload());
			gate.resolve();
			await stopping;
			expect(await rewriting).toBe(false);
			if (action === "stop") await f.idle();
			expect(draft).toBe("Keep this draft");
			expect(f.requests.filter(request => request.kind === "chat")).toEqual([]);
		});
	}

	it("can run context tools again after a stopped rewrite rebuilt its extension host", async () => {
		const entered = deferred(), gate = deferred();
		cleanup.push(gate.resolve);
		const f = await researchFixture({ plan: { clarify: { text: "Discard this rewrite" } }, beforeResponse: async request => {
			if (request.kind === "clarify") { entered.resolve(); await gate.promise; }
		} }, cleanup);
		const path = f.service.getActiveSessionPath();
		cleanup.push(f.bindEditor(path, { read: () => "Keep my draft", replace: () => {} }));
		await f.idle(path);
		const rewriting = f.service.runExtensionCommand("clarify");
		await entered.promise;
		await f.service.abortSession(path);
		gate.resolve();
		expect(await rewriting).toBe(false);
		await f.idle();
		f.setPlan({ chat: [{ tool: { name: "context_checkpoint", args: { name: "after-stop" } } }, { text: "Checkpoint saved after stopping." }] });
		await f.service.sendPrompt("Save a checkpoint now");
		await f.idle();
		const result = f.service.getSnapshot().messages.find(message => message.role === "toolResult" && message.toolName === "context_checkpoint");
		expect(textOf(result)).toContain("Created checkpoint 'after-stop'");
		expect((await f.plugin.sessionManager.getSessionFor(path).getLog()).some(item => item.kind === "fact" && item.fact === "label" && item.label === "after-stop")).toBe(true);
	});

	it("retains the request slot after stop until the native rewrite request finishes", async () => {
		const entered = deferred(), gate = deferred();
		cleanup.push(gate.resolve);
		const f = await researchFixture({ plan: { clarify: { text: "Late reply" } }, beforeResponse: async request => {
			if (request.kind === "clarify") { entered.resolve(); await gate.promise; }
		} }, cleanup);
		const path = f.service.getActiveSessionPath();
		cleanup.push(f.bindEditor(path, { read: () => "Keep this draft", replace: () => {} }));
		await f.idle();
		const rewrite = f.service.runExtensionCommand("clarify");
		await entered.promise;
		await f.service.abortSession(path);
		expect(await rewrite).toBe(false);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(f.service.getSnapshot().isExtensionBusy).toBe(true);
		expect(await f.service.runExtensionCommand("clarify")).toBe(false);
		expect(f.requests.filter(request => request.kind === "clarify")).toHaveLength(1);
		gate.resolve();
		await f.idle();
	});

	it("persists checkpoints and timeline, then resumes a summary branch while retaining old history", async () => {
		const f = await researchFixture({ protocol: "openai-completions", plan: { chat: [{ text: "The sources are verified." }] } }, cleanup);
		await f.service.sendPrompt("Review the sources");
		await f.idle();
		const path = f.service.getActiveSessionPath();
		const session = () => f.plugin.sessionManager.getSessionFor(path);
		const checkpoint = "sources-verified", summary = "Sources checked. Next step: write a short cited report.";
		const call = async (name: string, args: Record<string, unknown>) => {
			f.setPlan({ chat: [{ tool: { name, args } }, { text: "Done." }] });
			await f.service.sendPrompt(`Run ${name}`);
			await f.idle();
			return f.service.getSnapshot().messages.filter(message => message.role === "toolResult" && message.toolName === name).at(-1);
		};
		expect(textOf(await call("context_checkpoint", { name: checkpoint }))).toContain(`Created checkpoint '${checkpoint}'`);
		const saved = (await session().getLog()).find(item => item.kind === "fact" && item.fact === "label" && item.label === checkpoint);
		expect(saved?.kind).toBe("fact");
		if (saved?.kind !== "fact" || saved.fact !== "label") throw new Error("Checkpoint was not saved as a label fact");
		const timeline = textOf(await call("context_timeline", { limit: 20 }));
		expect(timeline).toContain(checkpoint);
		expect(timeline).toContain("HEAD");
		expect(timeline).toContain(saved.targetId);
		const originalIds = (await session().getLog()).flatMap(item => item.kind === "entry" ? [item.entry.id] : []);
		f.setPlan({ chat: [{ tool: { name: "context_compact", args: { target: checkpoint, summary, backupCheckpoint: "before-summary" } } }, { text: "Writing the report from the saved summary." }] });
		const before = f.requests.length;
		await f.service.sendPrompt("Make a handoff summary and continue");
		await waitForResearch(() => f.requests.slice(before).filter(request => request.kind === "chat").length === 2, "context continuation request");
		await f.idle();
		const log = await session().getLog();
		const branch = log.find(item => item.kind === "entry" && item.entry.type === "branch_summary" && item.entry.summary.includes(summary));
		if (branch?.kind !== "entry" || branch.entry.type !== "branch_summary") {
			throw new Error(`Summary was not persisted: ${JSON.stringify(f.service.getSnapshot().messages.filter(message => message.role === "custom"))}`);
		}
		expect(branch.entry.parentId).toBe(saved.targetId);
		expect(originalIds.every(id => log.some(item => item.kind === "entry" && item.entry.id === id))).toBe(true);
		expect(log.some(item => item.kind === "fact" && item.fact === "label" && item.label === "before-summary")).toBe(true);
		const continued = f.requests.slice(before).filter(request => request.kind === "chat").at(-1)!;
		expect(JSON.stringify(continued.body)).toContain(summary);
		expect(JSON.stringify(continued.body)).not.toContain('"/acm"');
		const active = await f.plugin.sessionManager.buildSessionContextFor(path);
		expect(active.messages.some(message => message.role === "custom" && message.customType === "pi-context" && message.display === false)).toBe(true);
		const settings = structuredClone(f.plugin.settings);
		f.unload();
		const restored = await researchFixture({ memory: f.memory, settings }, cleanup);
		await restored.service.openSession(path);
		await restored.idle();
		const restoredLog = await restored.plugin.sessionManager.getSessionFor(path).getLog();
		expect(restoredLog.some(item => item.kind === "entry" && item.entry.id === branch.entry.id)).toBe(true);
		expect(restoredLog.some(item => item.kind === "fact" && item.fact === "label" && item.label === checkpoint && item.targetId === saved.targetId)).toBe(true);
	});

	it("does not persist a checkpoint or summary against an unknown target", async () => {
		const f = await researchFixture({ protocol: "openai-completions", plan: { chat: [{ tool: { name: "context_checkpoint", args: { name: "invalid-anchor", target: "missing-entry" } } }, { text: "That history entry does not exist." }] } }, cleanup);
		await f.service.sendPrompt("Label an unknown entry");
		await f.idle();
		const path = f.service.getActiveSessionPath(), session = f.plugin.sessionManager.getSessionFor(path);
		const result = f.service.getSnapshot().messages.find(message => message.role === "toolResult" && message.toolName === "context_checkpoint");
		expect(textOf(result)).toContain("Unknown context entry");
		expect((await session.getLog()).some(item => item.kind === "fact" && item.fact === "label" && item.label === "invalid-anchor")).toBe(false);
		f.setPlan({ chat: [{ tool: { name: "context_compact", args: { target: "missing-entry", summary: "This must not become a summary." } } }, { text: "No summary was applied." }] });
		await f.service.sendPrompt("Compact to the missing entry");
		await waitForResearch(() => f.requests.filter(request => request.kind === "chat").length === 4, "unknown-target result");
		await f.idle();
		expect((await session.getLog()).some(item => item.kind === "entry" && item.entry.type === "branch_summary")).toBe(false);
		const failedCompact = f.service.getSnapshot().messages.filter(message => message.role === "custom" && message.customType === "pi-context").at(-1);
		expect(textOf(failedCompact)).toContain("Unknown context entry");
	});

	it("does not acknowledge an unsaved checkpoint when Vault rejects its label write", async () => {
		const f = await researchFixture({ protocol: "openai-completions", plan: { chat: [{ tool: { name: "context_checkpoint", args: { name: "unsaved-checkpoint" } } }, { text: "The checkpoint could not be saved." }] } }, cleanup);
		const append = f.memory.append.bind(f.memory);
		f.memory.append = async (path, value) => {
			if (value.includes('"fact":"label"')) throw new Error("Fixture Vault is read only");
			await append(path, value);
		};
		await f.service.sendPrompt("Save a checkpoint on a read-only Vault");
		await f.idle();
		const result = f.service.getSnapshot().messages.find(message => message.role === "toolResult" && message.toolName === "context_checkpoint");
		expect(textOf(result)).toContain("Fixture Vault is read only");
		expect(textOf(result)).not.toContain("Created checkpoint");
		expect((await f.plugin.sessionManager.getSessionFor(f.service.getActiveSessionPath()).getLog()).some(item => item.kind === "fact" && item.fact === "label")).toBe(false);
	});

	it("keeps the original conversation when the summary write fails", async () => {
		const f = await seededCheckpoint();
		const path = f.service.getActiveSessionPath(), session = f.plugin.sessionManager.getSessionFor(path);
		const originalIds = (await session.getLog()).flatMap(item => item.kind === "entry" ? [item.entry.id] : []);
		const append = f.memory.append.bind(f.memory);
		let attempted = false;
		f.memory.append = async (file, value) => {
			if (value.includes('"type":"branch_summary"')) { attempted = true; throw new Error("Fixture summary write failed"); }
			await append(file, value);
		};
		f.setPlan({ chat: [{ tool: { name: "context_compact", args: { target: "verified-notes", summary: "Only publish after saving." } } }, { text: "The original conversation is still selected." }] });
		await f.service.sendPrompt("Try saving a handoff summary");
		await waitForResearch(() => attempted, "failed-summary write");
		await f.idle();
		expect(attempted).toBe(true);
		expect(JSON.stringify(f.service.getSnapshot())).toContain("Fixture summary write failed");
		expect(JSON.stringify((await f.plugin.sessionManager.buildSessionContextFor(path)).messages)).toContain("Keep these original notes.");
		const log = await session.getLog();
		expect(originalIds.every(id => log.some(item => item.kind === "entry" && item.entry.id === id))).toBe(true);
		expect(log.some(item => item.kind === "entry" && item.entry.type === "branch_summary")).toBe(false);
	});

	for (const stage of ["summary", "selection"] as const) {
		it(`waits for an in-flight ${stage} write on stop and never starts a continuation`, async () => {
			const f = await seededCheckpoint();
			const path = f.service.getActiveSessionPath(), session = f.plugin.sessionManager.getSessionFor(path);
			const entered = deferred(), gate = deferred();
			cleanup.push(gate.resolve);
			const append = f.memory.append.bind(f.memory);
			let summaryId = "", selectionWrites = 0;
			f.memory.append = async (file, value) => {
				const mutation = JSON.parse(value) as { type?: string; kind: string; lane?: string; id?: string; leafId?: string };
				const isSummary = mutation.type === "branch_summary";
				if (isSummary) summaryId = mutation.id!;
				const isSelection = mutation.kind === "lane" && mutation.lane === "main" && mutation.leafId === summaryId;
				if (isSelection) selectionWrites++;
				if (stage === "summary" && isSummary || stage === "selection" && isSelection) { entered.resolve(); await gate.promise; }
				await append(file, value);
			};
			f.setPlan({ chat: [{ tool: { name: "context_compact", args: { target: "verified-notes", summary: "A handoff stopped during persistence." } } }] });
			const before = f.requests.length;
			const running = f.service.sendPrompt("Compact, then stop during the save");
			let enteredWrite = false;
			void entered.promise.then(() => { enteredWrite = true; });
			await waitForResearch(() => enteredWrite, `${stage} write started`);
			const stopped = f.service.abortSession(path);
			gate.resolve();
			await stopped;
			await running;
			await f.idle();
			expect(f.requests).toHaveLength(before + 1);
			expect(selectionWrites).toBe(stage === "selection" ? 1 : 0);
			const persisted = await f.plugin.sessionManager.buildSessionContextFor(path);
			const runtime = f.service.getSnapshot().messages;
			expect(JSON.stringify(runtime)).toBe(JSON.stringify(persisted.messages));
			expect(await session.view("main").getLeafId()).toEqual(stage === "selection" ? summaryId : expect.not.stringContaining(summaryId));
			expect(runtime.some(message => message.role === "custom" && message.customType === "pi-context")).toBe(false);
		});
	}
});
