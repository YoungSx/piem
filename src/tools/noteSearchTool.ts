import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { compareNoteMatches, formatNoteMatch, matchNote, noteQuery, type NoteSearchMatch } from "../vault/noteSearch";
import { SearchOutput } from "../vault/searchOutput";
import { yieldSearch } from "../vault/searchYield";
import { vaultScopeParameter } from "./parameters";
import { filesInSearchScope, searchInteger, searchScope } from "./searchScope";
import { throwIfAborted } from "./toolResult";

export interface NoteSearchDetails {
	query: string;
	candidateFiles: number;
	scannedFiles: number;
	matchedNotes: number;
	returnedNotes: number;
	metadataMissingCount: number;
	truncated: boolean;
	truncatedBy: "bytes" | "notes" | null;
	matches: NoteSearchMatch[];
}

const NoteSearchParameters = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 1000, description: "Case-insensitive literal terms separated by whitespace; up to 32 distinct terms. Chinese text without spaces is one term. No regex, stemming, synonyms, or Obsidian search operators." }),
	path: vaultScopeParameter("Folder or Markdown file; must exist."),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Notes to return, 1–100. Defaults to 20; the output byte budget may return fewer. Narrow query or path to find more." })),
});

export function createNoteSearchTool(app: App): AgentTool<typeof NoteSearchParameters, NoteSearchDetails> {
	return {
		name: "search_notes",
		label: "Find related notes",
		executionMode: "parallel",
		description: "Discover Markdown notes by literal term coverage, then title/alias, heading/tag, and body matches. Scans every note in scope before selecting results, one per note; repeated words add no weight. Returns paths, matching reasons, and line evidence. This is lexical ranking, not semantic search. Use grep for exact lines or regex. Reads can fail and metadata can be pending; Stop is checked between reads and line batches.",
		parameters: NoteSearchParameters,
		execute: async (_id, params, signal) => {
			throwIfAborted(signal);
			const query = noteQuery(params.query);
			const limit = searchInteger(params.maxResults ?? 20, "maxResults", 1, 100);
			const root = searchScope(app, params.path);
			const files = filesInSearchScope(app.vault.getMarkdownFiles(), root);
			const best: NoteSearchMatch[] = [];
			let scannedFiles = 0, matchedNotes = 0, metadataMissingCount = 0;
			for (const file of files) {
				throwIfAborted(signal);
				const content = await app.vault.cachedRead(file);
				throwIfAborted(signal);
				const cache = app.metadataCache.getFileCache(file);
				if (!cache) metadataMissingCount += 1;
				const match = await matchNote(file.path, file.basename, content, cache, query, signal);
				throwIfAborted(signal);
				scannedFiles += 1;
				if (match) {
					matchedNotes += 1;
					best.push(match);
					best.sort(compareNoteMatches);
					if (best.length > limit) best.pop();
				}
				if (scannedFiles % 16 === 0) await yieldSearch(signal);
			}
			throwIfAborted(signal);
			const output = new SearchOutput();
			let byteLimited = false;
			for (const match of best) {
				if (!output.add(formatNoteMatch(match, query.terms.length))) { byteLimited = true; break; }
			}
			const returnedNotes = output.rows.length;
			const truncated = returnedNotes < matchedNotes;
			const details: NoteSearchDetails = { query: query.phrase, candidateFiles: files.length, scannedFiles, matchedNotes, returnedNotes, metadataMissingCount, truncated, truncatedBy: byteLimited ? "bytes" : truncated ? "notes" : null, matches: best.slice(0, returnedNotes) };
			const summary = `Returned ${returnedNotes}/${matchedNotes} matching notes; scanned ${scannedFiles}/${files.length} Markdown files. Ranked by distinct term coverage, then title/alias, headings/tags, body, and stable path; repeated terms add no weight.${metadataMissingCount ? ` Metadata unavailable for ${metadataMissingCount} files; titles and bodies still searched.` : ""}${truncated ? " Narrow query or path to find more notes." : ""}${byteLimited ? " Output limited by bytes." : ""}`;
			return output.result(summary, details, "No matching notes.");
		},
	};
}
