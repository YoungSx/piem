import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stubWindowMembers, stubWindowTimers } from "../testUtils/windowStub";
import { createExtensionRequestPool, createExtensionResources } from "./extensionResources";
import type { FetchFn } from "../net/obsidianFetch";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
let restore: () => void;
const owners: ReturnType<typeof createExtensionResources>[] = [];
beforeEach(() => { restore = stubWindowTimers(); });
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); restore(); });
function setup(fetch: FetchFn = async () => new Response("ok")) {
	const errors: unknown[] = [];
	const owner = createExtensionResources({ fetch: createExtensionRequestPool(fetch), onError: error => errors.push(error) });
	owners.push(owner);
	return { owner, errors };
}

describe("background extension resources", () => {
	it("bounds physical requests across cancellation and replacement", async () => {
		const wires: Array<ReturnType<typeof deferred<Response>>> = [];
		const fetch = createExtensionRequestPool(async () => {
			const wire = deferred<Response>(); wires.push(wire); return await wire.promise;
		});
		const old = createExtensionResources({ fetch, onError: () => {} });
		owners.push(old);
		const controller = new AbortController();
		const pending = Array.from({ length: 4 }, () => old.fetch("https://fixture.invalid/collect", { signal: controller.signal }));
		const rejected = Promise.all(pending.map(work => work.catch(error => error as Error)));
		await Promise.resolve(); await Promise.resolve();
		expect(wires).toHaveLength(4);
		controller.abort(); old.dispose();
		expect((await rejected).every(error => error instanceof Error && error.name === "AbortError")).toBe(true);
		const next = createExtensionResources({ fetch, onError: () => {} });
		owners.push(next);
		await expect(next.fetch("https://fixture.invalid/collect")).rejects.toThrow("4 extension background requests");
		for (const wire of wires) wire.resolve(new Response("late"));
		await Promise.resolve(); await Promise.resolve();
		const recovered = next.fetch("https://fixture.invalid/collect");
		await Promise.resolve(); await Promise.resolve();
		wires.at(-1)!.resolve(new Response("recovered"));
		expect(await (await recovered).text()).toBe("recovered");
	});

	it("applies a deadline without forgetting an unabortable wire", async () => {
		const deadlines: Array<() => void> = [];
		const wires: Array<ReturnType<typeof deferred<Response>>> = [];
		const restoreDeadline = stubWindowMembers({
			setTimeout: (callback: () => void, ms: number) => { expect(ms).toBe(15_000); deadlines.push(callback); return deadlines.length; },
			clearTimeout: () => {},
		});
		try {
			const { owner } = setup(async () => { const wire = deferred<Response>(); wires.push(wire); return await wire.promise; });
			for (let i = 0; i < 4; i++) {
				const work = owner.fetch("https://fixture.invalid");
				await Promise.resolve();
				deadlines.at(-1)!();
				await expect(work).rejects.toMatchObject({ name: "AbortError" });
			}
			await expect(owner.fetch("https://fixture.invalid")).rejects.toThrow("4 extension background requests");
			for (const wire of wires) wire.resolve(new Response("late"));
		} finally { restoreDeadline(); }
	});

	it("never starts a cancelled or non-HTTP request", async () => {
		let calls = 0;
		const { owner } = setup(async () => { calls++; return new Response(); });
		const signal = AbortSignal.abort();
		await expect(owner.fetch(new Request("https://fixture.invalid", { signal }))).rejects.toMatchObject({ name: "AbortError" });
		await expect(owner.fetch("file:///vault/private")).rejects.toThrow("HTTP or HTTPS");
		expect(calls).toBe(0);
	});

	it("isolates timer IDs and rejects delayed promises on disposal", async () => {
		const one = setup().owner;
		const two = setup().owner;
		const fired = deferred<void>();
		const id = one.setTimeout(() => fired.resolve(), 1);
		two.clearTimeout(id);
		await fired.promise;
		const delay = two.timersPromises.setTimeout(60_000, "late", { ref: false });
		two.dispose();
		await expect(delay).rejects.toMatchObject({ name: "AbortError" });
		expect(() => two.setTimeout(() => {}, 1)).toThrow("disposed");
	});

	it("keeps shutdown flush available while cancelling repeating work", async () => {
		let interval = 0;
		const { owner } = setup();
		owner.setInterval(() => { interval++; }, 1000);
		owner.beginShutdown();
		expect(await (await owner.fetch("https://fixture.invalid/flush")).text()).toBe("ok");
		expect(await owner.timersPromises.setTimeout(1, "flushed")).toBe("flushed");
		expect(interval).toBe(0);
		expect(() => owner.setInterval(() => {}, 1)).toThrow("closing");
		owner.dispose();
		await expect(owner.fetch("https://fixture.invalid/flush")).rejects.toMatchObject({ name: "AbortError" });
	});

	it("serializes asynchronous interval callbacks and observes late failures", async () => {
		const invoked = deferred<void>();
		const release = deferred<void>();
		let calls = 0;
		const { owner, errors } = setup();
		owner.setInterval(async () => { calls++; invoked.resolve(); await release.promise; throw new Error("late"); }, 1);
		await invoked.promise;
		await owner.timersPromises.setTimeout(10);
		expect(calls).toBe(1);
		owner.dispose(); release.resolve();
		await Promise.resolve(); await Promise.resolve();
		expect(errors).toEqual([]);
	});

	it("bounds timers and removes a delay's abort listener after success", async () => {
		const { owner } = setup();
		const ids = Array.from({ length: 64 }, () => owner.setTimeout(() => {}, 60_000));
		expect(() => owner.setTimeout(() => {}, 1)).toThrow("64 extension timers");
		for (const id of ids) owner.clearTimeout(id);
		const controller = new AbortController();
		expect(await owner.timersPromises.setTimeout(1, "done", { signal: controller.signal })).toBe("done");
		controller.abort();
		expect(await owner.timersPromises.setTimeout(1, "next")).toBe("next");
	});
});
