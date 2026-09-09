import type { Entry, Session } from "@earendil-works/pi-agent-core";
import { createOfficialBookmark, type BookmarkEntry } from "./officialBookmark";

export type BookmarkCommand = "bookmark" | "unbookmark";
export interface ChatBookmark {
	entryId: string;
	label: string;
	text: string;
	truncated?: boolean;
}
export interface BookmarkOutcome {
	changed: boolean;
	label?: string;
	kind: "saved" | "removed" | "no-message" | "none";
}
export interface BookmarkHostSource {
	/** Reconcile and return the existing authoritative session, never a shadow CLI session. */
	load(): Promise<Session>;
	/** Checks lifetime and any operation that could change/delete this session. */
	assertAvailable(session?: Session): void;
}

export class BookmarkHost {
	private tail: Promise<unknown> = Promise.resolve();
	private disposed = false;
	private official?: Awaited<ReturnType<typeof createOfficialBookmark>>;
	private entries: BookmarkEntry[] = [];
	private labels = new Map<string, string>();
	private mutations: Array<{ id: string; label: string | undefined }> = [];
	private inCommand = false;
	constructor(private readonly source: BookmarkHostSource) {}

	run(name: BookmarkCommand, text = ""): Promise<BookmarkOutcome> {
		return this.enqueue(async () => {
			const label = text.trim();
			if (name === "bookmark" && (!label || label.length > 160)) throw new Error("Bookmark label must contain 1–160 characters.");
			const session = await this.source.load();
			this.assertActive();
			await this.refresh(session);
			this.assertActive();
			if (!this.official) {
				const official = await createOfficialBookmark({
					getEntries: () => this.entries.map(entry => ({ ...entry, ...(entry.message ? { message: { ...entry.message } } : {}) })),
					getLabel: id => this.labels.get(id),
					setLabel: (id, label) => {
						this.assertActive();
						if (!this.inCommand) throw new Error("Bookmark action escaped its command.");
						this.mutations.push({ id, label });
					},
					// UI reports a localized structured outcome only after its write has settled.
					notify: () => { this.assertActive(); },
				});
				if (this.disposed) { official.dispose(); this.assertActive(); }
				this.official = official;
			}
			this.mutations = [];
			this.inCommand = true;
			try {
				await this.official.run(name, label);
				this.assertActive();
				if (this.mutations.length > 1) throw new Error("Unexpected multiple writes from the official bookmark command.");
				const mutation = this.mutations[0];
				if (!mutation) return { changed: false, kind: name === "bookmark" ? "no-message" : "none" };
				this.assertActive(session);
				await session.setLabel(mutation.id, mutation.label);
				// Cancellation may arrive while Vault is writing. Never claim the completed write
				// was rolled back; suppress UI after disposal and let a future host read the log.
				this.assertActive();
				return { changed: true, kind: name === "bookmark" ? "saved" : "removed", label: mutation.label };
			} finally {
				this.inCommand = false;
				this.mutations = [];
				this.entries = [];
				this.labels.clear();
			}
		});
	}

	list(): Promise<ChatBookmark[]> {
		return this.enqueue(async () => {
			const session = await this.source.load();
			this.assertActive();
			const log = await session.getLog();
			this.assertActive();
			const labels = labelsFromLog(log);
			return log.filter((item): item is Extract<typeof item, { kind: "entry" }> => item.kind === "entry")
				.filter(item => labels.has(item.entry.id))
				.map(item => {
					const text = entryText(item.entry);
					return { entryId: item.entry.id, label: labels.get(item.entry.id)!, text: text.slice(0, 4000), ...(text.length > 4000 ? { truncated: true } : {}) };
				})
				.reverse();
		});
	}

	/** Called before deleting or reconciling a session. No detached writer survives the wait. */
	async settled(): Promise<void> { await this.tail; }
	dispose(): void {
		this.disposed = true;
		this.official?.dispose();
		this.official = undefined;
		this.entries = [];
		this.labels.clear();
	}
	private async refresh(session: Session): Promise<void> {
		const log = await session.getLog();
		this.assertActive();
		this.entries = log.filter((item): item is Extract<typeof item, { kind: "entry" }> => item.kind === "entry")
			.map(({ entry }) => ({ id: entry.id, type: entry.type, ...(entry.type === "message" ? { message: { role: entry.message.role } } : {}) }));
		this.labels = labelsFromLog(log);
	}
	private assertActive(session?: Session): void {
		if (this.disposed) throw new Error("Bookmark host was disposed.");
		this.source.assertAvailable(session);
	}
	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const task = this.tail.then(() => { this.assertActive(); return work(); });
		this.tail = task.catch(() => undefined);
		return task;
	}
}

function labelsFromLog(log: Awaited<ReturnType<Session["getLog"]>>): Map<string, string> {
	const labels = new Map<string, string>();
	for (const item of log) {
		if (item.kind === "fact" && item.fact === "label") {
			if (item.label) labels.set(item.targetId, item.label);
			else labels.delete(item.targetId);
		}
	}
	return labels;
}
function entryText(entry: Entry): string {
	if (entry.type !== "message" || !("content" in entry.message)) return "";
	const content = entry.message.content;
	return (typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n"));
}
