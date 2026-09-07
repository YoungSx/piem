import { describe, expect, it } from "bun:test";
import type { App, EventRef, TFile } from "obsidian";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();

const { resolveWorkingNotePath, watchActiveNote } = await import("./activeNoteWatch");

/**
 * A workspace that actually dispatches, which the shared plugin-loader fake does
 * not: its `on` returns an empty object and its `trigger` is a no-op, so a
 * registration can be observed but never fired.
 */
class FakeWorkspace {
	private readonly handlers = new Map<string, Set<() => void>>();
	/** What `getActiveFile()` resolves to. */
	activeFile: { path: string; extension: string } | null = null;

	on(name: string, callback: () => void): EventRef {
		const existing = this.handlers.get(name) ?? new Set<() => void>();
		existing.add(callback);
		this.handlers.set(name, existing);
		return { name, callback } as unknown as EventRef;
	}

	trigger(name: string): void {
		for (const callback of this.handlers.get(name) ?? []) {
			callback();
		}
	}

	handlerCount(name: string): number {
		return this.handlers.get(name)?.size ?? 0;
	}

	getActiveFile(): TFile | null {
		return this.activeFile as TFile | null;
	}
}

class FakeVault {
	/**
	 * Rename carries the file and its old path; delete carries the file alone.
	 * Modelled as one signature with `oldPath` required and ignored by delete
	 * callers, which keeps the fake small without an `any`-typed dispatch table.
	 */
	private readonly handlers = new Map<string, Set<(file: { path: string }, oldPath: string) => void>>();
	/** The paths the vault index currently resolves; ghost tests deliberately leave them out. */
	readonly files = new Set<string>();

	getFileByPath(path: string): { path: string; extension: string } | null {
		return this.files.has(path) ? { path, extension: "md" } : null;
	}

	on(name: string, callback: (file: { path: string }, oldPath: string) => void): EventRef {
		const existing = this.handlers.get(name) ?? new Set<(file: { path: string }, oldPath: string) => void>();
		existing.add(callback);
		this.handlers.set(name, existing);
		return { name, callback } as unknown as EventRef;
	}

	trigger(name: string, file: { path: string }, oldPath = ""): void {
		for (const callback of this.handlers.get(name) ?? []) {
			callback(file, oldPath);
		}
	}
}

function createApp(): { app: App; workspace: FakeWorkspace; vault: FakeVault } {
	const workspace = new FakeWorkspace();
	const vault = new FakeVault();
	return { app: { workspace, vault } as unknown as App, workspace, vault };
}

function markdown(path: string): { path: string; extension: string } {
	return { path, extension: "md" };
}

/**
 * Seeds both the active file and the vault index, the way a real workspace has
 * them consistent before any event fires.
 */
function openNote(workspace: FakeWorkspace, vault: FakeVault, path: string): void {
	workspace.activeFile = markdown(path);
	vault.files.add(path);
}

describe("resolveWorkingNotePath", () => {
	it("reports the note the user is working in", () => {
		const { app, workspace, vault } = createApp();
		openNote(workspace, vault, "Notes/today.md");

		expect(resolveWorkingNotePath(app)).toBe("Notes/today.md");
	});

	it("keeps reporting the note while the chat panel holds focus", () => {
		const { app, workspace, vault } = createApp();
		// `getActiveFile` is documented to fall back to the most recently active file
		// when the focused view is not a FileView, which is exactly the chat panel.
		// Reading the focused *view* instead would return null here and send no
		// context at the one moment the feature exists for: the user typing
		// "rewrite this note" into the composer.
		openNote(workspace, vault, "Notes/today.md");

		expect(resolveWorkingNotePath(app)).toBe("Notes/today.md");
	});

	it("reports nothing when no file is open at all", () => {
		const { app } = createApp();

		expect(resolveWorkingNotePath(app)).toBeNull();
	});

	it("reports nothing for a file the note tools cannot read", () => {
		const { app, workspace } = createApp();
		workspace.activeFile = { path: "Attachments/scan.pdf", extension: "pdf" };

		// A PDF, an image, or a canvas injects nothing rather than a path the model
		// would try to `read` as Markdown.
		expect(resolveWorkingNotePath(app)).toBeNull();
	});

	it("reports nothing while the workspace still holds a just-deleted file", () => {
		const { app, workspace, vault } = createApp();
		openNote(workspace, vault, "Notes/doomed.md");
		vault.files.delete("Notes/doomed.md");

		// Measured on a real runtime: for the whole synchronous window of the vault
		// `"delete"` event the workspace keeps handing back the removed file's
		// TFile while the index has already dropped it. Reporting that ghost would
		// put a note in front of the model every `read` of which fails.
		expect(resolveWorkingNotePath(app)).toBeNull();
	});
});

describe("watchActiveNote", () => {
	it("subscribes to both events that can change the note", () => {
		const { app, workspace } = createApp();

		const refs = watchActiveNote(app, () => undefined);

		expect(refs).toHaveLength(2);
		expect(workspace.handlerCount("active-leaf-change")).toBe(1);
		// `active-leaf-change` does not fire when a file is swapped inside a leaf
		// that already holds focus, so `file-open` is not redundant.
		expect(workspace.handlerCount("file-open")).toBe(1);
	});

	it("reports the note when a leaf change fires", () => {
		const { app, workspace, vault } = createApp();
		const seen: (string | null)[] = [];
		watchActiveNote(app, (path) => seen.push(path));
		openNote(workspace, vault, "Notes/today.md");

		workspace.trigger("active-leaf-change");

		expect(seen).toEqual(["Notes/today.md"]);
	});

	it("reports the note when a file is opened in place", () => {
		const { app, workspace, vault } = createApp();
		const seen: (string | null)[] = [];
		watchActiveNote(app, (path) => seen.push(path));
		openNote(workspace, vault, "Notes/other.md");

		workspace.trigger("file-open");

		expect(seen).toEqual(["Notes/other.md"]);
	});

	it("clears the note when the last file is closed", () => {
		const { app, workspace, vault } = createApp();
		const seen: (string | null)[] = [];
		watchActiveNote(app, (path) => seen.push(path));

		openNote(workspace, vault, "Notes/today.md");
		workspace.trigger("active-leaf-change");
		workspace.activeFile = null;
		vault.files.delete("Notes/today.md");
		workspace.trigger("active-leaf-change");

		expect(seen).toEqual(["Notes/today.md", null]);
	});

	it("re-reads the workspace on every event rather than trusting the payload", () => {
		const { app, workspace, vault } = createApp();
		const seen: (string | null)[] = [];
		watchActiveNote(app, (path) => seen.push(path));

		openNote(workspace, vault, "Notes/a.md");
		workspace.trigger("active-leaf-change");
		openNote(workspace, vault, "Notes/b.md");
		workspace.trigger("active-leaf-change");

		// The callback fires for every leaf, this panel's own included, so its
		// argument cannot be trusted to describe the note in question.
		expect(seen).toEqual(["Notes/a.md", "Notes/b.md"]);
	});

	it("does not report anything before an event fires", () => {
		const { app, workspace } = createApp();
		const seen: (string | null)[] = [];
		workspace.activeFile = markdown("Notes/today.md");

		watchActiveNote(app, (path) => seen.push(path));

		// Seeding the current note is the caller's job, so a consumer that wants
		// only changes is not forced to filter a synthetic first call.
		expect(seen).toEqual([]);
	});

	it("keeps context paths aligned with vault renames and deletions", () => {		const { app, vault, workspace } = createApp();
		const renamed: string[] = [];
		const deleted: string[] = [];
		watchActiveNote(app, () => undefined, (oldPath, newPath) => renamed.push(`${oldPath}->${newPath}`), (path) => deleted.push(path));

		vault.trigger("rename", { path: "Archive/team" }, "Notes/team");
		vault.trigger("delete", { path: "Archive/team" });

		expect(renamed).toEqual(["Notes/team->Archive/team"]);
		expect(deleted).toEqual(["Archive/team"]);
		expect(workspace.handlerCount("active-leaf-change")).toBe(1);
	});

	it("does not resurrect the deleted note as the working note", () => {
		// The real delete sequence: `onDelete` forgets the path, then `publish`
		// re-resolves. On a real runtime the workspace still reports the removed
		// file in that window, so without the index re-check the forget is undone
		// by the very next line — the ghost rides along to the next freeze and
		// every `read` of it fails.
		const { app, vault, workspace } = createApp();
		const seen: (string | null)[] = [];
		openNote(workspace, vault, "Notes/doomed.md");
		watchActiveNote(app, (path) => seen.push(path), undefined, () => undefined);

		vault.files.delete("Notes/doomed.md");
		vault.trigger("delete", { path: "Notes/doomed.md" });

		expect(seen).toEqual([null]);
	});
});
