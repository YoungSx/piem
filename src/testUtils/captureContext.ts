import { getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";

/** Record the resolved provider input in the conventional prompt/tools/message shape. */
export function captureContext(context: Context): Context {
	return structuredClone({
		systemPrompt: getCurrentSystemPrompt(context.messages),
		tools: getCurrentTools(context.messages),
		messages: context.messages.filter(message => message.role !== "system"),
	});
}
