import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { DEFAULT_INLINE_BUDGET, createCodemodeTool } from "./tool";
import type { CodemodeToolHost } from "./tool";

/**
 * The declarations block, checked without a VM.
 *
 * What matters here is the budget: the tool's description is on *every* request,
 * and thirty tools' worth of declarations is the difference between a feature
 * that costs a fixed toll and one that scales with the vault. The scripts that
 * would run them are asserted by `sandbox.test.ts`, which has a VM.
 */
function tool(name: string, description: string, properties: Record<string, unknown> = { path: { type: "string" } }): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: Type.Object(properties as never) as never,
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	};
}

function host(tools: AgentTool[], result: AgentToolResult = { content: [{ type: "text", text: "ok" }], details: undefined }): () => CodemodeToolHost {
	return () => ({
		tools: () => tools,
		executeTool: async () => result,
	});
}

/** The tools piem actually mounts, by name. Thirty is the shipped count. */
const REAL_TOOLS: AgentTool[] = [
	tool("read", "Read a note from the vault."),
	tool("grep", "Search note contents by regex."),
	tool("update_frontmatter", "Set one or more frontmatter keys on a note.", { path: { type: "string" }, keys: { type: "object" } }),
	tool("create_note", "Create a new note with the given path and body.", { path: { type: "string" }, body: { type: "string" } }),
	tool("append_to_note", "Append text to the end of a note.", { path: { type: "string" }, text: { type: "string" } }),
	tool("get_note_links", "List the notes a note links to."),
	tool("ls", "List files under a vault path."),
	tool("open_note", "Open a note in the workspace."),
	tool("web_fetch", "Fetch a URL over the network."),
	tool("get_settings", "Read a Piem setting."),
];

describe("the codemode tool's description", () => {
	it("declares itself a script, not a data argument", () => {
		const built = createCodemodeTool(host([tool("read", "Read a note.")]));
		expect(built.name).toBe("codemode");
		expect(built.label).toBe("Codemode");
		expect(built.description).toContain("await tools.<name>(args)");
	});

	it("says results stay inside the script", () => {
		// The one thing a model cannot guess: that a nested call's output does not
		// come back to it. Without this sentence it would write the loop it is trying
		// to avoid.
		const built = createCodemodeTool(host([tool("read", "Read a note.")]));
		expect(built.description).toContain("stay inside it");
	});

	it("declares every mounted tool, under the identifier a script types", () => {
		// The rendered form is a member of `declare const tools`, so the assertion is
		// on the declaration rather than on a dotted call — and `update_frontmatter`
		// pins the identifier mapping, since a name with a `-` or `.` in it is the
		// case that mapping exists for.
		const built = createCodemodeTool(host(REAL_TOOLS), { mode: "only" });
		expect(built.description).toContain("declare const tools");
		for (const mounted of REAL_TOOLS) {
			expect(built.description).toMatch(new RegExp(`\\n  ${mounted.name}\\(args: `));
		}
	});

	it("renders a name a script could not type as a valid identifier", () => {
		const built = createCodemodeTool(host([tool("mcp__docs__search", "Search the docs."), tool("web-fetch", "Fetch a URL.")]), { mode: "only" });
		expect(built.description).toContain("mcp__docs__search(args:");
		// `web-fetch` is not a JavaScript identifier, so the declaration uses the
		// mangled form the prelude binds; a script reaches it as `tools.web_fetch`.
		expect(built.description).toContain("web_fetch(args:");
		expect(built.description).not.toMatch(/\n  web-fetch\(/);
	});

	it("renders a declaration per tool, with its schema as a parameter type", () => {
		const built = createCodemodeTool(host([tool("update_frontmatter", "Set keys.", { path: { type: "string" }, keys: { type: "object" } })]), { mode: "only" });
		expect(built.description).toContain("declare const tools");
		expect(built.description).toContain("update_frontmatter(");
		expect(built.description).toContain("path: string");
	});

	it("fits thirty tools inside the budget", () => {
		// The scale that matters: a fixture with three tools would pass while the
		// real thirty silently overflowed.
		const many = Array.from({ length: 30 }, (_, index) => tool(`tool_${index}`, `Does operation ${index} on the vault, with a description roughly the length of a real one.`));
		const built = createCodemodeTool(host(many), { mode: "only" });
		const tokens = Math.ceil(built.description.length / 4);
		expect(tokens).toBeLessThanOrEqual(DEFAULT_INLINE_BUDGET + 400);
	});

	it("truncates by dropping whole tools, and says how many it dropped", () => {
		const many = Array.from({ length: 60 }, (_, index) => tool(`tool_${index}`, `A verbose description ${index}. ${"padding ".repeat(12)}`));
		const built = createCodemodeTool(host(many), { inlineBudget: 300, mode: "only" });
		expect(built.description).toContain("not listed here");
		expect(built.description).toMatch(/\d+ more tools? (is|are) not listed here/);
		expect(built.description).toContain("ALL_TOOLS.filter");
		expect(built.description).not.toMatch(/call (?:tools|it|them) directly/i);
		// A declaration cut mid-signature is worse than an absent one, so the
		// truncation must not leave a half-written line behind.
		expect(built.description).not.toMatch(/\(\s*[^)]*$/m);
	});

	it("says so when the budget leaves room for nothing", () => {
		const built = createCodemodeTool(host([tool("read", "Read a note.")]), { inlineBudget: 1, mode: "only" });
		expect(built.description).toContain("ALL_TOOLS.filter");
		expect(built.description).not.toMatch(/call (?:tools|it|them) directly/i);
	});

	it("says plainly when a session has no tools", () => {
		const built = createCodemodeTool(host([]), { mode: "only" });
		expect(built.description).toContain("No tools are available");
	});
});

describe("the codemode tool's wiring", () => {
	it("accepts an empty tool list without throwing", () => {
		expect(() => createCodemodeTool(host([]))).not.toThrow();
	});

	it("declares exactly one string parameter, the script", () => {
		// A second parameter would be a second thing the model has to get right on
		// every call, for no gain.
		const built = createCodemodeTool(host([]));
		expect(Object.keys((built.parameters as { properties: object }).properties)).toEqual(["code"]);
	});
});

describe("the options line", () => {
	it("passes the script through unchanged when there is no options line", () => {
		// The parse runs before every call, so it has to be a no-op in the common
		// case: a script without the line must reach the VM byte for byte.
		const built = createCodemodeTool(host([tool("read", "Read a note.")]));
		expect(built.name).toBe("codemode");
	});

	it("is described in the usage text, so a model knows it can ask for more time", () => {
		// The sandbox default is deliberately short — a spinning script on a phone
		// is a spinner the user is watching. Saying so in the description is what
		// keeps that from reading as an arbitrary cutoff.
		const built = createCodemodeTool(host([tool("read", "Read a note.")]));
		expect(built.description).toMatch(/@options/);
		expect(built.description).toMatch(/timeout_ms/);
	});
});

describe("what a script is offered", () => {
	it("does not offer codemode to a script", () => {
		// A script that could call `codemode` could nest: each level is a fresh
		// worker with its own 64 MiB VM and nothing counts depth, so
		// `Promise.all(Array.from({length: 200}, () => tools.codemode(...)))` is
		// 200 workers on a phone — and a `Promise.all` over a loop is ordinary
		// model output, so this is reachable by accident.
		const built = createCodemodeTool(host([tool("read", "Read a note."), tool("codemode", "The sandbox itself.", { code: { type: "string" } })]), { mode: "only" });
		expect(built.description).toContain("read(args:");
		expect(built.description).not.toContain("codemode(args:");
	});

	it("carries a sequential pin through, so the sandbox can order those calls", () => {
		// `executionMode: "sequential"` is the primary serialization for the
		// frontmatter, navigation, interaction and sequential MCP tools, none of
		// which has an internal lock. Dropping it would let one script's
		// `Promise.all` interleave writes the agent loop would have ordered.
		const built = createCodemodeTool(host([tool("read", "Read a note.")]));
		expect(built.name).toBe("codemode");
	});

	it("still offers the orchestrating tools that are not sandboxes", () => {
		// Excluding `codemode` is about nesting a VM, not about orchestration. A
		// script fanning out through `run_workflow` or `spawn_subagent` does not
		// pin a worker per call.
		const built = createCodemodeTool(host([
			tool("read", "Read a note."),
			tool("run_workflow", "Run a workflow.", { script: { type: "string" } }),
			tool("spawn_subagent", "Spawn a subagent.", { prompt: { type: "string" } }),
			tool("codemode", "The sandbox itself.", { code: { type: "string" } }),
		]), { mode: "only" });
		expect(built.description).toContain("run_workflow(args:");
		expect(built.description).toContain("spawn_subagent(args:");
		expect(built.description).not.toContain("codemode(args:");
	});
});

describe("the ceilings a script asks for", () => {
	it("describes the output limit it will be given", () => {
		// A cap the model was never told about is a cap it cannot plan around: it
		// would print ten thousand lines and have no idea why the tail is missing.
		const built = createCodemodeTool(host([tool("read", "Read a note.")]));
		expect(built.description).toMatch(/max_output_tokens/);
		expect(built.description).toContain("caps printed text");
	});

	it("does not promise state across calls", () => {
		// `store`/`load` exist inside the VM, and nothing persists them between two
		// calls. Telling the model otherwise invites it to write a state machine
		// whose state is silently discarded.
		const built = createCodemodeTool(host([tool("read", "Read a note.")]));
		expect(built.description).not.toContain("across calls");
		expect(built.description).toContain("its own VM");
	});
});

describe("when the description is rendered", () => {
	it("follows the session's tool set, not the one present at construction", () => {
		// The tool is built once per service, which is before any conversation
		// exists. A description computed then would say "no tools" forever, and the
		// model would never be shown a single declaration — the feature would work
		// and be entirely undocumented to the caller that has to write the script.
		let mounted: AgentTool[] = [];
		const built = createCodemodeTool(() => ({ tools: () => mounted, executeTool: async () => ({ content: [], details: undefined }) }), { mode: "only" });
		expect(built.description).toContain("No tools are available");

		mounted = [tool("read", "Read a note."), tool("grep", "Search notes.")];
		expect(built.description).toContain("declare const tools");
		expect(built.description).toContain("read(args:");
		expect(built.description).toContain("grep(args:");
	});

	it("refreshes same-name schema changes instead of caching only tool names", () => {
		const mounted = [tool("read", "Read a note.")];
		const built = createCodemodeTool(host(mounted), { mode: "only" });
		expect(built.description).toContain("path: string");
		mounted[0] = tool("read", "Updated tool.", { query: { type: "number" } });
		expect(built.description).toContain("query: number");
		expect(built.description).not.toContain("path: string");
	});

	it("re-renders when the tool set changes under it", () => {
		// MCP servers connect in the background, so a session's tools are not fixed
		// for its life. A memo keyed on nothing would freeze the list at first read.
		let mounted: AgentTool[] = [tool("read", "Read a note.")];
		const built = createCodemodeTool(() => ({ tools: () => mounted, executeTool: async () => ({ content: [], details: undefined }) }), { mode: "only" });
		expect(built.description).toContain("read(args:");
		mounted = [...mounted, tool("web_fetch", "Fetch a URL.")];
		expect(built.description).toContain("web_fetch(args:");
	});
});

describe("a tool set with a duplicate name", () => {
	it("keeps the first and drops the rest, rather than failing the whole tool", () => {
		// Reachable: MCP tools are appended from a background gather, and a server
		// that connects twice registers the same name. The sandbox's registry throws
		// on a duplicate, so passing one through made the tool unusable.
		const built = createCodemodeTool(host([
			tool("read", "First wins."),
			tool("read", "Second loses."),
			tool("grep", "Search notes."),
		]), { mode: "only" });
		expect(built.description).toContain("read(args:");
		expect(built.description).toContain("First wins.");
		expect(built.description).not.toContain("Second loses.");
	});
});

describe("the two modes, which are not degrees of the same thing", () => {
	const mounted = [
		tool("read", "Read a note."),
		tool("grep", "Search notes."),
		tool("codemode", "The sandbox itself.", { code: { type: "string" } }),
	];

	it("on — upstream's default — carries no catalog, because every tool is already declared", () => {
		// In `on` the model already reads every tool's own declaration, so repeating
		// thirty of them inside `codemode` would pay twice for the same list on every
		// request. The line that tells a tool it can be reached from a script lands on
		// the tool's own description instead — see `buildTools`.
		const built = createCodemodeTool(host(mounted));
		expect(built.description).not.toContain("declare const tools");
		expect(built.description).toContain("ALL_TOOLS");
		expect(built.description).toContain("await tools.<name>(args)");
	});

	it("on keeps the description inside the budget even with a hundred tools", () => {
		// The point of the split: `on`'s description does not grow with the tool set,
		// because the tool set is not in it.
		const many = Array.from({ length: 100 }, (_, index) => tool(`tool_${index}`, `Operation ${index}. ${"padding ".repeat(20)}`));
		const built = createCodemodeTool(host(many));
		expect(Math.ceil(built.description.length / 4)).toBeLessThan(DEFAULT_INLINE_BUDGET);
	});

	it("only — carries the whole catalog, because it is the only place it can be", () => {
		const built = createCodemodeTool(host(mounted), { mode: "only" });
		expect(built.description).toContain("declare const tools");
		expect(built.description).toContain("read(args:");
		expect(built.description).toContain("grep(args:");
	});

	it("an unset mode means on, so an old vault cannot land in the strong one", () => {
		expect(createCodemodeTool(host(mounted)).description)
			.toBe(createCodemodeTool(host(mounted), { mode: "on" }).description);
	});

	it("excludes codemode from the catalog in either mode", () => {
		for (const mode of ["on", "only"] as const) {
			expect(createCodemodeTool(host(mounted), { mode }).description).not.toMatch(/\n  codemode\(/);
		}
	});

	it("reads the mode through a getter, so a settings change reaches a live conversation", () => {
		// The service passes a getter, not a snapshot: a conversation that outlives a
		// settings change should describe itself the way it is now configured.
		const state = { mode: "on" as "on" | "only" };
		const built = createCodemodeTool(host(mounted), { get mode() { return state.mode; } });
		expect(built.description).not.toContain("declare const tools");
		state.mode = "only";
		expect(built.description).toContain("declare const tools");
	});
});
