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
 * - **The `SharedArrayBuffer` interrupt flag is gone rather than downgraded.** pi
 *   shares one so Bun can interrupt a thread spinning inside wasm, where
 *   `terminate()` cannot reach it. A plain `ArrayBuffer` cannot stand in:
 *   `postMessage` structured-clones its payload, so the worker would read a
 *   different buffer from the one the host writes, and the flag would never fire.
 *   Keeping it would be dead code under a comment calling it the graceful path.
 *   `terminate()` is what ends a runaway script here — measured at 301 ms in
 *   WebKit — so there is nothing here to lose.
 */
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/identifier";
import { renderToolSample } from "@earendil-works/pi-codemode/declarations";
import type {
	CodemodeCall,
	CodemodeError,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeStoreWrites,
	SandboxTool,
	WorkerInit,
	WorkerMessage,
} from "./types";
import { quickJsWasmUrl } from "./runtimeAsset";
import { CODEMODE_WORKER_SOURCE } from "./workerSource";

/**
 * How long one script may run before it is terminated.
 *
 * Shorter than pi's 300 s default, on purpose. Upstream's host is a CLI process
 * where a runaway script costs one turn; here the worker sits inside a chat
 * panel on a phone, and five minutes of a spinning loop is five minutes of the
 * user waiting on a reply that is not coming. Two minutes is long enough for the
 * work this is for — reading notes, filtering, writing back — and short enough
 * that a wedged script ends before the user gives up on the conversation.
 *
 * A script that needs longer says so: the `// @options: {"timeout_ms": …}` line
 * is parsed upstream and reaches this as `sourceOptions`.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The VM's heap ceiling.
 *
 * Upstream's own extension uses 256 MiB for a desktop CLI. A phone is not that,
 * and Obsidian may be running beside two other apps in a browser tab-sized
 * process, so this is lower. It is far above what note-sized work needs — the
 * measured cost of parsing a 50,000-object structure is a few seconds and well
 * under 16 MiB — and it turns "the script is wrong" into a catchable
 * `InternalError: out of memory` instead of a tab the user has to force-quit.
 */
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

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
 *
 * A rejected attempt is *not* cached. The realistic failure is a phone under
 * memory pressure failing to compile 637 KB, and keeping that rejection would
 * cost the user the feature until they reloaded Obsidian — one bad moment, no
 * way back.
 */
let wasmModule: Promise<WebAssembly.Module> | undefined;
function loadWasm(): Promise<WebAssembly.Module> {
	wasmModule ??= Promise.resolve().then(() => {
		const [, base64] = quickJsWasmUrl().split(",", 2);
		if (base64 === undefined) throw new Error("QuickJS wasm URL carries no payload");
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return WebAssembly.compile(bytes);
	}).catch((error: unknown) => {
		wasmModule = undefined;
		throw error;
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
	private workerUrl: string | undefined;
	/** Resolves when the current sequential call finishes; see {@link handleCall}. */
	private sequentialLane: Promise<void> = Promise.resolve();
	/** Resolves when the current sequential call finishes; see {@link handleCall}. */
	private readonly pending = new Map<number, {
		record: CodemodeCall | undefined;
		controller: AbortController;
		/** When the call went out, so a cancelled one reports its real duration. */
		startedAt: number;
	}>();
	private readonly output: CodemodeOutputItem[] = [];
	/** Output tokens spent so far, and items the ceiling refused. */
	private spentOutput = 0;
	private droppedOutput = 0;
	/** Output tokens spent so far, and items the ceiling refused. */
	private readonly calls: CodemodeCall[] = [];
	// `window.setTimeout` returns a number in a DOM lib, matching how
	// SessionRuntime types its own timer (`retryNoticeTimer`).
	private timer: number | undefined;
	private finished = false;

	constructor(
		private readonly tools: Map<string, SandboxTool>,
		private readonly globals: Map<string, SandboxTool>,
		private readonly code: string,
		private readonly timeoutMs: number,
		private readonly signal: AbortSignal | undefined,
		private readonly memoryLimitBytes: number | undefined,
		private readonly store: Record<string, string>,
		private readonly wasm: Promise<WebAssembly.Module>,
		private readonly workerSource: string | undefined,
		private readonly maxOutputTokens: number | undefined,
	) {
		this.promise = new Promise<CodemodeResult>(resolve => { this.settle = resolve; });
		if (Number.isFinite(timeoutMs)) {
			this.timer = window.setTimeout(() => {
				this.finish({ kind: "timeout", message: `Execution timed out after ${timeoutMs} ms` });
			}, timeoutMs);
		}
		// Checked before the listener, not after: a listener added to an
		// already-aborted signal never fires, so a run started that way would ignore
		// the abort entirely and take its whole deadline.
		if (signal?.aborted) queueMicrotask(this.onAbort);
		else signal?.addEventListener("abort", this.onAbort, { once: true });
		this.wasm.then(wasm => this.start(wasm), error => {
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
				// Like Pi's executor, ALL_TOOLS carries the schema for omitted tools.
				description: renderToolSample(tool),
			})),
			globals: [...this.globals.values()].map(global => ({
				name: global.name,
				spread: global.spread === true,
			})),
			store: this.store,
			wasm,
			memoryLimitBytes: this.memoryLimitBytes,
		};
		let worker: Worker;
		try {
			// A blob URL rather than a file path: the release ships exactly
			// main.js/manifest.json/styles.css, and a sibling worker file would
			// silently 404 for anyone installing from a release archive. Same
			// shape as the workflow engine's worker.
			//
			// The URL is revoked in `finish()`, not here. Revoking straight after
			// construction works on Chromium and fails elsewhere with `Blob URL is
			// missing`, because whether the worker has read its source yet is not
			// observable from here — so a session that works on a desktop vault
			// reports a sandbox fault on a phone.
			const url = URL.createObjectURL(new Blob([this.workerSource ?? CODEMODE_WORKER_SOURCE], { type: "text/javascript" }));
			this.workerUrl = url;
			worker = new Worker(url);
			worker.postMessage({ type: "init", ...init });
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
	}

	private handleMessage(message: WorkerMessage): void {
		if (this.finished) return;
		switch (message.type) {
			case "ready":
				// The wasm and the VM are created asynchronously, so the script cannot
				// be posted with the init message. Waiting for `ready` costs one round
				// trip and buys a script that cannot start before its runtime exists.
				this.worker?.postMessage({ type: "run", code: this.code });
				return;
			case "output":
				this.pushOutput(message.item);
				return;
			case "call":
				void this.handleCall(message);
				return;
			case "done":
				// Guarded because a throw here would escape `finish`, leaving the run
				// to end at its deadline as a `timeout` — the one mislabel this split
				// of error kinds exists to prevent. The prelude only ever sends its own
				// `JSON.stringify` output, so this is hardening, not a live path.
				try {
					if (message.ok) {
						this.finish(undefined, message.value === undefined ? undefined : JSON.parse(message.value) as unknown, message.writes);
					} else {
						// `kind` is ours, not the prelude's: it reports the name, message
						// and stack, and nothing about which of the four failure modes
						// this is. A script that threw is `script`; a deadline or an abort
						// is reported from here instead, and a VM fault arrives as `crash`.
						const { name, message: text, stack } = JSON.parse(message.error) as { name?: string; message?: string; stack?: string };
						this.finish({ kind: "script", name, message: text ?? "Script failed", stack });
					}
				} catch (error) {
					this.finish({ kind: "sandbox", message: `Malformed result from the sandbox: ${errorMessage(error)}` });
				}
				return;
			case "crash":
				this.finish({ kind: "sandbox", message: message.message });
		}
	}

	/**
	 * One output item, inside the ceiling.
	 *
	 * Whole items are dropped rather than one truncated: an image cut in half is
	 * worse than an absent one, and a text item cut mid-word misleads a model that
	 * quotes it back.
	 */
	private pushOutput(item: CodemodeOutputItem): void {
		const budget = this.maxOutputTokens;
		if (budget === undefined) {
			this.output.push(item);
			return;
		}
		const cost = Math.ceil((item.type === "text" ? item.text.length : item.data.length) / 4);
		if (this.spentOutput + cost <= budget) {
			this.spentOutput += cost;
			this.output.push(item);
			return;
		}
		this.droppedOutput++;
	}


	private async handleCall(message: Extract<WorkerMessage, { type: "call" }>): Promise<void> {
		const isTool = message.target === "tool";
		const record: CodemodeCall | undefined = isTool
			? { name: message.name, status: "cancelled", durationMs: 0 }
			: undefined;
		if (record) this.calls.push(record);
		const entry = (isTool ? this.tools : this.globals).get(message.name);
		// A tool that pins `executionMode: "sequential"` runs one at a time against
		// the other sequential calls in this script.
		//
		// Dropping the pin is not a technicality: for the frontmatter, navigation,
		// interaction and sequential MCP tools it *is* the serialization
		// (`src/tools/obsidianTools.ts`), none of which has an internal lock. A
		// script doing `await Promise.all(notes.map(n =>
		// tools.update_frontmatter(...)))` would re-introduce the interleaving
		// issue #475 fixed, and every call would look ordinary to `tool_call`.
		const sequential = entry?.sequential === true;
		let release: (() => void) | undefined;
		if (sequential) {
			const previous = this.sequentialLane;
			this.sequentialLane = new Promise<void>(resolve => { release = resolve; });
			await previous;
		}

		const controller = new AbortController();
		const startedAt = performance.now();
		this.pending.set(message.id, { record, controller, startedAt });
		let succeeded = false;
		let reply: { type: "settle"; id: number; ok: boolean; payload?: string };
		try {
			if (!entry) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${message.name}"`);
			// `JSON.parse` returns `any`; the tool receives it as `unknown`, which is
			// what every executor in the loop does with a model-supplied argument.
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await entry.execute(args, { signal: controller.signal });
			reply = {
				type: "settle", id: message.id, ok: true,
				payload: value === undefined ? undefined : JSON.stringify(value),
			};
			succeeded = true;
		} catch (error) {
			// Not encoded, unlike the success branch: the prelude rejects with
			// `new Error(payload)` verbatim, and only parses on the success path. A
			// JSON string here would arrive at the script with quotes around it.
			reply = { type: "settle", id: message.id, ok: false, payload: errorMessage(error) };
		} finally {
			// Released even when the tool threw, or one failure would wedge every
			// later sequential call in this script.
			release?.();
		}
		// Already finished (a timeout or an abort landed while the tool ran): the
		// worker is gone, so the record stays `cancelled` and there is no reply. The
		// check precedes every write to the record, because `finish` has already
		// snapshotted this array into the result the caller holds — a late write
		// would relabel a call the run killed.
		if (!this.pending.delete(message.id)) return;
		if (record) {
			record.status = succeeded ? "ok" : "error";
			record.durationMs = performance.now() - startedAt;
		}
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
			// `startedAt`, not `record.durationMs`: that field still holds its `0`
			// initialiser here, so `|| now` collapsed to zero and a call that ran for
			// forty seconds before a deadline recorded as 0 ms.
			if (entry.record) entry.record.durationMs = now - entry.startedAt;
			entry.controller.abort();
		}
		this.pending.clear();
		const calls = this.calls;
		if (this.droppedOutput > 0) {
			// The ceiling's own notice, last, so a model reading a truncated
			// transcript is told it is truncated instead of treating what it can see
			// as everything the script said.
			this.output.push({
				type: "text",
				text: `[${this.droppedOutput} output item(s) dropped: the script printed more than the ${this.maxOutputTokens}-token limit.]`,
			});
		}
		let result: CodemodeResult;
		try {
			result = error
				? { ok: false, error, output: this.output, calls }
				: {
					ok: true, value, output: this.output, calls,
					// A failed run reports no writes: the script may have got half way
					// through mutating the store, and pretending otherwise would hand
					// the caller a state it never reached.
					storeWrites: writes === undefined ? { set: {}, delete: [] } : parseStoreWrites(writes),
				};
		} catch (cause) {
			// Everything past `finished = true` is unreachable from any other exit, so
			// a throw here would leave the worker alive and the promise unsettled for
			// good — the caller would wait out a deadline that can no longer fire.
			result = {
				ok: false,
				error: { kind: "sandbox", message: `Could not read the sandbox result: ${errorMessage(cause)}` },
				output: this.output,
				calls,
			};
		}
		terminate(this.worker);
		this.worker = undefined;
		if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
		this.workerUrl = undefined;
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
	private readonly toolsByName = new Map<string, SandboxTool>();
	private readonly globalsByName = new Map<string, SandboxTool>();
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(
		private readonly options: {
			tools?: SandboxTool[];
			globals?: SandboxTool[];
			timeoutMs?: number;
			memoryLimitBytes?: number;
			/** Already-compiled `quickjs.wasm`; defaults to the inlined data URL. */
			wasm?: WebAssembly.Module | Promise<WebAssembly.Module>;
			/**
			 * The worker's script, overriding the inlined build.
			 *
			 * Upstream's `workerUrl`, one level down: a host that bundles cannot use
			 * the package's worker file, so it supplies its own. Here the equivalent
			 * is the text itself, which also lets a test drive `execute` without the
			 * build that inlines the QuickJS runtime — the seam through which the
			 * missing `run` post was caught.
			 */
			workerSource?: string;
			/**
			 * A ceiling on the script's printed output, in tokens.
			 *
			 * Applied as items arrive, not at the end: a script printing in a loop
			 * does not run out of VM memory, it runs out of *context*, one output
			 * item at a time, and the VM's ceiling says nothing about that.
			 */
			maxOutputTokens?: number;
			/**
			 * The worker's script, overriding the inlined build.
			 *
			 * Upstream's `workerUrl`, one level down: a host that bundles cannot use
			 * the package's worker file, so it supplies its own. Here the equivalent
			 * is the text itself, which also lets a test drive `execute` without the
			 * build that inlines the QuickJS runtime — the seam through which the
			 * missing `run` post was caught.
			 */
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
	registerTool(tool: SandboxTool): void {
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.toolsByName.set(tool.name, tool);
	}

	get tools(): SandboxTool[] { return [...this.toolsByName.values()]; }
	get globals(): SandboxTool[] { return [...this.globalsByName.values()]; }

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
			code,
			options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			options.signal,
			this.options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
			serializeStore(options.store),
			// Upstream's seam, kept: a caller that already has the module hands it
			// over instead of paying the inlined decode. It is also what makes this
			// class reachable from a test, which is how the init/run handshake got
			// asserted at all.
			// `Promise.resolve` so a caller may hand over either a module or a promise
			// for one, which is upstream's signature.
			Promise.resolve(this.options.wasm ?? loadWasm()),
			this.options.workerSource,
			this.options.maxOutputTokens,
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
