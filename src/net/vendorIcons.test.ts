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
	"github-copilot",
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
		for (const [id, svg] of addIconMock.mock.calls) {
			expect(svg).toStartWith("<svg");
			expect(svg).toEndWith("</svg>");
			expect(svg).toContain("viewBox=");
			// Width/height must be left to the consumer's CSS.
			expect(svg).not.toMatch(/<svg[^>]*\b(width|height)=/);
			// Either fill or stroke currentColor, never hard-coded hex or rgb.
			expect(svg).toMatch(/(fill|stroke)="currentColor"/);
			expect(svg).not.toMatch(/#[0-9a-fA-F]{3,6}/);
			expect(id).toStartWith("piem-");
		}
	});

	it("resolves a model to its vendor mark, or the neutral fallback when unmatched", () => {
		// Matching on id alone.
		expect(modelIconName("claude-3-opus", undefined)).toBe(VENDOR_ICON_ID_PREFIX + "anthropic");
		expect(modelIconName("openrouter/deepseek-ai/r1", undefined)).toBe(VENDOR_ICON_ID_PREFIX + "deepseek");
		// Fallback to host when id is novel.
		expect(modelIconName("custom-model-id", "https://api.openai.com/v1")).toBe(VENDOR_ICON_ID_PREFIX + "openai");
		// Fallback to generic box when neither matches.
		expect(modelIconName("custom-model-id", "https://proxy.internal/v1")).toBe(MODEL_FALLBACK_ICON_ID);
		expect(modelIconName(undefined, undefined)).toBe(MODEL_FALLBACK_ICON_ID);
	});
});
