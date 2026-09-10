import type { Entry } from "@earendil-works/pi-agent-core";
import type { ObsidianSessionManager } from "../session/ObsidianSessionManager";

/** A synchronous Pi read view, refreshed from the existing Vault-backed lane. */
export function extensionSessionView(options: {
	sessions: ObsidianSessionManager;
	path: string;
	lane(): string;
	assertOwner(): void;
}) {
	let entries: Entry[] = [];
	let branch: Entry[] = [];
	let labels = new Map<string, string | undefined>();
	let revision = 0;
	let loadedSession: ReturnType<ObsidianSessionManager["getSessionFor"]> | undefined;
	let loadedLeaf: string | null | undefined;
	let loadedLane: string | undefined;
	let latestSeq: number | undefined;
	return {
		async refresh(): Promise<void> {
			options.assertOwner();
			const current = ++revision;
			const lane = options.lane();
			const session = options.sessions.getSessionFor(options.path);
			const sameSession = loadedSession === session;
			const changes = await session.getLog({ afterSeq: sameSession ? latestSeq : undefined });
			const leaf = await session.view(lane).getLeafId();
			options.assertOwner();
			if (current !== revision || lane !== options.lane()) return;
			if (sameSession && loadedLane === lane && loadedLeaf === leaf && changes.length === 0) return;
			const nextEntries = sameSession ? [...entries] : [];
			const nextLabels = sameSession ? new Map(labels) : new Map<string, string | undefined>();
			for (const item of changes) {
				if (item.kind === "entry") nextEntries.push(item.entry);
				if (item.kind === "fact" && item.fact === "label") nextLabels.set(item.targetId, item.label);
			}
			const nextBranch = await session.view(lane).findEntriesOnBranch({ order: "oldestFirst" });
			options.assertOwner();
			if (current !== revision || lane !== options.lane()) return;
			entries = nextEntries;
			branch = nextBranch;
			labels = nextLabels;
			loadedSession = session;
			loadedLeaf = leaf;
			loadedLane = lane;
			latestSeq = changes.at(-1)?.seq ?? (sameSession ? latestSeq : undefined);
		},
		getEntries: () => entries,
		getBranch: () => branch,
		getLabel: (id: string) => labels.get(id),
	};
}
