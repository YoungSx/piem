import { describe, expect, it } from "bun:test";
import { EMPTY_WORKSPACE_CONTEXT, type WorkspaceContext } from "./workspaceContext";
import { QuickActionSuggestionCache, type SuggestionCacheKey, workspaceKeyPart } from "./quickActionSuggestionCache";
import type { QuickAction } from "../ui/quickActionSuggestions";

const chips = (label: string): QuickAction[] => [{ id: "suggested-0", label, prompt: `Prompt for ${label}.` }];

const key = (language: string, notePath: string | null, workspace = ""): SuggestionCacheKey => ({ language, notePath, workspace });

describe("QuickActionSuggestionCache", () => {
	it("returns undefined for a key never answered", () => {
		const cache = new QuickActionSuggestionCache();
		expect(cache.get(key("en", "notes/a.md"))).toBeUndefined();
	});

	it("returns the stored chips for the same key", () => {
		const cache = new QuickActionSuggestionCache();
		const stored = chips("First");
		cache.set(key("en", "notes/a.md"), stored);
		expect(cache.get(key("en", "notes/a.md"))).toEqual(stored);
	});

	it("separates entries by note path, so A and B never share an answer", () => {
		const cache = new QuickActionSuggestionCache();
		cache.set(key("en", "notes/a.md"), chips("For A"));
		cache.set(key("en", "notes/b.md"), chips("For B"));
		expect(cache.get(key("en", "notes/a.md"))?.[0]?.label).toBe("For A");
		expect(cache.get(key("en", "notes/b.md"))?.[0]?.label).toBe("For B");
	});

	it("treats a null note path as its own entry, distinct from any file", () => {
		const cache = new QuickActionSuggestionCache();
		cache.set(key("en", null), chips("Vault-wide"));
		cache.set(key("en", "notes/a.md"), chips("For A"));
		expect(cache.get(key("en", null))?.[0]?.label).toBe("Vault-wide");
		expect(cache.get(key("en", "notes/a.md"))?.[0]?.label).toBe("For A");
	});

	it("separates entries by language, so a language flip does not serve old-tongue chips", () => {
		const cache = new QuickActionSuggestionCache();
		cache.set(key("en", "notes/a.md"), chips("English"));
		expect(cache.get(key("zh-cn", "notes/a.md"))).toBeUndefined();
	});

	it("separates entries by workspace, so changed open tabs do not serve chips for a room the user left", () => {
		const cache = new QuickActionSuggestionCache();
		cache.set(key("en", null, "tab-a.md|tab-b.md"), chips("With tabs"));
		expect(cache.get(key("en", null, "tab-c.md"))).toBeUndefined();
		expect(cache.get(key("en", null, "tab-a.md|tab-b.md"))?.[0]?.label).toBe("With tabs");
	});

	it("joins the workspace parts deterministically, so the key survives a round-trip", () => {
		expect(workspaceKeyPart(EMPTY_WORKSPACE_CONTEXT)).toBe("");
		expect(
			workspaceKeyPart({
				folder: { path: "notes", entries: ["a.md", "sub/"], totalEntries: 4 },
				openTabs: ["other.md"],
				recentFiles: ["old.md"],
			}),
		).toBe("notes|a.md|sub/|4|other.md|old.md");
	});

	it("overwrites in place when the same key is answered twice", () => {
		const cache = new QuickActionSuggestionCache();
		cache.set(key("en", "notes/a.md"), chips("Stale"));
		cache.set(key("en", "notes/a.md"), chips("Fresh"));
		expect(cache.get(key("en", "notes/a.md"))?.[0]?.label).toBe("Fresh");
	});

	it("evicts the least recently used entry beyond the cap", () => {
		const cache = new QuickActionSuggestionCache();
		for (let index = 0; index < 32; index += 1) {
			cache.set(key("en", `notes/${index}.md`), chips(`Note ${index}`));
		}
		// A read of the oldest entry renews it, so the next one is evicted instead.
		expect(cache.get(key("en", "notes/0.md"))?.[0]?.label).toBe("Note 0");
		cache.set(key("en", "notes/32.md"), chips("Note 32"));
		expect(cache.get(key("en", "notes/1.md"))).toBeUndefined();
		expect(cache.get(key("en", "notes/0.md"))?.[0]?.label).toBe("Note 0");
		expect(cache.get(key("en", "notes/32.md"))?.[0]?.label).toBe("Note 32");
	});

	it("clears every entry", () => {
		const cache = new QuickActionSuggestionCache();
		cache.set(key("en", "notes/a.md"), chips("First"));
		cache.clear();
		expect(cache.get(key("en", "notes/a.md"))).toBeUndefined();
	});
});
