import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NativeComponentNode } from "../extensions/compat/componentTree";
import type { NativeExtensionSurface } from "../extensions/extensionUI";
import type { Translator } from "../i18n";
import { isComposing } from "./keyboard";
import { useT } from "./TranslatorContext";

/** Renders the component contract, never infers controls from its text. */
export function NativeExtensionComponents({ surface, translator }: {
	surface: NativeExtensionSurface;
	translator?: Translator;
}): React.JSX.Element {
	const inherited = useT();
	const t = translator ?? inherited;
	const rootRef = useRef<HTMLDivElement>(null);
	const measureRef = useRef<HTMLSpanElement>(null);
	const subscribe = useCallback((listener: () => void) => surface.subscribe(listener), [surface]);
	const getSnapshot = useCallback(() => surface.getSnapshot(), [surface]);
	const node = useSyncExternalStore(subscribe, getSnapshot);
	const [failed, setFailed] = useState(false);
	const current = useRef(surface);
	current.current = surface;
	const live = useRef(false);
	useEffect(() => {
		live.current = true;
		setFailed(false);
		return () => { live.current = false; };
	}, [surface]);
	const run = (action: () => void | Promise<void>): void => {
		if (!live.current || current.current !== surface) return;
		setFailed(false);
		const report = (error: unknown): void => {
			if (live.current && current.current === surface && !(error instanceof Error && error.name === "AbortError")) setFailed(true);
		};
		try { void Promise.resolve(action()).catch(report); }
		catch (error) { report(error); }
	};
	useEffect(() => {
		const element = rootRef.current;
		if (!element) return;
		let active = true;
		let previous = 80;
		let observer: ResizeObserver | undefined;
		const measure = (): void => {
			if (!active) return;
			const width = element.getBoundingClientRect().width;
			if (!Number.isFinite(width) || width <= 0) return;
			const measured = (measureRef.current?.getBoundingClientRect().width ?? 0) / 10;
			const fontSize = Number.parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).fontSize ?? "");
			const characterWidth = measured > 0 ? measured : (Number.isFinite(fontSize) ? fontSize : 14) * 0.6;
			const columns = Math.max(1, Math.min(500, Math.floor(width / characterWidth)));
			if (columns === previous) return;
			previous = columns;
			try { surface.resize(columns); }
			catch (error) {
				if (!(error instanceof Error && error.name === "AbortError")) setFailed(true);
			}
		};
		const observe = (): void => {
			observer?.disconnect();
			const owner = element.ownerDocument.defaultView;
			observer = owner?.ResizeObserver ? new owner.ResizeObserver(measure) : undefined;
			observer?.observe(element);
			measure();
		};
		observe();
		const unwatch = element.onWindowMigrated?.(observe);
		return () => { active = false; observer?.disconnect(); unwatch?.(); };
	}, [surface]);
	return <div ref={rootRef} className="piem-native-extension">
		<span ref={measureRef} className="piem-native-extension__measure" aria-hidden="true">0000000000</span>
		<NativeComponent node={node} t={t} run={run} />
		{failed ? <p className="piem-native-extension__error" role="alert">{t.t("extensionUI.actionFailed")}</p> : null}
	</div>;
}

type Action = (action: () => void | Promise<void>) => void;

function NativeComponent({ node, t, run }: { node: NativeComponentNode; t: Translator; run: Action }): React.JSX.Element {
	switch (node.kind) {
		case "container": return <div className="piem-native-extension__container">
			{node.children.map((child, index) => <NativeComponent key={index} node={child} t={t} run={run} />)}
		</div>;
		case "text": return <NativeText node={node} />;
		case "border": return <hr className="piem-native-extension__border" />;
		case "select": return <NativeSelect node={node} t={t} run={run} />;
		case "loader": return <div className="piem-native-extension__loader">
			<div role="status" aria-busy={!node.aborted}>
				{!node.aborted ? <progress aria-label={t.t("extensionUI.loading")} /> : null}
				<span>{node.aborted ? t.t("extensionUI.cancelled") : node.text}</span>
			</div>
			{node.cancellable ? <button type="button" disabled={node.aborted} onClick={() => run(node.onCancel)}>{t.t("extensionUI.cancel")}</button> : null}
		</div>;
	}
}

function NativeText({ node }: { node: Extract<NativeComponentNode, { kind: "text" }> }): React.JSX.Element {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const padding = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(16, value)) : 0;
		ref.current?.setCssProps({
			"--piem-extension-padding-x": `${padding(node.paddingX)}ch`,
			"--piem-extension-padding-y": `${padding(node.paddingY)}em`,
		});
	}, [node.paddingX, node.paddingY]);
	return <div ref={ref} className="piem-native-extension__text">{node.text}</div>;
}

function NativeSelect({ node, t, run }: {
	node: Extract<NativeComponentNode, { kind: "select" }>;
	t: Translator;
	run: Action;
}): React.JSX.Element {
	const listRef = useRef<HTMLDivElement>(null);
	const selected = Math.max(0, Math.min(node.items.length - 1, node.selectedIndex));
	useEffect(() => {
		const visible = Number.isFinite(node.maxVisible) ? Math.max(1, Math.min(20, node.maxVisible)) : 8;
		listRef.current?.setCssProps({ "--piem-extension-visible-count": String(visible) });
	}, [node.maxVisible]);
	useEffect(() => {
		const list = listRef.current;
		const option = list?.querySelector<HTMLElement>("[aria-selected=true]");
		option?.scrollIntoView?.({ block: "nearest" });
		// Programmatic selection must agree with the option a screen reader is
		// focused on. A passive widget must never pull focus from the composer.
		if (list && list.contains(list.ownerDocument.activeElement)) option?.focus();
	}, [selected]);
	if (node.items.length === 0) return <p role="status">{t.t("extensionUI.noOptions")}</p>;
	return <div ref={listRef} className="piem-native-extension__select" role="listbox" aria-label={t.t("extensionUI.optionsLabel")}
		onKeyDown={(event) => {
			if (isComposing(event.nativeEvent) || event.altKey || event.ctrlKey || event.metaKey) return;
			let next = selected;
			if (event.key === "ArrowDown") next = (selected + 1) % node.items.length;
			else if (event.key === "ArrowUp") next = (selected + node.items.length - 1) % node.items.length;
			else if (event.key === "Home") next = 0;
			else if (event.key === "End") next = node.items.length - 1;
			else if (event.key === "Enter" || event.key === " ") {
				event.preventDefault(); event.stopPropagation(); run(() => node.onSelect(selected)); return;
			}
			else if (event.key === "Escape") {
				event.preventDefault(); event.stopPropagation(); run(node.onCancel); return;
			} else return;
			event.preventDefault();
			event.stopPropagation();
			run(() => node.onSelectionChange(next));
			listRef.current?.querySelectorAll<HTMLElement>("[role=option]")[next]?.focus();
		}}>
		{node.items.map((item, index) => <button key={index} type="button" role="option" aria-selected={index === selected}
			tabIndex={index === selected ? 0 : -1} className="piem-native-extension__option"
			onClick={() => run(() => node.onSelect(index))}>
			<span>{item.label}</span>
			{item.description ? <span className="piem-native-extension__description">{item.description}</span> : null}
		</button>)}
	</div>;
}
