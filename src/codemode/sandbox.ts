/** Browser transport for Pi's unmodified QuickJS prelude. One worker per run. */
import { toCodemodeIdentifier, renderToolSample } from "@earendil-works/pi-codemode/declarations";
import type { CodemodeExecuteOptions } from "@earendil-works/pi-codemode";
import type { CodemodeCall, CodemodeError, CodemodeOutputItem, CodemodeResult, CodemodeStoreWrites, SandboxTool, WorkerInit, WorkerMessage } from "./types";
import { quickJsWasmUrl } from "./runtimeAsset";
import { CODEMODE_WORKER_SOURCE } from "./workerSource";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const RESERVED_GLOBALS = new Set(["tools", "ALL_TOOLS", "console", "text", "image", "exit", "globalThis", "store", "load"]);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function serializeStore(store: CodemodeExecuteOptions["store"]): Record<string, string> {
	return Object.fromEntries(Object.entries(store ?? {}).flatMap(([key, value]) => {
		const json = JSON.stringify(value);
		return json === undefined ? [] : [[key, json]];
	}));
}

/** Pi's prelude emits [key, json] for writes and [key] for deletions. */
function parseStoreWrites(json: string): CodemodeStoreWrites {
	const entries = JSON.parse(json) as [string, string?][];
	return {
		set: Object.fromEntries(entries.filter(([, value]) => value !== undefined).map(([key, value]) => [key, JSON.parse(value!) as unknown])),
		delete: entries.filter(([, value]) => value === undefined).map(([key]) => key),
	};
}

let wasmModule: Promise<WebAssembly.Module> | undefined;
function loadWasm(): Promise<WebAssembly.Module> {
	wasmModule ??= Promise.resolve().then(() => {
		const [, base64] = quickJsWasmUrl().split(",", 2);
		if (base64 === undefined) throw new Error("QuickJS wasm URL carries no payload");
		const binary = atob(base64);
		const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
		return WebAssembly.compile(bytes);
	}).catch((error: unknown) => { wasmModule = undefined; throw error; });
	return wasmModule;
}

export interface BrowserSandboxOptions {
	tools?: SandboxTool[];
	globals?: SandboxTool[];
	timeoutMs?: number;
	memoryLimitBytes?: number;
	wasm?: WebAssembly.Module | Promise<WebAssembly.Module>;
	workerSource?: string;
	/** A streaming consumer owns output buffering; otherwise result.output collects it. */
	onOutput?: (item: CodemodeOutputItem) => void;
}

class Execution {
	readonly promise: Promise<CodemodeResult>;
	private settle!: (result: CodemodeResult) => void;
	private worker?: Worker;
	private workerUrl?: string;
	private sequentialLane: Promise<void> = Promise.resolve();
	private readonly pending = new Map<number, { record?: CodemodeCall; controller: AbortController; startedAt: number }>();
	private readonly output: CodemodeOutputItem[] = [];
	private readonly calls: CodemodeCall[] = [];
	private timer?: number;
	private finished = false;

	constructor(
		private readonly tools: Map<string, SandboxTool>,
		private readonly globals: Map<string, SandboxTool>,
		private readonly code: string,
		private readonly options: BrowserSandboxOptions,
		private readonly run: CodemodeExecuteOptions,
	) {
		this.promise = new Promise(resolve => { this.settle = resolve; });
		const timeoutMs = run.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (Number.isFinite(timeoutMs)) {
			this.timer = window.setTimeout(() => this.finish({ kind: "timeout", message: `Execution timed out after ${timeoutMs} ms` }), timeoutMs);
		}
		if (run.signal?.aborted) this.onAbort();
		else run.signal?.addEventListener("abort", this.onAbort, { once: true });
		if (!this.finished) {
			void Promise.resolve(options.wasm ?? loadWasm()).then(wasm => this.start(wasm)).catch((error: unknown) => {
				this.finish({ kind: "sandbox", message: `Failed to initialize QuickJS: ${errorMessage(error)}` });
			});
		}
	}

	private readonly onAbort = () => {
		const reason: unknown = this.run.signal?.reason;
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	private start(wasm: WebAssembly.Module): void {
		if (this.finished) return;
		const init: WorkerInit = {
			tools: [...this.tools.values()].map(tool => ({ name: tool.name, jsName: toCodemodeIdentifier(tool.name), description: renderToolSample(tool) })),
			globals: [...this.globals.values()].map(global => ({ name: global.name, spread: global.spread === true })),
			store: serializeStore(this.run.store), wasm,
			memoryLimitBytes: this.options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
		};
		try {
			// Keep the URL until termination: WebKit may read the blob asynchronously.
			this.workerUrl = URL.createObjectURL(new Blob([this.options.workerSource ?? CODEMODE_WORKER_SOURCE], { type: "text/javascript" }));
			const worker = this.worker = new Worker(this.workerUrl);
			worker.onmessage = event => this.handleMessage(event.data as WorkerMessage);
			worker.onerror = event => this.finish({ kind: "sandbox", message: event.message || "Worker error" });
			worker.onmessageerror = () => this.finish({ kind: "sandbox", message: "Worker message could not be deserialized" });
			worker.postMessage({ type: "init", ...init });
		} catch (error) {
			this.finish({ kind: "sandbox", message: `Failed to start worker: ${errorMessage(error)}` });
		}
	}

	private handleMessage(message: WorkerMessage): void {
		if (this.finished) return;
		try {
			switch (message.type) {
				case "ready": this.worker?.postMessage({ type: "run", code: this.code }); break;
				case "output":
					if (this.options.onOutput) this.options.onOutput(message.item);
					else this.output.push(message.item);
					break;
				case "call": void this.handleCall(message); break;
				case "done":
					if (message.ok) {
						this.finish(undefined, message.value === undefined ? undefined : JSON.parse(message.value) as unknown, message.writes);
					} else {
						const error = JSON.parse(message.error) as { name?: string; message: string; stack?: string };
						this.finish({ ...error, kind: "script" });
					}
					break;
				case "crash": this.finish({ kind: "sandbox", message: message.message }); break;
			}
		} catch (error) {
			this.finish({ kind: "sandbox", message: `Malformed result from the sandbox: ${errorMessage(error)}` });
		}
	}

	private async handleCall(message: Extract<WorkerMessage, { type: "call" }>): Promise<void> {
		const isTool = message.target === "tool";
		const record: CodemodeCall | undefined = isTool ? { name: message.name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		const entry = (isTool ? this.tools : this.globals).get(message.name);
		const pending = { record, controller: new AbortController(), startedAt: performance.now() };
		// Queued calls belong to this execution too: finish() must cancel them.
		this.pending.set(message.id, pending);
		let release: (() => void) | undefined;
		const previous = this.sequentialLane;
		if (entry?.sequential) this.sequentialLane = new Promise(resolve => { release = resolve; });
		try {
			if (entry?.sequential) await previous;
			if (this.finished) return;
			if (!entry) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${message.name}"`);
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await entry.execute(args, { signal: pending.controller.signal });
			this.reply(message.id, true, value === undefined ? undefined : JSON.stringify(value));
		} catch (error) {
			this.reply(message.id, false, errorMessage(error));
		} finally {
			release?.();
		}
	}

	private reply(id: number, ok: boolean, payload?: string): void {
		const pending = this.pending.get(id);
		if (!pending) return; // The execution ended while this call was running.
		this.pending.delete(id);
		if (pending.record) {
			pending.record.status = ok ? "ok" : "error";
			pending.record.durationMs = performance.now() - pending.startedAt;
		}
		this.worker?.postMessage({ type: "settle", id, ok, payload });
	}

	private finish(error?: CodemodeError, value?: unknown, writes?: string): void {
		if (this.finished) return;
		this.finished = true;
		window.clearTimeout(this.timer);
		this.run.signal?.removeEventListener("abort", this.onAbort);
		for (const entry of this.pending.values()) {
			if (entry.record) entry.record.durationMs = performance.now() - entry.startedAt;
			entry.controller.abort();
		}
		this.pending.clear();
		let result: CodemodeResult;
		try {
			result = error ? { ok: false, error, output: this.output, calls: this.calls }
				: { ok: true, value, output: this.output, calls: this.calls, storeWrites: writes === undefined ? { set: {}, delete: [] } : parseStoreWrites(writes) };
		} catch (cause) {
			result = { ok: false, error: { kind: "sandbox", message: `Could not read the sandbox result: ${errorMessage(cause)}` }, output: this.output, calls: this.calls };
		}
		// Browser termination is synchronous. No Node promise or shared interrupt flag.
		try { this.worker?.terminate(); } finally {
			this.worker = undefined;
			if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
			this.workerUrl = undefined;
			this.settle(result);
		}
	}

	abort(): Promise<CodemodeResult> {
		this.finish({ kind: "aborted", message: "Sandbox closed" });
		return this.promise;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class CodemodeSandbox {
	private readonly toolsByName = new Map<string, SandboxTool>();
	private readonly globalsByName = new Map<string, SandboxTool>();
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(private readonly options: BrowserSandboxOptions = {}) {
		for (const tool of options.tools ?? []) this.registerTool(tool);
		const namespaces = new Set<string>();
		for (const global of options.globals ?? []) {
			const parts = global.name.split(".");
			const root = parts[0] ?? "";
			if (parts.length > 2 || !parts.every(part => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(root)) throw new Error(`Invalid global name "${global.name}"`);
			if (this.globalsByName.has(global.name)) throw new Error(`Global "${global.name}" is already registered`);
			if (parts.length === 2) namespaces.add(root);
			this.globalsByName.set(global.name, global);
		}
		for (const name of namespaces) {
			if (this.globalsByName.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
		}
	}

	registerTool(tool: SandboxTool): void {
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.toolsByName.set(tool.name, tool);
	}
	get tools(): SandboxTool[] { return [...this.toolsByName.values()]; }
	get globals(): SandboxTool[] { return [...this.globalsByName.values()]; }

	async execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		if (this.closed) throw new Error("Sandbox is closed");
		const execution = new Execution(new Map(this.toolsByName), this.globalsByName, code, this.options, options);
		this.running.add(execution);
		try { return await execution.promise; }
		finally { this.running.delete(execution); }
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map(execution => execution.abort()));
	}
}
