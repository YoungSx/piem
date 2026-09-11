import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionRunner } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";

export const SUPPORTED_EXTENSION_EVENTS = new Set([
	"context", "session_start", "session_shutdown", "before_agent_start", "agent_start", "agent_end", "agent_settled",
	"turn_start", "turn_end", "message_start", "message_update", "message_end",
	"tool_execution_start", "tool_execution_update", "tool_execution_end",
	// Interception, not observation: unlike the tool_execution_* trio these run
	// inside the agent's own tool-call path and can block a call or rewrite its
	// result. They are routed through the Agent's beforeToolCall/afterToolCall
	// hooks rather than this class, because pi's runner gives them dedicated
	// emitters that the generic emit() deliberately excludes.
	"tool_call", "tool_result",
	"input", "model_select", "session_tree",
]);

/** The native agent emits fewer fields than Pi's extension-facing event types. */
export class ExtensionAgentEvents {
	private turnIndex = 0;
	constructor(private readonly runner: ExtensionRunner) {}

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
			await this.runner.emit({ ...structuredClone(event), turnIndex: this.turnIndex++ });
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
