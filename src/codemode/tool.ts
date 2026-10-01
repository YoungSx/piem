/**
 * codemodeTool.ts — the `codemode` tool the model calls.
 *
 * The model writes a script, the script calls tools, and only the script's output
 * reaches the model. Everything about the sandbox half is upstream's
 * ({@link CodemodeSandbox}); this file is the conversation half — which tools a
 * script may reach, how a script's call becomes a real call through the agent
 * loop, and what the model is told when a script fails.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { renderDeclarations } from "@earendil-works/pi-codemode/declarations";
import { parseCodemodeSource, type ParsedCodemodeSource } from "@earendil-works/pi-codemode/source";
import { CodemodeSandbox } from "./sandbox";
import type {
	CodemodeCall,
	CodemodeJsonSchema,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeTool,
} from "./types";

/**
 * The ceiling on the tool declarations in this tool's description, in tokens.
 *
 * Every tool in the session is offered to a script — thirty-odd by default — and
 * each declaration carries a doc comment drawn from the tool's own description,
 * which is written for a model reading it in a tool list. That is a lot of text
 * for a description the model reads on *every* request, so it is capped here and
 * the description says so when it truncates: a model told the list is partial
 * goes and calls the tool directly, while one told a truncated list is complete
 * invents the missing tools.
 */
export const DEFAULT_INLINE_BUDGET = 3000;

/**
 * How much of a script's printed output reaches the model, in tokens.
 *
 * Every `text()` and `console.*` line counts, and they all go into the tool result
 * the *next* request carries — so an uncapped script printing in a loop does not
 * exhaust the VM, it exhausts the context, or draws a provider 400. Upstream
 * parses `max_output_tokens` and never applies it; 10 000 is its documented default
 * and is what this ships.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

/** The most a script may ask for, whatever it asks for. */
const MAX_ALLOWED_OUTPUT_TOKENS = 50_000;

/**
 * The longest a script may run, whatever it asks for.
 *
 * Ten minutes. Long enough that a legitimately slow vault-wide sweep finishes
 * rather than being cut off at a number that looks arbitrary, and short enough
 * that a runaway ends while the user still has the app open. The default with no
 * options line is two minutes (`sandbox.ts`).
 *
 * The clamp exists because upstream's parser accepts any positive integer: a model
 * asking for 86 400 000 would otherwise get a worker pinned until they closed
 * Obsidian.
 */
const MAX_ALLOWED_TIMEOUT_MS = 600_000;

/**
 * How much of a script's printed output reaches the model, in tokens.
 *
 * Every `text()` and `console.*` line counts, and they all go into the tool result
 * the *next* request carries — so an uncapped script printing in a loop does not
 * exhaust the VM, it exhausts the context, or draws a provider 400. Upstream
 * parses `max_output_tokens` and never applies it; 10 000 is its documented default
 * and is what this ships.
 */
/** The most a script may ask for, whatever it asks for. */
/**
 * The longest a script may run, whatever it asks for.
 *
 * Ten minutes. Long enough that a legitimately slow vault-wide sweep finishes
 * rather than being cut off at a number that looks arbitrary, and short enough
 * that a runaway ends while the user still has the app open. The default with no
 * options line is two minutes (`sandbox.ts`).
 *
 * The clamp exists because upstream's parser accepts any positive integer: a model
 * asking for 86 400 000 would otherwise get a worker pinned until they closed
 * Obsidian.
 */
/**
 * Four characters per token. Rough, but it only has to decide whether a block
 * fits a budget; being wrong by a few tokens changes nothing, and an exact
 * tokenizer would be a dependency for that.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** One tool, as the sandbox and the declaration renderer want it. */
export interface ScriptTool extends CodemodeTool {
	/** The agent tool this shadow exists for, so a call can be run properly. */
	readonly agentTool: AgentTool;
}

/**
 * What the host hands the tool.
 *
 * Read per call rather than captured at construction: the tool set changes with
 * the conversation — MCP servers connect in the background, extensions enable —
 * and a sandbox built once at startup would offer a stale list for the rest of
 * the process's life.
 */
export interface CodemodeToolHost {
	/** Every tool a script may call. */
	tools(): readonly AgentTool[];
	/**
	 * Runs one call through the agent loop's own tool path, so schema validation,
	 * the `tool_call`/`tool_result` hooks and any permission check apply exactly as
	 * they would for a model-issued call. Never rejects for a tool failure.
	 */
	executeTool(name: string, args: JsonObject, signal: AbortSignal): Promise<AgentToolResult>;
}

/** The model-facing schema: one string, the script. */
const codemodeSchema = Type.Object({ code: Type.String() });

/** How a tool's result becomes a value the script sees. */
function toScriptValue(result: AgentToolResult): unknown {
	if (result.structuredContent !== undefined) return result.structuredContent;
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

/**
 * The tools, wired.
 *
 * `execute` goes through the host rather than calling `agentTool.execute` directly:
 * the direct call skips validation and the hooks, which is exactly the layer an
 * extension installed to vet tool calls exists to run.
 */
const SELF = "codemode";

/**
 * The tools a script may call.
 *
 * One exclusion, and it is load-bearing: **`codemode` itself.** A script that
 * could call `codemode` could nest — each level is a fresh Web Worker with its own
 * 64 MiB QuickJS VM, and nothing in the loop counts depth, so
 * `await Promise.all(Array.from({ length: 200 }, () => tools.codemode({ code:
 * "while (true) {}" })))` is two hundred workers on a phone. A `Promise.all` over
 * a loop is ordinary model output, so this is reachable by accident rather than
 * only by intent, and iOS answers that with a jetsam kill that no JavaScript error
 * describes. It also kept the tool's own ~3000-token description inside the
 * declaration budget it was being counted against.
 *
 * Nothing else is excluded. `run_workflow` and the subagent pair orchestrate just
 * as `codemode` does, and a script fanning out through one of them is not nesting
 * a sandbox.
 */
function scriptTools(tools: readonly AgentTool[], host: CodemodeToolHost): ScriptTool[] {
	// First name wins, and duplicates are dropped rather than rejected.
	//
	// The sandbox's own registry throws on a duplicate name, so a list with one in
	// it made the whole tool unusable — and a duplicate is reachable: MCP tools are
	// appended to the mounted set from a background gather, and a server that
	// connects twice registers the same name. Everything else here already takes the
	// first match — `runToolCall` resolves by name, and the prelude keeps the first
	// tool to claim an identifier — so dropping is the behaviour a caller expects
	// rather than an error it has to learn about.
	const seen = new Set<string>();
	return tools
		.filter((agentTool) => {
			if (agentTool.name === SELF || seen.has(agentTool.name)) return false;
			seen.add(agentTool.name);
			return true;
		})
		.map((agentTool) => ({
		name: agentTool.name,
		description: agentTool.description,
		inputSchema: agentTool.parameters as CodemodeJsonSchema,
		// pi's `executionMode` is the *primary* serialization for several vault
		// tools (`src/tools/obsidianTools.ts`); the sandbox keeps it as a lane.
		sequential: agentTool.executionMode === "sequential",
		agentTool,
		execute: async (args, { signal }) => {
			const result = await host.executeTool(agentTool.name, (args ?? {}) as JsonObject, signal);
			if (result.isError) {
				// A failing call rejects, so a script can handle a miss instead of
				// carrying on with `undefined` and writing it into a note.
				throw new Error(toScriptValue(result) as string);
			}
			return toScriptValue(result);
		},
		}));
}

/**
 * The declarations block, capped to the budget and honest about being capped.
 *
 * Truncated by dropping whole tools, never by slicing: a declaration cut in the
 * middle of a signature is worse than one that is absent, because the model
 * cannot tell the two apart.
 */
function renderToolDeclarations(tools: readonly ScriptTool[], budget: number): string {
	if (tools.length === 0) return "No tools are available to scripts in this session.";
	const full = renderDeclarations({ tools });
	if (estimateTokens(full) <= budget) return full;
	const kept: ScriptTool[] = [];
	for (const tool of tools) {
		if (estimateTokens(renderDeclarations({ tools: [...kept, tool] })) > budget) break;
		kept.push(tool);
	}
	const hidden = tools.length - kept.length;
	const rendered = kept.length === 0
		? "// The declarations are too long for this budget; call tools directly."
		: renderDeclarations({ tools: kept });
	return `${rendered}\n// ${hidden} more tool${hidden === 1 ? " is" : "s are"} not listed here (description budget reached). Call ${hidden === 1 ? "it" : "them"} directly if you need ${hidden === 1 ? "it" : "them"}.`;
}

/** How to write a script at all, above the declarations. */
const USAGE = `Run JavaScript that calls tools as \`await tools.<name>(args)\`. Results the script
reads stay inside it — only what it prints with \`text()\` or returns reaches this
conversation — so one script can read many notes and answer with a single summary.

Inside a script: \`tools\` and \`ALL_TOOLS\`; \`text(value)\` and \`console.*\` to output;
\`exit()\` to stop early. A tool that fails rejects, so wrap a call in \`try\` when a
miss is survivable. The script is the body of an async function, so \`await\` at
the top level works.

Each call is its own VM and nothing carries over between two calls, so a script
that needs to remember something has to finish and be called again.

A first line of \`// @options: {"timeout_ms": 180000}\` asks for more time than
the default two minutes, for a script that genuinely needs it; \`max_output_tokens\`
(10000 by default) caps what the script may print — anything past it is dropped and
the run says so, so a script that wants more should print less.

\`\`\`js
const hits = await tools.grep({ query: "TODO" });
const lines = hits.split("\\n");
text(lines.slice(0, 5).join("\\n"));
return lines.length + " matches";
\`\`\``;

/** Builds the tool. */
export function createCodemodeTool(
	host: CodemodeToolHost,
	options: { inlineBudget?: number; memoryLimitBytes?: number; timeoutMs?: number; maxOutputTokens?: number } = {},
): AgentTool<typeof codemodeSchema> {
	// Rendered on read, not at construction. The tool is built once per service,
	// which happens before any conversation exists, so a description computed then
	// would be "No tools are available" forever — the model would be told the
	// sandbox has no tools and the declarations would never appear. A getter also
	// keeps the callable set honest: the tools are read per call, so the list in
	// the description is the same list the sandbox will offer.
	//
	// Memoized on the tool names, because `description` is read on every request
	// and rendering thirty declarations is not free.
	let memo: { signature: string; text: string } | undefined;
	const describe = (): string => {
		const tools = scriptTools(host.tools(), host);
		const signature = tools.map(tool => tool.name).join(",");
		if (memo?.signature !== signature) {
			memo = {
				signature,
				text: `${USAGE}\n\n${renderToolDeclarations(tools, options.inlineBudget ?? DEFAULT_INLINE_BUDGET)}`,
			};
		}
		return memo.text;
	};

	return {
		name: "codemode",
		label: "Codemode",
		get description() {
			return describe();
		},
		parameters: codemodeSchema,
		execute: async (_toolCallId, params, signal) => {
			// The script may ask for more time on its first line, which is what makes
			// the sandbox's default deadline safe to keep short: a script that
			// genuinely needs three minutes says so rather than being cut off.
			// A malformed options line is the model's mistake to see, not ours to
			// swallow, so it is reported as a script error.
			let source: ParsedCodemodeSource;
			try {
				source = parseCodemodeSource(params.code);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Script error: ${error instanceof Error ? error.message : String(error)}` }],
					details: undefined,
					isError: true,
				};
			}
			// Built per call so the tool list is the conversation's current one, and
			// closed in `finally` so a thrown script cannot leave a worker running.
			const sandbox = new CodemodeSandbox({
				tools: scriptTools(host.tools(), host),
				memoryLimitBytes: options.memoryLimitBytes,
				timeoutMs: options.timeoutMs,
				maxOutputTokens: Math.min(
					source.options.maxOutputTokens ?? options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
					MAX_ALLOWED_OUTPUT_TOKENS,
				),
			});
			let result: CodemodeResult;
			try {
				result = await sandbox.execute(source.code, {
					signal,
					timeoutMs: Math.min(source.options.timeoutMs ?? Number.POSITIVE_INFINITY, MAX_ALLOWED_TIMEOUT_MS),
				});
			} finally {
				await sandbox.close();
			}
			return toToolResult(result);
		},
	};
}

/** The model's view of one finished run. */
function toToolResult(result: CodemodeResult): AgentToolResult {
	// Output survives a failure: what the script managed before it broke is usually
	// the part worth reading, and the model can act on it rather than rerun blind.
	const content = result.output.map(toContentBlock);
	if (result.ok) {
		if (result.value !== undefined) content.push({ type: "text", text: JSON.stringify(result.value) });
		return { content, details: detailsOf(result) };
	}
	content.push({ type: "text", text: `Script error: ${result.error.stack ?? result.error.message}` });
	return { content, details: detailsOf(result), isError: true };
}

/** A script's output items already carry pi-ai's content shape. */
function toContentBlock(item: CodemodeOutputItem): { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } {
	return item;
}

/**
 * What the panel renders: every call the script made, and what became of it.
 *
 * `details` is typed `JsonValue` upstream, so the call records are copied into
 * plain shapes rather than passed through as class instances — a panel reading
 * `record.durationMs` needs the number to be there after a structured clone.
 */
function detailsOf(result: CodemodeResult): JsonObject {
	const calls: JsonValue[] = result.calls.map((call: CodemodeCall) => ({
		name: call.name,
		status: call.status,
		durationMs: Math.round(call.durationMs),
	}));
	if (!result.ok) {
		return {
			ok: false,
			calls,
			error: { kind: result.error.kind, message: result.error.message, name: result.error.name ?? "", stack: result.error.stack ?? "" },
		};
	}
	return {
		ok: true,
		calls,
		storeWrites: { set: result.storeWrites.set as JsonObject, delete: [...result.storeWrites.delete] },
	};
}
