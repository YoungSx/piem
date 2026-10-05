import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	defineDoc, defineTask, type ConversationId, type Harness, type Registry, type Session,
	type TaskId, type TaskOutcome, type TaskRuntime, type Tx,
} from "@earendil-works/pi-durable";
import { sanitizeMessageForLog } from "../vault/image";
import type { Entry } from "./sessionTypes";

type Input = { promptIds: string[]; tip: string | null };
type Checkpoint = { phase: "execute"; tip: string | null };
type Runtime = TaskRuntime<Input, Checkpoint, null, object>;
export type ExecutionSnapshot = { input: Input; checkpoint: Checkpoint; metadata: JsonValue };
// The frozen context is written once, not copied into every task transition.
const RunContext = defineDoc<{ value: JsonValue }>({
	kind: "piem.run-context", version: 1, scope: "task", initial: () => ({ value: null }),
});
const ExecutionDoc = defineDoc<{ taskId: TaskId<null> | null }>({
	kind: "piem.execution", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ taskId: null }),
});

/** Portable checkpoints use transcript UUIDs; Pi's numeric task IDs are rebuilt. */
export async function snapshotExecution(session: Session, conversationId: ConversationId): Promise<ExecutionSnapshot | undefined> {
	const pointer = await session.snapshot(ExecutionDoc, conversationId, BACKGROUND_CONTEXT);
	if (pointer?.taskId == null) return undefined;
	const task = await session.commit(tx => tx.task(pointer.taskId!), BACKGROUND_CONTEXT);
	if (!task || task.abortRequested || task.state.status === "terminal" || task.state.status === "completing") return undefined;
	const context = await session.snapshot(RunContext, task.id, BACKGROUND_CONTEXT);
	return { input: task.input as Input, checkpoint: task.state.checkpoint as Checkpoint, metadata: context?.value ?? null };
}

export async function restoreExecution(session: Session, conversationId: ConversationId, snapshot: ExecutionSnapshot): Promise<void> {
	const placeholder = defineTask<Input, Checkpoint, null>({
		name: `piem.run.${conversationId}`, version: 1, initial: () => snapshot.checkpoint,
		phases: { execute: async () => { throw new Error("Execution host is not attached"); } },
		abort: async () => { throw new Error("Execution host is not attached"); },
	});
	await session.commit(async tx => {
		const pointer = await tx.doc(ExecutionDoc, conversationId);
		pointer.taskId = await tx.createTask(placeholder, snapshot.input, { ownership: { kind: "conversation" }, conversationId });
		(await tx.doc(RunContext, pointer.taskId)).value = snapshot.metadata;
	}, BACKGROUND_CONTEXT);
}

/** One conversation's durable run; Pi owns reservation, cancellation and recovery. */
export class SessionExecution {
	private runtime?: Runtime;
	private busy = false;
	private readonly saved = new WeakMap<object, string>();

	constructor(
		private readonly harness: Harness,
		private readonly registry: Registry,
		private readonly conversationId: ConversationId,
		private readonly append: (tx: Tx, drafts: Array<{ type: string; [key: string]: unknown }>) => Promise<Entry[]>,
		private readonly lastMessageId: () => Promise<string | null>,
		private readonly onFailure: (listener: (error: unknown) => void) => () => void,
	) {}

	private async pending() {
		const pointer = await this.harness.snapshot(ExecutionDoc, this.conversationId, BACKGROUND_CONTEXT);
		const task = pointer?.taskId == null ? undefined : await this.harness.getTask(pointer.taskId, BACKGROUND_CONTEXT);
		return task && task.state.status !== "terminal" && task.state.status !== "completing" ? task : undefined;
	}

	async hasPending(): Promise<boolean> {
		const snapshot = await snapshotExecution(this.harness, this.conversationId);
		return !!snapshot && snapshot.checkpoint.tip === await this.lastMessageId();
	}

	/** Closing the host preserves pending checkpoints; it is not a user abort. */
	async close(): Promise<void> { await this.harness.close(BACKGROUND_CONTEXT); }

	/** Messages and their execution checkpoint cross the storage boundary together. */
	async persist(message: AgentMessage, logged = sanitizeMessageForLog(message)): Promise<string | undefined> {
		const saved = this.saved.get(message);
		if (saved) return saved;
		const runtime = this.runtime;
		if (!runtime) return undefined;
		let id: string | undefined;
		await runtime.commit(async (tx) => {
			id = (await this.append(tx, [{ type: "message", message: logged }]))[0]!.id;
			return { status: "running", checkpoint: { phase: "execute", tip: id } };
		}, BACKGROUND_CONTEXT);
		this.saved.set(message, id!);
		return id;
	}

	/**
	 * Install executable code only while its owning agent is attached. Reopening
	 * storage alone never executes a stale host closure or starts a model request.
	 */
	async run(options: {
		messages?: AgentMessage[];
		metadata: JsonValue;
		signal: AbortSignal;
		resume: boolean;
		admitted?(ids: readonly string[]): void;
		drive(recovered: boolean, metadata: JsonValue, signal: AbortSignal): Promise<TaskOutcome<null>>;
	}): Promise<void> {
		if (this.busy) throw new Error("Conversation is already executing");
		this.busy = true;
		const name = `piem.run.${this.conversationId}`;
		let aborting: Promise<unknown> | undefined;
		let cancel: (() => void) | undefined;
		const failure = new AbortController();
		// Pi reports a failed scheduler write without settling its durable task.
		// Release this waiter so the host can reconcile storage instead of hanging.
		const stopReporting = this.onFailure(error => failure.abort(error));
		try {
			options.signal.throwIfAborted();
			const pending = await this.pending();
			const recovered = options.resume && !!pending && await this.hasPending();
			const definition = defineTask<Input, Checkpoint, null>({
				name, version: 1,
				initial: input => ({ phase: "execute", tip: input.tip }),
				phases: {
					execute: async (_task, runtime, context) => {
						this.runtime = runtime;
						try {
							const savedContext = await runtime.snapshot(RunContext, runtime.taskId, context);
							const outcome = await options.drive(recovered, savedContext?.value ?? null, runtime.signal);
							await runtime.commit(() => ({ status: "terminal", outcome }), context);
						} finally { this.runtime = undefined; }
					},
				},
				abort: async (_task, runtime, context) => {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
				},
			});
			let taskId: TaskId<null>;
			if (recovered) {
				taskId = pending.id;
			} else {
				// A fresh prompt supersedes the previous interrupted intent. With its
				// code detached, Pi settles it as orphaned without replaying anything.
				if (pending) await this.harness.abortTask(pending.id, BACKGROUND_CONTEXT);
				options.signal.throwIfAborted();
				const messages = options.messages ?? [];
				const previousTip = await this.lastMessageId();
				const admitted = await this.harness.commit(async tx => {
					const pointer = await tx.doc(ExecutionDoc, this.conversationId);
					const entries = await this.append(tx, messages.map(message => ({ type: "message", message: sanitizeMessageForLog(message) })));
					const id = await tx.createTask(definition, { promptIds: entries.map(entry => entry.id), tip: entries.at(-1)?.id ?? previousTip }, {
						ownership: { kind: "conversation" }, conversationId: this.conversationId,
					});
					pointer.taskId = id;
					(await tx.doc(RunContext, id)).value = options.metadata;
					return { id, entries };
				}, BACKGROUND_CONTEXT);
				taskId = admitted.id;
				messages.forEach((message, index) => this.saved.set(message, admitted.entries[index]!.id));
				options.admitted?.(admitted.entries.map(entry => entry.id));
			}
			this.registry.install({ name, tasks: [definition] });
			cancel = () => {
				// A running Agent drains its abort events and stores the final
				// checkpoint. Before it starts, cancellation belongs to the scheduler.
				if (this.runtime) return;
				aborting = this.harness.abortTask(taskId, BACKGROUND_CONTEXT);
				void aborting.catch(() => undefined);
			};
			options.signal.addEventListener("abort", cancel, { once: true });
			if (options.signal.aborted) cancel();
			const settled = await this.harness.waitForTask(taskId, withAbortSignal(failure.signal, BACKGROUND_CONTEXT));
			await aborting;
			const outcome = settled.state.outcome;
			if (outcome.status === "faulted" || outcome.status === "failed") throw new Error(outcome.error.message);
			if (outcome.status === "orphaned") throw new Error(outcome.reason);
		} finally {
			stopReporting();
			if (cancel) options.signal.removeEventListener("abort", cancel);
			this.registry.uninstall({ name });
			this.busy = false;
		}
	}

	/** A missing result is uncertainty, never permission to repeat a side effect. */
	async recoverMessages(history: readonly AgentMessage[]): Promise<AgentMessage[]> {
		const messages = [...history];
		const results = new Set(messages.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []));
		for (const message of [...messages].reverse()) {
			if (message.role === "user") break;
			if (message.role !== "assistant") continue;
			for (const call of message.content) {
				if (call.type !== "toolCall" || results.has(call.id)) continue;
				const interrupted: AgentMessage = {
					role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true,
					content: [{ type: "text", text: "Execution was interrupted before its result was saved. The operation may already have taken effect. Inspect the current state before deciding whether to retry." }],
					timestamp: Date.now(),
				};
				await this.persist(interrupted);
				messages.push(interrupted);
				results.add(call.id);
			}
			break;
		}
		return messages;
	}
}
