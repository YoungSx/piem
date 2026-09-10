import type { Session } from "@earendil-works/pi-agent-core";
import { ContextSnapshot } from "./contextSnapshot";

export interface ContextNavigation {
	/** Reserved by this authoritative Session's id generator; not yet persisted. */
	summaryEntryId: string;
	targetId: string | null;
	fromId: string;
	expectedLeafId: string | null;
	checkpointSeq: number;
	summary: string;
	lane: string;
}
export interface ContextSessionSource {
	/** Return the captured chat's existing Session after pending messages are saved. */
	load(): Promise<Session>;
	/** Check owner identity, disposal and the operation's captured stop epoch. */
	assertAvailable(session?: Session): void;
	/** Persist the navigation and rebuild that chat's Agent before resolving. */
	navigate(request: ContextNavigation, session: Session): Promise<void>;
}

/**
 * The CLI extension reads synchronously; Vault storage commits asynchronously.
 * Refresh before tools/events and flush before their success leaves the host.
 * Only a navigation plan exists between branchWithSummary and navigateTree;
 * durable reads never pretend that plan has already changed the user's history.
 */
export class ContextSession {
	private session?: Session;
	private snapshot?: ContextSnapshot;
	private readonly labels = new Map<string, string | undefined>();
	private navigation?: ContextNavigation;
	private tail: Promise<unknown> = Promise.resolve();
	private disposed = false;
	private epoch = 0;

	constructor(private readonly source: ContextSessionSource, private readonly lane = "main") {}

	refresh(): Promise<void> {
		return this.enqueue(async epoch => {
			if (this.labels.size || this.navigation) throw new Error("Context changes must settle before refreshing history.");
			this.snapshot = undefined;
			const session = await this.source.load();
			this.assertActive(epoch, session);
			await this.readSnapshot(session, epoch);
		});
	}

	getEntries() { return this.current().getEntries(); }
	getEntry(id: string) { return this.current().getEntry(id); }
	getBranch(fromId?: string) { return this.current().getBranch(fromId); }
	getLeafId() { return this.current().leafId; }
	getChildren(id: string) { return this.current().getChildren(id); }
	getTree() { return this.current().getTree(id => this.getLabel(id)); }
	getLabel(id: string): string | undefined {
		const snapshot = this.current();
		return this.labels.has(id) ? this.labels.get(id) : snapshot.getLabel(id);
	}

	setLabel(id: string, label: string | undefined): void {
		const snapshot = this.current();
		if (!snapshot.getEntry(id)) throw new Error(`Unknown context entry: ${id}`);
		if (label !== undefined && (!label.trim() || label.length > 160)) throw new Error("Checkpoint names must contain 1–160 characters.");
		if (!this.labels.has(id) && this.labels.size >= 16) throw new Error("Too many checkpoint changes in one operation.");
		this.labels.set(id, label);
	}

	flush(): Promise<void> {
		return this.enqueue(async epoch => {
			if (!this.labels.size) return;
			this.current();
			const session = this.session!;
			const labels = [...this.labels];
			this.labels.clear();
			try {
				for (const [id, label] of labels) {
					this.assertActive(epoch, session);
					await session.setLabel(id, label);
					this.assertActive(epoch, session);
				}
				if (labels.length) await this.readSnapshot(session, epoch);
			} catch (error) {
				// The next operation must reload disk. An in-flight write may have
				// committed even if its owner was stopped while Vault was saving.
				this.snapshot = undefined;
				throw error;
			}
		});
	}

	branchWithSummary(targetId: string | null, summary: string): string {
		const snapshot = this.current();
		if (this.navigation) throw new Error("A context navigation is already pending.");
		if (targetId !== null && !snapshot.getEntry(targetId)) throw new Error(`Unknown context entry: ${targetId}`);
		if (!summary.trim() || summary.length > 128_000) throw new Error("A handoff summary must contain 1–128000 characters.");
		if (this.labels.size) throw new Error("Checkpoint changes must be saved before navigation.");
		const summaryEntryId = this.session!.idGenerator.next();
		this.navigation = {
			summaryEntryId, targetId, fromId: snapshot.leafId ?? "root", expectedLeafId: snapshot.leafId,
			checkpointSeq: snapshot.sequence, summary, lane: this.lane,
		};
		return summaryEntryId;
	}

	/** The upstream reset is part of its pending navigation, never a separate Vault write. */
	branch(targetId: string): void {
		this.current();
		if (!this.navigation || this.navigation.targetId !== targetId) throw new Error("Only the pending context branch can be selected.");
	}

	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }> {
		return this.enqueue(async epoch => {
			this.current();
			const request = this.navigation;
			if (!request || request.summaryEntryId !== targetId || options?.summarize !== false) {
				throw new Error("Only the prepared handoff summary can be selected.");
			}
			this.navigation = undefined;
			const session = this.session!;
			try {
				const leaf = await session.view(this.lane).getLeafId();
				this.assertActive(epoch, session);
				if (leaf !== request.expectedLeafId) throw new Error("Conversation changed before context navigation.");
				await this.source.navigate(structuredClone(request), session);
				this.assertActive(epoch, session);
				await this.readSnapshot(session, epoch);
				if (this.snapshot!.leafId !== targetId) throw new Error("Context navigation did not persist its summary.");
				return { cancelled: false };
			} catch (error) {
				this.snapshot = undefined;
				throw error;
			}
		});
	}

	/** Stop invalidates queued work; already-started writes are still awaited by settled(). */
	cancel(): void {
		this.epoch += 1;
		this.labels.clear();
		this.navigation = undefined;
		this.snapshot = undefined;
	}
	dispose(): void { this.disposed = true; this.cancel(); }
	async settled(): Promise<void> { await this.tail; }

	private current(): ContextSnapshot {
		this.assertActive(this.epoch, this.session);
		if (!this.snapshot) throw new Error("Context history must be refreshed before use.");
		return this.snapshot;
	}
	private assertActive(epoch: number, session?: Session): void {
		if (this.disposed) throw new Error("Context session was disposed.");
		if (epoch !== this.epoch) throw new Error("Context operation was cancelled.");
		this.source.assertAvailable(session);
	}
	private enqueue<T>(work: (epoch: number) => Promise<T>): Promise<T> {
		const epoch = this.epoch;
		const task = this.tail.then(() => { this.assertActive(epoch); return work(epoch); });
		this.tail = task.catch(() => undefined);
		return task;
	}
	private async readSnapshot(session: Session, epoch: number): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			this.assertActive(epoch, session);
			const log = await session.getLog();
			this.assertActive(epoch, session);
			const leaf = await session.view(this.lane).getLeafId();
			this.assertActive(epoch, session);
			// Log entries omit their lane. Read the real pointer and verify no
			// mutation arrived between those reads instead of guessing from ids.
			const newer = await session.getLog({ afterSeq: log.at(-1)?.seq ?? 0, limit: 1 });
			this.assertActive(epoch, session);
			if (newer.length) continue;
			this.snapshot = new ContextSnapshot(log, leaf);
			this.session = session;
			return;
		}
		throw new Error("Conversation changed while reading context history.");
	}
}
