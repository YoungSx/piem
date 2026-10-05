import type { Models } from "@earendil-works/pi-ai";

/** Preserve the complete public interface and receiver of Pi's class instance. */
export function delegateModels(getModels: () => Models): Models {
	return {
		getProviders: () => getModels().getProviders(),
		getProvider: id => getModels().getProvider(id),
		getModels: provider => getModels().getModels(provider),
		getModel: (provider, id) => getModels().getModel(provider, id),
		getModelsOfType: (type, provider) => getModels().getModelsOfType(type, provider),
		getModelOfType: (type, provider, id) => getModels().getModelOfType(type, provider, id),
		getAllModels: provider => getModels().getAllModels(provider),
		refresh: options => getModels().refresh(options),
		checkAuth: (provider, options) => getModels().checkAuth(provider, options),
		getAvailable: (provider, options) => getModels().getAvailable(provider, options),
		getAvailableOfType: (type, provider, options) => getModels().getAvailableOfType(type, provider, options),
		getAllAvailable: (provider, options) => getModels().getAllAvailable(provider, options),
		getAuth: (model, options) => typeof model === "string" ? getModels().getAuth(model, options) : getModels().getAuth(model, options),
		login: (provider, type, interaction, options) => getModels().login(provider, type, interaction, options),
		logout: (provider, options) => getModels().logout(provider, options),
		stream: (model, context, options) => getModels().stream(model, context, options),
		complete: (model, context, options) => getModels().complete(model, context, options),
		streamSimple: (model, context, options) => getModels().streamSimple(model, context, options),
		completeSimple: (model, context, options) => getModels().completeSimple(model, context, options),
		streamDeferred: (model, handle, options) => getModels().streamDeferred(model, handle, options),
		fetchDeferred: (model, handle, options) => getModels().fetchDeferred(model, handle, options),
		cancelDeferred: (model, handle, options) => getModels().cancelDeferred(model, handle, options),
		generateImages: (model, context, options) => getModels().generateImages(model, context, options),
		classify: (model, context, options) => getModels().classify(model, context, options),
	};
}
