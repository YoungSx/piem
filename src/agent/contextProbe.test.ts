import { afterEach, describe, expect, test } from "bun:test";
import type { App, WorkspaceLeaf } from "obsidian";
import { environmentMock, installObsidianStub, platformMock, STUB_API_VERSION } from "../testUtils/obsidianStub";
import type { ContextRef } from "./contextRefs";

installObsidianStub();

const { probeEnvironment, probeLinkContext, probeOutlines, probeRunContext, probeSelection, probeWorkspaceContext } = await import("./contextProbe");
const { MAX_SELECTION_CHARS } = await import("./contextInjection");
const { MarkdownView, TFolder } = await import("obsidian");

/** A folder entry that satisfies the `instanceof TFolder` check the probe makes. */
function folderEntry(path: string): object {
	return Object.assign(new TFolder(), { path, name: path.split("/").pop() });
}

/** A file entry, which is anything that is not a `TFolder`. */
function fileEntry(path: string, extension = "md"): Record<string, unknown> {
	return { path, extension, name: path.split("/").pop() };
}

/** A leaf holding a Markdown view of `path`, or an empty one when `path` is null. */
function markdownLeaf(path: string | null): object {
	// The real constructor takes the leaf it belongs to; the probe only reads `file`,
	// so an empty stand-in is enough — same shape `messageActions.test.ts` uses.
	return { view: Object.assign(new MarkdownView({} as WorkspaceLeaf), { file: path === null ? null : fileEntry(path) }) };
}

interface FakeVault {
	files?: Record<string, Record<string, unknown>>;
	leaves?: object[];
	recent?: string[];
	name?: string;
	/** `resolvedLinks` shape: source path to target path to count. */
	resolvedLinks?: Record<string, Record<string, number>>;
	/** `unresolvedLinks` shape: source path to *written link text* to count. */
	unresolvedLinks?: Record<string, Record<string, number>>;
	caches?: Record<string, unknown>;
	activeEditor?: object | null;
}

function fakeApp({
	files = {},
	leaves = [],
	recent = [],
	name = "probe-vault",
	resolvedLinks = {},
	unresolvedLinks = {},
	caches = {},
	activeEditor = null,
}: FakeVault): App {
	return {
		vault: {
			getName: () => name,
			getFileByPath: (path: string) => files[path] ?? null,
		},
		workspace: {
			getLeavesOfType: () => leaves,
			getLastOpenFiles: () => recent,
			activeEditor,
		},
		metadataCache: {
			resolvedLinks,
			unresolvedLinks,
			getFileCache: (file: { path: string }) => caches[file.path] ?? null,
		},
	} as unknown as App;
}

const pinnedRef = (path: string): ContextRef => ({ kind: "pinned", path, isPinned: true });

/** An editor stand-in with the two members the selection probe reads. */
function fakeEditor(file: string | null, selection: string): object {
	return { file: file === null ? null : { path: file }, editor: { getSelection: () => selection } };
}

const activeRef = (path: string): ContextRef => ({ kind: "active", path, isPinned: false });

afterEach(() => {
	// `platformMock` and `environmentMock` are process-global handles; leaving them
	// reconfigured would silently steer every later test file.
	Object.assign(platformMock, { isMacOS: false, isWin: false, isLinux: true, isIosApp: false, isAndroidApp: false, isPhone: false, isTablet: false });
	environmentMock.language = "en";
});

describe("probeEnvironment", () => {
	test("reads the vault name, the build, the language and the platform flags", () => {
		Object.assign(platformMock, { isLinux: false, isIosApp: true, isTablet: true });
		// `apiVersion` is a named import bound once against the stub, so the probe
		// cannot see a reassignment — asserted against the stub constant instead.
		environmentMock.language = "zh";

		expect(probeEnvironment(fakeApp({ name: "second brain" }))).toEqual({
			vaultName: "second brain",
			appVersion: STUB_API_VERSION,
			language: "zh",
			platform: { isMacOS: false, isWin: false, isLinux: false, isIosApp: true, isAndroidApp: false, isPhone: false, isTablet: true },
		});
	});
});

describe("probeWorkspaceContext", () => {
	test("collects the paths of open Markdown leaves", () => {
		const app = fakeApp({ files: { "Notes/a.md": fileEntry("Notes/a.md"), "Ideas/b.md": fileEntry("Ideas/b.md") }, leaves: [markdownLeaf("Notes/a.md"), markdownLeaf("Ideas/b.md")] });

		expect(probeWorkspaceContext(app, []).openTabs).toEqual(["Ideas/b.md", "Notes/a.md"]);
	});

	test("ignores leaves that are not Markdown views", () => {
		// `getLeavesOfType("markdown")` is the query, but the chat panel and a
		// deferred leaf both surface as views without a `file`; reading one blindly
		// would put `undefined` in the block.
		const app = fakeApp({ files: { "Notes/a.md": fileEntry("Notes/a.md") }, leaves: [{ view: { file: fileEntry("Chat/panel.md") } }, markdownLeaf(null), markdownLeaf("Notes/a.md")] });

		expect(probeWorkspaceContext(app, []).openTabs).toEqual(["Notes/a.md"]);
	});

	test("drops open-tab paths whose file no longer exists", () => {
		// Measured on a real runtime: for the whole synchronous window of a vault
		// `"delete"` event the leaves still hold the removed file's `TFile`, so an
		// unfiltered pass lists a tab whose path the note tools cannot open — the
		// same existence rule `recentFiles` already applies.
		const app = fakeApp({ files: { "Notes/alive.md": fileEntry("Notes/alive.md") }, leaves: [markdownLeaf("Notes/ghost.md"), markdownLeaf("Notes/alive.md")] });

		expect(probeWorkspaceContext(app, []).openTabs).toEqual(["Notes/alive.md"]);
	});

	test("drops recently-opened paths whose file no longer exists", () => {
		// Measured against a real vault: Obsidian never prunes a deleted file from
		// `getLastOpenFiles`, so an unfiltered list hands the model paths that `read`
		// will fail on, with no way to tell which.
		const app = fakeApp({ files: { "Notes/alive.md": fileEntry("Notes/alive.md") }, recent: ["Notes/deleted.md", "Notes/alive.md"] });

		expect(probeWorkspaceContext(app, []).recentFiles).toEqual(["Notes/alive.md"]);
	});

	test("drops recently-opened files that are not notes", () => {
		// The same list holds canvases and PDFs, which the note tools cannot act on.
		const app = fakeApp({
			files: {
				"Projects/board.canvas": fileEntry("Projects/board.canvas", "canvas"),
				"Notes/a.md": fileEntry("Notes/a.md"),
			},
			recent: ["Projects/board.canvas", "Notes/a.md"],
		});

		expect(probeWorkspaceContext(app, []).recentFiles).toEqual(["Notes/a.md"]);
	});

	test("reads the active note's folder and marks which entries are folders", () => {
		const active = fileEntry("Notes/today.md");
		active.parent = {
			path: "Notes",
			children: [active, fileEntry("Notes/other.md"), folderEntry("Notes/sub")],
		};
		const app = fakeApp({ files: { "Notes/today.md": active } });

		const context = probeWorkspaceContext(app, [activeRef("Notes/today.md")]);

		expect(context.folder).toEqual({ path: "Notes", entries: ["Notes/other.md", "Notes/sub/"], totalEntries: 2 });
	});

	test("reports no folder when nothing is being followed", () => {
		const app = fakeApp({ files: { "Notes/today.md": fileEntry("Notes/today.md") } });

		expect(probeWorkspaceContext(app, []).folder).toBeNull();
	});

	test("reports no folder when the active path no longer resolves", () => {
		// A note deleted mid-run leaves the ref pointing at nothing; the folder line
		// must vanish rather than name the folder it used to be in.
		const app = fakeApp({ files: {}, leaves: [] });

		expect(probeWorkspaceContext(app, [activeRef("Notes/gone.md")]).folder).toBeNull();
	});
});

describe("probeLinkContext", () => {
	test("inverts the forward link graph to find what points at the active note", () => {
		const app = fakeApp({
			files: { "Notes/today.md": fileEntry("Notes/today.md") },
			resolvedLinks: {
				"Notes/a.md": { "Notes/today.md": 2 },
				"Notes/b.md": { "Notes/today.md": 1 },
				"Notes/c.md": { "Notes/other.md": 1 },
				"Notes/today.md": {},
			},
		});

		expect(probeLinkContext(app, [activeRef("Notes/today.md")]).backlinks).toEqual(["Notes/a.md", "Notes/b.md"]);
	});

	test("reads unresolved links off the active note's own row, keyed by written text", () => {
		// Measured: `unresolvedLinks` maps the text the user typed, not a path — which
		// is why this needs no file lookup and why the renderer keeps the brackets.
		const app = fakeApp({
			files: { "Notes/today.md": fileEntry("Notes/today.md") },
			unresolvedLinks: { "Notes/today.md": { "Weekly Review": 1, "no-such-note": 2 } },
		});

		expect(probeLinkContext(app, [activeRef("Notes/today.md")]).brokenLinks).toEqual(["Weekly Review", "no-such-note"]);
	});

	test("reports nothing when no note is being followed", () => {
		const app = fakeApp({ resolvedLinks: { "Notes/a.md": { "Notes/today.md": 1 } } });

		expect(probeLinkContext(app, [pinnedRef("Notes/pin.md")]).backlinks).toEqual([]);
	});

	test("reports nothing when the active path no longer resolves", () => {
		const app = fakeApp({ files: {}, resolvedLinks: { "Notes/a.md": { "Notes/gone.md": 1 } } });

		expect(probeLinkContext(app, [activeRef("Notes/gone.md")]).backlinks).toEqual([]);
	});
});

describe("probeOutlines", () => {
	test("builds a skeleton for each pinned note from the metadata cache", () => {
		const app = fakeApp({
			files: { "Notes/spec.md": fileEntry("Notes/spec.md") },
			caches: {
				"Notes/spec.md": {
					headings: [{ level: 1, heading: "Overview" }],
					frontmatter: { status: "active" },
				},
			},
		});

		expect(probeOutlines(app, [pinnedRef("Notes/spec.md")])).toEqual([
			{
				path: "Notes/spec.md",
				headings: [{ level: 1, text: "Overview" }],
				totalHeadings: 1,
				properties: ["status: active"],
				totalProperties: 1,
			},
		]);
	});

	test("skips the active note even when it is also pinned", () => {
		// A pinned note that happens to be active is reported once, as the active
		// entry, so an outline for it would attach to a line that is not there.
		const app = fakeApp({
			files: { "Notes/today.md": fileEntry("Notes/today.md") },
			caches: { "Notes/today.md": { headings: [{ level: 1, heading: "Today" }] } },
		});

		expect(probeOutlines(app, [{ kind: "active", path: "Notes/today.md", isPinned: true }])).toEqual([]);
	});

	test("drops a pinned note with nothing to outline", () => {
		const app = fakeApp({ files: { "Notes/stub.md": fileEntry("Notes/stub.md") }, caches: { "Notes/stub.md": {} } });

		expect(probeOutlines(app, [pinnedRef("Notes/stub.md")])).toEqual([]);
	});

	test("drops a pinned note Obsidian has not cached", () => {
		const app = fakeApp({ files: { "Notes/fresh.md": fileEntry("Notes/fresh.md") }, caches: {} });

		expect(probeOutlines(app, [pinnedRef("Notes/fresh.md")])).toEqual([]);
	});
});

describe("probeSelection", () => {
	test("reads the selection out of the active editor", () => {
		const app = fakeApp({ activeEditor: fakeEditor("Notes/today.md", "the selected part") });

		expect(probeSelection(app, [activeRef("Notes/today.md")])).toEqual({
			path: "Notes/today.md",
			text: "the selected part",
			length: 17,
		});
	});

	test("reports nothing when the caret is collapsed", () => {
		const app = fakeApp({ activeEditor: fakeEditor("Notes/today.md", "") });

		expect(probeSelection(app, [activeRef("Notes/today.md")])).toBeNull();
	});

	test("refuses a selection made in a different note", () => {
		// `activeEditor` reports the most recently active editor, so after a navigation
		// it can still hold the note the user left. Without the guard, that note's
		// selection would be attributed to this one.
		const app = fakeApp({ activeEditor: fakeEditor("Notes/elsewhere.md", "not mine") });

		expect(probeSelection(app, [activeRef("Notes/today.md")])).toBeNull();
	});

	test("survives a workspace with no editor at all", () => {
		// Measured: opening a canvas leaves `activeEditor` null while `getActiveFile`
		// still reports the canvas, so the optional chain here is load-bearing.
		expect(probeSelection(fakeApp({ activeEditor: null }), [activeRef("Notes/today.md")])).toBeNull();
	});

	test("drops the text but keeps the size past the budget", () => {
		const long = "y".repeat(MAX_SELECTION_CHARS + 10);
		const app = fakeApp({ activeEditor: fakeEditor("Notes/today.md", long) });

		expect(probeSelection(app, [activeRef("Notes/today.md")])).toEqual({
			path: "Notes/today.md",
			text: null,
			length: long.length,
		});
	});
});

describe("probeRunContext", () => {
	test("reads all four halves of a run's snapshot in one pass", () => {
		const active = fileEntry("Notes/today.md");
		active.parent = { path: "Notes", children: [active, fileEntry("Notes/other.md")] };
		const app = fakeApp({
			files: { "Notes/today.md": active, "Notes/pin.md": fileEntry("Notes/pin.md"), "Ideas/x.md": fileEntry("Ideas/x.md") },
			leaves: [markdownLeaf("Ideas/x.md")],
			resolvedLinks: { "Notes/a.md": { "Notes/today.md": 1 } },
			unresolvedLinks: { "Notes/today.md": { missing: 1 } },
			caches: { "Notes/pin.md": { headings: [{ level: 2, heading: "Spec" }] } },
			activeEditor: fakeEditor("Notes/today.md", "picked"),
		});

		const context = probeRunContext(app, [activeRef("Notes/today.md"), pinnedRef("Notes/pin.md")]);

		expect(context.workspace.folder?.path).toBe("Notes");
		expect(context.workspace.openTabs).toEqual(["Ideas/x.md"]);
		expect(context.links.backlinks).toEqual(["Notes/a.md"]);
		expect(context.links.brokenLinks).toEqual(["missing"]);
		expect(context.outlines.map((outline) => outline.path)).toEqual(["Notes/pin.md"]);
		expect(context.selection?.text).toBe("picked");
	});
});
