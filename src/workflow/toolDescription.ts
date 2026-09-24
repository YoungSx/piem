/**
 * toolDescription.ts — the model-facing text for `run_workflow`.
 *
 * A trimmed port of Claude Code's Workflow description (via tintinweb's), kept
 * because the orchestration patterns are load-bearing guidance that gets used
 * badly when compressed. Deviations from upstream, each because it is untrue of
 * this host: no `isolation: "worktree"` (no git CLI), no `gate` (no shell),
 * `budget.total` is always null, and `schema` is pressure not force — a child
 * can decline and the call returns null. `{{typeList}}` is replaced with the
 * live agent roster.
 */

export function buildWorkflowToolDescription(agentTypes: readonly string[]): string {
	const typeList = agentTypes.length > 0 ? agentTypes.join(", ") : "general-purpose";
	return `Execute a workflow script that orchestrates multiple subagents deterministically. The script is plain JavaScript that fans work out across subagents, verifies it, and returns a JSON-serializable value.

ONLY use this when the user has asked for multi-agent orchestration in their own words ("use a workflow", "fan out agents", "orchestrate this"), invoked a skill that calls it, or named a workflow to run. For anything else — even a task that would benefit from parallelism — use spawn_subagent for individual children, or describe what a workflow could do and ask first.

The right move is often hybrid: scout inline first (find the files, scope the work) to discover the work-list, then call this to pipeline over it.

## The script

Begins with a PURE LITERAL meta block (no variables, calls, or interpolation):

  export const meta = {
    name: 'review-changes',
    description: 'Review changed files, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }

Then the body, using these globals (await directly; it runs in an async context):

- agent(prompt, opts?) => Promise<string | object> — spawn one subagent. Without a schema it returns the child's final text. With opts.schema (a JSON Schema, type:"object" at root) the child is asked to answer as JSON matching it and agent() returns the parsed object (or null if it declined — schema is pressure here, not force). Returns null if the child failed or was stopped; filter with .filter(Boolean). opts: label, phase, model (a configured model id), agentType (${typeList}), effort ("minimal"|"low"|"medium"|"high"|"xhigh"|"max"), resume (a label to continue), schema.
- parallel(thunks) => Promise<any[]> — run thunks concurrently and await all (a BARRIER). A thunk that throws resolves to null; filter before use.
- pipeline(items, stage1, stage2, ...) => Promise<any[]> — run each item through all stages with NO barrier between stages: item A can be in stage 3 while B is in stage 1. This is the DEFAULT for multi-stage work. Each stage sees (prevResult, originalItem, index).
- phase(title) — start a phase; later agent() calls group under it.
- log(message) — emit a progress line.
- workflow(nameOrRef, args?) — run a saved workflow inline (one level only).
- budget — { total: null, spent(), remaining() }; total is always null here, so guard loops with \`while (budget.total && ...)\` exactly as documented.
- args — the value passed as this tool's \`args\`, verbatim.

Concurrency is capped automatically; a run is capped at 1000 agents total and 4096 items per parallel()/pipeline() call.

## The canonical multi-stage pattern — pipeline, each finding verified as its review completes:

  const DIMENSIONS = [{key:'bugs', prompt:'...'}, {key:'perf', prompt:'...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel((review?.findings ?? []).map(f => () =>
      agent(\`Adversarially verify: \${f.title}\`, {phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))))
  )
  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
  return { confirmed }

## Quality patterns

- Adversarial verify: spawn N skeptics per finding, each prompted to REFUTE; keep only findings a majority could not refute.
- Loop-until-dry: for unknown-size discovery, keep spawning finders until K rounds return nothing new.
- Judge panel: generate N independent attempts from different angles, score with parallel judges, synthesize the winner.

Do NOT use Date.now(), Math.random(), or \`new Date()\` in a script — they throw (they would break resume). Stamp timestamps after the run or pass them via args.`;
}
