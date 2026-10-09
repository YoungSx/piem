import { setIcon } from "obsidian";
import type { Setting } from "obsidian";
import type { Translator } from "../../i18n";

/**
 * Row descriptions written by outside hands — a skill's frontmatter, an MCP
 * server's URL — have no length limit, and one long one stretches its row and
 * everything under it out of the scan. Past the budget the text folds to two
 * lines with a native HTML `<details>` disclosure; the fold is a view state,
 * so the full text stays in the DOM for selection and screen readers either way.
 *
 * Deliberately not applied to diagnostics: an error message's tail is the part
 * that explains the failure, and shortening it would trade a tall row for an
 * unread one.
 */

/** Character budget past which a description folds by default. */
export const DESC_FOLD_LIMIT = 200;

/** The class marking a currently-folded description body. */
const FOLDED_CLASS = "piem-settings-desc--folded";

/**
 * Sets a row's description, folding it behind a native HTML `<details>` disclosure
 * when it runs long.
 *
 * The text lives in its own span rather than directly in `descEl` so the clamp
 * can bind to the text alone. Appends nothing when short: a short description
 * should not carry fold machinery in its DOM.
 */
export function setFoldableDescription(setting: Setting, text: string, t: Translator): void {
	const desc = setting.descEl;
	if (text.length <= DESC_FOLD_LIMIT) {
		desc.setText(text);
		return;
	}

	const body = desc.createSpan({ cls: "piem-settings-desc-body" });
	body.setText(text);
	desc.classList.add("piem-settings-desc--foldable");
	body.classList.add(FOLDED_CLASS);

	const details = desc.createEl("details", {
		cls: "piem-settings-desc-details",
	});
	const summary = details.createEl("summary", {
		cls: "piem-settings-desc-summary",
	});

	// The chevron rotates on open, matching Obsidian's native disclosure style.
	setIcon(summary.createSpan({ cls: "piem-settings-desc-icon" }), "chevron-right");
	const label = summary.createSpan({ cls: "piem-settings-desc-text" });
	label.setText(t.t("descFold.more"));

	// Stop propagation at details so setting rows don't treat clicks as a row event,
	// while letting summary click bubble to details so native toggle works.
	details.addEventListener("click", (event) => {
		event.stopPropagation();
	});

	details.addEventListener("toggle", () => {
		const folded = !details.open;
		body.classList.toggle(FOLDED_CLASS, folded);
		desc.classList.toggle("piem-settings-desc--open", !folded);
		label.setText(t.t(folded ? "descFold.more" : "descFold.less"));
	});
}
