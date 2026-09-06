import React, { useCallback, useEffect, useRef } from "react";
import { setIcon, setTooltip, type IconName } from "obsidian";

interface ObsidianIconProps {
	name: IconName;
	className?: string;
}

/**
 * A Lucide glyph, painted into a holder the size of the glyph.
 *
 * `piem-icon` is on every holder rather than left to the callers, because the
 * shape it fixes is a property of `setIcon` and not of any one surface. `setIcon`
 * appends an `<svg>`, which is an inline replaced box: inside a plain `<span>` it
 * sits on the holder's text baseline and the holder's line box adds the font's
 * descender below it, so the holder stands ~2px taller than the glyph and the
 * glyph rides above its own centre. Every row that centres the holder next to a
 * label — trace pills, the tidy button, the switchers — then draws the glyph
 * ~2px above the words (#219). One rule in `styles.css` makes the holder a flex
 * box, which has no line box and therefore no descender to carry.
 */
export function ObsidianIcon({ name, className }: ObsidianIconProps): React.JSX.Element {
	const ref = useRef<HTMLSpanElement | null>(null);

	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		element.empty();
		setIcon(element, name);
	}, [name]);

	return <span ref={ref} className={["piem-icon", className].filter(Boolean).join(" ")} aria-hidden="true" />;
}

interface IconButtonProps {
	icon: IconName;
	label: string;
	onClick: React.MouseEventHandler<HTMLButtonElement>;
	disabled?: boolean;
	className?: string;
	children?: React.ReactNode;
	/**
	 * Exposes the button element, for a caller that has to move focus onto it —
	 * e.g. a control that only appears once the one the user just pressed is gone.
	 *
	 * Spelled out rather than `React.Ref` because React 18's `RefObject.current`
	 * is `readonly` — the callback below assigns through it, which only
	 * type-checks against the mutable half of the union. React 19 widened
	 * `React.Ref` to permit the write; see the pin in `package.json`.
	 */
	buttonRef?: React.RefCallback<HTMLButtonElement> | React.MutableRefObject<HTMLButtonElement | null>;
	/**
	 * What pressing the button opens, when it opens something.
	 *
	 * Assistive tech announces a bare `<button>` as an action that happens, which
	 * is the wrong promise for a control that instead reveals a list of choices:
	 * the user cannot tell before pressing whether they are committing or
	 * browsing. Absent for the buttons that really do just act.
	 */
	hasPopup?: "menu";
	/**
	 * Expander state, for a button that shows and hides a region in place.
	 *
	 * Spelled out rather than accepted as an `aria-expanded` JSX attribute because
	 * TypeScript never type-checks hyphenated attributes — a typo or a dropped
	 * prop would pass compile and simply vanish from the DOM. Absent renders
	 * nothing, for the buttons that only act.
	 */
	ariaExpanded?: boolean;
}

export function IconButton({
	icon,
	label,
	onClick,
	disabled = false,
	className,
	children,
	buttonRef,
	hasPopup,
	ariaExpanded,
}: IconButtonProps): React.JSX.Element {
	const classes = ["clickable-icon", "piem-chat__icon-button", className].filter(Boolean).join(" ");
	const elementRef = useRef<HTMLButtonElement | null>(null);
	const ref = useCallback(
		(element: HTMLButtonElement | null): void => {
			elementRef.current = element;
			if (typeof buttonRef === "function") {
				buttonRef(element);
			} else if (buttonRef) {
				buttonRef.current = element;
			}
		},
		[buttonRef],
	);

	useEffect(() => {
		if (elementRef.current) {
			setTooltip(elementRef.current, label);
		}
	}, [label]);

	return (
		<button
			ref={ref}
			type="button"
			className={classes}
			aria-label={label}
			aria-expanded={ariaExpanded}
			aria-haspopup={hasPopup}
			disabled={disabled}
			onClick={onClick}
		>
			<ObsidianIcon name={icon} />
			{children}
		</button>
	);
}
