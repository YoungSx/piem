import { describe, expect, it } from "bun:test";
import type { App, TFile } from "obsidian";
import { collectBacklinks, hasAnyBacklink, toLinkReferences } from "./links";

describe("hasAnyBacklink", () => {
	it("returns false when no other notes link to the target", () => {
		const file = { path: "Orphan.md" } as TFile;
		const app = {
			metadataCache: {
				resolvedLinks: {
					"A.md": { "B.md": 1 },
					"B.md": { "C.md": 2 },
				},
			},
		} as unknown as App;

		expect(hasAnyBacklink(app, file)).toBe(false);
	});

	it("returns true on the first discovered backlink without full-vault iteration", () => {
		const file = { path: "Target.md" } as TFile;
		const app = {
			metadataCache: {
				resolvedLinks: {
					"Source.md": { "Target.md": 3 },
					"Other.md": { "Unrelated.md": 1 },
				},
			},
		} as unknown as App;

		expect(hasAnyBacklink(app, file)).toBe(true);
	});

	it("works with getBacklinksForFile fast index when available", () => {
		const file = { path: "Target.md" } as TFile;
		const mockIndex = {
			data: new Map([["FastSource.md", {}]]),
		};
		const app = {
			metadataCache: {
				resolvedLinks: {
					"FastSource.md": { "Target.md": 1 },
				},
				getBacklinksForFile: () => mockIndex,
			},
		} as unknown as App;

		expect(hasAnyBacklink(app, file)).toBe(true);
	});
});

describe("collectBacklinks", () => {
	it("collects and sorts backlinks strongest-first", () => {
		const file = { path: "Target.md" } as TFile;
		const app = {
			metadataCache: {
				resolvedLinks: {
					"Weak.md": { "Target.md": 1 },
					"Strong.md": { "Target.md": 5 },
					"Unrelated.md": { "Other.md": 10 },
				},
			},
		} as unknown as App;

		const backlinks = collectBacklinks(app, file);
		expect(backlinks).toEqual([
			{ target: "Strong.md", count: 5 },
			{ target: "Weak.md", count: 1 },
		]);
	});
});

describe("toLinkReferences", () => {
	it("converts link counts map to sorted link references", () => {
		const result = toLinkReferences({ "B.md": 1, "A.md": 3 });
		expect(result).toEqual([
			{ target: "A.md", count: 3 },
			{ target: "B.md", count: 1 },
		]);
	});
});
