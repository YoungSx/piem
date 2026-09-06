import { describe, expect, it } from "bun:test";
import { DEFAULT_PROMPT_QUEUE_STRATEGY, isPromptQueueStrategy } from "./queueStrategy";

describe("promptQueueStrategy", () => {
	it("defaults to the whole answer, the timing that cannot land mid-plan", () => {
		// The default is the decision, not a detail: `afterTurn` puts a message the
		// reader meant as a follow-up into the middle of a plan the reply was
		// halfway through carrying out.
		expect(DEFAULT_PROMPT_QUEUE_STRATEGY).toBe("afterRun");
	});

	it("accepts only the two timings this build implements", () => {
		expect(isPromptQueueStrategy("afterRun")).toBe(true);
		expect(isPromptQueueStrategy("afterTurn")).toBe(true);
	});

	it("rejects anything else, so a stored value cannot become a third behaviour", () => {
		// The settings parse and the dropdown write share this guard. A vault
		// carrying a value from a future release, or none at all, has to fall back
		// rather than reach the turn-boundary hook as an unhandled string.
		for (const value of ["immediately", "", "AFTERRUN", undefined, null, 0, true, {}]) {
			expect(isPromptQueueStrategy(value)).toBe(false);
		}
	});
});
