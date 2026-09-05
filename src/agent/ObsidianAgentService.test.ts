import { describe, expect, it } from "bun:test";
import { installObsidianStub, requestUrlMock, resetNotices, shownNotices } from "../testUtils/obsidianStub";
import type { App, DataAdapter, ListedFiles, Stat, TFile, TFolder } from "obsidian";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentMessage, OperationStartedRecord, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PromptQueue } from "./promptQueue";
import type { SessionRuntime } from "./SessionRuntime";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { DEFAULT_SESSION_RETENTION } from "../session/retention";
import { DEFAULT_SESSION_DIR } from "../session/sessionDir";
import { DEFAULT_LOG_LEVEL } from "../logging/logLevel";
import type { PiemSettings } from "../settings";
import type { ObsidianAgentService as ObsidianAgentServiceType, PendingToolCall } from "./ObsidianAgentService";
import type { UserSkillsLoad } from "../skills/userSkills";
import { spyLogger } from "../testUtils/logSpy";
import { getT } from "../i18n";
import type { LoggerLike } from "../logging/Logger";

installObsidianStub();

// Dynamic imports so the mocked module wins over any cached real one.
const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { OBSIDIAN_AGENT_SYSTEM_PROMPT } = await import("./systemPrompt");
const { TFile: TFileClass, TFolder: TFolderClass } = await import("obsidian");
const { MAX_ACTIVE_NOTE_CHARS } = await import("./contextInjection");
// `settings.ts` imports `obsidian` at runtime; this import must stay behind
// the stub registration above.
const { DEFAULT_SETTINGS } = await import("../settings");

// Tests drive ObsidianSessionManager directly, so the directory is supplied here
// rather than derived from a Vault; `Vault#configDir` is used in production code.
const SESSION_DIR = `.${"obsidian"}/plugins/piem/sessions`;

// The real home directory may hold user-level skills, and a test that asserts
// on the composed prompt has to be hermetic — every service gets an empty loader.
// `searched` is empty rather than listing the built-in pair: nothing probed
// them here, and a stub that claimed a look would be the very lie
// `UserSkillsSearchEntry.found` distinguishes.
const NO_USER_SKILLS = async (): Promise<UserSkillsLoad> => ({ skills: [], diagnostics: [], searched: [] });

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

	/** Stands in for a vault whose OS trash works, matching the preferred path. */
	async trashSystem(path: string): Promise<boolean> {
		this.files.delete(path);
		return true;
	}

	async trashLocal(path: string): Promise<void> {
		this.files.delete(path);
	}

	/** The atomic publish step pi's `repo.fork` finishes a staged file with. */
	async rename(path: string, newPath: string): Promise<void> {
		const file = this.files.get(path);
		if (!file) {
			throw new Error(`Missing file: ${path}`);
		}
		this.files.delete(path);
		this.files.set(newPath, { ...file, mtime: Date.now() });
	}
}

/** A vault whose OS trash is disabled, so deletion has to reach `.trash`. */
class LocalTrashOnlyAdapter extends MemoryAdapter {
	async trashSystem(): Promise<boolean> {
		return false;
	}
}

/** Polls until the condition holds; the run's steps are async, not observable by await alone. */
function waitFor(condition: () => boolean): Promise<void> {
	return new Promise((resolve) => {
		const tick = () => (condition() ? resolve() : setTimeout(tick, 1));
		tick();
	});
}

class UntrashableAdapter extends MemoryAdapter {
	async trashSystem(): Promise<boolean> {
		throw new Error("Trash is unavailable.");
	}

	async trashLocal(): Promise<void> {
		throw new Error("Trash is unavailable.");
	}
}

describe("ObsidianAgentService", () => {
	it("notifies listeners after a prompt settles", async () => {
		const service = createService();
		const snapshots = [service.getSnapshot()];
		service.subscribe((snapshot) => snapshots.push(snapshot));

		await service.sendPrompt("Hello");

		const lastSnapshot = snapshots[snapshots.length - 1];
		expect(lastSnapshot?.isStreaming).toBe(false);
		expect(lastSnapshot?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("runs a delegated task on an in-process subagent and folds the report back in", async () => {
		// Full chain, no mocks of the machinery under test: the parent model
		// spawns a subagent and waits for it, the tool builds a real child
		// `Agent`, the child's own turn is answered by the same scripted
		// streamFn, and the parent gets the report as a wait result and answers
		// the user. One streamFn plays both roles, dispatched on the system
		// prompt only the subagent prompt contains.
		const childToolNames: string[][] = [];
		const scripted: StreamFn = (model, context, options) => {
			const isChild = context.systemPrompt?.includes("delegated task") ?? false;
			if (isChild) {
				childToolNames.push((context.tools ?? []).map((tool) => tool.name));
				return scriptedTextStream(model, "Scout report: nothing to organize.");
			}
			if (!thisParentCalled) {
				thisParentCalled = true;
				return scriptedToolCallStream(model, "spawn_1", "spawn_subagent", {
					task: "Sweep the vault",
					role: "scout",
				});
			}
			if (thisWaits === 0) {
				thisWaits += 1;
				return scriptedToolCallStream(model, "wait_1", "wait_subagent", {});
			}
			return scriptedTextStream(model, "Nothing needs organizing.");
		};
		let thisParentCalled = false;
		let thisWaits = 0;

		const service = createService(new MemoryAdapter(), { streamFn: scripted });
		await service.sendPrompt("Tidy check, please");

		const snapshot = service.getSnapshot();
		expect(snapshot.errorMessage).toBeUndefined();
		const last = snapshot.messages[snapshot.messages.length - 1];
		expect(last?.role).toBe("assistant");
		expect(JSON.stringify(last)).toContain("Nothing needs organizing.");
		// The wait result carried the child's report into the parent transcript.
		expect(JSON.stringify(snapshot.messages)).toContain("Scout report: nothing to organize.");

		// The child runs on the full vault set — mutators and the skill reader
		// included, since roles no longer strip anything — and may itself spawn
		// one further level (the cap is the next test's job).
		expect(childToolNames).toHaveLength(1);
		expect(childToolNames[0]).toContain("spawn_subagent");
		expect(childToolNames[0]).toContain("wait_subagent");
		expect(childToolNames[0]).toContain("read_skill");
		expect(childToolNames[0]).toContain("write");
		expect(childToolNames[0]).toContain("grep");
	});

	it("lets a child spawn once more and caps the tree below that", async () => {
		// Same scripted streamFn plays three agents. A subagent whose tool set
		// still carries `spawn_subagent` is answered with one more spawn; a set
		// without it has hit the depth floor and must produce the report. The
		// child is the only agent at depth ≤ 1, so counting its requests tells
		// its first turn (spawn) from its second (wait) from its third (report).
		const childToolNames: string[][] = [];
		const grandchildToolNames: string[][] = [];
		let childRequests = 0;
		let parentCalls = 0;
		const scripted: StreamFn = (model, context, options) => {
			const isSubagent = context.systemPrompt?.includes("delegated task") ?? false;
			if (!isSubagent) {
				parentCalls += 1;
				if (parentCalls === 1) {
					return scriptedToolCallStream(model, "spawn_1", "spawn_subagent", {
						task: "Sweep the vault",
						role: "general",
					});
				}
				if (parentCalls === 2) {
					return scriptedToolCallStream(model, "wait_1", "wait_subagent", {});
				}
				return scriptedTextStream(model, "Folded in.");
			}
			const names = (context.tools ?? []).map((tool) => tool.name);
			if (names.includes("spawn_subagent")) {
				childToolNames.push(names);
				childRequests += 1;
				if (childRequests === 1) {
					return scriptedToolCallStream(model, "spawn_2", "spawn_subagent", { task: "Narrow sweep" });
				}
				if (childRequests === 2) {
					return scriptedToolCallStream(model, "wait_2", "wait_subagent", {});
				}
				return scriptedTextStream(model, "Child report: all clear.");
			}
			grandchildToolNames.push(names);
			return scriptedTextStream(model, "Floor report: all clear.");
		};

		const service = createService(new MemoryAdapter(), { streamFn: scripted });
		await service.sendPrompt("Two-level sweep, please");

		const snapshot = service.getSnapshot();
		expect(snapshot.errorMessage).toBeUndefined();
		const last = snapshot.messages[snapshot.messages.length - 1];
		expect(JSON.stringify(last)).toContain("Folded in.");
		// The grandchild ran on a real tool set with no way to recurse further.
		expect(grandchildToolNames).toHaveLength(1);
		expect(grandchildToolNames[0]).not.toContain("spawn_subagent");
		expect(grandchildToolNames[0]).toContain("grep");
		expect(childToolNames).toHaveLength(3);
	});

	it("reports usage once the provider has charged for a turn", async () => {
		const service = createService();

		expect(service.getSnapshot().usage.requests).toBe(0);
		await service.sendPrompt("Hello");

		expect(service.getSnapshot().usage.requests).toBe(1);
	});

	it("reaches a custom endpoint configured after the agent was built", async () => {
		// Regression: `replaceAgent` used to capture `createObsidianStreamFn(...)`
		// once, freezing the provider registry at construction-time settings. An
		// endpoint configured afterwards left the agent holding a `Models` that
		// had never registered `custom`, so every send failed with
		// "Unknown provider: custom". The streamFn must resolve per request.
		const settings: PiemSettings = {
			...DEFAULT_SETTINGS,
			providers: [],
			models: [],
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			providerApiKeys: { deepseek: "test-key" },
			networkTransport: "requestUrl",
			showAgentDetails: false,
		traceExpand: "collapsed",
			sendShortcut: "enter",
			language: "en",
			sessionRetention: DEFAULT_SESSION_RETENTION,
			sessionDir: DEFAULT_SESSION_DIR,
			logLevel: DEFAULT_LOG_LEVEL,
		};
		const adapter = new MemoryAdapter();
		const service = new ObsidianAgentService(
			createFakeApp(asDataAdapter(adapter)),
			() => settings,
			new ObsidianSessionManager(asDataAdapter(adapter), SESSION_DIR, "obsidian-vault:Test"),
			{ loadUserSkills: NO_USER_SKILLS },
		);
		requestUrlMock.mockResolvedValue(sseResponse(replyChunks("hello")));

		// First turn on the builtin provider: this is what builds the agent, so
		// the streamFn captures whatever the registry looked like right now.
		await service.sendPrompt("Hello");
		expect(service.getSnapshot().errorMessage).toBeUndefined();

		// Then the user configures an endpoint and talks again — the exact
		// sequence that used to die with "Unknown provider: custom".
		settings.customEndpoint = { baseUrl: "https://gw.example.com/v1", apiKey: "sk-custom", modelId: "my-model" };
		await service.sendPrompt("Hello again");

		expect(service.getSnapshot().errorMessage).toBeUndefined();
		expect(requestUrlMock).toHaveBeenCalled();
		const params = requestUrlMock.mock.calls.at(-1)?.[0] as { url: string; headers: Record<string, string> };
		expect(params.url).toBe("https://gw.example.com/v1/chat/completions");
		expect(params.headers.authorization).toBe("Bearer sk-custom");
	});

	it("switches back to an earlier session and restores its transcript", async () => {
		const service = createService();
		await service.sendPrompt("First conversation");
		const firstSession = service.getSnapshot().session;

		await service.newSession();
		await service.sendPrompt("Second conversation");
		expect(service.getSnapshot().session?.id).not.toBe(firstSession?.id);

		const sessions = await service.listSessions();
		expect(sessions.length).toBeGreaterThanOrEqual(2);

		await service.openSession(firstSession?.path ?? "");

		const restored = service.getSnapshot();
		expect(restored.session?.id).toBe(firstSession?.id);
		expect(JSON.stringify(restored.messages)).toContain("First conversation");
		expect(JSON.stringify(restored.messages)).not.toContain("Second conversation");
	});

	it("keeps the blank sheet when new chat is clicked again", async () => {
		const service = createService();
		await service.initialize();
		const original = service.getSnapshot().session;

		// A chat with no turns is already what "new session" asks for; the
		// repeated clicks must not mint duplicate empty sessions behind it.
		await service.newSession();
		await service.newSession();

		expect(service.getSnapshot().session?.id).toBe(original?.id);
		expect((await service.listSessions()).length).toBe(1);
	});

	it("collapses a double-click on new chat into a single fresh session", async () => {
		const service = createService();
		await service.sendPrompt("Something to leave behind");

		// Both clicks race before the first swap lands; only one may create.
		await Promise.all([service.newSession(), service.newSession()]);

		expect((await service.listSessions()).length).toBe(2);
	});

	it("still creates a replacement when the last blank session is deleted", async () => {
		const service = createService();
		await service.initialize();
		const deleted = service.getSnapshot().session?.path ?? "";

		await service.deleteSession(deleted);

		// The replacement must ignore the stale transcript of the deleted
		// session — a blank sheet there does not mean "reuse it".
		expect(service.getSnapshot().session?.path).toBeTruthy();
		expect(service.getSnapshot().session?.path).not.toBe(deleted);
	});

	it("keeps a renamed session's name after the transcript is reloaded", async () => {
		const service = createService();
		await service.sendPrompt("First conversation");
		const renamed = service.getSnapshot().session;

		await service.renameSession("Release notes");
		expect(service.getSnapshot().session?.name).toBe("Release notes");

		await service.newSession();
		await service.openSession(renamed?.path ?? "");

		expect(service.getSnapshot().session?.name).toBe("Release notes");
	});

	it("appends the rename rather than rewriting the log", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("First conversation");
		const session = service.getSnapshot().session;

		await service.renameSession("Release notes");

		const content = await adapter.read(session?.path ?? "");
		expect(content).toContain('"kind":"fact"');
		expect(content).toContain("First conversation");
		expect(content.split("\n")[0]).toContain('"kind":"header"');
	});

	it("clearing the name falls back to the derived label", async () => {
		const service = createService();
		await service.sendPrompt("First conversation");
		await service.renameSession("Release notes");

		await service.renameSession("   ");

		expect(service.getSnapshot().session?.name).toBeUndefined();
	});

	it("picks up a name appended externally to the active session", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("First conversation");
		await service.renameSession("Local name");
		const revisionBefore = service.getSnapshot().sessionRevision;

		// Another writer on the same vault — a second Obsidian window, a pi CLI,
		// a hand edit — appends a name fact the live session's memory never sees.
		const external = new ObsidianSessionManager(asDataAdapter(adapter), SESSION_DIR, "obsidian-vault:Test");
		await external.loadSession(service.getActiveSessionPath()!);
		await external.appendSessionInfo("External name");

		await service.syncExternalSessionChange();

		const snapshot = service.getSnapshot();
		expect(snapshot.session?.name).toBe("External name");
		// The bump is what makes the session picker re-list; without it the header
		// would correct while the list stayed stale.
		expect(snapshot.sessionRevision).toBe(revisionBefore + 1);
	});

	it("leaves the revision alone when the file changed but the name did not", async () => {
		const service = createService();
		await service.sendPrompt("First conversation");
		await service.renameSession("Local name");
		const revisionBefore = service.getSnapshot().sessionRevision;

		// Every appended message writes the active file, and whether those writes
		// surface as vault modify events is platform-dependent; the name
		// comparison is what keeps a streaming turn from re-rendering per line.
		await service.sendPrompt("Second message");
		await service.syncExternalSessionChange();

		expect(service.getSnapshot().session?.name).toBe("Local name");
		expect(service.getSnapshot().sessionRevision).toBe(revisionBefore);
	});

	it("treats an external whitespace-only rename as cleared", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("First conversation");
		await service.renameSession("Local name");

		const external = new ObsidianSessionManager(asDataAdapter(adapter), SESSION_DIR, "obsidian-vault:Test");
		await external.loadSession(service.getActiveSessionPath()!);
		await external.appendSessionInfo("   ");

		await service.syncExternalSessionChange();

		// Matches how the local rename path collapses `"   "` to undefined.
		expect(service.getSnapshot().session?.name).toBeUndefined();
	});

	it("survives the active file being deleted externally", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("First conversation");
		const revisionBefore = service.getSnapshot().sessionRevision;

		const external = new ObsidianSessionManager(asDataAdapter(adapter), SESSION_DIR, "obsidian-vault:Test");
		await external.deleteSession(service.getActiveSessionPath()!);

		// Best-effort by contract: a failed re-read leaves the state alone instead
		// of turning a vault event into an unhandled rejection.
		await service.syncExternalSessionChange();

		expect(service.getSnapshot().sessionRevision).toBe(revisionBefore);
	});

	it("does nothing when no session is active", async () => {
		const service = createService();

		await service.syncExternalSessionChange();

		expect(service.getSnapshot().sessionRevision).toBe(0);
		expect(service.getSnapshot().session).toBeUndefined();
	});

	it("adopts the next stored session when the active one is deleted", async () => {
		const service = createService();
		await service.sendPrompt("First conversation");
		const firstSession = service.getSnapshot().session;
		await service.newSession();
		await service.sendPrompt("Second conversation");
		const secondSession = service.getSnapshot().session;

		await service.deleteSession(secondSession?.path ?? "");

		const snapshot = service.getSnapshot();
		expect(snapshot.errorMessage).toBeUndefined();
		expect(snapshot.session?.id).toBe(firstSession?.id);
		expect(await service.listSessions()).toHaveLength(1);
	});

	it("starts a fresh session when the last one is deleted", async () => {
		const service = createService();
		await service.sendPrompt("Only conversation");
		const onlySession = service.getSnapshot().session;

		await service.deleteSession(onlySession?.path ?? "");

		const snapshot = service.getSnapshot();
		expect(snapshot.errorMessage).toBeUndefined();
		expect(snapshot.session).toBeDefined();
		expect(snapshot.session?.id).not.toBe(onlySession?.id);
		expect(snapshot.messages).toHaveLength(0);
	});

	it("leaves the active session untouched when another one is deleted", async () => {
		const service = createService();
		await service.sendPrompt("First conversation");
		const firstSession = service.getSnapshot().session;
		await service.newSession();
		await service.sendPrompt("Second conversation");
		const activeSession = service.getSnapshot().session;

		await service.deleteSession(firstSession?.path ?? "");

		const snapshot = service.getSnapshot();
		expect(snapshot.session?.id).toBe(activeSession?.id);
		expect(JSON.stringify(snapshot.messages)).toContain("Second conversation");
		expect(await service.listSessions()).toHaveLength(1);
	});

	it("bumps the session revision so the chat list reloads after deleting another session", async () => {
		const service = createService();
		await service.sendPrompt("First conversation");
		const firstSession = service.getSnapshot().session;
		await service.newSession();
		await service.sendPrompt("Second conversation");
		const before = service.getSnapshot();

		await service.deleteSession(firstSession?.path ?? "");

		const after = service.getSnapshot();
		expect(after.session?.id).toBe(before.session?.id);
		expect(after.sessionRevision).toBeGreaterThan(before.sessionRevision);
	});

	it("falls back to the vault trash when the system trash refuses", async () => {
		const service = createService(new LocalTrashOnlyAdapter());
		await service.sendPrompt("Only conversation");
		const onlySession = service.getSnapshot().session;

		await service.deleteSession(onlySession?.path ?? "");

		expect(service.getSnapshot().errorMessage).toBeUndefined();
		expect((await service.listSessions()).map((session) => session.id)).not.toContain(onlySession?.id);
	});

	it("keeps the active session when trashing fails", async () => {
		const service = createService(new UntrashableAdapter());
		await service.sendPrompt("Only conversation");
		const onlySession = service.getSnapshot().session;

		resetNotices();
		await service.deleteSession(onlySession?.path ?? "");

		const snapshot = service.getSnapshot();
		/*
		 * A toast, not the banner. Deleting a chat is a command whose failure
		 * touches nothing in the conversation — the transcript below is still the
		 * one it was — so a red bar pinned above it would say the damage is there.
		 * The sentence names what did not happen and carries the reason.
		 */
		expect(snapshot.errorMessage).toBeUndefined();
		expect(shownNotices.map((notice) => notice.message)).toEqual([
			"Could not delete that chat: Trash is unavailable.",
		]);
		expect(snapshot.session?.id).toBe(onlySession?.id);
		expect(JSON.stringify(snapshot.messages)).toContain("Only conversation");
	});

	it("replaces a reply on retry instead of appending a second answer", async () => {
		const service = createService();
		await service.sendPrompt("What is in my vault?");
		const before = service.getSnapshot().messages;
		expect(before.filter((message) => message.role === "user")).toHaveLength(1);

		expect(await service.retryFrom(before.length - 1)).toBe(true);

		const after = service.getSnapshot().messages;
		// The question is re-asked once, not stacked, so the model never sees the
		// same prompt twice in one context.
		expect(after.filter((message) => message.role === "user")).toHaveLength(1);
		expect(JSON.stringify(after)).toContain("What is in my vault?");
	});

	it("drops the abandoned reply from the reloaded session, not just from memory", async () => {
		// The log is append-only, so the discarded turn stays on disk. What must
		// not survive is its place on the active branch: a retry that only
		// truncated the in-memory transcript would leave the log's leaf on the
		// abandoned reply and append the replacement below it, so reopening the
		// session would replay both the question and the answer it replaced.
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("Which notes mention pi?");
		const sessionPath = service.getSnapshot().session?.path ?? "";
		const before = service.getSnapshot().messages;

		expect(await service.retryFrom(before.length - 1)).toBe(true);

		const reloaded = createService(adapter);
		await reloaded.openSession(sessionPath);
		const messages = reloaded.getSnapshot().messages;
		expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
	});

	it("counts the branch summary's request in the running total", async () => {
		// Retrying forks the log, and `summarizeAbandonedBranch` spends a real
		// provider request to describe the branch being left behind. That request
		// produces a `branchSummary` message rather than an assistant turn, so
		// `sumUsage` — which reads usage off the transcript — cannot see it. It has to
		// arrive through the same side channel compaction uses, or the panel reports
		// less than the user was charged.
		//
		// The expected count is 2, not 3: a retry truncates the transcript, so the
		// abandoned assistant turn's usage leaves the total along with the message.
		// What remains is the replacement turn plus the summary — and it is exactly
		// the summary that went uncounted, making 1 the number this asserts against.
		requestUrlMock.mockImplementation(async () => sseResponse([summaryChunk("ABANDONED BRANCH"), usageChunk()]));
		const service = createService();
		await service.sendPrompt("Which notes mention pi?");
		const before = service.getSnapshot().messages;

		expect(await service.retryFrom(before.length - 1)).toBe(true);

		const after = service.getSnapshot();
		// Proves the summary actually happened, so the count below cannot pass by
		// coincidence on a run where no branch was summarized at all.
		expect(after.messages.some((message) => message.role === "branchSummary")).toBe(true);
		expect(after.usage.requests).toBe(2);
		// The summary's tokens ride along too, not just its request count.
		expect(after.usage.tokens).toBeGreaterThan(0);
	});

	it("declines a retry for a turn the log cannot name", async () => {
		// A transcript adopted without entry ids stands in for the turns a
		// compaction absorbed: their text survives only inside the summary, so
		// there is no entry to branch from and rewinding would drop the summary
		// along with the turn. Retrying in memory alone would then desync the
		// transcript from the log, so the action is refused instead.
		const service = createService();
		await service.initialize();
		const agent = service.getSnapshot();
		expect(agent.messages).toHaveLength(0);

		await service.sendPrompt("Recorded turn");
		const withHistory = service.getSnapshot().messages;
		// Replace the transcript with copies, which carry no entry mapping.
		service.getSnapshot();
		const detached = withHistory.map((message) => structuredClone(message));
		(service as unknown as { agent: { state: { messages: unknown[] } } }).agent.state.messages = detached;

		expect(await service.retryFrom(detached.length - 1)).toBe(false);
	});

	it("rewrites the question on edit-and-resend instead of re-asking the old one", async () => {
		const service = createService();
		await service.sendPrompt("What is in my vault?");
		const before = service.getSnapshot().messages;
		// The edit targets the user turn itself, which sits one below the reply.
		const questionIndex = before.length - 2;
		expect(before[questionIndex]?.role).toBe("user");

		expect(await service.editAndResend(questionIndex, "Which notes mention pi?")).toBe(true);

		const after = service.getSnapshot().messages;
		// One question, the new one: the rewrite replaced the turn rather than
		// stacking a second question below the first.
		expect(after.filter((message) => message.role === "user")).toHaveLength(1);
		expect(JSON.stringify(after)).toContain("Which notes mention pi?");
		expect(JSON.stringify(after)).not.toContain("What is in my vault?");
	});

	it("declines an edit at an index that does not name a question", async () => {
		// The index names the turn itself, so a reply or a tool row there is a
		// caller bug, not a rewind target: `findPromptIndex` would silently walk
		// back to the *previous* question and rewrite that one instead.
		const service = createService();
		await service.sendPrompt("What is in my vault?");
		const before = service.getSnapshot().messages;

		expect(await service.editAndResend(before.length - 1, "Which notes mention pi?")).toBe(false);
		// The transcript is untouched by the refusal.
		expect(service.getSnapshot().messages).toEqual(before);
	});

	it("declines an empty edit before touching the transcript", async () => {
		// An empty prompt is refused by the send path, but by then the rewind and
		// the branch summary have already happened — a no-op send would still fork
		// the log and bill a summary request. The empty check has to run first.
		const service = createService();
		await service.sendPrompt("What is in my vault?");
		const before = service.getSnapshot().messages;

		expect(await service.editAndResend(before.length - 2, "   ")).toBe(false);
		expect(service.getSnapshot().messages).toEqual(before);
	});

	it("declines an edit without a key before touching the transcript", async () => {
		// The rewind throws the original turn away. Refusing the replacement only
		// at send time — after the branch summary ran and the transcript was cut —
		// loses the question the user was trying to fix. The credential check
		// belongs to the preflight, with the same banner a fresh send raises.
		const { service, settings } = createServiceWithSettings();
		settings.providerApiKeys = {};
		await service.sendPrompt("What is in my vault?");
		const before = service.getSnapshot().messages;

		expect(await service.editAndResend(before.length - 2, "Which notes mention pi?")).toBe(false);
		expect(service.getSnapshot().messages).toEqual(before);
		expect(service.getSnapshot().errorMessage).toContain("key");
	});

	it("declines an image edit on a text-only model before touching the transcript", async () => {
		// Same preflight, other gate: pictures a text-only model would refuse must
		// stop the rewind while the original turn is still on the main line.
		const service = createService();
		await service.sendPrompt("What is in my vault?");
		const before = service.getSnapshot().messages;

		const sent = await service.editAndResend(before.length - 2, "What is this?", [
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);

		expect(sent).toBe(false);
		expect(service.getSnapshot().messages).toEqual(before);
		// One sentence, one channel: this used to be red at send time and grey at
		// staging time for the same fact.
		expect(service.getSnapshot().errorMessage).toBeUndefined();
		expect(service.getSnapshot().noticeMessage).toContain("does not accept images");
	});

	it("reports the rewind window on the snapshot while the branch summary runs", async () => {
		// Between the guards and the replacement send the agent streams nothing
		// and no compaction runs — the one window the panel used to report as
		// fully idle while a real LLM request (the abandoned branch's summary)
		// was in flight. That silence is what read as "the edit did nothing".
		let release: (() => void) | undefined;
		const gated = async (): Promise<unknown> =>
			new Promise((resolve) => {
				release = () => resolve(sseResponse([summaryChunk("ABANDONED BRANCH"), usageChunk()]));
			});
		requestUrlMock.mockImplementation(gated);
		const service = createService();
		await service.sendPrompt("What is in my vault?");
		const seen = [service.getSnapshot()];
		service.subscribe((snapshot) => seen.push(snapshot));

		const resend = service.editAndResend(service.getSnapshot().messages.length - 2, "Which notes mention pi?");
		// The branch summary request is gated until the flag is witnessed, so the
		// assertion cannot pass on a run where no window ever opened.
		for (let i = 0; i < 200 && release === undefined; i += 1) {
			await new Promise((r) => setTimeout(r, 5));
		}
		const during = service.getSnapshot();
		expect(during.isRewinding).toBe(true);
		expect(during.isStreaming).toBe(false);
		expect(during.isCompacting).toBe(false);
		release?.();
		expect(await resend).toBe(true);

		const finalSnapshot = seen[seen.length - 1];
		expect(finalSnapshot?.isRewinding).toBe(false);
		// The busy trio that gates every control never shows all-false mid-rewind:
		// streaming covers the replacement run itself.
		expect(finalSnapshot?.isStreaming).toBe(false);
	});

	it("refuses a fresh send that lands inside the rewind window", async () => {
		// The rewind truncates the transcript to before the edited question. A
		// message appended during the branch summary would be cut away by that
		// truncation — the user's words vanishing without a trace — so a send
		// that lands in the window is refused outright rather than accepted and
		// silently discarded.
		let release: (() => void) | undefined;
		const gated = async (): Promise<unknown> =>
			new Promise((resolve) => {
				release = () => resolve(sseResponse([summaryChunk("ABANDONED BRANCH"), usageChunk()]));
			});
		requestUrlMock.mockImplementation(gated);
		const service = createService();
		await service.sendPrompt("What is in my vault?");

		const resend = service.editAndResend(service.getSnapshot().messages.length - 2, "Which notes mention pi?");
		for (let i = 0; i < 200 && release === undefined; i += 1) {
			await new Promise((r) => setTimeout(r, 5));
		}
		const sent = await service.sendPrompt("A brand new question");
		// Grab the refusal before releasing the summary: the edit's own send
		// clears the banner when it runs, so the busy report is transient by
		// design — visible to the user during the window, gone once the turn lands.
		const refusal = service.getSnapshot().noticeMessage;
		release?.();
		expect(await resend).toBe(true);

		// The refusal is reported the way a busy send always is, and the edit's
		// own turn still went through with nothing appended above it. It names the
		// state that actually holds the turn: "already responding" was false here —
		// a send during streaming is queued, so only compaction or this rewind can
		// reach the refusal at all.
		expect(sent).toBe(false);
		expect(refusal).toContain("resending your message");
		const after = service.getSnapshot().messages;
		expect(JSON.stringify(after)).toContain("Which notes mention pi?");
		expect(JSON.stringify(after)).not.toContain("A brand new question");
	});

	it("reports a pending call under both its name and pi's id", async () => {
		let snapshotDuringTool: PendingToolCall[] | undefined;
		const service = createService(new MemoryAdapter(), {
			streamFn: createToolCallingStreamFn("ls", "toolu_bdrk_0152GcOpaqueId"),
		});
		service.subscribe((snapshot) => {
			if (snapshot.pendingToolCalls.length > 0) {
				snapshotDuringTool = snapshot.pendingToolCalls;
			}
		});

		await service.sendPrompt("What folders do I have?");

		// Two jobs, two fields. The name is what the panel draws — the id pi tracks
		// is opaque to a reader, and rendering it was the defect that put names here.
		// The id is what a transcript row matches its own `ToolCall.id` against, so
		// dropping it left the renderer guessing from position: right about one call
		// in flight, wrong about every turn that issued two.
		expect(snapshotDuringTool).toEqual([{ id: "toolu_bdrk_0152GcOpaqueId", name: "ls" }]);
		// And the call clears once it finishes, so the placeholder does not stick.
		expect(service.getSnapshot().pendingToolCalls).toEqual([]);
	});

	it("carries a streaming tool's progress onto the snapshot", async () => {
		// pi delivers progress as `tool_execution_update`, which a tool raises by
		// calling the `onUpdate` callback pi hands its `execute`. No tool in this
		// plugin reports progress yet, so the event is fed to the subscriber
		// directly — that boundary is exactly what is under test, and adding a
		// production hook only a test would use would be the wrong seam.
		const service = createService(new MemoryAdapter(), {
			streamFn: createToolCallingStreamFn("grep", "toolu_streaming"),
		});
		await service.initialize();
		const handle = service as unknown as {
			handleAgentEvent: (rt: unknown, event: unknown) => Promise<void>;
			runtimeForFocused: () => unknown;
			agent: { state: { pendingToolCalls: ReadonlySet<string> } };
		};
		const focusedRuntime = handle.runtimeForFocused();

		await handle.handleAgentEvent(focusedRuntime, { type: "tool_execution_start", toolCallId: "toolu_streaming", toolName: "grep", args: {} });
		await handle.handleAgentEvent(focusedRuntime, {
			type: "tool_execution_update",
			toolCallId: "toolu_streaming",
			toolName: "grep",
			args: {},
			partialResult: { content: [{ type: "text", text: "42 files scanned\nsecond line ignored" }], details: {} },
		});

		// pi owns which calls are in flight, so the snapshot only reports a tool
		// the agent also considers pending. Reflect that here.
		(handle.agent.state as { pendingToolCalls: ReadonlySet<string> }).pendingToolCalls = new Set(["toolu_streaming"]);

		// Only the first non-blank line: the row has one line to spend, and the
		// full output arrives with the tool result anyway.
		// The id rides along: it is never drawn, but a transcript row matches its own
		// `ToolCall.id` against it to know whether it is one of the calls still out.
		expect(service.getSnapshot().pendingToolCalls).toEqual([{ id: "toolu_streaming", name: "grep", progress: "42 files scanned" }]);

		// The progress must not outlive the call that produced it.
		await handle.handleAgentEvent(focusedRuntime, { type: "tool_execution_end", toolCallId: "toolu_streaming", toolName: "grep", result: {}, isError: false });
		(handle.agent.state as { pendingToolCalls: ReadonlySet<string> }).pendingToolCalls = new Set();
		expect(service.getSnapshot().pendingToolCalls).toEqual([]);
	});

	it("forgets in-flight tool bookkeeping when the agent is replaced", async () => {
		// A run that never delivers `tool_execution_end` — the shape an abort
		// produces — leaves per-call entries behind in every map keyed by call id.
		// `replaceAgent` is the point where nothing can still be in flight, so
		// both maps must be empty afterwards. Asserting on both is the point: they
		// are two halves of one fact, and an earlier revision cleared only the one
		// the panel renders, leaving the timing map to grow for the life of the
		// panel.
		const service = createService(new MemoryAdapter(), {
			streamFn: createToolCallingStreamFn("ls", "toolu_orphaned"),
		});
		await service.sendPrompt("What folders do I have?");

		const internals = service as unknown as {
			pendingToolNames: Map<string, string>;
			pendingToolStarts: Map<string, number>;
		};
		// Stand in for the calls an aborted run abandons: `tool_execution_start`
		// recorded them and no end event ever arrived to clear them.
		internals.pendingToolNames.set("toolu_abandoned", "grep");
		internals.pendingToolStarts.set("toolu_abandoned", Date.now());

		await service.newSession();

		expect(internals.pendingToolNames.size).toBe(0);
		expect(internals.pendingToolStarts.size).toBe(0);
	});

	it("feeds a failed tool result back to the model instead of ending the run", async () => {
		const scriptedStream = createToolCallingStreamFn("ls", "toolu_failed", { path: "Missing" });
		const contexts: Context[] = [];
		const streamFn: StreamFn = (model, context, options) => {
			contexts.push({ ...context, messages: [...context.messages] });
			return scriptedStream(model, context, options);
		};
		const service = createService(new MemoryAdapter(), { streamFn });

		expect(await service.sendPrompt("List the missing folder")).toBe(true);

		// One run, two requests: pi started the recovery request itself instead
		// of ending the run on the error (#208).
		const settled = service.getSnapshot();
		expect(contexts.length).toBe(2);
		expect(settled.isStreaming).toBe(false);
		expect(settled.pendingToolCalls).toEqual([]);
		expect(settled.messages.at(-1)?.role).toBe("assistant");

		// The failure is in the transcript as an error tool result ...
		const transcriptResult = settled.messages.find((message) => message.role === "toolResult");
		if (transcriptResult?.role !== "toolResult") {
			throw new Error("Expected the failed tool result in the transcript.");
		}
		expect(transcriptResult.isError).toBe(true);
		expect(JSON.stringify(transcriptResult.content)).toContain("Folder not found: Missing");

		// ... and the model actually saw it on the request after the failure.
		const fedBack = contexts[1]?.messages.find((message) => message.role === "toolResult");
		if (fedBack?.role !== "toolResult") {
			throw new Error("Expected the failed tool result to be fed back to the model.");
		}
		expect(fedBack.isError).toBe(true);
		expect(JSON.stringify(fedBack.content)).toContain("Folder not found: Missing");
	});

	it("declines a retry when nothing precedes the reply", async () => {
		const service = createService();
		await service.initialize();

		expect(await service.retryFrom(0)).toBe(false);
	});

	it("reports a chat it could not open without throwing, or blaming the one on screen", async () => {
		const service = createService();
		await service.initialize();

		resetNotices();
		await service.openSession(`${SESSION_DIR}/missing.jsonl`);

		// The panel still holds the previous conversation, intact; the failure
		// belongs to the control that was pressed, so it goes to the toast.
		expect(service.getSnapshot().errorMessage).toBeUndefined();
		expect(shownNotices.map((notice) => notice.message).join("")).toContain("Could not open that chat:");
	});

	it("starts without skills rather than failing when the skill layer throws", async () => {
		// The skill layer must not be able to stop the agent from existing. A
		// folder the host refuses to read is the user's environment, not a broken
		// conversation, and an agent without skills still answers questions while
		// one that never started answers nothing. This used to reach
		// `initializationError` and surface as the assertive banner, which also
		// gates sending — so an unreadable home directory silently disabled chat.
		const service = createService(new MemoryAdapter(), {
			loadUserSkills: async () => {
				throw new Error("User skill folder unreadable.");
			},
		});

		await service.initialize(); // must not throw

		expect(service.getSnapshot().errorMessage).toBeUndefined();
		// Nor does the raw host message reach the quiet channel: it belongs to the
		// Skills tab and the log, not to a panel about the user's notes.
		expect(service.getSnapshot().noticeMessage).toBeUndefined();
		// And sending still works, which is the whole point of containing it.
		expect(await service.sendPrompt("Hello")).toBe(true);
	});

	it("marks the reply whose write to the vault failed, by identity", async () => {
		/*
		 * The reader has already seen the reply when the append fails, so this is not
		 * a red alert — but it is the one report in the panel about loss they cannot
		 * undo, so it also cannot be a dismissible line at the top of the panel that
		 * the next send clears. It is reported by identity, and the transcript puts
		 * the warning under the reply it names.
		 */
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		// Open the session first, so only the turn's writes hit the broken append.
		await service.sendPrompt("First conversation");
		service.subscribe(() => undefined);
		const original = adapter.append.bind(adapter);
		adapter.append = async (path: string, data: string) => {
			if (data.includes("assistant")) {
				throw new Error("Disk full");
			}
			return original(path, data);
		};

		await service.sendPrompt("Second conversation");

		const snapshot = service.getSnapshot();
		expect(snapshot.errorMessage).toBeUndefined();
		// Neither channel: nothing the next send can erase.
		expect(snapshot.noticeMessage).toBeUndefined();
		const last = snapshot.messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect(snapshot.unpersistedMessages).toContain(last as object);
	});

	it("marks every message of a run the log refused, not only the first", async () => {
		// The realistic cause is a log the host cannot write at all, so stopping at
		// the first failure would mark one message and leave the rest of the run
		// silently unrecorded.
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("First conversation");
		const original = adapter.append.bind(adapter);
		adapter.append = async (path: string, data: string) => {
			if (data.includes('"role"')) {
				throw new Error("Disk full");
			}
			return original(path, data);
		};

		await service.sendPrompt("Second conversation");

		const marked = service.getSnapshot().unpersistedMessages ?? [];
		// Both halves of the turn the log refused: the question and the reply.
		expect(marked.length).toBeGreaterThanOrEqual(2);
	});

	it("reports context fill against the model's window, heuristic before any usage", async () => {
		const service = createService();
		const fresh = service.getSnapshot().contextFill;
		expect(fresh?.heuristicOnly).toBe(true);
		// deepseek-v4-pro ships a 1M window; the plugin does not override it.
		expect(fresh?.contextWindow).toBe(1_000_000);

		await service.sendPrompt("Hello");

		const after = service.getSnapshot().contextFill;
		expect(after?.heuristicOnly).toBe(false);
		// The fake turn reports 1_010 total tokens against a 1M window.
		expect(after?.tokens).toBe(1_010);
	});

	it("flips isCompacting while a forced compaction request is in flight", async () => {
		requestUrlMock.mockImplementation(async () => sseResponse([summaryChunk(), usageChunk()]));
		const service = createService();
		await service.sendPrompt("Long conversation");
		const seen = [service.getSnapshot()];
		service.subscribe((snapshot) => seen.push(snapshot));

		await service.compactNow();

		expect(seen.some((snapshot) => snapshot.isCompacting)).toBe(true);
		const finalSnapshot = seen[seen.length - 1];
		expect(finalSnapshot?.isCompacting).toBe(false);
		expect(finalSnapshot?.messages[0]?.role).toBe("compactionSummary");
		// Compaction bills its own request; it must show up in the running total.
		expect(finalSnapshot?.usage.requests).toBe(2);
	});

	it("reports when there was nothing to compact on the notice channel, not as an error", async () => {
		requestUrlMock.mockImplementation(async () => sseResponse([summaryChunk(), usageChunk()]));
		const service = createService();
		await service.compactNow();

		// The error banner is an assertive alert; a "nothing happened" outcome
		// routed through it made screen readers interrupt the user.
		//
		// Wording comes from the copy table rather than a literal in this method,
		// which is what it used to be — a Chinese reader who pressed Tidy up got
		// one line of English back. It matches the command that reaches it ("Tidy
		// up earlier messages"), not the detail-tier word "compact".
		expect(service.getSnapshot().noticeMessage).toBe("Nothing to tidy up yet.");
		expect(service.getSnapshot().errorMessage).toBeUndefined();
		expect(service.getSnapshot().messages).toHaveLength(0);
	});

	it("keeps the compaction summary visible in the transcript after compaction", async () => {
		requestUrlMock.mockImplementation(async () => sseResponse([summaryChunk("EARLIER HISTORY SUMMARIZED"), usageChunk()]));
		const service = createService();
		await service.sendPrompt("Long conversation");

		await service.compactNow();

		const snapshot = service.getSnapshot();
		expect(snapshot.messages[0]?.role).toBe("compactionSummary");
		expect(JSON.stringify(snapshot.messages)).toContain("EARLIER HISTORY SUMMARIZED");
		// The retained tail keeps the recent exchange so the agent can still see it.
		expect(snapshot.messages.some((message) => message.role === "user")).toBe(true);
	});

	it("names the active note in the request without touching the transcript", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });
		service.setActiveNotePath("Projects/weekly-0827.md");

		await service.sendPrompt("Rewrite this note");

		// The whole point of the issue: the path reaches the model unasked.
		expect(JSON.stringify(contexts[0]?.messages)).toContain("Active note: Projects/weekly-0827.md");
		// And it stays out of the transcript, so it is neither persisted to the
		// session log nor rendered in the panel nor re-sent as history next turn.
		expect(JSON.stringify(service.getSnapshot().messages)).not.toContain("<context>");
	});

	it("rides the active note's content along with its path", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), {
			streamFn: createCapturingStreamFn(contexts),
			vaultFiles: { "Projects/weekly-0827.md": "Meeting at noon\nAction: buy milk" },
		});
		service.setActiveNotePath("Projects/weekly-0827.md");

		await service.sendPrompt("Rewrite this note");

		const sent = JSON.stringify(contexts[0]?.messages);
		// The path alone told the model where to look; the content means it does
		// not have to spend a turn on `read` before being useful.
		expect(sent).toContain("Note content (2 lines):");
		expect(sent).toContain("Meeting at noon");
		// The mtime comes off the file stat, rendered as fixed ISO — the fake
		// vault stamps mtime 1, and a fixed value is what keeps the block cached.
		expect(sent).toContain(`Last modified: ${new Date(1).toISOString()}`);
	});

	it("keeps a giant active note inside the content budget", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), {
			streamFn: createCapturingStreamFn(contexts),
			vaultFiles: { "Notes/huge.md": "z".repeat(MAX_ACTIVE_NOTE_CHARS + 5_000) },
		});
		service.setActiveNotePath("Notes/huge.md");

		await service.sendPrompt("Trim this note");

		const last = contexts[0]?.messages.at(-1);
		const sent = typeof last?.content === "string" ? last.content : "";
		expect(sent).toContain("Note content (first 1 of 1 lines):");
		// The injected message is bounded even when the note is not: a giant note
		// must not turn into a giant prompt.
		expect(sent.length).toBeLessThan(MAX_ACTIVE_NOTE_CHARS + 400);
	});

	it("degrades to the path-only block when the note cannot be read", async () => {
		// No vaultFiles registered: the path is watched but the fake vault has no
		// such file, which is also what a mid-run rename or delete looks like.
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts) });
		service.setActiveNotePath("Notes/ghost.md");

		await service.sendPrompt("Hello");

		const sent = JSON.stringify(contexts[0]?.messages);
		expect(sent).toContain("Active note: Notes/ghost.md");
		expect(sent).not.toContain("Note content");
	});

	it("names no note when no Markdown note is active", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });

		await service.sendPrompt("Hello");

		// A canvas, a PDF, or an empty workspace must not produce "no note open":
		// that is a negative fact the model has no use for, and stating it would
		// churn the prompt every time the user clicked away. The date still rides
		// along — it is true regardless of what is open.
		const sent = JSON.stringify(contexts[0]?.messages);
		expect(sent).not.toContain("Active note:");
		expect(sent).not.toContain("Current folder:");
	});

	it("re-derives the injected block per turn rather than freezing it", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });
		service.setActiveNotePath("Notes/first.md");
		await service.sendPrompt("About this one");

		service.setActiveNotePath("Notes/second.md");
		await service.sendPrompt("Now this one");

		expect(JSON.stringify(contexts[0]?.messages)).toContain("Notes/first.md");
		// The second request must not still be naming the first note, and must not
		// name both — the block is rebuilt, not accumulated.
		const second = JSON.stringify(contexts[1]?.messages);
		expect(second).toContain("Notes/second.md");
		expect(second).not.toContain("Notes/first.md");
	});

	it("stops naming the active note once following is dismissed", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });
		await service.initialize();
		service.setActiveNotePath("Notes/today.md");

		service.setFollowActiveNote(false);
		await service.sendPrompt("Hello");

		// Dismissing follow means "stop watching where I am", not "stop telling the
		// model anything" — the folder line goes with the note, the date does not.
		const sent = JSON.stringify(contexts[0]?.messages);
		expect(sent).not.toContain("Active note:");
		expect(sent).not.toContain("Notes/today.md");
	});

	it("names what links to the active note and what its links fail to resolve", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), {
			streamFn: createCapturingStreamFn(contexts),
			vaultFiles: { "Notes/today.md": "body" },
			probeData: {
				resolvedLinks: { "Notes/inbound.md": { "Notes/today.md": 2 }, "Notes/today.md": {} },
				unresolvedLinks: { "Notes/today.md": { "Weekly Review": 1 } },
			},
		});
		service.setActiveNotePath("Notes/today.md");

		await service.sendPrompt("Rename the heading");

		const sent = JSON.stringify(contexts[0]?.messages);
		// Renaming a heading is exactly the edit that breaks other notes; the model
		// cannot weigh that without knowing something points here.
		expect(sent).toContain("Linked from: Notes/inbound.md");
		// And the brackets say this one is link text, not a path `read` would accept.
		expect(sent).toContain("Unresolved links in this note: [[Weekly Review]]");
	});

	it("rides the user's selection along with the note", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), {
			streamFn: createCapturingStreamFn(contexts),
			vaultFiles: { "Notes/today.md": "first\nsecond\nthird" },
			probeData: { activeEditor: { file: { path: "Notes/today.md" }, editor: { getSelection: () => "second" } } },
		});
		service.setActiveNotePath("Notes/today.md");

		await service.sendPrompt("Translate this");

		const sent = JSON.stringify(contexts[0]?.messages);
		// "Translate this" is unanswerable without it, and the panel is the only place
		// that can know which passage "this" was.
		expect(sent).toContain("Selected text (6 characters)");
		expect(sent).toContain("second");
	});

	it("gives a pinned note its headings and properties without its body", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), {
			streamFn: createCapturingStreamFn(contexts),
			vaultFiles: { "Notes/today.md": "body", "Notes/spec.md": "PINNED BODY TEXT" },
			probeData: {
				caches: {
					"Notes/spec.md": { headings: [{ level: 1, heading: "Decision log" }], frontmatter: { status: "active" } },
				},
			},
		});
		// Pins live on the session runtime, which only exists once the service has
		// started — `pinContextRef` is a silent no-op before that.
		await service.initialize();
		service.setActiveNotePath("Notes/today.md");
		service.pinContextRef("Notes/spec.md");

		await service.sendPrompt("Check the spec");

		const sent = JSON.stringify(contexts[0]?.messages);
		expect(sent).toContain("Outline: # Decision log");
		expect(sent).toContain("Properties: status: active");
		// The skeleton is the whole point: it routes the question without quoting a
		// second document into every turn.
		expect(sent).not.toContain("PINNED BODY TEXT");
	});

	it("keeps naming a pinned note after the user navigates away", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });
		await service.initialize();
		service.setActiveNotePath("Notes/pinned.md");
		service.pinContextRef("Notes/pinned.md");

		service.setActiveNotePath("Notes/elsewhere.md");
		await service.sendPrompt("Compare these");

		const sent = JSON.stringify(contexts[0]?.messages);
		expect(sent).toContain("Active note: Notes/elsewhere.md");
		expect(sent).toContain("Pinned note: Notes/pinned.md");
	});

	it("publishes the same refs the injection sends", async () => {
		const service = createService();
		await service.initialize();
		service.setActiveNotePath("Notes/today.md");
		service.pinContextRef("Notes/other.md");

		// One source of truth: the chip row renders this, so it cannot advertise
		// context the model was not given.
		expect(service.getSnapshot().contextRefs).toEqual([
			{ kind: "active", path: "Notes/today.md", isPinned: false },
			{ kind: "pinned", path: "Notes/other.md", isPinned: true },
		]);
	});

	it("notifies only when the active note actually changed", async () => {
		const service = createService();
		let notifications = 0;
		service.subscribe(() => notifications++);
		const baseline = notifications;

		service.setActiveNotePath("Notes/today.md");
		expect(notifications).toBe(baseline + 1);

		// `active-leaf-change` also fires for the chat panel's own leaf, which
		// resolves to the same note; `notify` rebuilds the whole snapshot and React
		// cannot bail out on a fresh object, so a no-op must stay silent.
		service.setActiveNotePath("Notes/today.md");
		expect(notifications).toBe(baseline + 1);
	});

	it("drops pins and restores following on a new chat", async () => {
		const service = createService();
		await service.sendPrompt("First conversation");
		service.setActiveNotePath("Notes/today.md");
		service.pinContextRef("Notes/pinned.md");
		service.setFollowActiveNote(false);

		await service.newSession();

		const snapshot = service.getSnapshot();
		// Pins and a dismissed follow belong to the conversation that collected
		// them; inheriting either would shape a fresh chat the user never set up.
		expect(snapshot.isFollowingActiveNote).toBe(true);
		// The active note survives because it describes the workspace, which did
		// not change when the conversation did.
		expect(snapshot.contextRefs).toEqual([{ kind: "active", path: "Notes/today.md", isPinned: false }]);
	});

	it("keeps the injected block out of the session log on disk", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		service.setActiveNotePath("Notes/today.md");

		await service.sendPrompt("Rewrite this note");

		// The in-memory assertion elsewhere could pass while the block still reached
		// the file. A path recorded here would be replayed into a future
		// conversation, long after it went stale.
		const content = await adapter.read(service.getSnapshot().session?.path ?? "");
		expect(content).not.toContain("<context>");
		expect(content).not.toContain("Notes/today.md");
	});

	it("keeps the injected block out of the compaction summary", async () => {
		requestUrlMock.mockImplementation(async () => sseResponse([summaryChunk("SUMMARY OF EARLIER TURNS"), usageChunk()]));
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		service.setActiveNotePath("Notes/today.md");
		await service.sendPrompt("Long conversation");

		await service.compactNow();

		// Compaction summarizes `agent.state.messages`, which the injection never
		// enters, and the summary *is* persisted. A leak here would defeat the whole
		// no-persistence argument for using transformContext.
		const content = await adapter.read(service.getSnapshot().session?.path ?? "");
		expect(content).toContain('"type":"compaction"');
		expect(content).not.toContain("<context>");
		expect(JSON.stringify(service.getSnapshot().messages)).not.toContain("<context>");
	});

	it("stops pinning at the cap", async () => {
		const service = createService();
		await service.initialize();
		for (let index = 0; index < 8; index++) {
			service.pinContextRef(`Notes/${index}.md`);
		}

		service.pinContextRef("Notes/overflow.md");

		// Every pin is billed on every turn, so the ceiling is explicit rather than
		// however many times the user managed to click.
		const paths = service.getSnapshot().contextRefs.map((ref) => ref.path);
		expect(paths).toHaveLength(8);
		expect(paths).not.toContain("Notes/overflow.md");
	});

	it("drops pins and restores following when an earlier chat is reopened", async () => {
		const service = createService();
		await service.sendPrompt("First conversation");
		const firstSession = service.getSnapshot().session;
		await service.newSession();
		await service.sendPrompt("Second conversation");

		service.setActiveNotePath("Notes/today.md");
		service.pinContextRef("Notes/pinned.md");
		service.setFollowActiveNote(false);

		await service.openSession(firstSession?.path ?? "");

		const snapshot = service.getSnapshot();
		expect(snapshot.isFollowingActiveNote).toBe(true);
		expect(snapshot.contextRefs).toEqual([{ kind: "active", path: "Notes/today.md", isPinned: false }]);
	});

	describe("mid-run compaction", () => {
		const WINDOW = 1_000_000;
		const RESERVE = 16_384;
		const THRESHOLD = WINDOW - RESERVE;

		async function runMidRunService(
			totals: number[],
			options: {
				requestUrl?: () => Promise<string | { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>;
			} = {},
		) {
			requestUrlMock.mockClear();
			const { streamFn, requests } = createRecordingToolCallingStreamFn(totals);
			const service = createService(new MemoryAdapter(), { streamFn });
			const snapshots = [service.getSnapshot()];
			service.subscribe((snapshot) => snapshots.push(snapshot));
			// The summarization request goes through requestUrl; turns go through
			// the injected streamFn. A custom responder keeps some tests in flight
			// until the test cancels.
			requestUrlMock.mockImplementation(
				options.requestUrl ?? (async () => sseResponse([summaryChunk("MID-RUN SUMMARY"), usageChunk()])),
			);
			await service.sendPrompt("Read the vault");
			return { service, requests, snapshots };
		}

		it("T1: compacts before the next request and the summary reaches it", async () => {
			const { service, requests, snapshots } = await runMidRunService([THRESHOLD + 1_000, 1_010]);

			expect(requests.length).toBe(2);
			expect(requests[0]?.messages[0]?.role).not.toBe("compactionSummary");
			expect(requests[1]?.messages[0]?.role).toBe("user");
			expect(JSON.stringify(requests[1]?.messages[0])).toContain("MID-RUN SUMMARY");
			expect(service.getSnapshot().messages[0]?.role).toBe("compactionSummary");
			const last = snapshots[snapshots.length - 1];
			expect(last?.isStreaming).toBe(false);
			expect(last?.errorMessage).toBeUndefined();
		});

		it("T2: does not compact when usage stays under the threshold", async () => {
			const { service, requests, snapshots } = await runMidRunService([1_010, 1_010]);

			expect(requests.length).toBe(2);
			// The pre-prompt compaction has always raised `isCompacting` for an
			// instant before `compactIfNeeded` can skip; that is not the flash this
			// gate exists to prevent. What must never happen is the banner appearing
			// at a turn boundary *while the run streams*.
			expect(snapshots.some((s) => s.isCompacting && s.isStreaming)).toBe(false);
			expect(requestUrlMock).not.toHaveBeenCalled();
			expect(service.getSnapshot().messages[0]?.role).not.toBe("compactionSummary");
		});

		it("T3: raises the flag while the run is still streaming", async () => {
			const { snapshots } = await runMidRunService([THRESHOLD + 1_000, 1_010]);

			expect(snapshots.some((s) => s.isCompacting && s.isStreaming)).toBe(true);
			const last = snapshots[snapshots.length - 1];
			expect(last?.isCompacting).toBe(false);
			expect(last?.isStreaming).toBe(false);
		});

		it("T3b: hands the transcript a running event, then the retained count that places its row", async () => {
			// The two halves of the tidying row's material. `isCompacting` is only the
			// busy flag; what the row is drawn *from* is the event while the request is
			// in flight and, once pi's summary lands, how much of the tail it kept —
			// which is where in the transcript the row belongs. Asserted together
			// because a snapshot that carries one without the other draws either a row
			// with no position or a position with no row.
			const { service, snapshots } = await runMidRunService([THRESHOLD + 1_000, 1_010]);

			const inFlight = snapshots.find((snapshot) => snapshot.compactionEvent?.state === "running");
			expect(inFlight?.isCompacting).toBe(true);
			/*
			 * The first attempt of a send is the pre-prompt one, and it runs before the
			 * user's own message joins the transcript — so its anchor is the empty tail.
			 * That is why a *running* row is drawn at "now" rather than at its anchor:
			 * anchoring it would put "Tidying thoughts…" above the prompt that caused
			 * it. The anchor earns its keep on the failure path, where the row must not
			 * drift down as the run appends past it.
			 */
			expect(inFlight?.compactionEvent?.anchor).toBe(0);
			const midRun = snapshots.find((snapshot) => snapshot.compactionEvent?.state === "running" && snapshot.isStreaming);
			expect(midRun?.compactionEvent?.anchor).toBeGreaterThan(0);

			const settled = service.getSnapshot();
			expect(settled.compactionEvent).toBeNull();
			expect(settled.messages[0]?.role).toBe("compactionSummary");
			/*
			 * The count can never name a row the transcript does not have. Zero is the
			 * honest answer for this fixture — the transcript is two turns long and pi
			 * summarized all of it — and zero is a real case, not a missing value: it
			 * puts the row immediately after the summary's own slot, which is exactly
			 * where the tidy happened when nothing was kept.
			 */
			expect(settled.compactionRetained).toBeGreaterThanOrEqual(0);
			expect(settled.compactionRetained).toBeLessThanOrEqual(settled.messages.length - 1);
		});
		it("T4: a failed compaction does not kill the run", async () => {
			// 401 matches none of pi-ai's retryable patterns, so the summarization
			// request fails on the first attempt instead of backing off for seconds.
			const { requests, snapshots } = await runMidRunService([THRESHOLD + 1_000, 1_010], {
				requestUrl: async () => ({ status: 401, headers: {}, arrayBuffer: new ArrayBuffer(0) }),
			});

			expect(requests.length).toBe(2);
			expect(JSON.stringify(requests[1]?.messages[0])).not.toContain("MID-RUN SUMMARY");
			const last = snapshots[snapshots.length - 1];
			// Reported on the transcript row the attempt already occupied, not in the
			// banner and no longer on the notice channel: a compaction that fails does
			// not stop the panel, and the run below is the proof.
			expect(last?.errorMessage).toBeUndefined();
			expect(last?.noticeMessage).toBeUndefined();
			expect(last?.isCompacting).toBe(false);
			expect(last?.compactionEvent?.state).toBe("failed");
			expect(last?.compactionEvent?.error).toBeDefined();
			// The run still settled with its own reply, and the log has no summary
			// to replay: a failed compaction must leave the session untouched.
			expect(last?.messages.at(-1)?.role).toBe("assistant");
			expect(JSON.stringify(last?.messages)).not.toContain("compactionSummary");
		});

		it("T5: the compaction entry lands after the turn it summarizes and reloads consistently", async () => {
			const adapter = new MemoryAdapter();
			requestUrlMock.mockClear();
			const { streamFn, requests } = createRecordingToolCallingStreamFn([THRESHOLD + 1_000, 1_010]);
			const service = createService(adapter, { streamFn });
			requestUrlMock.mockImplementation(async () => sseResponse([summaryChunk("MID-RUN SUMMARY"), usageChunk()]));
			await service.sendPrompt("Read the vault");

			const live = service.getSnapshot().messages;
			expect(live[0]?.role).toBe("compactionSummary");

			// The log must carry exactly one compaction entry, parented on the last
			// message entry before it — the tool result the boundary sat behind.
			// Appending from the turn_end subscription without awaiting the persist
			// would parent it on the assistant entry instead, and a reload would
			// then replay the tool result twice: once from retainedTail, once as its
			// own entry.
			const sessionPath = (await service.listSessions())[0]?.path ?? "";
			const entries = (await adapter.read(sessionPath))
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as { kind: string; type?: string; id?: string; parentId?: string });
			const compaction = entries.filter((e) => e.kind === "entry" && e.type === "compaction");
			expect(compaction).toHaveLength(1);
			const entryIndex = entries.findIndex((e) => e.kind === "entry" && e.type === "compaction");
			const precedingMessageIds = entries
				.slice(0, entryIndex)
				.filter((e) => e.kind === "entry" && e.type === "message")
				.map((e) => e.id ?? "");
			expect(compaction[0]?.parentId).toBe(precedingMessageIds.at(-1));

			// Reload in a fresh service: the replayed transcript must equal the
			// live one — same length, summary first.
			const reloaded = createService(adapter);
			await reloaded.openSession((await service.listSessions())[0]?.path ?? "");
			const replayed = reloaded.getSnapshot().messages;
			expect(replayed[0]?.role).toBe("compactionSummary");
			expect(replayed).toHaveLength(live.length);
			expect(requests.length).toBe(2);
		});

		it("T6: stopping mid-compaction does not report a compaction failure", async () => {
			// Gate the summarization request so the compaction is provably in
			// flight when the stop lands. The service must be held directly rather
			// than through the helper, because the run cannot settle until the
			// gate opens and the test must press stop while it is in flight.
			let release: (() => void) | undefined;
			let sawCompacting = false;
			const gated = (): Promise<never> =>
				new Promise((_, reject) => {
					// AbortError is terminal: pi-ai never retries it, so the rejection
					// settles the compaction on the first attempt instead of backing
					// off through the retry ladder.
					release = () => reject(new DOMException("The request was aborted.", "AbortError"));
				});
			requestUrlMock.mockClear();
			const { streamFn } = createRecordingToolCallingStreamFn([THRESHOLD + 1_000, 1_010]);
			const service = createService(new MemoryAdapter(), { streamFn });
			const snapshots = [service.getSnapshot()];
			service.subscribe((snapshot) => snapshots.push(snapshot));
			requestUrlMock.mockImplementation(gated);
			const settledPrompt = service.sendPrompt("Read the vault");

			// Wait until the compaction is in flight, then press stop.
			for (let i = 0; i < 200 && !sawCompacting; i += 1) {
				sawCompacting = service.getSnapshot().isCompacting;
				if (!sawCompacting) {
					await new Promise((r) => setTimeout(r, 5));
				}
			}
			expect(sawCompacting).toBe(true);

			// The gated mock pays no attention to its signal; release it and let
			// the service's own abort path drive the outcome.
			release?.();
			service.abort();
			await settledPrompt;

			// A user who pressed stop is told the run stopped; the aborted
			// compaction must not surface as a tidy-up failure on either channel.
			const last = snapshots[snapshots.length - 1];
			expect(last?.isCompacting).toBe(false);
			expect(last?.isStreaming).toBe(false);
			expect(last?.errorMessage ?? "").not.toContain("tidy up");
			expect(last?.noticeMessage ?? "").not.toContain("tidy up");
			// The hook returns `undefined` on cancel, leaving pi's loop in charge:
			// it keeps going until a streaming call observes the aborted signal and
			// settles the run with stopReason "aborted". The summary must not have
			// been applied either way.
			expect(service.getSnapshot().messages[0]?.role).not.toBe("compactionSummary");
		});
	});
});

describe("ObsidianAgentService queued prompts (mid-run sends)", () => {
	/** The first text of a message, for asserting on what the transcript actually says. */
	function firstText(message: { content: unknown }): string {
		const block = (message.content as { type: string; text?: string }[])[0];
		return block?.text ?? "";
	}

	function userTexts(service: ObsidianAgentServiceType): string[] {
		return service
			.getSnapshot()
			.messages.filter((message) => message.role === "user")
			.map((message) => firstText(message));
	}

	/** Plants a stranded entry directly in the mirror, for paths that need one without a live run. */
	function addStranded(service: ObsidianAgentServiceType, text: string): void {
		const queue = (service as unknown as { promptQueue: PromptQueue }).promptQueue;
		queue.add({
			kind: "steer",
			text,
			imageCount: 0,
			message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
		});
	}

	/**
	 * A streamFn whose first request never answers until `release` is called —
	 * the stand-in for a model the user interrupts mid-reply.
	 */
	function createGatedStreamFn() {
		let requestCount = 0;
		let gate: ReturnType<typeof createAssistantMessageEventStream> | undefined;
		let gateModel: Model<Api> | undefined;
		const streamFn: StreamFn = (model, _context, _options) => {
			requestCount += 1;
			if (requestCount === 1) {
				gate = createAssistantMessageEventStream();
				gateModel = model;
				return gate;
			}
			return scriptedTextStream(model, "Second reply");
		};
		return {
			streamFn,
			waitForFirstRequest: () => waitFor(() => requestCount === 1),
			// Same shape `scriptedTextStream` builds; the model is only known once
			// the request arrives, so the reply is assembled at release time.
			release: () => {
				const model = gateModel;
				const target = gate;
				if (!model || !target) {
					throw new Error("release before the first request");
				}
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "First reply" }],
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
				target.push({ type: "done", reason: "stop", message });
				target.end(message);
			},
		};
	}

	it("queues a mid-run send as a steer and injects every one at the next turn boundary", async () => {
		// Two mid-run sends on purpose: pi's own default is one-at-a-time, so
		// both landing proves the agent was built with steeringMode "all".
		const gated = createGatedStreamFn();
		const service = createService(new MemoryAdapter(), { streamFn: gated.streamFn });

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();

		expect(await service.sendPrompt("Hold on, use the other file")).toBe(true);
		expect(await service.sendPrompt("And also skip the summary")).toBe(true);
		expect(service.getSnapshot().queuedPrompts.map((entry) => entry.text)).toEqual([
			"Hold on, use the other file",
			"And also skip the summary",
		]);

		gated.release();
		await run;

		expect(userTexts(service)).toEqual(["First question", "Hold on, use the other file", "And also skip the summary"]);
		expect(service.getSnapshot().queuedPrompts).toEqual([]);
	});

	it("takes one queued chip back and re-pushes only the survivors into pi", async () => {
		const gated = createGatedStreamFn();
		const service = createService(new MemoryAdapter(), { streamFn: gated.streamFn });

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();
		await service.sendPrompt("Take this back");
		await service.sendPrompt("Keep this one");

		const queued = service.getSnapshot().queuedPrompts;
		expect(queued).toHaveLength(2);
		service.removeQueuedPrompt(queued[0]?.id ?? "");

		expect(service.getSnapshot().queuedPrompts.map((entry) => entry.text)).toEqual(["Keep this one"]);

		gated.release();
		await run;

		// The survivor is the only mid-run message that reached the transcript.
		expect(userTexts(service)).toEqual(["First question", "Keep this one"]);
	});

	it("clears queued chips when the run is aborted", async () => {
		const gated = createGatedStreamFn();
		const service = createService(new MemoryAdapter(), { streamFn: gated.streamFn });

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();
		await service.sendPrompt("Hold on");
		expect(service.getSnapshot().queuedPrompts).toHaveLength(1);

		// Abort only signals; a gated stream that ignores its signal never
		// settles, so the reply has to flow for the run to actually end.
		gated.release();
		service.abort();
		await run;

		expect(service.getSnapshot().queuedPrompts).toEqual([]);
		// Stopping the run retracts the queued intent along with it: the
		// transcript holds the original prompt and the aborted reply, no steer.
		expect(userTexts(service)).toEqual(["First question"]);
	});

	it("dispatches stranded queue entries itself once the run's end has fully settled", async () => {
		// This pins the dispatch *timing*, which the direct-call rescue tests
		// above cannot: pi awaits its listeners inside the run's executor, so
		// during `agent_end` the run is still held — `isStreaming` true,
		// `agent.prompt` forbidden. The rescue must wait for `waitForIdle()` and
		// only then start its own run; dispatching inline would bail on the
		// resume's streaming guard and the words would sit on chips forever.
		const gated = createGatedStreamFn();
		const service = createService(new MemoryAdapter(), { streamFn: gated.streamFn });

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();
		// Into the mirror only, bypassing `agent.steer`: pi never learns of
		// these words, so no drain point can inject them and the mirror is
		// full when the run ends — exactly the stranded shape.
		addStranded(service, "Too late for the drain point");
		expect(service.getSnapshot().queuedPrompts).toHaveLength(1);

		gated.release();
		await run;

		await waitFor(() => userTexts(service).includes("Too late for the drain point"));

		// The rescue ran as its own run (the gated stream's second request
		// answered it) and the mirror is spent.
		expect(userTexts(service)).toEqual(["First question", "Too late for the drain point"]);
		expect(service.getSnapshot().queuedPrompts).toEqual([]);
	});

	it("carries stranded queue entries ahead of the next direct send", async () => {
		// A run that ended before its drain point leaves the mirror full; the
		// next ordinary send must dispatch those words first, not behind the new one.
		const service = createService();
		await service.initialize();
		addStranded(service, "Stranded correction");

		await service.sendPrompt("Fresh question");

		expect(userTexts(service)).toEqual(["Stranded correction", "Fresh question"]);
		expect((service as unknown as { promptQueue: PromptQueue }).promptQueue.size).toBe(0);
	});

	it("dispatches stranded steers itself when the run ended without injecting them", async () => {
		const service = createService();
		await service.initialize();
		addStranded(service, "Stranded correction");

		await (service as unknown as { resumeQueuedPrompts: (messages: readonly AgentMessage[]) => Promise<void> })
			.resumeQueuedPrompts([]);

		// The rescue is a fresh run on its own: the words land, then the
		// scripted reply, and the mirror is empty afterwards.
		expect(userTexts(service)).toEqual(["Stranded correction"]);
		expect((service as unknown as { promptQueue: PromptQueue }).promptQueue.size).toBe(0);
	});

	it("leaves the queue alone when the run died on a provider error", async () => {
		const service = createService();
		await service.initialize();
		addStranded(service, "Stranded correction");

		// Shape mirrors pi's own run-failure message; only role and stopReason
		// are read, but the full assistant shape keeps the cast honest.
		const failed: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
			stopReason: "error",
			errorMessage: "boom",
		};

		await (service as unknown as { resumeQueuedPrompts: (messages: readonly AgentMessage[]) => Promise<void> })
			.resumeQueuedPrompts([failed]);

		// Re-sending into the same failure would bill a second refusal; the
		// words stay queued for the next direct send to carry.
		expect(userTexts(service)).toEqual([]);
		expect((service as unknown as { promptQueue: PromptQueue }).promptQueue.size).toBe(1);
	});

	it("clears queued chips when the session changes", async () => {
		const service = createService();
		await service.initialize();
		addStranded(service, "Queued for the old session");

		// The fresh session is blank, so the plain call would be a no-op; force the
		// swap the test is about.
		await service.newSession({ force: true });

		expect((service as unknown as { promptQueue: PromptQueue }).promptQueue.size).toBe(0);
		expect(service.getSnapshot().queuedPrompts).toEqual([]);
	});
});

/**
 * The run ledger and crash recovery.
 *
 * The ledger is the durability half: every run opens an `operation_started`
 * before it departs and closes it on `agent_end`, so a crash mid-run leaves
 * an orphan a later load reads. Recovery is the other half: the load settles
 * orphans and — when the user's words are still the transcript's tail —
 * raises the continue offer the banner renders.
 */
describe("ObsidianAgentService run ledger and recovery", () => {
	/** The active session's ledger, read off disk the way a later process would. */
	async function openOperations(service: ObsidianAgentServiceType): Promise<OperationStartedRecord[]> {
		return (service as unknown as { sessionManager: ObsidianSessionManager }).sessionManager
			.getSession()
			.findOpenOperations("main");
	}

	it("closes the run it opened, so a normal conversation leaves no orphans", async () => {
		const service = createService();

		await service.sendPrompt("Hello");

		expect(await openOperations(service)).toEqual([]);
		const finished = await (service as unknown as { sessionManager: ObsidianSessionManager }).sessionManager
			.getSession()
			.findRecords({ type: "operation_finished" });
		expect(finished).toHaveLength(1);
		expect(finished[0]).toMatchObject({ outcome: "completed" });
	});

	it("closes an aborted run as aborted", async () => {
		// A stream that ends only when aborted — the abort has to be what ends
		// the run, so the ledger close can be attributed to the abort rather
		// than to a run that had already settled on its own. Ending with an
		// aborted-stop message is what a real provider does; abort only
		// signals, and the run settles when the stream honours that signal.
		let gate: ReturnType<typeof createAssistantMessageEventStream> | undefined;
		let gateModel: Model<Api> | undefined;
		const streamFn: StreamFn = (model, _context, _options) => {
			gate = createAssistantMessageEventStream();
			gateModel = model;
			return gate;
		};
		const service = createService(undefined, { streamFn });
		await service.initialize();
		const settledPrompt = service.sendPrompt("Long answer, please");
		await waitFor(() => gate !== undefined);

		const abortSignal = service.getSnapshot().isStreaming;
		expect(abortSignal).toBe(true);
		service.abort();
		// The provider's answer to an abort: the aborted-stop reply, which is
		// what lets the run settle at all.
		const model = gateModel!;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Cut off" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1_000,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};
		gate!.push({ type: "error", reason: "aborted", error: message });
		gate!.end(message);
		await settledPrompt;

		const finished = await (service as unknown as { sessionManager: ObsidianSessionManager }).sessionManager
			.getSession()
			.findRecords({ type: "operation_finished" });
		expect(finished).toHaveLength(1);
		// The aborted-stop reply maps to the aborted outcome, not to a failure.
		expect(finished[0]).toMatchObject({ outcome: "aborted" });
	});

	it("raises the continue offer when a load finds a run cut before its reply", async () => {
		// Crash simulation, end to end: a first process opens a run and dies
		// before its finish record; a second process loads the session off the
		// same adapter and must find the orphan where the user can act on it.
		const memory = new MemoryAdapter();
		const crashed = createService(memory);
		await crashed.initialize();
		await crashed.sendPrompt("First question");
		// The orphan write stands in for the crash: an open operation with no
		// finish, exactly the shape a killed Obsidian leaves behind.
		const manager = (crashed as unknown as { sessionManager: ObsidianSessionManager }).sessionManager;
		await manager.beginRunOperation([
			{ role: "user", content: [{ type: "text", text: "Second question" }], timestamp: Date.now() },
		]);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Second question" }], timestamp: Date.now() });

		const revived = createService(memory);
		await revived.initialize();

		expect(revived.getSnapshot().canResumeInterrupted).toBe(true);
		expect(await openOperations(revived)).toEqual([]);

		// Continuing answers the stranded words as its own run, and the offer
		// clears with it.
		await revived.resumeInterruptedRun();
		const snapshot = revived.getSnapshot();
		expect(snapshot.canResumeInterrupted).toBe(false);
		const assistantText = snapshot.messages.at(-1);
		expect(assistantText?.role).toBe("assistant");
		// The ledger is clean again: the recovery's own run opened and closed.
		expect(await openOperations(revived)).toEqual([]);
	});

	it("keeps the offer silent when the tail is the assistant's own words", async () => {
		// The reply arrived; only the close was lost. Re-offering would invite a
		// duplicate turn, so the orphan closes silently.
		const memory = new MemoryAdapter();
		const crashed = createService(memory);
		await crashed.initialize();
		await crashed.sendPrompt("First question");
		const manager = (crashed as unknown as { sessionManager: ObsidianSessionManager }).sessionManager;
		await manager.beginRunOperation([{ role: "user", content: [{ type: "text", text: "Second question" }], timestamp: Date.now() }]);
		await manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Arrived before the crash" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
			stopReason: "stop",
		});

		const revived = createService(memory);
		await revived.initialize();

		expect(revived.getSnapshot().canResumeInterrupted).toBe(false);
		expect(await openOperations(revived)).toEqual([]);
	});

	it("dismisses the offer without acting on it", async () => {
		const memory = new MemoryAdapter();
		const crashed = createService(memory);
		await crashed.initialize();
		await crashed.sendPrompt("First question");
		const manager = (crashed as unknown as { sessionManager: ObsidianSessionManager }).sessionManager;
		await manager.beginRunOperation([
			{ role: "user", content: [{ type: "text", text: "Second question" }], timestamp: Date.now() },
		]);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Second question" }], timestamp: Date.now() });

		const revived = createService(memory);
		await revived.initialize();
		expect(revived.getSnapshot().canResumeInterrupted).toBe(true);

		revived.dismissInterruptedRun();

		expect(revived.getSnapshot().canResumeInterrupted).toBe(false);
	});
});

/**
 * What the error banner is allowed to claim.
 *
 * pi reports a user's stop through the very field a provider failure uses:
 * `state.errorMessage`. Left alone, pressing stop raised an assertive alert one
 * line above the transcript's own "You stopped this reply." — a warning for
 * something the user asked for, and a duplicate of a report that was already
 * there. These tests pin the split: the abort is filtered out of the banner
 * channel, a genuine failure is not.
 */
describe("ObsidianAgentService reports every missing embed, not just the last", () => {
	/*
	 * `readVaultImages` loops over the embeds and reported each miss with
	 * `setNotice`, which *assigns* — so three broken `![[…]]` references named one
	 * path. `appendNotice` is the accumulating sibling, and it already existed for
	 * exactly this.
	 */
	it("names each embed it could not read", async () => {
		const service = createService();

		await service.sendPrompt("look at ![[missing-one.png]] and ![[missing-two.png]]");

		const notice = service.getSnapshot().noticeMessage ?? "";
		expect(notice).toContain("missing-one.png");
		expect(notice).toContain("missing-two.png");
	});
});

describe("ObsidianAgentService banner semantics: what the transcript reports, the banner does not", () => {
	/** A settled assistant turn shaped like the one a provider returns. */
	function assistantReply(model: Model<Api>, overrides: Partial<AssistantMessage>): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "Half a thou" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1_000,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
			stopReason: "stop",
			...overrides,
		};
	}

	/**
	 * Runs one turn that the provider ends with `ending`, held open until the
	 * caller's `beforeEnd` hook has run so a stop can land mid-stream.
	 *
	 * The stream is gated rather than pre-canned because the abort has to be what
	 * ends the run: `abort()` only signals, and the run settles when the stream
	 * honours that signal — which is exactly the sequence that stamps
	 * `state.errorMessage`.
	 */
	async function runTurnEndingWith(
		ending: (model: Model<Api>) => AssistantMessage,
		beforeEnd?: (service: ObsidianAgentServiceType) => void,
	): Promise<ObsidianAgentServiceType> {
		let gate: ReturnType<typeof createAssistantMessageEventStream> | undefined;
		let gateModel: Model<Api> | undefined;
		const streamFn: StreamFn = (model) => {
			gate = createAssistantMessageEventStream();
			gateModel = model;
			return gate;
		};
		const service = createService(undefined, { streamFn });
		await service.initialize();
		const settled = service.sendPrompt("Write me something long");
		await waitFor(() => gate !== undefined);
		beforeEnd?.(service);
		const message = ending(gateModel!);
		// `error` is the event pi's loop reads for both endings; `reason` carries
		// which one it was.
		gate!.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
		gate!.end(message);
		await settled;
		return service;
	}

	it("raises no banner when the user pressed stop", async () => {
		const service = await runTurnEndingWith(
			(model) =>
				assistantReply(model, {
					stopReason: "aborted",
					// The text pi's API layer stamps on a cancelled stream. It reaches
					// `state.errorMessage` through `turn_end` like any failure would.
					errorMessage: "Request was aborted",
				}),
			(live) => live.abort(),
		);

		const snapshot = service.getSnapshot();
		expect(snapshot.errorMessage).toBeUndefined();
		expect(snapshot.errorOpensSettings).toBe(false);
		// Nor is it demoted to the quiet channel: the transcript's cutoff notice
		// under the reply is the one report, and a second copy in the banner area
		// is the duplication this fixes.
		expect(snapshot.noticeMessage).toBeUndefined();
		// The turn itself still carries the marker the transcript renders from, so
		// "You stopped this reply." is unaffected by the banner's silence.
		const last = snapshot.messages.at(-1);
		expect(last?.role === "assistant" && last.stopReason).toBe("aborted");
	});

	/*
	 * The banner used to carry this, which #239 reversed. Two reasons, and the
	 * first is a correctness one: pi clears `state.errorMessage` when the next run
	 * departs, so the banner's copy of a timeout lasted exactly one turn, while
	 * `errorMessage` on the message is written to the session log by
	 * `appendMessage`'s deep clone. Second, the banner cannot say *which* turn
	 * failed, and the transcript says nothing else.
	 */
	it("keeps the banner quiet when the stream dies on the open, and pi stamps the turn", async () => {
		/*
		 * A stream that throws the moment it is opened does not reach the dispatch
		 * catch: pi's own lifecycle wraps the run, catches the throw, stamps a
		 * failed assistant turn onto the transcript, and resolves `prompt` — the
		 * reply cutoff renders the reason under the turn it belongs to. The banner
		 * reporting it too is the duplication #239 ended, so silence here is the
		 * contract, over an old failed tail and all.
		 */
		// Turn one fails mid-stream and stays on the transcript: the old shadow.
		let gate: ReturnType<typeof createAssistantMessageEventStream> | undefined;
		let gateModel: Model<Api> | undefined;
		let calls = 0;
		const streamFn: StreamFn = (model) => {
			calls++;
			if (calls === 1) {
				gate = createAssistantMessageEventStream();
				gateModel = model;
				return gate;
			}
			// The second dispatch dies the moment the run opens the stream.
			throw new Error("socket hung up before the first byte");
		};
		const service = createService(undefined, { streamFn });
		await service.initialize();
		const settled = service.sendPrompt("Write me something long");
		await waitFor(() => gate !== undefined);
		const failed = assistantReply(gateModel!, {
			stopReason: "error",
			errorMessage: "504 Gateway Time-out",
		});
		gate!.push({ type: "error", reason: "error", error: failed });
		gate!.end(failed);
		await settled;
		expect(service.getSnapshot().errorMessage).toBeUndefined();

		// Turn two dies on the open: pi stamps the failure onto the transcript…
		await service.sendPrompt("Try again");
		expect(service.getSnapshot().errorMessage).toBeUndefined();
		const stamped = service.getSnapshot().messages.at(-1);
		expect(stamped?.role === "assistant" && stamped.errorMessage).toBe("socket hung up before the first byte");
	});

	it("raises the banner for a throw inside the dispatch, before the run departs", async () => {
		/*
		 * The stream-open throw above never reaches the dispatch catch, so the
		 * pre-flight throws that do reach it are the ones inside the try itself:
		 * the snapshot notify, the compaction. This drives the notify to throw —
		 * a listener registered against the snapshot dies on its first call — and
		 * the banner must hear it.
		 *
		 * The old guard captured the tail *after* those statements, so a throw
		 * from them arrived with the capture never taken and the previous turn's
		 * tail standing in: an old failed tail then swallowed the report, and the
		 * failure landed nowhere. Capturing first is the fix; the resume path
		 * reaches the same statements without needing a live stream to get there.
		 *
		 * The bomb disarms itself after one call because the catch's own
		 * settlement notifies again — a second detonation there would escape the
		 * catch and fail the test for the wrong reason.
		 */
		const memory = new MemoryAdapter();
		const crashed = createService(memory);
		await crashed.initialize();
		await crashed.sendPrompt("First question");
		// The orphan write arms the continue offer the resume acts on.
		const manager = (crashed as unknown as { sessionManager: ObsidianSessionManager }).sessionManager;
		await manager.beginRunOperation([
			{ role: "user", content: [{ type: "text", text: "Second question" }], timestamp: Date.now() },
		]);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Second question" }], timestamp: Date.now() });

		const revived = createService(memory);
		await revived.initialize();
		let explode = false;
		revived.subscribe(() => {
			if (explode) {
				explode = false;
				throw new Error("listener died");
			}
		});
		// The immediate callback at subscribe time passed through unexploded;
		// arming now makes the dispatch's first notify the detonation.
		explode = true;

		await revived.resumeInterruptedRun();
		expect(revived.getSnapshot().errorMessage).toBe("listener died");
	});

	it("still raises the banner when the turn's own markers do not agree", async () => {
		/*
		 * The filter is never a string match on the provider's prose — that varies
		 * ("Request was aborted", "upstream aborted the connection") and would
		 * misfile a real failure that merely mentions cancellation. It requires pi's
		 * two markers to agree: the turn carries one of the two stop reasons the
		 * transcript renders a notice for, *and* carries this exact text.
		 *
		 * So this is the drift case, and it is the whole reason the rule is written
		 * as an agreement: an error stamped on a turn that claims it ended normally
		 * would render no cutoff notice, so the banner has to keep it. The failure
		 * degrades to being shown twice, never to being swallowed.
		 */
		const service = await runTurnEndingWith((model) =>
			assistantReply(model, { stopReason: "stop", errorMessage: "Upstream refused the request." }),
		);

		expect(service.getSnapshot().errorMessage).toBe("Upstream refused the request.");
	});

	it("derives the silence per snapshot rather than latching it", async () => {
		// Read from the current run's last turn every time, so one suppressed
		// report cannot silence the next.
		const stopped = await runTurnEndingWith(
			(model) => assistantReply(model, { stopReason: "aborted", errorMessage: "Request was aborted" }),
			(live) => live.abort(),
		);
		expect(stopped.getSnapshot().errorMessage).toBeUndefined();

		const drifted = await runTurnEndingWith((model) =>
			assistantReply(model, { stopReason: "stop", errorMessage: "Upstream refused the request." }),
		);
		expect(drifted.getSnapshot().errorMessage).toBe("Upstream refused the request.");
	});
});

describe("ObsidianAgentService multimodal send", () => {
	/** The content blocks the first captured request carried, for image assertions. */
	function firstRequestContent(contexts: Context[]): { type: string; text?: string; mimeType?: string }[] {
		const firstContext = contexts[0];
		if (!firstContext) {
			throw new Error("Expected at least one captured request context.");
		}
		const userMessage = firstContext.messages.find((message) => message.role === "user") as
			| { content?: unknown }
			| undefined;
		return (userMessage?.content as { type: string; text?: string; mimeType?: string }[]) ?? [];
	}

	it("blocks image send when the active model is text-only", async () => {
		// Default service selects deepseek-v4-pro, whose `input` is ["text"].
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });

		const sent = await service.sendPrompt("describe this", [
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);

		expect(sent).toBe(false);
		// The run never reached the provider.
		expect(contexts).toHaveLength(0);
		// The banner names the model and tells the user how to recover — politely,
		// since nothing failed and nothing was lost: the model just cannot take what
		// was offered, and both text and images stay with the user.
		expect(service.getSnapshot().noticeMessage).toContain("does not accept images");
		expect(service.getSnapshot().errorMessage).toBeUndefined();
	});

	it("sends staged images alongside text to a multimodal model", async () => {
		const contexts: Context[] = [];
		const { service } = createServiceWithMultimodalModel({ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });

		const sent = await service.sendPrompt("what is this", [
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);

		expect(sent).toBe(true);
		expect(contexts.length).toBeGreaterThanOrEqual(1);
		const firstContext = contexts[0];
		if (!firstContext) {
			throw new Error("Expected at least one captured request context.");
		}
		const userMessage = firstContext.messages.find((message) => message.role === "user");
		expect(userMessage).toBeTruthy();
		const content = (userMessage as { content?: unknown }).content;
		expect(Array.isArray(content)).toBe(true);
		expect((content as { type: string }[]).some((block) => block.type === "image")).toBe(true);
	});

	it("resolves ![[...]] embeds from the vault and strips them from the text", async () => {
		const contexts: Context[] = [];
		// `readVaultImages` reads via `app.vault`, not the adapter, so stage the
		// image bytes on a fake vault that resolves `cat.png`.
		const imageBytes = new TextEncoder().encode("fake-png-bytes").buffer as ArrayBuffer;
		const { service } = createServiceWithMultimodalModel(
			{ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS },
			{ imageFiles: new Map([["cat.png", imageBytes]]) },
		);

		const sent = await service.sendPrompt("Look at ![[cat.png]] please");

		expect(sent).toBe(true);
		const firstContext = contexts[0];
		if (!firstContext) {
			throw new Error("Expected at least one captured request context.");
		}
		const userMessage = firstContext.messages.find((message) => message.role === "user") as
			| { content?: unknown }
			| undefined;
		const content = (userMessage?.content as { type: string; text?: string; mimeType?: string }[]) ?? [];
		// The image travelled as ImageContent…
		expect(content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
		// …and the embed syntax was removed from the text block.
		const textBlock = content.find((block) => block.type === "text");
		expect(textBlock?.text ?? "").not.toContain("![[cat.png]]");
		expect(textBlock?.text ?? "").toContain("Look at");
	});

	it("notifies but still sends when an embed cannot be found", async () => {
		const contexts: Context[] = [];
		const { service } = createServiceWithMultimodalModel({ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });

		const sent = await service.sendPrompt("Look at ![[missing.png]] please");

		expect(sent).toBe(true);
		// The missing image surfaced as a notice, not an error that blocks.
		expect(service.getSnapshot().noticeMessage).toContain("missing.png");
		// No image block reached the model — only the text, embed stripped.
		const firstContext = contexts[0];
		if (!firstContext) {
			throw new Error("Expected at least one captured request context.");
		}
		const userMessage = firstContext.messages.find((message) => message.role === "user") as
			| { content?: unknown }
			| undefined;
		const content = (userMessage?.content as { type: string }[]) ?? [];
		expect(content.some((block) => block.type === "image")).toBe(false);
	});

	it("resolves a shortest-path embed through the link index, anchored on the active note", async () => {
		const contexts: Context[] = [];
		const imageBytes = new TextEncoder().encode("fake-png-bytes").buffer as ArrayBuffer;
		// `cat.png` lives in an attachment folder and the embed names it by the
		// shortest path — a reference `getFileByPath` cannot answer, so the index
		// is asked exactly as Obsidian would ask it: the linkpath first, and the
		// note the embed was written in as the source the resolution anchors on.
		const linkCalls: { linkpath: string; sourcePath: string }[] = [];
		const { service } = createServiceWithMultimodalModel(
			{ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS },
			{
				imageFiles: new Map([["attachments/cat.png", imageBytes]]),
				linkIndex: (linkpath, sourcePath) => {
					linkCalls.push({ linkpath, sourcePath });
					return { path: "attachments/cat.png" } as TFile;
				},
			},
		);
		service.setActiveNotePath("Notes/daily.md");

		const sent = await service.sendPrompt("Look at ![[cat.png]] please");

		expect(sent).toBe(true);
		expect(linkCalls).toEqual([{ linkpath: "cat.png", sourcePath: "Notes/daily.md" }]);
		const content = firstRequestContent(contexts);
		expect(content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
		// The embed syntax was still removed from the text block.
		const textBlock = content.find((block) => block.type === "text");
		expect(textBlock?.text ?? "").not.toContain("![[cat.png]]");
	});

	it("resolves a full-path embed by exact lookup, with the link index never asked", async () => {
		const contexts: Context[] = [];
		const imageBytes = new TextEncoder().encode("fake-png-bytes").buffer as ArrayBuffer;
		// The index answers nothing at all — an unready index, say. That must not
		// cost a full path anything: the exact lookup runs first, so the fallback
		// only ever sees a reference the lookup already failed on. Recording the
		// index's calls pins that ordering rather than just the outcome.
		const linkCalls: { linkpath: string; sourcePath: string }[] = [];
		const { service } = createServiceWithMultimodalModel(
			{ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS },
			{
				imageFiles: new Map([["attachments/cat.png", imageBytes]]),
				linkIndex: (linkpath, sourcePath) => {
					linkCalls.push({ linkpath, sourcePath });
					return null;
				},
			},
		);
		service.setActiveNotePath("Notes/daily.md");

		const sent = await service.sendPrompt("Look at ![[attachments/cat.png]] please");

		expect(sent).toBe(true);
		expect(linkCalls).toEqual([]);
		expect(firstRequestContent(contexts).some((block) => block.type === "image")).toBe(true);
		// Nothing was dropped, so nothing earned a notice.
		expect(service.getSnapshot().noticeMessage).toBeUndefined();
	});

	it("reports a shortest-path embed the link index cannot resolve", async () => {
		const contexts: Context[] = [];
		const imageBytes = new TextEncoder().encode("fake-png-bytes").buffer as ArrayBuffer;
		// Same shape as the resolvable case, but the index has nothing for the
		// name — an unready index, or a link pointing nowhere. The miss surfaces
		// the way it does for a full path: a notice, and no image in the send.
		const { service } = createServiceWithMultimodalModel(
			{ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS },
			{
				imageFiles: new Map([["attachments/cat.png", imageBytes]]),
				linkIndex: () => null,
			},
		);
		service.setActiveNotePath("Notes/daily.md");

		const sent = await service.sendPrompt("Look at ![[cat.png]] please");

		expect(sent).toBe(true);
		expect(service.getSnapshot().noticeMessage).toContain("cat.png");
		expect(firstRequestContent(contexts).some((block) => block.type === "image")).toBe(false);
	});

	it("persists a placeholder, not base64, for an image-bearing user message", async () => {
		const adapter = new MemoryAdapter();
		const { service } = createServiceWithMultimodalModel({}, undefined, adapter);

		await service.sendPrompt("see this", [
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);

		const sessionPath = service.getSnapshot().session?.path ?? "";
		const logged = await adapter.read(sessionPath);
		// The session log must carry the placeholder text…
		expect(logged).toContain("[image: image/png]");
		// …and must never carry the raw base64 bytes.
		expect(logged).not.toContain("AAAA");
	});
});

/** Wraps SSE frames in the buffered body Obsidian's `requestUrl` returns. */
function sseResponse(frames: object[]): { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer } {
	const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
	return {
		status: 200,
		headers: { "content-type": "text/event-stream" },
		arrayBuffer: new TextEncoder().encode(body).buffer as ArrayBuffer,
	};
}

/** A chat-completions chunk carrying part of the summarizer's answer. */
function summaryChunk(text = "SUMMARY OF EARLIER TURNS"): object {
	return { id: "c1", choices: [{ delta: { content: text }, finish_reason: null }] };
}

/** A user-visible assistant reply, ending with a usage-charged stop. */
function replyChunks(text: string): object[] {
	return [
		{ id: "c1", choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
		{ id: "c1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
}

/** Final chunk with finish_reason and usage, as OpenAI-compatible providers emit. */
function usageChunk(): object {
	return {
		id: "c1",
		choices: [{ delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
	};
}

/**
 * The model the chat panel's switcher writes.
 *
 * This is the one setting a chat-panel control changes, so the service is where
 * the write has to be safe: the panel offers a list of ids and the service is
 * what decides whether one of them may become the endpoint every subsequent
 * request goes to.
 */
/*
 * Exporting the transcript as a vault note. The note is written through the
 * vault API — not the adapter — so `createFakeApp`'s create/createFolder pair
 * registers what a reader would open, and each assertion reads the note back
 * the same way the panel's "open the file" step resolves it.
 */
describe("exporting a session as a note", () => {
	it("writes the transcript beside its session log and returns the path", async () => {
		const vaultFiles: Record<string, string> = {};
		const service = createService(new MemoryAdapter(), { vaultFiles });
		await service.sendPrompt("First ask");
		await service.sendPrompt("Second ask");

		const path = await service.exportSessionAsNote();

		expect(path).toBe(`${DEFAULT_SESSION_DIR}/First ask.md`);
		const note = vaultFiles[`${DEFAULT_SESSION_DIR}/First ask.md`] ?? "";
		expect(note).toContain("# First ask");
		expect(note).toContain("First ask");
		expect(note).toContain("Second ask");
		expect(note).toContain("Done");
	});

	it("numbers a second export of an identically named chat instead of overwriting", async () => {
		const vaultFiles: Record<string, string> = {};
		const service = createService(new MemoryAdapter(), { vaultFiles });
		await service.sendPrompt("Hello");

		const first = await service.exportSessionAsNote();
		const second = await service.exportSessionAsNote();

		expect(first).toBe(`${DEFAULT_SESSION_DIR}/Hello.md`);
		expect(second).toBe(`${DEFAULT_SESSION_DIR}/Hello 2.md`);
		expect(vaultFiles[`${DEFAULT_SESSION_DIR}/Hello.md`]).toBeDefined();
		expect(vaultFiles[`${DEFAULT_SESSION_DIR}/Hello 2.md`]).toBeDefined();
	});

	it("answers null for an empty chat instead of writing a heading with nothing under it", async () => {
		const service = createService();

		expect(await service.exportSessionAsNote()).toBeNull();
	});
	// No "transcript without a session" case: the manager creates the session
	// entry before the first message lands, so a transcript always has one.
});

describe("recording a reply's duration", () => {
	/** The message entries of a session log, in order. */
	async function loggedMessages(adapter: MemoryAdapter, sessionPath: string): Promise<AssistantMessage[]> {
		const entries = (await adapter.read(sessionPath))
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as { type?: string; message?: AssistantMessage });
		return entries.filter((entry) => entry.type === "message").map((entry) => entry.message!) as AssistantMessage[];
	}

	it("stamps each settled reply with the gap from its own start, in the log", async () => {
		// The fake stream answers immediately, so `Date.now()` at `message_end`
		// is only a fraction past the message's own timestamp — the honest
		// shape of the measurement, even though it is too short to ever be
		// shown. The claim under test is that the field exists on disk at all:
		// the UI reads it back from the JSONL, so writing it there is the
		// feature.
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("How long did that take?");

		const sessionPath = service.getSnapshot().session?.path ?? "";
		const messages = await loggedMessages(adapter, sessionPath);
		const replies = messages.filter((message) => message.role === "assistant");
		expect(replies).toHaveLength(1);
		const durationMs = (replies[0] as { durationMs?: number }).durationMs;
		expect(typeof durationMs).toBe("number");
		expect(durationMs).toBeGreaterThanOrEqual(0);
	});

	it("leaves user messages unstamped, including pi's injected steering prompts", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("Just a question");

		const sessionPath = service.getSnapshot().session?.path ?? "";
		const messages = await loggedMessages(adapter, sessionPath);
		for (const message of messages) {
			if (message.role !== "assistant") {
				expect(message).not.toHaveProperty("durationMs");
			}
		}
	});

	it("survives a reload, so a reopened session still knows how long it took", async () => {
		// The stamp rides the message through `sanitizeMessageForLog` and the
		// manager's deep clone; the point of putting it on the message itself
		// rather than a side table is exactly this read-back.
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("First ask");
		const sessionPath = service.getSnapshot().session?.path ?? "";

		const revived = createService(adapter);
		await revived.openSession(sessionPath);

		const replies = revived.getSnapshot().messages.filter((message) => message.role === "assistant");
		expect(replies).toHaveLength(1);
		expect(typeof (replies[0] as { durationMs?: number }).durationMs).toBe("number");
	});
});

describe("switching the active model", () => {
	it("offers the configured models to the panel, named rather than as ids", () => {
		const { service, settings } = createServiceWithSettings();
		configureTwoModels(settings);

		expect(service.getSnapshot().modelChoices).toEqual([
			{ id: "m1", name: "Qwen Plus", provider: "My gateway" },
			{ id: "m2", name: "Llama 4", provider: "My gateway" },
		]);
		expect(service.getSnapshot().activeModelId).toBe("m1");
	});

	it("repoints requests, and says so in the next snapshot", async () => {
		const { service, settings } = createServiceWithSettings();
		configureTwoModels(settings);

		await service.setActiveModel("m2");

		expect(settings.activeModelId).toBe("m2");
		expect(service.getSnapshot().activeModelId).toBe("m2");
		// The resolved model is what a request is actually built from, so this is
		// the assertion that the switch reached the wire and not just the label.
		expect(service.getSnapshot().modelId).toBe("llama-4-maverick");
	});

	it("persists through the host, which is what survives a reload", async () => {
		// The plugin's own `saveSettings` seals secrets, writes data.json, and
		// reconfigures the running agent on the way back. A switch that only
		// mutated the in-memory object would be lost on the next launch.
		const saves: number[] = [];
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), {
			persistSettings: async () => {
				saves.push(1);
			},
		});
		configureTwoModels(settings);

		await service.setActiveModel("m2");

		expect(saves).toHaveLength(1);
	});

	it("ignores an id that names no configured model, rather than storing it", async () => {
		// A dangling `activeModelId` does not fail loudly: `getSelectedModel`
		// answers the next request from the builtin catalog instead, so the user
		// talks to a different endpoint than the one they selected.
		const { service, settings } = createServiceWithSettings();
		configureTwoModels(settings);

		await service.setActiveModel("deleted");

		expect(settings.activeModelId).toBe("m1");
	});

	it("does no work when the model is already active", async () => {
		// Persisting reconfigures the agent and appends to the session log, so a
		// no-op selection must not spend either.
		const saves: number[] = [];
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), {
			persistSettings: async () => {
				saves.push(1);
			},
		});
		configureTwoModels(settings);

		await service.setActiveModel("m1");

		expect(saves).toEqual([]);
	});

	it("reconfigures the live agent, so a switch mid-conversation takes effect", async () => {
		const { service, settings } = createServiceWithSettings();
		await service.initialize();
		configureTwoModels(settings);

		await service.setActiveModel("m2");

		// No `persistSettings` was supplied, so the default path reconfigures in
		// memory alone — which is the half that has to reach `agent.state.model`.
		expect(service.getSnapshot().modelId).toBe("llama-4-maverick");
	});
});

/** Two models behind one named provider, with the first selected. */
function configureTwoModels(settings: PiemSettings): void {
	settings.providers = [
		{ id: "p1", name: "My gateway", baseUrl: "https://gw/v1", protocol: "openai-completions", apiKey: "gw-key", secretRef: "", source: "user" },
	];
	settings.models = [
		{ id: "m1", providerId: "p1", modelApiId: "qwen-plus", displayName: "Qwen Plus", reasoning: false, supportsImages: false },
		{ id: "m2", providerId: "p1", modelApiId: "llama-4-maverick", displayName: "Llama 4", reasoning: false, supportsImages: false },
	];
	settings.activeModelId = "m1";
}

/**
 * A mid-run change is held, not refused (issue #252): the settings half writes
 * through at once and the live-agent half lands when the run settles. These
 * tests pin the whole deferred-apply contract — the hold, the single flush, the
 * clamp against the pending model, and the edges (departed runtime, abort,
 * delete) that the flush has to survive.
 */
describe("mid-run model and thinking changes (issue #252)", () => {
	/**
	 * A streamFn that records the model of every request and hangs the first one
	 * until released — the stand-in for a run in flight while the user
	 * reconfigures underneath it.
	 */
	function createRecordingGatedStreamFn() {
		const requestedModels: string[] = [];
		let requestCount = 0;
		let gate: ReturnType<typeof createAssistantMessageEventStream> | undefined;
		let gateModel: Model<Api> | undefined;
		const streamFn: StreamFn = (model, _context, _options) => {
			requestedModels.push(model.id);
			requestCount += 1;
			if (requestCount === 1) {
				gate = createAssistantMessageEventStream();
				gateModel = model;
				return gate;
			}
			return scriptedTextStream(model, "Second reply");
		};
		return {
			streamFn,
			requestedModels,
			waitForFirstRequest: () => waitFor(() => requestCount === 1),
			// Same shape `scriptedTextStream` builds; the model is only known once
			// the request arrives, so the reply is assembled at release time.
			release: () => {
				const model = gateModel;
				const target = gate;
				if (!model || !target) {
					throw new Error("release before the first request");
				}
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "First reply" }],
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
				target.push({ type: "done", reason: "stop", message });
				target.end(message);
			},
		};
	}

	/** A runtime's live state, for assertions the focused snapshot cannot make. */
	function peekRuntime(service: ObsidianAgentServiceType, path: string): SessionRuntime | undefined {
		return (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get(path);
	}

	/** Records which runtime each reconfigure lands on, shadowing the private method. */
	function spyReconfigures(service: ObsidianAgentServiceType): string[] {
		const paths: string[] = [];
		const target = service as unknown as { reconfigureRuntime: (rt: SessionRuntime) => Promise<void> };
		const original = target.reconfigureRuntime.bind(service);
		target.reconfigureRuntime = async (rt) => {
			paths.push(rt.sessionPath);
			await original(rt);
		};
		return paths;
	}

	it("defers a mid-run switch: the setting writes through, the run keeps its model", async () => {
		const gated = createRecordingGatedStreamFn();
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), { streamFn: gated.streamFn });
		configureTwoModels(settings);

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();

		await service.setActiveModel("m2");

		expect(settings.activeModelId).toBe("m2");
		// `modelId` is settings-derived and has moved on; `runningModelId` is what
		// the live agent sends with, and the run in flight keeps what it began on.
		expect(service.getSnapshot().modelId).toBe("llama-4-maverick");
		expect(service.getSnapshot().runningModelId).toBe("qwen-plus");
		expect(peekRuntime(service, service.getActiveSessionPath() ?? "")?.pendingConfiguration).toEqual({ modelId: "m2" });

		gated.release();
		await run;
	});

	it("persists a mid-run switch with the reconfigure skipped, and an idle one with it intact", async () => {
		// The skip is the whole trick: without it the host's `saveSettings` would
		// swap the live agent's model out from under the streaming request.
		const persisted: Array<{ reconfigure?: boolean } | undefined> = [];
		const gated = createRecordingGatedStreamFn();
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), {
			streamFn: gated.streamFn,
			persistSettings: async (options) => {
				persisted.push(options);
			},
		});
		configureTwoModels(settings);

		await service.setActiveModel("m2");
		expect(persisted).toEqual([undefined]);

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();
		await service.setActiveModel("m1");
		expect(persisted).toEqual([undefined, { reconfigure: false }]);
		expect(peekRuntime(service, service.getActiveSessionPath() ?? "")?.agent?.state.model.id).toBe("llama-4-maverick");

		gated.release();
		await run;
	});

	it("applies the pending switch exactly once when the run lands", async () => {
		// A queued steer puts both flush callers on the path: the `agent_end`
		// dispatch and the send's own settle. Take-then-apply is what keeps the
		// second one from doing the work a second time.
		const gated = createRecordingGatedStreamFn();
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), { streamFn: gated.streamFn });
		configureTwoModels(settings);

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();
		// Installed after the first request: a fresh send reconfigures on the way
		// out, and that pass is not the deferred-apply under test.
		const reconfigures = spyReconfigures(service);
		await service.setActiveModel("m2");
		expect(await service.sendPrompt("Now answer on the new one")).toBe(true);

		gated.release();
		await run;
		await waitFor(() => gated.requestedModels.length >= 2);

		expect(reconfigures).toHaveLength(1);
		const rt = peekRuntime(service, service.getActiveSessionPath() ?? "");
		expect(rt?.pendingConfiguration).toBeNull();
		expect(rt?.agent?.state.model.id).toBe("llama-4-maverick");
		expect(service.getSnapshot().runningModelId).toBe("llama-4-maverick");
		// The steered follow-up is where the deferral pays off for steers pi
		// rescues after the run: they leave on the model the user asked for.
		expect(gated.requestedModels[0]).toBe("qwen-plus");
		expect(gated.requestedModels[1]).toBe("qwen-plus");
		// pi's steering mode ("all") injects queued steers synchronously at the
		// turn boundary — before this service's `agent_end` handlers and its
		// settle-time flush run — so the injected follow-up still goes out on
		// the model the run began on. The flush's win here is the applied state
		// asserted above; a follow-up a *later* run rescues
		// (resumeQueuedPrompts) is the one that lands on the new model.
	});

	it("lets the last mid-run choice win when the user changes their mind twice", async () => {
		const gated = createRecordingGatedStreamFn();
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), { streamFn: gated.streamFn });
		configureTwoModels(settings);

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();
		const reconfigures = spyReconfigures(service);

		await service.setActiveModel("m2");
		await service.setActiveModel("m1");

		expect(peekRuntime(service, service.getActiveSessionPath() ?? "")?.pendingConfiguration).toEqual({ modelId: "m1" });

		gated.release();
		await run;
		await waitFor(() => reconfigures.length >= 1);

		// One flush, and it lands on the second choice: m1, not the m2 picked first.
		expect(reconfigures).toHaveLength(1);
		const rt = peekRuntime(service, service.getActiveSessionPath() ?? "");
		expect(rt?.pendingConfiguration).toBeNull();
		expect(rt?.agent?.state.model.id).toBe("qwen-plus");
	});

	it("clamps a pending thinking level to the model it lands on, and logs the clamped value once", async () => {
		// Neither model reasons, so "high" can only ever apply as "off" — the
		// point is that the clamp reads the pending model at flush time and that
		// the session log records what was actually applied, not what was asked.
		const gated = createRecordingGatedStreamFn();
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), { streamFn: gated.streamFn });
		configureTwoModels(settings);

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();

		await service.setThinkingLevel("high");
		await service.setActiveModel("m2");

		const manager = (service as unknown as { sessionManager: ObsidianSessionManager }).sessionManager;
		const appended: string[] = [];
		const originalAppend = manager.appendThinkingLevelChangeFor.bind(manager);
		(
			manager as unknown as { appendThinkingLevelChangeFor: typeof manager.appendThinkingLevelChangeFor }
		).appendThinkingLevelChangeFor = async (path: string, level: ThinkingLevel, lane?: string) => {
			appended.push(level);
			return originalAppend(path, level, lane);
		};

		gated.release();
		await run;
		await waitFor(() => appended.length >= 1);

		const rt = peekRuntime(service, service.getActiveSessionPath() ?? "");
		expect(rt?.agent?.state.thinkingLevel).toBe("off");
		expect(appended).toEqual(["off"]);
		expect(rt?.pendingConfiguration).toBeNull();
	});

	it("reconfigures a departed runtime when its background run lands", async () => {
		const gated = createRecordingGatedStreamFn();
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), { streamFn: gated.streamFn });
		configureTwoModels(settings);

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();
		const departed = service.getActiveSessionPath() ?? "";
		await service.setActiveModel("m2");

		// The panel moves on; the run in flight keeps its runtime and its run.
		await service.newSession();
		expect(service.getActiveSessionPath()).not.toBe(departed);

		const reconfigures = spyReconfigures(service);
		const beforeRelease = reconfigures.length;
		gated.release();
		await run;
		await waitFor(() => reconfigures.length > beforeRelease);

		// The flush targets the session that is still finishing, not the one on
		// screen — and the new session's setup is the only other work in the log.
		expect(reconfigures.slice(beforeRelease)).toEqual([departed]);
		const rt = peekRuntime(service, departed);
		expect(rt?.agent?.state.model.id).toBe("llama-4-maverick");
		expect(rt?.pendingConfiguration).toBeNull();
	});

	it("still applies a pending change after the user aborts the run", async () => {
		const gated = createRecordingGatedStreamFn();
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), { streamFn: gated.streamFn });
		configureTwoModels(settings);

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();
		await service.setActiveModel("m2");

		// Abort only signals; a gated stream that ignores its signal never
		// settles, so the reply has to flow for the run to actually end.
		gated.release();
		service.abort();
		await run;
		await waitFor(() => !peekRuntime(service, service.getActiveSessionPath() ?? "")?.pendingConfiguration);

		const rt = peekRuntime(service, service.getActiveSessionPath() ?? "");
		expect(rt?.agent?.state.model.id).toBe("llama-4-maverick");
		expect(service.getSnapshot().runningModelId).toBe("llama-4-maverick");
	});

	it("drops a deleted session's pending change without touching anything", async () => {
		const gated = createRecordingGatedStreamFn();
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), { streamFn: gated.streamFn });
		configureTwoModels(settings);

		const run = service.sendPrompt("First question");
		await gated.waitForFirstRequest();
		const doomed = service.getActiveSessionPath() ?? "";
		await service.setActiveModel("m2");

		// `removeRuntime` clears the hold before the settle closure reaches the
		// flush, so the flush must find nothing to do — and throw nothing.
		const reconfigures = spyReconfigures(service);
		await service.deleteSession(doomed);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(reconfigures).toEqual([]);
		expect(service.getActiveSessionPath()).not.toBe(doomed);
		// The focused session is now the replacement, whose agent was built from
		// settings *after* the mid-run switch — already on the new model.
		expect(service.getSnapshot().runningModelId).toBe("llama-4-maverick");
		expect(peekRuntime(service, doomed)).toBeUndefined();
	});
});

describe("language in the snapshot", () => {
	it("resolves the user's setting so the panel never re-resolves it", () => {
		const { service, settings } = createServiceWithSettings();
		expect(service.getSnapshot().language).toBe("en");
		settings.language = "zh-cn";
		expect(service.getSnapshot().language).toBe("zh-cn");
	});

	it("resolves auto to English when the host reports no language", () => {
		const { service, settings } = createServiceWithSettings();
		settings.language = "auto";
		expect(service.getSnapshot().language).toBe("en");
	});

	it("tells subscribers a setting changed even with no agent to reconfigure", async () => {
		// Regression: refreshConfiguration returned before notify() when no agent
		// had been built, so switching language left an open panel in the old one.
		const { service, settings } = createServiceWithSettings();
		const seen: string[] = [];
		const unsubscribe = service.subscribe((snapshot) => seen.push(snapshot.language));
		settings.language = "zh-cn";
		await service.refreshConfiguration();
		unsubscribe();
		expect(seen).toEqual(["en", "zh-cn"]);
	});
});

describe("prompt commands", () => {
	it("picks up a template saved after the conversation started, on the next send", async () => {
		// Templates used to load once, in `initializeAgent`, so a file saved on disk
		// did nothing until the plugin was reloaded — while an edited *skill* took
		// effect on the very next message. Both are `.md` under a vault folder and
		// both are `/name` commands in the same autocomplete menu, so there was no
		// story that made the difference explicable to anyone.
		// `createVaultAppWithSkills` rather than the `vaultFiles` option: that one
		// snapshots at construction, so a file added mid-test would be invisible to
		// the stub regardless of what the service does. This one derives its file
		// list per call, which is what lets the assertion be about the reload.
		const contexts: Context[] = [];
		const vaultFiles: Record<string, string> = {};
		const service = new ObsidianAgentService(
			createVaultAppWithSkills(vaultFiles),
			() => defaultTestSettings(),
			new ObsidianSessionManager(asDataAdapter(new MemoryAdapter()), SESSION_DIR, "obsidian-vault:Test"),
			{ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS },
		);

		await service.sendPrompt("Hello");
		vaultFiles["Piem/prompts/fresh.md"] = "FRESH TEMPLATE BODY: $ARGUMENTS";

		expect(await service.sendPrompt("/fresh with detail")).toBe(true);
		const sent = lastUserContent(contexts.at(-1));
		expect(sent).toContain("FRESH TEMPLATE BODY: with detail");
	});

	it("keeps template load problems out of the chat panel", async () => {
		// Same rule as skills: a malformed file of the user's own is not a chat
		// failure, and this load runs on every send, so the banner would re-raise it
		// once per message with nothing beside it that could act on the problem.
		const service = createService(new MemoryAdapter(), {
			vaultFiles: { "Piem/prompts/bad.md": "---\ndescription: : :\n---\nbody" },
		});

		await service.sendPrompt("Hello");

		expect(service.getSnapshot().noticeMessage).toBeUndefined();
		expect(service.getSnapshot().errorMessage).toBeUndefined();
		// Stored for the settings surface instead, on the same report the skill
		// layers use — they load together and are reported on as one thing.
		expect(service.getSkillLoad().templates.length).toBeGreaterThan(0);
	});

	it("sends the expanded template body, not the /name the user typed", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), {
			streamFn: createCapturingStreamFn(contexts),
			vaultFiles: { "Piem/prompts/echo.md": "---\ndescription: Echo it back\n---\nRepeat this verbatim: $ARGUMENTS" },
		});

		expect(await service.sendPrompt("/echo hello world")).toBe(true);

		// The model must see the expansion; the raw `/echo …` never reaches it.
		const sent = lastUserMessage(contexts.at(-1));
		expect(sent?.role).toBe("user");
		expect(JSON.stringify(sent?.content)).toContain("Repeat this verbatim: hello world");
		expect(JSON.stringify(sent?.content)).not.toContain("/echo");
	});

	it("honours quoting when splitting arguments", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), {
			streamFn: createCapturingStreamFn(contexts),
			vaultFiles: { "Piem/prompts/pair.md": "First is $1 and second is $2." },
		});

		await service.sendPrompt('/pair one "two three"');

		// pi's parseCommandArgs keeps the quoted span as a single positional, so
		// `$2` is the whole phrase rather than just `two`.
		expect(lastUserContent(contexts.at(-1))).toContain("First is one and second is two three.");
	});

	it("refuses an unknown /name with a notice instead of sending it as prose", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });

		expect(await service.sendPrompt("/nope")).toBe(false);

		// A typo'd command is a mistake, not a message: sending it verbatim would
		// waste a turn asking the model about a slash the user meant as a command.
		expect(service.getSnapshot().noticeMessage).toBe("Unknown command: /nope");
		expect(contexts).toHaveLength(0);
	});

	it("resolves a builtin on the first message of a session", async () => {
		// Regression: the command lookup used to run before initialize(), which is
		// what loads the templates, so the first `/summarize` of a session was
		// reported as unknown.
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });

		expect(await service.sendPrompt("/summarize")).toBe(true);
		expect(lastUserContent(contexts.at(-1))).toContain("Summarize the active note concisely.");
	});

	it("offers builtins and vault templates together for autocomplete", async () => {
		const service = createService(new MemoryAdapter(), {
			vaultFiles: { "Piem/prompts/echo.md": "---\ndescription: Echo it back\n---\nRepeat: $ARGUMENTS" },
		});
		await service.initialize();

		const commands = service.getSnapshot().availableCommands;
		const names = commands.map((command) => command.name);
		expect(names).toContain("summarize");
		expect(names).toContain("echo");
		expect(commands.find((command) => command.name === "echo")?.kind).toBe("template");
		expect(commands.find((command) => command.name === "link-graph")?.kind).toBe("skill");
		const summarizeCommands = commands.filter((command) => command.name === "summarize");
		expect(summarizeCommands).toHaveLength(2);
		expect(summarizeCommands[0]).toMatchObject({ kind: "template", invocation: "summarize" });
		expect(summarizeCommands[1]).toMatchObject({ kind: "skill", invocation: "skill:summarize" });
	});

	it("uses the template on a short-name collision and keeps the skill reachable explicitly", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), {
			streamFn: createCapturingStreamFn(contexts),
			vaultFiles: {
				"Piem/prompts/review.md": "PROMPT VERSION: $ARGUMENTS",
				"Piem/skills/review/SKILL.md": "---\nname: review\ndescription: Skill version\n---\nSKILL VERSION",
			},
		});

		expect(await service.sendPrompt("/review first")).toBe(true);
		expect(lastUserContent(contexts.at(-1))).toContain("PROMPT VERSION: first");
		expect(service.getSnapshot().noticeMessage).toContain("use /skill:review for the skill");

		expect(await service.sendPrompt("/skill:review focus on risks")).toBe(true);
		const explicit = lastUserContent(contexts.at(-1));
		expect(explicit).toContain("SKILL VERSION");
		expect(explicit).toContain("focus on risks");
	});

	it("leaves an ordinary message that merely contains a slash alone", async () => {
		const contexts: Context[] = [];
		const service = createService(new MemoryAdapter(), { streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS });

		expect(await service.sendPrompt("what does src/main.ts do?")).toBe(true);
		expect(lastUserContent(contexts.at(-1))).toContain("what does src/main.ts do?");
	});
});

describe("vault skills", () => {
	/** Captures the system prompt the fake provider actually received. */
	function createPromptCapturingStreamFn(prompts: string[]): StreamFn {
		return (_model, context) => {
			prompts.push(context.systemPrompt ?? "");
			return createFakeStreamFn()(_model, context);
		};
	}

	const SUMMARIZE_SKILL = "---\nname: summarize\ndescription: Summarize a note\n---\nDo the summary.";

	function createSkillsService(app: App, prompts: string[], logger?: LoggerLike): ObsidianAgentServiceType {
		return new ObsidianAgentService(
			app,
			() => defaultTestSettings(),
			new ObsidianSessionManager(asDataAdapter(new MemoryAdapter()), SESSION_DIR, "obsidian-vault:Test"),
			{ streamFn: createPromptCapturingStreamFn(prompts), loadUserSkills: NO_USER_SKILLS, logger },
		);
	}

	it("reports nothing before a load has happened, rather than inventing folders", async () => {
		// The settings tab renders this shape when opened before any chat, which is
		// why it must be honest about having looked at nothing: `searched` listing
		// the built-in pair would claim a probe that never ran, the exact confusion
		// `UserSkillsSearchEntry.found` distinguishes. The panel awaits
		// `refreshSkills` before every render to make the field current — this pins
		// what it would otherwise render.
		const service = createSkillsService(createVaultAppWithSkills({}), []);

		expect(service.getSkillLoad()).toEqual({ vault: [], user: { skills: [], diagnostics: [], searched: [] }, templates: [] });
	});

	it("makes the load current for a caller that awaits refreshSkills", async () => {
		// The panel's whole contract: await this, then read the field. If the field
		// were populated later — on the next send, say — the tab would render the
		// previous load and the report would describe a read the agent had moved on
		// from.
		const service = createSkillsService(
			createVaultAppWithSkills({ "Piem/skills/bad/SKILL.md": "---\nname: Not_A_Name\ndescription: broken\n---\nBody" }),
			[],
		);

		await service.refreshSkills();

		expect(service.getSkillLoad().vault.length).toBeGreaterThan(0);
	});

	it("logs each load problem once, not once per message sent", async () => {
		// The log is where the detail lives now that the banner does not carry it,
		// and `reloadSkills` runs on every send — so an unreadable folder that stays
		// unreadable would write one line per user message into a 2000-record ring,
		// burying the very detail the log view exists to show. The fingerprint is
		// what makes a standing problem legible instead of a flood.
		const { logger, records } = spyLogger();
		const service = createSkillsService(
			createVaultAppWithSkills({ "Piem/skills/bad/SKILL.md": "---\nname: Not_A_Name\ndescription: broken\n---\nBody" }),
			[],
			logger,
		);

		await service.sendPrompt("Hello");
		const afterFirst = records.filter((record) => record.level === "warn").length;
		await service.sendPrompt("Hello again");
		await service.sendPrompt("And again");

		expect(afterFirst).toBeGreaterThan(0);
		expect(records.filter((record) => record.level === "warn").length).toBe(afterFirst);
		// The code and the path ride the log even though the panel shows neither:
		// this is where a bug report gets assembled.
		const warned = records.find((record) => record.level === "warn");
		expect(warned?.detail?.code).toBe("invalid_metadata");
		expect(warned?.detail?.path).toContain("bad/SKILL.md");
		expect(warned?.detail?.layer).toBe("vault-skills");
	});

	it("logs again once the problems on disk actually change", async () => {
		// Deduping must not become silence: a user who fixes one file and breaks
		// another has a different problem, and the log has to say so.
		const skillFiles: Record<string, string> = { "Piem/skills/bad/SKILL.md": "---\nname: Not_A_Name\ndescription: broken\n---\nBody" };
		const { logger, records } = spyLogger();
		const service = createSkillsService(createVaultAppWithSkills(skillFiles), [], logger);

		await service.sendPrompt("Hello");
		const afterFirst = records.filter((record) => record.level === "warn").length;

		delete skillFiles["Piem/skills/bad/SKILL.md"];
		skillFiles["Piem/skills/worse/SKILL.md"] = "---\nname: Also_Bad\ndescription: broken\n---\nBody";
		await service.sendPrompt("Hello again");

		expect(records.filter((record) => record.level === "warn").length).toBeGreaterThan(afterFirst);
	});

	it("composes vault skills into the system prompt the model receives", async () => {
		// The prompt travels through state into the request context, so asserting
		// on what the streamFn saw proves the whole path, not just the field.
		const prompts: string[] = [];
		const service = createSkillsService(
			createVaultAppWithSkills({ "Piem/skills/summarize/SKILL.md": SUMMARIZE_SKILL }),
			prompts,
		);

		await service.sendPrompt("Hello");

		const prompt = prompts.at(-1) ?? "";
		expect(prompt.startsWith("You are Piem inside Obsidian.")).toBe(true);
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("summarize");
		expect(prompt).toContain("Piem/skills/summarize/SKILL.md");
	});

	it("includes bundled skills when the vault has no skill files", async () => {
		const prompts: string[] = [];
		const service = createSkillsService(createFakeApp(asDataAdapter(new MemoryAdapter())), prompts);

		await service.sendPrompt("Hello");

		const prompt = prompts.at(-1) ?? "";
		expect(prompt.startsWith(OBSIDIAN_AGENT_SYSTEM_PROMPT)).toBe(true);
		expect(prompt).toContain("<available_skills>");
		for (const name of ["summarize", "link-graph", "tag-organize", "find-skills"]) {
			expect(prompt).toContain(`<name>${name}</name>`);
		}
	});

	it("injects a bundled skill's complete instructions and additional request", async () => {
		const contexts: Context[] = [];
		const service = new ObsidianAgentService(
			createFakeApp(asDataAdapter(new MemoryAdapter())),
			() => defaultTestSettings(),
			new ObsidianSessionManager(asDataAdapter(new MemoryAdapter()), SESSION_DIR, "obsidian-vault:Test"),
			{ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS },
		);

		expect(await service.sendPrompt("/link-graph focus on unresolved links")).toBe(true);

		const sent = lastUserContent(contexts.at(-1));
		expect(sent).toContain("link-graph");
		expect(sent).toContain("Call get_note_links with direction set to both");
		expect(sent).toContain("focus on unresolved links");
	});

	it("lets a vault skill override bundled content and provenance", async () => {
		const contexts: Context[] = [];
		const app = createVaultAppWithSkills({
			"Piem/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: My summary\n---\nMY VAULT INSTRUCTIONS",
		});
		const service = new ObsidianAgentService(
			app,
			() => defaultTestSettings(),
			new ObsidianSessionManager(asDataAdapter(new MemoryAdapter()), SESSION_DIR, "obsidian-vault:Test"),
			{ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS },
		);

		expect(await service.sendPrompt("/skill:summarize")).toBe(true);

		const sent = lastUserContent(contexts.at(-1));
		expect(sent).toContain("MY VAULT INSTRUCTIONS");
		expect(sent).toContain("Piem/skills/summarize/SKILL.md");
		expect(sent).not.toContain("Call get_active_note");
	});

	it("keeps skill load problems out of the chat panel entirely", async () => {
		// The reported defect: `EACCES: permission denied, realpath '…'` from a
		// home-directory folder appeared in the chat banner. These are reports
		// about the user's own files, `reloadSkills` runs on every send, and the
		// banner has no control that could act on them — so they go to the Skills
		// tab and the log instead. Asserted on the vault half because it is the
		// one a fake vault can produce; the user half rides the same path.
		const prompts: string[] = [];
		const service = createSkillsService(
			createVaultAppWithSkills({
				"Piem/skills/summarize/SKILL.md": SUMMARIZE_SKILL,
				"Piem/skills/bad/SKILL.md": "---\nname: Not_A_Name\ndescription: broken\n---\nBody",
			}),
			prompts,
		);

		await service.sendPrompt("Hello");

		expect(service.getSnapshot().noticeMessage).toBeUndefined();
		expect(service.getSnapshot().errorMessage).toBeUndefined();
	});

	it("hands the same load's problems to the settings panel, split by layer", async () => {
		// The panel renders this rather than loading the folders itself, so it can
		// never describe a read the agent did not perform. Two independent loads a
		// moment apart can disagree — a network folder that reattaches between them
		// would leave the panel reporting clean while the prompt was built without
		// those skills.
		const prompts: string[] = [];
		const service = createSkillsService(
			createVaultAppWithSkills({
				"Piem/skills/summarize/SKILL.md": SUMMARIZE_SKILL,
				"Piem/skills/bad/SKILL.md": "---\nname: Not_A_Name\ndescription: broken\n---\nBody",
			}),
			prompts,
		);

		await service.initialize();
		const { vault, user } = service.getSkillLoad();

		// pi's message names the offending skill, and `path` names the file — the
		// pair is what makes the row actionable, so both must survive the trip.
		expect(vault.some((diagnostic) => diagnostic.message.includes("Not_A_Name"))).toBe(true);
		expect(vault.some((diagnostic) => diagnostic.path.endsWith("bad/SKILL.md"))).toBe(true);
		// The user layer stays its own list: its consequences differ, and its
		// messages are raw filesystem text rather than pi's own wording.
		expect(user.diagnostics).toEqual([]);
	});

	it("points an unresolvable command at the Skills tab only when a load actually failed", async () => {
		// The refusal misattributes the cause rather than merely being unhelpful.
		// A SKILL.md pi refused to load — here, no `description` — is genuinely
		// absent, so the command the user wrote in their own file really is
		// unknown, and "unknown command" reads as "you typed it wrong" when the
		// truth is "your file did not load". Per-turn and caused by what they just
		// typed, the same standard the missing-embed notice meets.
		const prompts: string[] = [];
		const withProblem = createSkillsService(
			createVaultAppWithSkills({ "Piem/skills/bad/SKILL.md": "---\nname: bad\n---\nBody with no description" }),
			prompts,
		);

		expect(await withProblem.sendPrompt("/bad")).toBe(false);
		const hinted = withProblem.getSnapshot().noticeMessage ?? "";
		expect(hinted).toContain("/bad");
		// Names the tab as it is actually labelled. The pointer is useless if it
		// sends the reader to a tab that does not exist, and this leaf has already
		// gone stale once — the tab was renamed from "Skills" to "Extensions" while
		// this copy still said the old name.
		expect(hinted).toContain(getT("en").t("settings.tabExtensions"));
		// The pointer names no path and quotes no filesystem text — the problems
		// themselves stay in the tab it points at.
		expect(hinted).not.toContain("bad/SKILL.md");

		// A clean load gets the plain refusal: a typo deserves a plain answer.
		const clean = createSkillsService(createVaultAppWithSkills({ "Piem/skills/summarize/SKILL.md": SUMMARIZE_SKILL }), []);

		expect(await clean.sendPrompt("/nope")).toBe(false);
		expect(clean.getSnapshot().noticeMessage).toBe("Unknown command: /nope");
	});

	it("refreshes a live agent's prompt when the vault gains a skill", async () => {
		const skillFiles: Record<string, string> = {};
		const prompts: string[] = [];
		const service = createSkillsService(createVaultAppWithSkills(skillFiles), prompts);

		await service.sendPrompt("Hello");
		expect(prompts.at(-1)).not.toContain("new/SKILL.md");

		// The user saves a new SKILL.md; saveSettings → refreshConfiguration picks
		// it up, so the running conversation sees it without a plugin reload.
		skillFiles["Piem/skills/new/SKILL.md"] = SUMMARIZE_SKILL;
		await service.refreshConfiguration();
		await service.sendPrompt("Hello again");

		expect(prompts.at(-1)).toContain("new/SKILL.md");
	});

	it("can invoke a vault skill added after initialization on the very next send", async () => {
		const skillFiles: Record<string, string> = {};
		const contexts: Context[] = [];
		const service = new ObsidianAgentService(
			createVaultAppWithSkills(skillFiles),
			() => defaultTestSettings(),
			new ObsidianSessionManager(asDataAdapter(new MemoryAdapter()), SESSION_DIR, "obsidian-vault:Test"),
			{ streamFn: createCapturingStreamFn(contexts), loadUserSkills: NO_USER_SKILLS },
		);

		await service.sendPrompt("Hello");
		skillFiles["Piem/skills/new/SKILL.md"] = "---\nname: new\ndescription: Newly saved\n---\nFRESH SKILL BODY";

		expect(await service.sendPrompt("/new extra detail")).toBe(true);
		const sent = lastUserContent(contexts.at(-1));
		expect(sent).toContain("FRESH SKILL BODY");
		expect(sent).toContain("extra detail");
	});
});

function createService(
	memoryAdapter: MemoryAdapter = new MemoryAdapter(),
	overrides: {
		streamFn?: StreamFn;
		vaultFiles?: Record<string, string>;
		loadUserSkills?: typeof NO_USER_SKILLS;
		probeData?: ProbeData;
	} = {},
): ObsidianAgentServiceType {
	return createServiceWithSettings(memoryAdapter, overrides).service;
}

/**
 * A vault stub with a real folder tree, so skills under `Piem/skills` resolve.
 *
 * `createFakeApp` returns null for every lookup, which is exactly right for the
 * other tests (a missing skills folder loads as empty) and exactly wrong here.
 * Importing a richer vault from another test file would drag its `mock.module`
 * registration along, so this one stands alone — same trade the
 * `organizeTools.test.ts` vault stub already documents.
 */
function createVaultAppWithSkills(skillFiles: Record<string, string>): App {
	// Derived per call rather than snapshotted at construction, so a test that
	// mutates `skillFiles` between turns (simulating the user saving a new
	// SKILL.md) sees the new file on the next reload.
	const liveFiles = () =>
		new Map<string, { content: string; size: number }>(
			Object.entries(skillFiles).map(([path, content]) => [path, { content, size: content.length }]),
		);
	const liveFolders = () => {
		const folders = new Set<string>();
		for (const path of Object.keys(skillFiles)) {
			let current = "";
			for (const segment of path.split("/").slice(0, -1)) {
				current = current ? `${current}/${segment}` : segment;
				folders.add(current);
			}
		}
		return folders;
	};
	const fileFor = (path: string): TFile => {
		const entry = liveFiles().get(path)!;
		const file: TFile = new TFileClass();
		file.path = path;
		file.name = path.split("/").pop() ?? path;
		file.stat = { ctime: 0, mtime: 0, size: entry.size };
		return file;
	};
	const folderFor = (path: string): TFolder => {
		const files = liveFiles();
		const folders = liveFolders();
		const folder: TFolder = new TFolderClass();
		folder.path = path;
		folder.name = path.split("/").pop() ?? path;
		folder.children = [
			...[...files.keys()].filter((p) => getParent(p) === path).map(fileFor),
			...[...folders].filter((p) => getParent(p) === path).map(folderFor),
		];
		return folder;
	};
	return {
		vault: {
			adapter: asDataAdapter(new MemoryAdapter()),
			getName: () => "Test",
			getFiles: () => [...liveFiles().keys()],
			getRoot: () => folderFor(""),
			getFileByPath: (path: string) => (liveFiles().has(path) ? fileFor(path) : null),
			getFolderByPath: (path: string) => (liveFolders().has(path) ? folderFor(path) : null),
			// `VaultExecutionEnv.requireFile` resolves through this, not the two
			// above; a stub that omits it loads skills that list but never read.
			getAbstractFileByPath: (path: string) =>
				liveFiles().has(path) ? fileFor(path) : liveFolders().has(path) ? folderFor(path) : null,
			read: async (file: TFile) => liveFiles().get(file.path)!.content,
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
	} as unknown as App;
}

/** The settings every service test starts from, so custom ones can spread it. */
function defaultTestSettings(): PiemSettings {
	return {
		...DEFAULT_SETTINGS,
		providers: [],
		models: [],
		provider: "deepseek",
		modelId: "deepseek-v4-pro",
		providerApiKeys: { deepseek: "test-key" },
		networkTransport: "requestUrl",
		showAgentDetails: false,
		sendShortcut: "enter",
		language: "en",
		sessionRetention: DEFAULT_SESSION_RETENTION,
		sessionDir: DEFAULT_SESSION_DIR,
		userSkillsDir: "",
	};
}

/** Same, but hands back the live settings object so a test can mutate it. */
function createServiceWithSettings(
	memoryAdapter: MemoryAdapter = new MemoryAdapter(),
	overrides: {
		streamFn?: StreamFn;
		vaultFiles?: Record<string, string>;
		loadUserSkills?: typeof NO_USER_SKILLS;
		/** Stands in for the plugin's `saveSettings`; omitted reconfigures in memory. */
		persistSettings?: (options?: { reconfigure?: boolean }) => Promise<void>;
		/** Link graph, metadata cache and active editor for the context probe. */
		probeData?: ProbeData;
	} = {},
): { service: ObsidianAgentServiceType; settings: PiemSettings } {
	const adapter = asDataAdapter(memoryAdapter);
	const settings = defaultTestSettings();
	const sessionManager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
	const service = new ObsidianAgentService(
		createFakeApp(adapter, overrides.vaultFiles, undefined, undefined, overrides.probeData),
		() => settings,
		sessionManager,
		{
			streamFn: overrides.streamFn ?? createFakeStreamFn(),
			// Forwarded, not defaulted: a test that swaps in a throwing loader is how
			// a failed *start* is simulated, and a default here would silently swallow
			// the override.
			loadUserSkills: overrides.loadUserSkills ?? NO_USER_SKILLS,
			...(overrides.persistSettings ? { persistSettings: overrides.persistSettings } : {}),
		},
	);
	return { service, settings };
}

/**
 * A service backed by a multimodal model (claude-opus-5, `input: ["text","image"]`).
 *
 * The default service falls back to deepseek-v4-pro, which is text-only — fine
 * for the capability-gate test but useless for asserting images travel through.
 * This configures a provider/model pair that declares image capability, which is
 * also how a real vault gets one: the builtin catalog is the fallback pair alone
 * now, and `supportsImages` is a field the user's own model row carries. The
 * provider supplies the key so `hasApiKey` passes, and vault image bytes can be
 * staged for `![[...]]` embed resolution (which reads `app.vault`, not the
 * adapter).
 */
function createServiceWithMultimodalModel(
	overrides: { streamFn?: StreamFn; loadUserSkills?: typeof NO_USER_SKILLS } = {},
	vault: { imageFiles?: Map<string, ArrayBuffer>; linkIndex?: (linkpath: string, sourcePath: string) => TFile | null } = {},
	memoryAdapter: MemoryAdapter = new MemoryAdapter(),
): { service: ObsidianAgentServiceType; settings: PiemSettings } {
	const adapter = asDataAdapter(memoryAdapter);
	const settings: PiemSettings = {
		providers: [
			{
				id: "p-multimodal",
				name: "Anthropic",
				baseUrl: "https://api.anthropic.com",
				protocol: "anthropic-messages",
				apiKey: "test-key",
				secretRef: "",
				source: "user",
			},
		],
		models: [
			{
				id: "m-multimodal",
				providerId: "p-multimodal",
				modelApiId: "claude-opus-5",
				displayName: "Claude Opus 5",
				reasoning: true,
				supportsImages: true,
				contextWindow: 200_000,
			},
		],
		activeModelId: "m-multimodal",
		provider: "anthropic",
		modelId: "claude-opus-5",
		providerApiKeys: {},
		networkTransport: "requestUrl",
		showAgentDetails: false,
		traceExpand: "collapsed",
		sendShortcut: "enter",
		language: "en",
		sessionRetention: DEFAULT_SESSION_RETENTION,
		sessionDir: DEFAULT_SESSION_DIR,
		userSkillsDir: "",
		mcpServers: [],
		logLevel: DEFAULT_LOG_LEVEL,
	};
	const sessionManager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
	const service = new ObsidianAgentService(
		createFakeApp(adapter, {}, vault.imageFiles, vault.linkIndex),
		() => settings,
		sessionManager,
		{
			streamFn: overrides.streamFn ?? createFakeStreamFn(),
			loadUserSkills: NO_USER_SKILLS,
		},
	);
	return { service, settings };
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

/** One completed provider response that requests a tool call. */
function scriptedToolCallStream(
	model: Model<Api>,
	callId: string,
	toolName: string,
	toolArguments: Record<string, unknown>,
) {
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

function createFakeStreamFn(): StreamFn {	return (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Done" }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
}

/**
 * Streams one tool call, then a plain reply on the follow-up request.
 *
 * The call id is deliberately provider-shaped: it is the string the panel used
 * to show before pending calls were resolved to names.
 */
function createToolCallingStreamFn(
	toolName: string,
	toolCallId: string,
	toolArguments: Record<string, unknown> = { path: "/" },
): StreamFn {
	let requests = 0;
	return (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
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

		if (requests === 1) {
			const message: AssistantMessage = {
				...base,
				content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: toolArguments }],
				stopReason: "toolUse",
			};
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end(message);
			return stream;
		}

		const message: AssistantMessage = { ...base, content: [{ type: "text", text: "Done" }], stopReason: "stop" };
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
}

/**
 * Records the context of each request so a test can assert on what the model was
 * actually sent, rather than on whether a hook happened to run.
 */
/**
 * The message the user actually sent, in a captured request.
 *
 * Not `messages.at(-1)`: `transformContext` appends the per-turn `<context>`
 * block as a user message on every request, which is the seam working as
 * designed. A test asking what was sent means what the person typed.
 */
function lastUserMessage(context: Context | undefined): Context["messages"][number] | undefined {
	for (let index = (context?.messages.length ?? 0) - 1; index >= 0; index -= 1) {
		const message = context?.messages[index];
		if (message?.role !== "user") {
			continue;
		}
		if (typeof message.content === "string" && message.content.startsWith("<context>")) {
			continue;
		}
		return message;
	}
	return undefined;
}

/** JSON of that message's content, which is the shape the `toContain` assertions want. */
function lastUserContent(context: Context | undefined): string {
	return JSON.stringify(lastUserMessage(context)?.content);
}

function createCapturingStreamFn(contexts: Context[]): StreamFn {
	const inner = createFakeStreamFn();
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		contexts.push(context);
		return inner(model, context, options);
	};
}

/**
 * Streams one tool call and then a plain reply, recording each request's context
 * and reporting the given context totals.
 *
 * The first total is what makes the between-turns threshold fire:
 * `estimateContextTokens` trusts the newest assistant usage, so one reported
 * total near the window crosses `shouldCompact` deterministically — the trick
 * `compaction.test.ts`'s `buildOverflowingHistory` already uses. Turns never
 * reach `requestUrl` because the stream function is injected; the summarization
 * request does, which is the separation these tests assert on.
 */
function createRecordingToolCallingStreamFn(
	totals: number[],
	toolName = "ls",
): { streamFn: StreamFn; requests: Context[] } {
	const requests: Context[] = [];
	let call = 0;
	const streamFn: StreamFn = (model: Model<Api>, context: Context, _options?: SimpleStreamOptions) => {
		requests.push({ ...context, messages: [...context.messages] });
		const total = totals[call] ?? totals[totals.length - 1] ?? 1_010;
		const isFirst = call === 0;
		call += 1;
		const stream = createAssistantMessageEventStream();
		const base = {
			role: "assistant" as const,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: total - 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: total,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		if (isFirst) {
			const message: AssistantMessage = {
				...base,
				// The arguments must actually succeed: a failed tool result would
				// make the agent loop turn again and swallow the second request
				// these tests are about. `""` normalizes to the vault root.
				content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: { path: "" } }],
				stopReason: "toolUse",
			};
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end(message);
			return stream;
		}
		const message: AssistantMessage = { ...base, content: [{ type: "text", text: "Done" }], stopReason: "stop" };
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	return { streamFn, requests };
}

/**
 * A fake app whose vault fronts an in-memory file tree.
 *
 * `vaultFiles` populates the `TFile`/`TFolder` side of the vault rather than the
 * `DataAdapter` side, because that is the half {@link VaultExecutionEnv} reads
 * through — and the env is how prompt templates are loaded. Folders are derived
 * from the file paths, so a caller only lists leaves.
 *
 * `imageFiles` stages binary image bytes for `![[...]]` embed resolution, which
 * reads `readBinary` rather than the text-reading methods above. Each path is
 * registered as a regular `TFile` so lookups behave exactly like a vault that
 * contains those images.
 *
 * `metadataCache` is present so embed resolution never falls off the fake app,
 * but its link index answers nothing by default — the exact `getFileByPath`
 * lookup already covers every full path, and a test that needs the index to
 * resolve (or to observe which linkpath and source it was asked about) passes
 * its own `linkIndex`. The file it returns only needs a `path`: `readBinary`
 * keys the staged bytes on it, exactly as the real vault would.
 */
/**
 * What the context probe reads beyond the file tree.
 *
 * Kept as one optional bag rather than four parameters: the probe reads all of it
 * on every request, and a fixture that supplies none of it must still not throw —
 * a throwing probe degrades silently and takes every fact in the block with it.
 */
interface ProbeData {
	/** Source path to target path to count, as `metadataCache.resolvedLinks` is shaped. */
	resolvedLinks?: Record<string, Record<string, number>>;
	/** Source path to *written link text* to count. */
	unresolvedLinks?: Record<string, Record<string, number>>;
	/** Path to the cache entry `getFileCache` returns. */
	caches?: Record<string, unknown>;
	/** Stands in for `workspace.activeEditor`, whose `file` the selection probe checks. */
	activeEditor?: { file: { path: string } | null; editor: { getSelection: () => string } } | null;
}

function createFakeApp(
	adapter: DataAdapter,
	vaultFiles: Record<string, string> = {},
	imageFiles?: Map<string, ArrayBuffer>,
	linkIndex?: (linkpath: string, sourcePath: string) => TFile | null,
	probeData: ProbeData = {},
): App {
	const files = new Map<string, TFile>();
	const folders = new Map<string, TFolder>();

	const folderAt = (path: string): TFolder => {
		const existing = folders.get(path);
		if (existing) {
			return existing;
		}
		const folder = new TFolderClass();
		// Obsidian reports the root folder's path as "/" and its name as "" — measured
		// against a real vault, and load-bearing: the context block special-cases that
		// exact value so a bare slash never reaches the model as a usable path. The map
		// is still keyed by "" so `getParent` stays a plain string operation.
		folder.path = path === "" ? "/" : path;
		folder.name = path.slice(path.lastIndexOf("/") + 1);
		folder.children = [];
		folders.set(path, folder);
		if (path !== "") {
			folderAt(getParent(path)).children.push(folder);
		}
		return folder;
	};

	const registerFile = (path: string, size: number): void => {
		const file = new TFileClass();
		file.path = path;
		file.name = path.slice(path.lastIndexOf("/") + 1);
		file.extension = path.slice(path.lastIndexOf(".") + 1);
		file.stat = { size, mtime: 1, ctime: 1 };
		files.set(path, file);
		const parent = folderAt(getParent(path));
		// The context probe reaches the current folder through `file.parent`; without
		// it every request would report no folder and the wiring would go uncovered.
		file.parent = parent;
		parent.children.push(file);
	};

	folderAt("");
	for (const [path, content] of Object.entries(vaultFiles)) {
		registerFile(path, content.length);
	}
	for (const [path, bytes] of imageFiles ?? []) {
		registerFile(path, bytes.byteLength);
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
			read: async (file: TFile) => vaultFiles[file.path] ?? "",
			cachedRead: async (file: TFile) => vaultFiles[file.path] ?? "",
			readBinary: async (file: { path: string }) => imageFiles?.get(file.path) ?? new ArrayBuffer(0),
			// Writes register the file in the same map the readers resolve, so a
			// test that creates a note can read it back through the same stub.
			create: async (path: string, content: string) => {
				registerFile(path, content.length);
				vaultFiles[path] = content;
				return files.get(path)!;
			},
			createFolder: async (path: string) => folderAt(path),
		},
		metadataCache: {
			getFirstLinkpathDest: (linkpath: string, sourcePath: string) => linkIndex?.(linkpath, sourcePath) ?? null,
			// Read by the context probe for backlinks, unresolved links and pinned-note
			// skeletons. Empty defaults keep the probe on its normal path.
			resolvedLinks: probeData.resolvedLinks ?? {},
			unresolvedLinks: probeData.unresolvedLinks ?? {},
			getFileCache: (file: TFile) => probeData.caches?.[file.path] ?? null,
		},
		workspace: {
			getActiveViewOfType: () => null,
			// The context probe walks Markdown leaves and the recent-files list.
			// Missing methods would send every request down the probe's degrade path,
			// which passes silently while covering nothing.
			getLeavesOfType: () => [],
			getLastOpenFiles: () => [],
			activeEditor: probeData.activeEditor ?? null,
		},
	} as unknown as App;
}

/** `MemoryAdapter` covers only the calls the session manager makes. */
function asDataAdapter(adapter: MemoryAdapter): DataAdapter {
	return adapter as unknown as DataAdapter;
}

function getParent(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

describe("quick-action suggestions", () => {
	const SUGGESTION_JSON = '[{"label":"Go deeper","prompt":"Expand on the reply."}]';

	/** A streamFn that answers every request with `text`, optionally holding the first call until `gate` resolves. */
	function suggestionReplyStreamFn(text: string, gate?: Promise<void>): StreamFn {
		let requests = 0;
		return (model: Model<Api>) => {
			requests += 1;
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 110,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			if (gate && requests === 1) {
				void gate.then(() => {
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				});
			} else {
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			}
			return stream;
		};
	}

	it("returns the model's chips for the empty screen without touching the conversation", async () => {
		const { service } = createServiceWithSettings(new MemoryAdapter(), { streamFn: suggestionReplyStreamFn(SUGGESTION_JSON) });
		await service.initialize();

		const actions = await service.suggestQuickActions("empty");

		expect(actions).toEqual([{ id: "suggested-0", label: "Go deeper", prompt: "Expand on the reply." }]);
		// A side-channel request must not leave a mark on the transcript.
		expect(service.getSnapshot().messages).toHaveLength(0);
	});

	it("declines a reply-scope request when there is no reply to react to", async () => {
		const { service } = createServiceWithSettings(new MemoryAdapter(), { streamFn: suggestionReplyStreamFn(SUGGESTION_JSON) });
		await service.initialize();

		const actions = await service.suggestQuickActions("reply");

		expect(actions).toBeNull();
	});

	it("supersedes an in-flight request and resolves the loser to null, never the winner's chips", async () => {
		let releaseFirst!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const { service } = createServiceWithSettings(new MemoryAdapter(), { streamFn: suggestionReplyStreamFn(SUGGESTION_JSON, gate) });
		await service.initialize();

		const first = service.suggestQuickActions("empty");
		const second = service.suggestQuickActions("empty");
		releaseFirst();

		expect(await second).toEqual([{ id: "suggested-0", label: "Go deeper", prompt: "Expand on the reply." }]);
		// The superseded request was aborted mid-flight; it must come back empty
		// rather than racing the winner's answer into the row.
		expect(await first).toBeNull();
	});

	it("aborts an in-flight suggestion the moment a real send starts", async () => {
		let releaseFirst!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const { service } = createServiceWithSettings(new MemoryAdapter(), { streamFn: suggestionReplyStreamFn(SUGGESTION_JSON, gate) });
		await service.initialize();

		const pending = service.suggestQuickActions("empty");
		// The send is a new turn; the suggestion asked for by the previous one is
		// dead weight, so sendPrompt must cancel it rather than let it finish.
		await service.sendPrompt("Hello");
		releaseFirst();

		expect(await pending).toBeNull();
	});

	it("declines to ask when the target has no credential", async () => {
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), { streamFn: suggestionReplyStreamFn(SUGGESTION_JSON) });
		await service.initialize();
		settings.providerApiKeys = {};

		expect(await service.suggestQuickActions("empty")).toBeNull();
	});

	/*
	 * The cache behind issue #200: a successful empty-scope answer is the next
	 * blank visit's stale row, so it lands in the cache; a failed or superseded
	 * request must not poison it, and a reply's answer — tied to that one
	 * conversation's text — never caches at all.
	 */
	it("caches an empty-scope answer and serves it back through peek", async () => {
		const { service } = createServiceWithSettings(new MemoryAdapter(), { streamFn: suggestionReplyStreamFn(SUGGESTION_JSON) });
		await service.initialize();
		service.setActiveNotePath("Projects/weekly-0827.md");

		expect(service.peekQuickActionSuggestions("empty")).toBeUndefined();
		const actions = await service.suggestQuickActions("empty");

		expect(actions).toEqual([{ id: "suggested-0", label: "Go deeper", prompt: "Expand on the reply." }]);
		expect(service.peekQuickActionSuggestions("empty")).toEqual(actions ?? undefined);
	});

	it("keys the cache by note, so a different note reads as unanswered", async () => {
		const { service } = createServiceWithSettings(new MemoryAdapter(), { streamFn: suggestionReplyStreamFn(SUGGESTION_JSON) });
		await service.initialize();
		service.setActiveNotePath("Projects/weekly-0827.md");
		await service.suggestQuickActions("empty");
		service.setActiveNotePath("Notes/other.md");

		expect(service.peekQuickActionSuggestions("empty")).toBeUndefined();
	});

	it("does not cache a failed request, so the next peek still reads as unanswered", async () => {
		const { service, settings } = createServiceWithSettings(new MemoryAdapter(), { streamFn: suggestionReplyStreamFn(SUGGESTION_JSON) });
		await service.initialize();
		service.setActiveNotePath("Projects/weekly-0827.md");
		settings.providerApiKeys = {};

		expect(await service.suggestQuickActions("empty")).toBeNull();
		expect(service.peekQuickActionSuggestions("empty")).toBeUndefined();
	});

	it("does not cache reply-scope answers, whose subject no future request reproduces", async () => {
		const { service } = createServiceWithSettings(new MemoryAdapter(), { streamFn: suggestionReplyStreamFn(SUGGESTION_JSON) });
		await service.initialize();

		await service.suggestQuickActions("empty");
		expect(service.peekQuickActionSuggestions("reply")).toBeUndefined();
	});
});

/**
 * Forking a session from a reply, driven through the service the panel talks
 * to. What is asserted here is the product's own contract — the new chat
 * carries the conversation up to the reply, the source is left exactly as it
 * was, and the panel lands in the copy — rather than pi's fork mechanics,
 * which `ObsidianSessionManager.test.ts` covers.
 */
describe("session fork", () => {
	it("copies the conversation into a new session and opens it", async () => {
		const service = createService();
		await service.sendPrompt("Original question");
		const sourcePath = service.getSnapshot().session?.path ?? "";
		const messages = service.getSnapshot().messages;

		expect(await service.forkSessionAt(messages.length - 1)).toBe(true);

		const snapshot = service.getSnapshot();
		expect(snapshot.session?.path).not.toBe(sourcePath);
		// The copy ends *on* the reply: the fork picks up where the source shows,
		// so continuing there appends to the exchange rather than redoing it.
		expect(JSON.stringify(snapshot.messages)).toContain("Original question");
		expect(snapshot.messages).toHaveLength(messages.length);
		// The turn after the fork lands only in the copy.
		await service.sendPrompt("Continued in the fork");
		expect(JSON.stringify(service.getSnapshot().messages)).toContain("Continued in the fork");
	});

	it("leaves the source conversation untouched", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("Original question");
		const sourcePath = service.getSnapshot().session?.path ?? "";
		await service.forkSessionAt(service.getSnapshot().messages.length - 1);
		await service.sendPrompt("Only in the fork");

		// A fresh service on the source path must read the conversation as it
		// stood when the fork was taken — not the turn that followed in the copy.
		const reloaded = createService(adapter);
		await reloaded.openSession(sourcePath);
		const source = reloaded.getSnapshot().messages;
		expect(JSON.stringify(source)).toContain("Original question");
		expect(JSON.stringify(source)).not.toContain("Only in the fork");
	});

	it("refuses to fork a reply the log cannot name", async () => {
		const service = createService();
		await service.initialize();
		const before = service.getSnapshot().session?.path;

		// No messages yet, so no entry id exists to anchor a fork on.
		expect(await service.forkSessionAt(0)).toBe(false);
		// A refusal is a no-op, not a half-done fork: the panel is still on the
		// chat it was on, and no copy was minted for it to land in.
		expect(service.getSnapshot().session?.path).toBe(before);
		expect(await service.listSessions()).toHaveLength(1);
	});

	it("keeps the interrupted-run ledger on each session's own main line", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("Original question");
		const sourcePath = service.getSnapshot().session?.path ?? "";

		expect(await service.forkSessionAt(service.getSnapshot().messages.length - 1)).toBe(true);
		// The fork is its own file with its own ledger: every run opened there has
		// been closed, so a reload has nothing to recover.
		const forkPath = service.getSnapshot().session?.path ?? "";
		expect(await openLedger(adapter, forkPath).then((ledger) => ledger.findAllOpenRunOperations())).toEqual(new Map());
		// And the source's ledger is untouched by the copy.
		expect(await openLedger(adapter, sourcePath).then((ledger) => ledger.findAllOpenRunOperations())).toEqual(new Map());
	});
});

/**
 * Crash recovery. pi refuses a second open operation on a lane that already has
 * one, so an orphan left behind by a dead process would silently make the
 * conversation unable to run until it is closed — the completeness line issue
 * #184 draws, now on the single main line every conversation reads and writes.
 */
describe("interrupted run recovery", () => {
	it("offers to continue a run the previous process left open", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.initialize();
		const sessionPath = service.getSnapshot().session?.path ?? "";
		const manager = new ObsidianSessionManager(asDataAdapter(adapter), SESSION_DIR, "obsidian-vault:Test");
		await manager.loadSession(sessionPath);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Cut off mid-reply" }], timestamp: 1 });
		await manager.beginRunOperation([{ role: "user", content: [{ type: "text", text: "Cut off mid-reply" }], timestamp: 1 }]);

		const reloaded = createService(adapter);
		await reloaded.openSession(sessionPath);

		expect(reloaded.getSnapshot().canResumeInterrupted).toBe(true);
		// And the orphan is closed, so the lane can open a run again. Read through a
		// fresh manager: pi hydrates its state at open and mutates it only through
		// its own writes, so the one that planted the orphan cannot see the close.
		expect(await openLedger(adapter, sessionPath).then((ledger) => ledger.findOpenRunOperations())).toEqual([]);
	});

	it("stays silent when the reply had already arrived", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("Answered before the crash");
		const sessionPath = service.getSnapshot().session?.path ?? "";
		const manager = new ObsidianSessionManager(asDataAdapter(adapter), SESSION_DIR, "obsidian-vault:Test");
		await manager.loadSession(sessionPath);
		await manager.beginRunOperation([]);

		const reloaded = createService(adapter);
		await reloaded.openSession(sessionPath);

		// Only the close was lost. Re-offering would invite a duplicate turn.
		expect(reloaded.getSnapshot().canResumeInterrupted ?? false).toBe(false);
		expect(await openLedger(adapter, sessionPath).then((ledger) => ledger.findOpenRunOperations())).toEqual([]);
	});

	it("withdraws the offer when the user sends instead", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.initialize();
		const sessionPath = service.getSnapshot().session?.path ?? "";
		const manager = new ObsidianSessionManager(asDataAdapter(adapter), SESSION_DIR, "obsidian-vault:Test");
		await manager.loadSession(sessionPath);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Cut off" }], timestamp: 1 });
		await manager.beginRunOperation([]);
		const reloaded = createService(adapter);
		await reloaded.openSession(sessionPath);

		await reloaded.sendPrompt("Never mind, new question");

		expect(reloaded.getSnapshot().canResumeInterrupted ?? false).toBe(false);
	});

	it("withdraws the offer on dismissal", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.initialize();
		const sessionPath = service.getSnapshot().session?.path ?? "";
		const manager = new ObsidianSessionManager(asDataAdapter(adapter), SESSION_DIR, "obsidian-vault:Test");
		await manager.loadSession(sessionPath);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Cut off" }], timestamp: 1 });
		await manager.beginRunOperation([]);
		const reloaded = createService(adapter);
		await reloaded.openSession(sessionPath);
		expect(reloaded.getSnapshot().canResumeInterrupted).toBe(true);

		reloaded.dismissInterruptedRun();

		expect(reloaded.getSnapshot().canResumeInterrupted ?? false).toBe(false);
	});

	it("closes its own ledger entry when a run completes", async () => {
		const adapter = new MemoryAdapter();
		const service = createService(adapter);
		await service.sendPrompt("A complete turn");
		const sessionPath = service.getSnapshot().session?.path ?? "";

		const ledger = await openLedger(adapter, sessionPath);
		// Steady state: every run opened has been closed, so a reload has nothing
		// to recover and offers nothing.
		expect(await ledger.findAllOpenRunOperations()).toEqual(new Map());
	});
});

/** A manager freshly opened on `path`, for reading a log another writer changed. */
async function openLedger(adapter: MemoryAdapter, path: string): Promise<ObsidianSessionManager> {
	const manager = new ObsidianSessionManager(asDataAdapter(adapter), SESSION_DIR, "obsidian-vault:Test");
	await manager.loadSession(path);
	return manager;
}

/**
 * A stream that delivers `text` as `chunks` separate `text_delta` events, the
 * way a real provider streams. `scriptedTextStream` skips straight to `done`,
 * which is right for every test that does not care how the text arrived — and
 * exactly wrong for the refresh-cost tests, which need the per-delta event
 * storm to have something to count.
 */
function scriptedDeltaStream(model: Model<Api>, text: string, chunks: number) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
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
	stream.push({ type: "start", partial: message });
	stream.push({ type: "text_start", contentIndex: 0, partial: message });
	const size = Math.ceil(text.length / chunks);
	for (let index = 0; index < chunks; index += 1) {
		const delta = text.slice(index * size, (index + 1) * size);
		message.content = [{ type: "text", text: (message.content[0] as { type: "text"; text: string }).text + delta }];
		stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
	}
	message.content = [{ type: "text", text }];
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

/** Counts `stat` calls: the real disk round-trips `refreshSessionInfo` pays for. */
class CountingAdapter extends MemoryAdapter {
	statCalls = 0;
	override async stat(path: string): Promise<Stat | null> {
		this.statCalls += 1;
		return super.stat(path);
	}
}

describe("streaming refresh cost", () => {
	/**
	 * Pins the refresh gate: session info may only be re-read when the session
	 * file changes — at a persisted message (message_end) and at the run's
	 * settle (agent_end). Before the gate, every streaming chunk re-ran
	 * `refreshSessionInfo` (a real `adapter.stat` plus a whole-file entry
	 * read), so a long reply paid hundreds of disk round-trips for a summary
	 * whose inputs had not changed.
	 */
	it("does not re-stat the session file per streaming delta", async () => {
		const adapter = new CountingAdapter();
		const chunks = 200;
		const service = createService(adapter, {
			streamFn: (model) => scriptedDeltaStream(model, "Long reply, streamed one chunk at a time. ".repeat(2), chunks),
		});
		// The startup cost (session creation, configuration) is part of every
		// run; measure it before the stream so the assertion below says
		// "streaming added nothing", not "the total is small".
		await service.initialize();
		const setupStatCalls = adapter.statCalls;

		await service.sendPrompt("Hello");

		// Streaming rendered, and the settled summary reflects the persisted turn.
		const snapshot = service.getSnapshot();
		expect(snapshot.isStreaming).toBe(false);
		expect(snapshot.session?.messageCount).toBe(2);
		// Two reads for the one turn: message_end's persist and agent_end's
		// sweep. A handful of slack for unrelated in-run stats is still orders
		// of magnitude below the one-per-delta behavior this pins against
		// (200 chunks would have meant 200+).
		expect(adapter.statCalls).toBeLessThanOrEqual(setupStatCalls + 8);
	});
});
