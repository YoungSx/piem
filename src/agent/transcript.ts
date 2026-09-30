import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";

const visible = new WeakMap<readonly AgentMessage[], { length: number; messages: AgentMessage[] }>();

/** System instructions belong to Pi's transcript, never the visible conversation. */
export function conversationMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	// Pi appends in place and replaces the array on rewind/restore. Keep the
	// snapshot stable between those changes so note events do not repaint chat.
	const cached = visible.get(messages);
	if (cached?.length === messages.length) return cached.messages;
	const result = messages.filter(message => message.role !== "system");
	visible.set(messages, { length: messages.length, messages: result });
	return result;
}

/** Piem owns the prompt; replayed history must not replace today's instructions/tools. */
export function replaceConversation(agent: Agent, messages: readonly AgentMessage[], prompt = agent.state.systemPrompt): void {
	const system = createInitialSystemMessage(prompt, agent.state.tools.map(toToolDeclaration));
	agent.state.messages = [...(system ? [system] : []), ...conversationMessages(messages)];
}

export function setSystemPrompt(agent: Agent, prompt: string): void {
	replaceConversation(agent, agent.state.messages, prompt);
}

/** UI actions use visible indices; preserve identity when locating Pi's transcript entry. */
export function transcriptIndex(messages: readonly AgentMessage[], visibleIndex: number): number {
	const message = conversationMessages(messages)[visibleIndex];
	return message ? messages.indexOf(message) : -1;
}
