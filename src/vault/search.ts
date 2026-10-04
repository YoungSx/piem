import { truncateLine } from "./piTruncate";

export interface GrepMatch {
	path: string;
	lineNumber: number;
	line: string;
}

export interface GrepOptions {
	caseSensitive?: boolean;
	regex?: boolean;
	maxMatches?: number;
}

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

export function matchesFindPattern(path: string, pattern: string): boolean {
	const normalizedPattern = pattern.trim();
	if (!normalizedPattern) {
		return true;
	}
	if (hasGlobCharacters(normalizedPattern)) {
		return globToRegExp(normalizedPattern).test(path);
	}
	return path.toLowerCase().includes(normalizedPattern.toLowerCase());
}

export function grepContent(path: string, content: string, pattern: string, options: GrepOptions = {}): GrepMatch[] {
	const matcher = createLineMatcher(pattern, options);
	const matches: GrepMatch[] = [];
	const maxMatches = options.maxMatches ?? 100;
	const lines = content.split(/\r?\n/);

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!matcher(line)) {
			continue;
		}
		matches.push({ path, lineNumber: index + 1, line });
		if (matches.length >= maxMatches) {
			break;
		}
	}

	return matches;
}

export function formatGrepMatches(matches: GrepMatch[], truncated: boolean): string {
	if (matches.length === 0) {
		return "No matches.";
	}
	// Long matches (minified assets, base64 blobs) would otherwise flood the model's
	// context, so each line is capped using pi's shared grep line limit.
	const body = matches
		.map((match) => `${match.path}:${match.lineNumber}: ${truncateLine(match.line).text}`)
		.join("\n");
	return truncated ? `${body}\n\n[Matches truncated.]` : body;
}

function createLineMatcher(pattern: string, options: GrepOptions): (line: string) => boolean {
	if (options.regex) {
		const flags = options.caseSensitive ? "" : "i";
		const regex = new RegExp(pattern, flags);
		return (line) => regex.test(line);
	}

	const needle = options.caseSensitive ? pattern : pattern.toLowerCase();
	return (line) => {
		const haystack = options.caseSensitive ? line : line.toLowerCase();
		return haystack.includes(needle);
	};
}

function hasGlobCharacters(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?");
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(REGEX_SPECIAL_CHARS, "\\$&").replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}
