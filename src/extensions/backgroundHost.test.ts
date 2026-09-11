import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CommunityHost, type CommunityExtension } from "./communityHost";
import { createExtensionPlatform, type BackgroundExtensionPlatform } from "./extensionPlatform";
import { createExtensionConfigStore, type ExtensionConfigData } from "./extensionConfigStore";
import { stubWindowTimers } from "../testUtils/windowStub";

let restore: () => void;
const hosts: CommunityHost[] = [];
beforeEach(() => { restore = stubWindowTimers(); });
afterEach(async () => { for (const host of hosts.splice(0)) { host.dispose(); await host.closed().catch(() => {}); } restore(); });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
function config() {
	let data: ExtensionConfigData | undefined;
	return createExtensionConfigStore({
		getData: () => data, setData: value => { data = value; }, persist: async () => {}, queue: task => task(),
	});
}
async function setup(extensions: readonly CommunityExtension[], requests: string[] = []) {
	const host = await CommunityHost.create({
		getEntries: () => [], getBranch: () => [], getSessionId: () => "fixture",
		notify: () => {}, prepare: async () => {}, deliver: () => {},
		platform: {
			fetch: async () => { throw new Error("Unexpected foreground fetch"); },
			backgroundFetch: async (input, init) => { requests.push(`${String(input)}:${String(init?.body)}`); return new Response("saved"); },
			config: config(), onError: () => {},
		},
	}, extensions);
	hosts.push(host);
	return host;
}

describe("background factories in the community host", () => {
	it("runs independently of chat operations and keeps each session's env and timers separate", async () => {
		const platforms: BackgroundExtensionPlatform[] = [];
		const fired = deferred<void>();
		let count = 0;
		const extension = {
			id: "background-fixture",
			createFactory(platform: BackgroundExtensionPlatform): ExtensionFactory {
				platforms.push(platform);
				return pi => {
					pi.on("session_start", () => {
						platform.process.env.TEST = String(platform.process.pid);
						platform.setInterval(async () => { await platform.fetch("https://fixture.invalid/collect"); count++; fired.resolve(); }, 1);
					});
					pi.registerCommand("foreground", { handler: async () => {} });
				};
			},
		};
		const oneRequests: string[] = [], twoRequests: string[] = [];
		const one = await setup([extension], oneRequests);
		const two = await setup([extension], twoRequests);
		await one.start(); await two.start();
		expect(one.busy).toBe(false); expect(two.busy).toBe(false);
		one.cancel();
		await one.run("foreground");
		await fired.promise;
		expect(count).toBeGreaterThan(0);
		expect(platforms[0]!.process.env.TEST).not.toBe(platforms[1]!.process.env.TEST);
		one.dispose(); await one.closed();
		expect(() => platforms[0]!.process.env.TEST).toThrow("disposed");
		expect(platforms[1]!.process.env.TEST).toBeDefined();
		await two.run("foreground");
	});

	it("flushes during shutdown, then revokes all retained resource closures", async () => {
		const flushed: string[] = [];
		let platform!: BackgroundExtensionPlatform;
		let delay!: Promise<unknown>;
		const host = await setup([{
			id: "flush-fixture", createFactory(value) {
				platform = value;
				return pi => {
					pi.on("session_start", () => {});
					pi.on("session_shutdown", async () => {
						delay = platform.timersPromises.setTimeout(60_000).catch(error => error as Error);
						flushed.push(await (await platform.fetch("https://fixture.invalid/flush")).text());
					});
				};
			},
		}]);
		await host.start(); host.dispose(); await host.closed();
		expect(flushed).toEqual(["saved"]);
		expect(await delay).toMatchObject({ name: "AbortError" });
		await expect(platform.fetch("https://fixture.invalid/late")).rejects.toMatchObject({ name: "AbortError" });
		expect(() => platform.setTimeout(() => {}, 1)).toThrow("disposed");
	});

	it("skips a failed factory and retires its resources while a healthy extension still loads", async () => {
		let bad!: BackgroundExtensionPlatform;
		let ran = false;
		const host = await setup([
			{ id: "broken", createFactory(platform) { bad = platform; platform.setInterval(() => {}, 10_000); throw new Error("broken factory"); } },
			{ id: "healthy", factory: pi => { pi.registerCommand("healthy", { handler: async () => { ran = true; } }); } },
		]);
		await host.run("healthy");
		expect(ran).toBe(true);
		expect(() => bad.process.env.TEST).toThrow("disposed");
	});

	it("retires a failed factory before waiting for another asynchronous factory", async () => {
		let bad!: BackgroundExtensionPlatform;
		const entered = deferred<void>(), gate = deferred<void>();
		const creating = setup([
			{ id: "broken", createFactory(platform) { bad = platform; platform.setInterval(() => {}, 1); throw new Error("broken factory"); } },
			{ id: "waiting", factory: async () => { entered.resolve(); await gate.promise; } },
		]);
		try {
			await entered.promise;
			expect(() => bad.process.env.TEST).toThrow("disposed");
		} finally { gate.resolve(); await creating; }
	});

	it("lets a background factory read its config while cancelled foreground IO drains", async () => {
		const wire = deferred<Response>();
		const started = deferred<void>();
		const host = createExtensionPlatform({
			fetch: () => { started.resolve(); return wire.promise; },
			complete: async () => { throw new Error("Unused"); }, config: config(), onError: () => {},
		});
		const owned = host.forBackgroundExtension("background");
		try {
			owned.platform.writeFileSync("/extensions/config/test.json", "{}");
			const request = host.withOperation(() => host.platform.fetch("https://fixture.invalid"));
			await started.promise; host.cancel();
			await expect(request).rejects.toMatchObject({ name: "AbortError" });
			expect(owned.platform.readFileSync("/extensions/config/test.json", "utf8")).toBe("{}");
			expect(owned.platform.readdirSync("/extensions/config")).toEqual(["test.json"]);
			owned.beginShutdown();
			expect(() => owned.platform.writeFileSync("/extensions/config/test.json", "{}" )).toThrow("read-only");
		} finally { wire.resolve(new Response()); owned.dispose(); host.dispose(); await host.drain(); }
	});

	it("does not let a rejected factory borrow a later operation's model capability", async () => {
		let completions = 0;
		const host = createExtensionPlatform({
			fetch: async () => new Response(), onError: () => {},
			complete: async () => { completions++; throw new Error("Must not be reached"); },
		});
		try {
			const bad = host.forBackgroundExtension("bad");
			bad.dispose();
			await expect(host.withOperation(() => bad.platform.complete({} as never, { messages: [] }))).rejects.toMatchObject({ name: "AbortError" });
			expect(completions).toBe(0);
		} finally { host.dispose(); await host.drain(); }
	});

	it("observes a failed background save when an unrelated operation is cancelled", async () => {
		const errors: unknown[] = [];
		let rejectSave!: (error: Error) => void;
		const saving = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
		let data: ExtensionConfigData | undefined;
		const store = createExtensionConfigStore({ getData: () => data, setData: value => { data = value; }, persist: () => saving, queue: task => task() });
		const host = createExtensionPlatform({ fetch: async () => new Response(), complete: async () => { throw new Error("unused"); }, config: store, onError: error => errors.push(error) });
		const gate = deferred<void>(), started = deferred<void>();
		try {
			const operation = host.withOperation(async () => { started.resolve(); await gate.promise; });
			await started.promise;
			host.forBackgroundExtension("background").platform.writeFileSync("/extensions/config/test.json", "{}");
			host.cancel();
			await expect(operation).rejects.toMatchObject({ name: "AbortError" });
			const failure = new Error("save failed");
			rejectSave(failure);
			await store.settled().catch(() => {});
			expect(errors).toEqual([failure]);
			await expect(store.flush()).rejects.toBe(failure);
		} finally { gate.resolve(); host.dispose(); await host.drain(); }
	});
});
