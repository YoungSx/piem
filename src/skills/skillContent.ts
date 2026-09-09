import { DEFAULT_MAX_BYTES, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { sha256Hex } from "./skillHash";

export interface SkillPageOptions {
	offset?: number;
	snapshot?: string;
}

export interface SkillContentDetails {
	name: string;
	filePath: string;
	/** Absent for the skill instructions; present for a supporting resource. */
	resource?: string;
	snapshot: string;
	offset: number;
	endOffset: number;
	totalBytes: number;
	nextOffset?: number;
}

/** Byte paging also handles a single long line without splitting UTF-8 characters. */
export async function skillContentPage(
	text: string,
	identity: Pick<SkillContentDetails, "name" | "filePath" | "resource">,
	options: SkillPageOptions,
): Promise<AgentToolResult<SkillContentDetails>> {
	const bytes = new TextEncoder().encode(text);
	const offset = options.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw new Error("Invalid skill byte offset.");
	if (offset > 0 && !options.snapshot) throw new Error("Continue with the snapshot returned by the first read_skill call.");
	const snapshot = await sha256Hex(text);
	if (options.snapshot && options.snapshot !== snapshot) throw new Error("Skill content changed. Restart read_skill at offset=0.");
	if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error("Skill offset must be at a UTF-8 character boundary.");
	let endOffset = Math.min(bytes.length, offset + DEFAULT_MAX_BYTES);
	while (endOffset < bytes.length && (bytes[endOffset]! & 0xc0) === 0x80) endOffset--;
	const nextOffset = endOffset < bytes.length ? endOffset : undefined;
	let content = new TextDecoder().decode(bytes.subarray(offset, endOffset));
	if (nextOffset !== undefined) {
		const resource = identity.resource === undefined ? "" : ` path=${JSON.stringify(identity.resource)}`;
		content += `\n\n[More skill content: call read_skill with name=${JSON.stringify(identity.name)}${resource} offset=${nextOffset} snapshot="${snapshot}". Continue until complete.]`;
	}
	return {
		content: [{ type: "text", text: content }],
		details: { ...identity, snapshot, offset, endOffset, totalBytes: bytes.length, ...(nextOffset === undefined ? {} : { nextOffset }) },
	};
}
