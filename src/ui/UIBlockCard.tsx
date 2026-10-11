import { type App } from "obsidian";
import * as obsidian from "obsidian";
import React, { useEffect, useRef, useState } from "react";
import { ObsidianIcon } from "./ObsidianIcon";
import { suppressOwnTooltip } from "./tooltipSuppression";
import { asPayloadObject } from "./uiBlockPayload";
import { useT } from "./TranslatorContext";

export interface UIBlockCardProps {
	request: {
		id: string;
		code: string;
		title?: string;
	};
	app: App;
	/** The script's last published state, re-applied across a remount. */
	state?: Record<string, unknown> | null;
	/** The view is on screen. Settles the tool call that presented it. */
	onReady: () => void;
	/** Channel 2: the user did something the agent has to answer. */
	onSendMessage: (data: Record<string, unknown>) => void;
	/** Channel 1: state for the next turn. Does not wake the agent. */
	onUpdate: (state: Record<string, unknown>) => void;
	/** Script-initiated close, and the user's own cancel button. */
	onClose: () => void;
	/** The script threw. Reported without waiting for the user. */
	onFail?: (error: string) => void;
}

type AsyncFunctionConstructor = new (
	...args: string[]
) => (...args: unknown[]) => unknown;

interface AsyncFunctionPrototype {
	constructor: AsyncFunctionConstructor;
}

export function UIBlockCard({
	request,
	app,
	state = null,
	onReady,
	onSendMessage,
	onUpdate,
	onClose,
	onFail,
}: UIBlockCardProps): React.JSX.Element {
	const t = useT();
	const sectionRef = useRef<HTMLElement | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [error, setError] = useState<string | null>(null);

	/*
	 * Refs, not dependencies. The effect below runs the script, and re-running it
	 * is a remount: every control is rebuilt and whatever the user had typed into
	 * one is gone. A parent that re-renders with a fresh callback identity — which
	 * is every render, since the panel builds these inline — must not be able to
	 * cause that. The effect's dependency list is the instance's identity only.
	 */
	const handlers = useRef({ onReady, onSendMessage, onUpdate, onClose, onFail });
	handlers.current = { onReady, onSendMessage, onUpdate, onClose, onFail };
	/*
	 * Seeded from the prop and then advanced by `ui.update` itself. The prop is
	 * the broker's answer, which only changes when something re-renders the
	 * panel; assigning it on every render is right because the broker is the
	 * source of truth and a render can only have read it after the last publish.
	 */
	const stateRef = useRef(state);
	stateRef.current = state;

	/*
	 * A script that throws reports itself, immediately.
	 *
	 * This used to wait for the user to press "Report error to agent", which made
	 * a render failure the one case that still blocked the tool call on a human —
	 * the exact mechanism this design exists to remove, reached through a door
	 * nobody meant to leave open. The model wrote code that does not run; it does
	 * not need a volunteer to be told so, and inside `codemode` nobody is coming:
	 * the script would sit on the call until the sandbox deadline killed it.
	 *
	 * The error still shows here for the moment the card is on screen, and then
	 * lands where every other tool failure lands — the result row in the
	 * transcript — rather than in a second place with a button on it.
	 */
	const reportFailure = (err: unknown): void => {
		const message = err instanceof Error ? err.message : String(err);
		setError(message);
		handlers.current.onFail?.(message);
	};

	/*
	 * No focus grab on mount.
	 *
	 * The blocking card took focus because it *was* the turn: nothing else could
	 * proceed until the user answered it, so moving the caret there was moving it
	 * to the only live thing on screen. A delivered view is the opposite — the
	 * agent has moved on, the composer is usable, and several views can be open at
	 * once. Focusing here would pull the caret out of the composer every time one
	 * remounted (a reopened panel, a switched session), which is a view stealing
	 * the keyboard from someone typing to the agent about something else.
	 */

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		container.empty?.();
		setError(null);

		let isMounted = true;

		/*
		 * Every channel is gated on `isMounted`. A script that keeps a timer or an
		 * async handler alive can reach these after its view is gone — a remount, a
		 * closed panel, a switched session — and the instance it is addressing may
		 * already be closed. The broker ignores an unknown id, so this is the second
		 * of two guards rather than the only one, but it is the one that keeps a
		 * stale closure from reporting state for a view the user is no longer
		 * looking at.
		 */
		const ui = {
			id: request.id,
			/*
			 * A getter, not the value. The script's whole lifetime is inside this
			 * effect — a handler it registers reads `ui.state` minutes after mount —
			 * and a captured value would hand it whatever was stored when the view
			 * opened, forever. Its own `ui.update` would not be visible to it, which
			 * is the opposite of what the parameter's description promises.
			 */
			get state(): Record<string, unknown> | null {
				return stateRef.current;
			},
			sendMessage: (data?: unknown): void => {
				if (!isMounted) return;
				handlers.current.onSendMessage(asPayloadObject(data));
			},
			update: (next?: unknown): void => {
				if (!isMounted) return;
				const published = asPayloadObject(next);
				// Advanced here as well as published, because `update` deliberately
				// does not notify — re-rendering the panel would remount this card and
				// destroy the interaction that called it. Without this the `state`
				// getter above would read a prop that nothing refreshes until some
				// unrelated render happens to come along.
				stateRef.current = published;
				handlers.current.onUpdate(published);
			},
			close: (): void => {
				if (!isMounted) return;
				handlers.current.onClose();
			},
		};

		let cleanup: (() => void) | undefined;
		/*
		 * Readiness is "the script finished setting up", which for an async script
		 * is its promise resolving — not the synchronous return of a function that
		 * has only kicked off its own loading. The tool call is waiting on this, so
		 * announcing it early would report a view as delivered while it was still
		 * blank.
		 */
		const announceReady = (): void => {
			if (!isMounted) return;
			handlers.current.onReady();
		};

		try {
			const asyncProto = Object.getPrototypeOf(async function () {}) as AsyncFunctionPrototype;
			const AsyncFunction = asyncProto.constructor;
			const runner = new AsyncFunction(
				"container",
				"obsidian",
				"app",
				"ui",
				`"use strict";\n${request.code}`,
			);
			const result: unknown = runner(container, obsidian, app, ui);
			if (result instanceof Promise) {
				result
					.then((resolved: unknown) => {
						if (!isMounted) {
							if (typeof resolved === "function") {
								try {
									(resolved as () => void)();
								} catch {
									// Ignore errors during teardown
								}
							}
							return;
						}
						if (typeof resolved === "function") {
							cleanup = resolved as () => void;
						}
						announceReady();
					})
					.catch((err: unknown) => {
						if (isMounted) {
							reportFailure(err);
						}
					});
			} else {
				if (typeof result === "function") {
					cleanup = result as () => void;
				}
				announceReady();
			}
		} catch (err: unknown) {
			reportFailure(err);
		}

		return () => {
			isMounted = false;
			try {
				cleanup?.();
			} catch {
				// Teardown errors should not unmount the parent.
			}
			container.empty?.();
		};
	}, [request.id, request.code, app]);

	return (
		<section
			ref={sectionRef}
			className="piem-ui-block-card piem-ui-block-card--live"
			tabIndex={-1}
			aria-label={t.t("uiBlock.cardLabel")}
			onMouseOver={suppressOwnTooltip}
		>
			<div className="piem-ui-block-card__header">
				<ObsidianIcon name="layout" className="piem-ui-block-card__icon" />
				<span className="piem-ui-block-card__title">
					{request.title || t.t("uiBlock.defaultTitle")}
				</span>
				<div className="piem-ui-block-card__state">
					<button
						type="button"
						className="piem-ui-block-card__dismiss clickable-icon"
						aria-label={t.t("uiBlock.close")}
						onClick={() => handlers.current.onClose()}
					>
						<ObsidianIcon name="x" />
					</button>
				</div>
			</div>

			{error ? (
				<div className="piem-ui-block-card__error" role="alert">
					<div className="piem-ui-block-card__error-title">
						{t.t("uiBlock.errorTitle")}
					</div>
					<div className="piem-ui-block-card__error-message">{error}</div>
				</div>
			) : null}

			<div ref={containerRef} className="piem-ui-block-card__body" />
		</section>
	);
}

/**
 * What stands in the transcript for a view that is no longer live.
 *
 * Two different facts reach this, and conflating them is what the old copy did:
 * a view the user closed after using it, and a view that never opened at all.
 * The first is the ordinary end of a delivered view and says nothing about
 * whether the user got what they needed; the second is a report that the agent's
 * attempt to show something failed.
 */
export interface UIBlockReceiptProps {
	title?: string;
	/** True when the view was closed before it ever reached the screen. */
	undelivered?: boolean;
}

export function UIBlockReceipt({ title, undelivered }: UIBlockReceiptProps): React.JSX.Element {
	const t = useT();

	return (
		<section
			className={`piem-ui-block-card piem-ui-block-card--settled ${
				undelivered ? "piem-ui-block-card--dismissed" : "piem-ui-block-card--completed"
			}`}
			aria-label={t.t("uiBlock.cardLabel")}
			onMouseOver={suppressOwnTooltip}
		>
			<div className="piem-ui-block-card__header">
				<ObsidianIcon
					name={undelivered ? "circle-slash" : "layout"}
					className="piem-ui-block-card__icon"
				/>
				<span className="piem-ui-block-card__title">
					{title || t.t("uiBlock.defaultTitle")}
				</span>
				<div className="piem-ui-block-card__state">
					<span className="piem-ui-block-card__status-text">
						{t.t(undelivered ? "uiBlock.undelivered" : "uiBlock.closed")}
					</span>
				</div>
			</div>
		</section>
	);
}
