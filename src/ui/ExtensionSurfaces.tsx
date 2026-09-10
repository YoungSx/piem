import React from "react";
import type { ExtensionUISnapshot } from "./ObsidianExtensionUI";
import { useT } from "./TranslatorContext";

/** Plain extension text follows the host theme and wraps inside a narrow leaf. */
export function ExtensionSurfaces({ snapshot, placement }: {
	snapshot: ExtensionUISnapshot;
	placement: "aboveEditor" | "belowEditor";
}): React.JSX.Element | null {
	const t = useT();
	const widgets = snapshot.widgets.filter((widget) => widget.placement === placement);
	const statuses = placement === "belowEditor" ? snapshot.statuses : [];
	if (widgets.length === 0 && statuses.length === 0) return null;
	return (
		<section className="piem-chat__extension-surfaces" aria-label={t.t("extensionUI.contentLabel")}>
			{widgets.map((widget) => <div key={widget.key} className="piem-chat__extension-widget">{widget.lines.join("\n")}</div>)}
			{statuses.length > 0 ? <div className="piem-chat__extension-status" role="status">
				{statuses.map((status) => <div key={status.key}>{status.text}</div>)}
			</div> : null}
		</section>
	);
}
