/** The tool id, in one place: render sites in the transcript key off it. */
export const PRESENT_UI_TOOL = "present_ui";

/**
 * What a `present_ui` result says about its view.
 *
 * The result reports a *delivery*, not an outcome: the view it describes may
 * still be on screen and still in use, because the tool call returns as soon as
 * the view mounts. So the render site's question is not "what did the user
 * submit" but "is this view still live" — which only the broker can answer, by
 * `id`. This carries the id to ask with, and the delivery verdict to fall back
 * on once the answer is no.
 */
export interface UIBlockOutcome {
	/** The broker instance id, or `undefined` for a result from an older build. */
	id?: string;
	title?: string;
	/** True when the view was closed before it ever reached the screen. */
	undelivered: boolean;
}

/**
 * Reads a `present_ui` result's details into the shape the transcript renders.
 *
 * `details` is untyped on `ToolResultMessage` and comes back through a session
 * file that may have been written by an older build or synced from another
 * device. Every field is validated rather than asserted.
 *
 * A result from before the lifecycle split carries `dismissed` and a `data`
 * payload instead of `uiId`/`live`. Those views cannot be live — the build that
 * made them destroyed them on return — so they read as a closed view with no id
 * to look up. Their payload is deliberately not rendered: it was the user's
 * answer to a question the transcript already shows the agent acting on.
 */
export function uiBlockOutcome(details: unknown): UIBlockOutcome | null {
	if (!details || typeof details !== "object") {
		return null;
	}
	const record = details as {
		uiId?: unknown;
		live?: unknown;
		dismissed?: unknown;
		title?: unknown;
	};

	const title = typeof record.title === "string" ? record.title : undefined;
	const id = typeof record.uiId === "string" ? record.uiId : undefined;

	if (id === undefined) {
		// Legacy shape: `dismissed` was the only outcome flag.
		return { title, undelivered: record.dismissed === true };
	}

	return { id, title, undelivered: record.live !== true };
}
