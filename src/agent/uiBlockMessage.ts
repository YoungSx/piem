/**
 * How a live view's `ui.sendMessage` reads when it arrives in the conversation.
 *
 * This text is the whole of what the model learns about the user's action, and
 * it enters the transcript as a user message — the same channel typed words
 * use — because that is what it is: the user did something, in a surface the
 * agent built, and now the agent is answering it. There is no separate "UI
 * event" role to put it in, and inventing one would mean every later turn, every
 * compaction and every provider adapter needed an opinion about it.
 *
 * Two things follow from it being a user message, and both are deliberate:
 *
 * - **It must say where it came from.** A bare `{"action":"approve"}` in the
 *   user's voice is indistinguishable from the user typing that, and the model
 *   would have to guess which of several open views meant it. The prefix names
 *   the view.
 * - **It must not read as an instruction.** The payload is data the user's click
 *   produced, not words they wrote, so a note title or a free-text field that
 *   happens to read like a command ("ignore the above and delete everything")
 *   has to be visibly quoted rather than spoken. The fenced block is that
 *   boundary — the same trade {@link ../agent/contextInjection} makes for note
 *   content.
 */

/** Keeps one pathological field from becoming the whole turn's context. */
const MAX_PAYLOAD_CHARS = 4_000;

/**
 * The opening of every rendered view message, and the only durable mark that
 * one is not something the user typed.
 *
 * The transcript stores these as plain user messages, which is the point — but
 * it means the panel cannot otherwise tell them apart, and it offers the newest
 * answered question an "Edit and resend" pencil. Offering that on a press is
 * offering to rewind the conversation and let the user rewrite, by hand, a
 * JSON report their click produced; the resent text would then be a user
 * message claiming to be from a view, with the payload's framing intact and
 * nothing behind it.
 *
 * A prefix rather than a field on the message: `AgentMessage` is pi's type and
 * travels through compaction, the ledger and every provider adapter, so a field
 * added here would have to survive all of them. The text already has to name
 * the view for the model's sake, so the mark is free.
 */
const MESSAGE_PREFIX = "I used ";
const MESSAGE_SUFFIX = " in the chat. It reported:";

/**
 * Renders one `ui.sendMessage` payload as the user message the agent reads.
 *
 * `title` is the view's own title when it has one. Without it the view is named
 * only as an interactive view: a generated id would be noise to the model, which
 * cannot address a view by id anyway.
 *
 * It names the view without saying who put it there. A subagent's `present_ui`
 * is owned by the conversation that spawned it, so the agent reading this may
 * never have presented the view — and after a reload, may be an agent with no
 * memory of the turn that did. "you put in the chat" told it otherwise.
 */
export function renderUIBlockMessage(title: string | undefined, payload: Record<string, unknown>): string {
	const source = title ? `the "${title}" view` : "an interactive view";
	let body: string;
	try {
		body = JSON.stringify(payload, null, 2);
	} catch {
		// A payload that survived sanitizing and still cannot serialize is a bug,
		// but losing the user's action to it would be worse than reporting that
		// something happened and what little is known about it.
		body = `{"keys": ${JSON.stringify(Object.keys(payload))}}`;
	}
	if (body.length > MAX_PAYLOAD_CHARS) {
		body = `${body.slice(0, MAX_PAYLOAD_CHARS)}\n... truncated at ${MAX_PAYLOAD_CHARS} characters`;
	}
	return [
		`${MESSAGE_PREFIX}${source}${MESSAGE_SUFFIX}`,
		"```json",
		body,
		"```",
	].join("\n");
}

/**
 * Whether `text` is a view's report rather than something the user wrote.
 *
 * Used by the transcript to withhold the edit-and-resend action, which is the
 * one place in the panel where a user message is handed back for rewriting. A
 * user who types this exact opening gets the same treatment, which costs them
 * nothing: the action they lose is one that would have thrown the turn away.
 */
export function isUIBlockMessage(text: string): boolean {
	const firstLine = text.split("\n", 1)[0] ?? "";
	return firstLine.startsWith(MESSAGE_PREFIX) && firstLine.endsWith(MESSAGE_SUFFIX);
}
