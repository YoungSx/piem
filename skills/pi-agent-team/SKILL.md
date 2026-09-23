---
name: pi-agent-team
description: Operate pi-agent-team to start, observe, control, and continue agent teams. Use when delegating to multiple agents, choosing foreground or detached execution, interacting with team members, or continuing a settled team.
---

# Pi Agent Team

## Start

- Default to foreground execution so the user can watch the live TUI. Use `detached: true` only when the user explicitly wants background execution or mid-run interaction.
- Pass through the user's objective and reporting requirements without adding expected answers.
- Use opaque, unrelated member IDs, omit `startMemberId` for symmetric work, and do not encode task order in the roster.
- Set `reporterId` only when the task has a natural moderator, judge, coordinator, or integrator. Otherwise let the team choose the reporter.
- Do not invent `maxTurns`.

## Detached runs

- Keep the returned `runId` and latest `stateChangeSeq`.
- Use `team_get` for an immediate snapshot, then `team_wait` with `afterSeq` to wait without polling.
- Do not prompt members unless the user requests it or a member explicitly blocks for requester input.
- When blocked, report the saved reason to the user and relay their answer with `team_prompt`; do not decide for them.
- Address a moderator or coordinator when guidance is intended for the whole team.

## Continue a settled team

Settlement ends a coordination round, not the team. Member sessions and histories remain available in the current parent session.

To continue:

1. Reuse the prior manifest's `team` value as `runId`.
2. Call `team_prompt` with the relevant member ID and the new request.
3. Observe the new round with `team_get` or `team_wait`.

A prompt after settlement starts a clean round over the same member sessions, uses the message as the new objective, and makes the addressed member report the response. Do not call `team_start` again when the user wants to continue the existing team.

During a running round, `team_prompt` instead wakes or unblocks the addressed member and counts as requester intervention.

## Interpret status

- `completed`: every member finished; correctness is still unverified.
- `quiescent`: unfinished members remain, but none is runnable.
- `exhausted`: the turn budget ended with runnable work remaining.

Use `team_cancel` only when the user intends to stop the current round. Retained teams disappear when the parent session shuts down or the retention limit evicts them.
