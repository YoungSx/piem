import type { JsonValue } from "@earendil-works/chord";
import { Agent, type AgentMessage, type AgentOptions } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionExecution } from "../session/SessionExecution";
import { conversationMessages, replaceConversation } from "./transcript";

/** Pi's existing loop and extension hooks, scheduled as one durable Harness task. */
export class DurableAgent extends Agent {
	private execution?: SessionExecution;
	private work?: Promise<void>;
	private controller?: AbortController;
	private persistenceError?: Error;

	constructor(options: AgentOptions, private readonly durable: {
		open(): Promise<SessionExecution>;
		capture?(): JsonValue;
		restore?(metadata: JsonValue): void;
		admitted?(message: AgentMessage, id: string): void;
		operationId?(): string | undefined;
	}) { super(options); }

	override prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	override prompt(input: string, images?: ImageContent[]): Promise<void>;
	override prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		const messages: AgentMessage[] = typeof input === "string"
			? [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }]
			: Array.isArray(input) ? input : [input];
		return this.run(false, messages);
	}

	override continue(): Promise<void> { return this.run(true); }
	override abort(): void { this.controller?.abort(); super.abort(); }
	override get signal(): AbortSignal | undefined { return super.signal ?? this.controller?.signal; }
	async suspend(): Promise<void> {
		// Seal the current host, including an execution still being opened.
		// Only user Stop writes cancellation; unload preserves its checkpoint.
		const closing = (this.execution ?? await this.durable.open()).close();
		super.abort();
		await closing;
		await this.waitForIdle();
	}
	override async waitForIdle(): Promise<void> {
		await super.waitForIdle();
		// Like Agent.waitForIdle(), this observes settlement without replaying a
		// dispatch failure into every queued idle callback.
		await this.work?.catch(() => undefined);
	}

	async persistMessage(message: AgentMessage, logged: AgentMessage): Promise<string | undefined> {
		try { return await this.execution?.persist(message, logged); }
		catch (error) {
			this.persistenceError = error instanceof Error ? error : new Error(String(error));
			// A failed checkpoint must stop before a subsequent tool or request.
			super.abort();
			throw error;
		}
	}

	private run(resume: boolean, messages?: AgentMessage[]): Promise<void> {
		if (this.work) return Promise.reject(new Error("Agent is already processing"));
		const controller = new AbortController();
		this.controller = controller;
		this.persistenceError = undefined;
		const work = this.execute(resume, messages, controller.signal);
		this.work = work.finally(() => {
			this.work = undefined;
			this.controller = undefined;
		});
		return this.work;
	}

	private async execute(resume: boolean, messages: AgentMessage[] | undefined, signal: AbortSignal): Promise<void> {
		this.execution = undefined;
		this.execution = await this.durable.open();
		let admitted = false;
		let started = false;
		try {
			await this.execution.run({
				messages, resume, signal, metadata: this.durable.capture?.() ?? null, operationId: this.durable.operationId?.(),
				admitted: ids => {
					admitted = true;
					messages?.forEach((message, index) => this.durable.admitted?.(message, ids[index]!));
				},
				drive: async (recovered, metadata, taskSignal) => {
					const abort = () => super.abort();
					taskSignal.addEventListener("abort", abort, { once: true });
					try {
						signal.throwIfAborted();
						taskSignal.throwIfAborted();
						if (recovered) {
							this.durable.restore?.(metadata);
							replaceConversation(this, await this.execution!.recoverMessages(conversationMessages(this.state.messages)));
						}
						if (messages) { started = true; await super.prompt(messages); }
						else if (!recovered || this.state.messages.at(-1)?.role !== "assistant") await super.continue();
						if (this.persistenceError) throw this.persistenceError;
						const last = [...this.state.messages].reverse().find(message => message.role === "assistant");
						if (signal.aborted || last?.stopReason === "aborted") return { status: "aborted" };
						if (last?.stopReason === "error") return { status: "failed", error: { message: last.errorMessage ?? "Provider error" } };
						return { status: "completed", result: null };
					} finally { taskSignal.removeEventListener("abort", abort); }
				},
			});
		} catch (error) {
			// Scheduler failures must not leave the request running after its
			// durable waiter has been released for storage reconciliation.
			super.abort();
			await super.waitForIdle();
			throw error;
		} finally {
			// Stop can win after durable admission but before the scheduler starts
			// Pi. Keep the accepted prompt visible and in the next request's context.
			if (admitted && !started && messages) this.state.messages = [...this.state.messages, ...messages];
		}
	}
}
