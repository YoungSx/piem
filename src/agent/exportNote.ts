import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { CustomMessage } from "@earendil-works/pi-agent-core";
import { messageReferences } from "./contextReference";

/** One transcript entry, as the exporter reads it. */
export type ExportableMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

export interface TranscriptExportOptions {
	/** The chat's display title, as the note's `#` heading. */
	title: string;
	/** When the export was taken — rendered in the note's context line. */
	exportedAt: Date;
	/** The model the conversation ran on, for the same line. */
	model: string;
	/** Localized role labels, so the note reads in the reader's language. */
	roles: { user: string; assistant: string; tool: string };
}

/**
 * Renders a chat transcript as a Markdown note.
 *
 * The audience is a reader skimming a conversation they took part in, not a
 * machine re-importing it: thinking blocks and tool *results* are dropped, a
 * tool *call* survives only as a one-line quote next to the reply that made it.
 * Every exchange is fenced with a rule so replies stay visually attached to
 * their own question when headings collapse in an outline.
 */
export function renderTranscriptMarkdown(messages: readonly ExportableMessage[], options: TranscriptExportOptions): string {
	const stamp = `${options.exportedAt.getFullYear()}-${pad(options.exportedAt.getMonth() + 1)}-${pad(options.exportedAt.getDate())} ${pad(options.exportedAt.getHours())}:${pad(options.exportedAt.getMinutes())}`;
	const blocks: string[] = [
		`# ${options.title}`,
		"",
		`*${stamp} · ${options.model}*`,
	];
	for (const message of messages) {
		const block = renderBlock(message, options.roles);
		if (block !== null) {
			blocks.push("", "---", "", block);
		}
	}
	return `${blocks.join("\n").trimEnd()}\n`;
}

/** Names the note would collide with nothing under: legal characters, bounded length. */
export function noteFileName(title: string): string {
	// Obsidian strips `\ / : * ? " < > | # ^ [ ]` from titles it generates; we
	// must not generate paths those characters would break either.
	const cleaned = title.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
	return (cleaned || "Chat").slice(0, 80);
}

function renderBlock(message: ExportableMessage, roles: TranscriptExportOptions["roles"]): string | null {
	if (message.role === "custom") {
		return messageReferences(message) && typeof message.content === "string" ? message.content : null;
	}
	if (message.role === "user") {
		const parts = typeof message.content === "string" ? [message.content] : message.content.map((part) => (part.type === "text" ? part.text : "[image]"));
		const text = parts.join("\n\n").trim();
		return text ? `**${roles.user}**\n\n${text}` : null;
	}
	if (message.role === "assistant") {
		const lines: string[] = [];
		const text = message.content
			.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n\n")
			.trim();
		if (text) {
			lines.push(`**${roles.assistant}**`, "", text);
		}
		for (const call of message.content) {
			if (call.type === "toolCall") {
				lines.push("", `> ${roles.tool}: \`${call.name}\``);
			}
		}
		return lines.length > 0 ? lines.join("\n") : null;
	}
	// Tool results carry the machinery of the turn, not the conversation.
	return null;
}

function pad(value: number): string {
	return value.toString().padStart(2, "0");
}
