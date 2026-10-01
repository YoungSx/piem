/**
 * sandbox.ts — the host half: one script, one Web Worker, one QuickJS VM.
 *
 * A port of pi-codemode's `runtime/host.js`, rewritten for the two things a
 * WebView does not have. Everything pi's version guarantees is kept, because
 * the prelude inside the VM is unchanged and expects this contract:
 *
 * - **One worker per execution.** A fresh VM means a runaway script — including
 *   one that only spins the microtask queue — is killed by `terminate()` and
 *   cannot poison a later run.
 * - **`execute()` never rejects for script failures.** They come back as
 *   `{ ok: false, error }` with `error.kind` telling a script bug (`script`) from
 *   a deadline (`timeout`), a cancellation (`aborted`), and a fault in the
 *   sandbox itself (`sandbox`).
 * - **Partial output survives failure**, so a model sees what the script managed
 *   before it broke.
 *
 * The two rewrites, both forced by the platform:
 *
 * - **`node:worker_threads` becomes a blob-URL Web Worker.** The one that bites
 *   is `terminate()`: Node's returns a Promise, a Web Worker's returns `void`.
 *   pi's host calls `.catch().then()` on it, which throws on a real phone. Every
 *   exit path here goes through {@link terminate} instead.
 * - **`SharedArrayBuffer` becomes a plain `ArrayBuffer`.** pi shares one so Bun
 *   can interrupt a thread spinning inside wasm, where `terminate()` cannot
 *   reach it. Obsidian is Electron or a WebView, neither of which is Bun, and
 *   `terminate()` is what actually ends a runaway script — measured at 301 ms in
 *   Playwright WebKit. `Atomics.store`/`load` work on a plain buffer, so the flag
 *   stays for the polite path and costs nothing.
 */
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/identifier";
import type {
	CodemodeCall,
	CodemodeError,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeStoreWrites,
	CodemodeTool,
	WorkerInit,
	WorkerMessage,
} from "./types";
import { QUICKJS_WASM_URL } from "./runtimeAsset";
import { CODEMODE_WORKER_SOURCE } from "./workerSource";

/** pi's default, kept so a script that hangs is bounded rather than wedging the chat. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Names the prelude binds itself; a global with one of these names is rejected. */
const RESERVED_GLOBALS = new Set([
	"tools", "ALL_TOOLS", "console", "text", "image", "exit", "globalThis", "store", "load",
]);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The store crosses into the VM as pre-serialized JSON, one string per key. */
function serializeStore(store: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
	const serialized: Record<string, string> = {};
	for (const [key, value] of Object.entries(store ?? {})) {
		const json = JSON.stringify(value);
		if (json !== undefined) serialized[key] = json;
	}
	return serialized;
}

/**
 * The prelude's tuples, each `[key]` or `[key, json]`.
 *
 * Narrowed element by element rather than cast: `JSON.parse` hands back `any`,
 * and a cast would move that `any` into every field instead of the one place the
 * shape is checked.
 */
function parseTuples(json: string): string[][] {
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) return [];
	return parsed.map(entry => (Array.isArray(entry) ? entry.map(part => String(part)) : [String(entry)]));
}

/**
 * The prelude's store writes, decoded.
 *
 * Its `serializeWrites()` emits an array of tuples — `[key]` for a delete,
 * `[key, json]` for a set — not an object. pi's own host reads that with
 * `Object.entries`, which turns `[["k","41"]]` into `[["0", ["k","41"]]]` and
 * would then store the tuple under the key `"0"`. Decoding the shape the prelude
 * actually produces is the whole job here, so it is spelled out.
 */
function parseStoreWrites(json: string): CodemodeStoreWrites {
	const writes: CodemodeStoreWrites = { set: {}, delete: [] };
	const entries = parseTuples(json);
	for (const entry of entries) {
		if (entry.length < 2) writes.delete.push(entry[0] ?? "");
		else writes.set[entry[0] ?? ""] = JSON.parse(entry[1] ?? "null") as unknown;
	}
	return writes;
}

/**
 * Compiled `quickjs.wasm`, once per plugin lifetime.
 *
 * The bytes ride in the bundle as a `data:` URL (see {@link ./runtimeAsset}), so
 * there is no file to read and nothing to wait on over a network — the two things
 * pi's loader uses, `node:fs` and a `fetch`, are both absent here by
 * construction. Decoded with `atob` rather than `fetch` for the same reason: a
 * data URL has no network in it, and going through `fetch` would buy nothing but
 * a dependency on a global the plugin otherwise does not use.
 *
 * Measured in a real Obsidian: 21.5 ms to decode, 3.8 ms to compile, once.
 */
let wasmModule: Promise<WebAssembly.Module> | undefined;
function loadWasm(): Promise<WebAssembly.Module> {
	wasmModule ??= Promise.resolve().then(() => {
		const [, base64] = QUICKJS_WASM_URL.split(",", 2);
		if (base64 === undefined) throw new Error("QuickJS wasm URL carries no payload");
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return WebAssembly.compile(bytes);
	});
	return wasmModule;
}

/**
 * One worker plus its protocol.
 *
 * The awkward parts are the two ends of the run: a tool call goes out and the
 * worker goes quiet until an answer comes back, and the run ends when the worker
 * says so, the deadline fires, or the caller aborts. All three must terminate
 * the worker, and `finish()` is the one place that does it.
 */
class Execution {
	readonly promise: Promise<CodemodeResult>;
	private settle!: (result: CodemodeResult) => void;
	private worker: Worker | undefined;
	private readonly pending = new Map<number, {
		record: CodemodeCall | undefined;
		controller: AbortController;
	}>();
	private readonly output: CodemodeOutputItem[] = [];
	private readonly calls: CodemodeCall[] = [];
	private readonly interrupt = new ArrayBuffer(4);
	// `window.setTimeout` returns a number in a DOM lib, matching how
	// SessionRuntime types its own timer (`retryNoticeTimer`).
	private timer: number | undefined;
	private finished = false;

	constructor(
		private readonly tools: Map<string, CodemodeTool>,
		private readonly globals: Map<string, CodemodeTool>,
		private readonly timeoutMs: number,
		private readonly signal: AbortSignal | undefined,
		private readonly memoryLimitBytes: number | undefined,
		private readonly store: Record<string, string>,
	) {
		this.promise = new Promise<CodemodeResult>(resolve => { this.settle = resolve; });
		if (Number.isFinite(timeoutMs)) {
			this.timer = window.setTimeout(() => {
				this.finish({ kind: "timeout", message: `Execution timed out after ${timeoutMs} ms` });
			}, timeoutMs);
		}
		signal?.addEventListener("abort", this.onAbort, { once: true });
		loadWasm().then(wasm => this.start(wasm), error => {
			this.finish({ kind: "sandbox", message: `Failed to load QuickJS: ${errorMessage(error)}` });
		});
	}

	private readonly onAbort = () => {
		const reason: unknown = this.signal?.reason;
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	private start(wasm: WebAssembly.Module): void {
		if (this.finished) return;
		const init: WorkerInit = {
			tools: [...this.tools.values()].map(tool => ({
				name: tool.name,
				jsName: toCodemodeIdentifier(tool.name),
				description: tool.description ?? "",
			})),
			globals: [...this.globals.values()].map(global => ({
				name: global.name,
				spread: global.spread === true,
			})),
			store: this.store,
			wasm,
			memoryLimitBytes: this.memoryLimitBytes,
			interrupt: this.interrupt,
		};
		let worker: Worker;
		try {
			// A blob URL rather than a file path: the release ships exactly
			// main.js/manifest.json/styles.css, and a sibling worker file would
			// silently 404 for anyone installing from a release archive. Same
			// shape as the workflow engine's worker.
			const url = URL.createObjectURL(new Blob([CODEMODE_WORKER_SOURCE], { type: "text/javascript" }));
			worker = new Worker(url);
			// Revoked after construction, which is all a blob URL needs: the worker
			// has already been handed its own copy of the source.
			URL.revokeObjectURL(url);
		} catch (error) {
			this.finish({ kind: "sandbox", message: `Failed to start worker: ${errorMessage(error)}` });
			return;
		}
		this.worker = worker;
		worker.onmessage = event => this.handleMessage(event.data as WorkerMessage);
		worker.onerror = event => {
			// `ErrorEvent.name` is not in the DOM lib this repo compiles against,
			// and it is not worth reading: the message is what the model needs.
			this.finish({ kind: "sandbox", message: event.message || "Worker error" });
		};
		worker.onmessageerror = () => {
			this.finish({ kind: "sandbox", message: "Worker message could not be deserialized" });
		};
		worker.postMessage({ type: "init", ...init });
	}

	private handleMessage(message: WorkerMessage): void {
		if (this.finished) return;
		switch (message.type) {
			case "ready":
				return;
			case "output":
				this.output.push(message.item);
				return;
			case "call":
				void this.handleCall(message);
				return;
			case "done":
				if (message.ok) {
					this.finish(undefined, message.value === undefined ? undefined : JSON.parse(message.value), message.writes);
				} else {
					this.finish(JSON.parse(message.error) as CodemodeError);
				}
				return;
			case "crash":
				this.finish({ kind: "sandbox", message: message.message });
		}
	}

	private async handleCall(message: Extract<WorkerMessage, { type: "call" }>): Promise<void> {
		const isTool = message.target === "tool";
		const record: CodemodeCall | undefined = isTool
			? { name: message.name, status: "cancelled", durationMs: 0 }
			: undefined;
		if (record) this.calls.push(record);
		const controller = new AbortController();
		const startedAt = performance.now();
		this.pending.set(message.id, { record, controller });
		let reply: { type: "settle"; id: number; ok: boolean; payload?: string };
		try {
			const entry = (isTool ? this.tools : this.globals).get(message.name);
			if (!entry) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${message.name}"`);
			// `JSON.parse` returns `any`; the tool receives it as `unknown`, which is
			// what every executor in the loop does with a model-supplied argument.
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await entry.execute(args, { signal: controller.signal });
			reply = {
				type: "settle", id: message.id, ok: true,
				payload: value === undefined ? undefined : JSON.stringify(value),
			};
			if (record) record.status = "ok";
		} catch (error) {
			// Not encoded, unlike the success branch: the prelude rejects with
			// `new Error(payload)` verbatim, and only parses on the success path. A
			// JSON string here would arrive at the script with quotes around it.
			reply = { type: "settle", id: message.id, ok: false, payload: errorMessage(error) };
			if (record) record.status = "error";
		}
		// Already finished (a timeout or an abort landed while the tool ran): the
		// worker is gone, so the record stays `cancelled` and there is no reply.
		if (!this.pending.delete(message.id)) return;
		if (record) record.durationMs = performance.now() - startedAt;
		this.worker?.postMessage(reply);
	}

	/**
	 * The single exit path.
	 *
	 * Everything that ends a run converges here, which is what guarantees the
	 * worker is terminated exactly once and the promise settled exactly once. The
	 * result is built before the terminate so a late message cannot corrupt it.
	 */
	private finish(error?: CodemodeError, value?: unknown, writes?: string): void {
		if (this.finished) return;
		this.finished = true;
		window.clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);
		const now = performance.now();
		// A tool still running when the script ends is cancelled through its own
		// signal, and its record says so rather than claiming a result.
		for (const entry of this.pending.values()) {
			if (entry.record) entry.record.durationMs = now - (entry.record.durationMs || now);
			entry.controller.abort();
		}
		this.pending.clear();
		const calls = this.calls;
		const result: CodemodeResult = error
			? { ok: false, error, output: this.output, calls }
			: {
				ok: true, value, output: this.output, calls,
				// A failed run reports no writes: the script may have got half way
				// through mutating the store, and pretending otherwise would hand
				// the caller a state it never reached.
				storeWrites: writes === undefined ? { set: {}, delete: [] } : parseStoreWrites(writes),
			};
		// The polite flag, then the hard stop. Set first so a script that is
		// inside wasm gets a chance to unwind rather than dying mid-allocation.
		Atomics.store(new Int32Array(this.interrupt), 0, 1);
		terminate(this.worker);
		this.worker = undefined;
		this.settle(result);
	}

	/** Ends the run because the caller aborted or the sandbox closed. */
	abort(reason: string): Promise<CodemodeResult> {
		this.finish({ kind: "aborted", message: reason });
		return this.promise;
	}
}

/**
 * Terminates a worker, whatever it returns.
 *
 * A Web Worker's `terminate()` returns `void`; Node's returns a Promise. pi's
 * host chains off it, which is fine there and a `TypeError` here — so the void
 * case is normalized rather than awaited. Idempotent because `finish()` and a
 * caller-driven abort can race.
 */
function terminate(worker: Worker | undefined): void {
	if (!worker) return;
	try { worker.terminate(); } catch { /* already gone */ }
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Runs model-written JavaScript in a QuickJS sandbox whose only capability is
 * calling injected tools.
 *
 * Nested tool results never reach the model's context — only the script's
 * `text()` output and return value do. That is the whole point: a script that
 * reads forty files to answer one question costs the model one result instead of
 * forty.
 */
export class CodemodeSandbox {
	private readonly toolsByName = new Map<string, CodemodeTool>();
	private readonly globalsByName = new Map<string, CodemodeTool>();
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(
		private readonly options: {
			tools?: CodemodeTool[];
			globals?: CodemodeTool[];
			timeoutMs?: number;
			memoryLimitBytes?: number;
		} = {},
	) {
		for (const tool of options.tools ?? []) this.registerTool(tool);
		const namespaces = new Set<string>();
		for (const global of options.globals ?? []) {
			const parts = global.name.split(".");
			const root = parts[0] ?? "";
			if (parts.length > 2 || !parts.every(part => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(root)) {
				throw new Error(`Invalid global name "${global.name}"`);
			}
			if (this.globalsByName.has(global.name)) {
				throw new Error(`Global "${global.name}" is already registered`);
			}
			if (parts.length === 2) namespaces.add(root);
			this.globalsByName.set(global.name, global);
		}
		for (const name of namespaces) {
			if (this.globalsByName.has(name)) {
				throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
			}
		}
	}

	/** Throws if a tool with the same name is already registered. */
	registerTool(tool: CodemodeTool): void {
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.toolsByName.set(tool.name, tool);
	}

	get tools(): CodemodeTool[] { return [...this.toolsByName.values()]; }
	get globals(): CodemodeTool[] { return [...this.globalsByName.values()]; }

	/**
	 * Runs `code`, the body of an async function: `return` and top-level `await`
	 * both work. Never rejects for script failures; those come back as
	 * `{ ok: false }`.
	 */
	async execute(code: string, options: { signal?: AbortSignal; timeoutMs?: number; store?: Readonly<Record<string, unknown>> } = {}): Promise<CodemodeResult> {
		if (this.closed) throw new Error("Sandbox is closed");
		const execution = new Execution(
			this.toolsByName,
			this.globalsByName,
			options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			options.signal,
			this.options.memoryLimitBytes,
			serializeStore(options.store),
		);
		this.running.add(execution);
		try {
			return await execution.promise;
		} finally {
			this.running.delete(execution);
		}
	}

	/** Aborts in-flight executions and refuses new ones. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map(execution => execution.abort("Sandbox closed")));
	}
}