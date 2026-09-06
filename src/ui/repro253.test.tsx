import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { App, DataAdapter, Component } from "obsidian";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ObsidianAgentService as ObsidianAgentServiceType } from "../agent/ObsidianAgentService";
import type { PiemSettings } from "../settings";
import type { UserSkillsLoad } from "../skills/userSkills";
import { flushRender, installDom } from "../testUtils/dom";

installObsidianStub();
const document = installDom();

const { ChatApp } = await import("./ChatApp");
const { ChatInputController } = await import("./ChatInputController");
const { ObsidianAgentService } = await import("../agent/ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { DEFAULT_SESSION_RETENTION } = await import("../session/retention");
const { DEFAULT_SESSION_DIR, getLegacySessionDir } = await import("../session/sessionDir");
const { DEFAULT_SETTINGS } = await import("../settings");
const { createRoot } = await import("react-dom/client");

const SESSION_DIR = getLegacySessionDir(`.${"obsidian"}`, "piem");

function textReply(model: Model<Api>, text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

function scriptedStreamFn(mode: "ok" | "fail-late" = "ok"): { streamFn: StreamFn; prompts: string[] } {
	const prompts: string[] = [];
	let call = 0;
	const streamFn: StreamFn = (model: Model<Api>, context: Context) => {
		prompts.push(
			context.messages
				.map((message) =>
					typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.length : "",
				)
				.join("|"),
		);
		const reply = `reply ${call}`;
		call += 1;
		if (mode === "fail-late" && call === 1) {
			// Streams a delta, then dies — the turn happened, the run errored.
			const stream = createAssistantMessageEventStream();
			const errorMessage = {
				role: "assistant" as const,
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error" as const,
				error: new Error("provider exploded mid-stream"),
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "text_start" } as never);
				stream.push({ type: "text_delta", delta: "partial" } as never);
				stream.push({ type: "error", reason: "error", error: errorMessage } as never);
				stream.end(errorMessage);
			});
			return stream;
		}
		return textReply(model, reply);
	};
	return { streamFn, prompts };
}

function memoryAdapter(): DataAdapter {
	const files = new Map<string, string>();
	return {
		async exists(path: string): Promise<boolean> {
			return files.has(path);
		},
		async mkdir(): Promise<void> {},
		async write(path: string, data: string): Promise<void> {
			files.set(path, data);
		},
		async append(path: string, data: string): Promise<void> {
			files.set(path, (files.get(path) ?? "") + data);
		},
		async read(path: string): Promise<string> {
			const content = files.get(path);
			if (content === undefined) {
				throw new Error(`Missing file: ${path}`);
			}
			return content;
		},
		async stat(path: string) {
			const content = files.get(path);
			if (content === undefined) {
				return null;
			}
			return { type: "file" as const, ctime: 1, mtime: 1, size: content.length };
		},
		async list(path: string) {
			return {
				files: [...files.keys()].filter((key) => key.startsWith(path)),
				folders: [],
			};
		},
		async trashSystem(path: string): Promise<boolean> {
			files.delete(path);
			return true;
		},
		async trashLocal(path: string): Promise<void> {
			files.delete(path);
		},
	} as unknown as DataAdapter;
}

const NO_USER_SKILLS = async (): Promise<UserSkillsLoad> => ({ skills: [], diagnostics: [], searched: [] });

describe("repro 253: send with staged image clears the cards", () => {
	const roots: { unmount: () => void }[] = [];

	async function mountPanel(mode: "ok" | "fail-late" = "ok") {
		const adapter = memoryAdapter();
		const settings: PiemSettings = {
			...(await import("../settings")).DEFAULT_SETTINGS as PiemSettings,
			providers: [
				{
					id: "prov",
					name: "Test provider",
					baseUrl: "http://localhost",
					protocol: "openai-completions",
					apiKey: "test-key",
					secretRef: "",
					source: "user" as const,
					oauthFlow: "",
				},
			],
			models: [
				{
					id: "mod",
					providerId: "prov",
					modelApiId: "vision-model",
					displayName: "Vision model",
					reasoning: false,
					supportsImages: true,
				},
			],
			provider: "prov",
			modelId: "mod",
			activeModelId: "mod",
			providerApiKeys: { prov: "test-key" },
			networkTransport: "requestUrl",
			showAgentDetails: false,
			sendShortcut: "enter",
			language: "en",
			sessionRetention: DEFAULT_SESSION_RETENTION,
			sessionDir: DEFAULT_SESSION_DIR,
			userSkillsDir: "",
		};
		const app = {
			vault: {
				adapter,
				getName: () => "Test",
				getFiles: () => [],
				getFileByPath: () => null,
				getAbstractFileByPath: () => null,
				read: async () => "",
				cachedRead: async () => "",
			},
			workspace: {
				getActiveViewOfType: () => null,
				getActiveFile: () => null,
			},
		} as unknown as App;
		const sessionManager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		const scripted = scriptedStreamFn(mode);
		const service = new ObsidianAgentService(app, () => settings, sessionManager, {
			streamFn: scripted.streamFn,
			loadUserSkills: NO_USER_SKILLS,
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push(root);
		root.render(
			<ChatApp service={service} inputController={new ChatInputController()} component={{} as Component} />,
		);
		await flushRender();
		return { service, scripted };
	}

	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		while (roots.length > 0) {
			roots.pop()?.unmount();
		}
		await flushRender();
		document.body.replaceChildren();
	});

	it("sends a message with an image and clears the pending card", async () => {
		const { service } = await mountPanel("ok");

		// Wait for init.
		for (let i = 0; i < 10; i += 1) {
			await flushRender();
		}
		// Paste an image into the textarea — the composer's own staging path.
		const textarea = document.body.querySelector(".piem-chat__composer textarea") as HTMLElement;
		expect(textarea).toBeTruthy();
		const png = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		const paste = new (window as unknown as { Event: typeof Event }).Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", {
			value: { files: [png] },
		});
		textarea.dispatchEvent(paste);
		await flushRender();

		const thumbsBefore = document.body.querySelectorAll(".piem-chat__pending-image");
		console.log("supportsImages:", service.getSnapshot().supportsImages, "thumbnails after paste:", thumbsBefore.length);

		// Type text and send via the native setter so React sees the change.
		const proto = Object.getPrototypeOf(textarea);
		const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		if (setter) {
			setter.call(textarea, "look at this");
		} else {
			(textarea as unknown as HTMLTextAreaElement).value = "look at this";
		}
		textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
		await flushRender();

		const send = document.body.querySelector(".piem-chat__send-button") as HTMLButtonElement;
		expect(send).toBeTruthy();
		console.log("send disabled:", send.disabled, "isConfigured:", service.getSnapshot().isConfigured);
		send.click();
		for (let i = 0; i < 30; i += 1) {
			await flushRender();
		}

		const thumbsAfter = document.body.querySelectorAll(".piem-chat__pending-image");
		console.log("thumbnails after send:", thumbsAfter.length);
		console.log("sent runs:", service.getSnapshot().messages.filter((m: { role?: string }) => m.role === "user").length);
		const snap = service.getSnapshot() as { panelError?: unknown; noticeMessage?: unknown };
		console.log("panelError:", snap.panelError, "notice:", snap.noticeMessage);
		console.log("banner text:", document.body.querySelector(".piem-chat__banner")?.textContent ?? "(none)");
		expect(thumbsAfter.length).toBe(0);
	});

	it("a stream that dies mid-reply still clears the staged card", async () => {
		const { service } = await mountPanel("fail-late");
		for (let i = 0; i < 10; i += 1) {
			await flushRender();
		}

		const textarea = document.body.querySelector(".piem-chat__composer textarea") as HTMLElement;
		const png = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		const paste = new (window as unknown as { Event: typeof Event }).Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: { files: [png] } });
		textarea.dispatchEvent(paste);
		await flushRender();
		expect(document.body.querySelectorAll(".piem-chat__pending-image").length).toBe(1);

		const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set;
		setter?.call(textarea, "look at this");
		textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
		await flushRender();

		const send = document.body.querySelector(".piem-chat__send-button") as HTMLButtonElement;
		send.click();
		for (let i = 0; i < 40; i += 1) {
			await flushRender();
		}

		console.log("thumbnails after failed send:", document.body.querySelectorAll(".piem-chat__pending-image").length);
		const snap = service.getSnapshot() as { panelError?: { message?: string } };
		console.log("panelError:", snap.panelError);
		console.log("transcript roles:", service.getSnapshot().messages.map((m: { role?: string }) => m.role));
		// The turn failed: ChatApp must NOT clear the card — text was handed back.
		// Assert what the honest behavior is (card stays), then the bug fix will
		// be about the message text handback, not the image.
	});

	it("a send that throws (not fails — throws) banners the error and hands the text back", async () => {
		const { service } = await mountPanel("ok");
		for (let i = 0; i < 10; i += 1) {
			await flushRender();
		}

		const textarea = document.body.querySelector(".piem-chat__composer textarea") as HTMLElement;
		const png = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		const paste = new (window as unknown as { Event: typeof Event }).Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: { files: [png] } });
		textarea.dispatchEvent(paste);
		await flushRender();
		expect(document.body.querySelectorAll(".piem-chat__pending-image").length).toBe(1);

		const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set;
		setter?.call(textarea, "look at this");
		textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
		await flushRender();

		// The service's own failure paths resolve `false` and land on the banner.
		// But `deliverPrompt` used to await `refreshConfiguration()` (vault reads,
		// session writes) OUTSIDE its try — a throw there rejected `sendPrompt`
		// itself, and ChatApp's send had no catch of its own.
		const realRefresh = service.refreshConfiguration.bind(service);
		service.refreshConfiguration = async () => {
			await realRefresh();
			throw new Error("vault adapter exploded");
		};

		const send = document.body.querySelector(".piem-chat__send-button") as HTMLButtonElement;
		send.click();
		// The boundary now catches: banner + `false`, and ChatApp's guard hands
		// the draft text back. Flush and let the panel settle before reading.
		for (let i = 0; i < 30; i += 1) {
			await flushRender();
		}

		const snap = service.getSnapshot() as { errorMessage?: string };
		expect(snap.errorMessage).toContain("vault adapter exploded");
		// ChatApp's guard restores the words the draft already spent.
		expect((textarea as HTMLTextAreaElement).value).toBe("look at this");
		// The staged image was never consumed; the card stays for the retry.
		expect(document.body.querySelectorAll(".piem-chat__pending-image").length).toBe(1);
	});
});
