import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { installDom, mountLinkUpdateModal } from "../testUtils/dom";
import { PLUGIN_ID } from "../constants";
import type { App, TAbstractFile, TFile, TFolder } from "obsidian";

installObsidianStub();
// `move_note` runs every rename under the link-update modal guard, whose poll
// reads a document; without one the guard takes its null-document path and the
// modal-watching tests below could never exercise their branch.
installDom();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Dynamic imports so the mocked module wins over any cached real one.
// Runtime classes come from the mocked module; types stay type-only.
const { TFile: TFileClass, TFolder: TFolderClass } = await import("obsidian");
const { createMoveNoteTool, createTrashNoteTool } = await import("./organizeTools");

describe("move_note", () => {
	it("renames through fileManager so inbound links follow the note", async () => {
		const app = createVaultApp([{ kind: "file", path: "Inbox/Idea.md" }, { kind: "folder", path: "Projects" }]);

		const result = await createMoveNoteTool(app.app).execute("tool-call", { from: "Inbox/Idea.md", to: "Projects/Idea.md" });

		// The load-bearing assertion of this whole file: `vault.rename` would
		// produce the same success text while orphaning every [[wikilink]], so only
		// the choice of API can catch that regression.
		expect(app.record.fileManagerRename).toEqual([["Inbox/Idea.md", "Projects/Idea.md"]]);
		expect(app.record.vaultRename).toEqual([]);
		expect(textOf(result)).toBe("Moved Inbox/Idea.md to Projects/Idea.md. Obsidian's file manager handled the move.");
		expect(result.details).toMatchObject({
			from: "Inbox/Idea.md",
			to: "Projects/Idea.md",
			kind: "file",
			moved: true,
			linksUpdated: true,
		});
	});

	it("creates missing destination folders before renaming", async () => {
		const app = createVaultApp([{ kind: "file", path: "Idea.md" }]);

		await createMoveNoteTool(app.app).execute("tool-call", { from: "Idea.md", to: "Projects/2026/Idea.md" });

		// `FileManager.renameFile` does not create parents, so a missing chain
		// would otherwise fail the rename rather than the folder creation.
		expect(app.record.createdFolders).toEqual(["Projects", "Projects/2026"]);
		expect(app.record.fileManagerRename).toEqual([["Idea.md", "Projects/2026/Idea.md"]]);
	});

	it("refuses an occupied destination instead of trashing the occupant", async () => {
		const app = createVaultApp([
			{ kind: "file", path: "Source.md" },
			{ kind: "file", path: "Dest.md" },
		]);

		const error = await createMoveNoteTool(app.app)
			.execute("tool-call", { from: "Source.md", to: "Dest.md" })
			.then(() => null, asError);

		expect(error?.message).toBe(
			"Cannot move to Dest.md because a file or folder already exists there. Pick a different path, or trash the existing one first.",
		);
		// Pins the deliberate divergence from `VaultExecutionEnv.renameFile`, which
		// trashes the destination to satisfy pi's replace-on-rename contract.
		expect(app.record.trashed).toEqual([]);
		expect(app.record.fileManagerRename).toEqual([]);
		expect(app.paths()).toContain("Dest.md");
	});

	it("refuses to move a folder inside itself", async () => {
		const app = createVaultApp([{ kind: "folder", path: "Archive" }]);

		const error = await createMoveNoteTool(app.app)
			.execute("tool-call", { from: "Archive", to: "Archive/2026" })
			.then(() => null, asError);

		expect(error?.message).toBe("Cannot move folder Archive inside itself.");
		expect(app.record.fileManagerRename).toEqual([]);
	});

	it("treats a move onto the same path as a no-op", async () => {
		const app = createVaultApp([{ kind: "file", path: "Idea.md" }]);

		const result = await createMoveNoteTool(app.app).execute("tool-call", { from: "Idea.md", to: "./Idea.md" });

		expect(textOf(result)).toBe("Idea.md is already at that path; nothing to move.");
		expect(result.details).toMatchObject({ moved: false });
		// Without the guard the occupied-destination check would reject this, since
		// the source is its own destination.
		expect(app.record.fileManagerRename).toEqual([]);
	});

	it("falls back to vault.rename and warns that links were left behind", async () => {
		const app = createVaultApp([{ kind: "file", path: "Idea.md" }], { withFileManager: false });

		const result = await createMoveNoteTool(app.app).execute("tool-call", { from: "Idea.md", to: "Projects/Idea.md" });

		expect(app.record.vaultRename).toEqual([["Idea.md", "Projects/Idea.md"]]);
		expect(app.record.fileManagerRename).toEqual([]);
		expect(textOf(result)).toContain("Inbound links were not updated and may now be broken.");
		expect(result.details).toMatchObject({ moved: true, linksUpdated: false });
	});

	it("moves a folder with everything inside it", async () => {
		const app = createVaultApp([
			{ kind: "folder", path: "Inbox", children: ["Inbox/A.md"] },
			{ kind: "file", path: "Inbox/A.md" },
		]);

		const result = await createMoveNoteTool(app.app).execute("tool-call", { from: "Inbox", to: "Archive/Inbox" });

		expect(textOf(result)).toBe(
			"Moved folder Inbox to Archive/Inbox, with everything inside it. Obsidian's file manager handled the move.",
		);
		expect(result.details).toMatchObject({ kind: "folder", moved: true });
	});

	it("reports an answered confirmation without claiming which way links went", async () => {
		const app = createVaultApp([{ kind: "file", path: "Inbox/Idea.md" }], { modalDuringRename: true });

		const result = await createMoveNoteTool(app.app).execute("tool-call", { from: "Inbox/Idea.md", to: "Projects/Idea.md" });

		expect(textOf(result)).toBe(
			"Moved Inbox/Idea.md to Projects/Idea.md. Obsidian's link-update confirmation was answered; inbound links follow the answer that was given.",
		);
		// The core honesty rule: the tool never saw the answer, so `linksUpdated`
		// is null rather than a guess.
		expect(result.details).toMatchObject({ moved: true, linksUpdated: null, modalDismissed: false });
	});

	it("lists pathed backlinks when the vault API orphans them", async () => {
		const app = createVaultApp([{ kind: "file", path: "Idea.md" }], {
			withFileManager: false,
			// Obsidian's own nested shape: `Notes.md` links to `Idea.md` twice,
			// and (no `getCache` on this stub) the link is treated as pathed.
			resolvedLinks: { "Notes.md": { "Idea.md": 2 } },
		});

		const result = await createMoveNoteTool(app.app).execute("tool-call", { from: "Idea.md", to: "Projects/Idea.md" });

		expect(app.record.vaultRename).toEqual([["Idea.md", "Projects/Idea.md"]]);
		expect(textOf(result)).toContain("Inbound links were not updated and may now be broken.");
		// The dangling list is what lets the model repair the links; both the
		// text and the structured field must carry it.
		expect(result.details).toMatchObject({ moved: true, linksUpdated: false, unresolvedBacklinks: ["Notes.md"] });
	});

	it("rejects a missing source", async () => {
		const app = createVaultApp([]);

		const error = await createMoveNoteTool(app.app)
			.execute("tool-call", { from: "Ghost.md", to: "Projects/Ghost.md" })
			.then(() => null, asError);

		expect(error?.message).toBe("File or folder not found: Ghost.md");
	});

	it("refuses the vault root on either side", async () => {
		const app = createVaultApp([{ kind: "file", path: "Idea.md" }]);
		const tool = createMoveNoteTool(app.app);

		const fromRoot = await tool.execute("tool-call", { from: ".", to: "Idea.md" }).then(() => null, asError);
		const toRoot = await tool.execute("tool-call", { from: "Idea.md", to: "" }).then(() => null, asError);

		expect(fromRoot?.message).toBe("Cannot move the vault root.");
		expect(toRoot?.message).toBe("Cannot move to the vault root.");
	});
});

describe("trash_note", () => {
	it("sends a file to trash rather than deleting it", async () => {
		const app = createVaultApp([{ kind: "file", path: "Inbox/Old.md" }]);

		const result = await createTrashNoteTool(app.app).execute("tool-call", { path: "Inbox/Old.md" });

		// Recoverability is the plugin's whole answer to destructive tool calls, and
		// it comes from this API choice alone; `vault.delete` is permanent.
		expect(app.record.trashed).toEqual(["Inbox/Old.md"]);
		expect(app.record.deleted).toEqual([]);
		expect(textOf(result)).toBe("Moved Inbox/Old.md to trash. It can be restored from trash.");
		expect(result.details).toMatchObject({ path: "Inbox/Old.md", kind: "file", trashed: true });
	});

	it("refuses a non-empty folder without recursive", async () => {
		const app = createVaultApp([
			{ kind: "folder", path: "Archive", children: ["Archive/A.md"] },
			{ kind: "file", path: "Archive/A.md" },
		]);

		const error = await createTrashNoteTool(app.app).execute("tool-call", { path: "Archive" }).then(() => null, asError);

		expect(error?.message).toBe(
			"Archive is a folder and is not empty. Pass recursive: true to trash it and everything inside.",
		);
		// The blast-radius assertion: nothing may reach trash on a refusal.
		expect(app.record.trashed).toEqual([]);
	});

	it("trashes a non-empty folder in one call when recursive is set", async () => {
		const app = createVaultApp([
			{ kind: "folder", path: "Archive", children: ["Archive/A.md", "Archive/B.md"] },
			{ kind: "file", path: "Archive/A.md" },
			{ kind: "file", path: "Archive/B.md" },
		]);

		const result = await createTrashNoteTool(app.app).execute("tool-call", { path: "Archive", recursive: true });

		// One trashFile call on the folder, not one per child: Obsidian trashes the
		// subtree itself, and per-child iteration would half-delete on failure.
		expect(app.record.trashed).toEqual(["Archive"]);
		expect(textOf(result)).toBe("Moved folder Archive to trash, with everything inside it. It can be restored from trash.");
		expect(result.details).toMatchObject({ kind: "folder", trashed: true });
	});

	it("trashes an empty folder without requiring recursive", async () => {
		const app = createVaultApp([{ kind: "folder", path: "Empty" }]);

		const result = await createTrashNoteTool(app.app).execute("tool-call", { path: "Empty" });

		expect(app.record.trashed).toEqual(["Empty"]);
		expect(result.details).toMatchObject({ kind: "folder", trashed: true });
	});

	it("refuses the vault root however it is spelled", async () => {
		const app = createVaultApp([{ kind: "file", path: "Idea.md" }]);
		const tool = createTrashNoteTool(app.app);

		for (const path of ["", "."]) {
			const error = await tool.execute("tool-call", { path }).then(() => null, asError);
			// Without this check `getAbstractFileByPath("")` returns null in a real
			// vault, so "delete the whole vault" would answer with a not-found.
			expect(error?.message, `path ${JSON.stringify(path)} was not refused as the vault root`).toBe(
				"Refusing to trash the vault root.",
			);
		}
		expect(app.record.trashed).toEqual([]);
	});

	it("rejects a missing target instead of reporting success", async () => {
		const app = createVaultApp([]);

		const error = await createTrashNoteTool(app.app).execute("tool-call", { path: "Ghost.md" }).then(() => null, asError);

		expect(error?.message).toBe("File or folder not found: Ghost.md");
	});

	it("reports a permanent delete as unrecoverable when fileManager is absent", async () => {
		const app = createVaultApp([{ kind: "file", path: "Old.md" }], { withFileManager: false });

		const result = await createTrashNoteTool(app.app).execute("tool-call", { path: "Old.md" });

		expect(app.record.deleted).toEqual(["Old.md"]);
		expect(app.record.trashed).toEqual([]);
		expect(textOf(result)).toContain("cannot be undone");
		expect(result.details).toMatchObject({ trashed: false });
	});
});

describe("path validation", () => {
	// Each escape is checked on every path parameter separately: normalizing only
	// `from` would let a move *into* the plugin's own folder through, and a
	// single-sided test would not notice.
	const cases = [
		{
			label: "plugin internals",
			// Built from `PLUGIN_ID` the way `path.ts` builds the check itself, so the
			// two cannot drift and no literal config path is hardcoded here.
			path: `.obsidian/plugins/${PLUGIN_ID}/data.json`,
			message: "Path points inside the Piem plugin internals.",
		},
		{ label: "parent traversal", path: "../outside.md", message: "Path must not contain '..' segments." },
		{ label: "absolute paths", path: "/etc/passwd", message: "Path must be vault-relative, not absolute." },
	];

	for (const { label, path, message } of cases) {
		it(`rejects ${label} on from, to, and trash path`, async () => {
			const app = createVaultApp([{ kind: "file", path: "Idea.md" }]);
			const move = createMoveNoteTool(app.app);

			const asFrom = await move.execute("tool-call", { from: path, to: "Idea2.md" }).then(() => null, asError);
			const asTo = await move.execute("tool-call", { from: "Idea.md", to: path }).then(() => null, asError);
			const asTrash = await createTrashNoteTool(app.app).execute("tool-call", { path }).then(() => null, asError);

			expect(asFrom?.message, "from was not validated").toBe(message);
			expect(asTo?.message, "to was not validated").toBe(message);
			expect(asTrash?.message, "trash path was not validated").toBe(message);
			expect(app.record.fileManagerRename).toEqual([]);
			expect(app.record.trashed).toEqual([]);
		});
	}
});

describe("abort handling", () => {
	it("rejects both tools before touching the vault", async () => {
		const app = createVaultApp([{ kind: "file", path: "Idea.md" }]);
		const controller = new AbortController();
		controller.abort();

		const move = await createMoveNoteTool(app.app)
			.execute("tool-call", { from: "Idea.md", to: "Moved.md" }, controller.signal)
			.then(() => null, asError);
		const trash = await createTrashNoteTool(app.app)
			.execute("tool-call", { path: "Idea.md" }, controller.signal)
			.then(() => null, asError);

		expect(move?.message).toBe("Operation aborted");
		expect(trash?.message).toBe("Operation aborted");
		expect(app.record.fileManagerRename).toEqual([]);
		expect(app.record.trashed).toEqual([]);
	});
});

interface VaultFixture {
	kind: "file" | "folder";
	path: string;
	/** Child paths, for folders whose emptiness the recursive guard reads. */
	children?: string[];
}

/**
 * Records which API each mutation went through.
 *
 * These tools' correctness lives in the API they pick, not in their output: a
 * `vault.rename` orphans every inbound link, and a `vault.delete` is permanent,
 * and both produce indistinguishable success text. Recording the call sites is
 * the only way a test can tell.
 */
interface MutationRecord {
	fileManagerRename: [string, string][];
	vaultRename: [string, string][];
	trashed: string[];
	deleted: string[];
	createdFolders: string[];
}

interface VaultApp {
	app: App;
	record: MutationRecord;
	paths: () => string[];
}

/**
 * Purpose-built app stub for these tools.
 *
 * Neither existing helper works here. `obsidianTools.test.ts`'s `createTaskApp`
 * resolves *every* unmatched path to a folder, so not-found is untestable.
 * `VaultExecutionEnv.test.ts`'s `MemoryVault` is not exported, and importing
 * across files that both call the process-global `mock.module` invites the
 * clobbering that `obsidianStub.ts` warns about.
 *
 * `withFileManager: false` models the edge-mobile builds where `fileManager`
 * is missing, which is the branch where recoverability ends. `resolvedLinks`
 * is a fragment of Obsidian's own nested map (`{source: {target: count}}`),
 * fed straight into `metadataCache` — the map the backlink read inverts. The
 * stub deliberately omits `getBacklinksForFile` (the fast path is a feature
 * probe, and a stub that answers it would need to model its whole shape), so
 * the scan runs — and the scan reads `resolvedLinks` unconditionally, which is
 * why a vault app carries `metadataCache` even when the fragment is empty.
 *
 * `modalDuringRename` mounts the link-update confirmation in the test DOM for
 * the duration of the rename: the guard sees it, the rename settles before the
 * grace window runs out, and the outcome is "answered" — the fast path to that
 * branch; the full dismissal path costs a real grace window and lives in
 * `linkUpdateConfirm.test.ts`.
 */
function createVaultApp(
	fixtures: VaultFixture[],
	options: { withFileManager?: boolean; resolvedLinks?: Record<string, Record<string, number>>; modalDuringRename?: boolean } = {},
): VaultApp {
	const record: MutationRecord = {
		fileManagerRename: [],
		vaultRename: [],
		trashed: [],
		deleted: [],
		createdFolders: [],
	};
	const entries = new Map<string, TAbstractFile>();
	for (const fixture of fixtures) {
		entries.set(fixture.path, fixture.kind === "file" ? makeFile(fixture.path) : makeFolder(fixture.path, fixture.children));
	}

	const move = (file: TAbstractFile, newPath: string): void => {
		entries.delete(file.path);
		file.path = newPath;
		entries.set(newPath, file);
	};

	const vault = {
		getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
		getFolderByPath: (path: string) => {
			const entry = entries.get(path);
			return entry instanceof TFolderClass ? entry : null;
		},
		createFolder: async (path: string) => {
			record.createdFolders.push(path);
			entries.set(path, makeFolder(path));
		},
		rename: async (file: TAbstractFile, newPath: string) => {
			// Mirrors the real API, which refuses an occupied destination — so a
			// tool that skipped its own check would fail here rather than silently
			// replacing a note.
			if (entries.has(newPath)) {
				throw new Error(`already exists: ${newPath}`);
			}
			record.vaultRename.push([file.path, newPath]);
			move(file, newPath);
		},
		delete: async (file: TAbstractFile) => {
			record.deleted.push(file.path);
			entries.delete(file.path);
		},
	};

	let modal: HTMLElement | null = null;
	const app = {
		vault,
		// `resolvedLinks` is the only member the backlink scan touches; an
		// unprobed member would throw mid-move rather than degrade.
		metadataCache: { resolvedLinks: options.resolvedLinks ?? {} },
		...(options.withFileManager === false
			? {}
			: {
					fileManager: {
						renameFile: async (file: TAbstractFile, newPath: string) => {
							if (entries.has(newPath)) {
								throw new Error(`already exists: ${newPath}`);
							}
							if (options.modalDuringRename) {
								modal = mountLinkUpdateModal(document);
							}
							// A modal the user answered is gone by the time the rename
							// settles; the guard's "answered" outcome rides on this gap.
							if (modal) {
								await sleep(60);
								modal.remove();
								modal = null;
							}
							record.fileManagerRename.push([file.path, newPath]);
							move(file, newPath);
						},
						trashFile: async (file: TAbstractFile) => {
							record.trashed.push(file.path);
							entries.delete(file.path);
						},
					},
				}),
	} as unknown as App;

	return { app, record, paths: () => [...entries.keys()] };
}

function makeFile(path: string): TFile {
	const file = new TFileClass();
	file.path = path;
	file.extension = path.split(".").pop() ?? "";
	return file;
}

function makeFolder(path: string, children: string[] = []): TFolder {
	const folder = new TFolderClass();
	folder.path = path;
	folder.children = children.map(makeFile);
	return folder;
}

function textOf(result: { content: { type: string }[] }): string {
	const block = result.content[0];
	if (block?.type !== "text") {
		throw new Error("Expected a text content block.");
	}
	return (block as { type: "text"; text: string }).text;
}

function asError(reason: unknown): Error | null {
	return reason instanceof Error ? reason : null;
}
