/**
 * The language the assistant is told to reply in, composed into the system
 * prompt as an instruction.
 *
 * This is a different thing from the interface language in {@link ../i18n}, and
 * the two are kept apart on purpose. The interface language picks which of the
 * plugin's own translation tables render its buttons and settings, so it is
 * locked to the languages this build ships copy for — English and simplified
 * Chinese. The conversation language picks which language the *model* answers
 * in, and a model speaks far more than two: locking this list to the UI tables
 * would deny a French reader French replies just because the settings screen
 * has no French translation.
 *
 * So this list stands alone. Each entry carries its own endonym for the
 * dropdown — the name a speaker calls their own language, which no translator
 * should touch — and an English name for the prompt, because the system prompt
 * is written in English and a model follows "Traditional Chinese" more reliably
 * than it follows a tag like `zh-tw`.
 *
 * `"auto"` is not in the list: it is the absence of an instruction. Selecting it
 * appends nothing and leaves the implicit behaviour untouched — the environment
 * sentence still states the interface language, and the model follows whatever
 * language the user writes in, exactly as it did before this setting existed.
 */

/** One language the assistant can be pinned to reply in. */
export interface ConversationLanguageOption {
	/** The persisted value, a BCP 47 tag. */
	code: string;
	/** The language's own name for itself, shown in the dropdown untranslated. */
	endonym: string;
	/** The English name used in the prompt instruction. */
	promptName: string;
}

/**
 * The languages offered, in the order the dropdown lists them.
 *
 * A curated set rather than every language a model knows: a dropdown of two
 * hundred entries is worse than a dozen that cover the speakers this plugin
 * actually reaches, and `"auto"` already serves anyone whose language is not
 * here — the model still follows what they write. Adding a language is one row.
 *
 * `as const satisfies` freezes each `code` into a literal (so
 * {@link ConversationLanguageSetting} is the exact union, not `string`) while
 * still checking every entry against {@link ConversationLanguageOption} — a
 * misshapen row fails to compile here rather than reaching the dropdown.
 */
export const CONVERSATION_LANGUAGES = [
	{ code: "en", endonym: "English", promptName: "English" },
	{ code: "zh-cn", endonym: "简体中文", promptName: "Simplified Chinese" },
	{ code: "zh-tw", endonym: "繁體中文", promptName: "Traditional Chinese" },
	{ code: "ja", endonym: "日本語", promptName: "Japanese" },
	{ code: "ko", endonym: "한국어", promptName: "Korean" },
	{ code: "fr", endonym: "Français", promptName: "French" },
	{ code: "de", endonym: "Deutsch", promptName: "German" },
	{ code: "es", endonym: "Español", promptName: "Spanish" },
	{ code: "pt", endonym: "Português", promptName: "Portuguese" },
	{ code: "it", endonym: "Italiano", promptName: "Italian" },
	{ code: "ru", endonym: "Русский", promptName: "Russian" },
	{ code: "ar", endonym: "العربية", promptName: "Arabic" },
] as const satisfies readonly ConversationLanguageOption[];

/** A code this build offers, e.g. `"zh-tw"`. */
export type ConversationLanguageCode = (typeof CONVERSATION_LANGUAGES)[number]["code"];

/**
 * A persisted conversation-language preference: `"auto"`, or one of the
 * {@link CONVERSATION_LANGUAGES} codes.
 */
export type ConversationLanguageSetting = "auto" | ConversationLanguageCode;

/** The default: follow the user, appending no instruction. */
export const DEFAULT_CONVERSATION_LANGUAGE: ConversationLanguageSetting = "auto";

/** Whether a persisted value names a conversation-language preference this build accepts. */
export function isConversationLanguageSetting(value: unknown): value is ConversationLanguageSetting {
	return value === "auto" || CONVERSATION_LANGUAGES.some((lang) => lang.code === value);
}

/**
 * The one sentence appended to the prompt when a language is pinned.
 *
 * An instruction, unlike the environment sentence it sits beside: `"regardless
 * of the language they write in"` is the whole point of an explicit setting —
 * the user asked in one language but wants the answer in another, which is
 * exactly the case the implicit follow-the-user behaviour cannot serve.
 */
export function renderConversationLanguageInstruction(option: ConversationLanguageOption): string {
	return `Respond to the user in ${option.promptName}, regardless of the language they write in.`;
}

/**
 * Appends the conversation-language instruction to a prompt, or returns it
 * unchanged for `"auto"`.
 *
 * The outermost suffix: its caller wraps this *around*
 * {@link ../environmentPrompt.withEnvironment}, so the instruction lands last,
 * after the environment sentence. That is deliberate — the environment is
 * background situation, but this is an instruction, and an instruction is
 * followed most reliably when it sits closest to the turn it governs rather
 * than buried above the facts. The order reads role, situation, instruction.
 *
 * An unrecognised value degrades to the `"auto"` no-op rather than composing a
 * broken sentence: the type guard is the real protection, but a hand-edited
 * `data.json` can still reach here past it.
 */
export function withConversationLanguage(prompt: string, setting: ConversationLanguageSetting): string {
	if (setting === "auto") {
		return prompt;
	}
	const option = CONVERSATION_LANGUAGES.find((lang) => lang.code === setting);
	if (!option) {
		return prompt;
	}
	return `${prompt}\n\n${renderConversationLanguageInstruction(option)}`;
}
