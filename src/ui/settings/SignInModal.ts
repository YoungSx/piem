import { Modal, Notice, Setting, type App } from "obsidian";
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { Translator } from "../../i18n";

/**
 * The dialog a subscription sign-in happens in.
 *
 * It is the plugin's implementation of pi's {@link AuthInteraction}: the flow
 * pushes events at it and it turns them into something a person can act on. Only
 * one event shape actually matters for the flows this build performs — a device
 * code, which is a short string the user types into the provider's own page — so
 * the dialog's whole job is to show that code, offer the page, and then say it is
 * waiting.
 *
 * Two decisions worth stating.
 *
 * The dialog owns the abort. A device-code flow polls until the user finishes,
 * the code expires, or somebody stops it, and "somebody stops it" has to include
 * closing this window — otherwise a dismissed dialog leaves a poll loop running
 * against the provider for the rest of the code's fifteen minutes. So the
 * controller is created here and aborted from `onClose`, whichever way the close
 * came about.
 *
 * `prompt` rejects rather than rendering a field. Nothing in this build calls it:
 * both flows are pure device-code, which is `notify`-only, and the poller never
 * asks the user for anything. A field built for a call that cannot happen would
 * be untested by use — so the honest spelling is a refusal that names what was
 * asked for. The pasted-authorization-code flows (Anthropic, OpenRouter) are what
 * will need it, and they are the piece of work that should add it.
 */

export interface SignInModalOptions {
	app: App;
	/** Provider row name, for the title — the user picked it, so it is what they recognise. */
	target: string;
	/** The sign-in's own name, e.g. "xAI (Grok/X subscription)". */
	method: string;
	/** Whether a credential is already stored, resolved before the dialog opens. */
	signedIn: boolean;
	/** Whether this device can store a credential at all. */
	canStore: boolean;
	t: Translator;
	/**
	 * Runs the provider's login flow against this dialog. Resolves once
	 * persisted.
	 *
	 * The interaction type is pi's `ProviderAuthInteraction` — the signal is
	 * mandatory there, and this dialog is exactly the party that owns one: it
	 * aborts on close, so the flow cannot outlive the window. Declaring the
	 * optional-signal `AuthInteraction` instead would let a caller hand over an
	 * interaction nobody can cancel.
	 */
	signIn(interaction: ProviderAuthInteraction): Promise<void>;
	/** Removes the stored credential. */
	signOut(): Promise<void>;
	/** Called after either operation changes what is stored, so the panel can re-render. */
	onChanged(): void;
}

/** Opens the sign-in dialog for one provider row. */
export function openSignInModal(options: SignInModalOptions): void {
	new SignInModal(options).open();
}

class SignInModal extends Modal {
	private readonly options: SignInModalOptions;
	/**
	 * Aborts the login flow. Fired from `onClose`, so dismissing the dialog stops
	 * the poll rather than orphaning it — see the module header.
	 */
	private readonly controller = new AbortController();
	/** Where every event and verdict is written. Replaced wholesale per update. */
	private body: HTMLElement | null = null;
	/** Guards a second press while a flow is already polling. */
	private running = false;

	constructor(options: SignInModalOptions) {
		super(options.app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("piem-settings-modal");
		const { t } = this.options;
		this.setTitle(t.t("signIn.title", { target: this.options.target }));
		contentEl.createEl("p", { text: t.t("signIn.method", { method: this.options.method }) });
		this.body = contentEl.createDiv({ cls: "piem-sign-in-body" });
		this.showState();
		this.renderActions();
	}

	onClose(): void {
		// Unconditional: a completed flow has already resolved, so aborting is a
		// no-op there, and every other exit is one that must stop the poll.
		this.controller.abort();
		this.contentEl.empty();
	}

	/** The resting message: signed in, signed out, or unable to store anything. */
	private showState(): void {
		const { t } = this.options;
		if (!this.options.canStore) {
			this.write(t.t("signIn.unavailable"));
			return;
		}
		this.write(t.t(this.options.signedIn ? "signIn.signedIn" : "signIn.signedOut"));
	}

	/** Replaces the body with one line of text. */
	private write(text: string): void {
		if (!this.body) {
			return;
		}
		this.body.empty();
		this.body.createEl("p", { text });
	}

	private renderActions(): void {
		const { t } = this.options;
		new Setting(this.contentEl)
			.setClass("piem-settings-modal-footer")
			.addButton((button) => {
				button.setButtonText(t.t("signIn.close"));
				button.onClick(() => this.close());
			})
			.addButton((button) => {
				// Only offered when there is something to remove, so the dialog never
				// invites a sign-out that would do nothing.
				if (!this.options.signedIn) {
					return;
				}
				button.setButtonText(t.t("signIn.signOut")).setDestructive();
				button.onClick(() => void this.runSignOut());
			})
			.addButton((button) => {
				button.setButtonText(t.t(this.options.signedIn ? "signIn.again" : "signIn.start"));
				button.setCta();
				button.setDisabled(!this.options.canStore);
				button.onClick(() => void this.runSignIn());
			});
	}

	private async runSignIn(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		const { t } = this.options;
		this.write(t.t("signIn.starting"));
		try {
			await this.options.signIn({
				signal: this.controller.signal,
				notify: (event) => this.show(event),
				prompt: (prompt) => this.refusePrompt(prompt),
			});
			this.write(t.t("signIn.done"));
			this.options.onChanged();
			new Notice(t.t("signIn.doneNotice", { target: this.options.target }));
			this.close();
		} catch (error) {
			// Including a cancellation, which reads as an error only if the dialog is
			// still open — and if it is not, nobody sees this line anyway.
			this.write(t.t("signIn.failed", { message: describe(error) }));
		} finally {
			this.running = false;
		}
	}

	private async runSignOut(): Promise<void> {
		const { t } = this.options;
		try {
			await this.options.signOut();
			this.options.onChanged();
			new Notice(t.t("signIn.signedOutNotice", { target: this.options.target }));
			this.close();
		} catch (error) {
			// Worth showing rather than swallowing: a refused removal means a live
			// refresh token survived a sign-out, which is the failure, not the tidy-up.
			this.write(t.t("signIn.signOutFailed", { message: describe(error) }));
		}
	}

	/**
	 * Renders one event from the flow.
	 *
	 * `device_code` is the only shape that needs structure — a code to read and a
	 * page to open — so it gets the layout and the other three become a line of
	 * text. `progress` and `info` are written rather than appended because the flow
	 * emits them as a running commentary, and a growing log of "waiting…" is noise.
	 */
	private show(event: AuthEvent): void {
		const { t } = this.options;
		if (event.type === "device_code") {
			this.showDeviceCode(event.userCode, event.verificationUri);
			return;
		}
		if (event.type === "auth_url") {
			this.write(event.instructions ?? t.t("signIn.openPage"));
			this.addLink(event.url);
			return;
		}
		this.write(event.message);
	}

	/** Code, instruction, link, and the fact that we are now waiting. */
	private showDeviceCode(userCode: string, verificationUri: string): void {
		const { t } = this.options;
		if (!this.body) {
			return;
		}
		this.body.empty();
		this.body.createEl("p", { text: t.t("signIn.enterCode") });
		// `code` rather than a styled div: the string is a literal the user has to
		// reproduce exactly, and a monospace run is what says so without a rule in
		// styles.css. Selectable, so it can be copied by hand as well as by button.
		this.body.createEl("p", { cls: "piem-sign-in-code" }).createEl("code", { text: userCode });
		new Setting(this.body)
			.addButton((button) => {
				button.setButtonText(t.t("signIn.copyCode"));
				button.onClick(() => {
					void navigator.clipboard.writeText(userCode).then(() => {
						new Notice(t.t("signIn.codeCopied"));
					});
				});
			})
			.addButton((button) => {
				button.setButtonText(t.t("signIn.openPageButton"));
				button.setCta();
				button.onClick(() => window.open(verificationUri, "_blank"));
			});
		this.addLink(verificationUri);
		this.body.createEl("p", { text: t.t("signIn.waiting") });
	}

	/**
	 * The URL in full, under whatever button opened it.
	 *
	 * Shown as text as well as a button because the two are not interchangeable:
	 * a user signing in on their phone while the vault is on a desktop needs to be
	 * able to read the address, and a user who wants to know where a button is
	 * about to send them deserves to see it first.
	 */
	private addLink(url: string): void {
		this.body?.createEl("p").createEl("a", { text: url, href: url });
	}

	/**
	 * Refuses a prompt this dialog has no field for.
	 *
	 * Unreachable in this build — see the module header — and spelled as a refusal
	 * rather than a silent hang so that adding a flow which does prompt fails
	 * loudly, in the dialog, with the prompt's own type named.
	 */
	private async refusePrompt(prompt: AuthPrompt): Promise<string> {
		throw new Error(this.options.t.t("signIn.promptUnsupported", { kind: prompt.type }));
	}
}

/** A thrown value as a line worth showing. */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
