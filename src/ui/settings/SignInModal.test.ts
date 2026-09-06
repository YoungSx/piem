import { describe, expect, it } from "bun:test";
import type { App } from "obsidian";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub } from "../../testUtils/obsidianStub";
import { getT } from "../../i18n";

// A Modal subclass needs a document to build its scaffold in, the dialog body
// calls Obsidian's prototype helpers on it, and the stub has to be registered
// before the import below resolves — so the dialog arrives as a dynamic import
// and nothing at the top of this file touches it statically. Installed here
// rather than relied on from a sibling test file, so this one passes when run
// alone.
installDom();
installObsidianDomHelpers();
installObsidianStub();
const { openSignInModal, SIGN_IN_CANCELLED } = await import("./SignInModal");
type SignInModalOptions = import("./SignInModal").SignInModalOptions;

const t = getT("en");

// The stub installs `window` but not every constructor on globalThis; dispatching
// a keyboard event needs the window's own class, not the test runner's (absent) one.
const KeyboardEvent = (
	window as unknown as { KeyboardEvent: new (type: string, init: { key: string }) => KeyboardEvent }
).KeyboardEvent;

/** The dialog, open, with a sign-in whose fate the test controls. */
function openDialog(overrides: Partial<SignInModalOptions> = {}): {
	content: HTMLElement;
	options: SignInModalOptions;
} {
	const options: SignInModalOptions = {
		app: {} as App,
		target: "My Provider",
		method: "Test Method",
		signedIn: false,
		canStore: true,
		t,
		signIn: async () => {},
		signOut: async () => {},
		onChanged: () => {},
		...overrides,
	};
	openSignInModal(options);
	const modalEl = document.body.lastElementChild as HTMLElement;
	return { content: modalEl.querySelector(".piem-settings-modal") ?? modalEl, options };
}

/** The footer's button whose label matches, read back from the rendered DOM. */
function buttonIn(content: HTMLElement, label: string): HTMLButtonElement {
	const button = Array.from(content.querySelectorAll("button")).find(
		(candidate) => candidate.textContent === label,
	);
	if (!button) {
		throw new Error(`no button labelled ${label} in ${content.innerHTML}`);
	}
	return button;
}

/**
 * The interaction the dialog hands to the flow, captured so a test can drive
 * both ends: the flow's events and prompts against the dialog's rendering.
 */
function captureSignInInteraction(
	run: (interaction: ProviderAuthInteraction) => Promise<void>,
): Pick<SignInModalOptions, "signIn"> {
	return {
		signIn: (interaction) => {
			interactions.push(interaction);
			return run(interaction);
		},
	};
}
const interactions: ProviderAuthInteraction[] = [];

/** Starts the flow from the dialog's own "Sign in" button and waits for the prompt. */
async function startAndAwaitPrompt(content: HTMLElement): Promise<ProviderAuthInteraction> {
	buttonIn(content, t.t("signIn.start")).click();
	await Promise.resolve();
	const interaction = interactions.at(-1);
	if (!interaction) {
		throw new Error("the dialog never called signIn");
	}
	return interaction;
}

describe("SignInModal manual_code prompt", () => {
	it("renders a paste field when the flow asks for one and resolves with the submitted text", async () => {
		let received: string | undefined;
		const { content } = openDialog({
			...captureSignInInteraction(async (interaction) => {
				received = await interaction.prompt({ type: "manual_code", message: "", placeholder: "http://cb" });
				await new Promise(() => {}); // the flow ends when the test does
			}),
		});
		const interaction = await startAndAwaitPrompt(content);

		const input = content.querySelector<HTMLInputElement>("input.piem-sign-in-paste");
		expect(input).not.toBeNull();
		expect(input?.placeholder).toBe("http://cb");
		expect(content.textContent).toContain(t.t("signIn.pastePrompt"));

		input!.value = "  https://localhost/callback?code=abc  ";
		buttonIn(content, t.t("signIn.pasteSubmit")).click();
		await Promise.resolve();

		// Trimmed, because a pasted URL arrives trailing a newline more often than not.
		expect(received).toBe("https://localhost/callback?code=abc");
		void interaction;
	});

	it("submits on Enter and ignores an empty paste", async () => {
		let received: string | undefined;
		const { content } = openDialog({
			...captureSignInInteraction(async (interaction) => {
				received = await interaction.prompt({ type: "manual_code", message: "" });
				await new Promise(() => {});
			}),
		});
		await startAndAwaitPrompt(content);

		const input = content.querySelector<HTMLInputElement>("input.piem-sign-in-paste")!;

		// Empty paste: nothing resolves, the field stays.
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		await Promise.resolve();
		expect(received).toBeUndefined();
		expect(content.querySelector("input.piem-sign-in-paste")).not.toBeNull();

		input.value = "bare-code";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		await Promise.resolve();
		expect(received).toBe("bare-code");
	});

	it("does not submit a whitespace-only paste", async () => {
		let received: string | undefined;
		const { content } = openDialog({
			...captureSignInInteraction(async (interaction) => {
				received = await interaction.prompt({ type: "manual_code", message: "" });
				await new Promise(() => {});
			}),
		});
		await startAndAwaitPrompt(content);

		const input = content.querySelector<HTMLInputElement>("input.piem-sign-in-paste")!;
		input.value = "   ";
		buttonIn(content, t.t("signIn.pasteSubmit")).click();
		await Promise.resolve();
		// Whitespace-only is not an answer: the flow stays waiting rather than
		// exchanging an empty paste.
		expect(received).toBeUndefined();
		expect(content.querySelector("input.piem-sign-in-paste")).not.toBeNull();
	});

	it("rejects the pending prompt when the dialog closes first", async () => {
		let promptError: unknown;
		const { content, options } = openDialog({
			...captureSignInInteraction(async (interaction) => {
				await interaction.prompt({ type: "manual_code", message: "" }).catch((error) => {
					promptError = error;
					throw error;
				});
			}),
		});
		await startAndAwaitPrompt(content);
		expect(content.querySelector("input.piem-sign-in-paste")).not.toBeNull();

		// Close through the real path — the footer's Close button, not a DOM
		// teardown — so the stub's close() runs the same onClose() a dismissal does.
		buttonIn(content, t.t("signIn.close")).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect((promptError as Error).message).toBe(SIGN_IN_CANCELLED);
		// onClose emptied the dialog, and with it the paste field — the flow's
		// rejection lands after close, so there is no visible verdict to read. What
		// the close must guarantee is that nothing keeps waiting, which the
		// rejection above pins.
		expect(content.querySelector("input.piem-sign-in-paste")).toBeNull();
		void options;
	});

	it("rejects the prompt on the flow's own cancel signal and shows the failure while open", async () => {
		let promptError: unknown;
		const cancel = new AbortController();
		const { content } = openDialog({
			...captureSignInInteraction(async (interaction) => {
				await interaction
					.prompt({ type: "manual_code", message: "", signal: cancel.signal })
					.catch((error) => {
						promptError = error;
						throw error;
					});
			}),
		});
		await startAndAwaitPrompt(content);

		// The flow cancels itself (an expired code, a provider refusal) while the
		// dialog is still up: the dialog is open, so the verdict lands in the body.
		cancel.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect((promptError as Error).message).toBe(SIGN_IN_CANCELLED);
		expect(content.textContent).toContain(SIGN_IN_CANCELLED);
		expect(content.querySelector("input.piem-sign-in-paste")).toBeNull();
	});

	it("refuses a prompt type it has no field for", async () => {
		let refused: unknown;
		const { content } = openDialog({
			...captureSignInInteraction(async (interaction) => {
				try {
					await interaction.prompt({ type: "text", message: "unsupported" });
				} catch (error) {
					refused = error;
				}
				await new Promise(() => {});
			}),
		});
		await startAndAwaitPrompt(content);
		expect((refused as Error).message).toContain("text");
	});

	it("keeps the failure message when the flow throws and the dialog stays open", async () => {
		const { content } = openDialog({
			signIn: async () => {
				throw new Error("HTTP 400 from the token exchange: invalid_grant");
			},
		});
		buttonIn(content, t.t("signIn.start")).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(content.textContent).toContain("invalid_grant");
		// The failure's own lead-in, not just the thrown text — the template's
		// prefix survives with an empty {message}.
		expect(content.textContent).toContain(t.t("signIn.failed", { message: "" }).split("{message}")[0]!);
	});
});
