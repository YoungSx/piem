import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT, branchTip, insertEntry, setValue, type Write } from "@earendil-works/pi-agent-core";
import { prepareExtensionBoundary } from "../extensions/extensionBoundary";
import type { ExtensionBoundaryCallbacks } from "../extensions/extensionEvents";
import type { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { sanitizeMessageForLog } from "../vault/image";
import type { SessionRuntime } from "./SessionRuntime";

/** Translate Pi's synchronous extension drafts into the owning Vault session's writes. */
export function extensionBoundaryStorage(rt: SessionRuntime, sessions: ObsidianSessionManager, assertOwner: () => void): ExtensionBoundaryCallbacks {
	let ids: string[] = [];
	const prepare = async (drafts: SessionBoundaryDraft[]) => {
		assertOwner();
		const agent = rt.agent;
		const epoch = rt.stopEpoch;
		const lane = rt.activeLane;
		if (!agent) throw new Error("Extension boundary has no active agent.");
		if (rt.unpersistedMessages.size) throw new Error("Save the conversation before changing its context.");
		const session = sessions.getSessionFor(rt.sessionPath);
		const entries = await session.view(lane).findEntriesOnBranch({ order: "oldestFirst" });
		assertOwner();
		if (rt.agent !== agent || rt.stopEpoch !== epoch || rt.activeLane !== lane) throw new Error("Conversation changed during extension boundary.");
		while (ids.length < drafts.length) ids.push(session.idGenerator.next());
		return prepareExtensionBoundary({
			entries,
			messages: agent.state.messages,
			messageOrigins: agent.state.messages.map(message => rt.messageEntryIds.get(message) ?? null),
			pendingMessages: agent.peekQueuedMessages(),
		}, drafts, ids);
	};
	return {
		getMessageEntryId: message => rt.messageEntryIds.get(message),
		buildContext: async drafts => (await prepare(drafts)).context,
		commit: async drafts => {
			if (!drafts.length) { ids = []; return; }
			const agent = rt.agent!;
			const epoch = rt.stopEpoch;
			const lane = rt.activeLane;
			const prepared = await prepare(drafts);
			const session = sessions.getSessionFor(rt.sessionPath);
			const release = sessions.claimOperation(rt.sessionPath);
			try {
				await session.mutate(async mutation => {
					assertOwner();
					if (rt.stopEpoch !== epoch || rt.agent !== agent || rt.activeLane !== lane) throw new Error("Extension boundary was cancelled.");
					const tip = (await mutation.getValue(branchTip(lane), BACKGROUND_CONTEXT))?.value ?? null;
					if (tip !== prepared.entries[0]?.parentId) throw new Error("Conversation changed before boundary drafts were saved.");
					const writes: Write[] = prepared.entries.map(entry => {
						const { seq: _seq, timestamp: _timestamp, ...draft } = entry;
						if (draft.type === "message") draft.message = sanitizeMessageForLog(draft.message);
						if (draft.type === "compaction") draft.retainedTail = draft.retainedTail.map(sanitizeMessageForLog);
						return insertEntry(draft);
					});
					writes.push(setValue(branchTip(lane), prepared.entries.at(-1)!.id));
					assertOwner();
					if (rt.stopEpoch !== epoch || rt.agent !== agent || rt.activeLane !== lane) throw new Error("Extension boundary was cancelled.");
					await mutation.commit(writes, BACKGROUND_CONTEXT);
				}, BACKGROUND_CONTEXT);
				assertOwner();
				if (rt.agent !== agent || rt.activeLane !== lane) throw new Error("Extension boundary owner changed.");
				agent.state.messages = prepared.messages;
				prepared.messages.forEach((message, index) => {
					const id = prepared.messageOrigins[index];
					if (id) rt.messageEntryIds.set(message, id);
				});
				const compaction = [...prepared.entries].reverse().find(entry => entry.type === "compaction");
				if (compaction?.type === "compaction") {
					const conversation = prepared.messages.filter(message => message.role !== "system");
					// Retain live identity: the next compaction recognizes its already
					// summarized prefix by these exact message objects.
					rt.lastCompaction = { ...compaction, retainedTail: conversation.slice(1, 1 + compaction.retainedTail.length) };
					rt.compactionGate = "awaiting";
					for (const entry of prepared.entries) if (entry.type === "compaction" && entry.usage) rt.overheadUsage.push(entry.usage);
				}
				rt.sessionRevision++;
				// A Stop racing an atomic commit cannot undo durable history. Keep
				// the same agent in sync, then refuse continuation of the old turn.
				if (rt.stopEpoch !== epoch) throw new Error("Extension boundary was cancelled.");
			} finally {
				ids = [];
				release();
			}
		},
	};
}
