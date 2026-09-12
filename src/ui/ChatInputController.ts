import type { ContextReference } from "../agent/contextReference";

type SubmitHandler = () => void;

type FocusHandler = () => void;
export type PrefillResult = boolean | "reported";
export interface ComposerPrefill { text: string; references?: readonly ContextReference[] }
type PrefillHandler = (text: string, references?: readonly ContextReference[]) => PrefillResult | void;

export class ChatInputController {
	private submitHandler: SubmitHandler | null = null;
	private focusHandler: FocusHandler | null = null;
	private prefillHandler: PrefillHandler | null = null;
	private prefillSession: string | undefined;
	private focusPending = false;
	/**
	 * A queued focus must not fire before queued prefills land, or the caret
	 * would sit at the start of a draft the prefill is about to extend.
	 */
	private focusWaitingForPrefill = false;
	/** Queued prefill texts, replayed in order once the composer registers. */
	private prefillQueue: { request: ComposerPrefill; session?: string; resolve: (accepted: PrefillResult) => void }[] = [];

	setSubmitHandler(handler: SubmitHandler | null): void {
		this.submitHandler = handler;
	}

	setFocusHandler(handler: FocusHandler | null): void {
		this.focusHandler = handler;
		if (!handler) {
			// The composer is gone, so a queued request would land in an unrelated panel.
			this.focusPending = false;
			this.focusWaitingForPrefill = false;
			return;
		}
		if (!this.focusPending) {
			return;
		}
		this.focusPending = false;
		if (this.prefillQueue.length > 0) {
			// Hold the focus until queued prefills are rendered; the composer calls
			// {@link notifyPrefillCommitted} after each one commits.
			this.focusWaitingForPrefill = true;
			return;
		}
		handler();
	}

	setPrefillHandler(handler: PrefillHandler | null, session?: string): void {
		this.prefillHandler = handler;
		this.prefillSession = session;
		if (!handler) {
			// Same reasoning as the focus queue: never deliver into an unmounted composer.
			for (const request of this.prefillQueue.splice(0)) request.resolve(false);
			this.focusWaitingForPrefill = false;
			return;
		}
		while (this.prefillQueue.length > 0) {
			const request = this.prefillQueue.shift();
			if (request) {
				request.resolve(!request.session || request.session === session ? handler(request.request.text, request.request.references) ?? true : false);
			}
		}
	}

	/** Wait for this conversation's draft to load without losing queued references. */
	suspendPrefill(): void {
		this.prefillHandler = null;
	}

	submit(): void {
		this.submitHandler?.();
	}

	focus(): void {
		if (!this.focusHandler) {
			this.focusPending = true;
			return;
		}
		this.focusHandler();
	}

	/**
	 * Delivers `text` to the composer, or latches it when none is mounted yet.
	 *
	 * The chat view mounts React asynchronously after `activateChatView`, so a
	 * command can reach this before the composer exists — mirroring
	 * {@link focus}. Delivery appends rather than overwrites: the user may have
	 * typed a draft already.
	 */
	prefill(text: string, session?: string, references?: readonly ContextReference[]): Promise<PrefillResult> {
		if (!this.prefillHandler) {
			return new Promise(resolve => this.prefillQueue.push({ request: { text, references }, session, resolve }));
		}
		return Promise.resolve(!session || session === this.prefillSession ? this.prefillHandler(text, references) ?? true : false);
	}

	/**
	 * Called by the composer once delivered prefill text is actually rendered,
	 * releasing a focus that was held back so the caret lands after the new text.
	 */
	notifyPrefillCommitted(): void {
		if (!this.focusWaitingForPrefill || !this.focusHandler) {
			return;
		}
		this.focusWaitingForPrefill = false;
		this.focusHandler();
	}
}
