import { ItemView, type WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
import { VIEW_TYPE_PIEM_SUBAGENTS } from "../constants";
import type { ObsidianAgentService } from "../agent/ObsidianAgentService";
import { snapshotSubagents, type SubagentSnapshot } from "../subagent/inspectorModel";
import { getT } from "../i18n";
import { sessionTitle } from "./sessionDialogs";
import { SubagentInspectorApp, type SelectionRequest } from "./SubagentInspector";
import { TranslatorProvider } from "./TranslatorContext";

/**
 * The subagent monitor's Obsidian shell.
 *
 * It owns three things the React tree deliberately does not: the registry
 * subscription, the clock a running child's elapsed time is measured against,
 * and the "open showing this run" request the chat panel's entry icon sends.
 * {@link SubagentInspectorApp} stays a function of its props, which is what lets
 * the tests drive list and detail without an Obsidian workspace.
 *
 * Snapshots are rebuilt on registry events, not on a timer — a spawn and a
 * settlement are the only moments the list's content changes. The one thing an
 * event cannot cover is a running child's elapsed time, which grows between
 * them; a per-second repaint of a whole sidebar for one number is the wrong
 * trade, so a live row's duration is its age at the last event and the status
 * word beside it says the run is not over.
 */
export class PiemSubagentView extends ItemView {
	private readonly service: ObsidianAgentService;
	private root: Root | null = null;
	/** Unhooks both subscriptions; neither is an Obsidian event, so `registerEvent` cannot own them. */
	private unsubscribe: (() => void) | null = null;
	/**
	 * The newest "open showing this run" request, or null if none was made.
	 *
	 * Held on the view rather than in React state because it arrives from outside
	 * the tree — the chat panel's entry icon, through {@link showSubagent} — and
	 * can land before `onOpen` has mounted anything. Carries a token so asking
	 * for the *same* run twice is still two requests: without it the prop would
	 * be unchanged and a reader who had navigated back to the list would press
	 * the row in the popover and watch nothing happen.
	 */
	private selectionRequest: SelectionRequest | null = null;
	private requestToken = 0;

	constructor(leaf: WorkspaceLeaf, service: ObsidianAgentService) {
		super(leaf);
		this.service = service;
	}

	getViewType(): string {
		return VIEW_TYPE_PIEM_SUBAGENTS;
	}

	getDisplayText(): string {
		return getT(this.service.getSnapshot().language).t("subagents.tabTitle");
	}

	getIcon(): string {
		return "users";
	}

	/**
	 * Repaints the tab header so a language change reaches the tab title.
	 *
	 * Same feature detection as the chat view: `updateHeader` exists on `View` at
	 * runtime but not in the shipped declarations, and a missing method costs only
	 * a stale title.
	 */
	refreshHeader(): void {
		(this as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	/**
	 * Opens the panel already showing one run.
	 *
	 * Safe before the React tree exists — the request is latched and applied by
	 * the next render — which is what lets the entry icon activate the leaf and
	 * name a run in one awaited sequence.
	 */
	showSubagent(id: string): void {
		this.requestToken += 1;
		this.selectionRequest = { id, token: this.requestToken };
		this.render();
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("piem-subagent-view");
		this.root = createRoot(this.contentEl);
		// Two channels, two subscriptions: the registry says which runs exist and
		// where they stand, the service snapshot says what language to say it in
		// and whether spend may be shown.
		const unsubscribeService = this.service.subscribe(() => this.render());
		const unsubscribeRegistry = this.service.getSubagentRegistry().subscribe(() => this.render());
		this.unsubscribe = () => {
			unsubscribeService();
			unsubscribeRegistry();
		};
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.root?.unmount();
		this.root = null;
	}

	private render(): void {
		if (!this.root) {
			return;
		}
		const chat = this.service.getSnapshot();
		const snapshots: readonly SubagentSnapshot[] = snapshotSubagents(this.service.getSubagentRegistry(), Date.now());
		const t = getT(chat.language);
		// Rebuilt per render rather than cached: a rename or a first message lands
		// in the session header, and a label held from an earlier render would name
		// a chat by a title it no longer has.
		const sessions = new Map(this.service.getKnownSessions().map((info) => [info.path, info]));
		this.root.render(
			<TranslatorProvider language={chat.language}>
				<SubagentInspectorApp
					snapshots={snapshots}
					// The chat the panel opens against — the same path the registry filed
					// its runs under, so no translation is needed between the two.
					focusedOwnerId={chat.session?.path}
					/*
					 * The one thing the React tree cannot work out for itself: a run
					 * carries an opaque owner id, and turning it into a name means
					 * reading the session header — or, when the chat is gone from the
					 * runtime pool, saying so. The registry outlives a deleted chat by
					 * design (rule 3 keeps the record for the session), so "a closed
					 * chat" is a state the panel has to be able to word.
					 */
					describeOwner={(ownerId) => {
						const info = sessions.get(ownerId);
						return info ? sessionTitle(info, t) : t.t("subagents.groupUnknownChat");
					}}
					showAgentDetails={chat.showAgentDetails}
					selectionRequest={this.selectionRequest}
					// The panel's stop controls land here: the view holds the registry
					// handle, so the kill stays in the Obsidian layer and React keeps
					// receiving pure data plus callbacks — same layering as the
					// selection request above. A hostless kill (no owner signal) is the
					// documented panel case: it sits outside every run and answers to
					// the user, and `killedBy: "user"` is what the parent later reads.
					onStop={(id) => this.service.getSubagentRegistry().kill(id, undefined, "user")}
					// Tidying, not a lifecycle change: the flag it sets is read by this
					// panel and by nothing else, so an archived run stays exactly as
					// collectable, stoppable and re-taskable as it was.
					onArchiveFinished={() => this.service.getSubagentRegistry().archiveSettled()}
					// Scoped and unscoped, kept apart all the way down to the registry:
					// the per-chat button passes an owner and can only reach that chat's
					// children, so a reader stopping one chat's runaway sweep cannot end
					// a background chat's work by pressing it.
					onStopChat={(ownerId) => this.service.getSubagentRegistry().killAllLive("user", ownerId)}
					onStopEverything={() => this.service.getSubagentRegistry().killAllLive("user")}
					app={this.service.getApp()}
					component={this}
				/>
			</TranslatorProvider>,
		);
	}
}
