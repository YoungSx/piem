/**
 * The model-driven half of proactive perception.
 *
 * `silentScout` decides *when* a note is worth a look; this module decides what
 * the look is made of and how the answer is read back. One non-streaming
 * request through the same `StreamFn` seam the agent's turns use, tools and
 * reasoning off: perception is a paragraph of JSON, not a task for the tool
 * loop, and it is paid for out of the user's own quota on a background timer —
 * so it stays one round trip on a cheap model.
 *
 * The note is handed over whole where it fits, and in the shape a reviewer
 * reads when it does not: frontmatter, heading outline, opening, closing. The
 * three defects the scout exists to catch — frontmatter that is missing or
 * malformed, contradictions and format breakage in the body, external links
 * whose conclusions were never written down — can each live anywhere in a long
 * note, which is exactly why the head-only excerpt this replaced could only
 * ever answer in generalities.
 *
 * The local audit's own findings ride along in the prompt. Every one of them is
 * free and already known (`vaultGardener`, `noteFacts`); a model asked to
 * perceive a note while blind to its broken links and unresolved promises
 * spends tokens rediscovering what the caller was holding.
 *
 * The prompt copy is authored once in English, in this module — model-facing
 * strings are not user interface, so they carry no i18n burden; the output
 * language is named inside the instruction itself, the same contract
 * `quickActionSuggestionRequest` documents.
 *
 * Free of React and DOM imports so the sampler, the prompt, and the parse unit
 * test without a renderer or a network.
 */

import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { BrokenLinkFix } from "./vaultGardener";
import type { Language } from "../i18n";

/** One perception the model reported, shaped to become a quick-action chip. */
export interface ScoutFinding {
	/** 2-4 words shown on the chip, naming the concrete defect. */
	label: string;
	/** The message a tap sends — the turn that acts on the finding. */
	prompt: string;
	/** One line of evidence the model actually saw. */
	summary?: string;
}

/**
 * Everything the request is built from.
 *
 * `content` is the note verbatim; the sampler decides how much of it fits.
 * The fact fields are the caller's local audit — passed in rather than
 * recomputed so the prompt describes the same audit the chip does.
 */
export interface ScoutPerceptionRequest {
	notePath: string;
	content: string;
	tags: readonly string[];
	unresolvedPromises: readonly string[];
	brokenLinkFixes: readonly BrokenLinkFix[];
	suggestedMocTopic: string | null;
}

/**
 * How many findings one perception may report.
 *
 * The chip row shows the first; the rest exist so the model can rank its own
 * perceptions and lead with the one it would fix first, rather than being
 * forced to name all-or-nothing. Three is where an audit stops being a list of
 * defects and starts being a rewrite proposal.
 */
export const MAX_SCOUT_FINDINGS = 3;

/**
 * Output ceiling for one perception.
 *
 * Above the 150 this replaced by a wide margin: three findings with a label, a
 * prompt, and a rationale each, in a language that may not be English, is where
 * a JSON array stops fitting — and a reply that ends mid-array fails the parse
 * and throws away the whole perception.
 */
export const SCOUT_MAX_TOKENS = 400;

/**
 * How much of a long note is shown. The parts, not the head: a note's
 * frontmatter sits at the top, its conclusions at the bottom, and its shape —
 * which is what a reviewer navigates by — is nowhere in particular.
 */
const SAMPLE_HEAD_CHARS = 2_500;
const SAMPLE_TAIL_CHARS = 1_500;
const SAMPLE_FRONTMATTER_LIMIT = 800;
const SAMPLE_HEADING_LIMIT = 20;

/** The instruction is authored in English; the output language is named in words the model reads. */
const LANGUAGE_NAMES: Record<Language, string> = { en: "English", "zh-cn": "简体中文" };

/**
 * The instruction half of the request, authored once in English.
 *
 * The three bullets are the scout's whole brief: the defects worth interrupting
 * a writer for, in the order the material can actually show them. The closing
 * rules matter as much as the contract — a perception the user checks and finds
 * wrong costs more trust than a missing one, so the model is told to stay
 * inside the material and to answer `[]` rather than pad the array.
 */
const PERCEPTION_INSTRUCTION = `You are reviewing one note in the user's personal knowledge vault, looking for problems the author would want to know about.

Look for, in priority order:
1. Missing or non-standard YAML frontmatter — no frontmatter block at all, or one without tags / an updated timestamp that the vault's other notes carry.
2. Contradictions, stale claims, or format breakage in the body — two statements that cannot both be true, a heading level that skips, a table or list that is malformed.
3. External links whose content was never written down — a bare URL or reference with no takeaway, so the note records that something was read but not what it said.

Reply with ONLY a JSON array of at most {count} objects, each {"label": string, "prompt": string, "summary": string}. label is 2-4 words shown on a button, naming the concrete defect (include a count when the material shows one, e.g. "2 contradictions"). prompt is the full message the button sends, under 25 words, asking for that specific fix. summary is one short line quoting the evidence you saw. Write label, prompt, and summary in {language}. Do not use markdown, code fences, or any text outside the array.

If the note has none of those problems, reply with exactly [].

Stay inside the material below: name only what it actually shows, and never invent a problem to fill the array. A finding the user checks and finds wrong is worse than no finding at all. Report the most serious defect first — it is the one shown on the button.`;

/**
 * Whether the note opens with a closed YAML frontmatter block.
 *
 * Exported because the prompt's fact line and the sampler's frontmatter part
 * have to agree on what counts as frontmatter; an unterminated leading `---`
 * block is *not* frontmatter here — it is a malformed one, and reporting it as
 * absent alongside the raw opening is what lets the model say so.
 */
export function hasFrontmatterBlock(content: string): boolean {
	return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content);
}

/**
 * Renders the note into reviewer shape: frontmatter, outline, opening, closing.
 *
 * Each part is cut to its own budget and the parts are labelled, because a
 * reviewer that cannot tell an outline line from prose reads the outline as
 * claims the note makes. The closing drops its first line when the split lands
 * mid-sentence — half a sentence reads as a claim, a dropped one reads as a cut.
 */
export function sampleNoteContent(content: string): string {
	const parts: string[] = [];

	const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
	if (frontmatter) {
		const block = frontmatter[0].trimEnd();
		parts.push(`Frontmatter:\n${block.length > SAMPLE_FRONTMATTER_LIMIT ? `${block.slice(0, SAMPLE_FRONTMATTER_LIMIT)}\n…` : block}`);
	}

	const headings = content.split(/\r?\n/).filter((line) => /^#{1,6}\s/.test(line)).slice(0, SAMPLE_HEADING_LIMIT);
	if (headings.length > 0) {
		parts.push(`Outline:\n${headings.join("\n")}`);
	}

	parts.push(`Opening:\n${content.slice(0, SAMPLE_HEAD_CHARS)}`);
	if (content.length > SAMPLE_HEAD_CHARS + SAMPLE_TAIL_CHARS) {
		const tail = content.slice(-SAMPLE_TAIL_CHARS);
		const firstBreak = tail.indexOf("\n");
		parts.push(`Closing:\n${firstBreak === -1 ? tail : tail.slice(firstBreak + 1)}`);
	}

	return parts.join("\n\n");
}

/**
 * Builds the one user message a perception request sends.
 *
 * The material goes up top in XML tags and the instruction lands at the bottom
 * — the order the prompt guides prescribe for longform data, and the tags that
 * keep note names and note bodies (which users author themselves) from reading
 * as instructions. The locally-computed facts open the block because they are
 * the only part of it that is certainly true.
 */
export function buildPerceptionPrompt(request: ScoutPerceptionRequest, language: Language): string {
	const tags = request.tags.length > 0 ? request.tags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(", ") : "none";
	const facts: string[] = [
		`Tags: ${tags}`,
		`Frontmatter: ${hasFrontmatterBlock(request.content) ? "present" : "absent"}`,
	];
	if (request.unresolvedPromises.length > 0) {
		facts.push(`Unresolved promises found locally: ${request.unresolvedPromises.join("; ")}`);
	}
	if (request.brokenLinkFixes.length > 0) {
		facts.push(
			`Broken links found locally: ${request.brokenLinkFixes.map((fix) => `[[${fix.original}]] -> [[${fix.target}]]`).join(", ")}`,
		);
	}
	if (request.suggestedMocTopic) {
		facts.push(`Emergent topic cluster: #${request.suggestedMocTopic}`);
	}

	const subject = [
		`The user is working in the note "${request.notePath}".`,
		"",
		"Facts already computed locally about this note (all accurate, do not re-derive):",
		...facts,
		"",
		`The note is ${request.content.length} characters long.`,
		"",
		sampleNoteContent(request.content),
	].join("\n");

	return `<subject>\n${subject}\n</subject>\n\n${PERCEPTION_INSTRUCTION.replace("{count}", String(MAX_SCOUT_FINDINGS)).replace("{language}", LANGUAGE_NAMES[language])}`;
}

/**
 * Reads the findings out of whatever the model answered with.
 *
 * Lenient by the same reasoning `parseSuggestedActions` documents: providers
 * wrap JSON in prose or fences, and a perception that half-survives is worth
 * showing sliced down rather than discarded. Entries missing a label or a
 * prompt are dropped; an empty result is the caller's signal that the model
 * found nothing, which is a valid answer and not a failure.
 */
export function parseScoutFindings(text: string, cap: number = MAX_SCOUT_FINDINGS): ScoutFinding[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const findings: ScoutFinding[] = [];
	// The cap counts *usable* findings, not array positions: one malformed entry
	// at the head of the array must not cost the model's second suggestion.
	for (const entry of parsed) {
		if (findings.length >= cap) {
			break;
		}
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const label = typeof record.label === "string" ? record.label.trim() : "";
		const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
		if (!label || !prompt) {
			continue;
		}
		const summary = typeof record.summary === "string" ? record.summary.trim() : "";
		findings.push({ label, prompt, ...(summary ? { summary } : {}) });
	}
	return findings;
}

/** The plain text of an assistant reply, joined across its text blocks. */
function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

/**
 * One perception request, end to end.
 *
 * `streamSimple` is injected rather than reached for, so the caller keeps its
 * transport, key, and test seam — the same `StreamFn` the agent's turns run on.
 *
 * Never throws. Every failure — transport error, aborted stop, unparseable
 * answer — resolves to `null`, which the caller reads as "nothing was
 * perceived, try again later"; only a usable answer counts as a perception,
 * the empty array included. The two are deliberately different: a `null` that
 * pinned the note's content hash would leave a note permanently unperceived
 * after one dropped request.
 */
export async function requestScoutFindings(options: {
	streamSimple: StreamFn;
	model: Model<Api>;
	request: ScoutPerceptionRequest;
	language: Language;
	signal?: AbortSignal;
	apiKey?: string;
}): Promise<ScoutFinding[] | null> {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: buildPerceptionPrompt(options.request, options.language),
				timestamp: Date.now(),
			} satisfies UserMessage,
		],
	};
	const streamOptions: SimpleStreamOptions = {
		toolChoice: "none",
		maxTokens: SCOUT_MAX_TOKENS,
		...(options.apiKey !== undefined && { apiKey: options.apiKey }),
		...(options.signal && { signal: options.signal }),
	};
	let message: AssistantMessage;
	try {
		// StreamFn is allowed to hand back the stream or a promise for it.
		const stream = await options.streamSimple(options.model, context, streamOptions);
		message = await stream.result();
	} catch {
		return null;
	}
	if (options.signal?.aborted || message.stopReason === "error" || message.stopReason === "aborted") {
		return null;
	}
	return parseScoutFindings(assistantMessageText(message));
}