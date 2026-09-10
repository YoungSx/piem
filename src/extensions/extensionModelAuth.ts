import type { AssistantMessage, Context, Model, ModelsApiStreamOptions, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionLifetime, ExtensionScope } from "./extensionLifetime";

type Complete = (model: Model<string>, context: Context, options: ModelsApiStreamOptions<string>) => Promise<AssistantMessage>;
type Auth = { ok: true; apiKey: string; headers: ProviderHeaders } | { ok: false; error: string };

/** Retained successful callbacks are bounded too; Stop releases every credential. */
export const EXTENSION_AUTH_CAPABILITY_LIMIT = 128;
const MODEL_REQUIRED = "Extension model must name one configured, unambiguous model with credentials.";
const AUTH_REQUIRED = "Extension completion requires a current modelRegistry auth capability.";

interface Credential {
	key: string;
	provider: string;
	id: string;
	scope: ExtensionScope;
	complete: Complete;
	revoke: () => void;
}

// A capability selects its owning conversation, never a process-wide current
// host. The owning host and captured scope remove their entries on cancellation.
const credentials = new Map<string, Credential>();
const modelOwners = new WeakMap<object, object>();
const headerOwners = new WeakMap<object, object>();

function assertOwner(owners: WeakMap<object, object>, value: object, owner: object): void {
	const known = owners.get(value);
	if (known && known !== owner) throw new Error("Extension model credentials belong to another conversation.");
}

function modelIdentity(model: Model<string>): { provider: string; id: string } {
	if (!model || typeof model !== "object") throw new Error(MODEL_REQUIRED);
	const { provider, id } = model;
	if (typeof provider !== "string" || typeof id !== "string") throw new Error(MODEL_REQUIRED);
	return { provider, id };
}

function requestSnapshot(request: ModelsApiStreamOptions<string>): ModelsApiStreamOptions<string> {
	if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Extension model options must be an object.");
	return { ...request };
}

/** The only runtime export used by the pi-ai compatibility entrypoint. */
export async function completeExtensionModel(model: Model<string>, context: Context, request: ModelsApiStreamOptions<string> = {}): Promise<AssistantMessage> {
	const snapshot = requestSnapshot(request);
	const credential = typeof snapshot.apiKey === "string" ? credentials.get(snapshot.apiKey) : undefined;
	if (!credential) throw new Error(AUTH_REQUIRED);
	return credential.complete(model, context, snapshot);
}

/** An auth-shaped, revocable capability; real provider keys and headers stay in the host. */
export function createExtensionModelAuth(options: {
	lifetime: ExtensionLifetime;
	resolve(provider: string, id: string): Model<string> | undefined;
	complete: Complete;
	assertCanComplete(): void;
}) {
	const owner = {};
	const issued = new Set<Credential>();
	const revoke = (): void => { for (const credential of issued) credential.revoke(); };
	// Includes credentials retained after a successful callback has left its run.
	options.lifetime.capture().signal.addEventListener("abort", revoke, { once: true });
	const issue = (model: Model<string>): Credential | undefined => {
		options.assertCanComplete();
		const { provider, id } = modelIdentity(model);
		assertOwner(modelOwners, model, owner);
		const scope = options.lifetime.capture();
		scope.assertActive();
		if (!options.resolve(provider, id)) return undefined;
		const cached = [...issued].find(item => item.scope === scope && item.provider === provider && item.id === id);
		if (cached) return cached;
		if (issued.size >= EXTENSION_AUTH_CAPABILITY_LIMIT) throw new Error(`At most ${EXTENSION_AUTH_CAPABILITY_LIMIT} extension model auth capabilities may be retained per conversation; Stop clears them.`);
		const key = `piem-extension:${crypto.randomUUID()}`;
		const credential: Credential = {
			key, provider, id, scope,
			revoke: () => {
				credentials.delete(key);
				issued.delete(credential);
				scope.signal.removeEventListener("abort", credential.revoke);
			},
			complete: (requested, context, request) => {
				options.assertCanComplete();
				scope.assertActive();
				if (credentials.get(key) !== credential) throw new Error(AUTH_REQUIRED);
				const identity = modelIdentity(requested);
				assertOwner(modelOwners, requested, owner);
				if (identity.provider !== provider || identity.id !== id) throw new Error("Extension model credentials belong to another model.");
				if (request.headers !== undefined) {
					const headers = request.headers;
					if (!headers || typeof headers !== "object" || Array.isArray(headers) || Reflect.ownKeys(headers).length
						|| (Object.getPrototypeOf(headers) !== Object.prototype && Object.getPrototypeOf(headers) !== null)) {
						throw new Error("Extension completion only accepts unchanged modelRegistry auth headers.");
					}
					assertOwner(headerOwners, headers, owner);
				}
				const forwarded = { ...request };
				delete forwarded.apiKey;
				delete forwarded.headers;
				const authoritative = options.resolve(provider, id);
				if (!authoritative) throw new Error(MODEL_REQUIRED);
				// Re-enter this exact callback's lease even after its first await.
				return options.lifetime.withScope(scope, () => options.complete(authoritative, context, forwarded));
			},
		};
		issued.add(credential);
		credentials.set(key, credential);
		scope.signal.addEventListener("abort", credential.revoke, { once: true });
		return credential;
	};
	return {
		bindModel: (model: Model<string>): Model<string> => { modelOwners.set(model, owner); return model; },
		getApiKey: async (model: Model<string>): Promise<string | undefined> => issue(model)?.key,
		getApiKeyAndHeaders: async (model: Model<string>): Promise<Auth> => {
			const credential = issue(model);
			if (!credential) return { ok: false, error: MODEL_REQUIRED };
			const headers: ProviderHeaders = Object.freeze({});
			headerOwners.set(headers, owner);
			return { ok: true, apiKey: credential.key, headers };
		},
		revoke,
	};
}
