import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import type { ObsidianAgentService } from "../agent/ObsidianAgentService";
import { getT, type Language } from "../i18n";
import type { CommandEntry } from "./CommandMenu";
import { createComposerAutocomplete } from "./extensionAutocomplete";
import { EMPTY_EXTENSION_UI, ObsidianExtensionUI } from "./ObsidianExtensionUI";

const subscribeEmpty = (): (() => void) => () => {};
const getEmpty = () => EMPTY_EXTENSION_UI;

/** Binds a live panel, with identity checks before every write to its draft. */
export function useExtensionUI(
	service: ObsidianAgentService,
	sessionPath: string | undefined,
	language: Language,
	commands: CommandEntry[],
	inputRef: MutableRefObject<string>,
	setInput: (value: string) => void,
	draftReady: boolean,
) {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const editorCleanup = useRef<(() => void) | undefined>();
	const current = useRef({ service, sessionPath, language, commands, setInput, inputRef, draftReady });
	current.current = { service, sessionPath, language, commands, setInput, inputRef, draftReady };
	const [attachment, setAttachment] = useState<{ service: ObsidianAgentService; sessionPath: string; adapter: ObsidianExtensionUI }>();
	const adapter = attachment?.service === service && attachment.sessionPath === sessionPath && draftReady ? attachment.adapter : undefined;
	const activeAdapter = useRef(adapter);
	activeAdapter.current = adapter;
	const snapshot = useSyncExternalStore(adapter?.subscribe ?? subscribeEmpty, adapter?.getSnapshot ?? getEmpty);
	useEffect(() => {
		if (!sessionPath || !draftReady) return;
		const write = (text: string): void => {
			current.current.inputRef.current = text;
			current.current.setInput(text);
		};
		// Each attachment owns a new adapter. StrictMode's cleanup/remount and a
		// draft-store reload must never bring a disposed conversation back to life.
		const next = new ObsidianExtensionUI(service.getApp(), () => getT(current.current.language), {
			isCurrent: () => current.current.service === service && current.current.draftReady
				&& current.current.sessionPath === sessionPath && service.getSnapshot().session?.path === sessionPath,
			getText: () => current.current.inputRef.current,
			setText: (text) => {
				write(text);
				const textarea = textareaRef.current;
				if (textarea) {
					textarea.value = text;
					textarea.setSelectionRange(text.length, text.length);
				}
			},
			paste: (text) => {
				const input = current.current.inputRef.current;
				const textarea = textareaRef.current;
				const start = textarea?.selectionStart ?? input.length;
				const end = textarea?.selectionEnd ?? start;
				const next = input.slice(0, start) + text + input.slice(end);
				write(next);
				if (textarea) {
					textarea.value = next;
					textarea.setSelectionRange(start + text.length, start + text.length);
				}
			},
		}, createComposerAutocomplete(() => current.current.commands));
		setAttachment({ service, sessionPath, adapter: next });
		const detach = service.attachExtensionUI(sessionPath, next);
		return () => {
			detach();
			next.dispose();
		};
	}, [service, sessionPath, draftReady]);
	const bindEditor = useCallback((element: HTMLTextAreaElement | null) => {
		editorCleanup.current?.();
		editorCleanup.current = undefined;
		textareaRef.current = element;
		if (!element) return;
		const handle = (event: KeyboardEvent): void => {
			if (event.target === element) activeAdapter.current?.handleShortcut(event);
		};
		element.addEventListener("keydown", handle);
		editorCleanup.current = () => element.removeEventListener("keydown", handle);
	}, []);
	useEffect(() => {
		// StrictMode replays effects without replacing the textarea ref.
		bindEditor(textareaRef.current);
		return () => { editorCleanup.current?.(); editorCleanup.current = undefined; };
	}, [bindEditor]);
	return { snapshot, bindEditor };
}
