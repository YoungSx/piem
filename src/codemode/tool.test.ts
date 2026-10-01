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

function host(tools: AgentTool[], result: AgentToolResult = { content: [{ type: "text", text: "ok" }], details: undefined }): CodemodeToolHost {
	return {
		tools: () => tools,
		executeTool: async () => result,
	};
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
		const built = createCodemodeTool(host(REAL_TOOLS));
		expect(built.description).toContain("declare const tools");
		for (const mounted of REAL_TOOLS) {
			expect(built.description).toMatch(new RegExp(`\\n  ${mounted.name}\\(args: `));
		}
	});

	it("renders a name a script could not type as a valid identifier", () => {
		const built = createCodemodeTool(host([tool("mcp__docs__search", "Search the docs."), tool("web-fetch", "Fetch a URL.")]));
		expect(built.description).toContain("mcp__docs__search(args:");
		// `web-fetch` is not a JavaScript identifier, so the declaration uses the
		// mangled form the prelude binds; a script reaches it as `tools.web_fetch`.
		expect(built.description).toContain("web_fetch(args:");
		expect(built.description).not.toMatch(/\n  web-fetch\(/);
	});

	it("renders a declaration per tool, with its schema as a parameter type", () => {
		const built = createCodemodeTool(host([tool("update_frontmatter", "Set keys.", { path: { type: "string" }, keys: { type: "object" } })]));
		expect(built.description).toContain("declare const tools");
		expect(built.description).toContain("update_frontmatter(");
		expect(built.description).toContain("path: string");
	});

	it("fits thirty tools inside the budget", () => {
		// The scale that matters: a fixture with three tools would pass while the
		// real thirty silently overflowed.
		const many = Array.from({ length: 30 }, (_, index) => tool(`tool_${index}`, `Does operation ${index} on the vault, with a description roughly the length of a real one.`));
		const built = createCodemodeTool(host(many));
		const tokens = Math.ceil(built.description.length / 4);
		expect(tokens).toBeLessThanOrEqual(DEFAULT_INLINE_BUDGET + 400);
	});

	it("truncates by dropping whole tools, and says how many it dropped", () => {
		const many = Array.from({ length: 60 }, (_, index) => tool(`tool_${index}`, `A verbose description ${index}. ${"padding ".repeat(12)}`));
		const built = createCodemodeTool(host(many), { inlineBudget: 300 });
		expect(built.description).toContain("not listed here");
		expect(built.description).toMatch(/\d+ more tools? (is|are) not listed here/);
		// A declaration cut mid-signature is worse than an absent one, so the
		// truncation must not leave a half-written line behind.
		expect(built.description).not.toMatch(/\(\s*[^)]*$/m);
	});

	it("says so when the budget leaves room for nothing", () => {
		const built = createCodemodeTool(host([tool("read", "Read a note.")]), { inlineBudget: 1 });
		expect(built.description).toContain("call tools directly");
	});

	it("says plainly when a session has no tools", () => {
		const built = createCodemodeTool(host([]));
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
