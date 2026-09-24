import React from "react";
import type { ExtensionUISnapshot } from "./ObsidianExtensionUI";
import { useT } from "./TranslatorContext";
import { NativeExtensionComponents } from "./NativeExtensionComponents";
import { plainText } from "../extensions/compat/textMetrics";
import { ExtensionStyledText, trimEdgeBlankLines } from "./extensionStyledText";

/** Plain extension text follows the host theme and wraps inside a narrow leaf. */
export function ExtensionSurfaces({ snapshot, placement, excludeComponentKeys }: {
	snapshot: ExtensionUISnapshot;
	placement: "aboveEditor" | "belowEditor";
	/** Component-widget keys another surface renders instead — kept generic so
	 *  this renderer never learns an extension's identity; the composition layer
	 *  names them. Scoped to component widgets only, matching what those surfaces
	 *  recover, so a same-key text widget still falls through to the generic path. */
	excludeComponentKeys?: readonly string[];
}): React.JSX.Element | null {
	const t = useT();
	const excludedComponent = (key: string): boolean => excludeComponentKeys?.includes(key) ?? false;
	const widgets = snapshot.widgets.filter((widget) => widget.placement === placement);
	const components = snapshot.componentWidgets?.filter(widget => widget.placement === placement && !excludedComponent(widget.key)) ?? [];
	const statuses = placement === "belowEditor" ? snapshot.statuses : [];
	const workingMessage = placement === "belowEditor" ? snapshot.workingMessage : undefined;
	if (widgets.length === 0 && statuses.length === 0 && components.length === 0 && !workingMessage) return null;
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
			{statuses.length > 0 || workingMessage ? <div className="piem-chat__extension-status" role="status">
				{workingMessage ? <div className="piem-chat__extension-working-message"><ExtensionStyledText text={plainText(workingMessage, true)} /></div> : null}
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
