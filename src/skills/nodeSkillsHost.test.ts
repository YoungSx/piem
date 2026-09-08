import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { createUserSkillsEnv, nodeSkillsHome, type HostRequire } from "./nodeSkillsHost";

const nodeRequire = createRequire(import.meta.url);

function withModule(id: string, value: unknown): HostRequire {
	return (name) => name === id ? value : nodeRequire(name);
}

const unavailableHosts: Array<[string, HostRequire | null]> = [
	["no require", null],
	["throwing require", () => { throw new Error("no node"); }],
	["undefined shim", () => undefined],
	["empty shim", () => ({})],
	["missing filesystem member", withModule("node:fs/promises", { ...nodeRequire("node:fs/promises"), realpath: undefined })],
	["missing path member", withModule("node:path", { ...nodeRequire("node:path"), isAbsolute: undefined })],
	["missing home function", withModule("node:os", {})],
	["throwing home function", withModule("node:os", { homedir: () => { throw new Error("home unavailable"); } })],
	["empty home", withModule("node:os", { homedir: () => "" })],
	["non-string home", withModule("node:os", { homedir: () => undefined })],
];

describe("user-skills host capabilities", () => {
	for (const [name, lookup] of unavailableHosts) {
		it(`skips ${name} without constructing an environment`, async () => {
			expect(nodeSkillsHome(lookup)).toBeUndefined();
			expect(await createUserSkillsEnv(lookup)).toBeUndefined();
		});
	}

	it("probes without reading files or loading the Node bridge", () => {
		const requests: string[] = [];
		const unusable = () => { throw new Error("probe performed I/O"); };
		const modules: Record<string, unknown> = {
			"node:fs/promises": { readFile: unusable, lstat: unusable, readdir: unusable, realpath: unusable },
			"node:path": { resolve: unusable, isAbsolute: unusable, join: unusable, basename: unusable },
			"node:os": { homedir: () => "/home/tester" },
		};
		expect(nodeSkillsHome((id) => {
			requests.push(id);
			if (!(id in modules)) throw new Error(`unexpected module: ${id}`);
			return modules[id];
		})).toBe("/home/tester");
		expect(requests).toEqual(["node:fs/promises", "node:path", "node:os"]);
	});

	it("uses the actual home directory, independent of the process cwd", async () => {
		expect(nodeSkillsHome()).toBe(homedir());
		const env = await createUserSkillsEnv();
		try {
			expect(env?.cwd).toBe(homedir());
			expect(await env?.absolutePath("~")).toEqual({ ok: true, value: homedir() });
		} finally {
			await env?.cleanup();
		}
	});
});
