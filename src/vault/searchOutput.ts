import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { DEFAULT_MAX_BYTES } from "./piTruncate";

const SUMMARY_BYTES = 1024;
const encoder = new TextEncoder();

/** Search owns its record budget so an outer text cut cannot skip unseen rows. */
export class SearchOutput {
	readonly rows: string[] = [];
	private bytes = 0;

	add(row: string): boolean {
		const bytes = encoder.encode(row).byteLength + 1;
		if (this.bytes + bytes > DEFAULT_MAX_BYTES - SUMMARY_BYTES) {
			if (!this.rows.length) throw new Error("Search result path is too long to return within the output budget.");
			return false;
		}
		this.rows.push(row);
		this.bytes += bytes;
		return true;
	}

	result<T>(summary: string, details: T, empty: string): AgentToolResult<T> {
		if (encoder.encode(summary).byteLength + 2 > SUMMARY_BYTES) throw new Error("Search summary exceeds its output budget.");
		return { content: [{ type: "text", text: `${summary}\n\n${this.rows.join("\n") || empty}` }], details };
	}
}
