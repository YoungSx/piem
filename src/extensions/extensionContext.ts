import type { Extension } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionRunner } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import type { ExtensionLifetime, ExtensionScope } from "./extensionLifetime";

/** Guard both an object read and methods retained from it across an await. */
function scopedObject<T extends object>(object: T, scope: ExtensionScope, lifetime: ExtensionLifetime): T {
	return new Proxy(object, {
		get(target, key, receiver): unknown {
			scope.assertActive();
			const value: unknown = Reflect.get(target, key, receiver);
			return typeof value === "function"
				? (...args: unknown[]): unknown => lifetime.withScope(scope, (): unknown => Reflect.apply(value, target, args))
				: value;
		},
	});
}

interface ContextReads {
	hasUI(): boolean;
	getThinkingLevel(): ThinkingLevel;
}

function scopedContext<T extends object>(original: T, scope: ExtensionScope, lifetime: ExtensionLifetime, reads: ContextReads): T {
	const descriptors = Object.getOwnPropertyDescriptors(original);
	for (const key of Object.keys(descriptors)) {
		const writable = descriptors[key]?.writable;
		let replacement: unknown;
		Object.defineProperty(descriptors, key, { enumerable: true, value: {
			enumerable: true, configurable: true,
			...(writable ? { set: (value: unknown) => { scope.assertActive(); replacement = value; } } : {}),
			get: () => {
				scope.assertActive();
				if (key === "hasUI") return reads.hasUI();
				// Runtime actions are retired before shutdown cleanup; metadata is
				// still readable through the host's authoritative read callback.
				if (key === "thinkingLevel") return reads.getThinkingLevel();
				const value: unknown = replacement ?? lifetime.withScope(scope, (): unknown => Reflect.get(original, key));
				if (key === "ui" || key === "sessionManager" || key === "modelRegistry") {
					if (!value || typeof value !== "object") throw new Error(`Missing extension ${key}.`);
					return scopedObject(value, scope, lifetime);
				}
				if (typeof value === "function") return (...args: unknown[]): unknown => {
					scope.assertActive();
					return lifetime.withScope(scope, (): unknown => Reflect.apply(value, original, args));
				};
				return value;
			},
		} });
	}
	return Object.defineProperties({}, descriptors) as T;
}

/**
 * Runner still dispatches and chains results. It shares one context per event,
 * so attach the dispatch lease there and give each actual callback its own
 * lease. A completed callback then survives cancellation of a later handler.
 */
export function bindScopedContexts(runner: ExtensionRunner, lifetime: ExtensionLifetime, reads: ContextReads, extensions: Extension[]): void {
	const owner = Symbol("extension dispatch scope");
	const createContext = runner.createContext.bind(runner);
	runner.createContext = () => {
		const original = createContext();
		// Runner copies descriptors for before_agent_start and command contexts.
		return Object.defineProperty(original, owner, { value: lifetime.capture() });
	};
	const invoke = <C extends object, T>(context: C, work: (ctx: C) => Promise<T>): Promise<T> => {
		const dispatch = Reflect.get(context, owner) as ExtensionScope;
		return lifetime.withScope(dispatch, () => lifetime.run(async scope => work(scopedContext(context, scope, lifetime, reads))));
	};
	for (const extension of extensions) {
		for (const [event, handlers] of extension.handlers) {
			extension.handlers.set(event, handlers.map(handler => (...args: unknown[]) => {
				const context = args[1];
				if (!context || typeof context !== "object") throw new Error("Missing extension handler context.");
				return invoke(context, ctx => handler(args[0], ctx, ...args.slice(2)));
			}));
		}
		for (const command of extension.commands.values()) {
			const handler = command.handler;
			command.handler = (args, ctx) => invoke(ctx, scoped => handler(args, scoped));
		}
		for (const { definition } of extension.tools.values()) {
			const execute = definition.execute.bind(definition);
			definition.execute = (id, params, signal, onUpdate, ctx) => invoke(ctx, scoped => execute(id, params, signal, onUpdate, scoped));
		}
	}
}
