import { getAllTags, parseFrontMatterAliases, type CachedMetadata } from "obsidian";
import { textLines } from "./search";
import { truncateLine } from "./piTruncate";
import { yieldSearch } from "./searchYield";

export interface NoteQuery {
	phrase: string;
	terms: string[];
}

export interface NoteSearchMatch {
	path: string;
	title: string;
	rank: number[];
	fields: string[];
	matchedTerms: string[];
	evidence?: { lineNumber: number; text: string };
}

export function noteQuery(query: string): NoteQuery {
	const phrase = query.trim().replace(/\s+/g, " ").toLowerCase();
	if (!phrase || phrase.length > 1000) throw new Error("query must contain 1–1000 characters after whitespace normalization.");
	const terms = [...new Set(phrase.split(" "))];
	if (terms.length > 32) throw new Error("query must contain at most 32 distinct whitespace-separated terms.");
	return { phrase: terms.join(" "), terms };
}

/** One bounded record per note; repeated body terms do not increase its rank. */
export async function matchNote(
	path: string,
	title: string,
	content: string,
	cache: CachedMetadata | null,
	query: NoteQuery,
	signal?: AbortSignal,
): Promise<NoteSearchMatch | null> {
	const sources: Array<[string, string[]]> = [
		["title", [title]],
		["aliases", parseFrontMatterAliases(cache?.frontmatter ?? null) ?? []],
		["headings", (cache?.headings ?? []).map((heading) => heading.heading)],
		["tags", cache ? getAllTags(cache) ?? [] : []],
	];
	const fieldTerms = sources.map(([, values]) => {
		const texts = values.map((value) => value.toLowerCase());
		return new Set(query.terms.filter((term) => texts.some((value) => value.includes(term))));
	});
	const phraseInTitle = sources.slice(0, 2).some(([, values]) => values.some((value) => value.toLowerCase().includes(query.phrase)));
	const bodyTerms = new Set<string>();
	let evidence: NoteSearchMatch["evidence"];
	for (const { line, lineNumber } of textLines(content)) {
		if (lineNumber % 1000 === 0) await yieldSearch(signal);
		const lower = line.toLowerCase();
		for (const term of query.terms) {
			const index = lower.indexOf(term);
			if (index < 0) continue;
			bodyTerms.add(term);
			if (!evidence) {
				const start = Math.max(0, index - 80);
				evidence = { lineNumber, text: `${start ? "…" : ""}${truncateLine(line.slice(start, start + 500)).text}${line.length > start + 500 ? "…" : ""}` };
			}
		}
	}
	const allTerms = new Set([...fieldTerms.flatMap((terms) => [...terms]), ...bodyTerms]);
	if (!allTerms.size) return null;
	const titleTerms = new Set([...fieldTerms[0]!, ...fieldTerms[1]!]);
	const structureTerms = new Set([...fieldTerms[2]!, ...fieldTerms[3]!]);
	return {
		path, title,
		rank: [allTerms.size, Number(phraseInTitle), titleTerms.size, structureTerms.size, bodyTerms.size],
		fields: [...sources.filter((_, index) => fieldTerms[index]!.size).map(([field]) => field), ...(bodyTerms.size ? ["body"] : [])],
		matchedTerms: query.terms.filter((term) => allTerms.has(term)),
		evidence,
	};
}

export function compareNoteMatches(left: NoteSearchMatch, right: NoteSearchMatch): number {
	for (let index = 0; index < left.rank.length; index += 1) {
		const difference = right.rank[index]! - left.rank[index]!;
		if (difference) return difference;
	}
	return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function formatNoteMatch(match: NoteSearchMatch, termCount: number): string {
	const reason = `Matched ${match.matchedTerms.length}/${termCount} terms in ${match.fields.join(", ")}: ${match.matchedTerms.join(", ")}`;
	const evidence = match.evidence ? `\n${match.path}:${match.evidence.lineNumber}: ${match.evidence.text}` : "";
	return `${match.path} — ${truncateLine(match.title).text}\n${reason}${evidence}`;
}
