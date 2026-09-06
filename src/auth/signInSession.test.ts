/**
 * The facade the settings panel drives sign-ins through.
 *
 * The cases carry the three promises the facade makes:
 *
 * 1. **Only a known flow opens.** A row naming no flow this build performs
 *    (a key row, or a flow id from a newer build) gets no actions — the row
 *    degrades to an ordinary provider rather than a dialog that cannot work.
 * 2. **A completed login is persisted.** The credential the flow returns must
 *    reach the store under the row's own id; a login that resolves but does
 *    not write would leave the panel claiming success over nothing. Driven
 *    through the real device-code flow over a scripted transport, so the
 *    assertion covers the path the user's click actually takes.
 * 3. **Signed-in is what the store says.** The answer is read live at ask
 *    time, so it flips after a real sign-in or sign-out without any state in
 *    the facade to go stale.
 */

import { describe, expect, it } from "bun:test";
import type { Credential, CredentialStore, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { FetchFn } from "../net/obsidianFetch";
import type { PluginSecretStore } from "../keychain";
// The flow's abortable wait uses `window.setTimeout` (the popout-safe global),
// so a DOM has to be installed before a login is driven through a real flow.
import { installDom } from "../testUtils/dom";
import { createSignInSession, signInTargetFor } from "./signInSession";

installDom();

/** A store over a plain map — the same shape `credentialStore.test.ts` models. */
function storeOver(entries: Map<string, Credential>): CredentialStore {
	return {
		read: async (id) => entries.get(id),
		list: async () => [...entries.entries()].map(([providerId, credential]) => ({ providerId, type: credential.type })),
		modify: async (id, fn) => {
			const next = await fn(entries.get(id));
			if (next === undefined) {
				entries.delete(id);
			} else {
				entries.set(id, next);
			}
			return next;
		},
		delete: async (id) => {
			entries.delete(id);
		},
	};
}

function secrets(available: boolean): PluginSecretStore {
	return {
		available,
		read: () => "",
		list: () => [],
		write: () => false,
		remove: () => false,
	};
}
void secrets;

/** The interaction this build's dialog hands over: signal + notify-only. */
function interaction(): ProviderAuthInteraction {
	return { signal: new AbortController().signal, notify: () => {}, prompt: () => Promise.reject(new Error("unused")) };
}

const XAI_ROW = { id: "row-xai", flowId: "xai" };
const KEY_ROW = { id: "row-key", flowId: "" };
const STALE_ROW = { id: "row-stale", flowId: "future-flow" };

/** Zero wait: the poll loop runs to its scripted success without spending intervals. */
const NO_SLEEP = async () => {};

/** The two replies one device-code exchange produces, over any transport. */
const XAI_REPLIES = [
	{ body: { device_code: "dc-1", user_code: "ABCD-EFGH", verification_uri: "https://accounts.x.ai/device" } },
	{ body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } },
];

function scriptedFetch(replies: { body?: unknown }[]): FetchFn {
	let index = 0;
	return async () => {
		// `noUncheckedIndexedAccess` reads the clamp as maybe-out-of-bounds; the
		// empty reply it substitutes is exactly what an exhausted script produces.
		const reply = replies[Math.min(index, replies.length - 1)] ?? { body: {} };
		index += 1;
		return new Response(JSON.stringify(reply.body), { status: 200 });
	};
}

describe("createSignInSession", () => {
	it("offers no actions for a key row or an unrecognized flow id", () => {
		const session = createSignInSession({ credentials: storeOver(new Map()), fetch: scriptedFetch([]), canStore: () => true });
		expect(session.actionsFor(KEY_ROW)).toBeUndefined();
		expect(session.actionsFor(STALE_ROW)).toBeUndefined();
	});

	it("names the flow it performs", () => {
		const session = createSignInSession({ credentials: storeOver(new Map()), fetch: scriptedFetch([]), canStore: () => true });
		expect(session.actionsFor(XAI_ROW)?.method).toContain("xAI");
	});

	it("persists the credential a completed login returned", async () => {
		const entries = new Map<string, Credential>();
		const session = createSignInSession({
			credentials: storeOver(entries),
			fetch: scriptedFetch(XAI_REPLIES),
			canStore: () => true,
			sleep: NO_SLEEP,
		});
		await session.actionsFor(XAI_ROW)!.signIn(interaction());
		const stored = entries.get(XAI_ROW.id);
		expect(stored?.type).toBe("oauth");
		if (stored?.type === "oauth") {
			expect(stored.access).toBe("at-1");
			expect(stored.refresh).toBe("rt-1");
		}
		expect(await session.actionsFor(XAI_ROW)!.isSignedIn()).toBe(true);
	});

	it("reports signed-out for an empty store and signed-in for a stored oauth credential", async () => {
		const entries = new Map<string, Credential>();
		entries.set(XAI_ROW.id, { type: "oauth", access: "at-1", refresh: "rt-1", expires: 1_800_000_000_000 });
		const session = createSignInSession({ credentials: storeOver(entries), fetch: scriptedFetch([]), canStore: () => true });
		expect(await session.actionsFor(XAI_ROW)!.isSignedIn()).toBe(true);
		entries.delete(XAI_ROW.id);
		expect(await session.actionsFor(XAI_ROW)!.isSignedIn()).toBe(false);
	});

	it("signs out by removing the stored credential", async () => {
		const entries = new Map<string, Credential>();
		entries.set(XAI_ROW.id, { type: "oauth", access: "at-1", refresh: "rt-1", expires: 1_800_000_000_000 });
		const session = createSignInSession({ credentials: storeOver(entries), fetch: scriptedFetch([]), canStore: () => true });
		await session.actionsFor(XAI_ROW)!.signOut();
		expect(entries.has(XAI_ROW.id)).toBe(false);
		expect(await session.actionsFor(XAI_ROW)!.isSignedIn()).toBe(false);
	});

	it("reads canStore live, not captured at creation", () => {
		let available = true;
		const session = createSignInSession({ credentials: storeOver(new Map()), fetch: scriptedFetch([]), canStore: () => available });
		expect(session.canStore()).toBe(true);
		available = false;
		expect(session.canStore()).toBe(false);
	});

	it("reduces a provider row to its sign-in target", () => {
		expect(
			signInTargetFor({
				id: "p1",
				name: "",
				baseUrl: "",
				protocol: "openai-completions",
				apiKey: "",
				secretRef: "",
				source: "user",
				oauthFlow: "xai",
			}),
		).toEqual({ id: "p1", flowId: "xai" });
	});
});
