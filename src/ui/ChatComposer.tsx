import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Platform } from "obsidian";
import { IconButton, ObsidianIcon } from "./ObsidianIcon";
import { isSendShortcut, resolveSendShortcut, sendShortcutAria, type SendShortcut } from "./keyboard";
import { sendButtonTitle, sendShortcutLabel } from "./chatStatus";
import { useT } from "./TranslatorContext";
import { suppressOwnTooltip } from "./tooltipSuppression";
import { useAutosize } from "./useAutosize";
import { CommandMenu, type CommandEntry } from "./CommandMenu";
import type { PendingImage } from "./pendingImages";
import type { QueuedPrompt } from "../agent/promptQueue";

interface ChatComposerProps {
	input: string;
	isStreaming: boolean;
	isCompacting: boolean;
	/**
	 * Whether a retry/edit-resend is between its guards and the replacement
	 * send — the silent window where the transcript moves on its own. Read as
	 * busy, exactly as streaming is: the send must be held, the editing notice
	 * must not claim the composer is still armed for the same edit, and Stop
	 * must stay reachable to cancel the branch summary mid-request.
	 */
	isRewinding: boolean;
	isInitializing: boolean;
	/**
	 * Whether the active model target has a key ready.
	 *
	 * Send is disabled without one: the request cannot go out, so a live button
	 * that only produces an error banner is the same trap the empty-draft case
	 * already fixed. The label carries the reason, since a disabled control has
	 * no other channel to explain itself.
	 */
	isConfigured: boolean;
	/**
	 * Whether the draft is an armed edit of an earlier question — sending then
	 * rewrites the conversation from that turn instead of appending. Drives the
	 * editing notice, the one place the state is visible where the send happens.
	 */
	isEditing?: boolean;
	/** Cancels the armed edit; the panel restores the draft it displaced. */
	onCancelEdit?: () => void;
	/** The chord the user chose in settings; overridden on mobile, see {@link resolveSendShortcut}. */
	sendShortcut: SendShortcut;
	onInputChange: (value: string) => void;
	onSend: () => void;
	onAbort: () => void;
	/** Receives the textarea focus function, so commands outside React can focus it. */
	onFocusRequested?: (focus: (() => void) | null) => void;
	/**
	 * Receives the textarea's element id, so a skip link outside this component can
	 * point at it. Generated here rather than passed in because the textarea is
	 * what the id belongs to; the panel only forwards it.
	 */
	onAnchorIdChange?: (id: string | undefined) => void;
	/**
	 * The context chip row, rendered inside the composer shell above the textarea.
	 *
	 * Passed in rather than built here so this component keeps knowing only about
	 * the draft and the send controls, and so the row sits inside the shell's focus
	 * ring — it is part of what you are about to send, not chrome above it.
	 */
	contextRow?: React.ReactNode;
	/**
	 * The model switcher, rendered at the leading edge of the send bar.
	 *
	 * Passed in for the same reason as {@link contextRow}: it needs the configured
	 * model list and a write back to settings, and this component's business is
	 * the draft and the send controls. Absent renders nothing and the bar closes
	 * up around the controls that remain.
	 */
	modelSwitcher?: React.ReactNode;
	/**
	 * The thinking-level selector, rendered immediately right of
	 * {@link modelSwitcher}.
	 *
	 * Passed in for the same reason as {@link modelSwitcher}: it reads the
	 * conversation's level and writes back to the session, and this component's
	 * business is the draft and the send controls. Absent — or a null node, which
	 * is what the selector itself returns for a model without reasoning — renders
	 * nothing and the model switcher keeps the bar's leading edge alone.
	 */
	thinkingSelector?: React.ReactNode;
	/**
	 * The context-occupancy ring, rendered immediately to the left of Send.
	 *
	 * Passed in for the same reason as {@link contextRow}: this component knows
	 * about the draft and the send controls, not about token accounting. It sits in
	 * the send bar rather than a row of its own because it costs no height there,
	 * and it sits *against* Send rather than across the bar from it because that is
	 * the question it answers — whether there is room for the thing the button next
	 * to it is about to send. Parked at the far leading edge it read as unrelated
	 * chrome, a full sidebar's width from the control it qualifies.
	 */
	contextGauge?: React.ReactNode;
	/**
	 * `/name` prompt templates and skills available to autocomplete. Empty when
	 * nothing loaded; the menu simply never opens, and `/`-prefixed drafts behave
	 * like any other text until the user sends them.
	 */
	commands: CommandEntry[];
	/**
	 * Images staged for the next send (pasted or dropped), shown as removable
	 * thumbnails above the textarea. Ephemeral: the parent clears them on a
	 * successful send and never persists them.
	 */
	pendingImages?: PendingImage[];
	/** Stage image files taken from a paste or drop event. */
	onAddImages?: (files: File[]) => void;
	/** Remove one staged image by id. */
	onRemoveImage?: (id: string) => void;
	/**
	 * Mid-run sends waiting to depart, oldest first. Shown where the send
	 * happens — a queue invisible at the composer is a queue the user cannot
	 * trust took their words.
	 */
	queuedPrompts?: QueuedPrompt[];
	/** Sends one queued message now, cutting the running reply short, by its chip's id. */
	onSteerQueuedPrompt?: (id: string) => void;
	/** Puts one queued message back in the draft for another pass, by its chip's id. */
	onEditQueuedPrompt?: (id: string) => void;
	/** Throws one queued message away, by its chip's id. */
	onDiscardQueuedPrompt?: (id: string) => void;
	/**
	 * Whether the composer is folded down to its top row.
	 *
	 * The fold is the phone's reading mode: the context row and the fold toggle
	 * stay, the draft's own rows unmount. The queued line stays visible too — a
	 * queue invisible at the composer is a queue the user cannot trust took their
	 * words (the same rule that put it there).
	 *
	 * Stateful in the parent rather than here, because the state is persisted:
	 * the panel's next mount has to open folded, which a component-local flag
	 * would forget.
	 */
	collapsed?: boolean;
	/** Folds or unfolds the composer; its presence is also what renders the toggle. */
	onToggleCollapsed?: () => void;
}

/**
 * The draft, the context row, and the send row.
 *
 * The keyboard hint rides on the Send button itself rather than in a status line
 * beside it. A hint belongs to the control it describes: a reader wondering how
 * to send looks at Send, and putting the chord in a separate line spends a whole
 * row of a narrow sidebar to answer a question the button was already being
 * asked. It also frees the slot the panel had been using for two purposes at
 * once — the shortcut while idle, the turn state while busy — which meant the
 * shortcut vanished exactly while a beginner was watching that spot.
 */
export function ChatComposer({
	input,
	isEditing = false,
	onCancelEdit,
	isStreaming,
	isCompacting,
	isRewinding,
	isInitializing,
	isConfigured,
	sendShortcut,
	onInputChange,
	onSend,
	onAbort,
	onFocusRequested,
	onAnchorIdChange,
	contextRow,
	modelSwitcher,
	thinkingSelector,
	contextGauge,
	commands,
	pendingImages,
	onAddImages,
	onRemoveImage,
	queuedPrompts,
	onSteerQueuedPrompt,
	onEditQueuedPrompt,
	onDiscardQueuedPrompt,
	collapsed = false,
	onToggleCollapsed,
}: ChatComposerProps): React.JSX.Element {
	const t = useT();
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const onSendRef = useRef<() => void>(onSend);
	const isBusy = isStreaming || isCompacting || isRewinding;
	/*
	 * The turn slot's phase. Compaction dominates: it is the one window where
	 * sending is refused outright (a send would race the compactor), so the slot
	 * names what is actually holding the turn rather than the run behind it.
	 */
	const turnPhase: "send" | "stop" | "stop-compaction" = isCompacting
		? "stop-compaction"
		: isBusy
			? "stop"
			: "send";
	const sendDisabled = isInitializing || !isConfigured || !input.trim();
	const [menuOpen, setMenuOpen] = useState(false);
	// Per-instance rather than a constant: Obsidian allows several leaves of one
	// view type, so two open chat panels would otherwise share one id and the
	// skip link in each would jump to whichever mounted first.
	const anchorId = useId();
	/*
	 * The command menu's listbox id, derived from the textarea's own — and the id
	 * of whichever option is currently highlighted, which the menu reports through
	 * `onActiveChange`. Between reports it is `null`, which is also what the
	 * textarea advertises while the menu is closed or has no matches.
	 */
	const menuId = `piem-command-menu${anchorId}`;
	const [activeOptionId, setActiveOptionId] = useState<string | null>(null);
	const shortcut = resolveSendShortcut(sendShortcut, Platform.isMobile);
	// Read by the capture-phase listener below, which is registered once:
	// re-registering it whenever the setting changes would be a listener's worth
	// of churn for a value the handler can simply read at event time.
	const shortcutRef = useRef<SendShortcut>(shortcut);

	onSendRef.current = onSend;
	shortcutRef.current = shortcut;

	/*
	 * The menu opens only while the draft is a bare command name — starts with
	 * `/` and has no space yet. Once the user types a space they are into the
	 * arguments and the name is fixed, so a floating list would only distract.
	 * Multiline drafts never open it: a `/` on the second line is prose.
	 */
	const commandQuery = useMemo(() => {
		if (!input.startsWith("/") || input.includes(" ") || input.includes("\n")) {
			return null;
		}
		return input.slice(1).toLowerCase();
	}, [input]);
	// Folded, the menu cannot stand: its anchor — the textarea — is not mounted,
	// and reopening unfolded should not resurrect a list the user never saw.
	const showMenu = !collapsed && menuOpen && commandQuery !== null && commands.length > 0;

	const selectCommand = (command: CommandEntry): void => {
		onInputChange(`/${command.invocation} `);
		setMenuOpen(false);
		// Keep the caret after the trailing space so the user types arguments next,
		// not back into the name.
		textareaRef.current?.focus();
	};

	// The textarea's own rows: `2` when it is on screen, `0` folded — read by the
	// autosize floor (`lineHeight * minRows`), which would otherwise reserve an
	// empty two-row box the fold just removed.
	useAutosize(textareaRef, input, { minRows: collapsed ? 0 : 2 });

	/*
	 * Image paste/drop staging.
	 *
	 * Only image files are pulled from the transfer; a text paste or a dropped
	 * note falls through to the textarea's native handling. The actual byte read
	 * and base64 encoding happen in the parent (via `fileToPendingImage`), so
	 * this component stays free of encoding logic and the staged list is the
	 * single source the parent owns.
	 */
	const handleImageTransfer = (files: FileList | null | undefined): void => {
		if (!onAddImages || !files || files.length === 0) {
			return;
		}
		const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
		if (images.length > 0) {
			onAddImages(images);
		}
	};

	const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
		handleImageTransfer(event.clipboardData?.files);
	};

	const handleDrop = (event: React.DragEvent<HTMLTextAreaElement>): void => {
		// Prevent the browser from navigating to or previewing the dropped file.
		event.preventDefault();
		handleImageTransfer(event.dataTransfer?.files);
	};

	const handleDragOver = (event: React.DragEvent<HTMLTextAreaElement>): void => {
		// A drop only fires when the target signals it accepts the drag; without
		// preventDefault the drop event never reaches `handleDrop`.
		event.preventDefault();
	};

	/*
	 * A touch press on a toolbar control must not steal focus from the draft.
	 *
	 * The send row rides with composing, not instead of it: tapping the model
	 * switcher, the ring or Send is part of writing the message, so the soft
	 * keyboard and the caret should both survive the press. This cancels the
	 * press's default action, which is what would move focus — so in a browser
	 * that only moves focus as that default action the keyboard stays put.
	 *
	 * It is a comfort, not the guarantee: iOS Safari drops the field's focus as
	 * part of its own tap handling, which is not a default action and so cannot
	 * be cancelled. Nothing breaks when it does — the row is always rendered, so
	 * the pressed control is never out of the layout when the tap resolves.
	 *
	 * Two exemptions. A press on the textarea passes through, because focusing
	 * it — and placing the caret — is precisely what that press is for. A mouse
	 * press passes through because native focus movement is what a desktop
	 * keyboard user's tab order expects.
	 */
	const keepFocusOnPress = (event: React.PointerEvent<HTMLDivElement>): void => {
		if (event.pointerType === "mouse" || event.target === textareaRef.current) {
			return;
		}
		event.preventDefault();
	};

	/*
	 * The only keydown path.
	 *
	 * A native listener rather than React's `onKeyDown`, and *instead* of it: the
	 * synthetic event React builds has no `isComposing`, so the IME guard in
	 * {@link isSendShortcut} could not see it there. With both handlers wired, the
	 * native one correctly declined the Enter that accepts a Chinese candidate and
	 * then let the event reach React's, which sent the half-typed sentence.
	 *
	 * Capture phase on the textarea, so it also runs ahead of any Obsidian hotkey
	 * bound to Enter, and `stopPropagation` keeps a send from reaching one.
	 */
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return undefined;
		}

		const handleNativeKeyDown = (event: KeyboardEvent): void => {
			if (!isSendShortcut(event, shortcutRef.current)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			onSendRef.current();
		};

		textarea.addEventListener("keydown", handleNativeKeyDown, { capture: true });
		return () => {
			textarea.removeEventListener("keydown", handleNativeKeyDown, { capture: true });
		};
		// `collapsed` rides along because folding unmounts the textarea and
		// unfolding mounts a new one — the listener binds to the element, so the
		// remount needs the registration to run again.
	}, [collapsed]);

	useEffect(() => {
		if (!onFocusRequested) {
			return undefined;
		}
		onFocusRequested(() => {
			const textarea = textareaRef.current;
			if (!textarea) {
				return;
			}
			textarea.focus();
			const end = textarea.value.length;
			textarea.setSelectionRange(end, end);
		});
		return () => {
			onFocusRequested(null);
		};
	}, [onFocusRequested]);

	useEffect(() => {
		// `undefined` while folded: the textarea the link points at is not in the
		// document, so the skip links outside (which test the id for truthiness)
		// must stand down rather than jump at nothing.
		onAnchorIdChange?.(collapsed ? undefined : anchorId);
	}, [onAnchorIdChange, anchorId, collapsed]);

	return (
		<footer className="piem-chat__composer">
			<div className="piem-chat__composer-shell" onPointerDown={keepFocusOnPress}>
				<div className="piem-chat__composer-top">
					{contextRow}
					{/*
					 * The fold toggle, mobile-only and trailing.
					 *
					 * It lives in this row rather than a corner of its own because the row
					 * is the one thing the fold keeps: a control that survives its own
					 * action has to sit on the survivor. Rendered on the phone alone —
					 * desktop reads at a width where folding would hide what it costs —
					 * and absent whenever the parent passes no handler, which is how the
					 * desktop build stays free of dead props.
					 *
					 * The glyph points the way the draft goes: chevron-down folds, so the
					 * row is what remains; chevron-up opens, and the draft returns. Same
					 * element both ways, so the press never drops focus mid-tap.
					 */}
					{Platform.isMobile && onToggleCollapsed ? (
						<IconButton
							icon={collapsed ? "chevron-down" : "chevron-up"}
							label={t.t(collapsed ? "chat.expandComposer" : "chat.collapseComposer")}
							onClick={onToggleCollapsed}
							className="piem-chat__composer-toggle"
							ariaExpanded={!collapsed}
						/>
					) : null}
				</div>
				{isEditing && !collapsed ? (
					/*
					 * The armed edit must be visible where the send happens. Its Send
					 * looks identical to the everyday one but rewrites the conversation
					 * instead of appending — a state carried silently by a textarea
					 * that merely shows old words would read as an ordinary draft, and
					 * the first send after opening the panel would surprise. The cancel
					 * beside it is the way back out, including to the draft this state
					 * displaced.
					 */
					<div className="piem-chat__editing" role="status">
						<ObsidianIcon name="pen-line" className="piem-chat__editing-icon" />
						<span className="piem-chat__editing-text">{t.t("chat.editingNotice")}</span>
						<IconButton icon="x" label={t.t("chat.editingCancel")} onClick={() => onCancelEdit?.()} className="piem-chat__editing-cancel" />
					</div>
				) : null}
				{queuedPrompts && queuedPrompts.length > 0 ? (
					/*
					 * The waiting line, oldest first. Sits between the composer and the
					 * running reply's output so the reader connects the two: these words
					 * went in, the reply on screen has not reached them yet. Every action
					 * is per chip — a queue of three is three decisions, not one.
					 *
					 * Three of them, in the order they escalate (issue #289). Send is the
					 * primary and the only one that spends anything: it cuts the running
					 * reply short so this message goes out now, which is the answer to
					 * "it cannot wait" that no setting can give. The pencil lands the
					 * words in the composer for a rewrite — it is the transcript's own
					 * edit glyph, so the two read as one verb. The x is the way out for a
					 * chip the reader has simply changed their mind about, without having
					 * to clear the composer afterwards. None of the three stands in for
					 * another.
					 */
					<ul
						className="piem-chat__queue"
						aria-label={t.t("chat.queueLabel")}
						onMouseOver={suppressOwnTooltip}
					>
						{queuedPrompts.map((queued) => (
							<li key={queued.id} className="piem-chat__queue-item" role="listitem">
								<span className="piem-chat__queue-text">
									{queued.text}
									{queued.imageCount > 0 ? (
										<span className="piem-chat__queue-images">{t.t("chat.queueImages", { count: queued.imageCount })}</span>
									) : null}
								</span>
								<IconButton
									icon="send"
									label={t.t("chat.queueSteer")}
									onClick={() => onSteerQueuedPrompt?.(queued.id)}
									className="piem-chat__queue-action"
								/>
								<IconButton
									icon="pen-line"
									label={t.t("chat.queueEdit")}
									onClick={() => onEditQueuedPrompt?.(queued.id)}
									className="piem-chat__queue-action"
								/>
								<IconButton
									icon="x"
									label={t.t("chat.queueDiscard")}
									onClick={() => onDiscardQueuedPrompt?.(queued.id)}
									className="piem-chat__queue-action"
								/>
							</li>
						))}
					</ul>
				) : null}
				{pendingImages && pendingImages.length > 0 && !collapsed ? (
					<ul className="piem-chat__pending-images">
						{pendingImages.map((image, index) => (
							<li key={image.id} className="piem-chat__pending-image">
								<img
									src={`data:${image.mimeType};base64,${image.data}`}
									alt={t.t("chat.imageThumbAlt", { mimeType: image.mimeType })}
									className="piem-chat__pending-image-thumb"
								/>
								<IconButton
									icon="x"
									label={t.t("chat.removeImage", { index: index + 1 })}
									onClick={() => onRemoveImage?.(image.id)}
									className="piem-chat__pending-image-remove"
								/>
							</li>
						))}
					</ul>
				) : null}
				{!collapsed ? (
					<textarea
						ref={textareaRef}
						id={anchorId}
						value={input}
						onChange={(event) => {
							const value = event.currentTarget.value;
							onInputChange(value);
							// Open the command menu the moment the draft becomes a lone `/`,
							// close it the moment it stops being one. Kept here rather than in an
							// effect so the menu tracks the keystroke, not a render behind it.
							setMenuOpen(value.startsWith("/"));
						}}
						onBlur={() => {
							// Defer so a click on a menu item fires before the menu unmounts.
							window.setTimeout(() => setMenuOpen(false), 0);
						}}
						onPaste={handlePaste}
						onDrop={handleDrop}
						onDragOver={handleDragOver}
						placeholder={t.t("chat.placeholder")}
						aria-label={t.t("chat.composerAria")}
						onMouseOver={suppressOwnTooltip}
						aria-keyshortcuts={sendShortcutAria(shortcut)}
						/*
						 * The ARIA combobox half of the command menu. The draft is where
						 * focus lives while the user types `/`, so the textarea carries the
						 * combobox role and quotes the menu — its listbox — and the
						 * highlighted option by id. All three attributes key off the one
						 * `activeOptionId` the menu reports, so `aria-expanded`,
						 * `aria-controls` and `aria-activedescendant` open, close and move
						 * together: with no matches the menu renders nothing and none of
						 * the three advertise it.
						 */
						role="combobox"
						aria-expanded={activeOptionId !== null}
						aria-controls={activeOptionId !== null ? menuId : undefined}
						aria-activedescendant={activeOptionId ?? undefined}
						rows={2}
					/>
				) : null}
				{showMenu ? (
					<CommandMenu
						commands={commands}
						query={commandQuery ?? ""}
						menuId={menuId}
						anchorRef={textareaRef}
						onActiveChange={setActiveOptionId}
						onSelect={selectCommand}
						onClose={() => setMenuOpen(false)}
					/>
				) : null}
				{!collapsed ? (
					<div className="piem-chat__composer-bar">
						{/*
						 * Reading order across the bar: what the message will be sent *to*,
						 * then how hard it will think, then whether there is room for it,
						 * then the send control itself.
						 *
						 * The switcher and the thinking selector form the bar's leading
						 * cluster — two questions about the same outgoing message — while
						 * the context ring and the terminal control form the trailing one:
						 * the ring's wrapper claims the corner through `margin-left: auto`
						 * (see the stylesheet), so the gauge always sits beside the action
						 * its reading qualifies.
						 */}
						{modelSwitcher}
						{thinkingSelector}
						{contextGauge}
						{isStreaming && input.trim() ? (
							/*
							 * The mouse half of mid-run queueing. The single turn slot has
							 * become Stop, so this quiet text button keeps the draft's
							 * queue path open for pointer users — the chord keeps working
							 * regardless. It exists only while there is a draft worth
							 * queueing, and it names itself, because an icon here would
							 * just be the next thing a reader has to guess.
							 */
							<button type="button" className="piem-chat__queue-button" onClick={onSend}>
								{t.t("chat.queueDraft")}
							</button>
						) : null}
						{/*
						 * One slot for the turn, not two buttons side by side: Send and
						 * Stop are phases of the same control — whose turn it is — so the
						 * slot changes what it is rather than the row gaining a control.
						 * Same element in every phase, only props change: re-mounting
						 * between phases (the old conditional-branch rendering) would drop
						 * focus from the button a keyboard user is holding.
						 */}
						<TurnControl
							phase={turnPhase}
							isConfigured={isConfigured}
							disabled={sendDisabled}
							shortcut={shortcut}
							onSend={onSend}
							onAbort={onAbort}
						/>
					</div>
				) : null}
			</div>
		</footer>
	);
}

interface TurnControlProps {
	/** Which phase the turn slot is in; send and stop share the one element. */
	phase: "send" | "stop" | "stop-compaction";
	/** Whether a key is configured; decides what the send phase says it is for. */
	isConfigured: boolean;
	disabled: boolean;
	/** The chord in force on this device, already resolved for mobile. */
	shortcut: SendShortcut;
	onSend: () => void;
	onAbort: () => void;
}

/**
 * The turn slot — Send and Stop as phases of one button, not two side by side.
 *
 * A turn control is a state machine, not a choice: whose turn is it, the
 * composer's or the agent's. Splitting that across two buttons made the row
 * carry a control that lied — while streaming, the button still named, painted
 * and coloured itself "Send" while actually queueing — and parked a dead
 * call-to-action beside Stop whenever the draft was empty. One slot changes
 * what it is instead, the way Obsidian's own record and playback buttons do.
 *
 * The element never unmounts across phases. React only keeps the DOM node — and
 * with it keyboard focus — because the three phases render the same shape: one
 * button whose icon, name, class and handler change together. A conditional
 * branch here would remount and drop focus mid-keystroke.
 *
 * The send phase keeps {@link SendButton}'s discipline intact: the chord rides
 * on the button, hidden from assistive tech, and with no key configured the
 * name becomes the reason and the keycaps go away with it.
 */
function TurnControl({ phase, isConfigured, disabled, shortcut, onSend, onAbort }: TurnControlProps): React.JSX.Element {
	const t = useT();
	const showChord = phase === "send" && isConfigured && !Platform.isMobile;
	const name =
		phase === "send"
			? !isConfigured
				? t.t("chat.sendNeedsKey")
				: showChord
					? sendButtonTitle(shortcut, Platform.isMacOS, t)
					: t.t("chat.sendMessage")
			: phase === "stop-compaction"
				? t.t("chat.stop")
				: t.t("chat.stopResponse");

	return (
		<IconButton
			icon={phase === "send" ? "send" : "square"}
			label={name}
			className={phase === "send" ? "piem-chat__send-button mod-cta" : "piem-chat__stop-button"}
			disabled={phase === "send" && disabled}
			onClick={phase === "send" ? onSend : onAbort}
		>
			{/*
			 * Keycaps, hidden from assistive tech: the accessible name above already
			 * carries the chord, and reading the glyphs would repeat it as symbols.
			 * The stop phases render no children at all, so the slot's width snaps
			 * from chord-bearing back to square rather than reserving space.
			 */}
			{showChord ? (
				<span className="piem-chat__send-chord" aria-hidden="true">
					{sendShortcutLabel(shortcut, Platform.isMacOS, t)}
				</span>
			) : null}
		</IconButton>
	);
}
