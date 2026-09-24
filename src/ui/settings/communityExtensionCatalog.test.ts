import { describe, expect, it } from "bun:test";
import { COMMUNITY_EXTENSION_CATALOG } from "./communityExtensionCatalog";

// The ids communityHost loads by default (its static list in communityHost.ts).
// Kept here as the spec: if a bundled extension is added there, this list and
// the assertions below must move in lockstep — and that edit is the reminder to
// decide whether the newcomer earns a user-facing switch.
const ALL_COMMUNITY_IDS = [
	"pi-invisible-continue",
	"pi-assistant-provenance",
	"pi-model-switch",
	"pi-web-search",
	"pi-clarify",
	"pi-context",
	"@juicesharp/rpiv-todo",
	"@geminixiang/pi-agent-team",
	"pi-otel",
];

describe("community extension catalog", () => {
	const ids = COMMUNITY_EXTENSION_CATALOG.map((row) => row.id);

	it("lists only ids communityHost actually loads", () => {
		for (const id of ids) expect(ALL_COMMUNITY_IDS).toContain(id);
	});

	it("omits exactly OTel, which the diagnostics switch already governs", () => {
		const omitted = ALL_COMMUNITY_IDS.filter((id) => !ids.includes(id));
		expect(omitted).toEqual(["pi-otel"]);
	});

	it("carries no duplicate rows", () => {
		expect(new Set(ids).size).toBe(ids.length);
	});
});
