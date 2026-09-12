import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { consumeDraftContent, type DraftContent, type DraftStore } from "../session/DraftStore";
import type { ContextReference } from "../agent/contextReference";

export interface SessionDraft {
	draft: string;
	references: ContextReference[];
	ready: boolean;
	setDraft: (text: string, references?: readonly ContextReference[]) => void;
	setReferences: (references: readonly ContextReference[]) => void;
	clearDraft: () => void;
	consumeDraft: (sent: DraftContent) => Promise<void>;
}

/** Text and references share one adoption, revision, and persisted draft file. */
export function useSessionDraft(store: DraftStore | undefined, scope: string | undefined): SessionDraft {
	const adoption = useMemo(() => ({ store, scope, revision: 0,
		value: { text: "", references: [] } as DraftContent,
	}), [store, scope]);
	const active = useRef<typeof adoption>();
	const [loaded, setLoaded] = useState<typeof adoption>();
	const [, redraw] = useState(0);

	useLayoutEffect(() => {
		active.current = adoption;
		return () => { active.current = undefined; };
	}, [adoption]);

	useEffect(() => {
		let cancelled = false;
		const revision = adoption.revision;
		if (!store || !scope) { setLoaded(adoption); return; }
		void store.getDraft(scope).then(value => {
			if (cancelled) return;
			if (revision === adoption.revision) adoption.value = value;
			setLoaded(adoption);
			redraw(value => value + 1);
		});
		return () => { cancelled = true; };
	}, [store, scope, adoption]);

	useEffect(() => {
		if (!store || !scope) return;
		return store.subscribe(scope, value => {
			if (active.current !== adoption) return;
			adoption.revision++;
			adoption.value = value;
			setLoaded(adoption);
			redraw(revision => revision + 1);
		});
	}, [store, scope, adoption]);

	const setDraft = useCallback((text: string, references?: readonly ContextReference[]) => {
		adoption.revision++;
		adoption.value = { text, references: [...(references ?? adoption.value.references)] };
		if (active.current === adoption) { setLoaded(adoption); redraw(value => value + 1); }
		if (store && scope) void store.set(scope, text, adoption.value.references);
	}, [store, scope, adoption]);

	const setReferences = useCallback((references: readonly ContextReference[]) => {
		setDraft(adoption.value.text, references);
	}, [setDraft, adoption]);

	const clearDraft = useCallback(() => {
		adoption.revision++;
		adoption.value = { text: "", references: [] };
		if (active.current === adoption) { setLoaded(adoption); redraw(value => value + 1); }
		if (store && scope) void store.clear(scope);
	}, [store, scope, adoption]);

	const consumeDraft = useCallback(async (sent: DraftContent) => {
		if (store && scope) { await store.consume(scope, sent); return; }
		const next = consumeDraftContent(adoption.value, sent);
		setDraft(next.text, next.references);
	}, [store, scope, adoption, setDraft]);

	// Writes already land in the store on every mutation; unmount only flushes.
	useEffect(() => () => { void store?.flush(); }, [store]);
	const ready = !scope || loaded === adoption;
	return { draft: scope && ready ? adoption.value.text : "", references: scope && ready ? adoption.value.references : [],
		ready, setDraft, setReferences, clearDraft, consumeDraft };
}
