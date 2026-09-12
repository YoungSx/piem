import React from "react";
import type { IconName } from "obsidian";
import { IconButton, ObsidianIcon } from "./ObsidianIcon";

/** One disclosure for skills and references, before and after sending. */
export function AttachmentCard({ icon, label, kind, title, className, removal, children }: {
	icon: IconName;
	label: string;
	kind?: string;
	title?: string;
	/** Identifies the content on the native disclosure; styling stays shared. */
	className?: string;
	removal?: { label: string; onClick: () => void };
	children: React.ReactNode;
}): React.JSX.Element {
	return <div className="piem-chat__attachment">
		<details className={`piem-chat__attachment-details ${className ?? ""}`}>
			<summary className="piem-chat__attachment-summary" title={title}>
				<ObsidianIcon name={icon} className="piem-chat__attachment-icon" />
				<span className="piem-chat__attachment-name">{label}</span>
				{kind ? <span className="piem-chat__attachment-kind">{kind}</span> : null}
				<ObsidianIcon name="chevron-down" className="piem-chat__attachment-chevron" />
			</summary>
			<div className="piem-chat__attachment-body">{children}</div>
		</details>
		{removal ? <IconButton icon="x" label={removal.label} onClick={removal.onClick} className="piem-chat__attachment-remove" /> : null}
	</div>;
}
