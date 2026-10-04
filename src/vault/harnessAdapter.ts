import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AgentTool, AgentToolResult, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { detectSupportedImageMimeType } from "../../node_modules/@earendil-works/pi-durable/dist/tools/image.js";
import type { TSchema } from "typebox";
import type { App } from "obsidian";
import { VaultExecutionEnv } from "./VaultExecutionEnv";
import { arrayBufferToBase64 } from "./image";

/** The original durable file tools use only api.env; no task runtime is emulated. */
export function adaptHarnessTool<TParameters extends TSchema, TDetails extends JsonValue>(
	tool: ToolRegistration<TParameters, TDetails>,
	options: { context: { env: ExecutionEnv } | (() => { env: ExecutionEnv } | Promise<{ env: ExecutionEnv }>); executionMode?: ToolExecutionMode },
): AgentTool<TParameters, TDetails | undefined> {
	if (!["read", "write", "edit"].includes(tool.name)) throw new Error(`Not a Pi file tool: ${tool.name}`);
	return {
		...tool,
		label: tool.name,
		replay: tool.replay === "safe" ? "safe" : "never",
		executionMode: options.executionMode ?? tool.executionMode,
		execute: async (_id, args, signal): Promise<AgentToolResult<TDetails | undefined>> => {
			const { env } = typeof options.context === "function" ? await options.context() : options.context;
			const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
			// The audited read/write/edit implementations access only this capability.
			const api = { env } as ToolExecutionApi<TDetails>;
			const result = await tool.execute(args, api, context);
			if (result.isError && tool.name === "read" && result.diagnostics?.some(item => item.code === "unsupported_image")) {
				const path = (args as { path: string }).path;
				const bytes = getOrThrow(await env.readBinaryFile(path, context));
				const mimeType = detectSupportedImageMimeType(bytes);
				if (mimeType) return { content: [{ type: "image", mimeType, data: arrayBufferToBase64(bytes.slice().buffer) }], details: undefined };
			}
			if (result.isError) throw new Error(result.diagnostics?.map(item => item.message).join("\n") || "Pi file tool failed");
			const content = [...(result.content ?? [])];
			if (result.diagnostics?.length) content.push({ type: "text", text: result.diagnostics.map(item => `[${item.message}]`).join("\n") });
			return { content, details: result.details };
		},
	};
}

export function createVaultHarnessContext(app: App): { env: VaultExecutionEnv } { return { env: new VaultExecutionEnv(app) }; }
export function createNativeFileTools(app: App, factories: { read: () => ToolRegistration; write: () => ToolRegistration; edit: () => ToolRegistration }): AgentTool[] {
	const context = createVaultHarnessContext(app);
	return [adaptHarnessTool(factories.read(), { context }), adaptHarnessTool(factories.write(), { context, executionMode: "sequential" }), adaptHarnessTool(factories.edit(), { context, executionMode: "sequential" })];
}
