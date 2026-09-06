import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { App, DataAdapter, ListedFiles, Stat } from "obsidian";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { DEFAULT_SESSION_RETENTION } from "../session/retention";
import { DEFAULT_SESSION_DIR } from "../session/sessionDir";
import { DEFAULT_LOG_LEVEL } from "../logging/logLevel";
import type { PiemSettings } from "../settings";
import type { ObsidianAgentService as ObsidianAgentServiceType } from "./ObsidianAgentService";
import type { UserSkillsLoad } from "../skills/userSkills";

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
	const streamFn: StreamFn = (model, context, options) => {
		const prompt = lastUserPromptText(context);
		if (prompt === HANG_A || prompt === HANG_B) {
			entered.set(prompt, true);
			return hangingStream(model, options, () => aborted.set(prompt, true));
		}
		return scriptedTextStream(model, `pong:${prompt}`);
	};
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
	const streamFn: StreamFn = (model, context) => {
		const prompt = lastUserPromptText(context);
		if (!prompt.startsWith("slow-")) {
			return scriptedTextStream(model, `pong:${prompt}`);
		}
		const stream = createAssistantMessageEventStream();
		held.set(prompt, { stream, model });
		started.add(prompt);
		return stream;
	};
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
function scriptedToolCallStream(model: Model<Api>, callId: string, toolName: string, toolArguments: Record<string, unknown>) {
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
	const streamFn: StreamFn = (model, context) => {
		// The subagent system prompt is the only thing that names a delegated task —
		// same discriminator the service's own delegation test uses.
		if (context.systemPrompt?.includes("delegated task") ?? false) {
			const stream = createAssistantMessageEventStream();
			child = { stream, model };
			return stream;
		}
		if (!spawned) {
			spawned = true;
			return scriptedToolCallStream(model, "spawn_1", "spawn_subagent", { task: "Sweep the vault", role: "scout" });
		}
		return scriptedTextStream(model, "delegated");
	};
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

/** An immediate echo script: every prompt gets `pong:<prompt>` back. */
function echoStreamFn(): StreamFn {
	return (model: Model<Api>, context: Context) => scriptedTextStream(model, `pong:${lastUserPromptText(context)}`);
}

// ---------------------------------------------------------------------------
// Shared sequencing
// ---------------------------------------------------------------------------

/** Seeds two sessions: A holds one echoed turn, B is the freshly minted sheet. */
async function seedTwoSessions(service: ObsidianAgentServiceType): Promise<{ pathA: string; pathB: string }> {
	await service.sendPrompt("seed-a");
	const pathA = service.getSnapshot().session?.path;
	expect(pathA).toBeDefined();
	await service.newSession();
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
