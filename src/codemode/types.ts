import type { CodemodeTool, CodemodeOutputItem } from "@earendil-works/pi-codemode";

/** Pi tool metadata with the host's write-serialization requirement. */
export interface SandboxTool extends CodemodeTool {
	sequential?: boolean;
}

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
} from "@earendil-works/pi-codemode";

/** What the worker needs to create one VM. */
export interface WorkerInit {
	tools: { name: string; jsName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	store: Record<string, string>;
	wasm: WebAssembly.Module;
	memoryLimitBytes?: number;
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
