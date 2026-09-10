import React, { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal, type App } from "obsidian";
import type { NativeExtensionSurface } from "../extensions/extensionUI";
import type { Translator } from "../i18n";
import { NativeExtensionComponents } from "./NativeExtensionComponents";

/** Obsidian owns focus and dismissal; the bridge owns the component lifetime. */
export class NativeExtensionDialog extends Modal {
	readonly result: Promise<void>;
	private resolveResult!: () => void;
	private root: Root | undefined;
	private closed = false;
	private cancelledByHost = false;
	private readonly abort = (): void => { this.cancelledByHost = true; this.close(); };

	constructor(app: App, private readonly t: Translator, private readonly surface: NativeExtensionSurface, private readonly signal: AbortSignal) {
		super(app);
		this.result = new Promise(resolve => { this.resolveResult = resolve; });
	}

	onOpen(): void {
		if (this.signal.aborted) { this.abort(); return; }
		this.setTitle(this.t.t("extensionUI.dialogTitle"));
		this.contentEl.classList.add("piem-native-extension-dialog");
		this.signal.addEventListener("abort", this.abort, { once: true });
		this.root = createRoot(this.contentEl.createDiv());
		this.root.render(<DialogContents surface={this.surface} t={this.t} onClose={() => this.close()} />);
	}

	onClose(): void {
		if (this.closed) return;
		this.closed = true;
		this.signal.removeEventListener("abort", this.abort);
		const root = this.root;
		this.root = undefined;
		if (root) queueMicrotask(() => root.unmount());
		this.contentEl.empty();
		try {
			if (!this.cancelledByHost) this.surface.cancel();
		} finally { this.resolveResult(); }
	}
}

function DialogContents({ surface, t, onClose }: { surface: NativeExtensionSurface; t: Translator; onClose: () => void }): React.JSX.Element {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const content = ref.current;
		(content?.querySelector<HTMLElement>("[role=option][aria-selected=true]")
			?? content?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
	}, []);
	return <div ref={ref}>
		<NativeExtensionComponents surface={surface} translator={t} />
		<div className="modal-button-container">
			<button type="button" onClick={onClose}>{t.t("extensionUI.cancel")}</button>
		</div>
	</div>;
}
