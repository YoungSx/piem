import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { textResult, throwIfAborted } from "../tools/toolResult";
import { statusOf, type SubagentEntry } from "./registry";
import { linkSignals } from "./runner";
import { SUBAGENT_CONCURRENCY_LIMIT, resolveOwnerId, startChildRun, type SubagentToolsContext } from "./spawnTool";

/**
 * The three tools that let a parent manage what it started, rather than only
 * start it and collect it.
 *
 * Two are thin readers over the registry; the third re-arms one of its entries.
 * Each exists because the alternative is worse than it looks. Without a kill, a
 * run has no deadline, so a fan-out whose first report makes the rest pointless
 * leaves its siblings running — holding write tools — until they finish on their
 * own or the session closes. Without a listing, the only way to learn what is
 * still running is to commit to a wait, whose floor is ten seconds. And without a
 * follow-up, a child that stopped is a dead end: everything it learned is
 * unreachable, so one more question about its report, or a retry after a dropped
 * connection, means paying for the whole task again on a fresh spawn.
 *
 * Claude Code (`TaskStop`, `ListAgents`, `SendMessage`), Codex (`interrupt_agent`,
 * `list_agents`) and the pi community extension ship the same set, and Claude
 * Code's framing of its message tool is the reason the third one here exists:
 * continuing an agent keeps its context, where a fresh spawn starts over.
 */

const KillParameters = Type.Object({
	subagentId: Type.String({
		description: "The id from spawn_subagent of the subagent to stop.",
	}),
});

/**
 * The `kill_subagent` tool: stops one live child without waiting for it.
 *
 * Every outcome is a result rather than an error, including a mistyped id: the
 * model's next move is the same either way — read what happened and continue —
 * and a thrown error would end the parent's turn under the service's
 * stop-on-tool-error rule.
 */
export function createKillSubagentTool(context: SubagentToolsContext, inheritedOwnerId?: string): AgentTool<typeof KillParameters> {
	return {
		name: "kill_subagent",
		label: "Stop subagent",
		description:
			"Stop a running subagent you spawned. Use it when its work has become unnecessary — a sibling already answered, or the plan changed. Whatever it had already written is still collectable with wait_subagent, marked incomplete. A subagent that already finished is left alone.",
		parameters: KillParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const ownerId = resolveOwnerId(context, inheritedOwnerId);
			const outcome = context.registry.kill(params.subagentId, signal);
			const id = params.subagentId;
			switch (outcome) {
				case "killed":
					return textResult(
						`Stopped subagent ${id}. Collect what it wrote before stopping with wait_subagent — it will be marked incomplete.`,
						{ subagentId: id, killed: true },
					);
				case "already-settled":
					return textResult(`Subagent ${id} had already finished; nothing to stop. Collect it with wait_subagent.`, {
						subagentId: id,
						killed: false,
						reason: "already-settled",
					});
				case "not-yours":
					return textResult(`Subagent ${id} was not spawned here, so it is not yours to stop.`, {
						subagentId: id,
						killed: false,
						reason: "not-yours",
					});
				default: {
					const ids = knownIds(context, signal, ownerId);
					return textResult(
						`No subagent ${id}.` + (ids.length ? ` This conversation spawned: ${ids.join(", ")}.` : " Nothing has been spawned here."),
						{ subagentId: id, killed: false, reason: "not-found" },
					);
				}
			}
		},
	};
}

const ListParameters = Type.Object({});

/**
 * The `list_subagents` tool: what this conversation spawned and where each stands.
 *
 * Returns at once, which is the whole point — the alternative today is a
 * `wait_subagent` call whose window floor is ten seconds, so a parent could not
 * cheaply ask "is anything still going?" before deciding what to do next.
 */
export function createListSubagentsTool(context: SubagentToolsContext, inheritedOwnerId?: string): AgentTool<typeof ListParameters> {
	return {
		name: "list_subagents",
		label: "List subagents",
		description:
			"List the subagents this conversation spawned and their current state, without waiting. Use it to check what is still running before deciding whether to wait, stop one, or spawn more.",
		parameters: ListParameters,
		execute: async (_toolCallId, _params, signal) => {
			throwIfAborted(signal);
			const ownerId = resolveOwnerId(context, inheritedOwnerId);
			const entries = signal ? context.registry.forSignal(signal) : context.registry.forOwner(ownerId);
			if (entries.length === 0) {
				// Children of an earlier turn stay collectable by id, so naming them
				// is the difference between "nothing exists" and "nothing here".
				// Scoped to this conversation: an id from another chat is one this
				// model could then wait on, which would fold a stranger's report into
				// a transcript that never asked for it.
				const elsewhere = context.registry.forOwner(ownerId);
				if (elsewhere.length === 0) {
					return textResult("No subagents have been spawned.", { subagents: [] });
				}
				return textResult(
					`No subagents spawned in this turn. Earlier turns spawned: ${elsewhere.map((e) => e.id).join(", ")} — wait on one by id.`,
					{ subagents: [], earlierIds: elsewhere.map((e) => e.id) },
				);
			}
			return textResult(entries.map(describeState).join("\n"), {
				subagents: entries.map((entry) => ({ subagentId: entry.id, role: entry.role.name, status: statusOf(entry) })),
			});
		},
	};
}

/** One line per child: enough to decide, without reproducing the report. */
function describeState(entry: SubagentEntry): string {
	const status = statusOf(entry);
	const tail =
		status === "failed"
			? ` — ${entry.error?.message ?? "failed"}`
			: status === "running"
				? " — collect it with wait_subagent when you need it"
				: " — collect it with wait_subagent";
	return `${entry.id} (role: ${entry.role.name}): ${status}${tail}`;
}

function knownIds(context: SubagentToolsContext, signal: AbortSignal | undefined, ownerId: string): string[] {
	return (signal ? context.registry.forSignal(signal) : context.registry.forOwner(ownerId)).map((entry) => entry.id);
}

const FollowUpParameters = Type.Object({
	subagentId: Type.String({
		description: "The id of the subagent to give the next instruction to.",
	}),
	task: Type.String({
		description:
			"The next instruction, in full. The subagent still remembers its own earlier work, so there is no need to repeat it — but it still cannot see this conversation, so anything new has to be spelled out.",
	}),
});

/**
 * The `follow_up_subagent` tool: hands a stopped subagent another instruction,
 * on the transcript it already has.
 *
 * The case that argues for it is a run that broke rather than one that finished.
 * A child cut off by a dropped connection halfway through a vault sweep still
 * holds everything it had learned, and without this the only way on is a fresh
 * spawn that pays for all of it again. A follow-up on a child that *did* finish is
 * the same mechanism spent on the cheaper thing: one more question about a report,
 * asked of the only agent that still has the working notes behind it.
 *
 * It does not break the isolation a subagent's report depends on. The parent
 * composes this instruction exactly as it composed the task — the child still
 * cannot see the conversation, so its answer is still a function of what it was
 * told plus what it found. What the monitor panel refuses is a different channel:
 * the *user* talking to a child, which would make a report the product of a
 * conversation nobody can audit. That stays closed.
 *
 * A child that is still working takes no new instruction. pi's loop owns the
 * transcript while a run is in flight, so a second prompt into it would put two
 * writers on one history; the parent is told to collect or stop first, which is
 * also what it would have had to do anyway.
 */
export function createFollowUpSubagentTool(context: SubagentToolsContext, inheritedOwnerId?: string): AgentTool<typeof FollowUpParameters> {
	return {
		name: "follow_up_subagent",
		label: "Follow up with subagent",
		description:
			"Give a subagent that has stopped another instruction, keeping everything it already learned. Use it to ask a follow-up about a report you just collected, or to pick a run back up after it failed partway — a failed subagent keeps its work, so continuing costs far less than spawning a replacement to redo it. Same subagent, same id, same model and role, and its transcript grows rather than restarting. It still cannot see this conversation, so the instruction has to stand on its own. Returns immediately; collect the new report with wait_subagent. A subagent that is still working cannot take another instruction until you collect it or stop it.",
		parameters: FollowUpParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const ownerId = resolveOwnerId(context, inheritedOwnerId);
			const id = params.subagentId;
			// Re-arming a child makes it live again, so it answers to the same width
			// cap a spawn does, and for the same reason: nothing else stops a parent
			// from having twenty children in flight.
			const live = context.registry.liveCount();
			if (live >= SUBAGENT_CONCURRENCY_LIMIT) {
				return textResult(
					`${live} subagents are already running, which is the limit (${SUBAGENT_CONCURRENCY_LIMIT}). Collect one with wait_subagent or stop one with kill_subagent, then try again.`,
					{ subagentId: id, resumed: false, reason: "at-capacity" },
				);
			}
			const outcome = context.registry.resume({
				id,
				ownerId,
				parentSignal: signal,
				task: params.task,
				startRun: (child) => {
					// This errand's own kill switch, linked to the run handing it over —
					// so stopping this turn stops the errand it started, exactly as a
					// spawn's would.
					const linked = linkSignals(signal);
					return {
						abort: linked.abort,
						dispose: linked.dispose,
						start: () =>
							startChildRun(context, {
								task: params.task,
								role: child.role,
								instructions: child.instructions,
								model: child.model,
								thinkingLevel: child.thinkingLevel,
								depth: child.depth,
								// Same child, same owner: the tree it belongs to was fixed when
								// it was spawned, and a re-task does not transplant it.
								ownerId,
								initialMessages: child.transcript,
								signal: linked.signal,
							}),
					};
				},
			});
			switch (outcome) {
				case "resumed":
					return textResult(
						`Subagent ${id} is working on it, with everything it had already learned still in view. Collect the new report with wait_subagent.`,
						{ subagentId: id, resumed: true, status: "running" },
					);
				case "still-running":
					return textResult(
						`Subagent ${id} is still working on its last instruction, so it cannot take another yet. Collect it with wait_subagent, or stop it with kill_subagent first.`,
						{ subagentId: id, resumed: false, reason: "still-running" },
					);
				case "user-stopped":
					return textResult(
						`Subagent ${id} was stopped by the user from the monitor panel, so it will not be picked back up. Spawn a fresh subagent if the work is still needed.`,
						{ subagentId: id, resumed: false, reason: "user-stopped" },
					);
				default: {
					// Across turns, within this conversation: a follow-up's ordinary shape
					// spans two runs — spawn, collect, report, then re-task on what the
					// user said next — so a run-scoped list would refuse exactly the case
					// this exists for. But conversation-scoped, never process-wide: the
					// resume above just refused a stranger's id as unknown, and echoing
					// other chats' ids here would point the model straight back at one.
					const ids = context.registry.forOwner(ownerId).map((entry) => entry.id);
					return textResult(
						`No subagent ${id}.` + (ids.length ? ` This conversation spawned: ${ids.join(", ")}.` : " Nothing has been spawned here."),
						{ subagentId: id, resumed: false, reason: "not-found" },
					);
				}
			}
		},
	};
}
