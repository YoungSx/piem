import React, { useEffect, useRef, useState, type RefObject } from "react";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { editorOffset, editorPosition } from "./extensionAutocomplete";
import { isComposing } from "./keyboard";
import { useT } from "./TranslatorContext";

interface Props {
	provider: AutocompleteProvider;
	input: string;
	cursor: number;
	force: boolean;
	request: number;
	menuId: string;
	anchorRef: RefObject<HTMLTextAreaElement | null>;
	onInputChange: (value: string) => void;
	onActiveChange: (id: string | null) => void;
	onClose: () => void;
}

/** Async Pi completion data rendered through the composer's native listbox pattern. */
export function ExtensionCompletionMenu({ provider, input, cursor, force, request, menuId, anchorRef, onInputChange, onActiveChange, onClose }: Props): React.JSX.Element | null {
	const t = useT();
	const [result, setResult] = useState<{ input: string; cursor: number; provider: AutocompleteProvider; request: number; suggestions: AutocompleteSuggestions }>();
	const [index, setIndex] = useState(0);
	const [settledRequest, setSettledRequest] = useState<number>();
	const listRef = useRef<HTMLUListElement>(null);
	// A delayed result never names or replaces a different draft/caret/provider.
	const suggestions = result?.input === input && result.cursor === cursor && result.provider === provider && result.request === request ? result.suggestions : undefined;
	const items = suggestions?.items ?? [];
	const activeIndex = Math.min(index, Math.max(0, items.length - 1));
	const activeId = items[activeIndex] ? `${menuId}-extension-${activeIndex}` : null;
	useEffect(() => {
		const controller = new AbortController();
		const position = editorPosition(input, cursor);
		void Promise.resolve().then(() => provider.getSuggestions(position.lines, position.cursorLine, position.cursorCol, { signal: controller.signal, force })).then(
			(value) => {
				if (controller.signal.aborted) return;
				setResult(value ? { input, cursor, provider, request, suggestions: value } : undefined);
				setIndex(0);
				setSettledRequest(request);
			},
			() => {
				if (controller.signal.aborted) return;
				setResult(undefined);
				setSettledRequest(request);
			},
		);
		return () => controller.abort();
	}, [provider, input, cursor, force, request]);

	useEffect(() => {
		onActiveChange(activeId);
		return () => onActiveChange(null);
	}, [activeId, onActiveChange]);
	useEffect(() => {
		(listRef.current?.children[activeIndex] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const apply = (item: AutocompleteItem): void => {
		const anchor = anchorRef.current;
		if (!suggestions || !anchor || anchor.value !== input || anchor.selectionStart !== cursor || anchor.selectionEnd !== cursor) return;
		const position = editorPosition(input, cursor);
		try {
			const completion = provider.applyCompletion(position.lines, position.cursorLine, position.cursorCol, item, suggestions.prefix);
			const value = completion.lines.join("\n");
			const offset = editorOffset(completion.lines, completion.cursorLine, completion.cursorCol);
			onInputChange(value);
			anchor.value = value;
			anchor.focus();
			anchor.setSelectionRange(offset, offset);
		} catch {
			// A failing third-party provider must leave the draft usable.
		} finally {
			onClose();
		}
	};
	const live = useRef({ items, activeIndex, apply, onClose });
	live.current = { items, activeIndex, apply, onClose };
	useEffect(() => {
		const anchor = anchorRef.current;
		if (!anchor) return;
		const handle = (event: KeyboardEvent): void => {
			if (event.target !== anchor || isComposing(event)) return;
			const { items: choices, activeIndex: selected, apply: choose, onClose: close } = live.current;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close();
			} else if (choices.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
				event.preventDefault();
				event.stopPropagation();
				setIndex((selected + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
			} else if (choices.length > 0 && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
				event.preventDefault();
				event.stopPropagation();
				const item = choices[selected];
				if (item) choose(item);
			}
		};
		let doc = anchor.ownerDocument;
		doc.addEventListener("keydown", handle, { capture: true });
		const unwatch = anchor.onWindowMigrated?.((win) => {
			doc.removeEventListener("keydown", handle, { capture: true });
			doc = win.document;
			doc.addEventListener("keydown", handle, { capture: true });
		});
		return () => { doc.removeEventListener("keydown", handle, { capture: true }); unwatch?.(); };
	}, [anchorRef]);
	if (items.length === 0) return force ? <div className="piem-chat__extension-status" role="status">
		{t.t(settledRequest === request ? "extensionUI.noSuggestions" : "extensionUI.loadingSuggestions")}
	</div> : null;
	return (
		<ul ref={listRef} id={menuId} className="piem-chat__command-menu" role="listbox" aria-label={t.t("extensionUI.completionsLabel")}>
			{items.map((item, itemIndex) => <li key={itemIndex} id={`${menuId}-extension-${itemIndex}`} role="option"
				aria-selected={itemIndex === activeIndex} className="piem-chat__command-menu-item">
				<button type="button" className="piem-chat__command-menu-button" tabIndex={-1}
					onMouseEnter={() => setIndex(itemIndex)} onPointerDown={(event) => event.preventDefault()} onClick={() => apply(item)}>
					<span className="piem-chat__command-menu-name">{item.label}</span>
					{item.description ? <span className="piem-chat__command-menu-desc">{item.description}</span> : null}
				</button>
			</li>)}
		</ul>
	);
}
