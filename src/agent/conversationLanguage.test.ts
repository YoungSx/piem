import { describe, expect, test } from "bun:test";
import {
	CONVERSATION_LANGUAGES,
	DEFAULT_CONVERSATION_LANGUAGE,
	isConversationLanguageSetting,
	renderConversationLanguageInstruction,
	withConversationLanguage,
} from "./conversationLanguage";

describe("isConversationLanguageSetting", () => {
	test("accepts auto", () => {
		expect(isConversationLanguageSetting("auto")).toBe(true);
	});

	test("accepts every offered code", () => {
		for (const lang of CONVERSATION_LANGUAGES) {
			expect(isConversationLanguageSetting(lang.code)).toBe(true);
		}
	});

	test("rejects a code this build does not offer", () => {
		// A plausible BCP 47 tag that is deliberately absent from the list: the
		// guard has to reject it, not wave through anything Chinese-ish.
		expect(isConversationLanguageSetting("zh-hk")).toBe(false);
	});

	test("rejects non-string junk from a hand-edited data.json", () => {
		expect(isConversationLanguageSetting(undefined)).toBe(false);
		expect(isConversationLanguageSetting(null)).toBe(false);
		expect(isConversationLanguageSetting(42)).toBe(false);
		expect(isConversationLanguageSetting({ code: "en" })).toBe(false);
	});
});

describe("the offered list", () => {
	test("defaults to auto", () => {
		expect(DEFAULT_CONVERSATION_LANGUAGE).toBe("auto");
	});

	test("carries traditional Chinese as its own entry, distinct from simplified", () => {
		// The whole reason this list is separate from the UI language tables: a
		// model speaks both, and folding zh-tw into zh-cn was the wrong direction.
		const simplified = CONVERSATION_LANGUAGES.find((lang) => lang.code === "zh-cn");
		const traditional = CONVERSATION_LANGUAGES.find((lang) => lang.code === "zh-tw");
		expect(simplified?.promptName).toBe("Simplified Chinese");
		expect(traditional?.promptName).toBe("Traditional Chinese");
		expect(traditional?.endonym).toBe("繁體中文");
	});

	test("has no auto row: auto is the absence of an instruction, not a language", () => {
		expect(CONVERSATION_LANGUAGES.some((lang) => lang.code === "auto")).toBe(false);
	});

	test("lists no code twice", () => {
		const codes = CONVERSATION_LANGUAGES.map((lang) => lang.code);
		expect(new Set(codes).size).toBe(codes.length);
	});
});

describe("renderConversationLanguageInstruction", () => {
	test("names the language and overrides the language written in", () => {
		const instruction = renderConversationLanguageInstruction({
			code: "ja",
			endonym: "日本語",
			promptName: "Japanese",
		});
		expect(instruction).toContain("Japanese");
		// The override clause is the point of an explicit setting; without it this
		// is just the implicit follow-the-user behaviour restated.
		expect(instruction).toContain("regardless of the language they write in");
	});
});

describe("withConversationLanguage", () => {
	const base = "You are Piem.";

	test("appends nothing for auto, preserving the implicit behaviour", () => {
		expect(withConversationLanguage(base, "auto")).toBe(base);
	});

	test("appends the instruction for a pinned language", () => {
		const composed = withConversationLanguage(base, "fr");
		expect(composed.startsWith(`${base}\n\n`)).toBe(true);
		expect(composed).toContain("French");
	});

	test("degrades an unrecognised value to the auto no-op", () => {
		// Past the type guard via a cast: a hand-edited data.json can reach here,
		// and a broken sentence is worse than no instruction.
		expect(withConversationLanguage(base, "k?" as never)).toBe(base);
	});
});
