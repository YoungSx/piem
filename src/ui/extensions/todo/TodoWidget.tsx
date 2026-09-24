import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import type { NativeExtensionSurface } from "../../../extensions/extensionUI";
import type { ExtensionUISnapshot } from "../../ObsidianExtensionUI";
import { NativeExtensionComponents } from "../../NativeExtensionComponents";
import { ExtensionEntryIcon } from "../../ExtensionEntryIcon";
import { useT } from "../../TranslatorContext";
import { TODO_WIDGET_KEY, readTodoModel, type TodoModel } from "./todoModel";

/** The mounted rpiv-todo overlay surface in this snapshot, if any. */
export function findTodoSurface(snapshot: ExtensionUISnapshot): NativeExtensionSurface | undefined {
	return snapshot.componentWidgets?.find((widget) => widget.key === TODO_WIDGET_KEY)?.surface;
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
 * The context-row extension entry icon, wearing the todo progress as a badge.
 * The icon stays generic; this only derives the badge and hands it over, so a
 * different extension mounting the same entry shows the icon with no badge.
 */
export function TodoEntryIcon({ snapshot }: { snapshot: ExtensionUISnapshot }): React.JSX.Element | null {
	const t = useT();
	const model = useTodoModel(findTodoSurface(snapshot));
	const badge = model
		? {
			text: `${model.completed}/${model.total}`,
			settled: !model.active,
			label: t.t("extensionUI.todoBadgeAria", { completed: model.completed, total: model.total }),
		}
		: undefined;
	return <ExtensionEntryIcon snapshot={snapshot} badge={badge} />;
}
