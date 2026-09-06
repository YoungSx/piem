import React, { useEffect, useState } from "react";
import { ObsidianIcon } from "./ObsidianIcon";
import { chatStatusText, runProgressText, type TurnProgress } from "./chatStatus";
import { useT } from "./TranslatorContext";

export interface ChatStatusBarProps {
	isInitializing: boolean;
	/** True while a retry/edit-resend runs its branch summary and rewind. */
	isRewinding: boolean;
	/**
	 * The run now in flight, carried while the turn streams and dropped when it
	 * settles. Present drives the elapsed-and-steps readout; absent means idle,
	 * compacting, or a panel that has not started a turn yet.
	 */
	run?: TurnProgress | null;
	/**
	 * The turn retry now being waited out, once announced; `undefined` when the
	 * turn is not inside a retry episode. Rides the status line because the wait
	 * it names has no transcript row — see {@link ChatStatusInput.retry}.
	 */
	retry?: { attempt: number; maxAttempts: number };
}

/**
 * What the panel is doing — and nothing else.
 *
 * Sits directly above the composer, below the transcript. It used to be two
 * separate surfaces: a status line inside the composer shell, and a metrics row
 * pinned under the header. That put the context meter and the spend counter at
 * the very top of the panel, above the conversation, which inverted the reading
 * order — the reader opens a chat panel to read the chat, and turning on agent
 * details pushed the first message down behind a row of numbers they had not
 * asked to read first.
 *
 * Below the transcript is where a status readout belongs, for the same reason an
 * editor puts its word count in a footer: it is ambient, it is about the thing
 * above it, and it is consulted rather than read. It also lands next to the
 * controls whose state it explains — Stop, and the composer that is disabled
 * while a turn is in flight.
 *
 * The occupancy meter and the spend counter used to live here too, on the same
 * row as the status line. Both moved into {@link ContextGauge}'s popover, beside
 * Send: they answer one question ("is there room, and what has it cost") and
 * splitting them across a bar and a ring said it twice. Tidying left the same way
 * and for the same reason, into the transcript row that also carries its outcome.
 * What is left is a single live line, which is a job this element can hold alone.
 *
 * Never unmounts: when there is nothing to report it collapses to the
 * screen-reader-only treatment, so an idle chat spends no height on an empty row
 * while its live region stays in the DOM. See `isQuiet`.
 */
export function ChatStatusBar({ isInitializing, isRewinding, run, retry }: ChatStatusBarProps): React.JSX.Element {
	const t = useT();
	/*
	 * The elapsed readout reads the clock at render time, not from state: every
	 * snapshot event re-renders the bar with a fresh figure, and the tick below
	 * exists only for the stretches between events. A turn can think for a
	 * minute without emitting anything, and a clock that only moved when a token
	 * arrived would read as frozen mid-wait — the exact "it ignored me" the
	 * readout exists to prevent. One-second cadence, stopped when there is no
	 * run to time; keyed on presence rather than identity, so a stream of
	 * tool-call events does not tear the interval down and rebuild it per event.
	 */
	const isRunning = run !== null && run !== undefined;
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!isRunning) {
			return undefined;
		}
		const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
		return () => window.clearInterval(timer);
	}, [isRunning]);
	const progress = run ? runProgressText(run, Date.now(), t) : null;
	const status = chatStatusText({ isInitializing, isRewinding, retry }, t);
	/*
	 * Nothing to show, but still something to keep: the bar collapses to the
	 * screen-reader-only treatment rather than unmounting.
	 *
	 * An `aria-live` region is only announced if it was already in the DOM when
	 * its content changed. Returning null here — which this did — meant the very
	 * first "Opening chat…" (or resend notice) of a quiet chat arrived in a
	 * region inserted in the same commit, which a screen reader may never
	 * announce at all. Hiding it visually costs no height and keeps the region
	 * discovered.
	 */
	const isQuiet = !status && !progress;

	return (
		// No `aria-label`: a name on a role-less div is a phantom — a screen reader
		// never reads it as part of anything, and Obsidian desktop would only turn
		// it into a hover tooltip on a strip the pointer user already sees.
		<div className={`piem-chat__statusbar${isQuiet ? " piem-chat__visually-hidden" : ""}`}>
			{/*
			 * The live region is the wrapper, not the text, so it stays mounted across
			 * state changes. A region that unmounts when the panel goes idle is one a
			 * screen reader has to re-discover, and the next state change after that
			 * can go unannounced.
			 */}
			<span className="piem-chat__status" role="status" aria-live="polite">
				{status ? (
					<>
						<ObsidianIcon name="loader-circle" className="piem-chat__spinner" />
						{status}
					</>
				) : null}
			</span>
			{progress ? (
				/*
				 * `role="timer"`, and deliberately *not* inside the live region beside
				 * it: a polite region would re-announce the whole line every second the
				 * clock turns over, interrupting the reader sixty times a minute to say
				 * nothing new. A timer is a value that is consulted, not announced —
				 * assistive tech reads it on arrival and on request, which is the same
				 * contract the sighted reader gets.
				 */
				<span className="piem-chat__run" role="timer">
					<ObsidianIcon name="loader-circle" className="piem-chat__spinner" />
					{progress}
				</span>
			) : null}
		</div>
	);
}
