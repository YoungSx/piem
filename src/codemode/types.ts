import type { CodemodeOutputItem } from "@earendil-works/pi-codemode/types";

/**
 * The codemode types this feature uses, in one import.
 *
 * Read from `@earendil-works/pi-codemode/types` — a specifier esbuild's alias
 * and `src/types/pi-codemode.d.ts` both point at the package's own
 * `dist/types.d.ts`. Not the package root: that pulls in `runtime/host.js`,
 * which imports `node:worker_threads` at the top level, and on a phone that is a
 * throw during module evaluation rather than a missing feature — it would take
 * the whole plugin down instead of one tool. Every re-export below is type-only,
 * so none of it survives into the bundle at all.
 */
export type {
	CodemodeCall,
	CodemodeError,
	CodemodeErrorKind,
	CodemodeJsonSchema,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeStoreWrites,
	CodemodeTool,
	CodemodeToolContext,
} from "@earendil-works/pi-codemode/types";

/** What the worker needs to create one VM. */
export interface WorkerInit {
	tools: { name: string; jsName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	store: Record<string, string>;
	wasm: WebAssembly.Module;
	memoryLimitBytes?: number;
	/** Plain `ArrayBuffer`, not `SharedArrayBuffer`: see {@link ../workerSource}. */
	interrupt: ArrayBuffer;
}

/**
 * Every message the worker sends back, mirroring pi's `runtime/protocol.js`.
 *
 * `ready` exists because the wasm and the VM are created asynchronously: a `run`
 * posted immediately would race them. The host waits, which costs one round trip
 * and buys a script that cannot start before its runtime exists.
 */
export type WorkerMessage =
	| { type: "ready" }
	| { type: "output"; item: CodemodeOutputItem }
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args?: string }
	| { type: "done"; ok: true; value?: string; writes: string }
	| { type: "done"; ok: false; error: string }
	| { type: "crash"; message: string };
