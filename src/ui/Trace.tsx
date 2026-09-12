import React from "react";
import type { IconName } from "obsidian";
import { ObsidianIcon } from "./ObsidianIcon";

interface TraceProps {
	icon: IconName;
	name: string;
	detail?: string;
	className?: string;
	/**
	 * True when `name` is a raw tool id (`get_active_note`) rather than a written
	 * label ("Read a note"). Only an id is set in monospace; the rows whose names
	 * are sentences — thinking, harness output, and every translated tool name —
	 * are set in the interface font.
	 */
	nameIsIdentifier?: boolean;
	/** Revealed content; `null` renders a plain row with no disclosure affordance. */
	body?: React.ReactNode;
	/**
	 * Whether the row is still resolving, for assistive tech.
	 *
	 * The shared running class is the visual half; aria-busy carries the same
	 * state to readers who cannot see it.
	 * It is `aria-busy` rather than a live region on purpose: dozens of rows can be
	 * out at once, and a region per row would announce a queue nobody asked to
	 * hear. The tail placeholder is the announcement; this is what a reader
	 * arriving at the row itself is told.
	 */
	busy?: boolean;
	/**
	 * The row's initial open state, from the expand mode the reader chose. An
	 * `open` attribute on a `<details>` sets the default, not a lock — the reader
	 * can still close the row by hand, which is why this is passed at render
	 * rather than managed as state: a re-render from a settings change restates
	 * the preference without fighting the reader's clicks.
	 */
	open?: boolean;
	/** Observes native disclosure state without controlling it. */
	onToggle?: (open: boolean) => void;
	children?: React.ReactNode;
}

/** A raw identifier uses monospace; a written label uses the interface font. */
function traceNameClass(isIdentifier: boolean): string {
	return `piem-chat__trace-name piem-chat__trace-name--${isIdentifier ? "identifier" : "label"}`;
}

/**
 * Collapsed one-line disclosure for machine traffic (tool calls, tool results,
 * thinking, harness output).
 *
 * One vocabulary for all of it: the transcript used to expand raw JSON and full
 * tool output inline while hiding thinking and diffs behind `<details>`, so a
 * single `grep` could bury the model's actual prose. Everything mechanical now
 * collapses to a 1-line row the reader opens on demand.
 */
export function Trace({ icon, name, detail, className, nameIsIdentifier = false, body, busy = false, open = false, onToggle, children }: TraceProps): React.JSX.Element {
	const revealed = body === undefined ? children : body;
	const classes = ["piem-chat__trace", className, busy ? "piem-chat__trace--running" : null].filter(Boolean).join(" ");
	const row = (
		<>
			<ObsidianIcon name={icon} className="piem-chat__trace-icon" />
			<span className={traceNameClass(nameIsIdentifier)}>{name}</span>
			{detail ? <span className="piem-chat__trace-detail">{detail}</span> : null}
		</>
	);

	// `undefined` rather than `false` for a settled row: `aria-busy="false"` on
	// every trace in a long transcript is markup that says nothing.
	const ariaBusy = busy ? true : undefined;
	if (!revealed) {
		return (
			<div className={`${classes} piem-chat__trace--flat`} aria-busy={ariaBusy}>
				{row}
			</div>
		);
	}
	return (
		<details className={classes} open={open} aria-busy={ariaBusy} onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}>
			<summary className="piem-chat__trace-summary">{row}</summary>
			<div className="piem-chat__trace-body">{revealed}</div>
		</details>
	);
}
