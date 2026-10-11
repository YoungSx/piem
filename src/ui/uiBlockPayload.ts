/**
 * Makes a script's payload safe to store, inject and log.
 *
 * Everything a UI block hands back crosses three boundaries the script knows
 * nothing about: the session log on disk, the context block bound for the model,
 * and `JSON.stringify`. A DOM node reached by an event handler closure, a
 * function on an options object, a `bigint` from a byte count, or the circular
 * reference a parent/child pair makes are all ordinary things to find in UI code
 * and all fatal to at least one of those three.
 *
 * So the conversions are chosen for what each boundary can carry rather than for
 * fidelity: functions and symbols vanish (a callback is not state), `bigint`
 * becomes its decimal string, a node becomes its tag name, and a cycle becomes
 * the string `[Circular]`.
 *
 * Shared by the tool and the card because both channels — the message that
 * starts a turn and the state read on the next one — reach those same
 * boundaries. It lives in its own module so neither side has to import the
 * other.
 */

function isDOMNode(value: unknown): value is { tagName?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"nodeType" in value &&
		typeof value.nodeType === "number"
	);
}

/**
 * `ancestors` tracks the path currently being walked, not every object seen, so
 * the same object appearing twice in two sibling branches is rendered twice
 * rather than the second one being called circular. A shared reference in a DAG
 * is not a cycle, and reporting it as one loses real data.
 */
export function sanitizePayload(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "function" || typeof value === "symbol") {
			return undefined;
		}
		if (typeof value === "bigint") {
			return value.toString();
		}
		return value;
	}
	if (ancestors.has(value)) {
		return "[Circular]";
	}
	if (isDOMNode(value)) {
		const tagName = typeof value.tagName === "string" ? value.tagName.toLowerCase() : "node";
		return `[Element <${tagName}>]`;
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => sanitizePayload(item, ancestors));
		}
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const sanitized = sanitizePayload(v, ancestors);
			if (sanitized !== undefined) {
				result[k] = sanitized;
			}
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

/** A payload coerced to the object shape every channel stores. */
export function asPayloadObject(data: unknown): Record<string, unknown> {
	const sanitized = sanitizePayload(data);
	return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
		? (sanitized as Record<string, unknown>)
		: { value: sanitized ?? true };
}
