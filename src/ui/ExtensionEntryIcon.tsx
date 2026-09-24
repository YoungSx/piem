import React, { useEffect, useId, useRef, useState } from "react";
import type { ExtensionShortcutAction } from "../extensions/extensionUI";
import type { ExtensionUISnapshot } from "./ObsidianExtensionUI";
import { ObsidianIcon } from "./ObsidianIcon";
import { usePointerDownOutside } from "./usePointerDownOutside";
import { useT } from "./TranslatorContext";
import { suppressOwnTooltip } from "./tooltipSuppression";

/**
 * Whether the context row's extension entry icon has anything to say.
 *
 * The rule is the subagent entry icon's, generalized: a permanent control for a
 * surface most turns never touch would spend attention on nothing, so the icon
 * appears only when an extension has actually mounted an above-editor panel —
 * which is also when its shortcut handler has something to act on — or while a
 * run or a failure is still on the books, because feedback the user triggered
 * has to have somewhere to land until it is read. A shortcut whose panel is
 * gone and whose run settled is a no-op upstream; an icon for it would be a
 * control that lies.
 *
 * Read from the snapshot alone, so the visibility rule generalizes without the
 * renderer knowing any one extension: every extension that mounts a panel and
 * registers shortcuts gets the same entry, and the panel's own auto-hide (an
 * empty todo list unmounts the widget) is what makes the icon follow it.
 */
export function hasExtensionEntry(snapshot: ExtensionUISnapshot): boolean {
	const pending = Boolean(snapshot.shortcutPending);
	const failed = Boolean(snapshot.shortcutError);
	if (pending || failed) return true;
	const mounted = (snapshot.componentWidgets?.length ?? 0) > 0 || snapshot.widgets.length > 0;
	return mounted && (snapshot.shortcuts?.length ?? 0) > 0;
}

/** The icon for one action, by what its description names. Unknown descriptions get the generic glyph. */
function entryIcon(actions: readonly ExtensionShortcutAction[]): string {
	const text = actions.map((action) => `${action.description ?? ""} ${action.key}`).join(" ").toLowerCase();
	if (text.includes("todo")) return "list-checks";
	return "puzzle";
}

/**
 * The way into an extension's shortcut actions, at the end of the context row,
 * to the left of the subagent monitor's icon.
 *
 * The shortcuts surface used to render as a `<details>` row pinned under the
 * composer — a permanent strip for a control most turns never touch, and one
 * more thing between the editor and the footer. The actions live here instead:
 * one icon in the row the user already reads before every send, its actions in
 * a popover above it. The same shape as the subagent entry icon beside it and
 * the context chips to its left, so the row stays one vocabulary.
 *
 * The click route and the keyboard route meet in the same place: this button
 * calls the action's `run`, and the shortcut the extension bound — its own
 * hotkey, unchanged — reaches the same `run` through the panel's textarea
 * handler. Neither route bypasses the other's guard rails.
 *
 * A run in flight breathes, the way the subagent icon does for a running child;
 * a failed run carries a red dot, because a press that did nothing must not be
 * silent. Both states keep the icon visible on their own: feedback the user
 * triggered outlives the panel that caused it until the next action or a
 * session rebuild clears it.
 */
/**
 * A count riding on the icon's corner. The caller localizes `label` (the icon's
 * accessible name while the badge shows) and picks `settled`; the icon itself
 * stays extension-agnostic and never reads what the number means.
 */
export interface ExtensionEntryBadge {
	readonly text: string;
	readonly settled: boolean;
	readonly label: string;
}

export function ExtensionEntryIcon({ snapshot, badge }: { snapshot: ExtensionUISnapshot; badge?: ExtensionEntryBadge }): React.JSX.Element | null {
	const t = useT();
	const actions = snapshot.shortcuts ?? [];
	const [isOpen, setIsOpen] = useState(false);
	const wrapperRef = useRef<HTMLSpanElement | null>(null);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	// Wires the icon to the popover it opens, for assistive tech that announces
	// what a toggle controls. `useId` because two chat panels could mount at once.
	const popoverId = useId();

	const pending = snapshot.shortcutPending;
	const failed = snapshot.shortcutError;

	useEffect(() => {
		// A run started from the popover keeps it open — the pending row and the
		// re-enabled rows are the receipt — but a run that failed leaves the
		// popover no quieter than the icon's dot does.
		if (failed) setIsOpen(true);
	}, [failed]);

	usePointerDownOutside(wrapperRef, isOpen, () => setIsOpen(false));

	if (!hasExtensionEntry(snapshot)) {
		return null;
	}

	const hasMultipleActions = actions.length > 1;
	const singleAction = actions.length === 1 ? actions[0] : undefined;

	const singleActionLabel = singleAction
		? (singleAction.description ? `${singleAction.description} (${singleAction.key})` : singleAction.key)
		: undefined;
	// A failed run owns the corner with its dot, so the badge stands down until the
	// failure clears; when it shows, the count becomes the icon's accessible name —
	// the digit itself is aria-hidden, the way the subagent badge's is.
	const badgeVisible = Boolean(badge) && !failed;
	const label = (badgeVisible ? badge?.label : undefined) ?? singleActionLabel ?? t.t("extensionUI.entryAria");

	const handleButtonClick = () => {
		if (hasMultipleActions || pending || failed) {
			setIsOpen((open) => !open);
			return;
		}
		if (singleAction) {
			void singleAction.run();
		}
	};

	const handleButtonMouseOver = (event: React.MouseEvent<HTMLElement>) => {
		// Single action without error: let Obsidian's native hover tooltip display the
		// action description and hotkey.
		// Multiple actions or error popover: suppress the container tooltip so it doesn't
		// compete with the popover.
		if (hasMultipleActions || isOpen) {
			suppressOwnTooltip(event);
		}
	};

	const handleRunAction = (action: ExtensionShortcutAction) => {
		setIsOpen(false);
		buttonRef.current?.focus();
		void action.run();
	};

	const handlePopoverKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			// The composer and the transcript have their own Escape handlers;
			// this press is about the popover and stops here.
			event.stopPropagation();
			setIsOpen(false);
			buttonRef.current?.focus();
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			const buttons = popoverRef.current?.querySelectorAll<HTMLButtonElement>("button.piem-chat__extension-entry-action:not(:disabled)");
			if (!buttons || buttons.length === 0) return;
			const list = Array.from(buttons);
			const activeIndex = list.indexOf(document.activeElement as HTMLButtonElement);
			let nextIndex = 0;
			if (event.key === "ArrowDown") {
				nextIndex = activeIndex === -1 || activeIndex === list.length - 1 ? 0 : activeIndex + 1;
			} else {
				nextIndex = activeIndex <= 0 ? list.length - 1 : activeIndex - 1;
			}
			list[nextIndex]?.focus();
		}
	};

	return (
		<span className="piem-chat__extension-entry" ref={wrapperRef}>
			<button
				ref={buttonRef}
				type="button"
				/*
				 * `clickable-icon` is load-bearing, not cosmetic: Obsidian styles every
				 * `button:not(.clickable-icon)` as a filled form control at a
				 * specificity a plain class cannot outrank, so dropping it hands the
				 * glyph to the theme's button chrome rather than freeing it from it.
				 */
				className={`clickable-icon piem-chat__icon-button piem-chat__extension-entry-button${pending ? " piem-chat__extension-entry-button--running" : ""}${failed ? " piem-chat__extension-entry-button--failed" : ""}`}
				aria-expanded={hasMultipleActions || isOpen ? isOpen : undefined}
				aria-controls={hasMultipleActions || isOpen ? popoverId : undefined}
				aria-label={label}
				/*
				 * Swallows the tooltip Obsidian hangs off this label on hover when a popover
				 * menu is attached or open: the popover already says more than it would, and on a
				 * pointer device both would open at once. For a single action without an open popover,
				 * the tooltip is permitted so hover surfaces the action name and hotkey.
				 */
				onMouseOver={handleButtonMouseOver}
				onClick={handleButtonClick}
			>
				<ObsidianIcon name={entryIcon(actions)} className="piem-chat__extension-entry-icon" />
				{badgeVisible ? (
					<span
						className={`piem-chat__extension-entry-badge${badge?.settled ? " piem-chat__extension-entry-badge--settled" : ""}`}
						aria-hidden="true"
					>
						{badge?.text}
					</span>
				) : null}
				{failed ? <span className="piem-chat__extension-entry-failed-dot" aria-hidden="true" /> : null}
			</button>
			{isOpen ? (
				<div
					ref={popoverRef}
					id={popoverId}
					className="piem-chat__extension-entry-popover"
					role="menu"
					aria-label={t.t("extensionUI.entryAria")}
					onMouseOver={suppressOwnTooltip}
					onKeyDown={handlePopoverKeyDown}
				>
					{hasMultipleActions ? (
						<div className="piem-chat__extension-entry-header">
							<ObsidianIcon name="zap" className="piem-chat__extension-entry-header-icon" />
							<span className="piem-chat__extension-entry-header-title">{t.t("extensionUI.actionsLabel")}</span>
						</div>
					) : null}
					<div className="piem-chat__extension-entry-list" role="none">
						{actions.map((action) => (
							<button
								key={action.key}
								type="button"
								role="menuitem"
								className="piem-chat__extension-entry-action"
								disabled={Boolean(pending)}
								onClick={() => handleRunAction(action)}
							>
								<span className="piem-chat__extension-entry-action-label" title={action.description || action.key}>
									{action.description || action.key}
								</span>
								<kbd className="piem-chat__extension-entry-kbd">{action.key}</kbd>
							</button>
						))}
					</div>
					{pending ? <div className="piem-chat__extension-entry-status" role="status">{t.t("extensionUI.runningAction")}</div> : null}
					{failed ? <p className="piem-native-extension__error" role="alert">{failed}</p> : null}
				</div>
			) : null}
		</span>
	);
}
