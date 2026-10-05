import type { Models, ModelType, ModelTypeMap } from "@earendil-works/pi-ai";
import { resolveModelChoice, type ModelResolutionSource } from "../settings";
import { delegateModels } from "./delegateModels";

/**
 * Native Harness references use the stable configuration-row id as modelId.
 * The resolved Model keeps its API id for provider dispatch. Two rows may share
 * an API id while declaring different capabilities; never resolve by API id.
 *
 * Scope this view to Harness: chat lookups use configuration ids. Listing and
 * availability methods still expose the underlying API catalog, not a second
 * configuration-row catalog. Other model types retain their API-id lookup.
 * Resolution reads current settings, including after reopening a checkpoint;
 * the native checkpoint stores a reference, not a historical Model snapshot.
 * Request defaults, auth and transport remain owned by the wrapped Models.
 */
export function withNativeModelLookup(getModels: () => Models, getSettings: () => ModelResolutionSource): Models {
	const getModel: Models["getModel"] = (provider, choiceId) => {
		const model = resolveModelChoice(getSettings(), choiceId);
		return model?.provider === provider ? model : undefined;
	};
	return {
		...delegateModels(getModels),
		getModel,
		getModelOfType: <T extends ModelType>(type: T, provider: string, id: string): ModelTypeMap[T] | undefined => {
			// TypeScript does not narrow a generic type parameter with this check.
			if (type === "chat") return getModel(provider, id) as ModelTypeMap[T] | undefined;
			return getModels().getModelOfType(type, provider, id);
		},
	};
}
