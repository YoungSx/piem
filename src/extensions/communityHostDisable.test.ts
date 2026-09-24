import { afterAll, describe, expect, it } from "bun:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CommunityHost } from "./communityHost";
import { stubWindowTimers } from "../testUtils/windowStub";

const restore = stubWindowTimers();
afterAll(restore);

/** A factory that records that it ran, and registers one command so it validates. */
function tracked(loaded: string[], id: string): { id: string; factory: ExtensionFactory } {
	return {
		id,
		factory: (pi) => {
			loaded.push(id);
			pi.registerCommand(id, { handler: async () => {} });
		},
	};
}

async function loadWith(disabled: string[] | undefined, ids: readonly string[]): Promise<string[]> {
	const loaded: string[] = [];
	const host = await CommunityHost.create(
		{
			getEntries: () => [], getBranch: () => [], getModel: () => undefined,
			getThinkingLevel: () => "off", isIdle: () => true, notify: () => {},
			prepare: async () => {}, deliver: () => {},
			platform: { fetch: async () => { throw new Error("No network expected"); }, onError: (error) => { throw error; } },
			...(disabled ? { disabledExtensionIds: () => disabled } : {}),
		},
		ids.map((id) => tracked(loaded, id)),
	);
	host.dispose();
	await host.closed();
	return loaded;
}

describe("community host honors the disabled-extension blocklist", () => {
	it("skips a listed id and loads the rest", async () => {
		expect(await loadWith(["b"], ["a", "b", "c"])).toEqual(["a", "c"]);
	});

	it("loads everything when the blocklist is empty", async () => {
		expect(await loadWith([], ["a", "b"])).toEqual(["a", "b"]);
	});

	it("loads everything when no blocklist is wired at all", async () => {
		expect(await loadWith(undefined, ["a", "b"])).toEqual(["a", "b"]);
	});
});
