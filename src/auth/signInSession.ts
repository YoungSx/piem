/**
 * The sign-in operations a settings panel can perform, in one object.
 *
 * The panel must not touch {@link CredentialStore} or the flow table directly:
 * it knows rows, not protocol arithmetic, and handing it the store would let a
 * future caller skip the transport pinning `streamFn.ts` documents. This is the
 * narrow door: resolve what a row offers, run its flow over the pinned
 * transport, and read or remove what it persisted.
 *
 * The flow objects are closures over table rows, built per call, so there is
 * nothing to hold between dialog openings and nothing to refresh after one.
 */

import type { CredentialStore, OAuthAuth, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { createOAuthAuth, isOAuthFlowId, oauthFlowName } from "./oauthFlows";
import type { ProviderConfig } from "../modelConfig";
import type { FetchFn } from "../net/obsidianFetch";

/** One provider row, reduced to what a sign-in dialog needs to run. */
export interface SignInTarget {
	/** Stable provider id — also the credential store's key. */
	id: string;
	/** The row's persisted sign-in, or `""` for a key-authenticated row. */
	flowId: string;
}

/**
 * What a subscription row's sign-in button resolves to.
 *
 * Undefined means the row names no flow this build performs, so no button is
 * drawn: a stale persisted id degrades to an ordinary row rather than a dialog
 * that cannot do anything.
 */
export interface SignInActions {
	/** The sign-in's own name, e.g. "xAI (Grok/X subscription)". */
	readonly method: string;
	/** Whether a credential is stored for this row right now. */
	isSignedIn(): Promise<boolean>;
	/** Runs the flow to completion, then persists what it returned. */
	signIn(interaction: ProviderAuthInteraction): Promise<void>;
	/** Removes the row's stored credential. */
	signOut(): Promise<void>;
}

export interface SignInSessionOptions {
	/** The one credential store for the session; see `PiemPlugin.requireCredentialStore`. */
	credentials: CredentialStore;
	/** The pinned transport every sign-in exchange travels over. */
	fetch: FetchFn;
	/** Whether this device can write secrets at all, read live from the environment. */
	canStore: () => boolean;
}

export function createSignInSession(options: SignInSessionOptions) {
	/**
	 * Reads the stored credential for display purposes only.
	 *
	 * Swallows a rejected read rather than propagating it, because the question
	 * being answered is "is there a sign-in to offer removing" — and the same
	 * store will throw the real reason at the next attempt that matters.
	 */
	const readStored = async (providerId: string): Promise<boolean> => {
		try {
			return (await options.credentials.read(providerId))?.type === "oauth";
		} catch {
			return false;
		}
	};

	return {
		/** Whether this device can keep a credential outside the vault. */
		canStore: (): boolean => options.canStore(),

		/** The sign-in actions for one row, or undefined when it offers none. */
		actionsFor(target: SignInTarget): SignInActions | undefined {
			if (!isOAuthFlowId(target.flowId)) {
				return undefined;
			}
			const flowId = target.flowId;
			// Fresh per opening, like the models bundle's own auth object: the flow
			// is stateless over the transport, so there is nothing to save.
			const oauth = () => createOAuthAuth(flowId, options.fetch);
			return {
				method: oauthFlowName(flowId),
				isSignedIn: () => readStored(target.id),
				// pi's own orchestration: login resolves with a credential, and the app
				// persists it afterwards. Serialized through the store's own write path
				// so a concurrent refresh cannot race the fresh token.
				signIn: async (interaction) => {
					const credential = await oauth().login(interaction);
					await options.credentials.modify(target.id, async () => credential);
				},
				signOut: () => options.credentials.delete(target.id),
			};
		},
	};
}

export type SignInSession = ReturnType<typeof createSignInSession>;

/** Reduces a settings row to the sign-in target it names. */
export function signInTargetFor(provider: ProviderConfig): SignInTarget {
	return { id: provider.id, flowId: provider.oauthFlow };
}
