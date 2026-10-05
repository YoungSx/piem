/** Test-only plugin: loads production adapters through Obsidian's official plugin loader. */
import { Plugin, Platform } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, LiveDoc, createRegistry, defineExtension, watchEvents } from "@earendil-works/pi-durable";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { createObsidianModels, withRequestDefaults } from "../src/net/streamFn";
import { withNativeModelLookup } from "../src/net/nativeModels";
import { nativeTool } from "../src/tools/nativeTool";
import { DurableVaultStorage } from "../src/session/DurableVaultStorage";
import { nativeSessionHeader, readNativeHistory, recoverNativeSessionCopy } from "../src/session/nativeSessionData";
import { PiemSession } from "../src/session/PiemSession";
import { VaultExecutionEnv } from "../src/vault/VaultExecutionEnv";
import { withContentLedger } from "../src/vault/contentLedger";

export default class NativeAdaptersFixture extends Plugin {
	private harness?: Harness;
	private release?: () => void;
	async close(): Promise<void> { this.release?.(); await this.harness?.close(context); }
	onunload(): void { void this.close(); }

	async run(endpoint: string, metadataTool: AgentTool, mobile: boolean) {
		const checks: string[] = [];
		const check = (name: string, condition: unknown) => { if (!condition) throw new Error(name); checks.push(name); };
		check("plugin mobile platform", Platform.isMobile === mobile && Platform.isDesktopApp === !mobile);
		const adapter = this.app.vault.adapter;
		const folder = `Piem/native-stage1-${mobile ? "mobile" : "desktop"}`;
		if (!await adapter.exists("Piem")) await adapter.mkdir("Piem");
		if (!await adapter.exists(folder)) await adapter.mkdir(folder);
		const path = `${folder}/session.jsonl`;
		const metadata = { id: `native-${mobile}`, cwd: "vault", createdAt: Date.now(), storageVersion: 1 };
		await adapter.write(path, nativeSessionHeader(metadata));
		const settings = {
			providers: [{ id: "native-fixture", name: "Native fixture", baseUrl: `${endpoint}/v1`, protocol: "openai-completions" as const, apiKey: "fixture-only", secretRef: "", source: "user" as const, oauthFlow: "" }],
			models: [{ id: "native-choice", providerId: "native-fixture", modelApiId: "wire-model", displayName: "Native fixture", reasoning: false, supportsImages: false }],
		};
		const bundle = createObsidianModels({ transport: "fetch", providers: settings.providers });
		const models = withNativeModelLookup(() => withRequestDefaults(bundle, () => "fixture-only", () => "none", () => 0), () => settings);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		this.release = gate.resolve;
		let writes = 0;
		// Original Pi tools go straight to Harness; only Obsidian-specific tools use the bridge.
		const writeTool = createWriteTool();
		const bridge = { ...writeTool, executionMode: "sequential" as const, execute: async (...args: Parameters<typeof writeTool.execute>) => {
			writes++;
			const result = await writeTool.execute(...args);
			started.resolve();
			const signal = args[2].abortSignal;
			const abort = () => gate.resolve();
			signal?.addEventListener("abort", abort, { once: true });
			try { if (!signal?.aborted) await gate.promise; }
			finally { signal?.removeEventListener("abort", abort); }
			return result;
		} };
		check("real write remains unsafe", bridge.replay !== "safe");
		const registry = createRegistry();
		registry.install(defineExtension({ name: "vault-fixture", tools: [bridge, nativeTool(metadataTool)] }));
		const env = withContentLedger(new VaultExecutionEnv(this.app));
		const options = { models, registry, env: () => env };
		let appends = 0, bytes = 0, active = 0, maxActive = 0;
		let sampledHeap = 0;
		const sample = () => { sampledHeap = Math.max(sampledHeap, (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0); };
		const sampler = window.setInterval(sample, 50);
		const originalAppend = adapter.append;
		adapter.append = async function (file, content) {
			if (!file.startsWith(`${folder}/`)) return originalAppend.call(this, file, content);
			active++; maxActive = Math.max(maxActive, active);
			try { await originalAppend.call(this, file, content); appends++; bytes += new TextEncoder().encode(content).length; }
			finally { active--; }
		};
		const begin = performance.now();
		const deadline = Promise.withResolvers<never>();
		void deadline.promise.catch(() => undefined);
		const watchdog = window.setTimeout(() => deadline.reject(new Error("Native renderer smoke deadline")), 45_000);
		const bounded = <T>(value: Promise<T>): Promise<T> => Promise.race([value, deadline.promise]);
		try {
			let storage = await DurableVaultStorage.open(adapter, path);
			this.harness = await Harness.open(storage, options, context);
			let root = await this.harness.root(context, { agent: { model: { provider: "native-fixture", modelId: "native-choice" } } });
			const input = { type: "input" as const, content: "native-write", requestId: "write-once" };
			const first = await root.submit(input, context);
			await bounded(started.promise);
			check("actual Vault side effect", await adapter.read(`${folder}/note.md`) === "Native adapters: written once.\n");
			const cut = await adapter.read(path);
			const history = await readNativeHistory(storage, metadata.id, root.id);
			check("native reader preserves messages", history.some(entry => entry.kind === "pi.user") && history.some(entry => entry.kind === "pi.assistant"));
			check("reader does not write", await adapter.read(path) === cut);
			check("no result at crash boundary", !history.some(entry => entry.kind === "pi.tool-result"));
			await this.close();
			const crashPath = `${folder}/crash.jsonl`;
			await adapter.write(crashPath, `${cut}{"kind":"durable_commit"`);
			const recoveredPath = await recoverNativeSessionCopy(adapter, crashPath, (file, content) => this.app.vault.create(file, content));
			check("crash evidence retained", await adapter.read(crashPath) === `${cut}{"kind":"durable_commit"`);
			storage = await DurableVaultStorage.open(adapter, recoveredPath);
			let refused = false;
			try { await PiemSession.open(storage, metadata); } catch { refused = true; }
			check("legacy engine refuses native graph", refused);
			this.harness = await Harness.open(storage, options, context);
			check("reopen is paused", (await this.harness.inspect(context)).scheduling === "paused");
			root = await this.harness.root(context);
			const resumed = await root.submit(input, context);
			check("submission identity survives", resumed.id === first.id);
			check("native recovery completed", (await bounded(resumed.wait(context))).status === "done");
			check("real write not repeated", writes === 1);
			const restored = await readNativeHistory(storage, metadata.id, root.id);
			check("unsafe tool reports interruption", restored.some(entry => entry.kind === "pi.tool-result" && JSON.stringify(entry.model).includes("interrupted")));
			check("Obsidian tool bridge completed", restored.some(entry => entry.model?.some(message => message.role === "toolResult" && message.toolName === "get_note_metadata" && !message.isError)));
			check("old entry identities survive", history.every(entry => restored.some(item => item.id === entry.id)));
			const fork = await root.fork(restored[0]!.entryId, { ownership: { kind: "ownerless" } }, context);
			check("fork retains inherited identity", (await readNativeHistory(storage, metadata.id, fork.id))[0]?.id === restored[0]!.id);
			const beforeStream = { appends, bytes, at: performance.now() };
			const partials = new Set<string>();
			const live = await this.harness.documentState(LiveDoc, root.id, context);
			if (!live) throw new Error("Native live state missing");
			const unsubscribe = live.subscribe(value => { if (value?.generation?.message) partials.add(JSON.stringify(value.generation.message.content)); });
			try { check("streaming native turn completed", (await bounded((await root.submit({ type: "input", content: "native-stream" }, context)).wait(context))).status === "done"); }
			finally { unsubscribe(); live.dispose(); }
			const streamMeasurements = { appends: appends - beforeStream.appends, bytes: bytes - beforeStream.bytes, distinctCommittedPartials: partials.size, elapsedMs: performance.now() - beforeStream.at };
			check("partial stream crosses persistence boundary", partials.size >= 3);
			// Hold delivery beyond the documented 100-batch limit, then consume the public stream.
			const events = await watchEvents(this.harness, root.id, context);
			const caughtUp = Promise.withResolvers<void>();
			const seen = new Set<number>();
			let deliveredBatches = 0, snapshotResets = 0;
			try {
				for (let index = 0; index < 111; index++) await root.commit(tx => tx.appendEntry(root.id, { kind: "fixture.backpressure", data: { index } }), context);
				events.start(async batch => {
					deliveredBatches++;
					for (const event of batch) {
						if (event.type === "snapshot") { snapshotResets++; seen.clear(); }
						const entries = event.type === "snapshot" ? event.entries : event.type === "entry_appended" ? [event.entry] : [];
						for (const entry of entries) if (entry.kind === "fixture.backpressure") seen.add(entry.id);
					}
					if (seen.size === 111) caughtUp.resolve();
				});
				await bounded(caughtUp.promise);
				check("event backlog recovers through snapshot", snapshotResets > 0 && seen.size === 111);
			} finally { await events.stop(); }
			await this.close();
			check("adapter writes drained", active === 0 && maxActive === 1);
			sample();
			return { passed: true, checks, writes, recoveredPath, platform: { isMobileApp: Platform.isMobileApp, isDesktopApp: Platform.isDesktopApp }, measurements: { appends, bytes, maxConcurrentAppends: maxActive, sampledPeakUsedJSHeapBytes: sampledHeap || null, elapsedMs: performance.now() - begin, stream: streamMeasurements, events: { withheldCommits: 111, deliveredBatches, snapshotResets, recoveredEntries: seen.size } } };
		} finally {
			try { await this.close(); } finally {
				adapter.append = originalAppend;
				window.clearInterval(sampler);
				window.clearTimeout(watchdog);
			}
		}
	}
}
