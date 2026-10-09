import { describe, expect, it } from "bun:test";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub } from "../../testUtils/obsidianStub";
import type { Translator } from "../../i18n";

const document = installDom();
installObsidianDomHelpers();
installObsidianStub();

// Everything from descFold imports after the stub: the module's own obsidian
// import must resolve against the mock, and a static import would race it.
const { DESC_FOLD_LIMIT, setFoldableDescription } = await import("./descFold");
const { Setting } = await import("obsidian");

/**
 * The fold is two decisions visible in the DOM: whether a description ships
 * with fold machinery at all, and which side of the disclosure the text sits on.
 * Both are read back from the rendered row — classes, open state, label text —
 * because those are what a keyboard user and the stylesheet each consume.
 *
 * The folded class is asserted on the body span itself, the element the
 * stylesheet's clamp selector binds to.
 *
 * The fake translator echoes the copy path, so label text doubles as proof of
 * which i18n branch produced it.
 */
describe("setFoldableDescription", () => {
	const t = { t: (path: string) => path, lang: "en" } as unknown as Translator;

	function renderRow(text: string): {
		desc: HTMLElement;
		body: HTMLElement;
		details: HTMLDetailsElement | null;
		summary: HTMLElement | null;
	} {
		const host = document.createElement("div");
		const setting = new (Setting as new (el: HTMLElement) => { descEl: HTMLElement })(host);
		setFoldableDescription(setting as never, text, t);
		const desc = setting.descEl;
		const body = desc.querySelector(".piem-settings-desc-body") as HTMLElement;
		const details = desc.querySelector("details");
		const summary = desc.querySelector("summary");
		return { desc, body, details, summary };
	}

	it("short descriptions stay plain — no body span, no details", () => {
		const row = renderRow("short");
		expect(row.body).toBeNull();
		expect(row.details).toBeNull();
	});

	it("long descriptions fold by default and expose the fold to the stylesheet", () => {
		const row = renderRow("x".repeat(DESC_FOLD_LIMIT + 1));
		expect(row.body.textContent).toBe("x".repeat(DESC_FOLD_LIMIT + 1));
		expect(row.body.classList.contains("piem-settings-desc--folded")).toBe(true);
		expect(row.desc.classList.contains("piem-settings-desc--foldable")).toBe(true);
		expect(row.details?.open).toBe(false);
		expect(row.summary?.querySelector(".piem-settings-desc-text")?.textContent).toBe("descFold.more");
		expect(row.summary?.querySelector(".piem-settings-desc-icon")).not.toBeNull();
	});

	it("the summary toggles details open and closed, flipping its label and body class", () => {
		const row = renderRow("x".repeat(DESC_FOLD_LIMIT + 1));
		row.summary!.click();
		expect(row.details!.open).toBe(true);
		expect(row.body.classList.contains("piem-settings-desc--folded")).toBe(false);
		expect(row.desc.classList.contains("piem-settings-desc--open")).toBe(true);
		expect(row.summary!.querySelector(".piem-settings-desc-text")!.textContent).toBe("descFold.less");

		row.summary!.click();
		expect(row.details!.open).toBe(false);
		expect(row.body.classList.contains("piem-settings-desc--folded")).toBe(true);
		expect(row.desc.classList.contains("piem-settings-desc--open")).toBe(false);
		expect(row.summary!.querySelector(".piem-settings-desc-text")!.textContent).toBe("descFold.more");
	});
});
