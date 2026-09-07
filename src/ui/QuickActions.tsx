import React, { useRef } from "react";
import type { QuickAction } from "./quickActionSuggestions";
import { useStripScroll } from "./quickActionStrip";
import { useT } from "./TranslatorContext";
import { suppressOwnTooltip } from "./tooltipSuppression";

type QuickActionsLayout = "wrap" | "strip";

interface QuickActionsProps {
	/** The suggested prompts to offer; an empty row renders nothing. */
	actions: QuickAction[];
	/** Sends the tapped suggestion as the user's own prompt. */
	onSelect: (prompt: string) => void;
	/**
	 * How excess chips are handled. `wrap` folds them onto a second line —
	 * the empty screen's row, which is three fixed chips and never overflows.
	 * `strip` scrolls them sideways under a fading edge — the reply
	 * placement's row, whose six read as a palette to swipe, not a menu.
	 */
	layout?: QuickActionsLayout;
}

/**
 * A row of one-tap prompts.
 *
 * Suggested next things to ask, rendered as plain labelled chips: the label is
 * the whole control, and the fuller prompt it sends lives in the copy table,
 * so the row stays scannable while the request stays specific.
 *
 * Always rendered rather than revealed on hover — the same reasoning as
 * `ReplyActions`: hover-only controls are unreachable by touch, and this panel
 * really does run on a phone.
 */
export function QuickActions({ actions, onSelect, layout = "wrap" }: QuickActionsProps): React.JSX.Element | null {
	const t = useT();
	// The strip's hooks live above the empty-row exit: the reply placement
	// clears its actions and refills them around every turn, and a hook that
	// vanished with the row would change the call order mid-instance.
	const stripRef = useRef<HTMLDivElement | null>(null);
	// The ids are positional, so their join changes whenever the chips do —
	// which is both when the fades must be re-measured and when the row must
	// not greet its replacement still scrolled to the middle.
	useStripScroll(layout === "strip" ? stripRef : null, actions.map((action) => action.id).join("|"));

	if (actions.length === 0) {
		return null;
	}

	return (
		<div
			className={layout === "strip" ? "piem-chat__quick-actions piem-chat__quick-actions--strip" : "piem-chat__quick-actions"}
			role="group"
			aria-label={t.t("quickActions.label")}
			onMouseOver={suppressOwnTooltip}
			ref={stripRef}
		>
			{actions.map((action) => (
				<button
					key={action.id}
					type="button"
					className="piem-chat__quick-action"
					onClick={() => onSelect(action.prompt)}
				>
					{action.label}
				</button>
			))}
		</div>
	);
}
