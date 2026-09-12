import { Notice, TFile, TFolder, type App } from "obsidian";
import type { ObsidianAgentService } from "../agent/ObsidianAgentService";
import { MAX_CONTEXT_REFERENCES, parseContextReferences, type ContextReference } from "../agent/contextReference";
import type { Translator } from "../i18n";
import type { PrefillResult } from "./ChatInputController";

export interface ContextRequest {
	paths?: readonly string[];
	text?: string;
	references?: readonly ContextReference[];
}

/** One delivery path; staging a card never sends or pins content behind the user's back. */
export async function deliverContextRequest(
	request: ContextRequest,
	app: App,
	service: ObsidianAgentService,
	openView: () => Promise<{ prefillComposer(text: string, session?: string, references?: readonly ContextReference[]): Promise<PrefillResult>; focusInput(): void } | null>,
	t: Translator,
): Promise<void> {
	try {
		const [session, view] = await Promise.all([service.prepareContextTarget(), openView()]);
		if (!session) { new Notice(t.t("noteReference.unavailable")); return; }
		if (!view) { new Notice(t.t("commands.couldNotOpenChat")); return; }
		const references: ContextReference[] = [...(request.references ?? [])];
		let missing = 0;
		for (const path of new Set(request.paths ?? [])) {
			const file = app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) references.push({ kind: "file", path: file.path });
			else if (file instanceof TFolder) references.push({ kind: "folder", path: file.path === "/" ? "." : file.path });
			else missing++;
		}
		const valid = parseContextReferences(references);
		if (!valid) { new Notice(t.t("noteReference.referenceLimit", { limit: MAX_CONTEXT_REFERENCES })); return; }
		const owner = service.getSnapshot().session;
		if (owner?.path !== session || service.getSnapshot().isOpeningSession) { new Notice(t.t("noteReference.selectionChanged")); return; }
		if (!valid.length && !request.text) { new Notice(t.t("noteReference.missing")); return; }
		const outcome = await view.prefillComposer(request.text ?? "", owner.id, valid);
		if (outcome === true) await service.persistContextDraft(session);
		if (service.getSnapshot().session?.path !== session) { new Notice(t.t("noteReference.selectionChanged")); return; }
		if (missing) new Notice(t.t("noteReference.missingCount", { count: missing }));
		if (outcome === false) new Notice(t.t("noteReference.unavailable"));
		if (outcome === true) view.focusInput();
	} catch { new Notice(t.t("noteReference.unavailable")); }
}
