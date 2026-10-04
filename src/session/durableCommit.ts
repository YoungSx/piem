import type { Storage, StorageWrite, ConversationId, EntryId, TaskId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;
const optionalId = (value: unknown): boolean => value === undefined || id(value);

/** Validate the Piem wire envelope before Pi validates and applies the transaction. */
export function parseDurableWrites(value: unknown): StorageWrite[] {
	if (!Array.isArray(value)) throw new Error("Invalid durable writes");
	for (const write of value) {
		if (!object(write) || !validWrite(write)) throw new Error("Invalid durable write");
	}
	return value as StorageWrite[];
}

function validWrite(write: Record<string, unknown>): boolean {
	const value = write.value;
	switch (write.type) {
		case "conversation":
			return object(value) && id(value.id)
				&& (value.parent === undefined || (object(value.parent) && id(value.parent.conversationId) && id(value.parent.at)))
				&& (value.owner === undefined || (object(value.owner) && id(value.owner.conversationId) && id(value.owner.taskId)));
		case "entry":
			return object(value) && id(value.id) && id(value.conversationId) && typeof value.kind === "string"
				&& optionalId(value.head) && optionalId(value.byTaskId)
				&& (value.model === undefined || Array.isArray(value.model))
				&& (value.edits === undefined || (Array.isArray(value.edits) && value.edits.every(edit => object(edit) && id(edit.target)
					&& (edit.action === "omit" || (edit.action === "replace" && Array.isArray(edit.messages))))));
		case "task":
			return object(value) && id(value.id) && id(value.conversationId) && typeof value.kind === "string"
				&& object(value.state) && ["pending", "running", "waiting", "completing", "terminal"].includes(String(value.state.status));
		case "submission":
			return object(value) && id(value.id) && id(value.conversationId) && ["input", "write"].includes(String(value.type))
				&& ["queued", "placed", "done", "unanswered"].includes(String(value.status)) && optionalId(value.entry) && optionalId(value.answer);
		case "document.create": {
			const record = write.record;
			return object(record) && id(record.id) && typeof record.kind === "string" && object(record.scope)
				&& (record.scope.kind === "session" || (record.scope.kind === "conversation" && id(record.scope.conversationId))
					|| (record.scope.kind === "task" && id(record.scope.taskId)))
				&& documentContent(write.content) && write.content.kind === "base";
		}
		case "document.change": return id(write.id) && documentContent(write.content);
		case "document.retire": return id(write.id);
		// prepareCommit resolves document.copy to document.create before encoding.
		default: return false;
	}
}

function documentContent(value: unknown): value is Record<string, unknown> {
	return object(value) && id(value.version)
		&& ((value.kind === "base" && object(value.value)) || (value.kind === "delta" && Array.isArray(value.ops)));
}

/** MemoryStorage trusts Session's references; a file arriving from disk cannot. */
export async function validateDurableReferences(writes: StorageWrite[], storage: Storage): Promise<void> {
	const conversations = new Set(writes.flatMap(write => write.type === "conversation" ? [write.value.id] : []));
	const entries = new Set(writes.flatMap(write => write.type === "entry" ? [write.value.id] : []));
	const tasks = new Set<TaskId>(writes.flatMap(write => write.type === "task" ? [write.value.id] : []));
	const conversation = async (id: ConversationId) => conversations.has(id) || !!await storage.conversation(id, BACKGROUND_CONTEXT);
	const entry = async (id: EntryId) => entries.has(id) || !!await storage.entry(id, BACKGROUND_CONTEXT);
	const task = async (id: TaskId) => tasks.has(id) || !!await storage.task(id, BACKGROUND_CONTEXT);
	for (const write of writes) {
		let valid = true;
		if (write.type === "conversation") {
			if (write.value.parent) valid &&= await conversation(write.value.parent.conversationId) && await entry(write.value.parent.at);
			if (write.value.owner) valid &&= await conversation(write.value.owner.conversationId) && await task(write.value.owner.taskId);
		} else if (write.type === "entry") {
			valid = await conversation(write.value.conversationId);
			if (write.value.head !== undefined) valid &&= await entry(write.value.head);
			if (write.value.byTaskId !== undefined) valid &&= await task(write.value.byTaskId);
			for (const edit of write.value.edits ?? []) valid &&= await entry(edit.target);
		} else if (write.type === "task") {
			valid = await conversation(write.value.conversationId);
			if (write.value.owner !== undefined) valid &&= await task(write.value.owner);
			if (write.value.state.status === "waiting") for (const id of write.value.state.on) valid &&= await task(id);
		} else if (write.type === "submission") {
			valid = await conversation(write.value.conversationId);
			if (write.value.entry !== undefined) valid &&= await entry(write.value.entry);
			if (write.value.answer !== undefined) valid &&= await entry(write.value.answer);
		} else if (write.type === "document.create") {
			const scope = write.record.scope;
			if (scope.kind === "conversation") valid = await conversation(scope.conversationId);
			if (scope.kind === "task") valid = await task(scope.taskId);
		}
		if (!valid) throw new Error("Dangling reference in durable commit");
	}
}
