import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { StopReason } from "@earendil-works/pi-ai";
import { describeReplyCutoff, markReplySteered } from "./replyCutoff";
import { getT } from "../i18n";

const en = getT("en");
const zh = getT("zh-cn");

/**
 * An assistant turn that ended for `stopReason`; only that field and
 * `errorMessage` matter here.
 */
function reply(stopReason: StopReason, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Half a sen" }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

describe("describeReplyCutoff", () => {
	it("reports a reply the user stopped", () => {
		const cutoff = describeReplyCutoff(reply("aborted"), en);
		expect(cutoff?.kind).toBe("stopped");
		expect(cutoff?.notice).toBe("You stopped this reply.");
	});

	it("reports a reply a steered message cut short, not as a stop", () => {
		// Same `stopReason` as the stop button — pi has no other way to record an
		// abort — so without the stamp the transcript would tell someone who
		// pressed a chip's steer action that they pressed stop (issue #289).
		const steered = reply("aborted");
		markReplySteered(steered);

		const cutoff = describeReplyCutoff(steered, en);
		expect(cutoff?.kind).toBe("steered");
		expect(cutoff?.notice).toBe("Cut short for your next message.");
	});

	it("refuses the stamp on anything but an aborted turn", () => {
		// The flag driving the stamp is per-run, and a run whose last turn landed
		// normally is a run whose interrupt lost the race. Marking it would put a
		// notice under a reply that finished.
		const landed = reply("stop");
		markReplySteered(landed);
		expect(describeReplyCutoff(landed, en)).toBeNull();

		const failed = reply("error", "boom");
		markReplySteered(failed);
		expect(describeReplyCutoff(failed, en)?.kind).toBe("failed");
	});

	it("reports a reply the model's length limit cut off", () => {
		// The regression this covers: `length` set no notice at all, so a sentence
		// the provider truncated mid-word was presented as a finished answer. pi
		// treats the same stop reason as serious enough to fail every tool call in
		// the message, so the text beside them cannot be shown as complete either.
		const cutoff = describeReplyCutoff(reply("length"), en);
		expect(cutoff?.kind).toBe("truncated");
		expect(cutoff?.notice).toBe("This reply hit the model's length limit and stopped early.");
	});

	it("says nothing about a reply that ended on its own terms", () => {
		expect(describeReplyCutoff(reply("stop"), en)).toBeNull();
		expect(describeReplyCutoff(reply("toolUse"), en)).toBeNull();
	});

	/*
	 * This case used to return `null`, on the grounds that the banner already
	 * reported it. The banner's copy does not survive the next run's departure and
	 * cannot say which turn it belonged to, so #239 moved the report here — where
	 * it is positioned, persisted with the message, and sits above the regenerate
	 * control that is the recovery.
	 */
	it("reports a turn the provider failed, in words the reader can act on", () => {
		const cutoff = describeReplyCutoff(reply("error", "504 Gateway Time-out"), en);

		expect(cutoff?.kind).toBe("failed");
		expect(cutoff?.notice).toBe("The provider did not answer in time.");
		expect(cutoff?.icon).toBe("alert-triangle");
	});

	it("keeps the provider's own words behind the sentence that summarised them", () => {
		// The classification is made from wording, so the original has to stay
		// reachable: a family guessed wrong then costs a headline, not a fact.
		const cutoff = describeReplyCutoff(reply("error", "429 quota exhausted, check billing"), en);

		expect(cutoff?.raw).toBe("429 quota exhausted, check billing");
	});

	it("still reports a failure the provider described with nothing at all", () => {
		// `raw` is present even when empty, so the renderer can tell "the provider
		// said nothing" from "not a failure". The pill renders flat in that case —
		// a disclosure that opens onto nothing would be the one dishonesty here,
		// and the `unknown` sentence already carries the news itself.
		const cutoff = describeReplyCutoff(reply("error"), en);

		expect(cutoff?.kind).toBe("failed");
		expect(cutoff?.notice).toBe("The provider did not answer, and did not say why.");
		expect(cutoff?.raw).toBe("");
	});

	it("translates every notice", () => {
		const steered = reply("aborted");
		markReplySteered(steered);
		expect(describeReplyCutoff(steered, zh)?.notice).toBe("这条回复为你的下一条消息让了路。");
		expect(describeReplyCutoff(reply("aborted"), zh)?.notice).toBe("你已停止这条回复。");
		expect(describeReplyCutoff(reply("length"), zh)?.notice).toBe("这条回复达到模型的长度上限，提前结束了。");
		expect(describeReplyCutoff(reply("error", "504 Gateway Time-out"), zh)?.notice).toBe("供应商迟迟没有回话。");
	});

	it("phrases the spoken form to continue a sentence, not to open one", () => {
		// It is appended to the reply text for a screen reader, so an upper-case
		// start would read as a new announcement mid-sentence.
		for (const stopReason of ["aborted", "length", "error"] as const) {
			const spoken = describeReplyCutoff(reply(stopReason), en)?.spoken ?? "";
			expect(spoken).not.toBe("");
			expect(spoken[0]).toBe(spoken[0]?.toLowerCase());
		}
		const steered = reply("aborted");
		markReplySteered(steered);
		const steeredSpoken = describeReplyCutoff(steered, en)?.spoken ?? "";
		expect(steeredSpoken).not.toBe("");
		expect(steeredSpoken[0]).toBe(steeredSpoken[0]?.toLowerCase());
	});
});
