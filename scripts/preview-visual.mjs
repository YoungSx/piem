/*
 * Renders the plugin's *real* React components into happy-dom, serializes the
 * DOM they produce, and writes each scenario as a standalone HTML page that
 * loads the shipped `styles.css` over Obsidian's token values. Sibling of
 * `preview-transcript.mjs` — same output folder, same Chromium — but the markup
 * is not hand-written fixtures: it is what `ChatApp` and `SubagentInspectorApp`
 * actually emit, so a spacing or alignment defect in a component is a defect in
 * the page.
 *
 * Companion: `measure-visual.mjs` screenshots the pages this writes.
 *
 * Not a test and not shipped. `PREVIEW_DIR` decides where pages land; snap
 * Chromium cannot see hidden paths, so `~/piem-preview` is the usual value.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.PREVIEW_DIR ? resolve(process.env.PREVIEW_DIR) : resolve(HERE, "..", ".preview");
const REPO = resolve(HERE, "..");

const styles = readFileSync(join(REPO, "styles.css"), "utf8");
// Icons live outside the repo (a download artifact); snap Chromium also cannot
// reach hidden paths, so look next to the pages first.
let icons;
for (const candidate of [join(OUT_DIR, "icons.json"), join(OUT_DIR, "polish", "icons.json"), join(HERE, "icons.json")]) {
	try {
		icons = JSON.parse(readFileSync(candidate, "utf8"));
		break;
	} catch {}
}
if (!icons) {
	throw new Error(`icons.json not found (looked in ${OUT_DIR}, ${OUT_DIR}/polish, ${HERE})`);
}

for (const required of ["container-type: inline-size", ".piem-chat {", ".piem-chat__icon-button"]) {
	if (!styles.includes(required)) {
		throw new Error(`styles.css no longer carries ${required}; the page would not render what the plugin ships`);
	}
}

// The stub's `setIcon` is a no-op, which would leave every header, trace and
// composer icon blank — exactly the glyphs an alignment check needs. Register
// the stub, then re-register a full plain-object copy of its namespace with
// `setIcon` replaced. A Proxy over the namespace does not survive Bun's
// `mock.module`, and a naive spread loses non-enumerable exports (`debounce`),
// so the copy enumerates property names instead.
const { installObsidianStub, markdownRenderMock, setStubIconPainter } = await import("../src/testUtils/obsidianStub.ts");
installObsidianStub();
// The stub's own `setIcon` points at the painter registry — wire it to the
// icons.json resolver so glyphs draw for real in the serialized pages.
setStubIconPainter((element, name) => setIconWithIcons(element, name));
const stubNamespace = await import("obsidian");
const stubCopy = Object.fromEntries(Object.getOwnPropertyNames(stubNamespace).map((name) => [name, stubNamespace[name]]));
// Vendor marks (`piem-vendor-*`) register through `addIcon` in onload, outside
// icons.json; capture those registrations so `setIcon` can resolve them too.
const registeredIcons = new Map();
const setIconWithIcons = (element, name) => {
	const svg = icons[name] ?? registeredIcons.get(name);
	if (svg === undefined) {
		throw new Error(`icons.json has no "${name}" — extend the download list and rebuild it`);
	}
	element.empty();
	const template = element.ownerDocument.createElement("template");
	template.innerHTML = svg;
	const painted = template.content.firstElementChild;
	// Obsidian's own copy of the Lucide set carries `svg-icon`; the static
	// download does not (`class="lucide lucide-archive"`). Without the class the
	// shim's `.svg-icon` sizing rule matches nothing and every glyph paints at
	// the file's natural 24px, which is 1.5x what the plugin asks for and enough
	// to make an alignment verdict lie — the harness would report a gap the app
	// does not have, and miss one it does. Stamped here rather than widened in
	// CSS, because the class is what the real `setIcon` produces.
	painted?.classList.add("svg-icon");
	element.append(painted ?? template.content);
};
const { mock } = await import("bun:test");
mock.module("obsidian", () => ({
	...stubCopy,
	setIcon: setIconWithIcons,
	addIcon: (iconId, svgContent) => {
		registeredIcons.set(iconId, svgContent);
	},
}));

// onload calls `registerVendorIcons()` — do the same here so the vendor marks
// land in `registeredIcons` before any chat mounts one.
const { registerVendorIcons } = await import("../src/net/vendorIcons.ts");
registerVendorIcons();

// Realistic markdown faces: the stub's default marker paragraph would render
// every reply as one grey line and hide the spacing under test.
markdownRenderMock.mockImplementation(async ({ el, markdown }) => {
	el.innerHTML = miniMarkdown(String(markdown ?? ""));
});

const { installDom, flushRender } = await import("../src/testUtils/dom.ts");
const document = installDom();
// Chat's controller and stub-rendered rows use Obsidian's prototype helpers
// (`toggleClass`, …) that plain DOM lacks; the tests install the same layer.
const { installObsidianDomHelpers } = await import("../src/testUtils/obsidianDom.ts");
installObsidianDomHelpers();

const reactDomClient = await import("react-dom/client");
const React = await import("react");

const { ChatApp } = await import("../src/ui/ChatApp.tsx");
const { MessageList } = await import("../src/ui/MessageList.tsx");
const { TranslatorProvider } = await import("../src/ui/TranslatorContext.tsx");
const { ChatInputController } = await import("../src/ui/ChatInputController.ts");
const { AskUserBroker } = await import("../src/tools/askUserBroker.ts");
const { ObsidianAgentService } = await import("../src/agent/ObsidianAgentService.ts");
const { ObsidianSessionManager } = await import("../src/session/ObsidianSessionManager.ts");
const { DEFAULT_SETTINGS } = await import("../src/settings.ts");
const { SubagentInspectorApp } = await import("../src/ui/SubagentInspector.tsx");
const { DEFAULT_SESSION_DIR, getLegacySessionDir } = await import("../src/session/sessionDir.ts");
const { DEFAULT_SESSION_RETENTION } = await import("../src/session/retention.ts");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");

const SESSION_DIR = getLegacySessionDir(`.${"obsidian"}`, "piem");
const CHIPS_JSON = '[{"label":"Summarize this note","prompt":"Summarize the active note."},{"label":"Find tasks","prompt":"List open tasks in the vault."}]';
const NO_USER_SKILLS = async () => ({ skills: [], diagnostics: [], searched: [] });

/** One completed provider response carrying only `text`. */
function textReply(model, text) {
	const stream = createAssistantMessageEventStream();
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 12_000,
			output: 480,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12_480,
			cost: { input: 0.0021, output: 0.0009, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

/** A streamFn that answers every request with the next scripted reply. */
function scriptedStreamFn(replies) {
	let call = 0;
	return (model) => {
		const reply = replies[Math.min(call, replies.length - 1)] ?? "";
		call += 1;
		return textReply(model, reply);
	};
}

/**
 * A streamFn that starts a reply and never finishes it, so the panel holds the
 * mid-stream state: streaming bubble, running status row, abort-capable send.
 * `abort` ends the turn after the page has been captured.
 */
function hangingStreamFn(text) {
	return () => {
		const stream = createAssistantMessageEventStream();
		const partial = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			usage: { input: 12_000, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 12_030, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: { ...partial, content: [{ type: "text", text }] } });
		return stream;
	};
}

/** A streamFn that fails the turn, for the error banner. */
function failingStreamFn(message) {
	return () => {
		throw new Error(message);
	};
}

/**
 * A DataAdapter over a Map. Folders are implicit (a path is a folder when some
 * key lives under it), `list` returns direct children only, and stats carry a
 * real mtime — the session repo walks directories and orders sessions by
 * mtime, so a flatter or timeless fake silently empties `listSessions()`.
 */
function memoryAdapter() {
	const files = new Map();
	const now = () => Date.now();
	const isFolder = (path) => [...files.keys()].some((key) => key.startsWith(`${path}/`));
	return {
		async exists(path) {
			return files.has(path) || isFolder(path);
		},
		async mkdir() {},
		async write(path, data) {
			files.set(path, { data, mtime: now() });
		},
		async append(path, data) {
			const existing = files.get(path);
			files.set(path, { data: (existing ? existing.data : "") + data, mtime: now() });
		},
		async read(path) {
			const entry = files.get(path);
			if (entry === undefined) throw new Error(`Missing file: ${path}`);
			return entry.data;
		},
		async stat(path) {
			const entry = files.get(path);
			if (entry === undefined) return isFolder(path) ? { type: "folder", ctime: 0, mtime: 0, size: 0 } : null;
			return { type: "file", ctime: entry.mtime, mtime: entry.mtime, size: entry.data.length };
		},
		async list(path) {
			const prefix = `${path}/`;
			const children = new Map();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const [head, rest] = [key.slice(prefix.length).split("/")[0], key.slice(prefix.length).split("/").slice(1).join("/")];
				children.set(head, rest.length > 0 ? "folder" : "file");
			}
			return {
				files: [...children].filter(([, kind]) => kind === "file").map(([name]) => `${prefix}${name}`),
				folders: [...children].filter(([, kind]) => kind === "folder").map(([name]) => `${prefix}${name}`),
			};
		},
		async remove(path) {
			for (const key of [...files.keys()]) {
				if (key === path || key.startsWith(`${path}/`)) files.delete(key);
			}
		},
		async trashSystem(path) {
			await this.remove(path);
			return true;
		},
		async trashLocal(path) {
			await this.remove(path);
		},
	};
}

const PROVIDERS = [
	{ id: "p-deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", protocol: "openai-completions", apiKey: "sk-test", secretRef: "", source: "user" },
	{ id: "p-anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic-messages", apiKey: "", secretRef: "secret-anthropic", source: "user" },
];
const MODELS = [
	{ id: "m-deepseek-pro", providerId: "p-deepseek", modelApiId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextWindow: 131072, reasoning: true, supportsImages: false, maxTokens: 8192 },
	{ id: "m-deepseek-lite", providerId: "p-deepseek", modelApiId: "deepseek-v4-lite", displayName: "DeepSeek V4 Lite", contextWindow: 65536, reasoning: false, supportsImages: false },
	{ id: "m-sonnet", providerId: "p-anthropic", modelApiId: "claude-sonnet-5", displayName: "Claude Sonnet 5", contextWindow: 200000, reasoning: true, supportsImages: true, maxTokens: 16384 },
];

function makeSettings() {
	return {
		...DEFAULT_SETTINGS,
		providers: PROVIDERS,
		models: MODELS,
		activeModelId: "m-deepseek-pro",
		provider: "p-deepseek",
		modelId: "m-deepseek-pro",
		providerApiKeys: { "p-deepseek": "sk-test" },
		networkTransport: "requestUrl",
		showAgentDetails: false,
		sendShortcut: "enter",
		language: "en",
		sessionRetention: DEFAULT_SESSION_RETENTION,
		sessionDir: DEFAULT_SESSION_DIR,
		userSkillsDir: "",
	};
}

function makeAppStub(adapter) {
	return {
		vault: {
			adapter,
			getName: () => "Test",
			getFiles: () => [],
			getFileByPath: () => null,
			getAbstractFileByPath: () => null,
			read: async () => "",
			cachedRead: async () => "",
		},
		workspace: {
			getActiveViewOfType: () => null,
			getActiveFile: () => null,
		},
	};
}

function makeService({ streamFn, settings } = {}) {
	const adapter = memoryAdapter();
	const resolvedSettings = settings ?? makeSettings();
	const app = makeAppStub(adapter);
	const sessionManager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
	const service = new ObsidianAgentService(app, () => resolvedSettings, sessionManager, {
		streamFn: streamFn ?? (() => {
			throw new Error("no traffic in visual harness");
		}),
		loadUserSkills: NO_USER_SKILLS,
	});
	return { service, sessionManager, settings: resolvedSettings };
}

/** Waits until `done()` is true or `tries` frames pass, flushing renders each frame. */
async function settle(done, tries = 20) {
	for (let i = 0; i < tries; i += 1) {
		await flushRender();
		if (done()) {
			return true;
		}
	}
	return false;
}

/**
 * Mounts ChatApp the way the real-service test does — render first, so the
 * mount effect owns initialization — drives it with `drive`, then hands back
 * the panel element.
 */
async function mountChat({ streamFn, settings, drive, askUserBroker }) {
	const { service, sessionManager } = makeService({ streamFn, settings });
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = reactDomClient.createRoot(host);
	root.render(
		React.createElement(ChatApp, { service, inputController: new ChatInputController(), component: {}, askUserBroker }),
	);
	// Cold start: the mount effect initializes the service, which creates the
	// session and (on the empty screen) asks the model for chips.
	await settle(() => service.getSnapshot().sessionInfo !== undefined || service.getSnapshot().isConfigured === false);
	const cleanup = async () => {
		try {
			service.abort();
		} catch {}
		root.unmount();
		host.remove();
		document.body.replaceChildren();
	};
	if (drive) {
		await drive(service, sessionManager, askUserBroker);
	}
	await flushRender();
	const element = host.firstElementChild;
	return { element, cleanup };
}

const SCENARIOS = {};

SCENARIOS["chat-empty"] = async () => {
	const { element, cleanup } = await mountChat({
		streamFn: scriptedStreamFn([CHIPS_JSON]),
		drive: async (service) => {
			await settle(() => document.querySelectorAll(".piem-chat__quick-action").length >= 2);
			void service;
		},
	});
	return { element, cleanup };
};

SCENARIOS["chat-conversation"] = async () => {
	const { element, cleanup } = await mountChat({
		streamFn: scriptedStreamFn([
			CHIPS_JSON,
			[
				"## Reading list audit",
				"",
				"Your vault has **three** notes tagged `reading`, and two of them overlap:",
				"",
				"- `Books/Deep Work.md` — 4 highlights",
				"- `Books/Deep Work (copy).md` — same highlights, older",
				"",
				"Run `bun run merge-notes` to reconcile them.",
			].join("\n"),
			"Deleted the duplicate note and merged its highlights into the original. 12 lines changed, nothing lost.",
		]),
		drive: async (service) => {
			await service.sendPrompt("Audit my reading list");
			await flushRender();
			await service.sendPrompt("Good — clean up the duplicate");
		},
	});
	return { element, cleanup };
};

/**
 * The flat trace rows: a paired call (the common shape — call and result as one
 * row), a result with a diff that opens itself, a failing one, and the
 * compaction divider. Seeded through a second session so the shapes do not
 * depend on real tool execution, then reloaded the way a vault restart would —
 * `openSession` is the same path the session picker takes.
 *
 * The tool names are the plugin's real ones. They were invented (`edit_note`,
 * `web_search`) until the glyph work in the icon audit, which is exactly the
 * kind of thing this page exists to catch: an id no tool ships falls through
 * `toolCatalog.ts` to a monospace name and the generic wrench, so the page drew
 * the fallback on every row and none of the real vocabulary.
 */
SCENARIOS["chat-traces"] = async () => {
	const { element, cleanup } = await mountChat({
		streamFn: scriptedStreamFn([CHIPS_JSON]),
		drive: async (service, sessionManager) => {
			const info = await sessionManager.createSession({ provider: "p-deepseek", modelId: "m-deepseek-pro" });
			const assistant = (text, calls = []) => ({
				role: "assistant",
				content: [{ type: "text", text }, ...calls],
				api: "openai-completions",
				provider: "deepseek",
				model: "deepseek-v4-pro",
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			});
			await sessionManager.appendMessage({ role: "user", content: "Update the reading list", timestamp: Date.now() });
			await sessionManager.appendMessage(
				assistant("Updating `Books/Deep Work.md` now.", [
					{ type: "toolCall", id: "tc_read", name: "read", arguments: { path: "Books/Deep Work.md" } },
				]),
			);
			// Answers `tc_read`, so the two draw as one row — the shape the reader
			// meets most, and the only one that shows a settled tool's own glyph.
			await sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "tc_read",
				toolName: "read",
				content: [{ type: "text", text: "# Deep Work\n\n* *Seeing* — 2025 edition" }],
				isError: false,
				timestamp: Date.now(),
			});
			await sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "tc_1",
				toolName: "edit",
				content: [{ type: "text", text: "Applied the edit." }],
				details: { diff: "+  * *The Hero with a Thousand Faces* — chapter 3\n-  ~~old highlight~~\n+  * *Seeing* — 2026 edition" },
				isError: false,
				timestamp: Date.now(),
			});
			await sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "tc_2",
				toolName: "web_fetch",
				content: [{ type: "text", text: "No results for the quoted phrase." }],
				isError: true,
				timestamp: Date.now(),
			});
			await sessionManager.appendMessage({
				role: "compactionSummary",
				summary: "Earlier turns covered importing the 2025 reading CSV and tagging every book note.",
				tokensBefore: 41_000,
				timestamp: Date.now(),
			});
			await sessionManager.appendMessage(assistant("Done — the list now has 9 entries and two were merged."));
			// `createSession` already made B the manager's active session, so a plain
			// `openSession(B)` would hit the same-path early exit and the panel would
			// keep showing A's empty transcript. Point the manager back at A first.
			await sessionManager.loadSession(service.getSnapshot().session.path);
			await service.openSession(info.path);
			await settle(() => document.querySelectorAll(".piem-chat__message, .piem-chat__trace, .piem-chat__compaction").length >= 4);
		},
	});
	return { element, cleanup };
};

SCENARIOS["chat-streaming"] = async () => {
	const { element, cleanup } = await mountChat({
		streamFn: hangingStreamFn("Reading the three notes you tagged `reading` — the second one looks like a duplicate, hold on"),
		drive: async (service) => {
			const send = service.sendPrompt("Check my reading notes for duplicates");
			await settle(
				() =>
					service.getSnapshot().isStreaming &&
					document.querySelector(".piem-chat__message--assistant") !== null,
			);
			// Hold the promise; abort in cleanup ends the turn.
			void send;
			// A draft left waiting mid-reply: the turn slot is Stop now, so the
			// queue entry beside it is what the bar should show for this draft.
			const textarea = document.querySelector(".piem-chat footer textarea");
			if (!textarea) {
				throw new Error("composer textarea not found");
			}
			Reflect.set(window.HTMLTextAreaElement.prototype, "value", "and check the third one too", textarea);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
			if (!(await settle(() => document.querySelector(".piem-chat__queue-button") !== null))) {
				throw new Error("queue entry did not appear for the mid-reply draft");
			}
		},
	});
	return { element, cleanup };
};

/*
 * A provider failure, which now reads in the flow rather than in the banner
 * (#239). The wait is on the transcript's own tail — an assistant turn stamped
 * `stopReason: "error"` — because that is where the report lives; waiting on
 * `errorMessage` would wait for a banner that no longer rises for this.
 */
SCENARIOS["chat-error"] = async () => {
	const { element, cleanup } = await mountChat({
		streamFn: failingStreamFn("DeepSeek request failed: 401 invalid API key"),
		drive: async (service) => {
			await service.sendPrompt("Hello");
			await settle(() => {
				const last = service.getSnapshot().messages.at(-1);
				return last?.role === "assistant" && last.stopReason === "error";
			});
		},
	});
	return { element, cleanup };
};

/*
 * What the banner is *for* after the triage: a standing state that stops the
 * panel working until the reader changes something. The key gate is the
 * archetype, and it is the one failure whose recovery is the settings tab.
 */
SCENARIOS["chat-blocked"] = async () => {
	const { element, cleanup } = await mountChat({
		/*
		 * Every key removed — on the active provider *and* in the per-provider map,
		 * because `getConfiguredApiKey` reads the configured provider first. This is
		 * the one standing state whose recovery is the settings tab, and therefore
		 * the one failure that earns the banner's shortcut.
		 */
		settings: {
			...makeSettings(),
			providers: PROVIDERS.map((provider) => ({ ...provider, apiKey: "", secretRef: "" })),
			providerApiKeys: {},
		},
		drive: async (service) => {
			await service.sendPrompt("Hello");
			await settle(() => service.getSnapshot().errorMessage !== undefined);
		},
	});
	return { element, cleanup };
};

/*
 * The armed-edit state: one completed turn, then the user message's edit
 * button is clicked for real — the notice is ChatApp-internal state, so there
 * is no service-level entry; dispatching on the live button exercises the same
 * path a user's click takes.
 */
SCENARIOS["chat-editing"] = async () => {
	const { element, cleanup } = await mountChat({
		streamFn: scriptedStreamFn([CHIPS_JSON, "Reading the three notes tagged `reading` now — one looks like a duplicate."]),
		drive: async (service) => {
			await service.sendPrompt("Check my reading notes for duplicates");
			await settle(
				() => !service.getSnapshot().isStreaming && document.querySelector(".piem-chat__message--assistant") !== null,
			);
			const edit = [...document.querySelectorAll("button[aria-label]")].find(
				(button) => button.getAttribute("aria-label") === "Edit and resend",
			);
			if (!edit) {
				throw new Error("edit button not found");
			}
			edit.click();
			await settle(() => document.querySelector(".piem-chat__editing") !== null);
		},
	});
	return { element, cleanup };
};

/*
 * The context popover, opened. The gauge's own click path opens it — the state
 * lives in `ContextGauge`, so pressing the live ring is the only way to reach it
 * — and the popover is the only surface that renders a labelled icon button next
 * to three lines of readout, which is what makes it the page where an icon that
 * sits above its label (#219) is visible at all.
 */
SCENARIOS["chat-context-popover"] = async () => {
	const { element, cleanup } = await mountChat({
		streamFn: scriptedStreamFn([CHIPS_JSON, "Three notes tagged `reading`, two of them duplicates."]),
		drive: async (service) => {
			await service.sendPrompt("Audit my reading list");
			await settle(() => !service.getSnapshot().isStreaming && document.querySelector(".piem-chat__context-gauge") !== null);
			document.querySelector(".piem-chat__context-gauge").click();
			await settle(() => document.querySelector(".piem-chat__context-popover") !== null);
		},
	});
	return { element, cleanup };
};

/** Inspector snapshots, hand-built: pure data, no live registry needed. */
const INSPECTOR_SNAPSHOTS = [
	{
		id: "sub-1",
		role: "researcher",
		task: "Compare the two PDF readers the user shortlisted and summarize price, sync and mobile support.",
		followUps: ["Check whether either one syncs annotations to an iPad offline."],
		depth: 1,
		modelId: "deepseek-v4-pro",
		thinkingLevel: "medium",
		status: "done",
		spawnedAt: Date.now() - 74_000,
		settledAt: Date.now() - 12_000,
		durationMs: 62_000,
		report:
			"**Zotero** wins on price (free tier covers both) and has better PDF annotation sync; **Papers** is stronger on mobile but its sync plan costs $3/month. Recommend Zotero unless the iPad workflow is primary.",
		turns: 6,
		usage: { tokens: 18_400, cost: 0.0142, requests: 6 },
		messages: [],
	},
	{
		id: "sub-2",
		role: "sweeper",
		task: "Find every note that links to `Books/Deep Work.md` and report broken links.",
		instructions: "Report only; do not edit.",
		depth: 1,
		modelId: "deepseek-v4-lite",
		thinkingLevel: "off",
		status: "running",
		spawnedAt: Date.now() - 9_000,
		durationMs: 9_000,
		messages: [],
	},
	{
		id: "sub-3",
		role: "archiver",
		task: "Move notes older than 2024 into the Archive folder.",
		depth: 1,
		modelId: "deepseek-v4-pro",
		thinkingLevel: "medium",
		status: "failed",
		archived: true,
		spawnedAt: Date.now() - 40_000,
		settledAt: Date.now() - 33_000,
		durationMs: 7_000,
		errorMessage: "Folder 'Archive' does not exist and creation was refused",
		turns: 1,
		messages: [],
	},
];

async function mountInspector(snapshots, selectionRequest) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = reactDomClient.createRoot(host);
	root.render(
		React.createElement(SubagentInspectorApp, {
			snapshots,
			showAgentDetails: true,
			selectionRequest: selectionRequest ?? null,
			onStop: () => {},
			onStopAll: () => {},
			onArchiveFinished: () => {},
			app: makeAppStub(memoryAdapter()),
			component: {},
		}),
	);
	await flushRender();
	await flushRender();
	return {
		element: host.firstElementChild,
		cleanup: async () => {
			root.unmount();
			host.remove();
			document.body.replaceChildren();
		},
	};
}

/*
 * The question card, in the layout a desktop reader meets: one single-select
 * question, so every row commits on the click and therefore wears no marker and a
 * trailing arrow instead of one. `matchMedia` in this harness reports a fine
 * pointer, which is exactly the branch that produces action rows.
 */
SCENARIOS["chat-ask"] = async () => {
	const broker = new AskUserBroker({ isPanelVisible: () => true });
	const { element, cleanup } = await mountChat({
		streamFn: scriptedStreamFn([CHIPS_JSON]),
		askUserBroker: broker,
		drive: async (service) => {
			await service.sendPrompt("Tidy up my reading list");
			await flushRender();
			void broker.ask([
				{
					question: "Two notes hold the same highlights. Which one should survive?",
					header: "Which note",
					options: [
						{ label: "Keep Deep Work.md", description: "The older file, already linked from six other notes." },
						{ label: "Keep Deep Work (copy).md", description: "The newer file, with two highlights the original lacks." },
						{ label: "Merge them into a new note", description: "Both sets of highlights, neither original path." },
					],
				},
			]);
			await settle(() => document.querySelectorAll(".piem-ask-action").length >= 3);
		},
	});
	return { element, cleanup };
};

/*
 * The other layout: several questions, one of them multi-select. Nothing here can
 * commit on a click — one answer is not the batch — so every row carries the marker
 * whose shape is the rule, and the footer shows the count Confirm is waiting for.
 */
SCENARIOS["chat-ask-multi"] = async () => {
	const broker = new AskUserBroker({ isPanelVisible: () => true });
	const { element, cleanup } = await mountChat({
		streamFn: scriptedStreamFn([CHIPS_JSON]),
		askUserBroker: broker,
		drive: async (service) => {
			await service.sendPrompt("Reorganize the reading folder");
			await flushRender();
			void broker.ask([
				{
					question: "Where should the merged note live?",
					header: "Where to file",
					options: [
						{ label: "Books/", description: "Beside the rest of the reading notes." },
						{ label: "Inbox/", description: "Left for you to triage later." },
					],
				},
				{
					question: "What should I carry over from the copy?",
					header: "What to keep",
					multiSelect: true,
					options: [
						{ label: "Highlights", description: "Every quoted passage, in the order they appear." },
						{ label: "Frontmatter", description: "Tags, rating, and the finished date." },
						{ label: "Backlinks", description: "Rewrites the six notes that point at the old path." },
					],
				},
			]);
			await settle(() => document.querySelectorAll(".piem-ask-option").length >= 5);
		},
	});
	return { element, cleanup };
};

/*
 * What the decision leaves behind. Seeded as a settled tool result the same way
 * `chat-traces` seeds its rows, because this is the shape a reader meets on every
 * later scroll-back — and the shape that used to be a one-line collapsed trace.
 */
SCENARIOS["chat-ask-answered"] = async () => {
	const { element, cleanup } = await mountChat({
		streamFn: scriptedStreamFn([CHIPS_JSON]),
		drive: async (service, sessionManager) => {
			const info = await sessionManager.createSession({ provider: "p-deepseek", modelId: "m-deepseek-pro" });
			await sessionManager.appendMessage({ role: "user", content: "Tidy up my reading list", timestamp: Date.now() });
			await sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "tc_ask",
				toolName: "ask_user",
				content: [{ type: "text", text: "The user answered:\nWhich note: Merge them into a new note" }],
				details: {
					dismissed: false,
					answers: [
						{
							question: "Two notes hold the same highlights. Which one should survive?",
							header: "Which note",
							selected: ["Merge them into a new note"],
						},
						{ question: "What should I carry over from the copy?", header: "What to keep", selected: ["Highlights", "Frontmatter"] },
					],
				},
				isError: false,
				timestamp: Date.now(),
			});
			await sessionManager.loadSession(service.getSnapshot().session.path);
			await service.openSession(info.path);
			await settle(() => document.querySelectorAll(".piem-ask-card__picked").length >= 3);
		},
	});
	return { element, cleanup };
};

SCENARIOS["subagent-list"] = async () => mountInspector(INSPECTOR_SNAPSHOTS);
SCENARIOS["subagent-detail"] = async () => mountInspector(INSPECTOR_SNAPSHOTS, { id: "sub-1", token: 1 });

/* ------------------------------------------------------ tidying seam (issue #278) */

/*
 * The tidying row in all four of its states, as a contact sheet.
 *
 * Not a panel page: what has to be judged here is one row's four states beside
 * each other, in both languages and both themes, which the shared `page()` shape
 * cannot say. It began as a decision page — a dashed rule against a torn-paper
 * sawtooth — and stayed after the dashed rule won, because the same sheet is what
 * shows whether the seam survives a long translation and a light background.
 */

/** The transcript under the settled seam: two turns kept, one asked afterwards. */
function seamTranscript(language) {
	const zh = language === "zh-cn";
	const assistant = (text) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return [
		{ role: "user", content: zh ? "合并重复的读书笔记" : "Merge the duplicate notes", timestamp: Date.now() },
		assistant(zh ? "合并完了，高亮都保留着。" : "Merged them — every highlight kept."),
		{ role: "user", content: zh ? "再看第三篇" : "Check the third one", timestamp: Date.now() },
	];
}

const SEAM_SUMMARY = {
	"zh-cn": "较早的往来：导入 2025 年阅读 CSV、给每篇书籍笔记打标签，并确认了三处坏链。",
	en: "Earlier turns covered importing the 2025 reading CSV, tagging every book note, and confirming three broken links.",
};

const SEAM_ERROR = "429 Too Many Requests — the provider asked us to slow down";

/** One transcript mount, serialized. `state` picks which of the four cells it is. */
async function mountSeam(state, language) {
	const summary = {
		role: "compactionSummary",
		summary: SEAM_SUMMARY[language],
		tokensBefore: 41_000,
		timestamp: Date.now(),
	};
	const settled = state === "settled" || state === "open";
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = reactDomClient.createRoot(host);
	root.render(
		React.createElement(
			TranslatorProvider,
			{ language },
			React.createElement(MessageList, {
				messages: settled ? [summary, ...seamTranscript(language)] : seamTranscript(language),
				isStreaming: false,
				pendingToolCalls: [],
				app: makeAppStub(memoryAdapter()),
				component: {},
				sourcePath: "",
				traceExpand: state === "open" ? "expanded" : "collapsed",
				// Two kept turns, so the seam draws before the question that followed it.
				compactionRetained: settled ? 2 : 0,
				compactionEvent: state === "running" ? { state: "running", anchor: 3 } : state === "failed" ? { state: "failed", anchor: 3, error: SEAM_ERROR } : null,
			}),
		),
	);
	await flushRender();
	await flushRender();
	const element = host.firstElementChild;
	const markup = element.outerHTML;
	root.unmount();
	host.remove();
	return markup;
}

/*
 * Obsidian's default *light* theme, for the tokens this stylesheet reads.
 *
 * The rest of this harness is dark-only, which is fine for spacing and alignment
 * and not fine for a seam: how a hairline reads against the page is the whole
 * question, and it is the answer that inverts between themes. Layout values are
 * exact (they are shared with `TOKENS`); colours are close, not exact — enough to
 * judge whether a line is visible, not enough to settle a contrast figure.
 */
const LIGHT_TOKENS = `
	--icon-color: #5c5c5c;
	--icon-color-hover: #222;
	--background-primary: #fff;
	--background-primary-alt: #f5f6f8;
	--background-secondary: #f2f3f5;
	--background-secondary-alt: #e3e5e8;
	--background-modifier-border: #ddd;
	--background-modifier-border-hover: #c8c8c8;
	--background-modifier-border-focus: #999;
	--background-modifier-hover: rgba(0, 0, 0, 0.05);
	--background-modifier-error: #e93147;
	--background-modifier-error-rgb: 233, 49, 71;
	--text-normal: #222;
	--text-muted: #5c5c5c;
	--text-faint: #999;
	--text-error: #c0304a;
	--text-accent: #705dcf;
	--text-on-accent: #fff;
	/* Obsidian's default accent resolves to this, and to the same value in both
	   themes: it is the user's chosen accent, not a theme colour. It was a step
	   darker here (Tailwind's violet-600), which understated a glyph this token
	   now tints rather than only a button it fills. */
	--interactive-accent: #8b6cef;
	--interactive-normal: #f2f3f5;
	--interactive-hover: #e9e9e9;
	--code-background: #f2f3f5;
	--pre-background: #f2f3f5;
	--tag-background: #e4e4e4;
	--shadow-s: 0 1px 2px rgba(0, 0, 0, 0.1);
	--shadow-l: 0 4px 12px rgba(0, 0, 0, 0.12);
	--scrollbar-thumb-bg: #ccc;
`;

const SEAM_CELLS = [
	{ state: "running", label: "in flight" },
	{ state: "settled", label: "settled" },
	{ state: "open", label: "settled, opened" },
	{ state: "failed", label: "failed" },
];

/** Which widths the sheet shows each cell at, per language. */
const SEAM_COLUMNS = [
	{ language: "zh-cn", width: 300 },
	{ language: "en", width: 300 },
	{ language: "zh-cn", width: 560 },
];

async function seamPage() {
	const markup = new Map();
	for (const { state } of SEAM_CELLS) {
		for (const language of ["zh-cn", "en"]) {
			markup.set(`${state}:${language}`, await mountSeam(state, language));
		}
	}
	const grid = (theme) => `<section class="sheet sheet--${theme}">
	<h2>${theme === "light" ? "Light theme (approximate colours)" : "Dark theme"}</h2>
	${SEAM_CELLS.map(
		({ state, label }) => `<div class="sheet-row">
		<h3>${label}</h3>
		<div class="sheet-cells">${SEAM_COLUMNS.map(
			({ language, width }) => `<figure style="width: ${width}px">
			<figcaption>${language} · ${width}px</figcaption>
			<div class="harness-leaf harness-leaf--seam" style="width: ${width}px"><div class="view-content">${markup.get(`${state}:${language}`)}</div></div>
		</figure>`,
		).join("")}</div>
	</div>`,
	).join("")}
</section>`;
	const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>tidying seam</title><style>
:root {${TOKENS}}
.sheet--light { ${LIGHT_TOKENS} }
body { background: #191919; font-family: var(--font-interface); margin: 0; padding: 16px; }
h2 { color: #ddd; font-size: 13px; font-weight: 500; margin: 0 0 10px; }
h3 { color: #999; font-size: 11px; font-weight: 400; margin: 0 0 4px; }
figcaption { color: #777; font-size: 10px; margin-bottom: 3px; }
figure { margin: 0; }
/* The light block scopes its tokens to this section, so a colour resolved at body
   level would resolve against the dark root and set every word in the light cells
   in dark-theme grey. Hence the restatement here. */
.sheet { background: var(--background-primary); border-radius: 8px; color: var(--text-normal); margin-bottom: 16px; padding: 14px; }
.sheet--light h2 { color: #333; }
.sheet--light h3, .sheet--light figcaption { color: #777; }
.sheet-row { margin-bottom: 12px; }
.sheet-cells { display: flex; gap: 14px; align-items: flex-start; }
/* The leaf, as app.css builds it, sized to a few rows instead of a full panel. */
.harness-leaf { background: var(--background-primary); contain: strict; isolation: isolate; }
.harness-leaf--seam { height: 300px; }
.view-content { height: 100%; width: 100%; }
${styles}
${OBSIDIAN_CORE_SHIM}
body { background: #191919; }
</style></head><body>
${grid("dark")}
${grid("light")}
</body></html>`;
	return { element: null, cleanup: async () => document.body.replaceChildren(), html, width: 300 + 300 + 560 + 3 * 14 + 60, height: 1400 };
}

SCENARIOS["tidy-seam"] = () => seamPage();

/*
 * A tool row's four states, and what a running one is now made of.
 *
 * The row used to answer "is something happening" with a spinner, which is the
 * one question it could answer without the glyph. So the glyph belongs to the
 * tool in every state but the two the reader has to act on, and "still out" is
 * carried by three stacked signals instead: the row's text lifts to
 * `--text-normal`, the glyph goes accent, and it breathes.
 *
 * A contact sheet because the parts that can be wrong are comparative. Whether an
 * hourglass reads as a wait needs the settled eye beside it; whether accent
 * carries at 300px needs the muted rows around it; and whether the fold's one
 * breath is legible for four calls needs the single-call row above it. Both
 * themes, because accent is the one colour here that does not come from the text
 * ramp.
 *
 * The breath is frozen at full opacity on this page. A screenshot would otherwise
 * catch a random phase and report the tint as whatever opacity it happened to
 * land on — and the frozen frame is also exactly what a reader with reduced
 * motion sees, so this sheet checks that path at the same time. That the tint
 * animates at all is a stylesheet question, not a picture one.
 */
const RUN_CELLS = [
	{ id: "one", label: "one call out" },
	{ id: "fold", label: "four out, folded into one row" },
	{ id: "mixed", label: "two back, one still out" },
	{ id: "settled", label: "back, and it worked" },
	{ id: "cut", label: "asked, never answered" },
	{ id: "failed", label: "it broke" },
];

/** The transcript and pending set for one cell. */
function runFixture(id, language) {
	const zh = language === "zh-cn";
	const base = {
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const reply = (...calls) => ({ role: "assistant", content: calls, ...base });
	const call = (callId, name, args) => ({ type: "toolCall", id: callId, name, arguments: args });
	const back = (callId, toolName, text, isError = false) => ({
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	});
	const ask = { role: "user", content: zh ? "把这三篇读书笔记核对一遍" : "Cross-check these three reading notes", timestamp: Date.now() };
	const pending = (...entries) => entries.map(([callId, name]) => ({ id: callId, name }));

	if (id === "one") {
		return {
			messages: [ask, reply(call("c-wait", "wait_subagent", { subagentId: "sub-1" }))],
			pendingToolCalls: pending(["c-wait", "wait_subagent"]),
		};
	}
	if (id === "fold") {
		return {
			messages: [
				ask,
				reply(
					call("c-s1", "spawn_subagent", { task: "Books/Deep Work.md" }),
					call("c-s2", "spawn_subagent", { task: "Books/Seeing.md" }),
					call("c-s3", "spawn_subagent", { task: "Books/Hero.md" }),
					call("c-wait", "wait_subagent", {}),
				),
			],
			pendingToolCalls: pending(["c-s1", "spawn_subagent"], ["c-s2", "spawn_subagent"], ["c-s3", "spawn_subagent"], ["c-wait", "wait_subagent"]),
		};
	}
	if (id === "mixed") {
		return {
			messages: [
				ask,
				reply(
					call("c-r1", "read", { path: "Books/Deep Work.md" }),
					call("c-r2", "read", { path: "Books/Seeing.md" }),
					call("c-g", "grep", { pattern: "duplicate highlight" }),
				),
				back("c-r1", "read", "# Deep Work"),
				back("c-r2", "read", "# Seeing"),
			],
			pendingToolCalls: pending(["c-g", "grep"]),
		};
	}
	if (id === "settled") {
		return {
			messages: [ask, reply(call("c-r", "read", { path: "Books/Deep Work.md" })), back("c-r", "read", "# Deep Work\n\n* *Seeing* — 2026 edition")],
			pendingToolCalls: [],
		};
	}
	if (id === "cut") {
		return { messages: [ask, reply(call("c-w", "write", { path: "Books/Deep Work.md" }))], pendingToolCalls: [] };
	}
	return {
		messages: [
			ask,
			reply(call("c-r", "read", { path: "Books/Missing.md" })),
			back("c-r", "read", zh ? "找不到这条笔记。" : "File not found.", true),
		],
		pendingToolCalls: [],
	};
}

/** One transcript mount, serialized; `id` picks which of the six cells it is. */
async function mountToolRun(id, language) {
	const { messages, pendingToolCalls } = runFixture(id, language);
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = reactDomClient.createRoot(host);
	root.render(
		React.createElement(
			TranslatorProvider,
			{ language },
			React.createElement(MessageList, {
				messages,
				isStreaming: pendingToolCalls.length > 0,
				pendingToolCalls,
				app: makeAppStub(memoryAdapter()),
				component: {},
				sourcePath: "",
			}),
		),
	);
	await flushRender();
	await flushRender();
	const element = host.firstElementChild;
	const markup = element.outerHTML;
	root.unmount();
	host.remove();
	return markup;
}

async function toolRunPage() {
	const markup = new Map();
	for (const { id } of RUN_CELLS) {
		for (const language of ["zh-cn", "en"]) {
			markup.set(`${id}:${language}`, await mountToolRun(id, language));
		}
	}
	const grid = (theme) => `<section class="sheet sheet--${theme}">
	<h2>${theme === "light" ? "Light theme (approximate colours)" : "Dark theme"}</h2>
	${RUN_CELLS.map(
		({ id, label }) => `<div class="sheet-row">
		<h3>${label}</h3>
		<div class="sheet-cells">${SEAM_COLUMNS.map(
			({ language, width }) => `<figure style="width: ${width}px">
			<figcaption>${language} · ${width}px</figcaption>
			<div class="harness-leaf harness-leaf--run" style="width: ${width}px"><div class="view-content">${markup.get(`${id}:${language}`)}</div></div>
		</figure>`,
		).join("")}</div>
	</div>`,
	).join("")}
</section>`;
	const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>tool run states</title><style>
:root {${TOKENS}}
.sheet--light { ${LIGHT_TOKENS} }
body { background: #191919; font-family: var(--font-interface); margin: 0; padding: 16px; }
h2 { color: #ddd; font-size: 13px; font-weight: 500; margin: 0 0 10px; }
h3 { color: #999; font-size: 11px; font-weight: 400; margin: 0 0 4px; }
figcaption { color: #777; font-size: 10px; margin-bottom: 3px; }
figure { margin: 0; }
.sheet { background: var(--background-primary); border-radius: 8px; color: var(--text-normal); margin-bottom: 16px; padding: 14px; }
.sheet--light h2 { color: #333; }
.sheet--light h3, .sheet--light figcaption { color: #777; }
.sheet-row { margin-bottom: 12px; }
.sheet-cells { display: flex; gap: 14px; align-items: flex-start; }
.harness-leaf { background: var(--background-primary); contain: strict; isolation: isolate; }
.harness-leaf--run { height: 190px; }
.view-content { height: 100%; width: 100%; }
${styles}
${OBSIDIAN_CORE_SHIM}
body { background: #191919; }
/* See the note above the cells: full opacity, so the sheet is reproducible and
   doubles as the reduced-motion frame. Also stills the tail's dots, which bounce
   on their own timer. */
.sheet .piem-chat__trace--running .piem-chat__trace-icon,
.sheet .piem-chat__typing-dot { animation-play-state: paused; }
</style></head><body>
${grid("dark")}
${grid("light")}
</body></html>`;
	return { element: null, cleanup: async () => document.body.replaceChildren(), html, width: 300 + 300 + 560 + 3 * 14 + 60, height: 2500 };
}

SCENARIOS["tool-run"] = () => toolRunPage();

/**
 * The provider form, and specifically its preset row.
 *
 * Built the way production builds it — `new ProviderModal(...).open()` runs
 * `onOpen`, so these are the rows `Setting` actually emits — then wrapped in the
 * `.modal` frame Obsidian would put around a modal's content. Not a React tree
 * like every other page here, which is why it assembles its own HTML.
 *
 * Three states at the desktop modal width. One width, not several: Obsidian
 * reshapes settings rows on a narrow screen through app.css rules this harness's
 * shim does not carry, so a phone column would be showing the harness's layout
 * rather than the app's. What this width does answer is the question the preset
 * row actually raises — its longest option is a full token-plan host (Qwen's), and
 * whether that pushes the row past the modal edge is visible here.
 *
 * The saved-row frame is the one that proves the selection is honest: it holds
 * Anthropic's endpoint and nothing told it so, the dropdown derived it.
 */
/*
 * The fork confirmation, in both languages.
 *
 * The dialog *is* the change issue #273's follow-up makes: pressing fork used to
 * grow two buttons in the send bar, and now it asks once. Its whole substance is
 * three strings and which of the two buttons carries the accent, so a picture is
 * the only check that reads them the way a user does — side by side, at the width
 * Obsidian gives a modal, with the Chinese copy next to the English it was
 * written against.
 */
SCENARIOS["fork-confirm"] = async () => {
	const { openForkConfirm } = await import("../src/ui/forkConfirmModal.ts");
	const { getT } = await import("../src/i18n/index.ts");

	const frame = (language) => {
		const before = new Set(Array.from(document.body.children));
		openForkConfirm({}, { t: getT(language), onConfirm: async () => {} });
		// The stub's `Modal` appends its own element on construction, titleEl first
		// and contentEl second — see `src/testUtils/obsidianStub.ts`. Taking the
		// child that appeared keeps this from depending on body order.
		const modalEl = Array.from(document.body.children).find((element) => !before.has(element));
		if (!modalEl) {
			throw new Error("openForkConfirm mounted nothing");
		}
		return `<div class="modal"><div class="modal-title">${modalEl.firstElementChild?.textContent ?? ""}</div>${modalEl.lastElementChild?.outerHTML ?? ""}</div>`;
	};

	const states = [
		["English", frame("en")],
		["\u4e2d\u6587 \u2014 the panel calls a chat \u300c\u5bf9\u8bdd\u300d everywhere else, so this does too", frame("zh-cn")],
	];
	const width = 520;
	const columns = `<div class="harness-panel">
	<h3>${width}px</h3>
	${states.map(([label, html]) => `<h4>${label}</h4>\n\t<div style="width: ${width}px">${html}</div>`).join("\n\t")}
</div>`;

	const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>fork-confirm</title><style>
:root {${TOKENS}}
body { background: #111; color: var(--text-normal); font-family: var(--font-interface); margin: 0; padding: 16px; display: flex; gap: 24px; align-items: flex-start; }
.harness-panel h3 { color: #888; font-size: 11px; font-weight: 400; margin: 0 0 6px; }
.harness-panel h4 { color: #6e6e6e; font-size: 11px; font-weight: 400; margin: 16px 0 4px; }
${styles}
${OBSIDIAN_CORE_SHIM}
</style></head><body>
${columns}
</body></html>`;

	return {
		element: document.body,
		html,
		width: width + 32 + 40,
		height: 520,
		cleanup: async () => document.body.replaceChildren(),
	};
};

SCENARIOS["provider-modal"] = async () => {
	const { ProviderModal } = await import("../src/ui/settings/ProviderModal.ts");
	const { getT } = await import("../src/i18n/index.ts");
	const t = getT("en");
	const opened = [];

	const frame = (provider, pick) => {
		const modal = new ProviderModal({
			app: {},
			...(provider ? { provider } : {}),
			// The plainest key tier: one text field, so the preset row is not sharing
			// the picture with a keychain picker.
			secretStorage: "manual",
			readSecret: () => "",
			t,
			test: async () => ({ ok: true, detail: "" }),
			onSubmit: async () => {},
		});
		modal.open();
		opened.push(modal);
		if (pick) {
			// Chosen the way a user chooses, so the production handler fills the three
			// fields below it rather than the harness writing them in.
			for (const select of Array.from(modal.contentEl.querySelectorAll("select"))) {
				if (Array.from(select.options).some((option) => option.value === pick)) {
					select.value = pick;
					select.dispatchEvent(new Event("change"));
					break;
				}
			}
		}
		/*
		 * `outerHTML` serializes attributes, and a form control's current state is
		 * not one: `input.value` and a `<select>`'s selection are properties. Left
		 * alone every field would render as its placeholder and every dropdown as
		 * its first option — the picture would show an empty Custom form no matter
		 * what the form actually holds, which is precisely the thing under test.
		 * So the state is written back as attributes before serializing.
		 */
		for (const input of Array.from(modal.contentEl.querySelectorAll("input"))) {
			if (input.value) {
				input.setAttribute("value", input.value);
			}
		}
		for (const select of Array.from(modal.contentEl.querySelectorAll("select"))) {
			for (const option of Array.from(select.options)) {
				if (option.value === select.value) {
					option.setAttribute("selected", "selected");
				} else {
					option.removeAttribute("selected");
				}
			}
		}
		return `<div class="modal"><div class="modal-title">${modal.titleEl.textContent}</div>${modal.contentEl.outerHTML}</div>`;
	};

	const SAVED = {
		id: "p-anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		protocol: "anthropic-messages",
		apiKey: "sk-ant-existing",
		secretRef: "",
		source: "user",
	};
	const states = [
		["New form — Custom, where it opens", frame(undefined, undefined)],
		["Preset picked — Qwen, the longest label there is", frame(undefined, "qwen")],
		["Editing a saved row — the selection is derived from its URL", frame(SAVED, undefined)],
	];

	const columns = [600]
		.map(
			(width) => `<div class="harness-panel">
	<h3>${width}px</h3>
	${states.map(([label, html]) => `<h4>${label}</h4>\n\t<div style="width: ${width}px">${html}</div>`).join("\n\t")}
</div>`,
		)
		.join("\n");

	const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>provider-modal</title><style>
:root {${TOKENS}}
body { background: #111; color: var(--text-normal); font-family: var(--font-interface); margin: 0; padding: 16px; display: flex; gap: 24px; align-items: flex-start; }
.harness-panel h3 { color: #888; font-size: 11px; font-weight: 400; margin: 0 0 6px; }
.harness-panel h4 { color: #6e6e6e; font-size: 11px; font-weight: 400; margin: 16px 0 4px; }
${styles}
${OBSIDIAN_CORE_SHIM}
</style></head><body>
${columns}
</body></html>`;

	return {
		element: document.body,
		html,
		width: 600 + 32 + 40,
		height: 1740,
		cleanup: async () => {
			for (const modal of opened) {
				modal.close();
			}
			document.body.replaceChildren();
		},
	};
};

/* ------------------------------------------------------------------ page assembly */

/** Minimal markdown face for the stub renderer: the shapes replies actually carry. */
function miniMarkdown(markdown) {
	const lines = markdown.split("\n");
	const out = [];
	let inCode = false;
	let code = [];
	let list = null;
	const flushList = () => {
		if (list) {
			out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
			list = null;
		}
	};
	const inline = (text) =>
		text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>")
			.replace(/`([^`]+)`/g, "<code>$1</code>");
	for (const raw of lines) {
		if (raw.startsWith("```")) {
			if (inCode) {
				out.push(`<pre><code>${code.join("\n")}</code></pre>`);
				inCode = false;
				code = [];
			} else {
				flushList();
				inCode = true;
			}
			continue;
		}
		if (inCode) {
			code.push(raw);
			continue;
		}
		const heading = raw.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			flushList();
			out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
			continue;
		}
		const bullet = raw.match(/^\s*[-*]\s+(.*)$/);
		if (bullet) {
			if (!list || list.tag !== "ul") {
				flushList();
				list = { tag: "ul", items: [] };
			}
			list.items.push(bullet[1]);
			continue;
		}
		if (raw.trim() === "") {
			flushList();
			continue;
		}
		flushList();
		out.push(`<p>${inline(raw)}</p>`);
	}
	flushList();
	if (inCode && code.length > 0) {
		out.push(`<pre><code>${code.join("\n")}</code></pre>`);
	}
	return out.join("\n");
}

// Obsidian's own values for the tokens the stylesheet reads — the same set the
// transcript harness carries, so the two pages agree on what the plugin sees.
const TOKENS = `
	--size-4-1: 4px;
	--size-4-2: 8px;
	--size-4-3: 12px;
	--size-4-4: 16px;
	--size-4-5: 20px;
	--size-4-6: 24px;
	--size-4-8: 32px;
	--size-4-9: 36px;
	--size-4-10: 40px;
	--size-4-12: 48px;
	--size-2-1: 2px;
	--size-2-2: 4px;
	--size-2-3: 6px;
	--radius-s: 4px;
	--radius-m: 8px;
	--radius-l: 12px;
	--font-ui-smaller: 12px;
	--font-ui-small: 13px;
	--font-ui-medium: 15px;
	--font-text-size: 16px;
	--font-semibold: 600;
	--font-medium: 500;
	--font-interface: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	--font-monospace: ui-monospace, SFMono-Regular, Menlo, monospace;
	--icon-s: 16px;
	--icon-size: 16px;
	--icon-color: #b3b3b3;
	--icon-color-hover: #dcddde;
	--icon-opacity: 0.85;
	--background-primary: #1e1e1e;
	--background-primary-alt: #161616;
	--background-secondary: #262626;
	--background-secondary-alt: #1a1a1a;
	--background-modifier-border: #3f3f3f;
	--background-modifier-border-hover: #555;
	--background-modifier-border-focus: #888;
	--background-modifier-hover: rgba(255, 255, 255, 0.075);
	--background-modifier-error: #a33;
	--background-modifier-error-rgb: 170, 51, 51;
	--background-modifier-success: #2a2;
	--text-normal: #dcddde;
	--text-muted: #b3b3b3;
	--text-faint: #6e6e6e;
	--text-error: #e55;
	--text-accent: #a882ff;
	--text-on-accent: #fff;
	--text-success: #2a2;
	/* Obsidian's own default, hsl(254, 80%, 68%) — see the note in LIGHT_TOKENS. */
	--interactive-accent: #8b6cef;
	--interactive-accent-hover: #7a58ec;
	--interactive-normal: #2a2a2a;
	--interactive-hover: #333;
	--code-background: #2a2a2a;
	--pre-background: #2a2a2a;
	--code-size: 0.9em;
	--tag-background: #333;
	--shadow-s: 0 1px 2px rgba(0, 0, 0, 0.5);
	--shadow-l: 0 4px 12px rgba(0, 0, 0, 0.5);
	--layer-menu: 65;
	--scrollbar-thumb-bg: #555;
	--line-height-tight: 1.3;
	--input-radius: 5px;
	--modal-background: #1e1e1e;
	--modal-radius: 12px;
	--background-modifier-form-field: #1a1a1a;
`;

// Buttons and links get their look from Obsidian's app.css, not the plugin
// stylesheet — without this the pages' plain buttons render as bare HTML.
// Faithful to the default dark theme, layout values exact so spacing defects
// in the plugin's own rules still show; colors approximate.
const OBSIDIAN_CORE_SHIM = `body { color: var(--text-normal); font-family: var(--font-interface); font-size: var(--font-ui-medium); }
button {
	background-color: var(--interactive-normal);
	border: 0;
	border-radius: 6px;
	box-shadow: var(--shadow-s);
	color: var(--text-normal);
	cursor: pointer;
	font-family: var(--font-interface);
	font-size: var(--font-ui-small);
	height: 30px;
	line-height: 17px;
	padding: var(--size-2-1) var(--size-4-3);
	white-space: nowrap;
}
button:hover { background-color: var(--interactive-hover); }
button.mod-cta { background-color: var(--interactive-accent); color: var(--text-on-accent); }
button.mod-destructive { background-color: rgba(var(--background-modifier-error-rgb), 0.15); color: var(--text-error); }
/* Icon buttons ride Obsidian's clickable-icon: transparent until hover, icon
   colored, minimum hit area. Obsidian's app.css fully resets the UA button
   look (appearance/border/padding/shadow); mirror that here — resetting only
   the background still leaves Chromium's default button frame visible. */
.clickable-icon { appearance: none; background-color: transparent; border: none; box-shadow: none; color: var(--icon-color); cursor: pointer; display: flex; padding: 0; }
.clickable-icon:hover { color: var(--icon-color-hover); }
/* setIcon stamps width="24" height="24" on the SVG; Obsidian's app.css sizes
   .svg-icon from --icon-size so every icon renders at 16px here. Without this
   rule the SVGs paint at their natural 24px and every icon in the screenshots
   is 1.5x too large — alignment verdicts lie. */
.svg-icon { height: var(--icon-size, var(--icon-s)); width: var(--icon-size, var(--icon-s)); }
/* Snap Chromium double-paints underlined anchors (bug, not a plugin defect);
   the default theme styles links with accent color and no underline anyway. */
a { color: var(--text-accent); cursor: pointer; text-decoration: none; }
a:hover { text-decoration: underline; }
/* Settings rows and the modal frame. Every row a settings form draws is built by
   Obsidian's Setting, whose layout lives entirely in app.css — styles.css only
   carries the piem-* rules on top of it. Without this block a form page renders
   as a stack of unstyled divs, which is worse than no picture: the plugin's own
   spacing rules would appear to do nothing.
   Layout values are the shipped 1.13 ones so a spacing defect in a piem rule still
   shows; colors are approximate, like the rest of this shim. Judge structure,
   alignment and wrapping from these pages — never a colour verdict. */
.setting-item { align-items: center; border-top: 1px solid var(--background-modifier-border); display: flex; gap: var(--size-4-4); justify-content: space-between; padding: var(--size-4-3) 0; }
.setting-item:first-child { border-top: none; padding-top: 0; }
.setting-item-info { margin-right: auto; min-width: 0; }
.setting-item-name { color: var(--text-normal); }
.setting-item-description { color: var(--text-muted); font-size: var(--font-ui-smaller); line-height: var(--line-height-tight); padding-top: var(--size-4-1); }
.setting-item-control { align-items: center; display: flex; flex: 0 0 auto; gap: var(--size-4-2); justify-content: flex-end; }
.setting-item-heading .setting-item-name { font-size: var(--font-ui-medium); font-weight: var(--font-semibold); }
input.text-input, select.dropdown {
	background: var(--background-modifier-form-field);
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--input-radius);
	color: var(--text-normal);
	font-family: var(--font-interface);
	font-size: var(--font-ui-small);
	height: 30px;
	padding: 0 var(--size-4-2);
}
/* Obsidian caps a form control so a long value cannot push the row wider than the
   modal. Reproduced because the preset dropdown's longest label is a full
   token-plan host, and whether that wraps or overflows is exactly what these
   pictures are for. */
input.text-input, select.dropdown { max-width: 100%; }
select.dropdown { appearance: none; background-image: none; text-overflow: ellipsis; }
.modal { background: var(--modal-background); border-radius: var(--modal-radius); box-shadow: var(--shadow-l); padding: var(--size-4-4); }
.modal-title { font-size: var(--font-ui-medium); font-weight: var(--font-semibold); margin-bottom: var(--size-4-3); text-align: center; }
`;

/**
 * The panel inside a real leaf. Chat and inspector pages get the three widths
 * the transcript harness uses — same DOM serialized once, so a width-dependent
 * defect shows up as a difference between siblings, not a rebuild.
 */
function page(title, innerHtml, widths) {
	const panels = widths
		.map(
			(width) => `<div class="harness-panel">
	<h3>${width}px</h3>
	<div class="harness-leaf" style="width: ${width}px">
		<div class="view-content">${innerHtml}</div>
	</div>
</div>`,
		)
		.join("\n");
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><style>
:root {${TOKENS}}
body { background: #111; color: var(--text-normal); font-family: var(--font-interface); margin: 0; padding: 16px; display: flex; gap: 20px; align-items: flex-start; }
.harness-panel h3 { color: #888; font-size: 11px; font-weight: 400; margin: 0 0 6px; }
/* The leaf, as app.css builds it: a fixed-width containment and stacking box. */
.harness-leaf { background: var(--background-secondary); contain: strict; isolation: isolate; height: 640px; }
.view-content { height: 100%; width: 100%; }
${styles}
${OBSIDIAN_CORE_SHIM}
</style></head><body>
${panels}
</body></html>`;
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const CHAT_WIDTHS = [300, 390, 560];
	const manifest = [];
	for (const [name, build] of Object.entries(SCENARIOS)) {
		try {
			const built = await build();
			const { element, cleanup } = built;
			try {
				/*
				 * A scenario that needs a page shape this harness's own `page()` cannot
				 * express — a contact sheet across states, languages and themes rather
				 * than one panel at three widths — hands back finished HTML and its own
				 * window size. Everything else stays on the shared path, so the eight
				 * panel pages cannot drift apart.
				 */
				const html = built.html ?? page(name, element.outerHTML, CHAT_WIDTHS);
				const file = join(OUT_DIR, `${name}.html`);
				writeFileSync(file, html);
				manifest.push({
					name,
					file,
					width: built.width ?? 3 * 560 + 2 * 20 + 32 + 40,
					height: built.height ?? 700,
				});
				console.log(`wrote ${file}`);
			} finally {
				await cleanup();
			}
		} catch (error) {
			console.error(`scenario ${name} failed:`, error?.stack ?? error);
		}
	}
	writeFileSync(join(OUT_DIR, "visual-manifest.json"), JSON.stringify(manifest, null, 2));
	console.log(`wrote ${join(OUT_DIR, "visual-manifest.json")} (${manifest.length} pages)`);
	// Nothing may outlive the run: React roots are unmounted above, and an
	// un-ended service timer would otherwise keep this process alive.
	process.exit(0);
}

await main();
