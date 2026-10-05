import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AssistantEntry, ToolResultEntry, UserEntry, type AgentState, type ConversationView, type LiveState, type ToolSlot } from "@earendil-works/pi-durable";
import type { PendingToolCall } from "../agent/ObsidianAgentService";

/** Read-only projection of Pi's committed documents; never an execution state machine. */
export function nativeChatProjection(view: ConversationView) {
	const live = (view.docs["pi.live"] ?? {}) as LiveState;
	const agent = (view.docs["pi.agent"] ?? {}) as AgentState;
	// System declarations and compaction/reset handoffs are provider context,
	// even when their model representation is a user message. Never impersonate
	// the user in the visible transcript.
	const messages: AgentMessage[] = view.entries.flatMap(entry =>
		UserEntry.is(entry) || AssistantEntry.is(entry) || ToolResultEntry.is(entry)
			? (entry.model ?? []).filter(message => message.role === "user" || message.role === "assistant" || message.role === "toolResult")
			: []);
	if (live.generation?.message) messages.push(live.generation.message);
	const pendingToolCalls: PendingToolCall[] = (live.tools ?? [])
		.filter(tool => tool.status !== "done")
		.map(tool => ({ id: tool.callId, name: tool.name, progress: progress(tool) }));
	const isCompacting = !!live.compactions?.length;
	return {
		messages, agent, pendingToolCalls, isCompacting,
		busy: !!live.run || isCompacting,
		retry: live.generation?.retry ?? live.compactions?.find(task => task.retry)?.retry,
	};
}

function progress(tool: ToolSlot): string | undefined {
	const details = tool.details;
	if (details && typeof details === "object" && !Array.isArray(details)) {
		const update = details.piemProgress;
		if (update && typeof update === "object" && !Array.isArray(update) && Array.isArray(update.content)) {
			// The adapter publishes complete replacements, including a shorter/empty update.
			return update.content.flatMap(block => block && typeof block === "object" && !Array.isArray(block)
				&& block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
		}
	}
	return tool.output;
}
