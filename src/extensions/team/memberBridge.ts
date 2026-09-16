/**
 * The `@earendil-works/pi-coding-agent` face the community package
 * `@geminixiang/pi-agent-team` sees inside piem, replaced per-package by
 * `scripts/pi-scoped-factories.mjs` (its `SUBSTITUTIONS` table).
 *
 * The package drives member sessions through four pi values —
 * `createAgentSession`, `DefaultResourceLoader`, `SessionManager` and
 * `getAgentDir` — plus `getMarkdownTheme` from its (tui-only) chat view.
 * In piem, member sessions are first-class runtime-pool sessions rather than
 * pi's own (design decision 3 and 4: bridged into {@link MemberSessionHandle},
 * rpc-mode gate), so the first three become recorders that forward one
 * normalized {@link MemberSessionSpec} to the conversation host instead of
 * touching pi's loader or filesystem session directory.
 *
 * Constraint: this file is the *substituted* module of an audited scoped
 * build, so it must stay self-contained — its only import is the build-time
 * platform specifier, which the compiler rewrites into one closure binding.
 * Types are `import type` because everything else (compat shims, the real
 * pi module) is foreign territory for the scoped graph.
 */
import { createMemberSession, getAgentDir } from "piem:extension-platform";
import type { MemberSessionHandle, MemberSessionSpec } from "./memberTypes";

export { getAgentDir };

/** Only pi-tui's own Markdown rendering ever consumes this; piem's tool cards do not run it. */
export function getMarkdownTheme(): Record<string, unknown> {
	return {
		code: () => "",
		codeBlock: () => "",
		link: (text: string) => text,
	};
}

/**
 * Recorder stand-in for pi's resource loader. The package reads nothing off
 * the instance — it only calls `reload()` and hands it back through
 * `createAgentSession({ resourceLoader })` — so the loader just carries the
 * member configuration the host needs: doctrine system prompt, skill filter,
 * and the no-extensions / no-themes pins (a member must not start nested
 * teams, which the host also enforces by not mounting community factories).
 */
export class DefaultResourceLoader {
	constructor(readonly options: { skillsOverride?: MemberSessionSpec["skillsOverride"]; systemPrompt?: string }) {}
	async reload(): Promise<void> {}
}

/**
 * pi's SessionManager builds real per-directory session files. For piem the
 * host owns persistence (its ObsidianSessionManager creates the same JSONL in
 * the same directory), so `create` only records the lineage decision 1 asks
 * for: `parentSession` keeps the team's upstream link in member metadata.
 */
export const SessionManager = {
	create(cwd: string, directory?: string, options?: { parentSession?: string }) {
		return { cwd, directory, parentSession: options?.parentSession };
	},
};

/**
 * Builds one member session through the host instead of pi. The package's
 * call site is the only consumer, so options keys are read positionally and
 * anything unexpected fails by falling out of the destructuring below.
 */
export async function createAgentSession(options: {
	cwd: string;
	agentDir?: string;
	model?: unknown;
	modelRuntime?: unknown;
	thinkingLevel?: string;
	customTools?: unknown[];
	resourceLoader?: { options?: { skillsOverride?: MemberSessionSpec["skillsOverride"]; systemPrompt?: string } };
	sessionManager?: { parentSession?: string };
}): Promise<{ session: MemberSessionHandle }> {
	const loader = options.resourceLoader;
	const spec: MemberSessionSpec = {
		cwd: options.cwd,
		model: options.model,
		modelRuntime: options.modelRuntime,
		thinkingLevel: options.thinkingLevel,
		customTools: options.customTools ?? [],
		systemPrompt: loader?.options?.systemPrompt,
		skillsOverride: loader?.options?.skillsOverride,
		parentSession: options.sessionManager?.parentSession,
	};
	return { session: await createMemberSession(spec) };
}
