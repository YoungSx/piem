import React, { useEffect, useRef } from "react";
import { MarkdownRenderer, type App, type Component } from "obsidian";
import { resolveTextFace, resolveTextRenderMode, type TextBlockKind } from "./markdownPolicy";
import { routeMarkdownLinkClick } from "./markdownLinks";

export interface MarkdownTextProps {
	text: string;
	kind: TextBlockKind;
	/** True while the surrounding message is still streaming in. */
	isStreaming?: boolean;
	app: App;
	component: Component;
	/**
	 * Note path used to resolve `[[wikilinks]]` and relative image paths; empty
	 * when no note is active.
	 *
	 * Read at render time and deliberately not a re-render trigger — see
	 * {@link MarkdownContainer}.
	 */
	sourcePath: string;
	/**
	 * Extra class for the outer element, e.g. the streaming-caret marker on the
	 * block the model is still writing. Absent for every settled block.
	 */
	className?: string;
}

/**
 * Renders one chat text block.
 *
 * Markdown blocks go through `MarkdownRenderer.render`, which is Obsidian's own
 * sanitizing pipeline — nothing here touches `innerHTML` directly, so model
 * output never reaches the DOM unescaped by us.
 *
 * Plain blocks keep the `<pre>` treatment (streaming text, tool arguments,
 * tool results).
 *
 * Both branches carry the block's typeface class, because the plain branch used
 * to set every kind in the interface font — one declaration covering streaming
 * prose and machine output alike. Prose was right; the output was not. A grep
 * table, a `ls` listing and an indented `JSON.stringify` payload only line up in
 * a fixed-width font, and they were being set proportionally, so their columns
 * did not. The class states the typeface either way rather than leaving it to one
 * blanket rule.
 */
export function MarkdownText({ text, kind, isStreaming = false, app, component, sourcePath, className }: MarkdownTextProps): React.JSX.Element {
	const faceClass = `piem-chat__text--${resolveTextFace(kind)}`;
	const blockClass = className ? `${faceClass} ${className}` : faceClass;
	if (resolveTextRenderMode(kind, isStreaming) === "plain") {
		return <pre className={`piem-chat__text ${blockClass}`}>{text}</pre>;
	}
	return <MarkdownContainer markdown={text} faceClass={blockClass} app={app} component={component} sourcePath={sourcePath} />;
}

/**
 * Thin DOM shell around `MarkdownRenderer.render`.
 *
 * The effect clears the container on every run because `render` appends to it:
 * without that, re-renders of an already-finished message would stack a second
 * copy of the content. The promise result is deliberately not awaited by React
 * state; appending happens inside Obsidian's renderer and cleanup only needs to
 * drop whatever landed.
 *
 * `sourcePath` is read through a ref rather than listed as a dependency. It is
 * only a link-resolution base, and re-rendering because it changed would mean
 * tearing down and re-rendering every block in the transcript through Obsidian's
 * renderer each time the user opened a different note. That used to be
 * unreachable — nothing re-rendered the panel on a note switch — but the context
 * chips subscribe to the workspace, so the switch now reaches React and the
 * dependency would fire on every one. Already-rendered content keeps the path
 * that was current when it rendered, which is the right base for the links it
 * actually contains.
 *
 * The click listener lives in the same effect and closes over that same base, so
 * a link resolves against the note the block was rendered about rather than
 * whichever note happens to be open when it is clicked. The two only differ when
 * the vault holds notes sharing a basename, and there the block's own base is the
 * honest one — the model wrote `[[dup]]` while looking at one of them.
 * {@link routeMarkdownLinkClick} covers why internal links need a listener at all
 * and external ones need none.
 *
 * It is a plain `addEventListener` rather than React's `onClick` or the view's
 * `registerDomEvent`, for one reason each. Everything it listens for was put in
 * the container by Obsidian, not by React, so keeping the listener next to the
 * render call that produced those nodes is what makes the two share a lifetime —
 * and a base. `registerDomEvent` would tie the listener to the *view* instead, so
 * a transcript that scrolled a thousand blocks past would leave a thousand
 * registrations behind on a container each of them no longer owns.
 */
function MarkdownContainer({ markdown, faceClass, app, component, sourcePath }: { markdown: string; faceClass: string; app: App; component: Component; sourcePath: string }): React.JSX.Element {
	const ref = useRef<HTMLDivElement | null>(null);
	const sourcePathRef = useRef(sourcePath);

	sourcePathRef.current = sourcePath;

	useEffect(() => {
		const el = ref.current;
		if (!el) {
			return undefined;
		}
		el.empty();
		const base = sourcePathRef.current;
		void MarkdownRenderer.render(app, markdown, el, base, component).catch((error: unknown) => {
			console.error("piem: markdown render failed", error);
		});
		const onClick = (event: MouseEvent): void => {
			routeMarkdownLinkClick(app, event, base);
		};
		el.addEventListener("click", onClick);
		return () => {
			el.removeEventListener("click", onClick);
			el.empty();
		};
	}, [app, component, markdown]);

	return <div className={`piem-chat__markdown ${faceClass}`} ref={ref} />;
}
