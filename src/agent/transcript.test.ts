import { expect, test } from "bun:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { conversationMessages, replaceConversation, setSystemPrompt, transcriptIndex } from "./transcript";

test("replacement preserves the current prompt and executable tools without leaking functions into the transcript", () => {
	const agent = new Agent({
		streamFn: () => { throw new Error("No provider request expected"); },
		initialState: {
			systemPrompt: "Current vault rules",
			tools: [{ name: "read", label: "Read", description: "Read a note", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }],
		},
	});
	const user: AgentMessage = { role: "user", content: "Question", timestamp: 1 };
	replaceConversation(agent, [{ role: "system", content: "Stale saved rules", timestamp: 0 }, user]);
	expect(agent.state.systemPrompt).toBe("Current vault rules");
	expect(getCurrentTools(agent.state.messages).map(tool => tool.name)).toEqual(["read"]);
	expect(() => structuredClone(agent.state.messages)).not.toThrow();
	expect(conversationMessages(agent.state.messages)).toEqual([user]);
	expect(agent.state.messages[transcriptIndex(agent.state.messages, 0)]).toBe(user);
	setSystemPrompt(agent, "This turn's rules");
	expect(agent.state.systemPrompt).toBe("This turn's rules");
	expect(conversationMessages(agent.state.messages)[0]).toBe(user);
	expect(transcriptIndex(agent.state.messages, -1)).toBe(-1);
	expect(transcriptIndex(agent.state.messages, 1)).toBe(-1);
});
