import { describe, expect, it } from "bun:test";
import type { Keychain } from "../keychain";
import {
	resolveRequestSecrets,
	resolveSecretPlaceholders,
} from "./secretPlaceholders";

/** A keychain backed by a plain map, matching the read-only view resolution uses. */
function fakeKeychain(entries: Record<string, string>): Keychain {
	return {
		available: true,
		encrypted: true,
		read: (id) => entries[id] ?? "",
		list: () => Object.keys(entries),
	};
}

describe("resolveSecretPlaceholders", () => {
	it("substitutes a known entry and leaves the rest of the string intact", () => {
		const kc = fakeKeychain({ "my-token": "sk-live-123" });
		const { resolved, unknownIds } = resolveSecretPlaceholders(
			"Bearer {{secret:my-token}}",
			kc,
		);
		expect(resolved).toBe("Bearer sk-live-123");
		expect(unknownIds).toEqual([]);
	});

	it("substitutes every occurrence, not just the first", () => {
		const kc = fakeKeychain({ a: "1", b: "2" });
		const { resolved } = resolveSecretPlaceholders(
			"{{secret:a}}-{{secret:b}}-{{secret:a}}",
			kc,
		);
		expect(resolved).toBe("1-2-1");
	});

	it("collects unknown ids and leaves their placeholder verbatim rather than blanking it", () => {
		const kc = fakeKeychain({ known: "v" });
		const { resolved, unknownIds } = resolveSecretPlaceholders(
			"{{secret:known}} {{secret:missing}}",
			kc,
		);
		// The known one resolves; the missing one stays as text so the caller can
		// fail the tool naming it, instead of sending an empty credential.
		expect(resolved).toBe("v {{secret:missing}}");
		expect(unknownIds).toEqual(["missing"]);
	});

	it("dedupes a repeated unknown id", () => {
		const kc = fakeKeychain({});
		const { unknownIds } = resolveSecretPlaceholders(
			"{{secret:x}} {{secret:x}}",
			kc,
		);
		expect(unknownIds).toEqual(["x"]);
	});

	it("ignores a malformed placeholder rather than reading a garbage id", () => {
		// Uppercase and underscores are outside Obsidian's id grammar, so the regex
		// never matches and the text passes through untouched — a braces typo is the
		// model's to see, not a silent empty lookup.
		const kc = fakeKeychain({ MY_TOKEN: "should-not-be-read" });
		const { resolved, unknownIds } = resolveSecretPlaceholders(
			"{{secret:MY_TOKEN}}",
			kc,
		);
		expect(resolved).toBe("{{secret:MY_TOKEN}}");
		expect(unknownIds).toEqual([]);
	});

	it("returns a string with no placeholder unchanged", () => {
		const kc = fakeKeychain({ a: "1" });
		const { resolved, unknownIds } = resolveSecretPlaceholders(
			"https://example.com/path",
			kc,
		);
		expect(resolved).toBe("https://example.com/path");
		expect(unknownIds).toEqual([]);
	});
});

describe("resolveRequestSecrets", () => {
	it("resolves placeholders across url, headers, and body at once", () => {
		const kc = fakeKeychain({ tok: "T", key: "K" });
		const { resolved, unknownIds } = resolveRequestSecrets(
			{
				url: "https://api.example.com?key={{secret:key}}",
				headers: { authorization: "Bearer {{secret:tok}}" },
				body: '{"k":"{{secret:key}}"}',
			},
			kc,
		);
		expect(resolved.url).toBe("https://api.example.com?key=K");
		expect(resolved.headers).toEqual({ authorization: "Bearer T" });
		expect(resolved.body).toBe('{"k":"K"}');
		expect(unknownIds).toEqual([]);
	});

	it("leaves optional fields absent when the input omitted them", () => {
		const kc = fakeKeychain({});
		const { resolved } = resolveRequestSecrets(
			{ url: "https://example.com" },
			kc,
		);
		expect(resolved.headers).toBeUndefined();
		expect(resolved.body).toBeUndefined();
	});

	it("unions unknown ids seen anywhere in the request", () => {
		const kc = fakeKeychain({});
		const { unknownIds } = resolveRequestSecrets(
			{
				url: "https://example.com?a={{secret:one}}",
				headers: { h: "{{secret:two}}" },
				body: "{{secret:one}}",
			},
			kc,
		);
		expect(unknownIds.sort()).toEqual(["one", "two"]);
	});
});
