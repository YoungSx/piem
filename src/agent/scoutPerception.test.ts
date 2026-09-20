import { describe, expect, it } from "bun:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	buildPerceptionPrompt,
	hasFrontmatterBlock,
	parseScoutFindings,
	requestScoutFindings,
	sampleNoteContent,
	MAX_SCOUT_FINDINGS,
	type ScoutPerceptionRequest,
} from "./scoutPerception";

const MODEL = { id: "scout-model" } as Model<Api>;

function request(overrides: Partial<ScoutPerceptionRequest> = {}): ScoutPerceptionRequest {
	return {
		notePath: "Notes/Architecture.md",
		content: "---\ntags: [arch]\n---\n\n# Architecture\n\n正文。\n",
		tags: ["arch"],
		unresolvedPromises: [],
		brokenLinkFixes: [],
		suggestedMocTopic: null,
		...overrides,
	};
}

/**
 * A stream whose single assistant message carries `text`.
 *
 * Built from the real shape pi's stream settles on — `pi-ai`'s `end()` does not
 * emit a `done` event, so a fixture that relied on one would assert against a
 * transcript that never happens.
 */
function replyStream(text: string): StreamFn {
	const message = (): AssistantMessage =>
		({
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
		}) as unknown as AssistantMessage;
	return ((_model: Model<Api>, _context: Context, _options: SimpleStreamOptions) => ({
		result: async () => message(),
	})) as unknown as StreamFn;
}

describe("hasFrontmatterBlock", () => {
	it("accepts a closed leading block", () => {
		expect(hasFrontmatterBlock("---\ntags: [a]\n---\n\nbody")).toBe(true);
	});

	it("rejects a note with no block, and an unterminated one", () => {
		expect(hasFrontmatterBlock("# Title\n\nbody")).toBe(false);
		// An unterminated `---` is a malformed note, not a frontmatter one; the
		// prompt reports it absent and hands the model the raw opening to judge.
		expect(hasFrontmatterBlock("---\ntags: [a]\n\nbody")).toBe(false);
	});
});

describe("sampleNoteContent", () => {
	it("keeps the head, the outline and the tail of a long note", () => {
		const long = `---\ntags: [a]\n---\n\n# Title\n\n## Section\n\n${"x".repeat(5_000)}\n\nCONCLUSION: done.`;
		const sample = sampleNoteContent(long);

		expect(sample).toContain("Frontmatter:");
		expect(sample).toContain("Outline:\n# Title\n## Section");
		expect(sample).toContain("Opening:");
		// The conclusion lives at the bottom, which is where a head-only excerpt
		// would have lost it.
		expect(sample).toContain("CONCLUSION: done.");
	});

	it("says nothing about an outline a short note does not have", () => {
		const sample = sampleNoteContent("just a line");
		expect(sample).not.toContain("Outline:");
		expect(sample).not.toContain("Frontmatter:");
	});
});

describe("buildPerceptionPrompt", () => {
	it("injects the local audit so the model does not re-derive it", () => {
		const prompt = buildPerceptionPrompt(
			request({
				unresolvedPromises: ["待验证：缓存失效"],
				brokenLinkFixes: [{ original: "old", target: "New" }],
				suggestedMocTopic: "arch",
			}),
			"zh-cn",
		);

		expect(prompt).toContain("Unresolved promises found locally: 待验证：缓存失效");
		expect(prompt).toContain("Broken links found locally: [[old]] -> [[New]]");
		expect(prompt).toContain("Emergent topic cluster: #arch");
		expect(prompt).toContain("Tags: #arch");
		expect(prompt).toContain("Frontmatter: present");
		// The output language is named in words the model reads, not a locale code.
		expect(prompt).toContain("简体中文");
		expect(prompt).toContain(`at most ${MAX_SCOUT_FINDINGS} objects`);
	});
});

describe("parseScoutFindings", () => {
	it("reads findings out of a fenced or chatty answer", () => {
		const parsed = parseScoutFindings('Here you go:\n```json\n[{"label":"2 处矛盾","prompt":"修正这两处。","summary":"A 与 B 冲突。"}]\n```');
		expect(parsed).toEqual([{ label: "2 处矛盾", prompt: "修正这两处。", summary: "A 与 B 冲突。" }]);
	});

	it("reads an empty array as a valid perception", () => {
		expect(parseScoutFindings("[]")).toEqual([]);
	});

	it("drops entries missing a label or a prompt, and caps the rest", () => {
		const parsed = parseScoutFindings(
			JSON.stringify([
				{ label: "ok", prompt: "do it" },
				{ label: "", prompt: "no label" },
				{ label: "no prompt", prompt: "" },
				{ label: "second", prompt: "do it too" },
				{ label: "third", prompt: "and this" },
				{ label: "fourth", prompt: "past the cap" },
			]),
		);
		expect(parsed.map((entry) => entry.label)).toEqual(["ok", "second", "third"]);
	});

	it("returns nothing for prose with no array in it", () => {
		expect(parseScoutFindings("I could not find any problems.")).toEqual([]);
	});
});

describe("requestScoutFindings", () => {
	it("returns the parsed findings", async () => {
		const findings = await requestScoutFindings({
			streamSimple: replyStream('[{"label":"缺 Frontmatter","prompt":"补上 tags 与 updated。"}]'),
			model: MODEL,
			request: request(),
			language: "zh-cn",
		});
		expect(findings).toEqual([{ label: "缺 Frontmatter", prompt: "补上 tags 与 updated。" }]);
	});

	it("returns null — not an empty perception — when the transport throws", async () => {
		const throwing = (() => {
			throw new Error("network down");
		}) as unknown as StreamFn;
		const findings = await requestScoutFindings({
			streamSimple: throwing,
			model: MODEL,
			request: request(),
			language: "en",
		});
		expect(findings).toBeNull();
	});

	it("returns null when the answer is empty", async () => {
		const findings = await requestScoutFindings({
			streamSimple: replyStream("[]"),
			model: MODEL,
			request: request(),
			language: "en",
		});
		// An empty array is a real answer, distinct from a failed one.
		expect(findings).toEqual([]);
	});
});