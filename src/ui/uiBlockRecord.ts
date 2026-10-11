/** The tool id, in one place: render sites in the transcript key off it. */
export const PRESENT_UI_TOOL = "present_ui";

/** What was submitted or decided in the UI block. */
export interface UIBlockOutcome {
	data?: Record<string, any>;
	action?: string;
	title?: string;
	/** True when the user cancelled or dismissed the block. */
	dismissed: boolean;
}

/**
 * Reads a `present_ui` result's details into the shape the receipt renders.
 *
 * `details` is untyped on `ToolResultMessage` and comes back through a session
 * file that may have been written by an older build or synced from another device.
 * Every field is validated rather than asserted.
 */
export function uiBlockOutcome(details: unknown): UIBlockOutcome | null {
	if (!details || typeof details !== "object") {
		return null;
	}
	const record = details as {
		dismissed?: unknown;
		data?: unknown;
		action?: unknown;
		title?: unknown;
	};

	const title = typeof record.title === "string" ? record.title : undefined;
	const action = typeof record.action === "string" ? record.action : undefined;

	if (record.dismissed === true) {
		return { dismissed: true, title, action };
	}

	const data =
		record.data && typeof record.data === "object" && !Array.isArray(record.data)
			? (record.data as Record<string, any>)
			: undefined;

	return {
		dismissed: false,
		data,
		action,
		title,
	};
}
