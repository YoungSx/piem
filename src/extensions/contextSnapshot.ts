import type { CustomEntry, Entry, LogItem, ProvisionedEntry } from "@earendil-works/pi-agent-core";

type DatedEntry<T extends Entry> = T extends Entry ? Omit<T, "timestamp" | "seq"> & { timestamp: string; seq?: number } : never;
/** The audited extension's read view, not a second CLI SessionManager. */
export type ContextEntry = DatedEntry<Entry> | {
	type: "custom_message";
	id: string;
	seq: number;
	parentId: string | null;
	timestamp: string;
	customType: string;
	content: unknown;
	display: boolean;
	details?: unknown;
};
export interface ContextTreeNode {
	entry: ContextEntry;
	children: ContextTreeNode[];
	label?: string;
}

/** A bounded read operation supplies one consistent log and lane head. */
export class ContextSnapshot {
	readonly sequence: number;
	private readonly entries = new Map<string, ContextEntry>();
	private readonly children = new Map<string | null, ContextEntry[]>();
	private readonly labels = new Map<string, string>();

	constructor(log: readonly LogItem[], public leafId: string | null) {
		this.sequence = log.at(-1)?.seq ?? 0;
		for (const item of log) {
			if (item.kind === "entry") {
				const entry = projectEntry(item.entry);
				this.entries.set(entry.id, entry);
				const siblings = this.children.get(entry.parentId) ?? [];
				siblings.push(entry);
				this.children.set(entry.parentId, siblings);
			} else if (item.kind === "fact" && item.fact === "label") {
				if (item.label) this.labels.set(item.targetId, item.label);
				else this.labels.delete(item.targetId);
			}
		}
		if (leafId !== null && !this.entries.has(leafId)) throw new Error("Context snapshot is missing its current entry.");
	}

	/** The id is reserved now; storage supplies its real sequence when flushed. */
	appendCustomEntry(entry: ProvisionedEntry<CustomEntry>): void {
		if (this.entries.has(entry.id)) return;
		const projected: ContextEntry = { ...structuredClone(entry), parentId: this.leafId, timestamp: new Date().toISOString() };
		this.entries.set(projected.id, projected);
		const siblings = this.children.get(projected.parentId) ?? [];
		siblings.push(projected);
		this.children.set(projected.parentId, siblings);
		this.leafId = projected.id;
	}

	getEntries(): ContextEntry[] { return [...this.entries.values()].map(entry => structuredClone(entry)); }
	getEntry(id: string): ContextEntry | undefined { return structuredClone(this.entries.get(id)); }
	getLabel(id: string): string | undefined { return this.labels.get(id); }
	getChildren(id: string): ContextEntry[] { return structuredClone(this.children.get(id) ?? []); }

	getBranch(fromId = this.leafId): ContextEntry[] {
		const entries: ContextEntry[] = [];
		const visited = new Set<string>();
		let id = fromId;
		while (id !== null) {
			if (visited.has(id)) throw new Error("Context history contains a cycle.");
			visited.add(id);
			const entry = this.entries.get(id);
			if (!entry) throw new Error(`Unknown context entry: ${id}`);
			entries.push(structuredClone(entry));
			id = entry.parentId;
		}
		return entries.reverse();
	}

	getTree(getLabel: (id: string) => string | undefined): ContextTreeNode[] {
		const nodes = new Map<string, ContextTreeNode>();
		const roots: ContextTreeNode[] = [];
		for (const entry of this.entries.values()) {
			const label = getLabel(entry.id);
			nodes.set(entry.id, { entry: structuredClone(entry), children: [], ...(label ? { label } : {}) });
		}
		for (const node of nodes.values()) {
			const parent = node.entry.parentId === null ? undefined : nodes.get(node.entry.parentId);
			if (parent && parent !== node) parent.children.push(node);
			else roots.push(node);
		}
		// Build and order iteratively: a long conversation must not consume the call stack.
		for (const node of nodes.values()) {
			node.children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
		}
		return roots;
	}
}

function projectEntry(entry: Entry): ContextEntry {
	const copy = structuredClone(entry);
	const timestamp = new Date(copy.timestamp).toISOString();
	// CLI stores custom messages as entries; core stores the same content as a
	// message role. Preserve the extension's rule that hidden messages stay hidden.
	if (copy.type === "message" && copy.message.role === "custom") {
		return {
			type: "custom_message", id: copy.id, seq: copy.seq, parentId: copy.parentId, timestamp,
			customType: copy.message.customType, content: copy.message.content, display: copy.message.display,
			...(copy.message.details === undefined ? {} : { details: copy.message.details }),
		};
	}
	return { ...copy, timestamp };
}
