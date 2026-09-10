import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DraftStore } from "../session/DraftStore";

export interface SessionDraft {
	/** Current composer text. */
	draft: string;
	/** False while adopting this conversation's persisted draft. */
	ready: boolean;
	/** Records a keystroke; persistence is debounced inside the store. */
	setDraft: (text: string) => void;
	/** Clears the draft after a successful send, without waiting for a write. */
	clearDraft: () => void;
}

/**
 * Composer text, scoped to one conversation and persisted across reloads.
 *
 * The draft used to be plain component state, which lost it whenever the leaf
 * unmounted, and switching chats left it in place — so a half-written question
 * for one conversation could be sent to another. Keying on a scope makes the
 * draft follow the conversation rather than the panel.
 *
 * `scope` is the store's key for one composer — the session's own id, as
 * `DraftStore` records. Opaque here on purpose: this hook never parses it, so a
 * scope change is a scope change whatever it was derived from.
 *
 * Written on unmount as well as on a pause: teardown cancels the store's
 * debounce, which is precisely the case (closing the panel mid-sentence) that
 * this exists to survive.
 */
export function useSessionDraft(store: DraftStore | undefined, scope: string | undefined): SessionDraft {
	const [draft, setDraftState] = useState("");
	const scopeRef = useRef<string | undefined>(scope);
	const draftRef = useRef("");
	const writeRevision = useRef(0);
	// Identity belongs to this adoption, not merely the path: A → B → A must
	// finish the new A read before extensions can inspect or fill its draft.
	const adoption = useMemo(() => ({ store, scope }), [store, scope]);
	const activeAdoption = useRef<typeof adoption>();
	const [loadedScope, setLoadedScope] = useState<{ store: DraftStore | undefined; scope: string | undefined }>();
	const loadedRef = useRef(loadedScope);
	const markLoaded = useCallback((loaded: typeof adoption): void => {
		loadedRef.current = loaded;
		setLoadedScope(loaded);
	}, []);

	draftRef.current = draft;

	// A send can settle after switching conversations or closing the panel.
	// Its captured setter still owns the old store key, but no longer the UI.
	// Layout cleanup retires that ownership as soon as the switch commits.
	useLayoutEffect(() => {
		activeAdoption.current = adoption;
		return () => { activeAdoption.current = undefined; };
	}, [adoption]);

	useEffect(() => {
		const previousScope = scopeRef.current;
		scopeRef.current = scope;
		if (!store) {
			if (previousScope !== scope) setDraftState("");
			markLoaded(adoption);
			return undefined;
		}

		// Hand the outgoing branch's text back to the store before adopting the new
		// one, or switching away mid-sentence would drop it.
		if (previousScope && previousScope !== scope && loadedRef.current?.store === store && loadedRef.current.scope === previousScope) {
			void store.set(previousScope, draftRef.current);
		}

		if (!scope) {
			setDraftState("");
			return undefined;
		}

		let cancelled = false;
		const revision = writeRevision.current;
		void store.get(scope).then((stored) => {
			if (!cancelled) {
				// An extension or a keystroke may already have supplied newer text.
				if (revision === writeRevision.current) {
					draftRef.current = stored;
					setDraftState(stored);
				}
				markLoaded(adoption);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [store, scope, adoption, markLoaded]);

	// Flush on unmount: `DraftStore.flush` cancels the debounce and writes, so
	// closing the panel keeps the last keystrokes instead of discarding them.
	useEffect(() => {
		if (!store) {
			return undefined;
		}
		return () => {
			const current = scopeRef.current;
			if (current && loadedRef.current?.store === store && loadedRef.current.scope === current) {
				void store.set(current, draftRef.current).then(() => store.flush());
				return;
			}
			void store.flush();
		};
	}, [store]);

	const setDraft = useCallback(
		(text: string) => {
			if (activeAdoption.current === adoption) {
				writeRevision.current++;
				draftRef.current = text;
				setDraftState(text);
				markLoaded(adoption);
			}
			const current = adoption.scope;
			if (store && current) {
				void store.set(current, text);
			}
		},
		[store, adoption, markLoaded],
	);

	const clearDraft = useCallback(() => {
		if (activeAdoption.current === adoption) {
			writeRevision.current++;
			draftRef.current = "";
			setDraftState("");
			markLoaded(adoption);
		}
		const current = adoption.scope;
		if (store && current) {
			void store.clear(current);
		}
	}, [store, adoption, markLoaded]);

	const ready = !scope || loadedScope === adoption;
	return { draft: scope && ready ? draft : "", ready, setDraft, clearDraft };
}
