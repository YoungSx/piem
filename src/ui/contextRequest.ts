import { Notice, TFile, TFolder, type App } from "obsidian";
import type { ObsidianAgentService } from "../agent/ObsidianAgentService";
import { MAX_PINNED_REFS } from "../agent/contextRefs";
import type { Translator } from "../i18n";
import type { PrefillResult } from "./ChatInputController";

export interface ContextRequest {
	paths?: readonly string[];
	text?: string;
}

/** One delivery path for menus and editor commands, including a closed, cold panel. */
export async function deliverContextRequest(
	request: ContextRequest,
	app: App,
	service: ObsidianAgentService,
	openView: () => Promise<{ prefillComposer(text: string, session?: string): Promise<PrefillResult>; focusInput(): void } | null>,
	t: Translator,
): Promise<void> {
	try {
		const [session, view] = await Promise.all([service.prepareContextTarget(), openView()]);
		if (!session) {
			new Notice(t.t("noteReference.unavailable"));
			return;
		}
		if (!view) { new Notice(t.t("commands.couldNotOpenChat")); return; }
		const files: string[] = [];
		const references: string[] = [];
		let missing = 0;
		const paths = [...new Set(request.paths ?? [])];
		for (const path of paths) {
			const file = app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) files.push(file.path);
			else if (file instanceof TFolder) references.push(t.t("noteReference.folder", { path: JSON.stringify(file.path === "/" ? "." : file.path) }));
			else missing++;
		}
		const pinned = service.pinContextRefs(files, session);
		if (!pinned) { new Notice(t.t("noteReference.selectionChanged")); return; }
		references.push(...pinned.overflow.map(path => t.t("noteReference.file", { path: JSON.stringify(path) })));
		const text = [request.text ?? "", ...references].join("");
		const owner = service.getSnapshot().session;
		if (owner?.path !== session) { new Notice(t.t("noteReference.selectionChanged")); return; }
		const outcome = !text || await view.prefillComposer(text, owner.id);
		const accepted = outcome === true;
		if (service.getSnapshot().session?.path !== session) {
			new Notice(t.t("noteReference.selectionChanged"));
			return;
		}
		if (paths.length > 1) new Notice(t.t("noteReference.batchResult", {
			added: pinned.added.length, existing: pinned.existing.length,
			drafted: accepted ? references.length : 0, missing: missing + (accepted ? 0 : references.length),
		}));
		else if (missing) new Notice(t.t("noteReference.missing"));
		if (outcome === false) new Notice(t.t("noteReference.unavailable"));
		if (accepted && pinned.overflow.length) new Notice(t.t("noteReference.pinLimit", { limit: MAX_PINNED_REFS }));
		if (accepted) view.focusInput();
	} catch {
		new Notice(t.t("noteReference.unavailable"));
	}
}
