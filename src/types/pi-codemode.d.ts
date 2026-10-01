/**
 * Declarations for the codemode build specifiers.
 *
 * `tsc` sees only `tsconfig.json`, and the three names this feature imports are
 * ones esbuild's aliases and its runtime plugin invent:
 * `@earendil-works/pi-codemode/prelude` becomes the prelude's dist file,
 * `/quickjs-wasm` the QuickJS IIFE, `/quickjs-wasm-url` the base64 data URL. None
 * is in the package's `exports` map, so nothing resolves them — the build works
 * because esbuild never consults this map for them, and the type check does not
 * because it does.
 *
 * Declaring them here closes that gap in the direction that fails loudly: a real
 * declaration means `tsc` verifies every use, where leaving them unresolved means
 * `any` at every call site. `src/testUtils/codemodeBuildPreload.ts` points bun at
 * the same three files for the same reason.
 *
 * `/types` is declared too — it is the package's `dist/types.d.ts`, which the
 * `exports` map does not list either.
 */
declare module "@earendil-works/pi-codemode/prelude" {
	/** The JavaScript the prelude evaluates inside the QuickJS VM. */
	export const PRELUDE_SOURCE: string;
	/** Per-value ceiling on a `store()` write, in characters of JSON. */
	export const MAX_STORE_VALUE_CHARS: number;
	/** Ceiling on all stored values together, in characters of JSON. */
	export const MAX_STORE_TOTAL_CHARS: number;
}

declare module "@earendil-works/pi-codemode/quickjs-wasm" {
	/** The browser build of `quickjs-wasi`, as IIFE text. */
	export const QUICKJS_IIFE_SOURCE: string;
}

declare module "@earendil-works/pi-codemode/quickjs-wasm-url" {
	/** `quickjs.wasm` as a `data:` URL. */
	export const QUICKJS_WASM_URL: string;
}

declare module "@earendil-works/pi-codemode/source" {
	/** A token budget for the script's output. */
	export interface CodemodeSourceOptions {
		maxOutputTokens?: number;
		/** Hard deadline for the whole script in milliseconds, including tool calls. */
		timeoutMs?: number;
	}
	export interface ParsedCodemodeSource {
		/**
		 * The script with the options line replaced by an empty line, so a stack
		 * trace still points at the line the model wrote.
		 */
		code: string;
		options: CodemodeSourceOptions;
	}
	/**
	 * Splits an optional first-line `// @options: {...}` from the script. Throws
	 * {@link CodemodeSourceError} for empty input and invalid options.
	 */
	export function parseCodemodeSource(input: string): ParsedCodemodeSource;
}

declare module "@earendil-works/pi-codemode/source" {
	/** A token budget for the script's output. */
	export interface CodemodeSourceOptions {
		maxOutputTokens?: number;
		/** Hard deadline for the whole script in milliseconds, including tool calls. */
		timeoutMs?: number;
	}
	export interface ParsedCodemodeSource {
		/**
		 * The script with the options line replaced by an empty line, so a stack
		 * trace still points at the line the model wrote.
		 */
		code: string;
		options: CodemodeSourceOptions;
	}
	/**
	 * Splits an optional first-line `// @options: {...}` from the script. Throws
	 * {@link CodemodeSourceError} for empty input and invalid options.
	 */
	export function parseCodemodeSource(input: string): ParsedCodemodeSource;
}

declare module "@earendil-works/pi-codemode/identifier" {
	/**
	 * The identifier a script uses for a tool: characters that are not valid in a
	 * JavaScript identifier become `_`. `mcp__docs__search` stays, `my-tool`
	 * becomes `my_tool`.
	 */
	export function toCodemodeIdentifier(name: string): string;
}

declare module "@earendil-works/pi-codemode/types" {
	/** Context handed to a tool a sandbox script calls. */
	export interface CodemodeToolContext {
		/**
		 * Aborted when the script finishes (including unawaited calls), the
		 * execution times out, the caller aborts, or the sandbox is closed.
		 */
		signal: AbortSignal;
	}

	/** A JSON Schema document. Only used to render declarations, never to validate. */
	export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

	/** One tool or global a script can reach. */
	export interface CodemodeTool {
		/**
		 * A script calls tools as `tools.<id>(args)`, where `<id>` is the name with
		 * characters that are not valid in identifiers replaced by `_`, and also as
		 * `tools["<name>"](args)`. Globals are called as `<name>(args)` and must be
		 * identifiers, or `<namespace>.<member>`.
		 */
		name: string;
		/** Shown as a doc comment in the rendered declarations, and listed in `ALL_TOOLS`. */
		description?: string;
		/** Schema of the single argument; rendered as the parameter type. */
		inputSchema?: CodemodeJsonSchema;
		/** Schema of the resolved value; rendered as the promise type. */
		outputSchema?: CodemodeJsonSchema;
		/** Globals only: `execute` receives every argument as an array. */
		spread?: boolean;
		/**
		 * `args` is whatever the script passed, after a JSON round trip. The return
		 * value must be JSON-serializable; a thrown error surfaces in the script as
		 * an `Error` with the same message.
		 */
		execute(args: unknown, context: CodemodeToolContext): unknown;
	}

	/** One item of the script's output, in the order the script produced them. */
	export type CodemodeOutputItem =
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string };

	export type CodemodeCallStatus = "ok" | "error" | "cancelled";

	/** One tool call the script made, and what became of it. */
	export interface CodemodeCall {
		name: string;
		status: CodemodeCallStatus;
		durationMs: number;
	}

	/**
	 * `script`: the script threw or failed to parse.
	 * `timeout`: the deadline expired and the worker was terminated.
	 * `aborted`: the caller's signal fired or the sandbox was closed.
	 * `sandbox`: the worker or VM failed outside the script's control.
	 */
	export type CodemodeErrorKind = "script" | "timeout" | "aborted" | "sandbox";

	export interface CodemodeError {
		kind: CodemodeErrorKind;
		name?: string;
		message: string;
		stack?: string;
	}

	/** Keys the script changed with `store()`. Only successful runs report writes. */
	export interface CodemodeStoreWrites {
		set: Record<string, unknown>;
		/** Keys stored as `undefined`. */
		delete: string[];
	}

	/**
	 * `output` is kept for failed runs too, up to the failure. `exit()` completes
	 * with `value: undefined`.
	 */
	export type CodemodeResult =
		| { ok: true; value: unknown; output: CodemodeOutputItem[]; calls: CodemodeCall[]; storeWrites: CodemodeStoreWrites }
		| { ok: false; error: CodemodeError; output: CodemodeOutputItem[]; calls: CodemodeCall[] };

	export interface CodemodeExecuteOptions {
		signal?: AbortSignal;
		/** Overrides the sandbox default for this execution. */
		timeoutMs?: number;
		/** Values the script reads with `load(key)`. */
		store?: Readonly<Record<string, unknown>>;
	}
}
