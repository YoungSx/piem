import type { App } from "obsidian";
import type { AgentTool, Skill } from "@earendil-works/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-agent-core";
import type { VaultExecutionEnv } from "../vault/VaultExecutionEnv";
import { adaptHarnessTool } from "../vault/harnessAdapter";
import { withContentLedger } from "../vault/contentLedger";
import { createNoteLinksTool, createNoteMetadataTool } from "./linkTools";
import { createUpdateFrontmatterTool } from "./frontmatterTools";
import { createActiveNoteTool } from "./noteTools";
import { createOpenNoteTool, createOpenSidePanelTool } from "./navigationTools";
import { createGotoLocationTool, createInsertAtCursorTool } from "./editorTools";
import { createAskUserTool, createNotifyTool } from "./interactionTools";
import type { AskUserBroker } from "./askUserBroker";
import { createMoveNoteTool, createTrashNoteTool } from "./organizeTools";
import { createFindTool, createGrepTool, createLsTool } from "./searchTools";
import { createListTasksTool, createSummarizeTasksTool } from "./taskTools";
import { createWebFetchTool } from "./webFetchTools";
import { createReadSkillTool } from "./skillTools";
import type { PiemSettings } from "../settings";

/**
 * Builds the full Obsidian-vault tool set for a low-level pi `Agent`.
 *
 * The three execution tools — read, write, edit — are pi's native harness
 * tools ({@link createReadTool} / {@link createWriteTool} /
 * {@link createEditTool}), adapted onto the shared {@link VaultExecutionEnv}
 * passed in as `env` through a per-call {@link withContentLedger} view (write
 * conflict detection needs per-session last-seen content). Sharing one
 * underlying env instance across all three keeps pi's file mutation queue
 * interlocked for the session (it keys per-path locks off env object
 * identity); the explicit `executionMode: "sequential"` pins below are the
 * primary serialization now that the agent runs batches of read-only tools in
 * parallel — the queue stays as the per-path backstop. The same env is reused
 * to load prompt templates, so a reload never hands the loader a different
 * object than the tools queue on.
 *
	 * The remaining tools (ls, find, grep, tasks, notes, frontmatter, skills,
	 * move, trash, and the screen tools — open/panel/cursor/notify/ask) are
	 * application-specific
	 * and stay hand-written. `read_skill` serves the loaded in-memory snapshot
	 * across built-in, user-level, and vault skill files. move/trash
	 * stay out of the native set because pi's `FileSystem` rename replaces its
	 * destination, while a user-facing move must refuse an occupied one.
 *
 * Every tool carries an explicit `executionMode` — pi treats an omitted mark
 * as "parallel", and a batch runs concurrently unless one of its tools is
 * pinned sequential, so the marks are the whole story of what may interleave.
 * Only confirmed pure reads are "parallel"; everything that mutates the vault,
 * the editor, the screen, or the network stays sequential.
 *
 * `web_fetch` is the sole outbound tool and is always present. It was gated
 * behind an off-by-default setting until the capability review in #52: a tool
 * the user has to discover and enable is a tool the agent effectively does not
 * have, and the failure mode that gating produced — the model reasoning about
 * pages it could not reach — cost more than the channel it withheld. Disclosure
 * moved to where it belongs: the tool's own `description` names the outbound
 * request, and the Network tab documents the transport it rides. It rides the
 * same transport the user chose for provider requests, resolved here per build
 * so a transport change in settings is reflected on the next turn.
 */
/**
 * The collaborators the tool set needs but cannot reach for itself.
 *
 * A bag rather than more positional parameters: both of these are optional, both
 * are supplied only by the plugin's composition root, and a fifth positional
 * argument after an optional fourth is a call site nobody can read.
 */
export interface ObsidianToolDeps {
	/** The loaded skill set, for `read_skill`. Omitted leaves the tool out. */
	getSkills?: () => readonly Skill[];
	/**
	 * Where `ask_user` puts its question. Omitted means the tool is left out
	 * entirely: an agent holding a question tool with no surface to render on
	 * would block its own turn forever, which is worse than not offering it.
	 */
	askUserBroker?: AskUserBroker;
	/** Originating conversation, bound when these tools are built. */
	ownerId?: string;
}

export function createObsidianTools(
	app: App,
	env: VaultExecutionEnv,
	settings: PiemSettings,
	deps: ObsidianToolDeps = {},
): AgentTool[] {
	// One ledger view per call site — createObsidianTools runs per session, so
	// the wrapper (and its last-seen ledger) is per session too. The write tool's
	// baseline staleness check rides it; the underlying env stays shared.
	const trackedEnv = withContentLedger(env);
	const tools: AgentTool[] = [
		// pi's native harness tools ship without an `executionMode`, so the pin
		// happens here, at the one place they are adapted into the agent's list.
		adaptHarnessTool(createReadTool(), { context: { env: trackedEnv }, executionMode: "parallel" }),
		adaptHarnessTool(createWriteTool(), { context: { env: trackedEnv }, executionMode: "sequential" }),
		adaptHarnessTool(createEditTool(), { context: { env: trackedEnv }, executionMode: "sequential" }),
		createLsTool(app),
		createFindTool(app),
		createGrepTool(app),
		createListTasksTool(app),
		createSummarizeTasksTool(app),
		createNoteLinksTool(app),
		createNoteMetadataTool(app),
		createUpdateFrontmatterTool(app),
		createActiveNoteTool(app),
		createMoveNoteTool(app),
		createTrashNoteTool(app),
		createOpenNoteTool(app),
		createOpenSidePanelTool(app),
		createInsertAtCursorTool(app),
		createGotoLocationTool(app),
		createNotifyTool(app),
		/*
		 * Spread in place rather than pushed after the array, so the inventory keeps
		 * its order whether or not a broker was supplied — the list is what the model
		 * is shown, and a tool that moves depending on the wiring is a diff nobody
		 * asked for.
		 *
		 * `ask_user` used to resolve the interface language here, because it owned a
		 * dialog and therefore owned user-facing copy. It renders through the panel's
		 * React tree now, which reads the language from its own context. This layer
		 * supplies the broker and the conversation the question belongs to.
		 */
		...(deps.askUserBroker ? [createAskUserTool(app, deps.askUserBroker, deps.ownerId)] : []),
		createWebFetchTool(),
	];
	if (deps.getSkills) {
		tools.push(createReadSkillTool(deps.getSkills));
	}
	return tools;
}
