import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Model, Api, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Agent, convertToLlm } from "@earendil-works/pi-agent-core";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { TFile } from "obsidian";

installObsidianStub();

const { TFile: TFileClass } = await import("obsidian");
const { VaultExecutionEnv } = await import("../vault/VaultExecutionEnv");
const { adaptHarnessTool, createVaultHarnessContext } = await import("../vault/harnessAdapter");
const core = await import("@earendil-works/pi-agent-core");

const MODEL: Model<Api> = {
	id: "test-model",
	api: "openai-completions",
	provider: "test",
	contextWindow: 128_000,
	maxTokens: 4_096,
} as unknown as Model<Api>;

/**
 * What the execution-order assertions read.
 *
 * `start` and `end` are the loop's own `tool_execution_start` / `_end` events,
 * so the interleaving they record is pi's, not ours.
 */
interface TimelineEntry {
	event: "start" | "end";
	tool: string;
}

/**
 * In-memory vault stand-in that records the in-flight window of each read the
 * way the *native read tool* performs it (`vault.readBinary`). Reads can be
 * parked mid-flight via {@link release}, so a test can hold one read open and
 * watch whether the other tool in the batch is allowed to overtake it.
 *
 * Deliberately parks only `readBinary`: the edit tool reaches its own
 * read-back through `vault.read`, and parking that too would deadlock the
 * edit test's own internals.
 */
class GateVault {
	private readonly files = new Map<string, string>([["Note.md", "body\n"]]);
	/** Sequence of `<path>:open` / `<path>:close` as reads start and finish. */
	readonly reads: string[] = [];
	/** Resolvers for reads a test has parked via `release`. */
	private readonly held = new Map<string, () => void>();

	/** Seeds one file's body before the run starts. */
	put(path: string, content: string): void {
		this.files.set(path, content);
	}

	private async parkedRead(path: string): Promise<void> {
		this.reads.push(`${path}:open`);
		await new Promise<void>((resolve) => {
			this.held.set(path, resolve);
		});
		this.reads.push(`${path}:close`);
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		await this.parkedRead(file.path);
		return new TextEncoder().encode(this.files.get(file.path) ?? "").buffer as ArrayBuffer;
	}

	async read(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? "";
	}

	/** Releases one parked read by path. */
	release(path: string): void {
		this.held.get(path)?.();
		this.held.delete(path);
	}

	getFileByPath(path: string): TFile | null {
		if (!this.files.has(path)) {
			return null;
		}
		const file: TFile = new TFileClass();
		file.path = path;
		file.name = path;
		file.stat = { ctime: 0, mtime: 0, size: this.files.get(path)!.length };
		return file;
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.getFileByPath(path);
	}

	getFolderByPath(): null {
		return null;
	}

	async modify(file: TFile, data: string): Promise<void> {
		if (!this.files.has(file.path)) {
			throw new Error(`File not found: ${file.path}`);
		}
		this.files.set(file.path, data);
	}

	/** Mirrors Obsidian's atomic read-modify-write; the write tool rides it. */
	async process<T>(file: TFile, fn: (data: string) => T): Promise<T> {
		if (!this.files.has(file.path)) {
			throw new Error(`File not found: ${file.path}`);
		}
		const result = fn(this.files.get(file.path)!);
		this.files.set(file.path, result as unknown as string);
		return result;
	}

	readonly adapter = {
		exists: async (path: string) => this.files.has(path),
	};

	readText(path: string): string | undefined {
		return this.files.get(path);
	}
}

/**
 * Builds a streamFn whose nth request replays the nth script entry, issuing
 * every entry's tool calls together in one assistant message — the batch shape
 * the tool-execution strategy branches on.
 */
function batchedStreamFn(script: Array<{ toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; text?: string }>): StreamFn {
	let requests = 0;
	return (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
		const step = script[Math.min(requests, script.length - 1)]!;
		requests += 1;
		const stream = createAssistantMessageEventStream();
		const base = {
			role: "assistant" as const,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		if (step.toolCalls.length > 0) {
			const message: AssistantMessage = {
				...base,
				content: [
					...(step.text ? [{ type: "text" as const, text: step.text }] : []),
					...step.toolCalls.map((call) => ({ type: "toolCall" as const, ...call })),
				],
				stopReason: "toolUse",
			};
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end(message);
			return stream;
		}
		const message: AssistantMessage = {
			...base,
			content: [{ type: "text" as const, text: step.text ?? "" }],
			stopReason: "stop",
		};
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
}

/** Records `tool_execution_start`/`_end` pairs, in emission order. */
function recordTimeline(agent: Agent): TimelineEntry[] {
	const timeline: TimelineEntry[] = [];
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			timeline.push({ event: "start", tool: event.toolName });
		}
		if (event.type === "tool_execution_end") {
			timeline.push({ event: "end", tool: event.toolName });
		}
	});
	return timeline;
}

/** Polls until `condition` holds, with a bounded budget instead of hanging. */
async function until(condition: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (condition()) {
			return;
		}
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function appFor(vault: GateVault): Parameters<typeof createVaultHarnessContext>[0] {
	return { vault } as unknown as Parameters<typeof createVaultHarnessContext>[0];
}

/** Tools adapted the way `createObsidianTools` adapts them, over one shared env. */
function adaptTools(app: Parameters<typeof createVaultHarnessContext>[0], marks: { read: "parallel"; write: "parallel" | "sequential"; edit?: "parallel" }) {
	const context = createVaultHarnessContext(app);
	const env = context.env;
	const tools: AgentTool<any>[] = [
		adaptHarnessTool(core.createReadTool(), { context: { env }, executionMode: marks.read }),
		adaptHarnessTool(core.createWriteTool(), { context: { env }, executionMode: marks.write }),
	];
	if (marks.edit) {
		tools.push(adaptHarnessTool(core.createEditTool(), { context: { env }, executionMode: marks.edit }));
	}
	return tools;
}

describe("tool execution mode", () => {
	it("runs two read-only calls in one batch concurrently", async () => {
		const vault = new GateVault();
		vault.put("Other.md", "other\n");
		const tools = adaptTools(appFor(vault), { read: "parallel", write: "parallel" });
		const readTool = tools[0]!;

		const agent = new Agent({
			streamFn: batchedStreamFn([
				{
					toolCalls: [
						{ id: "r1", name: "read", arguments: { path: "/Note.md" } },
						{ id: "r2", name: "read", arguments: { path: "/Other.md" } },
					],
				},
				{ toolCalls: [], text: "done" },
			]),
			convertToLlm,
			toolExecution: "parallel",
			initialState: {
				systemPrompt: "test",
				model: MODEL,
				thinkingLevel: "off" as never,
				tools,
				messages: [],
			},
		});
		const timeline = recordTimeline(agent);

		const run = agent.prompt("read both");
		// Both reads are in flight at once: the second one has started while the
		// first is still parked. A sequential batch would never overlap.
		await until(() => vault.reads.filter((entry) => entry.endsWith(":open")).length === 2, "both reads to open");
		expect(vault.reads).toEqual(["Note.md:open", "Other.md:open"]);
		expect(timeline.filter((entry) => entry.event === "start").length).toBe(2);
		expect(timeline.some((entry) => entry.event === "end")).toBe(false);
		vault.release("Note.md");
		vault.release("Other.md");
		await run;

		// The second read overtook the first: its start came before the first's
		// end, which is exactly what a serialized batch cannot produce.
		const firstEnd = timeline.findIndex((entry) => entry.event === "end");
		const secondStart = timeline.map((entry) => entry.event === "start").lastIndexOf(true);
		expect(secondStart).toBeLessThan(firstEnd);
	});

	it("serializes a batch when one tool is marked sequential", async () => {
		const vault = new GateVault();
		vault.put("Other.md", "other\n");
		const tools = adaptTools(appFor(vault), { read: "parallel", write: "parallel" });
		const readTool = tools[0]!;
		// A second read variant pinned sequential: same tool body, so the only
		// thing that can explain the ordering below is the mark.
		const sequentialRead = adaptHarnessTool(core.createReadTool(), {
			context: { env: createVaultHarnessContext(appFor(vault)).env },
			executionMode: "sequential",
		});
		sequentialRead.name = "read_slow";

		const agent = new Agent({
			streamFn: batchedStreamFn([
				{
					toolCalls: [
						{ id: "r1", name: "read", arguments: { path: "/Note.md" } },
						{ id: "r2", name: "read_slow", arguments: { path: "/Other.md" } },
					],
				},
				{ toolCalls: [], text: "done" },
			]),
			convertToLlm,
			toolExecution: "parallel",
			initialState: {
				systemPrompt: "test",
				model: MODEL,
				thinkingLevel: "off" as never,
				tools: [readTool, sequentialRead],
				messages: [],
			},
		});

		const run = agent.prompt("read both");
		// The first read is parked and the second has NOT started: the sequential
		// pin serialized the whole batch.
		await until(() => vault.reads.filter((entry) => entry === "Note.md:open").length === 1, "the first read to open");
		await Bun.sleep(20);
		expect(vault.reads).toEqual(["Note.md:open"]);
		vault.release("Note.md");
		// The second read now runs, still one at a time — and parks too.
		await until(() => vault.reads.includes("Other.md:open"), "the second read to open");
		vault.release("Other.md");
		await run;
		expect(vault.reads).toEqual(["Note.md:open", "Note.md:close", "Other.md:open", "Other.md:close"]);
	});

	it("keeps a write behind a parked read when the write is pinned sequential", async () => {
		// The production shape: `write` carries `executionMode: "sequential"`,
		// `read` carries "parallel", the agent runs `toolExecution: "parallel"`.
		// One sequential tool in the batch serializes all of it, so the write
		// cannot start, let alone land, while the read is still in flight.
		const vault = new GateVault();
		const tools = adaptTools(appFor(vault), { read: "parallel", write: "sequential" });

		const agent = new Agent({
			streamFn: batchedStreamFn([
				{
					toolCalls: [
						{ id: "r1", name: "read", arguments: { path: "/Note.md" } },
						{ id: "w1", name: "write", arguments: { path: "/Note.md", content: "rewritten\n" } },
					],
				},
				{ toolCalls: [], text: "done" },
			]),
			convertToLlm,
			toolExecution: "parallel",
			initialState: {
				systemPrompt: "test",
				model: MODEL,
				thinkingLevel: "off" as never,
				tools,
				messages: [],
			},
		});
		const timeline = recordTimeline(agent);

		const run = agent.prompt("read then write");
		await until(() => vault.reads.includes("Note.md:open"), "the read to open");
		// Give the write a scheduling window to prove it did not jump the queue:
		// the note still holds its original body while the read is parked.
		await Bun.sleep(20);
		expect(vault.readText("Note.md")).toBe("body\n");
		vault.release("Note.md");
		await run;
		expect(vault.readText("Note.md")).toBe("rewritten\n");
		expect(timeline.map((entry) => entry.event)).toEqual(["start", "end", "start", "end"]);
	});

	it("still serializes two forced-parallel edits on one path through the mutation queue", async () => {
		// Belt-and-braces proof, independent of the loop marks: even if a batch
		// reaches the loop with a write-class tool wrongly marked parallel, the
		// shared env's per-path mutation queue orders the two read-modify-write
		// cycles, so both edits land and `one\n` survives.
		const vault = new GateVault();
		vault.put("Note.md", "one\ntwo\nthree\n");
		const tools = adaptTools(appFor(vault), { read: "parallel", write: "parallel", edit: "parallel" });
		const editTool = tools[2]!;

		const agent = new Agent({
			streamFn: batchedStreamFn([
				{
					toolCalls: [
						{ id: "e1", name: "edit", arguments: { path: "/Note.md", edits: [{ oldText: "two", newText: "TWO" }] } },
						{ id: "e2", name: "edit", arguments: { path: "/Note.md", edits: [{ oldText: "three", newText: "THREE" }] } },
					],
				},
				{ toolCalls: [], text: "done" },
			]),
			convertToLlm,
			toolExecution: "parallel",
			initialState: {
				systemPrompt: "test",
				model: MODEL,
				thinkingLevel: "off" as never,
				tools,
				messages: [],
			},
		});

		await agent.prompt("edit both");
		const finalContent = vault.readText("Note.md") ?? "";
		expect(finalContent).toContain("TWO");
		expect(finalContent).toContain("THREE");
		expect(finalContent).toContain("one\n");
		expect(editTool.executionMode).toBe("parallel");
	});
});
