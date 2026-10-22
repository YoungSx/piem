import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createLineMatcher, textLines } from "../vault/search";
import { truncateLine } from "../vault/piTruncate";
import { SearchOutput } from "../vault/searchOutput";
import { yieldSearch } from "../vault/searchYield";
import { vaultScopeParameter } from "./parameters";
import { TEXT_EXTENSIONS } from "./vaultFiles";
import { filesInSearchScope, searchInteger, searchScope } from "./searchScope";
import { throwIfAborted } from "./toolResult";

export interface GrepDetails {
	pattern: string;
	count: number;
	offset: number;
	hasMore: boolean;
	nextOffset?: number;
	candidateFiles: number;
	readFiles: number;
	fullyScannedFiles: number;
	lineTruncated: boolean;
	truncated: boolean;
	truncatedBy: "matches" | "bytes" | null;
}

const GrepParameters = Type.Object({
	pattern: Type.String(),
	path: vaultScopeParameter("Folder or file; must exist."),
	caseSensitive: Type.Optional(Type.Boolean()),
	regex: Type.Optional(Type.Boolean()),
	maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Matching lines per page, 1–1000. Defaults to 100; the byte budget may return fewer." })),
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Zero-based matching-line offset. Defaults to 0. Continue with nextOffset using the same query and scope; vault changes can shift pages." })),
});

export function createGrepTool(app: App): AgentTool<typeof GrepParameters, GrepDetails> {
	return {
		name: "grep",
		label: "Search file text",
		executionMode: "parallel",
		description: "Find matching lines in vault text files, in stable path and line order. Literal and case-insensitive by default; regex and caseSensitive are optional. Results include coverage and nextOffset for paging. Use search_notes to discover related notes. Cancellation is checked between reads and line batches; a single regex evaluation cannot be interrupted.",
		parameters: GrepParameters,
		execute: async (_id, params, signal) => {
			throwIfAborted(signal);
			const limit = searchInteger(params.maxMatches ?? 100, "maxMatches", 1, 1000);
			const offset = searchInteger(params.offset ?? 0, "offset", 0, Number.MAX_SAFE_INTEGER);
			const matcher = createLineMatcher(params.pattern, params);
			const root = searchScope(app, params.path);
			const files = filesInSearchScope(app.vault.getFiles().filter((file) => TEXT_EXTENSIONS.has(file.extension.toLowerCase())), root);
			const output = new SearchOutput();
			let skipped = 0, readFiles = 0, fullyScannedFiles = 0;
			let hasMore = false, lineTruncated = false;
			let truncatedBy: "matches" | "bytes" | null = null;
			scan: for (const file of files) {
				throwIfAborted(signal);
				const content = await app.vault.cachedRead(file);
				throwIfAborted(signal);
				readFiles += 1;
				for (const { line, lineNumber } of textLines(content)) {
					if (lineNumber % 1000 === 0) await yieldSearch(signal);
					if (!matcher(line)) continue;
					if (skipped < offset) { skipped += 1; continue; }
					if (output.rows.length === limit) {
						hasMore = true;
						truncatedBy = "matches";
						break scan;
					}
					const shortened = truncateLine(line);
					if (!output.add(`${file.path}:${lineNumber}: ${shortened.text}`)) {
						hasMore = true;
						truncatedBy = "bytes";
						break scan;
					}
					lineTruncated ||= shortened.wasTruncated;
				}
				fullyScannedFiles += 1;
				if (readFiles % 16 === 0) await yieldSearch(signal);
			}
			throwIfAborted(signal);
			const count = output.rows.length;
			const nextOffset = hasMore ? searchInteger(offset + count, "nextOffset", 0, Number.MAX_SAFE_INTEGER) : undefined;
			const details = { pattern: params.pattern, count, offset, hasMore, nextOffset, candidateFiles: files.length, readFiles, fullyScannedFiles, lineTruncated, truncated: hasMore, truncatedBy };
			const continuation = hasMore ? ` Continue grep with the same arguments and offset=${nextOffset}.` : " Search range exhausted.";
			const summary = `Returned ${count} matching lines; offset=${offset}; hasMore=${hasMore}${hasMore ? `; nextOffset=${nextOffset}` : ""}. Read ${readFiles}/${files.length} candidate files; fully scanned ${fullyScannedFiles}.${continuation}${lineTruncated ? " Long line text is shortened; read the file at its line number." : ""}${truncatedBy === "bytes" ? " Page limited by output bytes." : ""}`;
			return output.result(summary, details, "No matches.");
		},
	};
}
