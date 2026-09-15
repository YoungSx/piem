import React from "react";
import type { ExtensionUISnapshot } from "./ObsidianExtensionUI";
import { useT } from "./TranslatorContext";
import { NativeExtensionComponents } from "./NativeExtensionComponents";
import { plainText } from "../extensions/compat/textMetrics";
import { ExtensionStyledText, trimEdgeBlankLines } from "./extensionStyledText";

/** Plain extension text follows the host theme and wraps inside a narrow leaf. */
export function ExtensionSurfaces({ snapshot, placement }: {
	snapshot: ExtensionUISnapshot;
	placement: "aboveEditor" | "belowEditor";
}): React.JSX.Element | null {
	const t = useT();
	const widgets = snapshot.widgets.filter((widget) => widget.placement === placement);
	const components = snapshot.componentWidgets?.filter(widget => widget.placement === placement) ?? [];
	const statuses = placement === "belowEditor" ? snapshot.statuses : [];
	if (widgets.length === 0 && statuses.length === 0 && components.length === 0) return null;
	// The feed seat grows with its content — the transcript is the scroller; a
	// nested 25vh viewport here would scroll inside the scroll (see styles.css).
	const inFeed = placement === "aboveEditor";
	return (
		<section
			className={`piem-chat__extension-surfaces${inFeed ? " piem-chat__extension-surfaces--feed" : ""}`}
			aria-label={t.t("extensionUI.contentLabel")}
		>
			{widgets.map((widget) => {
				// Same boundary as the native tree: palette sentinels survive, every
				// raw terminal command (CSI, OSC, C1) is dropped before rendering.
				const lines = trimEdgeBlankLines(widget.lines.map((line) => plainText(line, true)));
				if (lines.length === 0) return null;
				return <div key={widget.key} className="piem-chat__extension-widget"><ExtensionStyledText text={lines.join("\n")} /></div>;
			})}
			{components.map(widget => <NativeExtensionComponents key={widget.key} surface={widget.surface} />)}
			{statuses.length > 0 ? <div className="piem-chat__extension-status" role="status">
				{statuses.map((status) => <div key={status.key}><ExtensionStyledText text={plainText(status.text, true)} /></div>)}
			</div> : null}
			{/*
			 * Extension shortcut actions render nowhere here — they moved to the
			 * context row's entry icon (see ExtensionEntryIcon). This section stays
			 * a content-only surface: text widgets, component widgets and statuses.
			 */}
		</section>
	);
}
