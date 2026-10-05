import type { App } from "obsidian";
import { uuidv7, type CredentialStore, type Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, ROOT_CONVERSATION_ID, UserEntry, AssistantEntry, ToolResultEntry, type AgentChange } from "@earendil-works/pi-durable";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-durable/tools";
import type { Keychain } from "../keychain";
import { getActiveModelConfig, getApiKeyForProvider, getProviderForModel, type PiemSettings } from "../settings";
import { createObsidianModels, withRequestDefaults } from "../net/streamFn";
import { withNativeModelLookup } from "../net/nativeModels";
import { resolveRetrySettings } from "../net/retrySettings";
import { resolveCompactionSettings } from "../agent/compactionSettings";
import { VaultExecutionEnv } from "../vault/VaultExecutionEnv";
import { withContentLedger } from "../vault/contentLedger";
import { normalizeFolderPath } from "../vault/path";
import { createObsidianTools } from "../tools/obsidianTools";
import { nativeTool } from "../tools/nativeTool";
import { NativeChatSession, type NativeChatOptions } from "./NativeChatSession";
import { DurableVaultStorage } from "./DurableVaultStorage";
import { readNativeHistory } from "./nativeSessionData";
import { hasFileManager } from "../vault/trash";
import { NATIVE_SESSION_FORMAT } from "./sessionMetadata";

export interface NativeChatListItem {
	id: string;
	path: string;
	name?: string;
	createdAt: number;
	modifiedAt: number;
	firstMessage: string;
	messageCount: number;
}

/** One owner per path. Native files never pass through the legacy repository. */
export class NativeChatManager {
	private readonly sessions = new Map<string, Promise<NativeChatSession>>();
	private readonly env: VaultExecutionEnv;
	private readonly deletions = new Map<string, Promise<void>>();
	private modelsKey?: string;
	private models?: Models;
	private closing?: Promise<void>;

	constructor(private readonly app: App, private readonly getSettings: () => PiemSettings,
		private readonly credentials: CredentialStore, private readonly keychain?: Keychain) {
		this.env = new VaultExecutionEnv(app);
	}

	create(): Promise<NativeChatSession> {
		this.assertOpen();
		const folder = this.folder();
		const path = `${folder}/${uuidv7()}.jsonl`;
		return this.cache(path, async () => {
			await this.ensureFolder(folder);
			return this.load(path, true);
		});
	}

	open(path: string): Promise<NativeChatSession> {
		this.assertOpen();
		path = this.checkedPath(path);
		return this.sessions.get(path) ?? this.cache(path, () => this.load(path, false));
	}

	reopen(path: string): Promise<NativeChatSession> {
		this.assertOpen();
		path = this.checkedPath(path);
		const previous = this.sessions.get(path);
		return this.cache(path, async () => {
			if (previous) await (await previous).close();
			return this.load(path, false);
		});
	}

	async list(): Promise<NativeChatListItem[]> {
		this.assertOpen();
		const folder = this.folder();
		if (!await this.app.vault.adapter.exists(folder)) return [];
		const { files } = await this.app.vault.adapter.list(folder);
		const result: NativeChatListItem[] = [];
		// Sequential reads keep mobile I/O bounded. No Harness is opened here.
		// ponytail: each listing replays every session's full history for the
		// preview line and count; cache a summary in the header when vaults
		// accumulate hundreds of native chats.
		for (const path of files) {
			if (!path.endsWith(".jsonl") || path.slice(0, path.lastIndexOf("/")) !== folder) continue;
			const content = await this.app.vault.adapter.read(path);
			let header: { v?: unknown; kind?: unknown; id?: unknown; createdAt?: unknown };
			try { header = JSON.parse(content.split("\n", 1)[0] ?? "") as typeof header; }
			catch { continue; }
			if (header.kind !== "header" || header.v !== NATIVE_SESSION_FORMAT || typeof header.id !== "string" || typeof header.createdAt !== "number") continue;
			const storage = await DurableVaultStorage.open(this.app.vault.adapter, path);
			try {
				const history = await readNativeHistory(storage, header.id, ROOT_CONVERSATION_ID);
				const messages = history.flatMap(entry => (entry.model ?? []).filter(message =>
					entry.kind === UserEntry.kind && message.role === "user"
					|| entry.kind === AssistantEntry.kind && message.role === "assistant"
					|| entry.kind === ToolResultEntry.kind && message.role === "toolResult"));
				const first = messages.find(message => message.role === "user");
				const firstMessage = !first ? "" : typeof first.content === "string" ? first.content : first.content.filter(block => block.type === "text").map(block => block.text).join("\n");
				const stat = await this.app.vault.adapter.stat(path);
				result.push({ id: header.id, path, createdAt: header.createdAt, modifiedAt: stat?.mtime ?? header.createdAt, firstMessage, messageCount: messages.length });
			} finally { await storage.close(); }
		}
		return result.sort((a, b) => b.modifiedAt - a.modifiedAt);
	}

	delete(path: string): Promise<void> {
		this.assertOpen();
		path = this.checkedPath(path);
		const previous = this.sessions.get(path);
		const deleting = Promise.resolve().then(async () => {
			if (previous) await (await previous).close();
			const storage = await DurableVaultStorage.open(this.app.vault.adapter, path);
			try { if (storage.format !== NATIVE_SESSION_FORMAT) throw new Error("Expected a native chat file"); }
			finally { await storage.close(); }
			const file = this.app.vault.getFileByPath(path);
			if (file && hasFileManager(this.app)) await this.app.fileManager.trashFile(file);
			else await this.app.vault.adapter.trashLocal(path);
			this.sessions.delete(path);
		});
		this.deletions.set(path, deleting);
		void deleting.finally(() => this.deletions.delete(path)).catch(() => undefined);
		return deleting;
	}

	close(): Promise<void> {
		if (!this.closing) {
			// Assign synchronously: in-flight opens are already cached and joined.
			this.closing = Promise.resolve().then(async () => {
				const results = await Promise.allSettled([...this.deletions.values(), ...[...this.sessions.values()].map(async pending => {
					let host: NativeChatSession;
					try { host = await pending; } catch { return; }
					await host.close();
				})]);
				this.sessions.clear();
				const failed = results.find(result => result.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
			});
		}
		return this.closing;
	}

	private cache(path: string, open: () => Promise<NativeChatSession>): Promise<NativeChatSession> {
		const pending = Promise.resolve().then(open);
		this.sessions.set(path, pending);
		void pending.catch(() => { if (this.sessions.get(path) === pending) this.sessions.delete(path); });
		return pending;
	}

	private folder(): string { return `${normalizeFolderPath(this.getSettings().sessionDir)}/native`; }
	private checkedPath(path: string): string {
		path = normalizeFolderPath(path);
		if (this.deletions.has(path)) throw new Error("Native chat is being deleted");
		if (path.slice(0, path.lastIndexOf("/")) !== this.folder() || !path.endsWith(".jsonl")) throw new Error("Not a native chat path");
		return path;
	}
	private assertOpen(): void { if (this.closing) throw new Error("Native chat manager is closed"); }
	private async ensureFolder(folder: string): Promise<void> {
		let path = "";
		for (const part of folder.split("/")) {
			path = path ? `${path}/${part}` : part;
			if (!await this.app.vault.adapter.exists(path)) {
				try { await this.app.vault.createFolder(path); }
				catch (error) { if (!await this.app.vault.adapter.exists(path)) throw error; }
			}
		}
	}

	private agent(): AgentChange {
		const settings = this.getSettings();
		const model = getActiveModelConfig(settings);
		const provider = model && getProviderForModel(settings, model);
		return {
			model: model && provider ? { provider: provider.id, modelId: model.id } : null,
			cwd: "/",
			instructions: "You are Piem inside Obsidian. Work only inside this vault using the available tools. Use get_active_note when the user refers to the current note; no editor context is automatically injected here. Read notes before making claims or editing them. Use metadata and task tools for indexed vault questions. For read, write and edit, paths are absolute within the vault (for example /Notes/Idea.md); other tools use their documented vault-relative paths. Never access the host filesystem. Use [[vault/relative/path]] links for notes you have actually read. Explain changes briefly. This native preview has no extension, team, skill, MCP or ask_user tools.",
		};
	}

	private async load(path: string, creating: boolean): Promise<NativeChatSession> {
		let host: NativeChatSession | undefined;
		const options = this.options(() => host);
		host = await (creating ? NativeChatSession.create(this.app, path, options) : NativeChatSession.open(this.app, path, options));
		return host;
	}

	private options(getHost: () => NativeChatSession | undefined): NativeChatOptions {
		const settings = this.getSettings();
		const env = withContentLedger(this.env);
		const registry = createRegistry();
		const official = [
			{ ...createReadTool(), executionMode: "parallel" as const },
			{ ...createWriteTool(), executionMode: "sequential" as const },
			{ ...createEditTool(), executionMode: "sequential" as const },
		];
		const tools = createObsidianTools(this.app, this.env, settings, { keychain: this.keychain })
			.filter(tool => !["read", "write", "edit"].includes(tool.name)).map(tool => nativeTool(tool));
		registry.install(defineExtension({ name: "piem-vault", tools: [...official, ...tools] }));
		const getSettings = this.getSettings;
		const agent = this.agent();
		return {
			models: withNativeModelLookup(() => this.currentModels(), this.getSettings), registry, env,
			agent,
			settings: {
				get retry() { const retry = resolveRetrySettings(getSettings().retry); return { enabled: retry.maxRetries > 0, ...retry }; },
				get compaction() {
					const current = getSettings();
					const host = getHost();
					const model = host ? host.getSnapshot().view.docs["pi.agent"]?.model : agent.model;
					const choiceId = model && typeof model === "object" && !Array.isArray(model) ? model.modelId : undefined;
					const selected = current.models.find(choice => choice.id === choiceId);
					return resolveCompactionSettings(current.compaction, selected?.contextWindow ?? 128_000);
				},
			},
		};
	}

	private currentModels(): Models {
		const settings = this.getSettings();
		const key = JSON.stringify([settings.networkTransport, settings.providers.map(provider => [provider.id, provider.baseUrl, provider.protocol, provider.oauthFlow])]);
		if (!this.models || this.modelsKey !== key) {
			const bundle = createObsidianModels({ transport: settings.networkTransport, providers: settings.providers, credentials: this.credentials });
			this.models = withRequestDefaults(bundle, provider => getApiKeyForProvider(this.getSettings(), provider),
				() => this.getSettings().cacheRetention, () => resolveRetrySettings(this.getSettings().retry).maxRetries);
			this.modelsKey = key;
		}
		return this.models;
	}
}
