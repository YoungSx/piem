import React, { useEffect, useId, useRef, useState } from "react";
import { contextRefLabel, type ContextRef } from "../agent/contextRefs";
import { IconButton, ObsidianIcon } from "./ObsidianIcon";
import { useT } from "./TranslatorContext";
import { suppressOwnTooltip } from "./tooltipSuppression";
import { usePointerDownOutside } from "./usePointerDownOutside";

interface ContextRowProps {
	/** Notes the next turn will name, active first. Empty renders nothing. */
	refs: ContextRef[];
	/** Whether the active note is being followed, which decides the resume control. */
	isFollowingActive: boolean;
	/** Opens a referenced note in the vault. */
	onOpen: (path: string) => void;
	/** Keeps naming a note after the user navigates away. */
	onPin: (path: string) => void;
	/** Drops a pinned note. */
	onUnpin: (path: string) => void;
	/** Starts or stops naming whatever note the user is looking at. */
	onSetFollowActive: (follow: boolean) => void;
	/**
	 * Row-end content that is not a note reference — today, the subagent monitor's
	 * entry icon.
	 *
	 * It arrives as a node rather than as props for a specific control because the
	 * row's subject is what the model is told about, and a subagent is not that; a
	 * `subagentSnapshots` prop here would make this component the place two
	 * unrelated features meet. `ChatApp` composes them instead, the same way it
	 * composes the header's switchers.
	 *
	 * Its presence also keeps the row alive: the row hides itself when there is no
	 * note to report, and a monitor icon that vanished whenever no note was open
	 * would be a notification you could only see by luck.
	 */
	trailing?: React.ReactNode;
}

/**
 * What the model is told about, shown above the composer.
 *
 * The panel used to give no sign of this at all: the model either knew which
 * note you meant or it didn't, and you found out by being asked. The row makes
 * the answer visible before you send, and lets you change it.
 *
 * Chips, not cards. A sidebar's vertical space is its scarcest resource, and a
 * card costs roughly 60px to carry the same one line of text a 24px chip does.
 *
 * The two kinds render differently on purpose, and neither draws a border. The
 * row sits inside the composer shell, which already has one, so a chip framing
 * itself in the same token put two hairlines 8px apart — a box in a box. The
 * distinction is carried by fill instead: a followed note arrived by itself and
 * will change by itself, so it has none and reads as part of the shell; a pinned
 * note was chosen and stays, so it is filled and reads as an object sitting on
 * it. Rendering both as the same dismissible object would make the row lie:
 * dismissing a followed note and then opening another file would bring it
 * straight back, having achieved nothing. Dismissing the followed chip
 * therefore turns *following* off, which is a state the row can honestly show.
 *
 * Each chip is one button that discloses its own actions — opening the note,
 * pinning or dismissing — rather than carrying them inline. Inline controls cost
 * every chip a third of its width permanently to serve a need once per note's
 * lifetime, and they were what pushed this row to wrap onto two lines on a
 * phone; the chip's whole width now goes to the label, and everything else one
 * press away. It is the same shape as the subagent entry icon beside it: one
 * control in the row, its actions in a popover above it.
 *
 * Dismissing a control unmounts it, which drops focus to `<body>` and costs a
 * keyboard user their place. Each dismissal therefore hands focus to whatever
 * takes the control's role: the resume button when following was turned off, or
 * the row's first remaining control when a pin was removed.
 */
export function ContextRow({
	refs,
	isFollowingActive,
	onOpen,
	onPin,
	onUnpin,
	onSetFollowActive,
	trailing,
}: ContextRowProps): React.JSX.Element | null {
	const t = useT();
	const rowRef = useRef<HTMLDivElement | null>(null);
	const resumeRef = useRef<HTMLButtonElement | null>(null);
	// Which control should receive focus after the render that follows a dismissal.
	// Applied in an effect because the replacement does not exist until then.
	const pendingFocus = useRef<"resume" | "firstControl" | null>(null);

	useEffect(() => {
		const target = pendingFocus.current;
		if (!target) {
			return;
		}
		pendingFocus.current = null;
		if (target === "resume") {
			resumeRef.current?.focus();
			return;
		}
		rowRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
	});

	// Nothing to say: no Markdown note open and nothing pinned, with following
	// still on. Rendering an empty row would spend sidebar height on the absence
	// of information — unless something else is riding along, in which case the
	// row is the only thing holding it and hiding it would take that with it.
	if (refs.length === 0 && isFollowingActive && !trailing) {
		return null;
	}

	return (
		<div className="piem-chat__context-row" role="group" aria-label={t.t("contextRow.rowAria")} ref={rowRef}>
			{refs.map((ref) => (
				<ContextChip
					key={`${ref.kind}:${ref.path}`}
					contextRef={ref}
					onOpen={onOpen}
					onPin={onPin}
					onUnpin={(path) => {
						pendingFocus.current = "firstControl";
						onUnpin(path);
					}}
					onStopFollowing={() => {
						// The resume button is what replaces this chip, so it is where the
						// user's place in the row now is.
						pendingFocus.current = "resume";
						onSetFollowActive(false);
					}}
				/>
			))}
			{isFollowingActive ? null : (
				<IconButton
					icon="eye-off"
					label={t.t("contextRow.followActive")}
					onClick={() => onSetFollowActive(true)}
					className="piem-chat__context-resume"
					buttonRef={resumeRef}
				/>
			)}
			{/*
			 * Pushed to the far end by its own margin rather than by
			 * `justify-content`, which would move the chips too. Wrapped so the
			 * margin has something to sit on whatever the caller passed.
			 */}
			{trailing ? <span className="piem-chat__context-trailing">{trailing}</span> : null}
		</div>
	);
}

interface ContextChipProps {
	contextRef: ContextRef;
	onOpen: (path: string) => void;
	onPin: (path: string) => void;
	onUnpin: (path: string) => void;
	onStopFollowing: () => void;
}

/**
 * One note, one button, one popover.
 *
 * The button's whole job is to identify the note and disclose the actions; the
 * popover is where those actions live, because actions that fire once in a
 * note's lifetime have no business spending row width forever. Pinning keeps
 * the popover open on purpose: the pin row leaves it, which is the visible
 * answer to the press. The other rows end the chip or leave the panel, and
 * close before they go.
 */
function ContextChip({ contextRef, onOpen, onPin, onUnpin, onStopFollowing }: ContextChipProps): React.JSX.Element {
	const t = useT();
	const isActive = contextRef.kind === "active";
	const label = contextRefLabel(contextRef.path);
	const modifier = isActive ? "piem-chat__context-chip--active" : "piem-chat__context-chip--pinned";
	const [isOpen, setIsOpen] = useState(false);
	const wrapperRef = useRef<HTMLSpanElement | null>(null);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	// Wires the chip to the popover it opens, for assistive tech that announces
	// what a toggle controls. `useId` because two chat panels could mount at once.
	const popoverId = useId();

	usePointerDownOutside(wrapperRef, isOpen, () => setIsOpen(false));

	return (
		<span
			className={`piem-chat__context-chip ${modifier}`}
			ref={wrapperRef}
			onKeyDown={(event) => {
				if (event.key === "Escape" && isOpen) {
					// The composer and the transcript have their own Escape handlers;
					// this press is about the popover and stops here.
					event.stopPropagation();
					setIsOpen(false);
					buttonRef.current?.focus();
				}
			}}
		>
			{/*
			 * `clickable-icon`-free on purpose: this button renders text, so the bare-
			 * button reset — not the icon-button classes — is what frees it from
			 * Obsidian's form-control chrome.
			 *
			 * No `title` and a suppressed tooltip: the popover is one press away and
			 * carries the full path, and the accessible name's tooltip stacking on
			 * top of it was the defect the old chip had to shed once already.
			 */}
			<button
				ref={buttonRef}
				type="button"
				className="piem-chat__context-open"
				aria-label={t.t(isActive ? "contextRow.chipFollowed" : "contextRow.chipPinned", { path: contextRef.path })}
				aria-expanded={isOpen}
				aria-controls={popoverId}
				onMouseOver={suppressOwnTooltip}
				onClick={() => setIsOpen((open) => !open)}
			>
				<ObsidianIcon name={isActive ? "file-text" : "pin"} className="piem-chat__context-icon" />
				<span className="piem-chat__context-chip-label">{label}</span>
			</button>
			{isOpen ? (
				<div
					id={popoverId}
					className="piem-chat__context-chip-popover"
					role="group"
					aria-label={t.t("contextRow.chipPopoverAria", { name: label })}
					onMouseOver={suppressOwnTooltip}
				>
					{/* The chip truncates to a file name; this line is where the folder
					    the reader cannot recover from context comes back. */}
					<span className="piem-chat__context-chip-path">{contextRef.path}</span>
					<div className="piem-chat__context-chip-actions">
						<button
							type="button"
							className="piem-chat__context-chip-action"
							onClick={() => {
								// Close before navigating: the leaf takes over, and a popover
								// left hanging over the composer would outlive its own subject.
								setIsOpen(false);
								onOpen(contextRef.path);
							}}
						>
							<ObsidianIcon name="file-text" className="piem-chat__context-chip-action-icon" />
							{t.t("contextRow.openNote")}
						</button>
						{isActive && !contextRef.isPinned ? (
							<button
								type="button"
								className="piem-chat__context-chip-action"
								onClick={() => onPin(contextRef.path)}
							>
								<ObsidianIcon name="pin" className="piem-chat__context-chip-action-icon" />
								{t.t("contextRow.pinToChat")}
							</button>
						) : null}
						{isActive ? (
							/*
							 * Not "remove this note" — focus would put it right back. What this
							 * turns off is following the user's focus at all, which is why the
							 * label names the behaviour rather than the note.
							 */
							<button
								type="button"
								className="piem-chat__context-chip-action"
								onClick={onStopFollowing}
							>
								<ObsidianIcon name="eye-off" className="piem-chat__context-chip-action-icon" />
								{t.t("contextRow.stopFollowing")}
							</button>
						) : (
							<button
								type="button"
								className="piem-chat__context-chip-action"
								onClick={() => onUnpin(contextRef.path)}
							>
								<ObsidianIcon name="x" className="piem-chat__context-chip-action-icon" />
								{t.t("contextRow.removeFromContext")}
							</button>
						)}
					</div>
				</div>
			) : null}
		</span>
	);
}
