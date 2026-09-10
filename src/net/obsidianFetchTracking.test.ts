import { beforeEach, describe, expect, it, mock } from "bun:test";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";

installObsidianStub();
const { createObsidianRequestUrlFetch } = await import("./obsidianFetch");
const response = { status: 200, headers: {}, arrayBuffer: new TextEncoder().encode("answer").buffer };

function networkRequest() {
	let resolve!: (value: typeof response) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<typeof response>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

describe("requestUrl completion tracking", () => {
	beforeEach(() => requestUrlMock.mockReset());

	it("reports one actual network handle for each fetch, independent of response conversion", async () => {
		requestUrlMock.mockResolvedValue(response);
		const onRequest = mock((_settled: Promise<void>) => {});
		const fetch = createObsidianRequestUrlFetch({ onRequest });
		const result = await fetch("https://configured.example/v1/chat");
		expect(await result.text()).toBe("answer");
		expect(onRequest).toHaveBeenCalledTimes(1);
		await expect(onRequest.mock.calls[0]![0]).resolves.toBeUndefined();
		requestUrlMock.mockResolvedValue({ ...response, status: 0 });
		await expect(fetch("https://configured.example/v1/chat")).rejects.toThrow("HTTP status");
		expect(onRequest).toHaveBeenCalledTimes(2);
		await expect(onRequest.mock.calls[1]![0]).resolves.toBeUndefined();
	});

	it.each(["success", "failure"])("keeps tracking a stopped network request until its late %s", async outcome => {
		const work = networkRequest();
		requestUrlMock.mockReturnValue(work.promise);
		const tracked: Promise<void>[] = [];
		const onRequest = mock((settled: Promise<void>) => { tracked.push(settled); });
		const fetch = createObsidianRequestUrlFetch({ onRequest });
		const controller = new AbortController();
		const pending = fetch("https://configured.example/v1/chat", { signal: controller.signal });
		await Promise.resolve();
		expect(onRequest).toHaveBeenCalledTimes(1);
		let networkFinished = false;
		const settled = Promise.all(tracked).then(() => { networkFinished = true; });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(networkFinished).toBe(false);
		if (outcome === "success") work.resolve(response);
		else work.reject(new Error("late network failure"));
		await settled;
		expect(networkFinished).toBe(true);
		await expect(tracked[0]!).resolves.toBeUndefined();
	});

	it("does not track a request that was cancelled before network dispatch", async () => {
		const onRequest = mock((_settled: Promise<void>) => {});
		const fetch = createObsidianRequestUrlFetch({ onRequest });
		const controller = new AbortController();
		controller.abort();
		await expect(fetch("https://configured.example/v1/chat", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(requestUrlMock).not.toHaveBeenCalled();
		expect(onRequest).not.toHaveBeenCalled();
	});

	it("preserves transport errors while completion handles resolve without exposing the response", async () => {
		requestUrlMock.mockRejectedValue(new Error("network unavailable"));
		const tracked: Promise<void>[] = [];
		const fetch = createObsidianRequestUrlFetch({ onRequest: settled => { tracked.push(settled); } });
		await expect(fetch("https://configured.example/v1/chat")).rejects.toThrow("network unavailable");
		await expect(tracked[0]!).resolves.toBeUndefined();
	});
});
