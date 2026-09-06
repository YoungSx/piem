import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../../testUtils/obsidianStub";

// `ModelModal` extends Obsidian's `Modal` at module scope, so the stub has to be
// registered before the import below resolves.
installObsidianStub();

const { buildModelSuggestions } = await import("./ModelModal");
import { getBuiltinModels, getBuiltinProviders } from "../../net/builtinCatalog";
import type { ProviderListing } from "../../net/modelListingCache";
import type { ProviderConfig } from "../../modelConfig";

/**
 * The suggestion list is where "ask the endpoint" meets "ship a catalog".
 *
 * Neither source is authoritative alone: an endpoint knows what it will actually
 * accept but may implement no listing, while the shipped catalog always answers
 * and is always a snapshot. These cover the merge, because getting it wrong is
 * invisible — a suggestion list is never obviously incomplete, and an id
 * attributed to the wrong provider still looks plausible.
 */

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id: "prov-1",
		name: "My gateway",
		baseUrl: "https://gw.internal/v1",
		protocol: "openai-completions",
		apiKey: "sk-1",
		secretRef: "",
		source: "user",
		oauthFlow: "",
		...overrides,
	};
}

function listing(modelIds: string[], overrides: Partial<ProviderConfig> = {}): ProviderListing {
	return { provider: provider(overrides), modelIds };
}

/** An id the builtin catalog is certain to carry, so overlap can be tested for real. */
function someBuiltinId(): string {
	for (const name of getBuiltinProviders()) {
		const first = getBuiltinModels(name)[0];
		if (first) {
			return first.id;
		}
	}
	throw new Error("the builtin catalog is empty, which every other test would also fail on");
}

function find(suggestions: ReturnType<typeof buildModelSuggestions>, value: string) {
	return suggestions.find((entry) => entry.value === value);
}

describe("buildModelSuggestions", () => {
	it("falls back to the builtin catalog when no endpoint has answered", () => {
		const suggestions = buildModelSuggestions();
		expect(suggestions.length).toBeGreaterThan(0);
		expect(find(suggestions, someBuiltinId())).toBeDefined();
	});

	it("offers ids an endpoint reported that no shipped catalog knows", () => {
		// The case the shipped catalog can never cover: a private gateway's own id.
		const suggestions = buildModelSuggestions([listing(["internal-llm-v3"])]);
		expect(find(suggestions, "internal-llm-v3")?.description).toContain("My gateway");
	});

	it("keeps the builtin catalog alongside what endpoints reported", () => {
		const suggestions = buildModelSuggestions([listing(["internal-llm-v3"])]);
		expect(find(suggestions, "internal-llm-v3")).toBeDefined();
		expect(find(suggestions, someBuiltinId())).toBeDefined();
	});

	it("lists an id once, naming every source, rather than once per source", () => {
		const suggestions = buildModelSuggestions([
			listing(["shared-model"], { id: "prov-1", name: "Gateway A" }),
			listing(["shared-model"], { id: "prov-2", name: "Gateway B" }),
		]);

		const matches = suggestions.filter((entry) => entry.value === "shared-model");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toContain("Gateway A");
		expect(matches[0]?.description).toContain("Gateway B");
	});

	it("credits the endpoint, not the shipped catalog, for an id both carry", () => {
		// The endpoint is the authority on what it accepts, so its attribution leads.
		const shared = someBuiltinId();
		const suggestions = buildModelSuggestions([listing([shared], { name: "Gateway A" })]);

		const match = find(suggestions, shared);
		expect(match).toBeDefined();
		expect(match?.description?.startsWith("Gateway A")).toBe(true);
	});

	it("puts endpoint-reported ids ahead of catalog-only ones", () => {
		// An empty query keeps this order (see `rankSuggestions`), so it decides what
		// a user sees before typing anything.
		const suggestions = buildModelSuggestions([listing(["internal-llm-v3"])]);
		const reported = suggestions.findIndex((entry) => entry.value === "internal-llm-v3");
		const builtin = suggestions.findIndex((entry) => entry.value === someBuiltinId());

		expect(reported).toBeGreaterThanOrEqual(0);
		expect(builtin).toBeGreaterThan(reported);
	});

	it("is unaffected by which provider is selected, since it takes no selection", () => {
		// A gateway commonly serves models it did not originate, and `modelConfig.ts`
		// reserves a many-to-many future. Scoping this list to one provider would
		// have to be undone for both.
		const both = buildModelSuggestions([
			listing(["from-a"], { id: "prov-1", name: "Gateway A" }),
			listing(["from-b"], { id: "prov-2", name: "Gateway B" }),
		]);
		expect(find(both, "from-a")).toBeDefined();
		expect(find(both, "from-b")).toBeDefined();
	});

	it("tolerates an endpoint that answered with nothing", () => {
		// Unreachable, unauthorized, or implements no listing: all arrive as empty.
		const suggestions = buildModelSuggestions([listing([])]);
		expect(suggestions).toEqual(buildModelSuggestions());
	});
});
