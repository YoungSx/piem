import { expect, test, spyOn } from "bun:test";
import type { App } from "obsidian";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { UserEntry, SystemEntry, CompactionEntry, ResetEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { MemoryAdapter } from "../testUtils/memoryAdapter";

import { nativeSessionHeader } from "./nativeSessionData";
installObsidianStub();
const { DEFAULT_SETTINGS } = await import("../settings");
const { NativeChatSession } = await import("./NativeChatSession");
const { NativeChatManager } = await import("./NativeChatManager");

function fixture() {
	const adapter = new MemoryAdapter();
	const app = { vault: { adapter, getFileByPath: () => null, configDir: ".obsidian", createFolder: (path: string) => adapter.mkdir(path),
		create: async (path: string, content: string) => {
			if (await adapter.exists(path)) throw new Error("Exists");
			await adapter.write(path, content);
		},
	} } as unknown as App;
	const settings = structuredClone(DEFAULT_SETTINGS);
	const manager = new NativeChatManager(app, () => settings, new InMemoryCredentialStore());
	return { adapter, app, settings, manager };
}

test("manager scopes new native files and shares a single writer for concurrent open", async () => {
	const f = fixture();
	try {
		const host = await f.manager.create();
		expect(host.path.startsWith(`${f.settings.sessionDir}/native/`)).toBe(true);
		const [one, two] = await Promise.all([f.manager.open(host.path), f.manager.open(host.path)]);
		expect(one).toBe(host);
		expect(two).toBe(host);
		const bytes = await f.adapter.read(host.path);
		const list = await f.manager.list();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ id: host.id, path: host.path });
		expect(await f.adapter.read(host.path)).toBe(bytes);
		const reopened = await f.manager.reopen(host.path);
		expect(host.getSnapshot().closed).toBe(true);
		expect(reopened).not.toBe(host);
		expect(reopened.getSnapshot().paused).toBe(true);
	} finally { await f.manager.close(); }
});

test("manager rejects old formats and escaped paths without migration", async () => {
	const f = fixture();
	try {
		await f.manager.create();
		const path = `${f.settings.sessionDir}/native/old.jsonl`;
		const bytes = nativeSessionHeader({ id: "legacy", cwd: "/", createdAt: 1, storageVersion: 1 }).replace('"v":7', '"v":6');
		await f.adapter.write(path, bytes);
		await expect(f.manager.open(path)).rejects.toThrow("native chat file");
		expect(await f.adapter.read(path)).toBe(bytes);
		expect(() => f.manager.open(`${f.settings.sessionDir}/other.jsonl`)).toThrow("native chat path");
		expect(() => f.manager.open("../escape.jsonl")).toThrow();
		expect(await f.manager.list()).toHaveLength(1);
	} finally { await f.manager.close(); }
});

test("missing model is explicit and closing joins pending create", async () => {
	const f = fixture();
	const pending = f.manager.create();
	const closing = f.manager.close();
	const host = await pending;
	await closing;
	expect(host.getSnapshot().closed).toBe(true);
	expect(() => f.manager.open(host.path)).toThrow("closed");
	const second = fixture();
	try {
		const empty = await second.manager.create();
		expect((await empty.conversation.agent(context)).model).toBeUndefined();
		expect(empty.view.value.entries).toHaveLength(0);
	} finally { await second.manager.close(); }
});

test("manager selects official file tools and refreshes keys and provider registrations", async () => {
	const f = fixture();
	f.settings.providers = [{ id: "endpoint", name: "Endpoint", baseUrl: "https://example.test/v1", protocol: "openai-completions", apiKey: "key-one", secretRef: "", source: "user", oauthFlow: "" }];
	f.settings.models = [{ id: "configured-model", providerId: "endpoint", modelApiId: "api-model", displayName: "Model", contextWindow: 128000, maxTokens: 512, reasoning: false, supportsImages: false }];
	f.settings.activeModelId = "configured-model";
	f.settings.networkTransport = "requestUrl";
	const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
	requestUrlMock.mockImplementation(async params => {
		requests.push(params as typeof requests[number]);
		const body = 'data: {"id":"answer","choices":[{"delta":{"role":"assistant","content":"Done"},"finish_reason":null}]}\n\ndata: {"id":"answer","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		return { status: 200, headers: { "content-type": "text/event-stream" }, arrayBuffer: new TextEncoder().encode(body).buffer };
	});
	try {
		const host = await f.manager.create();
		const agent = await host.conversation.agent(context);
		expect(agent.model).toEqual({ provider: "endpoint", modelId: "configured-model" });
		expect(agent.tools.filter(tool => ["read", "write", "edit"].includes(tool.name))).toHaveLength(3);
		expect(agent.tools.some(tool => tool.name === "ask_user")).toBe(false);
		await (await host.submit("First")).wait(context);
		f.settings.providers[0]!.apiKey = "key-two";
		await (await host.submit("Second")).wait(context);
		f.settings.providers[0]!.baseUrl = "https://changed.test/v1";
		await (await host.submit("Third")).wait(context);
		const listing = await f.manager.list();
		expect(listing[0]).toMatchObject({ firstMessage: "First", messageCount: 6 });
		expect(requests).toHaveLength(3);
		expect(requests[0]!.headers.authorization).toBe("Bearer key-one");
		expect(requests[1]!.headers.authorization).toBe("Bearer key-two");
		expect(requests[2]!.url).toStartWith("https://changed.test/v1");
		expect(JSON.parse(requests[0]!.body).model).toBe("api-model");
	} finally { requestUrlMock.mockReset(); await f.manager.close(); }
});

test("native deletion drains the owner, excludes new opens and uses recoverable trash", async () => {
	const f = fixture();
	try {
		const host = await f.manager.create();
		const deleting = f.manager.delete(host.path);
		expect(() => f.manager.open(host.path)).toThrow("being deleted");
		await deleting;
		expect(host.getSnapshot().closed).toBe(true);
		expect(f.adapter.trashed).toContain(host.path);
		expect(f.adapter.removed).toHaveLength(0);
		expect(await f.manager.list()).toHaveLength(0);
	} finally { await f.manager.close(); }
});

test("compaction getter follows each session model and live settings", async () => {
	const f = fixture();
	f.settings.providers = [{ id: "endpoint", name: "Endpoint", baseUrl: "https://example.test/v1", protocol: "openai-completions", apiKey: "key", secretRef: "", source: "user", oauthFlow: "" }];
	const model = { id: "small", providerId: "endpoint", modelApiId: "same-api", displayName: "Model", contextWindow: 8000, maxTokens: 512, reasoning: false, supportsImages: false };
	f.settings.models = [model, { ...model, id: "large", contextWindow: 128000 }];
	f.settings.activeModelId = "large";
	const original = NativeChatSession.create.bind(NativeChatSession);
	const supplied: Array<Parameters<typeof NativeChatSession.create>[2]> = [];
	const spy = spyOn(NativeChatSession, "create").mockImplementation((app, path, options) => { supplied.push(options); return original(app, path, options); });
	try {
		const small = await f.manager.create();
		await small.configure({ model: { provider: "endpoint", modelId: "small" } });
		await f.manager.create();
		const smallPolicy = supplied[0]!.settings!.compaction!;
		const largePolicy = supplied[1]!.settings!.compaction!;
		expect(smallPolicy.reserveTokens! + smallPolicy.keepRecentTokens!).toBeLessThan(8000);
		expect(largePolicy.reserveTokens!).toBeGreaterThan(smallPolicy.reserveTokens!);
		f.settings.compaction = { reserveTokens: 1024, keepRecentTokens: 1024 };
		expect(supplied[0]!.settings!.compaction).toMatchObject({ reserveTokens: 1024, keepRecentTokens: 1024 });
		f.settings.retry = { maxRetries: 0 };
		expect(supplied[1]!.settings!.retry).toMatchObject({ enabled: false, maxRetries: 0 });
	} finally { spy.mockRestore(); await f.manager.close(); }
});

test("native history ignores provider-only summaries and handoffs in preview and count", async () => {
	const f = fixture();
	try {
		const host = await f.manager.create();
		await host.conversation.commit(async tx => {
			for (const kind of [SystemEntry.kind, CompactionEntry.kind, ResetEntry.kind]) {
				await tx.appendEntry(host.conversation.id, { kind, model: [{ role: "user", content: "Provider-only context", timestamp: 1 }] });
			}
			await tx.appendEntry(host.conversation.id, { kind: UserEntry.kind, model: [{ role: "user", content: "The real question", timestamp: 2 }] });
			await tx.appendEntry(host.conversation.id, { kind: ToolResultEntry.kind, model: [{ role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "Note" }], isError: false, timestamp: 3 }] });
		}, context);
		const before = await f.adapter.read(host.path);
		expect((await f.manager.list())[0]).toMatchObject({ firstMessage: "The real question", messageCount: 2 });
		expect(await f.adapter.read(host.path)).toBe(before);
	} finally { await f.manager.close(); }
});
