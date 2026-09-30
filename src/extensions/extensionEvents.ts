import type { AgentEvent, AgentMessage, Entry } from "@earendil-works/pi-agent-core";
import type { ExtensionRunner } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import type { AgentActivityOutcome, BoundaryContextPreview, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

export interface ExtensionBoundaryCallbacks {
	buildContext(drafts: SessionBoundaryDraft[], event: "turn_end" | "agent_before_settle"): BoundaryContextPreview | Promise<BoundaryContextPreview>;
	commit(drafts: SessionBoundaryDraft[]): Promise<void>;
	getMessageEntryId(message: AgentMessage): string | undefined;
}

export const SUPPORTED_EXTENSION_EVENTS = new Set([
	"context", "session_start", "session_shutdown", "before_agent_start", "agent_start", "agent_end", "agent_before_settle", "agent_settled",
	"turn_start", "turn_end", "message_start", "message_update", "message_end",
	"tool_execution_start", "tool_execution_update", "tool_execution_end",
	// Interception, not observation: unlike the tool_execution_* trio these run
	// inside the agent's own tool-call path and can block a call or rewrite its
	// result. They are routed through the Agent's beforeToolCall/afterToolCall
	// hooks rather than this class, because pi's runner gives them dedicated
	// emitters that the generic emit() deliberately excludes.
	"tool_call", "tool_result",
	"before_provider_request", "after_provider_response",
	"input", "model_select", "thinking_level_select", "session_tree", "session_compact", "session_compact_failed",
	"session_before_fork", "session_before_switch", "session_before_compact", "session_before_tree",
]);

/** Piem compaction entry exposed to extensions with truthful firstKeptEntryId lineage. */
export type PiemCompactionEntry = Omit<Extract<Entry, { type: "compaction" }>, "timestamp"> & {
	timestamp: string;
	/** The entry ID of the first retained message, or empty string if no retained tail exists. */
	readonly firstKeptEntryId: string;
};

export function extensionCompactionEntry(
	entry: Extract<Entry, { type: "compaction" }>,
	firstKeptEntryId?: string | null,
): PiemCompactionEntry {
	const resolvedFirstKeptEntryId =
		(entry as unknown as { firstKeptEntryId?: string }).firstKeptEntryId ?? firstKeptEntryId ?? "";
	return {
		...structuredClone(entry),
		timestamp: new Date(entry.timestamp).toISOString(),
		firstKeptEntryId: resolvedFirstKeptEntryId,
	};
}

/** The native agent emits fewer fields than Pi's extension-facing event types. */
export class ExtensionAgentEvents {
	private turnIndex = 0;
	constructor(private readonly runner: ExtensionRunner, private readonly boundary?: ExtensionBoundaryCallbacks) {}

	async finishTurn(message: AgentMessage, toolResults: Extract<AgentEvent, { type: "turn_end" }>["toolResults"], assertActive: () => void): Promise<boolean> {
		if (!this.runner.hasHandlers("turn_end")) return false;
		const boundary = this.requireBoundary();
		const messageEntryId = boundary.getMessageEntryId(message);
		if (!messageEntryId) throw new Error("Turn boundary message has not been persisted.");
		return this.dispatch({
			type: "turn_end", turnIndex: this.turnIndex, message, toolResults,
			messageEntryId,
			toolResultEntryIds: toolResults.map(result => {
				const id = boundary.getMessageEntryId(result);
				if (!id) throw new Error("Turn boundary tool result has not been persisted.");
				return id;
			}),
			outcome: message.role === "assistant" && message.stopReason === "error" ? "error"
				: message.role === "assistant" && message.stopReason === "aborted" ? "aborted" : "completed",
		}, assertActive);
	}

	async beforeSettle(outcome: AgentActivityOutcome, assertActive: () => void): Promise<boolean> {
		if (!this.runner.hasHandlers("agent_before_settle")) return false;
		return this.dispatch({ type: "agent_before_settle", outcome }, assertActive);
	}

	private requireBoundary(): ExtensionBoundaryCallbacks {
		if (!this.boundary) throw new Error("Extension boundary storage is unavailable.");
		return this.boundary;
	}

	private async dispatch(event: Parameters<ExtensionRunner["emitBoundary"]>[0], assertActive: () => void): Promise<boolean> {
		const boundary = this.requireBoundary();
		const result = await this.runner.emitBoundary(event, async drafts => {
			assertActive();
			const context = await boundary.buildContext(drafts, event.type);
			assertActive();
			return context;
		});
		assertActive();
		if (!result.valid) return false;
		await boundary.commit(result.entries);
		assertActive();
		if (result.continue) {
			const context = await boundary.buildContext([], event.type);
			assertActive();
			if (!context.canContinue) throw new Error(`${event.type} requested continuation without runnable model context.`);
		}
		return result.continue;
	}

	/** Track numbering even when no extension subscribes to turn_end itself. */
	observe(event: AgentEvent): void {
		if (event.type === "agent_start") this.turnIndex = 0;
		if (event.type === "turn_end") this.turnIndex++;
	}

	async emit(event: AgentEvent, assertActive: () => void): Promise<void> {
		if (event.type === "agent_start") this.turnIndex = 0;
		if (event.type === "turn_start") {
			await this.runner.emit({ ...event, turnIndex: this.turnIndex, timestamp: Date.now() });
		} else if (event.type === "turn_end") {
			// Mutating boundary handlers run in finishTurn, before Pi chooses its
			// continuation. The later observation only advances the turn number.
			this.turnIndex++;
		} else if (event.type === "message_end") {
			const replacement = await this.runner.emitMessageEnd(structuredClone(event));
			assertActive();
			if (replacement) replaceMessage(event.message, replacement);
		} else {
			await this.runner.emit(structuredClone(event));
		}
	}
}

/** Mirrors the official AgentSession: preserve the message identity Pi stores. */
function replaceMessage(target: AgentMessage, replacement: AgentMessage): void {
	if (replacement.role !== target.role) throw new Error("Extension cannot change a message role.");
	for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
	Object.assign(target, replacement);
	if ((target.role === "user" || target.role === "assistant" || target.role === "toolResult" || target.role === "custom") && target.content == null) {
		target.content = [];
	}
}
