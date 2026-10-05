import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Host bridge for tools without structured-output or batch-termination contracts.
 * Legacy content updates are replacement snapshots, not native output chunks:
 * progress lives in a replacing piemProgress details envelope. Native UI consumers
 * must recognize that envelope; final details replace it (undefined becomes null).
 */
export function nativeTool<T extends TSchema, D extends JsonValue | undefined>(tool: AgentTool<T, D>): ToolRegistration<T> {
	if (tool.outputSchema) throw new Error(`Native tool ${tool.name} does not support outputSchema yet`);
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		replay: tool.replay === "safe" ? "safe" : "unsafe",
		async execute(args, api, context) {
			const cancellation = new AbortController();
			const forwardAbort = () => cancellation.abort(context.abortSignal?.reason);
			context.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
			if (context.abortSignal?.aborted) forwardAbort();
			let active = true, failed = false, executionFailed = false;
			let failure: unknown, executionError: unknown;
			let next: JsonValue | undefined;
			let pending: Promise<void> | undefined;
			let result!: AgentToolResult<D>;
			const fail = (error: unknown) => {
				if (!failed) { failed = true; failure = error; }
				cancellation.abort(error);
			};
			const drain = async () => {
				try {
					while (next !== undefined && !cancellation.signal.aborted) {
						const value = next;
						next = undefined;
						await api.details(value, context);
					}
				} catch (error) { fail(error); }
				finally { pending = undefined; }
			};
			try {
				cancellation.signal.throwIfAborted();
				result = await tool.execute(api.callId, args, cancellation.signal, update => {
					if (!active || cancellation.signal.aborted) return;
					try {
						// One in-flight write plus the latest replacement; no unbounded promise queue.
						next = copyJson({ piemProgress: { content: update.content, details: update.details ?? null } }, { omitUndefinedProperties: true });
						pending ??= drain();
					} catch (error) { fail(error); }
				});
			} catch (error) { executionFailed = true; executionError = error; }
			finally {
				active = false;
				await pending;
				context.abortSignal?.removeEventListener("abort", forwardAbort);
			}
			if (failed) throw failure;
			if (executionFailed) throw executionError;
			cancellation.signal.throwIfAborted();
			if (result.structuredContent !== undefined || result.terminate === true) {
				return {
					content: [...result.content, { type: "text" as const, text: `Tool ${tool.name} already executed, but its structuredContent or batch termination contract is not supported by the native bridge. Do not retry this operation.` }],
					details: result.details ?? null, isError: true, usage: result.usage,
				};
			}
			return { content: result.content, details: result.details ?? null, isError: result.isError, usage: result.usage };
		},
	};
}
