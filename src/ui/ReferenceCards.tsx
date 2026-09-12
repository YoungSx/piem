import React from "react";
import { Notice, type App } from "obsidian";
import { referenceKey, type ContextReference } from "../agent/contextReference";
import type { Translator } from "../i18n";
import { IconButton, ObsidianIcon } from "./ObsidianIcon";

export function ReferenceCards({ references, app, t, onRemove }: {
	references: readonly ContextReference[];
	app: App;
	t: Translator;
	onRemove?: (reference: ContextReference) => void;
}): React.JSX.Element | null {
	if (!references.length) return null;
	return <ul className="piem-chat__references" aria-label={t.t("noteReference.cards")}>
		{references.map(reference => {
			const path = reference.kind === "url" ? reference.url : reference.path;
			const label = reference.kind === "url" ? new URL(path).hostname : path.split("/").pop() ?? path;
			const icon = reference.kind === "url" ? "link" : reference.kind === "folder" ? "folder" : reference.kind === "selection" ? "text-select" : "file-text";
			return <li className="piem-chat__reference" key={referenceKey(reference)}>
				<details className="piem-chat__reference-details">
					<summary title={path}>
						<ObsidianIcon name={icon} />
						<span className="piem-chat__reference-name">{label}</span>
						<span className="piem-chat__reference-kind">{t.t(`noteReference.kind.${reference.kind}`)}</span>
						<ObsidianIcon name="chevron-down" className="piem-chat__reference-chevron" />
					</summary>
					<div className="piem-chat__reference-body">
						{reference.kind === "url" ? <a href={path} target="_blank" rel="noopener noreferrer">{path}</a> :
							reference.kind === "folder" ? <span>{path}</span> : <button type="button" className="piem-chat__reference-open" onClick={() => {
								const file = app.vault.getFileByPath(path);
								if (!file) { new Notice(t.t("noteReference.missing")); return; }
								void app.workspace.getLeaf(false).openFile(file);
							}}>{path}</button>}
						{reference.kind === "selection" ? <>
							{reference.startLine === undefined ? null : <span>{t.t("noteReference.lines", { start: reference.startLine, end: reference.endLine ?? reference.startLine })}</span>}
							<pre>{reference.text}</pre>
							{reference.truncated ? <span>{t.t("noteReference.truncated")}</span> : null}
						</> : <span className="piem-chat__reference-hint">{t.t(reference.kind === "url" ? "noteReference.webHint" : "noteReference.pathHint")}</span>}
					</div>
				</details>
				{onRemove ? <IconButton icon="x" label={t.t("noteReference.remove", { name: label })} onClick={() => onRemove(reference)} className="piem-chat__reference-remove" /> : null}
			</li>;
		})}
	</ul>;
}
