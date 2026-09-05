import { describe, expect, it } from "bun:test";
import { debounce, getAllTags, prepareFuzzySearch, sortSearchResults, ToggleStub } from "./obsidianStub";
import { installDom } from "./dom";

const document = installDom();

/**
 * The stub's own semantics, independent of any consumer.
 *
 * These assertions are what keeps the shared obsidian stub honest: every tag,
 * debounce, or fuzzy-search test elsewhere in the suite runs against this code,
 * so a wrong stub makes those suites pass while encoding wrong behavior. The
 * fuzzy assertions here intentionally avoid absolute scores — the stub's scoring
 * is a stand-in, documented as such on `prepareFuzzySearch`.
 */
describe("obsidianStub", () => {
	describe("getAllTags", () => {
		it("returns null for a nullish cache", () => {
			expect(getAllTags(null as never)).toBeNull();
			expect(getAllTags(undefined as never)).toBeNull();
		});

		it("combines frontmatter tags first, then body tags", () => {
			expect(
				getAllTags({
					tags: [{ tag: "#body-tag", position: {} as never }],
					frontmatter: { tags: "fm-tag" },
				} as never),
			).toEqual(["#fm-tag", "#body-tag"]);
		});

		it("prefixes frontmatter tags with # and keeps body tags as held", () => {
			// Mirrors the real 1.8.10 implementation (see the provenance note on
			// getAllTags): frontmatter declarations are normalized, body tags pass
			// through as `TagCache` holds them.
			expect(
				getAllTags({
					tags: [{ tag: "#one", position: {} as never }],
					frontmatter: { tag: "two" },
				} as never),
			).toEqual(["#two", "#one"]);
			expect(getAllTags({ frontmatter: { tags: ["#kept"] } } as never)).toEqual(["#kept"]);
		});

		it("splits a comma- or space-separated frontmatter scalar", () => {
			expect(getAllTags({ frontmatter: { tags: "alpha, beta gamma" } } as never)).toEqual([
				"#alpha",
				"#beta",
				"#gamma",
			]);
		});

		it("accepts a frontmatter array and keeps only strings", () => {
			expect(getAllTags({ frontmatter: { tags: ["a", 3, "b"] } } as never)).toEqual(["#a", "#b"]);
		});

		it("does not deduplicate — callers do", () => {
			expect(
				getAllTags({
					tags: [{ tag: "#same", position: {} as never }],
					frontmatter: { tags: "#same" },
				} as never),
			).toEqual(["#same", "#same"]);
		});

		it("yields an empty array when neither source has tags", () => {
			expect(getAllTags({} as never)).toEqual([]);
		});
	});

	describe("prepareFuzzySearch", () => {
		it("matches in-order subsequences, not just prefixes", () => {
			// The failure mode #101 exists for: query abbreviations landing in the
			// middle of a command name.
			expect(prepareFuzzySearch("org")("tag-organize")).not.toBeNull();
			expect(prepareFuzzySearch("tg")("tag-organize")).not.toBeNull();
		});

		it("rejects text that cannot contain the query in order", () => {
			expect(prepareFuzzySearch("lg")("tag-organize")).toBeNull();
			expect(prepareFuzzySearch("org")("organize-tag")).not.toBeNull();
		});

		it("matches case-insensitively", () => {
			expect(prepareFuzzySearch("ORG")("Tag-Organize")).not.toBeNull();
		});

		it("collapses adjacent hits into one range and separates gaps", () => {
			const result = prepareFuzzySearch("org")("tag-organize");
			expect(result?.matches).toEqual([[4, 7]]);
			const gapped = prepareFuzzySearch("oz")("tag-organize");
			expect(gapped?.matches).toEqual([[4, 5], [10, 11]]);
		});

		it("matches everything on an empty query", () => {
			const result = prepareFuzzySearch("")("anything");
			expect(result).not.toBeNull();
			expect(result?.matches).toEqual([]);
		});

		it("ranks a shorter text above a longer one", () => {
			const search = prepareFuzzySearch("org");
			const short = search("organize");
			const long = search("tag-organize");
			expect(short!.score).toBeGreaterThan(long!.score);
		});
	});

	describe("sortSearchResults", () => {
		it("orders best match first, in place", () => {
			const results = [
				{ match: { score: 1, matches: [] } },
				{ match: { score: 9, matches: [] } },
				{ match: { score: 5, matches: [] } },
			];
			sortSearchResults(results);
			expect(results.map((entry) => entry.match.score)).toEqual([9, 5, 1]);
		});
	});

	describe("debounce", () => {
		it("fires once after the timeout with the latest args", async () => {
			const calls: number[] = [];
			const debounced = debounce((value: number) => calls.push(value), 10);
			debounced(1);
			debounced(2);
			expect(calls).toEqual([]);
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(calls).toEqual([2]);
		});

		it("run() executes the pending call immediately with the latest args", async () => {
			const calls: number[] = [];
			const debounced = debounce((value: number) => {
				calls.push(value);
				return value * 10;
			}, 60);
			debounced(1);
			debounced(2);
			const returned = debounced.run();
			expect(calls).toEqual([2]);
			expect(returned).toBe(20);
			// The timer is spent; the timeout must not fire a second time.
			await new Promise((resolve) => setTimeout(resolve, 70));
			expect(calls).toEqual([2]);
		});

		it("run() is a no-op with nothing pending", () => {
			const calls: number[] = [];
			const debounced = debounce((value: number) => calls.push(value), 10);
			expect(debounced.run()).toBeUndefined();
			expect(calls).toEqual([]);
		});

		it("cancel() drops the pending call", async () => {
			const calls: number[] = [];
			const debounced = debounce((value: number) => calls.push(value), 10);
			debounced(1);
			debounced.cancel();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(calls).toEqual([]);
		});

		it("without resetTimer, later calls do not push the deadline back", async () => {
			const calls: number[] = [];
			const debounced = debounce((value: number) => calls.push(value), 15);
			debounced(1);
			await new Promise((resolve) => setTimeout(resolve, 10));
			debounced(2);
			// 20ms after the first call: the original deadline (15ms) has passed,
			// so the pending call — now carrying the newest args — has fired.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(calls).toEqual([2]);
		});

		it("with resetTimer, each call restarts the clock", async () => {
			const calls: number[] = [];
			const debounced = debounce((value: number) => calls.push(value), 15, true);
			debounced(1);
			await new Promise((resolve) => setTimeout(resolve, 10));
			debounced(2);
			// 20ms after the first call, but only 10ms after the reset — still pending.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(calls).toEqual([]);
			await new Promise((resolve) => setTimeout(resolve, 15));
			expect(calls).toEqual([2]);
		});

		it("returns the debouncer itself, so run/cancel stay chainable", () => {
			const debounced = debounce(() => undefined, 10);
			expect(debounced()).toBe(debounced);
			expect(debounced.cancel()).toBe(debounced);
		});
	});

	/**
	 * The one thing this stub's toggle could get wrong without any consumer
	 * noticing: whether a programmatic `setValue` notifies.
	 *
	 * Obsidian's does — 1.13.7 ships
	 * `this.on !== value && (this.on = value, …, this.changeCallback?.(value))` —
	 * so a handler that corrects its own control re-enters itself. While this stub
	 * set the value silently, an MCP row that did exactly that passed every test
	 * and shipped a switch that could not be turned off.
	 */
	describe("ToggleStub", () => {
		function build(seed: boolean): { toggle: ToggleStub; seen: boolean[] } {
			const parent = document.createElement("div");
			const toggle = new ToggleStub(parent);
			toggle.setValue(seed);
			const seen: boolean[] = [];
			toggle.onChange((value) => seen.push(value));
			return { toggle, seen };
		}

		it("setValue notifies when it changes the value", () => {
			const control = build(false);
			control.toggle.setValue(true);
			expect(control.seen).toEqual([true]);
			expect(control.toggle.getValue()).toBe(true);
		});

		it("setValue holding the same value notifies nobody", () => {
			const control = build(true);
			control.toggle.setValue(true);
			expect(control.seen).toEqual([]);
		});

		it("a user's flip notifies exactly once", () => {
			const control = build(true);
			control.toggle.toggle(false);
			expect(control.seen).toEqual([false]);
		});
	});
});
