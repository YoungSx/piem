import * as messages from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
export { convertToLlm, type CustomMessage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";

/** Piem keeps epoch timestamps on disk; the current Pi factories take ISO dates. */
export function createCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string | number) {
	return messages.createCompactionSummaryMessage(summary, tokensBefore, new Date(timestamp).toISOString());
}
export function createBranchSummaryMessage(summary: string, fromId: string | null, timestamp: string | number) {
	return { ...messages.createBranchSummaryMessage(summary, fromId ?? "", new Date(timestamp).toISOString()), fromId };
}
export function createCustomMessage(
	customType: string, content: messages.CustomMessage["content"], display: boolean, details: unknown, timestamp: string | number,
) {
	return messages.createCustomMessage(customType, content, display, details, new Date(timestamp).toISOString());
}
