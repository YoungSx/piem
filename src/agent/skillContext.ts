import { createCustomMessage, type AgentMessage, type CustomMessage } from "@earendil-works/pi-agent-core";
import { parseSkillInvocation } from "./skillInvocation";

const SKILL_CONTEXT_TYPE = "piem-skill-context";
interface SkillContextDetails {
	name: string;
	filePath: string;
	resource?: string;
	snapshot?: string;
	offset: number;
}
interface SkillContext {
	message: CustomMessage;
	details: SkillContextDetails;
}

function textContent(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function resourceKey(details: SkillContextDetails): string {
	return JSON.stringify([details.name, details.filePath, details.resource ?? ""]);
}

function contextFrom(message: AgentMessage): SkillContext | undefined {
	if (message.role === "custom" && message.customType === SKILL_CONTEXT_TYPE) {
		const details = readDetails(message.details);
		return details ? { message, details } : undefined;
	}
	if (message.role === "toolResult" && message.toolName === "read_skill" && !message.isError) {
		const details = readDetails(message.details);
		if (!details) return undefined;
		const resource = details.resource === undefined ? "instructions" : `resource ${JSON.stringify(details.resource)}`;
		const content = `Previously loaded skill ${JSON.stringify(details.name)} ${resource}, location ${JSON.stringify(details.filePath)}:\n\n${textContent(message)}`;
		return { message: createCustomMessage(SKILL_CONTEXT_TYPE, content, false, details, message.timestamp), details };
	}
	if (message.role === "user") {
		const text = textContent(message);
		const invocation = parseSkillInvocation(text);
		if (!invocation) return undefined;
		const details: SkillContextDetails = { name: invocation.name, filePath: invocation.location, offset: 0 };
		// The transcript parser trims for display. Keep the original block here,
		// including indentation and trailing Markdown spaces, for the model.
		const content = text.slice(0, text.lastIndexOf("\n</skill>") + "\n</skill>".length);
		return { message: createCustomMessage(SKILL_CONTEXT_TYPE, content, false, details, message.timestamp), details };
	}
	return undefined;
}

function readDetails(value: unknown): SkillContextDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const details = value as Record<string, unknown>;
	if (typeof details.name !== "string" || typeof details.filePath !== "string") return undefined;
	return {
		name: details.name, filePath: details.filePath,
		offset: typeof details.offset === "number" && Number.isSafeInteger(details.offset) && details.offset >= 0 ? details.offset : 0,
		...(typeof details.resource === "string" ? { resource: details.resource } : {}),
		...(typeof details.snapshot === "string" ? { snapshot: details.snapshot } : {}),
	};
}

/**
 * Preserve only content that has actually entered this conversation. Pi custom
 * messages survive its JSONL codec and convertToLlm without orphan tool calls.
 * No skill reload or second source of truth is needed after a session reopens.
 */
export function retainSkillContext(history: readonly AgentMessage[], retainedTail: readonly AgentMessage[]): AgentMessage[] {
	const active = new Map<string, { snapshot?: string; pages: Map<number, SkillContext> }>();
	for (const message of history) {
		const context = contextFrom(message);
		if (!context) continue;
		const key = resourceKey(context.details);
		let record = active.get(key);
		// A new version or a fresh non-paged invocation supersedes older rules.
		if (!record || record.snapshot !== context.details.snapshot || context.details.snapshot === undefined) {
			record = { snapshot: context.details.snapshot, pages: new Map() };
			active.set(key, record);
		}
		record.pages.set(context.details.offset, context);
	}
	const tail = retainedTail.filter((message) => message.role !== "custom" || message.customType !== SKILL_CONTEXT_TYPE);
	const present = new Set<string>();
	for (const message of tail) {
		const context = contextFrom(message);
		if (context) present.add(JSON.stringify([resourceKey(context.details), context.details.snapshot, context.details.offset]));
	}
	const restored: AgentMessage[] = [];
	for (const [key, record] of active) {
		for (const [offset, context] of [...record.pages].sort(([a], [b]) => a - b)) {
			if (!present.has(JSON.stringify([key, record.snapshot, offset]))) restored.push(context.message);
		}
	}
	return [...restored, ...tail];
}
