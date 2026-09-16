/**
 * The contract between the agent-team bridge and piem's member session host.
 *
 * The community package `@geminixiang/pi-agent-team` reaches for pi's own
 * `createAgentSession` machinery to build each member's session. piem runs
 * members as first-class pool sessions instead (decision 3 of five: a member
 * session must open and continue like any ordinary conversation), so the
 * bridge forwards one normalized request per member to the conversation host
 * and hands back a handle the package drives.
 */

/** What one member session needs; a faithful echo of the package's request. */
export interface MemberSessionSpec {
	/** Working directory the members share with the parent conversation. */
	cwd: string;
	/** The parent's model object, passed through unchanged. */
	model?: unknown;
	/** The parent's ModelRuntime, passed through unchanged. */
	modelRuntime?: unknown;
	/** pi thinking level already lowered by the package (`max` → `medium`). */
	thinkingLevel?: string;
	/**
	 * pi `ToolDefinition`s — the package's own team coordination tools. The
	 * host mounts them next to this session's ordinary vault tools.
	 */
	customTools: unknown[];
	/** The package's member doctrine, already joined into one string. */
	systemPrompt?: string;
	/**
	 * Skill filter the package supplies (it excludes its own operator skill so
	 * members cannot start nested teams). Receives piem's skill list.
	 */
	skillsOverride?: (base: { skills: readonly { name: string }[] }) => { skills: readonly { name: string }[] };
	/** Session file id of the conversation that started the team. */
	parentSession?: string;
}

/**
 * The handle the package drives per member. Field names are the package's
 * own `SessionLike` contract (`pi-agent.ts`); the host implements them over
 * its SessionRuntime pool.
 */
export interface MemberSessionHandle {
	readonly sessionId: string;
	readonly sessionFile?: string;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void> | void;
	setSessionName?(name: string): void;
	getLastAssistantText?(): string | undefined;
}
