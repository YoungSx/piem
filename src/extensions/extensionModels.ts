import type { AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import { abortable, linkedAbortSignal, type ExtensionLifetime } from "./extensionLifetime";
import { createExtensionModelAuth } from "./extensionModelAuth";
import { unavailable } from "./node/unavailable";

export type ExtensionComplete = (model: Model<string>, context: Context, options: ModelsApiStreamOptions<string>) => Promise<AssistantMessage>;

/** Per-session limits cover extensions accidentally firing duplicate requests. */
export const EXTENSION_COMPLETION_LIMIT = 2;
export const EXTENSION_COMPLETION_TIMEOUT_MS = 60_000;
/** Only used when a configured model does not declare a usable output limit. */
export const EXTENSION_COMPLETION_DEFAULT_MAX_TOKENS = 4_096;

/** Unknown provider options can contain routing, callbacks or credentials. */
const ALLOWED_OPTIONS = new Set(["signal", "maxTokens", "temperature", "reasoningEffort", "cacheRetention", "sessionId", "toolChoice"]);

function validatedOptions(request: ModelsApiStreamOptions<string>, model: Model<string>): ModelsApiStreamOptions<string> {
	if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Extension model options must be an object.");
	// Snapshot once: mutation after validation must not introduce an override before
	// the queued transport begins. Inherited fields are never forwarded.
	const snapshot = { ...request };
	for (const key of Reflect.ownKeys(snapshot)) {
		if (typeof key !== "string" || !ALLOWED_OPTIONS.has(key)) unavailable(`extension model option ${String(key)}`);
	}
	const maxTokens = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : EXTENSION_COMPLETION_DEFAULT_MAX_TOKENS;
	if (snapshot.maxTokens !== undefined && (!Number.isSafeInteger(snapshot.maxTokens) || snapshot.maxTokens < 1 || snapshot.maxTokens > maxTokens)) {
		throw new Error(`Extension maxTokens must be an integer between 1 and ${maxTokens}.`);
	}
	snapshot.maxTokens ??= maxTokens;
	if (snapshot.temperature !== undefined && (!Number.isFinite(snapshot.temperature) || snapshot.temperature < 0 || snapshot.temperature > 2)) {
		throw new Error("Extension temperature must be between 0 and 2.");
	}
	for (const [key, allowed] of [
		["toolChoice", ["auto", "none", "any", "required"]],
		["reasoningEffort", ["none", "minimal", "low", "medium", "high", "xhigh", "max"]],
		["cacheRetention", ["none", "short", "long"]],
	] as const) {
		const value = snapshot[key];
		if (value !== undefined && (typeof value !== "string" || !allowed.some(option => option === value))) {
			throw new Error(`Unsupported extension ${key}.`);
		}
	}
	if (snapshot.sessionId !== undefined && (typeof snapshot.sessionId !== "string" || /[\r\n]/.test(snapshot.sessionId))) {
		throw new Error("Extension sessionId must be a string without line breaks.");
	}
	if (snapshot.signal !== undefined && !(snapshot.signal instanceof AbortSignal)) throw new Error("Extension signal must be an AbortSignal.");
	return snapshot;
}

/** Models can carry authentication headers; extensions only receive metadata. */
export function extensionModelSnapshot(model: Model<string>): Model<string> {
	const snapshot = structuredClone(model);
	delete snapshot.headers;
	return snapshot;
}

/** The authoritative model is resolved again; an extension's model is only an ID. */
export function createExtensionModels(options: {
	lifetime: ExtensionLifetime;
	getModels(): Model<string>[];
	complete: ExtensionComplete;
	assertAvailable(): void;
	assertCanComplete?(): void;
}) {
	let pending = 0;
	const configured = () => { options.assertAvailable(); return options.getModels(); };
	const resolve = (provider: string, id: string) => {
		const matches = configured().filter(model => model.provider === provider && model.id === id);
		return matches.length === 1 ? matches[0] : undefined;
	};
	const assertCanComplete = () => {
		if (options.assertCanComplete) options.assertCanComplete();
		else options.assertAvailable();
	};
	const complete = (requested: Model<string>, context: Context, request: ModelsApiStreamOptions<string> = {}): Promise<AssistantMessage> => options.lifetime.run(async scope => {
		assertCanComplete();
		const authoritative = resolve(requested.provider, requested.id);
		if (!authoritative) throw new Error("Extension model must name one configured, unambiguous model with credentials.");
		const model = structuredClone(authoritative);
		const snapshot = validatedOptions(request, model);
		if (pending >= EXTENSION_COMPLETION_LIMIT) throw new Error(`At most ${EXTENSION_COMPLETION_LIMIT} extension model requests may run per conversation.`);
		const timeout = new AbortController();
		const signal = linkedAbortSignal(scope.signal, snapshot.signal, timeout.signal);
		const timer = window.setTimeout(() => timeout.abort(), EXTENSION_COMPLETION_TIMEOUT_MS);
		try {
			if (signal.signal.aborted) throw new DOMException("Extension model request was cancelled.", "AbortError");
			const copiedContext = structuredClone(context);
			pending++;
			// Releasing the caller is not proof the transport stopped. Obsidian's
			// requestUrl may finish later; keep its slot until the real work settles.
			const work = Promise.resolve().then(() => {
				if (signal.signal.aborted) throw new DOMException("Extension model request was cancelled.", "AbortError");
				return options.complete(model, copiedContext, { ...snapshot, signal: signal.signal });
			});
			void work.then(() => { pending--; }, () => { pending--; });
			const result = await abortable(work, signal.signal);
			scope.assertActive();
			return result;
		} finally {
			window.clearTimeout(timer);
			signal.dispose();
		}
	});
	const auth = createExtensionModelAuth({ lifetime: options.lifetime, resolve, complete, assertCanComplete });
	const snapshot = (model: Model<string>) => auth.bindModel(extensionModelSnapshot(model));
	const available = () => configured().map(snapshot);
	const find = (provider: string, id: string) => {
		const model = resolve(provider, id);
		return model && snapshot(model);
	};
	return {
		getAvailable: available,
		getAll: available,
		find,
		hasConfiguredAuth: (model: Model<string>) => Boolean(find(model.provider, model.id)),
		complete,
		getApiKey: auth.getApiKey,
		getApiKeyAndHeaders: auth.getApiKeyAndHeaders,
		// Host-only hooks; these must not become modelRegistry methods.
		snapshot,
		revokeAuth: auth.revoke,
	};
}
