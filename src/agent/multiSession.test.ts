import type { JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { captureContext } from "../testUtils/captureContext";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { App, DataAdapter, ListedFiles, Stat } from "obsidian";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentToolResult, StreamFn } from "@earendil-works/pi-agent-core";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { stubWindowMembers } from "../testUtils/windowStub";
import { webcrypto } from "node:crypto";
import { DEFAULT_SESSION_RETENTION } from "../session/retention";
import { DEFAULT_SESSION_DIR } from "../session/sessionDir";
import { DEFAULT_LOG_LEVEL } from "../logging/logLevel";
import type { PiemSettings } from "../settings";
import { parseCodemodeArgument, type CodemodeSessionMode } from "../codemode/mode";
import type { ObsidianAgentService as ObsidianAgentServiceType } from "./ObsidianAgentService";
import type { UserSkillsLoad } from "../skills/userSkills";
import { withRunawayGuard, createBoundedCollector } from "../testUtils/runawayGuard";

// The obsidian stub is process-global and must be registered before any module
// that imports `obsidian` is evaluated — same ordering the service tests use.
installObsidianStub();

const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { TFile: TFileClass, TFolder: TFolderClass } = await import("obsidian");
const { DEFAULT_SETTINGS } = await import("../settings");

const SESSION_DIR = `.${"obsidian"}/plugins/piem/sessions`;

const NO_USER_SKILLS = async (): Promise<UserSkillsLoad> => ({ skills: [], diagnostics: [], searched: [] });

// ---------------------------------------------------------------------------
// Factories copied from ObsidianAgentService.test.ts (they are file-local there)
// ---------------------------------------------------------------------------

class MemoryAdapter {
	private readonly files = new Map<string, { content: string; mtime: number }>();
	private readonly folders = new Set<string>();

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.folders.add(path);
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, { content: data, mtime: Date.now() });
	}

	async append(path: string, data: string): Promise<void> {
		const existing = this.files.get(path)?.content ?? "";
		this.files.set(path, { content: existing + data, mtime: Date.now() });
	}

	async read(path: string): Promise<string> {
		const file = this.files.get(path);
		if (!file) {
			throw new Error(`Missing file: ${path}`);
		}
		return file.content;
	}

	async stat(path: string): Promise<Stat | null> {
		const file = this.files.get(path);
		if (file) {
			return { type: "file", ctime: file.mtime, mtime: file.mtime, size: file.content.length };
		}
		if (this.folders.has(path)) {
			return { type: "folder", ctime: Date.now(), mtime: Date.now(), size: 0 };
		}
		return null;
	}

	async list(path: string): Promise<ListedFiles> {
		return {
			files: [...this.files.keys()].filter((filePath) => getParent(filePath) === path),
			folders: [...this.folders.values()].filter((folderPath) => getParent(folderPath) === path),
		};
	}

	async trashSystem(path: string): Promise<boolean> {
		this.files.delete(path);
		return true;
	}

	async trashLocal(path: string): Promise<void> {
		this.files.delete(path);
	}

	/** Test-side read helper: every persisted line, keyed by path. */
	filePaths(): string[] {
		return [...this.files.keys()];
	}
}

function asDataAdapter(adapter: MemoryAdapter): DataAdapter {
	return adapter as unknown as DataAdapter;
}

function getParent(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function waitFor(condition: () => boolean): Promise<void> {
	return new Promise((resolve) => {
		const tick = () => (condition() ? resolve() : setTimeout(tick, 1));
		tick();
	});
}

/** Drains the event loop long enough for a wrongful abort to have landed. */
async function settleTick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 25));
}

function defaultTestSettings(): PiemSettings {
	return {
		...DEFAULT_SETTINGS,
		shareDiagnostics: false,
		providers: [
			{
				id: "p-test",
				name: "Test gateway",
				baseUrl: "https://gw.test/v1",
				protocol: "openai-completions",
				apiKey: "test-key",
				secretRef: "",
				source: "user",
				oauthFlow: "",
			},
		],
		models: [{ id: "m-test", providerId: "p-test", modelApiId: "test-model", displayName: "Test Model", reasoning: false, supportsImages: false }],
		activeModelId: "m-test",
		networkTransport: "requestUrl",
		showAgentDetails: false,
		sendShortcut: "enter",
		language: "en",
		sessionRetention: DEFAULT_SESSION_RETENTION,
		sessionDir: DEFAULT_SESSION_DIR,
	};
}

function createFakeApp(adapter: DataAdapter, vaultFiles: Record<string, string> = {}): App {
	const files = new Map<string, object>();
	const folders = new Map<string, object>();

	const folderAt = (path: string): object => {
		const existing = folders.get(path);
		if (existing) {
			return existing;
		}
		const folder: object = new TFolderClass();
		(folder as { path: string }).path = path;
		(folder as { name: string }).name = path.slice(path.lastIndexOf("/") + 1);
		folders.set(path, folder);
		if (path !== "") {
			folderAt(getParent(path));
		}
		return folder;
	};

	const registerFile = (path: string, size: number): void => {
		const file: object = new TFileClass();
		(file as { path: string }).path = path;
		(file as { name: string }).name = path.slice(path.lastIndexOf("/") + 1);
		(file as { stat: Stat }).stat = { type: "file", size, mtime: 1, ctime: 1 };
		files.set(path, file);
		folderAt(getParent(path));
	};

	folderAt("");
	for (const [path, content] of Object.entries(vaultFiles)) {
		registerFile(path, content.length);
	}

	return {
		vault: {
			adapter,
			getName: () => "Test",
			getFiles: () => Array.from(files.values()),
			getRoot: () => folderAt(""),
			getFileByPath: (path: string) => files.get(path) ?? null,
			getFolderByPath: (path: string) => folders.get(path) ?? null,
			getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path) ?? null,
			read: async (file: { path: string }) => vaultFiles[file.path] ?? "",
			cachedRead: async (file: { path: string }) => vaultFiles[file.path] ?? "",
			createFolder: async (path: string) => folderAt(path),
		},
		workspace: {
			getActiveViewOfType: () => null,
			// Read by the context probe on every request; absent methods would make it
			// throw and degrade instead of reporting an empty workspace.
			getLeavesOfType: () => [],
			getLastOpenFiles: () => [],
		},
	} as unknown as App;
}

function createService(memoryAdapter: MemoryAdapter = new MemoryAdapter(), streamFn?: StreamFn): ObsidianAgentServiceType {
	const adapter = asDataAdapter(memoryAdapter);
	const settings = defaultTestSettings();
	const sessionManager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
	return new ObsidianAgentService(createFakeApp(adapter), () => settings, sessionManager, {
		streamFn: streamFn ?? ((): StreamFn => {
			throw new Error("multiSession tests must script their streams explicitly");
		})(),
		loadUserSkills: NO_USER_SKILLS,
	});
}

/** One completed provider response carrying only text, for scripted streamFns. */
function scriptedTextStream(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason: "stop",
	};
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

// ---------------------------------------------------------------------------
// The two stream scripts the concurrency tests are built from
// ---------------------------------------------------------------------------

/** The prompt text that makes a session's run hang until aborted. */
const HANG_A = "hang-a";
const HANG_B = "hang-b";

/**
 * What the person actually typed, in a captured request.
 *
 * Not simply the last user message: `transformContext` appends the per-turn
 * `<context>` block as a user message on every request, so an echo script that
 * took the last one would parrot the block back instead of the prompt.
 */
function lastUserPromptText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message && message.role === "user") {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				if (content.startsWith("<context>")) {
					continue;
				}
				return content.trim();
			}
			return content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n")
				.trim();
		}
	}
	return "";
}

/**
 * A provider request that never completes on its own and only terminates when
 * the run's signal fires — what a real hung request does, since the agent
 * forwards its signal into stream options. Copied from the
 * `hangingStreamFn` in src/subagent/extension.test.ts, with an `onAbort`
 * probe so a test can tell "the signal fired" from "the run settled".
 */
function hangingStream(model: Model<Api>, options: SimpleStreamOptions | undefined, onAbort: () => void) {
	const stream = createAssistantMessageEventStream();
	const fire = (): void => {
		onAbort();
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
			stopReason: "aborted",
			errorMessage: "aborted",
		};
		// The event protocol terminates aborted runs with `error`, not `done`.
		stream.push({ type: "error", reason: "aborted", error: message });
		stream.end(message);
	};
	if (options?.signal?.aborted) {
		fire();
	} else {
		options?.signal?.addEventListener("abort", fire, { once: true });
	}
	return stream;
}

/**
 * One streamFn playing every session: the two hang prompts get a run that only
 * ends when the run's signal fires; every other prompt gets an immediate echo.
 *
 * `entered`/`aborted` are keyed by prompt text because the streamFn cannot know
 * which session file it serves — the prompt is the session's fingerprint here.
 */
function multiSessionStreamFn(): {
	streamFn: StreamFn;
	entered: Map<string, boolean>;
	aborted: Map<string, boolean>;
} {
	const entered = new Map<string, boolean>([
		[HANG_A, false],
		[HANG_B, false],
	]);
	const aborted = new Map<string, boolean>([
		[HANG_A, false],
		[HANG_B, false],
	]);
	const streamFn: StreamFn = withRunawayGuard((model, context, options) => {
		const prompt = lastUserPromptText(context);
		if (prompt === HANG_A || prompt === HANG_B) {
			entered.set(prompt, true);
			return hangingStream(model, options, () => aborted.set(prompt, true));
		}
		return scriptedTextStream(model, `pong:${prompt}`);
	}, { maxCalls: 100, label: "multiSessionStreamFn" });
	return { streamFn, entered, aborted };
}

/**
 * A script whose runs finish only when the test says so, by prompt text.
 *
 * `hangingStream` above can only ever end in an abort, which cannot answer "did
 * a background run's reply reach the right transcript". This one holds the
 * stream open and hands back the closer, so a run can complete while the panel
 * is looking somewhere else.
 */
function deferredStreamFn(): {
	streamFn: StreamFn;
	started: Set<string>;
	finish: (prompt: string, text: string) => void;
} {
	const started = new Set<string>();
	const held = new Map<string, { stream: ReturnType<typeof createAssistantMessageEventStream>; model: Model<Api> }>();
	const streamFn: StreamFn = withRunawayGuard((model, context) => {
		const prompt = lastUserPromptText(context);
		if (!prompt.startsWith("slow-")) {
			return scriptedTextStream(model, `pong:${prompt}`);
		}
		const stream = createAssistantMessageEventStream();
		held.set(prompt, { stream, model });
		started.add(prompt);
		return stream;
	}, { maxCalls: 100, label: "deferredStreamFn" });
	const finish = (prompt: string, text: string): void => {
		const pending = held.get(prompt);
		if (!pending) {
			throw new Error(`No run is waiting for ${prompt}`);
		}
		held.delete(prompt);
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: pending.model.api,
			provider: pending.model.provider,
			model: pending.model.id,
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
			stopReason: "stop",
		};
		pending.stream.push({ type: "done", reason: "stop", message });
		pending.stream.end(message);
	};
	return { streamFn, started, finish };
}

/** One assistant turn that is a single tool call. */
function scriptedToolCallStream(model: Model<Api>, callId: string, toolName: string, toolArguments: JsonObject) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: toolName, arguments: toolArguments }],
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
		stopReason: "toolUse",
	};
	stream.push({ type: "done", reason: "toolUse", message });
	stream.end(message);
	return stream;
}

/**
 * A script where the parent delegates once and then stops talking, leaving the
 * child's own turn open until the test closes it.
 *
 * The parent's run therefore *finishes* while its child is still working —
 * which is the state a focus switch has to survive. `wait_subagent` is
 * deliberately not called: it reaches `window.setTimeout`, which this file has
 * no DOM for.
 */
function delegatingStreamFn(): {
	streamFn: StreamFn;
	childStarted: () => boolean;
	finishChild: (text: string) => void;
} {
	let spawned = false;
	let child: { stream: ReturnType<typeof createAssistantMessageEventStream>; model: Model<Api> } | undefined;
	const streamFn: StreamFn = withRunawayGuard((model, context) => {
		// The subagent system prompt is the only thing that names a delegated task —
		// same discriminator the service's own delegation test uses.
		if (getCurrentSystemPrompt(context.messages)?.includes("delegated task") ?? false) {
			const stream = createAssistantMessageEventStream();
			child = { stream, model };
			return stream;
		}
		if (!spawned) {
			spawned = true;
			return scriptedToolCallStream(model, "spawn_1", "spawn_subagent", { task: "Sweep the vault", role: "scout" });
		}
		return scriptedTextStream(model, "delegated");
	}, { maxCalls: 100, label: "delegatingStreamFn" });
	const finishChild = (text: string): void => {
		if (!child) {
			throw new Error("No child run is waiting");
		}
		const { stream, model } = child;
		child = undefined;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
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
			stopReason: "stop",
		};
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	};
	return { streamFn, childStarted: () => child !== undefined, finishChild };
}

function multiSessionDelegatingStreamFn(): {
	streamFn: StreamFn;
	enteredChildren: Map<string, boolean>;
} {
	const enteredChildren = new Map<string, boolean>();
	let spawnedA = false;
	let spawnedB = false;
	const streamFn: StreamFn = withRunawayGuard((model, context, options) => {
		if (getCurrentSystemPrompt(context.messages)?.includes("delegated task") ?? false) {
			const stream = createAssistantMessageEventStream();
			const msgStr = JSON.stringify(context.messages);
			const name = msgStr.includes("scout-a") ? "scout-a" : msgStr.includes("scout-b") ? "scout-b" : "unknown";
			enteredChildren.set(name, true);
			const fire = (): void => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					timestamp: Date.now(),
					stopReason: "aborted",
					errorMessage: "aborted",
				};
				stream.push({ type: "error", reason: "aborted", error: message });
				stream.end(message);
			};
			if (options?.signal?.aborted) {
				fire();
			} else {
				options?.signal?.addEventListener("abort", fire, { once: true });
			}
			return stream;
		}
		const userMsg = JSON.stringify(context.messages);
		if (!spawnedA && userMsg.includes("delegate-a")) {
			spawnedA = true;
			return scriptedToolCallStream(model, "spawn_a", "spawn_subagent", { task: "scout-a", role: "scout" });
		}
		if (!spawnedB && userMsg.includes("delegate-b")) {
			spawnedB = true;
			return scriptedToolCallStream(model, "spawn_b", "spawn_subagent", { task: "scout-b", role: "scout" });
		}
		return scriptedTextStream(model, "delegated");
	}, { maxCalls: 100, label: "multiSessionDelegatingStreamFn" });

	return { streamFn, enteredChildren };
}


/** An immediate echo script: every prompt gets `pong:<prompt>` back. */
function echoStreamFn(): StreamFn {
	return (model: Model<Api>, context: Context) => scriptedTextStream(model, `pong:${lastUserPromptText(context)}`);
}

// ---------------------------------------------------------------------------
// Shared sequencing
// ---------------------------------------------------------------------------

/**
 * Seeds two sessions, each holding one echoed turn.
 *
 * Both must carry a message: a sheet left blank on switch-away is retired by
 * the blank-sheet sweep, and these tests are about concurrency semantics, not
 * about giving a blank sheet a reason to die.
 */
async function seedTwoSessions(service: ObsidianAgentServiceType): Promise<{ pathA: string; pathB: string }> {
	await service.sendPrompt("seed-a");
	const pathA = service.getSnapshot().session?.path;
	expect(pathA).toBeDefined();
	await service.newSession();
	await service.sendPrompt("seed-b");
	const pathB = service.getSnapshot().session?.path;
	expect(pathB).toBeDefined();
	expect(pathB).not.toBe(pathA);
	return { pathA: pathA as string, pathB: pathB as string };
}

/**
 * Starts a hang on the ACTIVE session and waits until the provider request is
 * genuinely in flight (the streamFn has been entered — `isStreaming` alone
 * flips earlier, while the run is still preparing), so a subsequent switch
 * cannot dodge the assertion by aborting before the request was ever made.
 *
 * The sendPrompt promise is deliberately not returned: a hanging run never
 * resolves it, and awaiting it here would deadlock the test. The run ends via
 * the abort probes instead.
 */
async function startHang(
	service: ObsidianAgentServiceType,
	prompt: string,
	entered: Map<string, boolean>,
): Promise<void> {
	void service.sendPrompt(prompt);
	await waitFor(() => entered.get(prompt) === true);
}

/**
 * Ends a hang regardless of which abort API the service currently exposes.
 * Before the #235 implementation only the global `abort()` exists, so the
 * per-session path degrades to it — cleanup must not be the thing a red test
 * trips over.
 */
async function stopRun(service: ObsidianAgentServiceType, path: string): Promise<void> {
	const candidate = service as unknown as { abortSession?: (path: string) => Promise<void> | void };
	if (typeof candidate.abortSession === "function") {
		await candidate.abortSession(path);
		return;
	}
	if (service.getActiveSessionPath() === path) {
		service.abort();
	}
}

/** Reads every persisted session log line from the vault adapter. */
async function sessionLogContents(adapter: MemoryAdapter): Promise<Map<string, string>> {
	const contents = new Map<string, string>();
	const walk = async (dir: string): Promise<void> => {
		const listing = await adapter.list(dir);
		for (const filePath of listing.files) {
			contents.set(filePath, await adapter.read(filePath));
		}
		for (const folderPath of listing.folders) {
			await walk(folderPath);
		}
	};
	await walk(SESSION_DIR);
	return contents;
}

/**
 * target API: per-session run states.
 * Codifies the shape the implementation must expose — one entry per session
 * the service knows about, named by its session file path.
 */
type SessionRunState = { path: string; state: "idle" | "running" | "waiting-input" | "error" };

describe("ObsidianAgentService multi-session concurrency (issue #235)", () => {
	it("opening another session does not abort the first session's stream", async () => {
		const { streamFn, entered, aborted } = multiSessionStreamFn();
		const service = createService(new MemoryAdapter(), streamFn);
		const { pathA, pathB } = await seedTwoSessions(service);
		await service.openSession(pathA);

		// Session A's run hangs on the provider request; it only ends if the run's
		// signal fires, and the firing is what the probe records.
		await startHang(service, HANG_A, entered);
		expect(entered.get(HANG_A)).toBe(true);
		expect(aborted.get(HANG_A)).toBe(false);

		// The switch under test: open B while A's request is still in flight.
		await service.openSession(pathB);
		expect(service.getActiveSessionPath()).toBe(pathB);

		// Plenty of turns of the event loop for a wrongful abort to land.
		await settleTick();

		expect(aborted.get(HANG_A)).toBe(false);
		// And A's stream was never terminated: an aborted run lands as an `error`
		// event, so if the probe never fired the run is still holding its stream.
		expect(entered.get(HANG_A)).toBe(true);

		await stopRun(service, pathA);
	});

	it("switching away and back leaves the background run untouched", async () => {
		const { streamFn, entered, aborted } = multiSessionStreamFn();
		const service = createService(new MemoryAdapter(), streamFn);
		const { pathA, pathB } = await seedTwoSessions(service);
		await service.openSession(pathA);

		await startHang(service, HANG_A, entered);
		const agentWhileRunning = (service as unknown as { runtimes: Map<string, { agent: unknown }> }).runtimes.get(pathA)?.agent;

		// Leave, then come back.
		await service.openSession(pathB);
		await settleTick();
		await service.openSession(pathA);
		await settleTick();

		const agentAfterReturn = (service as unknown as { runtimes: Map<string, { agent: unknown }> }).runtimes.get(pathA)?.agent;
		expect(agentAfterReturn).toBe(agentWhileRunning);

		const states = (service as { getSessionRunStates?: () => SessionRunState[] }).getSessionRunStates!();
		expect(states.find((entry) => entry.path === pathA)?.state).toBe("running");
		// What the user sees on the way back: the run is still streaming, its
		// request was never signalled, and nothing offers to "resume" the run that
		// is right there in flight.
		const back = service.getSnapshot();
		expect(back.isStreaming).toBe(true);
		expect(back.canResumeInterrupted ?? false).toBe(false);
		expect(aborted.get(HANG_A)).toBe(false);

		await stopRun(service, pathA);
	});

	it("switching back and forth keeps each session's events isolated", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter, echoStreamFn());
		const { pathA, pathB } = await seedTwoSessions(service);

		// Interleave: A → prompt → B → prompt → A → prompt → B → prompt.
		await service.openSession(pathA);
		await service.sendPrompt("ping-a-1");
		await service.openSession(pathB);
		await service.sendPrompt("ping-b-1");
		await service.openSession(pathA);
		await service.sendPrompt("ping-a-2");
		await service.openSession(pathB);
		await service.sendPrompt("ping-b-2");

		const bView = service.getSnapshot();
		expect(JSON.stringify(bView.messages)).toContain("pong:ping-b-1");
		expect(JSON.stringify(bView.messages)).toContain("pong:ping-b-2");
		expect(JSON.stringify(bView.messages)).not.toContain("pong:ping-a-1");
		expect(JSON.stringify(bView.messages)).not.toContain("pong:ping-a-2");

		await service.openSession(pathA);
		const aView = service.getSnapshot();
		expect(JSON.stringify(aView.messages)).toContain("pong:ping-a-1");
		expect(JSON.stringify(aView.messages)).toContain("pong:ping-a-2");
		expect(JSON.stringify(aView.messages)).not.toContain("pong:ping-b-1");
		expect(JSON.stringify(aView.messages)).not.toContain("pong:ping-b-2");

		// And the same isolation holds on disk: each session's JSONL holds only
		// its own turns — no message ever landed in the other session's file.
		const logs = await sessionLogContents(adapter);
		const logsWithTurns = [...logs.entries()].filter(([, content]) => content.includes("ping-a-1") || content.includes("ping-b-1"));
		expect(logsWithTurns.length).toBeGreaterThanOrEqual(2);
		const fileWithA = logsWithTurns.filter(([, content]) => content.includes("ping-a-1"));
		const fileWithB = logsWithTurns.filter(([, content]) => content.includes("ping-b-1"));
		expect(fileWithA.length).toBe(1);
		expect(fileWithB.length).toBe(1);
		expect(fileWithA[0]![0]).not.toBe(fileWithB[0]![0]);
		expect(fileWithA[0]![1]).toContain("pong:ping-a-1");
		expect(fileWithA[0]![1]).toContain("pong:ping-a-2");
		expect(fileWithA[0]![1]).not.toContain("pong:ping-b");
		expect(fileWithB[0]![1]).toContain("pong:ping-b-1");
		expect(fileWithB[0]![1]).toContain("pong:ping-b-2");
		expect(fileWithB[0]![1]).not.toContain("pong:ping-a");
	});

	it("a run that lands while another session is focused reaches its own transcript", async () => {
		const { streamFn, started, finish } = deferredStreamFn();
		const adapter = new MemoryAdapter();
		const service = createService(adapter, streamFn);
		const { pathA, pathB } = await seedTwoSessions(service);
		await service.openSession(pathA);

		// A's request is in flight when the panel walks away from it.
		void service.sendPrompt("slow-a");
		await waitFor(() => started.has("slow-a"));
		await service.openSession(pathB);
		expect(service.getActiveSessionPath()).toBe(pathB);

		// The reply arrives with B on screen.
		finish("slow-a", "background reply");
		const states = (): SessionRunState[] => (service as { getSessionRunStates?: () => SessionRunState[] }).getSessionRunStates!();
		await waitFor(() => states().find((entry) => entry.path === pathA)?.state === "idle");
		await settleTick();

		// It belongs to A: not in the transcript on screen, in A's log on disk, and
		// on screen again the moment focus comes back.
		expect(JSON.stringify(service.getSnapshot().messages)).not.toContain("background reply");
		const logs = await sessionLogContents(adapter);
		expect(logs.get(pathA)).toContain("background reply");
		await service.openSession(pathA);
		expect(JSON.stringify(service.getSnapshot().messages)).toContain("background reply");
	});

	it("a subagent spawned by one session outlives a switch to another", async () => {
		const { streamFn, childStarted, finishChild } = delegatingStreamFn();
		const service = createService(new MemoryAdapter(), streamFn);
		const { pathA, pathB } = await seedTwoSessions(service);
		await service.openSession(pathA);

		// A delegates and its own run finishes; the child keeps working.
		await service.sendPrompt("delegate-a");
		await waitFor(childStarted);
		const registry = service.getSubagentRegistry();
		expect(registry.liveCount()).toBe(1);

		// A child's kill switch is linked to its parent RUN's signal, so a focus
		// switch must not reach it — in either direction.
		await service.openSession(pathB);
		await settleTick();
		expect(registry.liveCount()).toBe(1);
		await service.openSession(pathA);
		await settleTick();
		expect(registry.liveCount()).toBe(1);

		// It still reports, and the report is the child's own.
		finishChild("Scout report: nothing to organize.");
		await waitFor(() => registry.liveCount() === 0);
		const entry = registry.all().find((candidate) => candidate.role.name === "scout");
		expect(entry?.settled).toBe(true);
		expect(entry?.error).toBeUndefined();
		expect(JSON.stringify(entry?.result?.messages ?? [])).toContain("Scout report: nothing to organize.");
	});

	it("abortSession cancels only the target session's subagents and deleteSession tears down and prunes them", async () => {
		const { streamFn, enteredChildren } = multiSessionDelegatingStreamFn();
		const service = createService(new MemoryAdapter(), streamFn);
		const { pathA, pathB } = await seedTwoSessions(service);

		// Session A delegates scout-a
		await service.openSession(pathA);
		await service.sendPrompt("delegate-a");
		await waitFor(() => enteredChildren.get("scout-a") === true);

		// Session B delegates scout-b
		await service.openSession(pathB);
		await service.sendPrompt("delegate-b");
		await waitFor(() => enteredChildren.get("scout-b") === true);

		const registry = service.getSubagentRegistry();
		expect(registry.liveCount()).toBe(2);

		const entryA = registry.forOwner(pathA)[0]!;
		const entryB = registry.forOwner(pathB)[0]!;
		expect(entryA).toBeDefined();
		expect(entryB).toBeDefined();
		expect(entryA.settled).toBe(false);
		expect(entryB.settled).toBe(false);

		// Abort session A: only entryA should be cancelled as user abort
		await service.abortSession(pathA);
		await waitFor(() => entryA.settled);

		expect(entryA.settled).toBe(true);
		expect(entryA.killedBy).toBe("user");
		// Session B's subagent must still be running
		expect(entryB.settled).toBe(false);
		expect(entryB.killedBy).toBeUndefined();
		expect(registry.liveCount()).toBe(1);

		// Delete session B: teardown aborts live subagents and prunes entries for pathB
		await service.deleteSession(pathB);
		await waitFor(() => entryB.settled);

		expect(entryB.settled).toBe(true);
		expect(entryB.killedBy).toBe("teardown");
		expect(registry.liveCount()).toBe(0);
		// Settled entries for pathB were pruned on teardown
		expect(registry.forOwner(pathB)).toEqual([]);
	});

	it("deleting the neighbor session falls back to the live run without replacing it", async () => {
		const { streamFn, entered, aborted } = multiSessionStreamFn();
		const service = createService(new MemoryAdapter(), streamFn);
		const { pathA, pathB } = await seedTwoSessions(service);
		await service.openSession(pathA);

		// A streams; the user opens B and deletes B, so focus auto-falls back to A.
		await startHang(service, HANG_A, entered);
		const agentWhileRunning = (service as unknown as { runtimes: Map<string, { agent: unknown }> }).runtimes.get(pathA)?.agent;
		await service.openSession(pathB);
		await service.deleteSession(pathB);
		await settleTick();

		expect(service.getActiveSessionPath()).toBe(pathA);
		// The delete path re-ran startup on the way back; a returning runtime that
		// already owns a live agent must keep it, not be rebuilt from the log tail.
		const agentAfterFallback = (service as unknown as { runtimes: Map<string, { agent: unknown }> }).runtimes.get(pathA)?.agent;
		expect(agentAfterFallback).toBe(agentWhileRunning);
		expect(aborted.get(HANG_A)).toBe(false);

		// What the user sees: the run still streaming, and no "resume the broken
		// reply" banner over a run that is right there in flight.
		const back = service.getSnapshot();
		expect(back.isStreaming).toBe(true);
		expect(back.canResumeInterrupted ?? false).toBe(false);

		await stopRun(service, pathA);
	});

	it("deleting the neighbor session falls back to the live run without replacing it", async () => {
		const { streamFn, entered, aborted } = multiSessionStreamFn();
		const service = createService(new MemoryAdapter(), streamFn);
		const { pathA, pathB } = await seedTwoSessions(service);
		await service.openSession(pathA);

		// A streams; the user opens B and deletes B, so focus auto-falls back to A.
		await startHang(service, HANG_A, entered);
		const agentWhileRunning = (service as unknown as { runtimes: Map<string, { agent: unknown }> }).runtimes.get(pathA)?.agent;
		await service.openSession(pathB);
		await service.deleteSession(pathB);
		await settleTick();

		expect(service.getActiveSessionPath()).toBe(pathA);
		// The delete path re-ran startup on the way back; a returning runtime that
		// already owns a live agent must keep it, not be rebuilt from the log tail.
		const agentAfterFallback = (service as unknown as { runtimes: Map<string, { agent: unknown }> }).runtimes.get(pathA)?.agent;
		expect(agentAfterFallback).toBe(agentWhileRunning);
		expect(aborted.get(HANG_A)).toBe(false);

		// What the user sees: the run still streaming, and no "resume the broken
		// reply" banner over a run that is right there in flight.
		const back = service.getSnapshot();
		expect(back.isStreaming).toBe(true);
		expect(back.canResumeInterrupted ?? false).toBe(false);

		await stopRun(service, pathA);
	});

	it("abort only kills the session it targets", async () => {
		const { streamFn, entered, aborted } = multiSessionStreamFn();
		const service = createService(new MemoryAdapter(), streamFn);
		const { pathA, pathB } = await seedTwoSessions(service);
		await service.openSession(pathA);

		await startHang(service, HANG_A, entered);
		// Switching to B must leave A's run alone (covered above); here both hang.
		await service.openSession(pathB);
		await startHang(service, HANG_B, entered);
		expect(entered.get(HANG_B)).toBe(true);

		// target API: abort must be addressable per session, not global.
		await (service as { abortSession?: (path: string) => Promise<void> | void }).abortSession!(pathA);
		await waitFor(() => aborted.get(HANG_A) === true);

		expect(aborted.get(HANG_A)).toBe(true);
		expect(aborted.get(HANG_B)).toBe(false);
		expect(service.getSnapshot().isStreaming).toBe(true);

		await stopRun(service, pathB);
	});

	it("run state is reported per session", async () => {
		const { streamFn, entered, aborted } = multiSessionStreamFn();
		const service = createService(new MemoryAdapter(), streamFn);
		const { pathA, pathB } = await seedTwoSessions(service);
		await service.openSession(pathA);

		await startHang(service, HANG_A, entered);

		// target API: per-session run states.
		const states = (): SessionRunState[] => (service as { getSessionRunStates?: () => SessionRunState[] }).getSessionRunStates!();

		whileAHangs: {
			const whileRunning = await states();
			const stateOf = (path: string) => whileRunning.find((entry) => entry.path === path)?.state;
			expect(stateOf(pathA)).toBe("running");
			expect(stateOf(pathB)).toBe("idle");
			break whileAHangs;
		}

		// A is the active session here, so the existing global abort ends its run;
		// the aborted stream lands as an `error` event and the state must say so.
		service.abort();
		await waitFor(() => aborted.get(HANG_A) === true);
		await waitFor(() => !service.getSnapshot().isStreaming);

		const afterError = await states();
		const stateOfAfter = (path: string) => afterError.find((entry) => entry.path === path)?.state;
		expect(stateOfAfter(pathA)).toBe("error");
		expect(stateOfAfter(pathB)).toBe("idle");

	});

	it("a retention sweep spares the background session whose run is in flight", async () => {
		const { streamFn, entered, aborted } = multiSessionStreamFn();
		const adapter = new MemoryAdapter();
		const dataAdapter = asDataAdapter(adapter);
		const settings = defaultTestSettings();
		// Cap of 2: the third create fires a sweep whose keep count is
		// limit − protected (the focused chat and the claimed mid-run chat) = 0,
		// so every unprotected chat goes — the test names the victim instead of
		// hoping one falls out.
		const sessionManager = new ObsidianSessionManager(dataAdapter, {
			sessionDir: () => SESSION_DIR,
			retentionLimit: () => 2,
		}, "obsidian-vault:Test");
		const service = new ObsidianAgentService(createFakeApp(dataAdapter), () => settings, sessionManager, {
			streamFn,
			loadUserSkills: NO_USER_SKILLS,
		});

		// A holds a turn and then a hanging run; B is the idle leftover; C is the
		// fresh chat whose create fires the sweep. The focused chat and the
		// claimed mid-run chat each hold a slot, so B is what goes — and if the
		// claim were missing, A would go with it, mid-run.
		await service.sendPrompt("seed-a");
		const pathA = service.getSnapshot().session?.path;
		expect(pathA).toBeDefined();
		await service.newSession();
		const pathB = service.getSnapshot().session?.path;
		expect(pathB).toBeDefined();
		await service.openSession(pathA!);
		await startHang(service, HANG_A, entered);
		await service.openSession(pathB!);
		// B is the blank sheet, so the create must be forced past that guard.
		await service.newSession({ force: true });

		// The sweep really ran: the idle leftover left disk.
		expect(adapter.filePaths()).not.toContain(pathB);
		// The claim spared the mid-run chat's file…
		expect(adapter.filePaths()).toContain(pathA!);
		// …and its run never noticed any of it.
		await settleTick();
		expect(aborted.get(HANG_A)).toBe(false);
		expect(entered.get(HANG_A)).toBe(true);

		await stopRun(service, pathA!);
	});
});

/** The runtime shape this test inspects, as a narrow cast alias. */
interface MemberRuntimeProbe {
	sessionPath: string;
	memberSpec: { parentSession?: string; customTools: unknown[] } | undefined;
	agent: { state: { tools: Array<{ name: string }> } } | null;
}

describe("agent-team member sessions through the service", () => {
	/**
	 * The production seam, driven end to end: the parent conversation's model
	 * calls `team_start`, the community host's factory reaches the bridge, and
	 * the bridge reaches the service's own `createMemberSession` — the real
	 * one. Members receive real session files (decision 3), the v4 header
	 * carries `parentSessionId` (decision 1), the naming is the package's field
	 * (decision 1), and the tool set drops the full-content writer and the
	 * delegation pair (decision 5A and the layers rule).
	 */
	it("creates named, lineage-linked member sessions with a write-free tool set", async () => {
		const restore = stubWindowMembers(
			{
				crypto: webcrypto as unknown as Crypto,
				setTimeout: (callback: () => void, delay?: number) => globalThis.setTimeout(callback, delay),
				clearTimeout: (id?: number) => { if (id !== undefined) globalThis.clearTimeout(id); },
			},
		);
		try {
			const contexts = createBoundedCollector<Context>(50);
			let parentRequests = 0;
			let memberCalls = 0;
			const streamFn: StreamFn = withRunawayGuard(
				(model, context) => {
					contexts.push(captureContext(context));
					if (String(getCurrentSystemPrompt(context.messages) ?? "").includes("one symmetric worker")) {
						memberCalls += 1;
						return scriptedToolCallStream(model, `member-${memberCalls}`, "team_finish", { summary: "scripted member is done" });
					}
					parentRequests += 1;
					if (parentRequests === 1) {
						return scriptedToolCallStream(model, "team_start_1", "team_start", {
							objective: "each member finishes at once",
							members: [{ id: "m1", name: "Alice" }, { id: "m2", name: "Bob" }],
							initialMessage: "begin",
						});
					}
					return scriptedTextStream(model, "team settled");
				},
				{ maxCalls: 50, label: "multiSession.teamStreamFn" },
			);
			const service = createService(new MemoryAdapter(), streamFn);
			try {
				expect(await service.sendPrompt("Start a two-member team")).toBe(true);

				// Poll: member naming and the tool result land asynchronously.
				const deadline = Date.now() + 20_000;
				const runtimes = () => {
					const serviceRuntimes = (service as unknown as { runtimes: Map<string, MemberRuntimeProbe> }).runtimes;
					return [...serviceRuntimes.values()];
				};
				while (Date.now() < deadline) {
					if (runtimes().filter(rt => rt.memberSpec).length >= 2) break;
					await Bun.sleep(50);
				}
				const members = runtimes().filter(rt => rt.memberSpec);
				expect(members).toHaveLength(2);

				// Decision 5A + the layers rule: no `write`, no delegation pair.
				for (const member of members) {
					const names = member.agent!.state.tools.map(tool => tool.name);
					expect(names).toContain("read");
					expect(names).toContain("edit");
					expect(names).toContain("team_say");
					expect(names).not.toContain("write");
					expect(names).not.toContain("spawn_subagent");
					expect(names).not.toContain("wait_subagent");
				}

				// Decision 1: lineage through the ordinary v4 header field, and the
				// author's exact member naming in the session list.
				const parentId = service.getSnapshot().session!.id;
				const sessions = (service as unknown as { sessionManager: {
					listSessions(): Promise<Array<{ id: string; name?: string; parentSessionId?: string }>>;
					claimed: Set<string>;
				} }).sessionManager;
				while (Date.now() < deadline) {
					const listed = await sessions.listSessions();
					if (listed.filter(entry => entry.parentSessionId === parentId && entry.name).length >= 2) break;
					await Bun.sleep(50);
				}
				const listed = await sessions.listSessions();
				const linked = listed.filter(entry => entry.parentSessionId === parentId);
				expect(linked).toHaveLength(2);
				expect(linked.map(entry => entry.name).sort()).toEqual([
					"agent team · Alice (m1)", "agent team · Bob (m2)",
				]);
				// Decision 2: the team-run claim holds while the retained run lives.
				for (const member of members) {
					expect(sessions.claimed.has((member as { sessionPath: string }).sessionPath)).toBe(true);
				}
			} finally { service.dispose(); }
		} finally { restore(); }
	}, 30_000);
});

describe("run_workflow ships off unless the user asked for it", () => {
	/**
	 * The top-level tool names the current settings produce.
	 *
	 * Read off the agent rather than `buildTools`, which is private: the mounted
	 * tool list is what the model is actually offered, so a test that read the
	 * private method could pass while the agent was assembled from something else.
	 */
	async function toolNames(settings: PiemSettings): Promise<string[]> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("this test never reaches the provider"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			// One prompt drives construction; the turn ends on the throw, which is
			// after the tool set is fixed.
			await service.sendPrompt("seed").catch(() => undefined);
			const agent = (service as unknown as {
				agent?: { state: { tools: Array<{ name: string }> } };
			}).agent;
			return (agent?.state.tools ?? []).map(tool => tool.name);
		} finally {
			service.dispose();
		}
	}

	it("offers no run_workflow on a vault that never turned it on", async () => {
		expect(await toolNames(defaultTestSettings())).not.toContain("run_workflow");
	}, 30_000);

	it("offers run_workflow once the setting is on", async () => {
		const settings = { ...defaultTestSettings(), workflowEnabled: true };
		expect(await toolNames(settings)).toContain("run_workflow");
	}, 30_000);

	// The rest of the tool set is what the tests above would silently lose if the
	// gate took the wrong slice: `read` proves the vault tools survive it.
	it("leaves the rest of the tool set alone", async () => {
		expect(await toolNames(defaultTestSettings())).toContain("read");
	}, 30_000);
});

describe("codemode ships off unless the user asked for it", () => {
	async function names(settings: PiemSettings): Promise<string[]> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("this test never reaches the provider"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed").catch(() => undefined);
			const agent = (service as unknown as {
				agent?: { state: { tools: Array<{ name: string }> } };
			}).agent;
			return (agent?.state.tools ?? []).map(tool => tool.name);
		} finally {
			service.dispose();
		}
	}

	it("offers no codemode on a vault that never turned it on", async () => {
		expect(await names(defaultTestSettings())).not.toContain("codemode");
	}, 30_000);

	it("offers codemode once the setting is on", async () => {
		expect(await names({ ...defaultTestSettings(), codemodeEnabled: true })).toContain("codemode");
	}, 30_000);

	// The switch is independent of the workflow one: a reader who wants the
	// scriptable sandbox has not asked for the fixed engine, and the other way
	// round. One toggle driving both would make them impossible to separate.
	it("does not follow the workflow switch", async () => {
		expect(await names({ ...defaultTestSettings(), workflowEnabled: true })).not.toContain("codemode");
		expect(await names({ ...defaultTestSettings(), codemodeEnabled: true })).not.toContain("run_workflow");
	}, 30_000);

	// Nothing else moves: the sandbox is offered *alongside* the direct tools, not
	// instead of them, so a vault that turns it on keeps every tool it had.
	it("leaves the rest of the tool set alone", async () => {
		const mounted = await names({ ...defaultTestSettings(), codemodeEnabled: true });
		expect(mounted).toContain("read");
		expect(mounted).toContain("codemode");
	}, 30_000);
});

describe("codemode ships off unless the user asked for it", () => {
	async function names(settings: PiemSettings): Promise<string[]> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("this test never reaches the provider"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed").catch(() => undefined);
			const agent = (service as unknown as {
				agent?: { state: { tools: Array<{ name: string }> } };
			}).agent;
			return (agent?.state.tools ?? []).map(tool => tool.name);
		} finally {
			service.dispose();
		}
	}

	it("offers no codemode on a vault that never turned it on", async () => {
		expect(await names(defaultTestSettings())).not.toContain("codemode");
	}, 30_000);

	it("offers codemode once the setting is on", async () => {
		expect(await names({ ...defaultTestSettings(), codemodeEnabled: true })).toContain("codemode");
	}, 30_000);

	// The switch is independent of the workflow one: a reader who wants the
	// scriptable sandbox has not asked for the fixed engine, and the other way
	// round. One toggle driving both would make them impossible to separate.
	it("does not follow the workflow switch", async () => {
		expect(await names({ ...defaultTestSettings(), workflowEnabled: true })).not.toContain("codemode");
		expect(await names({ ...defaultTestSettings(), codemodeEnabled: true })).not.toContain("run_workflow");
	}, 30_000);

	// Nothing else moves: the sandbox is offered *alongside* the direct tools, not
	// instead of them, so a vault that turns it on keeps every tool it had.
	it("leaves the rest of the tool set alone", async () => {
		const mounted = await names({ ...defaultTestSettings(), codemodeEnabled: true });
		expect(mounted).toContain("read");
		expect(mounted).toContain("codemode");
	}, 30_000);
});

describe("run_workflow ships off unless the user asked for it", () => {
	/**
	 * The top-level tool names the current settings produce.
	 *
	 * Read off the agent rather than `buildTools`, which is private: the mounted
	 * tool list is what the model is actually offered, so a test that read the
	 * private method could pass while the agent was assembled from something else.
	 */
	async function toolNames(settings: PiemSettings): Promise<string[]> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("this test never reaches the provider"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			// One prompt drives construction; the turn ends on the throw, which is
			// after the tool set is fixed.
			await service.sendPrompt("seed").catch(() => undefined);
			const agent = (service as unknown as {
				agent?: { state: { tools: Array<{ name: string }> } };
			}).agent;
			return (agent?.state.tools ?? []).map(tool => tool.name);
		} finally {
			service.dispose();
		}
	}

	it("offers no run_workflow on a vault that never turned it on", async () => {
		expect(await toolNames(defaultTestSettings())).not.toContain("run_workflow");
	}, 30_000);

	it("offers run_workflow once the setting is on", async () => {
		const settings = { ...defaultTestSettings(), workflowEnabled: true };
		expect(await toolNames(settings)).toContain("run_workflow");
	}, 30_000);

	// The rest of the tool set is what the tests above would silently lose if the
	// gate took the wrong slice: `read` proves the vault tools survive it.
	it("leaves the rest of the tool set alone", async () => {
		expect(await toolNames(defaultTestSettings())).toContain("read");
	}, 30_000);
});

describe("codemode ships off unless the user asked for it", () => {
	async function names(settings: PiemSettings): Promise<string[]> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("this test never reaches the provider"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed").catch(() => undefined);
			const agent = (service as unknown as {
				agent?: { state: { tools: Array<{ name: string }> } };
			}).agent;
			return (agent?.state.tools ?? []).map(tool => tool.name);
		} finally {
			service.dispose();
		}
	}

	it("offers no codemode on a vault that never turned it on", async () => {
		expect(await names(defaultTestSettings())).not.toContain("codemode");
	}, 30_000);

	it("offers codemode once the setting is on", async () => {
		expect(await names({ ...defaultTestSettings(), codemodeEnabled: true })).toContain("codemode");
	}, 30_000);

	// The switch is independent of the workflow one: a reader who wants the
	// scriptable sandbox has not asked for the fixed engine, and the other way
	// round. One toggle driving both would make them impossible to separate.
	it("does not follow the workflow switch", async () => {
		expect(await names({ ...defaultTestSettings(), workflowEnabled: true })).not.toContain("codemode");
		expect(await names({ ...defaultTestSettings(), codemodeEnabled: true })).not.toContain("run_workflow");
	}, 30_000);

	// Nothing else moves: the sandbox is offered *alongside* the direct tools, not
	// instead of them, so a vault that turns it on keeps every tool it had.
	it("leaves the rest of the tool set alone", async () => {
		const mounted = await names({ ...defaultTestSettings(), codemodeEnabled: true });
		expect(mounted).toContain("read");
		expect(mounted).toContain("codemode");
	}, 30_000);
});

describe("codemode ships off unless the user asked for it", () => {
	async function names(settings: PiemSettings): Promise<string[]> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("this test never reaches the provider"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed").catch(() => undefined);
			const agent = (service as unknown as {
				agent?: { state: { tools: Array<{ name: string }> } };
			}).agent;
			return (agent?.state.tools ?? []).map(tool => tool.name);
		} finally {
			service.dispose();
		}
	}

	it("offers no codemode on a vault that never turned it on", async () => {
		expect(await names(defaultTestSettings())).not.toContain("codemode");
	}, 30_000);

	it("offers codemode once the setting is on", async () => {
		expect(await names({ ...defaultTestSettings(), codemodeEnabled: true })).toContain("codemode");
	}, 30_000);

	// The switch is independent of the workflow one: a reader who wants the
	// scriptable sandbox has not asked for the fixed engine, and the other way
	// round. One toggle driving both would make them impossible to separate.
	it("does not follow the workflow switch", async () => {
		expect(await names({ ...defaultTestSettings(), workflowEnabled: true })).not.toContain("codemode");
		expect(await names({ ...defaultTestSettings(), codemodeEnabled: true })).not.toContain("run_workflow");
	}, 30_000);

	// Nothing else moves: the sandbox is offered *alongside* the direct tools, not
	// instead of them, so a vault that turns it on keeps every tool it had.
	it("leaves the rest of the tool set alone", async () => {
		const mounted = await names({ ...defaultTestSettings(), codemodeEnabled: true });
		expect(mounted).toContain("read");
		expect(mounted).toContain("codemode");
	}, 30_000);
});

describe("a codemode script's nested call goes through the agent's own tool path", () => {
	/**
	 * The last seam the unit tests cannot reach.
	 *
	 * `sandbox.test.ts` proves a script's call reaches whatever host it is given,
	 * but not that the host is `runToolCall` — which is the difference between a
	 * nested call and a direct one. This drives the real service with a real agent
	 * and calls the private bridge, because that is the only place the wiring
	 * exists.
	 */
	async function nestedCall(settings: PiemSettings, args: { name: string; args: JsonObject }): Promise<AgentToolResult> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				// One completed reply, so an agent exists with its tool set mounted.
				streamFn: echoStreamFn(),
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed");
			const bridge = (service as unknown as {
				executeNestedTool(name: string, args: JsonObject, signal: AbortSignal): Promise<AgentToolResult>;
			}).executeNestedTool.bind(service);
			return await bridge(args.name, args.args, new AbortController().signal);
		} finally {
			service.dispose();
		}
	}

	it("runs a real tool and hands the script its content", async () => {
		// Valid against `grep`'s own schema, so the only thing left to prove is that
		// the call reached the tool at all.
		const result = await nestedCall(defaultTestSettings(), {
			name: "grep",
			args: { pattern: "TODO" } as JsonObject,
		});
		expect(result.isError).toBeFalsy();
		// An empty vault matches nothing, and the tool says so rather than failing —
		// which is what distinguishes "ran and found nothing" from "never ran".
		expect(result.content?.[0]).toMatchObject({ type: "text" });
	}, 30_000);

	it("reports an unknown tool as an error rather than throwing", async () => {
		// `runToolCall` never rejects for a tool failure; an unknown name is one.
		// A rejection here would take the whole script down instead of letting it
		// decide whether a miss matters.
		const result = await nestedCall(defaultTestSettings(), {
			name: "no_such_tool",
			args: {} as JsonObject,
		});
		expect(result.isError).toBe(true);
	}, 30_000);

	it("refuses a call whose arguments do not match the tool's schema", async () => {
		// The reason this goes through `runToolCall` and not `agentTool.execute`:
		// validation is part of the path, so a script cannot smuggle past it.
		const result = await nestedCall(defaultTestSettings(), {
			name: "grep",
			args: { wrong: 1 } as JsonObject,
		});
		expect(result.isError).toBe(true);
	}, 30_000);
});

describe("a codemode script's nested call goes through the agent's own tool path", () => {
	/**
	 * The last seam the unit tests cannot reach.
	 *
	 * `sandbox.test.ts` proves a script's call reaches whatever host it is given,
	 * but not that the host is `runToolCall` — which is the difference between a
	 * nested call and a direct one. This drives the real service with a real agent
	 * and calls the private bridge, because that is the only place the wiring
	 * exists.
	 */
	async function nestedCall(settings: PiemSettings, args: { name: string; args: JsonObject }): Promise<AgentToolResult> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				// One completed reply, so an agent exists with its tool set mounted.
				streamFn: echoStreamFn(),
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed");
			const bridge = (service as unknown as {
				executeNestedTool(name: string, args: JsonObject, signal: AbortSignal): Promise<AgentToolResult>;
			}).executeNestedTool.bind(service);
			return await bridge(args.name, args.args, new AbortController().signal);
		} finally {
			service.dispose();
		}
	}

	it("runs a real tool and hands the script its content", async () => {
		// Valid against `grep`'s own schema, so the only thing left to prove is that
		// the call reached the tool at all.
		const result = await nestedCall(defaultTestSettings(), {
			name: "grep",
			args: { pattern: "TODO" } as JsonObject,
		});
		expect(result.isError).toBeFalsy();
		// An empty vault matches nothing, and the tool says so rather than failing —
		// which is what distinguishes "ran and found nothing" from "never ran".
		expect(result.content?.[0]).toMatchObject({ type: "text" });
	}, 30_000);

	it("reports an unknown tool as an error rather than throwing", async () => {
		// `runToolCall` never rejects for a tool failure; an unknown name is one.
		// A rejection here would take the whole script down instead of letting it
		// decide whether a miss matters.
		const result = await nestedCall(defaultTestSettings(), {
			name: "no_such_tool",
			args: {} as JsonObject,
		});
		expect(result.isError).toBe(true);
	}, 30_000);

	it("refuses a call whose arguments do not match the tool's schema", async () => {
		// The reason this goes through `runToolCall` and not `agentTool.execute`:
		// validation is part of the path, so a script cannot smuggle past it.
		const result = await nestedCall(defaultTestSettings(), {
			name: "grep",
			args: { wrong: 1 } as JsonObject,
		});
		expect(result.isError).toBe(true);
	}, 30_000);
});

describe("codemode's mode decides what the model is offered", () => {
	async function mounted(settings: PiemSettings): Promise<Array<{ name: string; description: string }>> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("this test never reaches the provider"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed").catch(() => undefined);
			const agent = (service as unknown as { agent?: { state: { tools: Array<{ name: string; description: string }> } } }).agent;
			return agent?.state.tools ?? [];
		} finally {
			service.dispose();
		}
	}

	const withMode = (mode: "on" | "only") => ({ ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: mode });

	it("on withholds nothing", async () => {
		const names = (await mounted(withMode("on"))).map((tool) => tool.name);
		expect(names).toContain("codemode");
		expect(names).toContain("read");
	}, 30_000);

	it("only withholds the direct tools, leaving codemode as the one way in", async () => {
		// The point of the mode: a model that cannot see a tool cannot skip the
		// sandbox to reach it. This is also cheaper per request than shipping both —
		// one capped block replaces every tool's declaration.
		const tools = await mounted(withMode("only"));
		expect(tools.map((tool) => tool.name)).toEqual(["codemode"]);
	}, 30_000);

	it("on appends the script sample to a tool's own description", async () => {
		// The model already reads this description, so the sample lands on ground it
		// is standing on rather than in a second catalog it has to hold alongside it.
		const read = (await mounted(withMode("on"))).find((tool) => tool.name === "read");
		expect(read?.description).toMatch(/codemode tool declaration/);
		expect(read?.description).toMatch(/declare const tools/);
	}, 30_000);

	it("only leaves descriptions alone, because the tool is not offered at all", async () => {
		const tools = await mounted(withMode("only"));
		expect(tools.find((tool) => tool.name === "read")).toBeUndefined();
	}, 30_000);

	it("adds no sample when codemode is off, whatever the mode says", async () => {
		const read = (await mounted({ ...defaultTestSettings(), codemodeEnabled: false, codemodeMode: "on" }))
			.find((tool) => tool.name === "read");
		expect(read?.description).not.toMatch(/codemode tool declaration/);
	}, 30_000);

	it("reads the mode through a getter, so a settings change reaches a live conversation", async () => {
		// The service hands the tool a getter rather than a snapshot. Getting that
		// wrong is silent in a different way: an object-literal getter's `this` is
		// the literal, so the read throws and every description read fails.
		const tool = new ObsidianAgentService(createFakeApp(asDataAdapter(new MemoryAdapter())), () => defaultTestSettings(),
			new ObsidianSessionManager(asDataAdapter(new MemoryAdapter()), SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("never"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			}).getCodemodeTool();
		expect(() => tool.description).not.toThrow();
	}, 30_000);
});

describe("codemode's mode decides what the model is offered", () => {
	async function mounted(settings: PiemSettings): Promise<Array<{ name: string; description: string }>> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("this test never reaches the provider"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed").catch(() => undefined);
			const agent = (service as unknown as { agent?: { state: { tools: Array<{ name: string; description: string }> } } }).agent;
			return agent?.state.tools ?? [];
		} finally {
			service.dispose();
		}
	}

	const withMode = (mode: "on" | "only") => ({ ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: mode });

	it("on withholds nothing", async () => {
		const names = (await mounted(withMode("on"))).map((tool) => tool.name);
		expect(names).toContain("codemode");
		expect(names).toContain("read");
	}, 30_000);

	it("only withholds the direct tools, leaving codemode as the one way in", async () => {
		// The point of the mode: a model that cannot see a tool cannot skip the
		// sandbox to reach it. This is also cheaper per request than shipping both —
		// one capped block replaces every tool's declaration.
		const tools = await mounted(withMode("only"));
		expect(tools.map((tool) => tool.name)).toEqual(["codemode"]);
	}, 30_000);

	it("on appends the script sample to a tool's own description", async () => {
		// The model already reads this description, so the sample lands on ground it
		// is standing on rather than in a second catalog it has to hold alongside it.
		const read = (await mounted(withMode("on"))).find((tool) => tool.name === "read");
		expect(read?.description).toMatch(/codemode tool declaration/);
		expect(read?.description).toMatch(/declare const tools/);
	}, 30_000);

	it("only leaves descriptions alone, because the tool is not offered at all", async () => {
		const tools = await mounted(withMode("only"));
		expect(tools.find((tool) => tool.name === "read")).toBeUndefined();
	}, 30_000);

	it("adds no sample when codemode is off, whatever the mode says", async () => {
		const read = (await mounted({ ...defaultTestSettings(), codemodeEnabled: false, codemodeMode: "on" }))
			.find((tool) => tool.name === "read");
		expect(read?.description).not.toMatch(/codemode tool declaration/);
	}, 30_000);

	it("reads the mode through a getter, so a settings change reaches a live conversation", async () => {
		// The service hands the tool a getter rather than a snapshot. Getting that
		// wrong is silent in a different way: an object-literal getter's `this` is
		// the literal, so the read throws and every description read fails.
		const tool = new ObsidianAgentService(createFakeApp(asDataAdapter(new MemoryAdapter())), () => defaultTestSettings(),
			new ObsidianSessionManager(asDataAdapter(new MemoryAdapter()), SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: (() => { throw new Error("never"); }) as unknown as StreamFn,
				loadUserSkills: NO_USER_SKILLS,
			}).getCodemodeTool();
		expect(() => tool.description).not.toThrow();
	}, 30_000);
});

it("codemode only sends one callable tool and script-only guidance to the provider", async () => {
	const adapter = asDataAdapter(new MemoryAdapter());
	const contexts: Context[] = [];
	const settings = { ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "only" as const };
	const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
		new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
			streamFn: (model, context) => {
				contexts.push(captureContext(context));
				return scriptedTextStream(model, "done");
			},
			loadUserSkills: NO_USER_SKILLS,
		});
	try {
		await service.sendPrompt("fresh only session");
		await service.sendPrompt("/codemode on");
		await service.sendPrompt("direct tools enabled");
		await service.sendPrompt("/codemode only");
		await service.sendPrompt("back to scripts");
		expect(contexts).toHaveLength(3);
		expect(contexts[1]?.tools?.map(tool => tool.name)).toContain("read");
		for (const context of [contexts[0], contexts[2]]) {
			expect(context?.tools?.map(tool => tool.name)).toEqual(["codemode"]);
			const description = context?.tools?.[0]?.description ?? "";
			expect(description).not.toMatch(/call (?:tools|it|them) directly/i);
			expect(description).toContain("only callable tool");
			expect(description).toContain("ALL_TOOLS.filter");
		}
	} finally {
		service.dispose();
	}
}, 30_000);

describe("codemode `only` does not withhold the catalog from the sandbox itself", () => {
	it("a script can still reach the tools the model can no longer see", async () => {
		// The mode working against itself is the failure this pins: `only` removes
		// the direct tools from `agent.state.tools`, and the sandbox read its
		// callable list from there — so the script would have been written against
		// an empty `tools` and the model would have been told to use a sandbox that
		// could do nothing.
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter),
			() => ({ ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "only" }) as PiemSettings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: echoStreamFn(),
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed");
			const agent = (service as unknown as { agent?: { state: { tools: Array<{ name: string }> } } }).agent;
			const mounted = agent?.state.tools.map((tool) => tool.name) ?? [];
			expect(mounted).toEqual(["codemode"]);
			// The catalog the model reads is the whole point, and it comes from the
			// same place the script's callable list does.
			expect(service.getCodemodeTool().description ?? "").toMatch(/declare const tools/);
			expect(service.getCodemodeTool().description ?? "").toMatch(/read\(args: /);
		} finally {
			service.dispose();
		}
	}, 30_000);

	it("`on` reports the same catalog through the tools' own descriptions", async () => {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter),
			() => ({ ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "on" }) as PiemSettings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: echoStreamFn(),
				loadUserSkills: NO_USER_SKILLS,
			});
		try {
			await service.sendPrompt("seed");
			expect(service.getCodemodeTool().description ?? "").not.toMatch(/declare const tools/);
		} finally {
			service.dispose();
		}
	}, 30_000);

	it("`only` withholds an MCP server's tools from the model and keeps them scriptable", async () => {
		// The one class of tool the mode used to miss: MCP tools were spliced into
		// the mounted set outside `buildTools`, after the filter, so a server's
		// tools reached the model no matter what the mode promised. They belong on
		// the same side of the gate as everything else — hidden from the model,
		// present in the catalog a script reads.
		const adapter = asDataAdapter(new MemoryAdapter());
		const probe = {
			name: "mcp_probe", label: "probe", description: "A mounted MCP tool.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "probe-ok" }], details: undefined }),
		};
		const service = new ObsidianAgentService(createFakeApp(adapter),
			() => ({ ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "only" }) as PiemSettings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: echoStreamFn(),
				loadUserSkills: NO_USER_SKILLS,
				getMountedExternalTools: () => [probe],
			});
		try {
			await service.sendPrompt("seed");
			const agent = (service as unknown as { agent?: { state: { tools: Array<{ name: string }> } } }).agent;
			const mounted = agent?.state.tools.map((tool) => tool.name) ?? [];
			expect(mounted).toContain("codemode");
			expect(mounted).not.toContain("read");
			expect(mounted).not.toContain("mcp_probe");
			// Scriptable is a fact about `scriptTools` — the array the sandbox's
			// registry and the nested executor both read — not about the catalog's
			// rendering, which the budget may truncate (and `tool.test.ts` covers).
			const scriptable = (service as unknown as { current(): { scriptTools?: Array<{ name: string }> } })
				.current()?.scriptTools?.map((tool) => tool.name) ?? [];
			expect(scriptable).toContain("mcp_probe");
			expect(scriptable).toContain("read");
		} finally {
			service.dispose();
		}
	}, 30_000);

	it("`only` leaves the withheld tools callable from a script, vault tools and MCP tools alike", async () => {
		// The executor used to resolve a script's call against the mounted set —
		// the very list the mode empties — so every script call came back
		// "Tool read not found" and the sandbox could only do arithmetic. It
		// resolves against `scriptTools` now: what the catalog promised is what
		// runs, whichever provider shipped the tool.
		const adapter = asDataAdapter(new MemoryAdapter());
		const probe = {
			name: "mcp_probe", label: "probe", description: "A mounted MCP tool.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "probe-ok" }], details: undefined }),
		};
		const service = new ObsidianAgentService(createFakeApp(adapter),
			() => ({ ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "only" }) as PiemSettings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: echoStreamFn(),
				loadUserSkills: NO_USER_SKILLS,
				getMountedExternalTools: () => [probe],
			});
		const nested = (name: string, args: JsonObject) =>
			(service as unknown as {
				executeNestedTool(name: string, args: JsonObject, signal: AbortSignal): Promise<AgentToolResult>;
			}).executeNestedTool(name, args, new AbortController().signal);
		try {
			await service.sendPrompt("seed");
			const direct = await nested("ls", {});
			expect(JSON.stringify(direct)).not.toContain("not found");
			const external = await nested("mcp_probe", {});
			expect(external.isError).not.toBe(true);
			expect(external.content[0]).toEqual({ type: "text", text: "probe-ok" });
		} finally {
			service.dispose();
		}
	}, 30_000);
});

describe("parseCodemodeArgument", () => {
	it("reports when there is nothing to change to", () => {
		// A command that changed something in answer to a question would be the
		// wrong kind of surprise.
		expect(parseCodemodeArgument(undefined)).toEqual({ kind: "report" });
		expect(parseCodemodeArgument("   ")).toEqual({ kind: "report" });
	});

	const WORDS: [string, CodemodeSessionMode][] = [
		["on", "on"], ["both", "on"], ["ON", "on"],
		["only", "only"], ["scripts", "only"],
		["off", "off"], ["none", "off"],
	];
	it.each(WORDS)("reads %s as %s", (word, mode) => {
		expect(parseCodemodeArgument(word)).toEqual({ kind: "set", mode });
	});

	it("has no `vault` to follow any more, and says so rather than pretending", () => {
		// Session-scoped overrides are gone: the settings page and the command are
		// two surfaces over the same two fields, so there is nothing to hand the
		// decision back to. A reader who types the old word gets the same honest
		// refusal as any other unknown word.
		expect(parseCodemodeArgument("vault")).toEqual({ kind: "unknown", argument: "vault" });
		expect(parseCodemodeArgument("settings")).toEqual({ kind: "unknown", argument: "settings" });
		expect(parseCodemodeArgument("maybe")).toEqual({ kind: "unknown", argument: "maybe" });
	});

	it("does not accept a word that only looks like one", () => {
		expect(parseCodemodeArgument("only-ish")).toEqual({ kind: "unknown", argument: "only-ish" });
	});
});

describe("/codemode", () => {
	async function chat(settings: PiemSettings, serviceOptions: Record<string, unknown> = {}): Promise<{
		service: ObsidianAgentServiceType;
		mounted: () => string[];
		send: (prompt: string) => Promise<boolean>;
	}> {
		const adapter = asDataAdapter(new MemoryAdapter());
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: echoStreamFn(),
				loadUserSkills: NO_USER_SKILLS,
				...serviceOptions,
			});
		await service.sendPrompt("seed");
		return {
			service,
			mounted: () => (service as unknown as { agent?: { state: { tools: Array<{ name: string }> } } })
				.agent?.state.tools.map((tool) => tool.name) ?? [],
			send: (prompt: string) => service.sendPrompt(prompt),
		};
	}

	it("is offered in the composer alongside the other built-ins", async () => {
		// A command nobody can see in the autocomplete is a command nobody finds.
		const { service } = await chat(defaultTestSettings());
		try {
			const list = (service as unknown as { commandList(rt: unknown): Array<{ name: string }> }).commandList(null);
			expect(list.map((entry) => entry.name)).toContain("codemode");
		} finally { service.dispose(); }
	}, 30_000);

	it("reports the current mode with no argument, and changes nothing", async () => {
		const { service, send, mounted } = await chat({ ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "only" as const });
		try {
			expect(mounted()).not.toContain("read");
			await send("/codemode");
			expect(mounted()).not.toContain("read");
		} finally { service.dispose(); }
	}, 30_000);

	it("writes the vault setting — the settings page and the command are one switch", async () => {
		// The command's whole job is to be the composer's handle on the same two
		// fields the settings page renders. Writing anything else (a session-local
		// override, an in-memory only answer) is how the two surfaces drift apart.
		const settings = { ...defaultTestSettings() };
		const { service, send, mounted } = await chat(settings);
		try {
			expect(mounted()).not.toContain("codemode");
			await send("/codemode only");
			expect(settings.codemodeEnabled).toBe(true);
			expect(settings.codemodeMode).toBe("only");
			expect(mounted()).not.toContain("read");
			expect(mounted()).toContain("codemode");
		} finally { service.dispose(); }
	}, 30_000);

	it("applies to every conversation, not just the one that asked", async () => {
		// One answer for the vault is the semantic: a new chat must not come up
		// with the mode the previous conversation was still holding.
		const { service, send, mounted } = await chat(defaultTestSettings());
		try {
			await send("/codemode only");
			expect(mounted()).toContain("codemode");
			await service.newSession({ force: true });
			await service.sendPrompt("seed").catch(() => undefined);
			expect(mounted()).not.toContain("read");
			expect(mounted()).toContain("codemode");
		} finally { service.dispose(); }
	}, 30_000);

	it("turns the tool off by writing the setting off", async () => {
		const settings = { ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "only" as const };
		const { service, send, mounted } = await chat(settings);
		try {
			expect(mounted()).not.toContain("read");
			await send("/codemode off");
			expect(settings.codemodeEnabled).toBe(false);
			expect(mounted()).toContain("read");
			expect(mounted()).not.toContain("codemode");
		} finally { service.dispose(); }
	}, 30_000);

	it("turns the tool on even when the vault had it off", async () => {
		const settings = { ...defaultTestSettings() };
		const { service, send, mounted } = await chat(settings);
		try {
			expect(mounted()).not.toContain("codemode");
			await send("/codemode on");
			expect(settings.codemodeEnabled).toBe(true);
			expect(mounted()).toContain("codemode");
			expect(mounted()).toContain("read");
		} finally { service.dispose(); }
	}, 30_000);

	it("treats `vault` as unknown now that there is nothing to hand back", async () => {
		const settings = { ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "on" as const };
		const { service, send, mounted } = await chat(settings);
		try {
			await send("/codemode vault");
			expect(settings.codemodeMode).toBe("on");
			expect(mounted()).toContain("read");
		} finally { service.dispose(); }
	}, 30_000);

	it("reports an unknown word rather than pretending", async () => {
		const { service, send, mounted } = await chat({ ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "on" as const });
		try {
			await send("/codemode maybe");
			expect(mounted()).toContain("read");
		} finally { service.dispose(); }
	}, 30_000);

	it("never reaches the model", async () => {
		// A command that changed something and then also sent a message would have
		// the model narrate a change it did not make.
		const { service, send } = await chat({ ...defaultTestSettings(), codemodeEnabled: true });
		try {
			await expect(send("/codemode only")).resolves.toBe(false);
		} finally { service.dispose(); }
	}, 30_000);

	it("does not save when the mode asked for is already the mode on disk", async () => {
		// An unchanged save would be a no-op with a toast claiming otherwise — and
		// worse, it would reconfigure the agent for nothing.
		const saves: number[] = [];
		const adapter = asDataAdapter(new MemoryAdapter());
		const settings = { ...defaultTestSettings(), codemodeEnabled: true, codemodeMode: "on" as const };
		const service = new ObsidianAgentService(createFakeApp(adapter), () => settings,
			new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test"), {
				streamFn: echoStreamFn(),
				loadUserSkills: NO_USER_SKILLS,
				persistSettings: async () => { saves.push(Date.now()); },
			});
		try {
			await service.sendPrompt("seed");
			await service.sendPrompt("/codemode on");
			expect(saves.length).toBe(0);
			await service.sendPrompt("/codemode only");
			expect(saves.length).toBe(1);
		} finally { service.dispose(); }
	}, 30_000);
});
