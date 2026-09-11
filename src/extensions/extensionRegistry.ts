import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SlashCommandInfo, SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

/**
 * Read-only projections of the tool and command registries, for
 * `pi.getAllTools()` and `pi.getCommands()`.
 *
 * This is a module rather than two closures at the bridge's `actions` object
 * because what these functions must *not* return is the whole specification.
 * Every registry entry piem holds is an executable — an {@link AgentTool} owns
 * `execute`, a command entry is resolved against a live handler — and those
 * closures capture the runtime that built them: its conversation, its session
 * path, its agent state, and through the transport its credentials. Handing an
 * extension the live object would hand it a route around every ownership check
 * in {@link ./extensionLifetime}: it could call `execute` after Stop, after a
 * session switch, after disposal, or from another conversation entirely.
 *
 * So the projection is allowlist-shaped, not denylist-shaped. Rather than copy
 * an entry and delete the dangerous members — which silently admits whatever
 * member pi or piem adds next — each function names the members Pi's
 * {@link ToolInfo} / {@link SlashCommandInfo} declare and builds a fresh object
 * from them. A new `AgentTool` member is absent by construction, and the test
 * that walks the returned graph for functions is what keeps it that way.
 */

/**
 * Where a bridged entry came from, in Pi's own vocabulary.
 *
 * Pi fills this from real package metadata for a loaded extension, or from
 * `createSyntheticSourceInfo` for entries with no file behind them. Everything
 * piem exposes is the second kind — a vault tool is compiled into `main.js`, a
 * builtin skill is a bundled string — so the path is a label, not something an
 * extension can open. `scope: "temporary"` is that helper's own default and
 * says exactly this: no user or project configuration file backs the entry.
 *
 * Built inline rather than by importing the helper: it only fills these four
 * fields from the same defaults, and reaching into pi's `dist/core/source-info.js`
 * by relative path would add a bundle input, and a `check-bundle` required-module
 * entry to pin it, to save nothing.
 */
function sourceInfo(path: string, source: string): SourceInfo {
	return { path, source, scope: "temporary", origin: "top-level" };
}

/**
 * The tools the conversation's agent is holding, as metadata.
 *
 * Drawn from the agent's own list rather than rebuilt, because
 * `pi.getActiveTools()` answers from that same list: an extension comparing the
 * two ("which of the available tools are switched on") needs both sides from one
 * registry, and a rebuild could name a tool the running agent does not have.
 *
 * `parameters` is the one member that cannot be a primitive — Pi's type is the
 * TypeBox schema itself, and reading a tool's schema is the point of the call,
 * since that is how a wrapper extension re-declares a tool. It is deep-cloned
 * because the schemas are built once per tool and shared with the request the
 * agent sends to the provider; a mutable reference would let an extension edit
 * what the model is told. `structuredClone` also refuses functions rather than
 * copying them, so a schema carrying one throws here instead of forwarding it.
 */
export function toolInfoList(tools: readonly AgentTool[]): ToolInfo[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: structuredClone(tool.parameters),
		// `promptGuidelines` is deliberately absent rather than `undefined`: Pi
		// declares it optional, and an own property holding undefined reads as
		// "declared, empty" to a caller testing `"promptGuidelines" in info`.
		// `AgentTool` carries no such member, which is the reason to spell the
		// absence out instead of copying a field that does not exist.
		sourceInfo: sourceInfo(`<piem:tool:${tool.name}>`, "piem"),
	}));
}

/** One slash command, in the shape piem's panel snapshot already models. */
export interface CommandEntry {
	name: string;
	description: string;
	kind: "template" | "skill" | "extension";
}

/**
 * The conversation's slash commands, as metadata.
 *
 * piem's `kind` maps onto Pi's `SlashCommandSource` one-for-one — both separate
 * an extension command from a prompt template from a skill — so this is a
 * rename, not a reinterpretation. Pi's own implementation prefixes skill names
 * with `skill:`; this does not. piem already carries a disambiguated invocation
 * separately for autocomplete, and borrowing it here would make the `name` an
 * extension reads back differ from the command's real name on any vault that
 * happens to hold a template of the same name. `name` stays the name; `source`
 * carries what kind it is.
 */
export function commandInfoList(commands: readonly CommandEntry[]): SlashCommandInfo[] {
	return commands.map(command => ({
		name: command.name,
		description: command.description,
		source: command.kind === "template" ? "prompt" : command.kind,
		sourceInfo: sourceInfo(`<piem:${command.kind}:${command.name}>`, command.kind),
	}));
}
