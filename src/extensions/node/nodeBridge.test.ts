import { describe, expect, it } from "bun:test";
import { createRequire } from "./module";
import { fileURLToPath, pathToFileURL } from "./url";
import { readFileSync, writeFileSync, watch, existsSync } from "./fs";
import { spawn } from "./childProcess";
import process from "./process";
import path from "./path";

describe("limited Node environment", () => {
	it("uses explicit virtual paths without modifying the real process", () => {
		expect(process.cwd()).toBe("/vault");
		expect(process.platform).toBe("browser");
		expect(path.resolve("/vault/Notes", "../Other.md")).toBe("/vault/Other.md");
		expect(path.resolve("Notes", "../Other.md")).toBe("/vault/Other.md");
		expect(path.relative("Notes", "/vault/Other.md")).toBe("../Other.md");
		expect(process.versions).toEqual({});
	});
	it("resolves virtual URLs without admitting remote file hosts or escaped separators", () => {
		expect(fileURLToPath(pathToFileURL("/pi/space name.json"))).toBe("/pi/space name.json");
		expect(() => fileURLToPath("https://server/file")).toThrow();
		expect(() => fileURLToPath("file://server/share/file")).toThrow();
		expect(() => fileURLToPath("file:///pi/a%2fb")).toThrow();
	});
	it("fails unsupported loads, filesystem access and subprocesses explicitly", () => {
		const require = createRequire("file:///pi/dist/core/extensions/loader.js");
		expect(() => require("node:fs")).toThrow("does not support");
		expect(() => require.resolve("remote-package")).toThrow("does not support");
		expect(existsSync("/vault/Secret.md")).toBe(false);
		expect(() => readFileSync("/vault/Secret.md", "utf8")).toThrow("No bundled resource");
		expect(() => writeFileSync()).toThrow("does not support");
		expect(() => watch()).toThrow("does not support");
		expect(() => spawn()).toThrow("does not support");
	});
});
