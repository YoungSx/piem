import React, { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal, type App } from "obsidian";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../i18n";

type DialogRequest =
	| { kind: "select"; title: string; options: string[] }
	| { kind: "confirm"; title: string; message: string }
	| { kind: "input"; title: string; placeholder?: string }
	| { kind: "editor"; title: string; prefill?: string };

type DialogResult = string | boolean | undefined;

/** Native Obsidian focus trapping and dismissal, with a React-owned form. */
export class ExtensionDialog extends Modal {
	readonly result: Promise<DialogResult>;
	private resolveResult!: (value: DialogResult) => void;
	private root: Root | undefined;
	private settled = false;
	private timeoutId: number | undefined;
	private readonly abort = (): void => this.close();

	constructor(
		app: App,
		private readonly t: Translator,
		private readonly request: DialogRequest,
		private readonly options: ExtensionUIDialogOptions = {},
	) {
		super(app);
		this.result = new Promise((resolve) => { this.resolveResult = resolve; });
	}

	onOpen(): void {
		if (this.options.signal?.aborted) {
			this.close();
			return;
		}
		this.setTitle(this.request.title);
		this.contentEl.classList.add("piem-extension-dialog");
		this.root = createRoot(this.contentEl.createDiv());
		this.root.render(<ExtensionDialogForm request={this.request} t={this.t} onFinish={(value) => this.finish(value)} />);
		this.options.signal?.addEventListener("abort", this.abort, { once: true });
		const timeout = this.options.timeout;
		if (timeout !== undefined && Number.isFinite(timeout)) {
			const deadline = Date.now() + Math.max(0, timeout);
			const countdown = this.contentEl.createEl("p", { cls: "piem-extension-dialog__timeout" });
			// One short-lived timer only while this dialog is visible. Closing it
			// removes both the timer and its abort listener, including on unload.
			const update = (): void => {
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					this.close();
					return;
				}
				countdown.textContent = this.t.t("extensionUI.expiresIn", { seconds: Math.ceil(remaining / 1000) });
				this.timeoutId = window.setTimeout(update, Math.min(remaining, 1000));
			};
			update();
		}
	}

	onClose(): void {
		this.options.signal?.removeEventListener("abort", this.abort);
		if (this.timeoutId !== undefined) {
			window.clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
		const root = this.root;
		this.root = undefined;
		// A conversation switch can close us inside the panel's React cleanup.
		// Detach the modal now and release its independent root after that commit.
		if (root) queueMicrotask(() => root.unmount());
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolveResult(undefined);
		}
	}

	private finish(value: DialogResult): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveResult(value);
		this.close();
	}
}

function ExtensionDialogForm({ request, t, onFinish }: {
	request: DialogRequest;
	t: Translator;
	onFinish: (value: DialogResult) => void;
}): React.JSX.Element {
	const formRef = useRef<HTMLFormElement>(null);
	useEffect(() => {
		formRef.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
	}, []);
	return (
		<form ref={formRef} onSubmit={(event) => {
			event.preventDefault();
			const field = formRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[name=answer]");
			onFinish(request.kind === "confirm" ? true : field?.value);
		}}>
			{request.kind === "confirm" ? <p>{request.message}</p> : (
				<label className="piem-extension-dialog__field">
					<span>{request.title}</span>
					{request.kind === "select" ? (
						<select name="answer" defaultValue={request.options[0]}>
							{request.options.map((option, index) => <option key={index} value={option}>{option}</option>)}
						</select>
					) : request.kind === "editor" ? (
						<textarea name="answer" defaultValue={request.prefill ?? ""} rows={8} />
					) : <input name="answer" type="text" placeholder={request.placeholder} />}
				</label>
			)}
			<div className="modal-button-container">
				<button type="button" onClick={() => onFinish(undefined)}>{t.t("extensionUI.cancel")}</button>
				<button type="submit" className="mod-cta" disabled={request.kind === "select" && request.options.length === 0}>
					{t.t(request.kind === "editor" ? "extensionUI.save" : "extensionUI.confirm")}
				</button>
			</div>
		</form>
	);
}
