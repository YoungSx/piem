import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./piTruncate";

export interface TextSliceOptions {
	offset?: number;
	limit?: number;
}

export interface TextSlice {
	text: string;
	startLine: number;
	endLine: number;
	totalLines: number;
	truncated: boolean;
}

/**
 * Selects a one-indexed line window from a note.
 *
 * pi keeps its equivalent window inline and unexported inside its own read tool,
 * and reaches it only after a filesystem read, so it cannot be reused from the
 * Obsidian Vault API. Byte capping is deliberately left to
 * {@link truncateToolOutput} so the two limits do not compound.
 */
export function sliceTextByLines(content: string, options: TextSliceOptions = {}): TextSlice {
	const lines = content.split(/\r?\n/);
	const startLine = Math.max(1, options.offset ?? 1);
	const startIndex = startLine - 1;
	const requestedEnd = options.limit === undefined ? lines.length : startIndex + Math.max(0, options.limit);
	const selectedLines = lines.slice(startIndex, requestedEnd);
	const visibleLineCount = selectedLines.length;

	return {
		text: selectedLines.join("\n"),
		startLine,
		endLine: visibleLineCount === 0 ? startLine - 1 : startLine + visibleLineCount - 1,
		totalLines: lines.length,
		truncated: requestedEnd < lines.length,
	};
}

export function formatTextSlice(path: string, slice: TextSlice): string {
	const header = `${path} lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines}${slice.truncated ? " (truncated)" : ""}`;
	return `${header}\n${slice.text}`;
}

/** A capped tool output plus what the cap did, for callers that offer paging. */
export interface TruncatedText {
	text: string;
	truncated: boolean;
	/** Which budget ran out first, or null when nothing was cut. */
	truncatedBy: "lines" | "bytes" | null;
	/** Lines in the original text, so a caller can word "N of M". */
	totalLines: number;
	/** Lines that survived the cut. */
	outputLines: number;
}

/**
 * Caps a tool result so one large note cannot fill the model's context.
 *
 * The byte budget comes from pi's shared limit rather than a character count,
 * because UTF-8 bytes are what the provider actually pays for — 50k characters
 * of CJK text is roughly 150k bytes, which a character-based cap lets through.
 *
 * The line budget is pi's too, and it is the one worth overriding: pi's 2000
 * lines suit a file read, where the first screenful is what the model wanted,
 * but a result whose whole point is its own length (a subagent report, say) is
 * cut by it long before the byte budget bites. Pass `Number.POSITIVE_INFINITY`
 * to run on bytes alone.
 *
 * pi's `truncateHead` supplies both limits and the whole-line cut. Its
 * "first line alone exceeds the limit" case returns no content at all, which
 * would turn a single-line file into an empty result, so that case falls back to
 * a byte-bounded slice of the first line.
 */
export function truncateToolOutputDetailed(
	text: string,
	maxBytes = DEFAULT_MAX_BYTES,
	maxLines = DEFAULT_MAX_LINES,
): TruncatedText {
	const result = truncateHead(text, { maxBytes, maxLines });
	if (!result.truncated) {
		return {
			text,
			truncated: false,
			truncatedBy: null,
			totalLines: result.totalLines,
			outputLines: result.outputLines,
		};
	}

	// Naming the budget that actually ran out is the difference between a model
	// that pages the rest and one that concludes the report was simply short.
	const notice =
		result.truncatedBy === "lines"
			? `\n\n[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines.]`
			: `\n\n[Output truncated at ${formatSize(maxBytes)}: showing ${result.outputLines} of ${result.totalLines} lines.]`;
	const body = result.firstLineExceedsLimit ? sliceToByteLimit(text, maxBytes) : result.content;
	return {
		text: `${body}${notice}`,
		truncated: true,
		truncatedBy: result.truncatedBy,
		totalLines: result.totalLines,
		// A byte-clipped first line is one partial line on screen; report it as
		// such rather than as pi's zero, or "0 of 1 lines" reads as empty.
		outputLines: result.firstLineExceedsLimit ? 1 : result.outputLines,
	};
}

/** The capped text alone, for the many callers that never page. */
export function truncateToolOutput(text: string, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES): string {
	return truncateToolOutputDetailed(text, maxBytes, maxLines).text;
}

/** Cuts a string to a UTF-8 byte budget without splitting a character. */
function sliceToByteLimit(text: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(text).slice(0, maxBytes);
	return new TextDecoder("utf-8", { fatal: false }).decode(encoded).replace(/�+$/, "");
}
