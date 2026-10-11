import { type App } from "obsidian";
import * as obsidian from "obsidian";
import React, { useEffect, useRef, useState } from "react";
import { ObsidianIcon } from "./ObsidianIcon";
import { suppressOwnTooltip } from "./tooltipSuppression";
import { useT } from "./TranslatorContext";

function focusIsEditable(root: HTMLElement | null): boolean {
	const active = root?.ownerDocument.activeElement;
	if (!(active instanceof HTMLElement)) return false;
	if (active.isContentEditable) return true;
	const tag = active.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export interface UIBlockCardProps {
	request: {
		id: string;
		code: string;
		title?: string;
	};
	queued?: number;
	app: App;
	onCommit: (data: Record<string, any>) => void;
	onDismiss?: () => void;
}

export function UIBlockCard({
	request,
	queued = 0,
	app,
	onCommit,
	onDismiss,
}: UIBlockCardProps): React.JSX.Element {
	const t = useT();
	const sectionRef = useRef<HTMLElement | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [error, setError] = useState<string | null>(null);

	const onCommitRef = useRef(onCommit);
	onCommitRef.current = onCommit;

	useEffect(() => {
		const card = sectionRef.current;
		if (card && !focusIsEditable(card)) {
			card.focus();
		}
	}, []);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		container.empty?.();
		setError(null);

		let isMounted = true;
		let committed = false;
		const safeCommit = (data?: Record<string, any>): void => {
			if (committed) return;
			committed = true;
			const payload = data && typeof data === "object" ? data : { value: data ?? true };
			onCommitRef.current(payload);
		};

		let cleanup: (() => void) | undefined;

		try {
			const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
			const runner = new AsyncFunction(
				"container",
				"obsidian",
				"app",
				"commit",
				`"use strict";\n${request.code}`,
			);
			const result = runner(container, obsidian, app, safeCommit);
			if (result && typeof result.then === "function") {
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
					})
					.catch((err: unknown) => {
						if (isMounted) {
							setError(err instanceof Error ? err.message : String(err));
						}
					});
			} else if (typeof result === "function") {
				cleanup = result;
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
			className="piem-ui-block-card piem-ui-block-card--pending"
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
					<span className="piem-ui-block-card__waiting-text">
						{t.t("uiBlock.waiting")}
					</span>
					{queued > 0 ? (
						<span className="piem-ui-block-card__queued">
							{t.t("uiBlock.queued", { count: String(queued) })}
						</span>
					) : null}
					<button
						type="button"
						className="piem-ui-block-card__dismiss clickable-icon"
						aria-label={t.t("uiBlock.cancel")}
						onClick={onDismiss}
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

export interface UIBlockReceiptProps {
	title?: string;
	action?: string;
	data?: Record<string, any>;
	dismissed?: boolean;
}


function formatReceiptValue(value: unknown): string {
	if (typeof value === "object" && value !== null) {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

export function UIBlockReceipt({
	title,
	action,
	data,
	dismissed,
}: UIBlockReceiptProps): React.JSX.Element {
	const t = useT();

	// Exclude action if present in data, as it is prominently rendered in the badge.
	const displayData = data ? Object.entries(data).filter(([key]) => key !== "action") : [];

	return (
		<section
			className={`piem-ui-block-card piem-ui-block-card--settled ${
				dismissed ? "piem-ui-block-card--dismissed" : "piem-ui-block-card--completed"
			}`}
			aria-label={t.t("uiBlock.cardLabel")}
			onMouseOver={suppressOwnTooltip}
		>
			<div className="piem-ui-block-card__header">
				<ObsidianIcon
					name={dismissed ? "circle-slash" : "check"}
					className="piem-ui-block-card__icon"
				/>
				<span className="piem-ui-block-card__title">
					{title || t.t("uiBlock.defaultTitle")}
				</span>
				<div className="piem-ui-block-card__state">
					<span className="piem-ui-block-card__status-text">
						{t.t(dismissed ? "uiBlock.cancelled" : "uiBlock.completed")}
					</span>
				</div>
			</div>

			{action ? (
				<div className="piem-ui-block-card__action-row">
					<span className="piem-ui-block-card__action-badge">{action}</span>
				</div>
			) : null}

			{displayData.length > 0 ? (
				<dl className="piem-ui-block-card__record">
					{displayData.map(([key, value]) => (
						<div className="piem-ui-block-card__pair" key={key}>
							<dt className="piem-ui-block-card__key">{key}</dt>
							<dd className="piem-ui-block-card__value">
								{formatReceiptValue(value)}
							</dd>
						</div>
					))}
				</dl>
			) : null}
		</section>
	);
}
