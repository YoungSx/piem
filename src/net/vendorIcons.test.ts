import { describe, expect, it } from "bun:test";

import { installObsidianStub, addIconMock } from "../testUtils/obsidianStub";
import type { VendorId } from "./vendorMatch";

// The registry reaches `obsidian` for `addIcon`; the module ships types only,
// so it has to be stubbed before that import resolves.
installObsidianStub();
const { registerVendorIcons, vendorIconName, modelIconName, VENDOR_ICON_ID_PREFIX, MODEL_FALLBACK_ICON_ID } = await import("./vendorIcons");

installObsidianStub();

/** Every vendor the matcher can answer — a missing mark here is a surface bug, not a gap. */
const ALL_VENDORS: VendorId[] = [
	"anthropic",
	"openai",
	"google",
	"deepseek",
	"groq",
	"mistral",
	"moonshotai",
	"xai",
	"zai",
	"openrouter",
	"qwen",
	"meta",
	"minimax",
];

describe("vendorIcons", () => {
	it("registers one mark per vendor under the shared prefix, plus the neutral fallback", () => {
		addIconMock.mockClear();
		registerVendorIcons();
		const registered = new Map(addIconMock.mock.calls.map(([id, svg]) => [id, svg]));
		// One per vendor, and one more for the no-vendor fallback.
		expect(registered.size).toBe(ALL_VENDORS.length + 1);
		expect(registered.get(MODEL_FALLBACK_ICON_ID)).toBeDefined();
		for (const vendor of ALL_VENDORS) {
			const name = vendorIconName(vendor) ?? "";
			expect(name).toStartWith(VENDOR_ICON_ID_PREFIX);
			expect(registered.get(name)).toBeDefined();
			// The no-vendor answer is "no icon", not a prefixed empty id.
			expect(vendorIconName(undefined)).toBeUndefined();
		}
	});

	it("is idempotent — re-registering overwrites with identical markup", () => {
		addIconMock.mockClear();
		registerVendorIcons();
		const first = new Map(addIconMock.mock.calls.map(([id, svg]) => [id, svg]));
		registerVendorIcons();
		const second = new Map(addIconMock.mock.calls.map(([id, svg]) => [id, svg]));
		expect(second.size).toBe(first.size);
		for (const [id, svg] of first) {
			expect(second.get(id)).toBe(svg);
		}
	});

	it("ships render-ready SVG: a viewBox, no fixed root size, and source that follows the text color", () => {
		addIconMock.mockClear();
		registerVendorIcons();
		for (const svg of addIconMock.mock.calls.map(([, content]) => content)) {
			expect(svg).toContain("viewBox=");
			// Obsidian's --icon-size owns the render; a root width/height would
			// fight it. (stroke-width — part of the artwork — is spelled with a
			// hyphen and excluded by this pattern.)
			expect(svg).not.toMatch(/<svg[^>]*\swidth=/);
			expect(svg).not.toMatch(/<svg[^>]*\sheight=/);
			expect(svg).toContain("currentColor");
		}
	});
});

describe("modelIconName", () => {
	it("gives a model its vendor mark, and the neutral fallback when none matches", () => {
		// Model-id match wins even through a custom gateway host.
		expect(modelIconName("claude-opus-5", "https://bf.s8p.io/v1")).toBe(`${VENDOR_ICON_ID_PREFIX}anthropic`);
		expect(modelIconName("deepseek-v4-flash", "https://bf.s8p.io/v1")).toBe(`${VENDOR_ICON_ID_PREFIX}deepseek`);
		// Official host match when the id names no family.
		expect(modelIconName("auto", "https://openrouter.ai/api/v1")).toBe(`${VENDOR_ICON_ID_PREFIX}openrouter`);
		// Neither known: the neutral fallback, never undefined.
		expect(modelIconName("sensenova-6.8-flash-lite", "https://token.sensenova.cn/v1")).toBe(MODEL_FALLBACK_ICON_ID);
		expect(modelIconName(undefined, undefined)).toBe(MODEL_FALLBACK_ICON_ID);
	});
});
