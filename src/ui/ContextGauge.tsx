import React, { useId, useRef, useState } from "react";
import { formatCost, formatTokens } from "../agent/usage";
import type { ContextFill, UsageTotals } from "../agent/usage";
import { IconButton } from "./ObsidianIcon";
import { usePointerDownOutside } from "./usePointerDownOutside";
import { suppressOwnTooltip } from "./tooltipSuppression";
import {
	contextCacheLine,
	contextGaugeName,
	contextLevel,
	contextLongCacheNote,
	contextPercent,
	contextReasoningNote,
	contextStateText,
	contextTokenSummary,
	meterTitle,
	tidyLabel,
} from "./headerCopy";
import { useT } from "./TranslatorContext";

/**
 * Radius of the gauge ring in the 16×16 viewBox, and the circumference the
 * dash offset is computed against.
 *
 * Derived once here rather than written into the stylesheet as a magic number:
 * `stroke-dashoffset` has to be expressed in the same user units as the
 * circumference, so the two must be kept in step. Changing `r` changes the
 * dash length, and nothing else has to move.
 */
const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface ContextGaugeProps {
	/** Occupancy, or null before the first measurement. Null renders nothing. */
	fill: ContextFill | null;
	/** Cumulative tokens and spend, with the cache/reasoning breakdown; shown in the popover behind the details tier. */
	usage: UsageTotals;
	/** Whether the panel may show agent-internal readouts (spend, raw counts). */
	showAgentDetails: boolean;
	/** A turn is in flight, so compaction cannot start. */
	isStreaming: boolean;
	/** A compaction request is already in flight. */
	isCompacting: boolean;
	/** Runs the same on-demand compaction as the command palette entry. */
	onTidy: () => void;
}

/**
 * How full the context window is, as a ring beside Send.
 *
 * This replaces a full-width readout — the word "Context", a 4.5rem bar, and
 * "~12.4k / 1.00M, ok" — that spent a whole row of a 300px sidebar on a value
 * consulted rather than read. A ring is a worse instrument for reading a
 * proportion (nobody tells 60% from 75% at 16px) and that is the trade: the
 * precision moved into the popover, and the glyph is left carrying the one
 * question that has to be answerable at a glance, which is whether the level is
 * fine, filling, or about to cost the user their turn. That is a colour's job,
 * not a length's.
 *
 * Shown unconditionally rather than behind the agent-details tier, unlike the
 * readout it replaces. Hiding it was the right call for a row of numbers that
 * also had to teach the word "context"; it is the wrong call for a glyph that
 * costs no height and teaches nothing, because running out of context is a wall
 * every reader hits, not just the ones watching token counts. Spend and raw
 * totals stay behind the tier — how much it costs is a different question from
 * how much room is left.
 *
 * A `<button>`, not the `role="progressbar"` this used to be. That loses a
 * machine-readable `aria-valuenow`, and it is a deliberate loss: at 16px the
 * numbers only exist inside the popover, so the button's accessible name carries
 * the full readout instead — the value survives without the role.
 *
 * A press opens it, and nothing else does: a click, a tap, or Enter/Space on the
 * focused ring. Hover used to open it as well, and focus used to pin it, and the
 * three could not be reconciled — the pointer and the press fire into one state
 * in an order neither of them chooses. A tap arrives as `pointerover` *then*
 * `click`, so hover opened the popover and the tap's own click shut it again; a
 * mouse click arrives as `focus` *then* `click`, so opening on focus is closed by
 * the very click that focused it. One trigger has no ordering left to lose:
 * whatever opened it is what closes it. The keyboard keeps its way in, because
 * Enter and Space on a `<button>` *are* clicks — that is what a disclosure is
 * meant to answer to, and Tab-to-open is the part ARIA never asked for.
 *
 * Not an {@link IconButton}, but it wears the same two classes by hand. The
 * component is the wrong shape here — it renders a Lucide glyph via `setIcon`,
 * and this button's content is an inline `<svg>` whose arc is driven by a custom
 * property — yet `clickable-icon` is not optional. Obsidian styles every
 * `button:not(.clickable-icon)` as a filled form control at a specificity a
 * plain class cannot outrank, so dropping the class does not free the glyph from
 * the theme's button chrome; it hands the glyph to it. The 0.85 icon opacity that
 * comes with the class, which would otherwise dilute the warn and near bands, is
 * pinned back to 1 through `--icon-opacity` in `styles.css`.
 */
export function ContextGauge({
	fill,
	usage,
	showAgentDetails,
	isStreaming,
	isCompacting,
	onTidy,
}: ContextGaugeProps): React.JSX.Element | null {
	const t = useT();
	/*
	 * A plain boolean, now that a press is the only way in.
	 *
	 * This used to record *how* it opened, because a hover-opened popover had to
	 * close when the pointer left while a pressed one had to survive that — the
	 * pointer travels through a gap on its way to the tidy button inside. With
	 * hover gone there is one close rule, so there is nothing left for the state
	 * to disambiguate.
	 */
	const [isOpen, setIsOpen] = useState(false);
	const wrapperRef = useRef<HTMLSpanElement | null>(null);
	// Wires the ring to the popover it opens, for assistive tech that announces
	// what a toggle controls. `useId` because nothing else guarantees a single
	// panel per workspace: a stable literal would collide if two ever mounted.
	const popoverId = useId();

	const closeNow = (): void => setIsOpen(false);

	/*
	 * An open popover is dismissed by pressing elsewhere.
	 *
	 * Blur alone does not cover it: tapping outside does not reliably move focus
	 * on iOS Safari, which leaves a touch reader with an open panel and nowhere
	 * obvious to tap. It matters more now than it did — with hover gone, there is
	 * no pointer-leave doing this job for a mouse either. The full rule —
	 * including the document it has to listen on to survive a popout window —
	 * lives in `usePointerDownOutside`, shared with `SubagentEntryIcon`.
	 */
	usePointerDownOutside(wrapperRef, isOpen, closeNow);

	/*
	 * The one trigger: press to open, press again to close.
	 *
	 * Nothing here inspects `pointerType`. That check existed because touch fired
	 * the hover path on its way in; with only the press path left, every input
	 * takes the same route and there is no second opinion to reconcile.
	 */
	const toggle = (): void => setIsOpen((current) => !current);

	// Null is "not measured yet", not "0% used". An empty ring would state the
	// second, so there is nothing honest to draw until the first measurement.
	if (!fill) {
		return null;
	}

	const level = contextLevel(fill);
	const ratio = Math.min(Math.max(fill.ratio, 0), 1);
	const ringStyle = {
		"--pi-context-circumference": RING_CIRCUMFERENCE,
		"--pi-context-ratio": ratio,
	} as React.CSSProperties;

	return (
		<span
			className={`piem-chat__context piem-chat__context--${level}`}
			ref={wrapperRef}
			/*
			 * No `onPointerEnter`/`onPointerLeave`, and deliberately no `onFocus`
			 * either. Tab lands on the ring without opening anything; Enter or Space
			 * then opens it through the click path. Opening on focus would not merely
			 * be a stray ARIA behaviour, it would break the pointer: a mouse click
			 * focuses before it clicks, so the focus-open and the click-toggle would
			 * cancel out and the ring would look dead.
			 *
			 * `onBlur` stays. Focus leaving the ring *and* the popover is a keyboard
			 * reader walking away from a floating panel that overlays the draft, and
			 * nothing else would fold it up for them.
			 */
			onBlur={(event) => {
				// Focus moving to the tidy button inside the popover must not close it.
				if (!event.currentTarget.contains(event.relatedTarget)) {
					closeNow();
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape" && isOpen) {
					event.stopPropagation();
					closeNow();
					wrapperRef.current?.querySelector<HTMLButtonElement>(".piem-chat__context-gauge")?.focus();
				}
			}}
		>
			<button
				type="button"
				/*
				 * `clickable-icon` is load-bearing, not cosmetic: without it Obsidian's
				 * `button:not(.clickable-icon)` rule wins over anything this stylesheet
				 * says and wraps the ring in a filled, rounded control box. See the rule
				 * in `styles.css` for the specificity arithmetic and for why the opacity
				 * that class carries is answered with a token rather than by opting out.
				 */
				className="clickable-icon piem-chat__icon-button piem-chat__context-gauge"
				aria-expanded={isOpen}
				aria-controls={popoverId}
				aria-label={contextGaugeName(fill, t)}
				/*
				 * Swallows the tooltip Obsidian hangs off this label on hover. Kept
				 * after hover stopped opening the popover, because the collision it
				 * avoids is still there: the label is the whole readout, the pointer
				 * is still resting on the ring once the popover is open, and the
				 * tooltip would surface beside the panel repeating its own first
				 * line. The accessible name survives — the event stops here, the
				 * attribute is never touched. The handler sits on the button, not
				 * the wrapper, so the tidy button's deliberate disabled-reason
				 * tooltip inside the popover still reaches Obsidian.
				 */
				onMouseOver={suppressOwnTooltip}
				onClick={toggle}
			>
				{/*
				 * `stroke-dashoffset` rather than a width or an arc path: it paints
				 * without reflowing, the way the bar it replaces animated a transform
				 * rather than a width. The ring starts at 12 o'clock (rotated in CSS) and
				 * `stroke-linecap: round` leaves a visible dot at 1%, which reads as
				 * "just started" instead of "empty circle, probably broken".
				 */}
				<svg className="piem-chat__context-ring" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
					<circle className="piem-chat__context-ring-track" cx="8" cy="8" r={RING_RADIUS} />
					<circle className="piem-chat__context-ring-fill" cx="8" cy="8" r={RING_RADIUS} style={ringStyle} />
				</svg>
			</button>
			{isOpen ? (
				<ContextPopover
					id={popoverId}
					fill={fill}
					usage={usage}
					showAgentDetails={showAgentDetails}
					isStreaming={isStreaming}
					isCompacting={isCompacting}
					onTidy={() => {
						// Close before running: the outcome is reported by the status bar
						// ("Tidying up earlier messages…"), and a popover left open would
						// compete with it for the same sentence.
						closeNow();
						onTidy();
					}}
				/>
			) : null}
		</span>
	);
}

interface ContextPopoverProps extends Omit<ContextGaugeProps, "fill"> {
	fill: ContextFill;
	/** The id the ring's `aria-controls` points at; minted once in the gauge. */
	id: string;
}

/**
 * The numbers the ring cannot carry, plus the one action they imply.
 *
 * Not `role="tooltip"`. ARIA does not allow a tooltip to own focusable content,
 * and a screen reader may skip the whole subtree — which would take the tidy
 * button with it. A plain labelled group keeps the button reachable.
 */
function ContextPopover({
	id,
	fill,
	usage,
	showAgentDetails,
	isStreaming,
	isCompacting,
	onTidy,
}: ContextPopoverProps): React.JSX.Element {
	const t = useT();
	const level = contextLevel(fill);
	const isBusy = isStreaming || isCompacting;
	// Same tier as spend, but gated per line: a provider without a prompt cache
	// reports the cache fields as 0 (not absent), a provider without a thinking
	// split omits `reasoning`, and only Anthropic reports the hour-long share of a
	// cache write — so each line answers for itself instead of assuming the session
	// carries a breakdown at all.
	const detailsVisible = showAgentDetails && usage.requests > 0;
	const cacheLine = detailsVisible ? contextCacheLine(usage, t) : undefined;
	const longCacheNote = detailsVisible ? contextLongCacheNote(usage, t) : undefined;
	const reasoningNote = detailsVisible ? contextReasoningNote(usage, t) : undefined;

	return (
		// The popover's own label is for the screen reader's grouping; hovering its
		// padding should not surface it as a tooltip beside the readout it names.
		<div
			id={id}
			className="piem-chat__context-popover"
			role="group"
			aria-label={t.t("chat.contextAria")}
			onMouseOver={suppressOwnTooltip}
		>
			<span className="piem-chat__context-value">
				{contextTokenSummary(fill)} <span aria-hidden="true">·</span> {contextPercent(fill)}%
			</span>
			{/* The level named in words, not only in the ring's colour. */}
			<span className="piem-chat__context-state">{contextStateText(level, t)}</span>
			{/* Estimate caveat, or what happens at the threshold — including the case
			    where nothing does, because automatic tidying is off. */}
			<span className="piem-chat__context-note">{meterTitle(fill, t)}</span>
			{showAgentDetails && usage.requests > 0 ? (
				<span className="piem-chat__context-spend">
					{formatTokens(usage.tokens)} {t.t("chat.tokensSuffix")} <span aria-hidden="true">·</span> {formatCost(usage.cost)}
				</span>
			) : null}
			{cacheLine ? <span className="piem-chat__context-cache">{cacheLine}</span> : null}
			{longCacheNote ? <span className="piem-chat__context-long-cache">{longCacheNote}</span> : null}
			{reasoningNote ? <span className="piem-chat__context-reasoning">{reasoningNote}</span> : null}
			{/*
			 * Always rendered, disabled while busy rather than hidden. `compactNow`
			 * returns early during a stream and the single-flight guard rejects a
			 * second compaction, so a live button would do nothing — and the label
			 * has to carry the reason, since a disabled control has no other channel.
			 */}
			<IconButton
				icon="archive"
				label={tidyLabel({ isStreaming, isCompacting }, t)}
				className="piem-chat__context-tidy"
				disabled={isBusy}
				onClick={onTidy}
			>
				<span className="piem-chat__context-tidy-label" aria-hidden="true">
					{t.t("commands.tidyUp")}
				</span>
			</IconButton>
		</div>
	);
}
