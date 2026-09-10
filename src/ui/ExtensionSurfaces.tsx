import React from "react";
import type { ExtensionUISnapshot } from "./ObsidianExtensionUI";
import { useT } from "./TranslatorContext";
import { NativeExtensionComponents } from "./NativeExtensionComponents";

/** Plain extension text follows the host theme and wraps inside a narrow leaf. */
export function ExtensionSurfaces({ snapshot, placement }: {
	snapshot: ExtensionUISnapshot;
	placement: "aboveEditor" | "belowEditor";
}): React.JSX.Element | null {
	const t = useT();
	const widgets = snapshot.widgets.filter((widget) => widget.placement === placement);
	const components = snapshot.componentWidgets?.filter(widget => widget.placement === placement) ?? [];
	const statuses = placement === "belowEditor" ? snapshot.statuses : [];
	const shortcuts = placement === "belowEditor" ? snapshot.shortcuts ?? [] : [];
	if (widgets.length === 0 && statuses.length === 0 && components.length === 0 && shortcuts.length === 0) return null;
	return (
		<section className="piem-chat__extension-surfaces" aria-label={t.t("extensionUI.contentLabel")}>
			{widgets.map((widget) => <div key={widget.key} className="piem-chat__extension-widget">{widget.lines.join("\n")}</div>)}
			{components.map(widget => <NativeExtensionComponents key={widget.key} surface={widget.surface} />)}
			{statuses.length > 0 ? <div className="piem-chat__extension-status" role="status">
				{statuses.map((status) => <div key={status.key}>{status.text}</div>)}
			</div> : null}
			{shortcuts.length > 0 ? <details className="piem-chat__extension-actions">
				<summary>{t.t("extensionUI.actionsLabel")}</summary>
				<ul>
					{shortcuts.map(action => <li key={action.key}>
						<button type="button" disabled={Boolean(snapshot.shortcutPending)} onClick={() => { void action.run(); }}>
							<span>{action.description || action.key}</span><kbd>{action.key}</kbd>
						</button>
					</li>)}
				</ul>
			</details> : null}
			{placement === "belowEditor" && snapshot.shortcutPending ? <div role="status">{t.t("extensionUI.runningAction")}</div> : null}
			{placement === "belowEditor" && snapshot.shortcutError ? <p className="piem-native-extension__error" role="alert">{snapshot.shortcutError}</p> : null}
		</section>
	);
}
