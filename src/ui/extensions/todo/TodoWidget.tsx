import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import type { NativeExtensionSurface } from "../../../extensions/extensionUI";
import type { ExtensionUISnapshot } from "../../ObsidianExtensionUI";
import type { ExtensionEntryBadge } from "../../ExtensionEntryIcon";
import { NativeExtensionComponents } from "../../NativeExtensionComponents";
import { useT } from "../../TranslatorContext";
import { TODO_WIDGET_KEY, readTodoModel, type TodoModel } from "./todoModel";

/**
 * The mounted rpiv-todo overlay surface, if any. Matched by key AND placement:
 * TodoCard renders in the aboveEditor feed tail, so it must not claim a surface
 * that (on a future, unpinned version) mounts belowEditor — that one stays with
 * the generic renderer, and neither surface double-renders it.
 */
export function findTodoSurface(snapshot: ExtensionUISnapshot): NativeExtensionSurface | undefined {
	return snapshot.componentWidgets?.find(
		(widget) => widget.key === TODO_WIDGET_KEY && widget.placement === "aboveEditor",
	)?.surface;
}

/**
 * The live todo model for a surface. Subscribes to the surface, not the UI
 * snapshot: the overlay's content and its collapse toggle change the surface's
 * node in place and never republish the snapshot — ObsidianExtensionUI only does
 * that on mount/unmount — so a snapshot-only reader would miss both.
 */
export function useTodoModel(surface: NativeExtensionSurface | undefined): TodoModel | null {
	const node = useSyncExternalStore(
		useCallback((listener: () => void) => (surface ? surface.subscribe(listener) : () => {}), [surface]),
		useCallback(() => (surface ? surface.getSnapshot() : undefined), [surface]),
	);
	return useMemo(() => readTodoModel(node), [node]);
}

/**
 * The todo overlay as a card in the feed. Hidden while collapsed — the entry
 * icon's badge carries the count then — and otherwise the extension's own text,
 * unchanged, in a container that reads as a panel rather than loose lines. On an
 * unrecognized shape (model null) it stays shown, so content is never lost.
 */
export function TodoCard({ surface }: { surface: NativeExtensionSurface }): React.JSX.Element | null {
	const model = useTodoModel(surface);
	if (model?.collapsed) return null;
	return (
		<div className="piem-todo-card">
			<NativeExtensionComponents surface={surface} />
		</div>
	);
}

/**
 * The todo progress as a badge for the generic context-row entry icon, or
 * undefined when no todo overlay is mounted. Only a badge crosses the seam — the
 * icon keeps its own generic call site in ChatApp and never learns about todos,
 * mirroring how TodoCard sits beside (not inside) the generic ExtensionSurfaces.
 */
export function useTodoBadge(snapshot: ExtensionUISnapshot): ExtensionEntryBadge | undefined {
	const t = useT();
	const model = useTodoModel(findTodoSurface(snapshot));
	return model
		? {
			text: `${model.completed}/${model.total}`,
			settled: !model.active,
			label: t.t("extensionUI.todoBadgeAria", { completed: model.completed, total: model.total }),
		}
		: undefined;
}
