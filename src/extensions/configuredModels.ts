import type { Model } from "@earendil-works/pi-ai";
import { getApiKeyForProvider, resolveModelChoice, type PiemSettings } from "../settings";

/** Only configured, credentialed models enter the extension's registry. Keys never do. */
export function configuredModels(settings: PiemSettings): Array<{ choiceId: string; model: Model<string> }> {
	const choices: Array<{ choiceId: string; model: Model<string> }> = [];
	for (const row of settings.models) {
		const model = resolveModelChoice(settings, row.id);
		if (model && getApiKeyForProvider(settings, model.provider)) choices.push({ choiceId: row.id, model });
	}
	// Pi identifies models by provider/id. If settings contain that pair twice,
	// neither row is a safe switch target: choosing the first would hide a decision.
	return choices.filter(({ model }) => choices.filter(other => other.model.provider === model.provider && other.model.id === model.id).length === 1);
}
