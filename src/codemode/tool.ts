/** Model-facing browser adapter over Pi's parser, declarations and VM prelude. */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { CodemodeJsonSchema, CodemodeStoreWrites } from "@earendil-works/pi-codemode";
import { MCP_TYPESCRIPT_PREAMBLE, mcpStructuredContentSchema, renderDeclarations, renderToolSample } from "@earendil-works/pi-codemode/declarations";
import { CODEMODE_SOURCE_GRAMMAR, parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { Type } from "typebox";
import { CodemodeSandbox, DEFAULT_MEMORY_LIMIT_BYTES, DEFAULT_TIMEOUT_MS, type BrowserSandboxOptions } from "./sandbox";
import { ScriptOutput } from "./output";
import type { SandboxTool } from "./types";

export const DEFAULT_INLINE_BUDGET = 3000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_ALLOWED_OUTPUT_TOKENS = 50_000;

export type CodemodeMode = "on" | "only";

export interface CodemodeToolHost {
	tools(): readonly AgentTool[];
	/** Uses Pi's runToolCall, including validation and extension hooks. */
	executeTool(name: string, args: JsonObject, signal: AbortSignal): Promise<AgentToolResult>;
	/** Both operations belong to the captured conversation's current branch. */
	readStore?(): Promise<Record<string, unknown>>;
	writeStore?(writes: CodemodeStoreWrites): Promise<void>;
}

interface CodemodeOptions extends Pick<BrowserSandboxOptions, "wasm" | "workerSource" | "memoryLimitBytes" | "timeoutMs"> {
	inlineBudget?: number;
	maxOutputTokens?: number;
	mode?: CodemodeMode;
}

const codemodeSchema = Type.Object({ code: Type.String({ description: "JavaScript with top-level await and return; optionally starts with // @options: {...}." }) });

/** Match Pi: only a declared outputSchema makes structuredContent script-visible. */
function declaration(tool: AgentTool) {
	return { name: tool.name, description: tool.description, inputSchema: tool.parameters as CodemodeJsonSchema, outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" } };
}

export function codemodeSample(tool: AgentTool): string {
	return renderToolSample(declaration(tool));
}

function scriptTools(host: CodemodeToolHost): SandboxTool[] {
	const seen = new Set<string>();
	return host.tools().filter(tool => {
		if (tool.name === "codemode" || seen.has(tool.name)) return false;
		seen.add(tool.name);
		return true;
	}).map(tool => ({
		...declaration(tool),
		sequential: tool.executionMode === "sequential",
		execute: async (args, { signal }) => {
			const result = await host.executeTool(tool.name, (args ?? {}) as JsonObject, signal);
			if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
			const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			if (result.isError) throw new Error(text || `Tool "${tool.name}" failed`);
			return text;
		},
	}));
}

/** Whole declarations only. Omitted tools remain discoverable inside the script. */
function renderToolDeclarations(tools: readonly SandboxTool[], budget: number): string {
	if (!tools.length) return "No tools are available to scripts in this session.";
	const full = renderDeclarations({ tools });
	if (Math.ceil(full.length / 4) <= budget) return full;
	const kept: SandboxTool[] = [];
	let rendered = "";
	for (const tool of tools) {
		const candidate = renderDeclarations({ tools: [...kept, tool] });
		if (Math.ceil(candidate.length / 4) > budget) continue;
		kept.push(tool);
		rendered = candidate;
	}
	const hidden = tools.length - kept.length;
	return `${rendered}\n// ${hidden} more tool${hidden === 1 ? " is" : "s are"} not listed here (description budget reached). Use ALL_TOOLS.filter(...) in the script to discover ${hidden === 1 ? "it" : "them"}, then call through tools[name].`;
}

const DEFAULT_DEADLINE_MINUTES = DEFAULT_TIMEOUT_MS / 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The host dial's share of the parser's contract: a positive integer up to `setTimeout`'s own limit. */
function validTimeout(ms: number | undefined): number | undefined {
	return typeof ms === "number" && Number.isInteger(ms) && ms > 0 && ms <= MAX_TIMEOUT_MS ? ms : undefined;
}
const USAGE = `Run JavaScript that calls tools as \`await tools.<name>(args)\`. Results the script
reads stay inside it — only text(), console output, image(), and the return value
reach this conversation. Each call runs in its own VM, as an async function body.
There is no Node, file system, network access, or timer inside the VM.

Use text(value) or console.log(value) to print; image(dataUrlOrImageContent) to
forward a base64 image; exit() to finish early. Await every call you need: pending
calls are cancelled when the script ends. Calls have real side effects; a later
failure does not undo earlier calls. Failed calls reject, except structured tool
results such as MCP CallToolResult: inspect their isError field.

Discover tools and parameter declarations with
\`text(ALL_TOOLS.filter(t => /keyword/i.test(t.name + " " + t.description)));\`
Then call \`await tools[name](args)\` inside the script.

A first line of \`// @options: {"timeout_ms": 900000, "max_output_tokens": 10000}\`
sets the deadline and output budget. The default deadline is ${DEFAULT_DEADLINE_MINUTES} minutes, with no
maximum of ours — ask for what your script needs, up to setTimeout's own limit
of ${MAX_TIMEOUT_MS}. It bounds the whole script and counts
time spent awaiting tool calls, so budget for the tools you call: a chain of slow
ones needs a larger number, not a faster script. The VM heap is ${DEFAULT_MEMORY_LIMIT_BYTES / 1024 / 1024} MiB.
max_output_tokens (default 10000, maximum 50000) caps printed text, return values
and errors together; truncated text keeps its beginning and end. Images are
preserved. Full output is not saved outside the vault; filter large results before
printing them.`;

/** capture() pins the session before the first await, including nested calls. */
export function createCodemodeTool(capture: () => CodemodeToolHost, options: CodemodeOptions = {}): AgentTool<typeof codemodeSchema> {
	return {
		name: "codemode",
		label: "Codemode",
		executionMode: "sequential",
		parameters: codemodeSchema,
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		get description() {
			const host = capture();
			const tools = scriptTools(host);
			const only = options.mode === "only";
			const scope = only ? "`codemode` is the only callable tool. Every other tool named in the prompt, skills, history, or catalog must be called inside its JavaScript via `tools`; never emit a direct tool call to those names.\n\n" : "";
			const store = host.readStore && host.writeStore
				? "store(key, value) and load(key) keep JSON values across calls on this conversation branch. Successful scripts commit writes; storing undefined deletes a key."
				: "No session store is attached: store()/load() values last only within this call.";
			const catalog = only || !tools.length ? renderToolDeclarations(tools, options.inlineBudget ?? DEFAULT_INLINE_BUDGET)
				: "Every tool above can also be reached from inside a script. ALL_TOOLS lists them.";
			const mcpTypes = tools.some(tool => mcpStructuredContentSchema(tool.outputSchema) !== undefined)
				? `\n\nShared MCP types:\n${MCP_TYPESCRIPT_PREAMBLE}` : "";
			return `${scope}${USAGE}\n\n${store}${mcpTypes}\n\n${catalog}`;
		},
		execute: async (_id, params, signal) => {
			const host = capture();
			let source;
			try { source = parseCodemodeSource(params.code); }
			catch (error) { return { content: [{ type: "text", text: `Script error: ${String(error)}` }], details: undefined, isError: true }; }
			const output = new ScriptOutput(Math.min(source.options.maxOutputTokens ?? options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, MAX_ALLOWED_OUTPUT_TOKENS));
			const sandbox = new CodemodeSandbox({
				tools: scriptTools(host), wasm: options.wasm, workerSource: options.workerSource,
				memoryLimitBytes: options.memoryLimitBytes,
				// No ceiling on `timeout_ms`, deliberately: there was one — 600_000 —
				// and it was ours, not pi's (pi caps at `setTimeout`'s own limit in
				// both codemode and bash, which is to say it does not cap it). It sat
				// underneath every per-tool dial that is already the model's to turn,
				// and {@link DEFAULT_TIMEOUT_MS} remains the backstop for a script
				// that asks for nothing. The script rung is bounded by pi's parser
				// (positive integer up to `setTimeout`'s 2147483647); the host rung
				// gets no such check, so `validTimeout` makes it here. `??` would be
				// wrong twice over: a host's 0 is a real value that would arm a
				// first-tick kill, and NaN fails Number.isFinite and would silently
				// arm no deadline at all.
				timeoutMs: source.options.timeoutMs ?? validTimeout(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
				onOutput: item => output.push(item),
			});
			try {
				const store = await host.readStore?.();
				const result = await sandbox.execute(source.code, { signal, store });
				if (result.ok) {
					if (Object.keys(result.storeWrites.set).length || result.storeWrites.delete.length) {
						signal?.throwIfAborted();
						await host.writeStore?.(result.storeWrites);
					}
					if (result.value !== undefined) output.push({ type: "text", text: typeof result.value === "string" ? result.value : JSON.stringify(result.value) });
				} else {
					const calls = result.calls.map(call => `${call.name} (${call.status})`).join(", ");
					// The prefix is the first thing a model reads, and "Script error"
					// is a verdict the sandbox did not reach for a timeout or an
					// abort: the script did nothing wrong, the budget ran out or the
					// caller stopped it. Sending it hunting for a bug in its own loop
					// is the confusion the timeout message was rewritten to prevent.
					const verdict = result.error.kind === "timeout" || result.error.kind === "aborted" ? "Script stopped" : "Script error";
					const label = result.error.kind === "timeout" || result.error.kind === "aborted" ? "Tool calls already made (they are not undone)" : "Tool calls made before the failure (they are not undone)";
					output.push({ type: "text", text: `${verdict}: ${result.error.stack ?? result.error.message}\n\n${label}: ${calls || "none"}.` });
				}
				return {
					content: output.content(),
					details: { ok: result.ok, calls: result.calls.map(call => ({ ...call, durationMs: Math.round(call.durationMs) })) },
					isError: !result.ok,
				};
			} finally { await sandbox.close(); }
		},
	};
}
