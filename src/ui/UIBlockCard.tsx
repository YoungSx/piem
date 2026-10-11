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
	const stateRef = useRef(state);
	stateRef.current = state;

	const handleCancel = (): void => {
		const { onFail: fail, onClose: close } = handlers.current;
		if (error && fail) {
			fail(error);
		} else {
			close();
		}
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
			state: stateRef.current,
			sendMessage: (data?: unknown): void => {
				if (!isMounted) return;
				handlers.current.onSendMessage(asPayloadObject(data));
			},
			update: (next?: unknown): void => {
				if (!isMounted) return;
				handlers.current.onUpdate(asPayloadObject(next));
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
							setError(err instanceof Error ? err.message : String(err));
						}
					});
			} else {
				if (typeof result === "function") {
					cleanup = result as () => void;
				}
				announceReady();
			}
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : String(err));
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
						onClick={handleCancel}
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
					{onFail ? (
						<button
							type="button"
							className="piem-ui-block-card__error-report mod-warning"
							onClick={() => onFail(error)}
						>
							{t.t("uiBlock.reportError")}
						</button>
					) : null}
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
