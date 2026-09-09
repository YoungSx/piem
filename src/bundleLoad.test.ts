import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { installDom } from "./testUtils/dom";
import { createObsidianHostModule, createStubApp, loadPluginBundle, type PluginHostRecord } from "./testUtils/pluginLoader";
import { createSkillVault } from "./testUtils/skillVault";

/**
 * End-to-end load gate over the built artifact.
 *
 * Every other test in this repo imports source modules and injects mocks. That
 * is what let 0.1.0-alpha.3 ship a bundle that could not be loaded at all: the
 * one boundary that was broken — how the bundle reaches electron — was mocked
 * past in every unit test. This file imports nothing from `src`; it evaluates
 * `main.js` exactly as Obsidian does and runs `onload` to completion.
 *
 * Requires `npm run build` to have produced main.js. CI builds before testing.
 */

// The plugin constructs views and settings tabs during onload, which touches DOM
// globals that bun does not provide by default.
installDom();

function emptyRecord(): PluginHostRecord {
	return { views: [], commands: [], ribbonIcons: [], icons: new Map(), settingTabs: 0, savedData: [] };
}

const DESKTOP = { isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false, isIosApp: false, isAndroidApp: false };
const MOBILE = { isDesktop: false, isDesktopApp: false, isMobile: true, isMobileApp: true, isIosApp: true, isAndroidApp: false };

interface LoadedPlugin {
	onload(): Promise<void>;
	onunload?(): void;
	settings: { userSkillsDir?: string };
	refreshAgentSkills(): Promise<void>;
	prepareBuiltinSkills(restore?: boolean): Promise<void>;
	agentSkillLoad(): {
		builtin: { install: { status: string }; diagnostics: unknown[] };
		user: {
			skills: Array<{ name: string; content: string; filePath: string; sourceDir: string }>;
			diagnostics: Array<{ code: string; message: string }>;
			searched: Array<{ dir: string; found: boolean | undefined; loaded: number }>;
		};
	};
	agentSkillCatalog(): Array<{ skill: { name: string; content: string; filePath: string }; source: string }>;
}

const loadedPlugins: LoadedPlugin[] = [];
const temporaryHomes: string[] = [];
const nodeRequire = createRequire(import.meta.url);
afterEach(() => {
	for (const plugin of loadedPlugins.splice(0)) plugin.onunload?.();
	for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * Loads the bundle under one platform shape and returns the constructed plugin.
 *
 * `modules` models which host modules the shell exposes, and `secretStorage`
 * what the app itself carries — together they describe a real device (mobile:
 * neither; Linux without a keyring: a store that answers but does not encrypt)
 * rather than a hypothetical one.
 */
function instantiate(options: {
	platform: Record<string, boolean>;
	modules?: Record<string, unknown>;
	exposeGlobalRequire?: boolean;
	secretStorage?: unknown;
	allowNodeBuiltins?: boolean;
	onRequire?: (id: string) => void;
	onDynamicImport?: (id: string) => void;
}): { plugin: LoadedPlugin; record: PluginHostRecord } {
	const record = emptyRecord();
	const modules: Record<string, unknown> = {
		obsidian: createObsidianHostModule(record, options.platform),
		...options.modules,
	};
	const exports = loadPluginBundle({
		modules,
		exposeGlobalRequire: options.exposeGlobalRequire,
		allowNodeBuiltins: options.allowNodeBuiltins ?? !options.platform.isMobile,
		onRequire: options.onRequire,
		onDynamicImport: options.onDynamicImport,
	});
	const PluginClass = (exports as { default?: unknown }).default ?? exports;
	expect(typeof PluginClass).toBe("function");
	const plugin = new (PluginClass as new (app: unknown, manifest: unknown) => LoadedPlugin)(
		createStubApp({ secretStorage: options.secretStorage }),
		{
			id: "piem",
			version: "test",
		},
	);
	loadedPlugins.push(plugin);
	return { plugin, record };
}

/** A full read surface, as a desktop Obsidian with keychain support provides. */
function workingSecretStorage(): unknown {
	const entries = new Map<string, string>();
	return {
		peekSecret: (id: string) => entries.get(id) ?? null,
		isEncryptionAvailable: () => true,
		listSecrets: () => [...entries.keys()],
	};
}

describe("built bundle loads under Obsidian's loader", () => {
	it("exports a constructible plugin class", () => {
		const { plugin } = instantiate({ platform: DESKTOP, secretStorage: workingSecretStorage() });

		expect(typeof plugin.onload).toBe("function");
	});

	it("completes onload on desktop with a working keychain", async () => {
		const { plugin, record } = instantiate({
			platform: DESKTOP,
			secretStorage: workingSecretStorage(),
		});

		await plugin.onload();

		expect(record.views).toContain("piem-chat-view");
		expect(record.commands.length).toBeGreaterThan(0);
		expect(record.settingTabs).toBe(1);
	});

	it("completes onload on desktop where the store cannot encrypt — Linux without a keyring", async () => {
		const secretStorage = {
			peekSecret: () => null,
			isEncryptionAvailable: () => false,
			listSecrets: () => [],
		};
		const { plugin, record } = instantiate({ platform: DESKTOP, secretStorage });

		await plugin.onload();

		expect(record.settingTabs).toBe(1);
	});

	it("completes onload on desktop where the store is only a partial shape", async () => {
		// A store missing `peekSecret` is treated as absent, the same as none at
		// all — calling into an incomplete store would throw somewhere deeper.
		const { plugin, record } = instantiate({
			platform: DESKTOP,
			secretStorage: { listSecrets: () => [] },
		});

		await plugin.onload();

		expect(record.settingTabs).toBe(1);
	});

	it("completes onload on desktop with no secretStorage on the app at all", async () => {
		const { plugin, record } = instantiate({ platform: DESKTOP });

		await plugin.onload();

		expect(record.settingTabs).toBe(1);
	});

	it("completes onload on desktop when the shell injects no global require", async () => {
		const { plugin, record } = instantiate({ platform: DESKTOP, exposeGlobalRequire: false });

		await plugin.onload();

		expect(record.settingTabs).toBe(1);
	});

	it("completes onload on desktop when the keychain probe throws", async () => {
		const secretStorage = {
			peekSecret: () => {
				throw new Error("Secure storage is not available.");
			},
			isEncryptionAvailable: () => {
				throw new Error("libsecret is not available");
			},
			listSecrets: () => {
				throw new Error("Secure storage is not available.");
			},
		};
		const { plugin, record } = instantiate({ platform: DESKTOP, secretStorage });

		await plugin.onload();

		expect(record.settingTabs).toBe(1);
	});

	it("completes onload on mobile, where no keychain exists either", async () => {
		const { plugin, record } = instantiate({ platform: MOBILE, exposeGlobalRequire: false });

		await plugin.onload();

		expect(record.views).toContain("piem-chat-view");
		expect(record.settingTabs).toBe(1);
	});

	it("registers the ribbon entry that is the only way to open the panel on mobile", async () => {
		const { plugin, record } = instantiate({ platform: MOBILE, exposeGlobalRequire: false });

		await plugin.onload();

		expect(record.ribbonIcons.length).toBeGreaterThan(0);
	});

	it("registers the brand icon and points every brand mark at it", async () => {
		// A ribbon button rendering a name nothing registered shows a blank slot,
		// which no other gate can see — the load succeeds, the tests pass, only
		// the corner of the UI is empty. This pins the contract: the brand icon
		// is registered, and every icon slot `onload` fills resolves to a
		// registered id. The id is a literal because this file imports no src
		// modules; a rename here failing the test is the point.
		const { plugin, record } = instantiate({ platform: MOBILE, exposeGlobalRequire: false });

		await plugin.onload();

		expect(record.icons.get("piem-brand") ?? "").toContain("<svg");
		for (const icon of record.ribbonIcons) {
			expect(record.icons.has(icon)).toBe(true);
		}
	});
});

describe("built bundle loads user skills through Pi's lazy Node environment", () => {
	for (const [name, modules] of [
		["rejects Node modules", {}],
		["returns undefined", { "node:fs/promises": undefined, "node:os": undefined, "node:path": undefined }],
		["returns partial modules", { "node:fs/promises": {}, "node:os": { homedir: () => "/home/tester" }, "node:path": {} }],
	] as const) {
		it(`skips scanning when the host ${name}, without initializing the bridge`, async () => {
			const requests: string[] = [];
			const dynamicImports: string[] = [];
			const { plugin } = instantiate({
				platform: MOBILE,
				modules,
				exposeGlobalRequire: false,
				allowNodeBuiltins: false,
				onRequire: (id) => requests.push(id),
				onDynamicImport: (id) => dynamicImports.push(id),
			});
			await plugin.onload();
			expect(requests.filter((id) => id.startsWith("node:"))).toEqual([]);
			plugin.settings.userSkillsDir = "C:\\Users\\smoke\\skills";
			await plugin.refreshAgentSkills();
			const user = plugin.agentSkillLoad().user;
			expect(user.skills).toEqual([]);
			expect(user.diagnostics).toEqual([]);
			expect(user.searched).toEqual(["~/.pi/agent/skills", "~/.agents/skills"].map((dir) => ({ dir, found: undefined, loaded: 0 })));
			expect(plugin.agentSkillCatalog().some((entry) => entry.source === "builtin")).toBe(false);
			expect(requests).not.toContain("node:child_process");
			expect(requests).not.toContain("node:readline");
			expect(requests.filter((id) => id.startsWith("node:"))).toEqual([]);
			expect(dynamicImports).toEqual([]);
		});
	}

	it("reads isolated real directories, honors precedence and refreshes edited skills", async () => {
		const home = mkdtempSync(join(tmpdir(), "piem-bundle-skills-"));
		temporaryHomes.push(home);
		const put = (path: string, name: string, body: string) => {
			const file = join(home, path);
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`);
			return file;
		};
		const custom = put("chosen/shared/SKILL.md", "shared", "chosen wins");
		put(".pi/agent/skills/shared/SKILL.md", "shared", "pi loses");
		put(".agents/skills/shared/SKILL.md", "shared", "agents loses");
		put(".pi/agent/skills/pi-only/SKILL.md", "pi-only", "pi body");
		put(".agents/skills/agents-only/SKILL.md", "agents-only", "agents body");
		put(".agents/skills/ignored/SKILL.md", "ignored", "ignored body");
		writeFileSync(join(home, ".agents/skills/.gitignore"), "ignored/\n");
		put("linked/linked/SKILL.md", "linked", "linked body");
		symlinkSync(join(home, "linked/linked"), join(home, ".agents/skills/linked"));
		symlinkSync(join(home, "missing"), join(home, ".agents/skills/dangling"));
		const requests: string[] = [];
		const forbidden: string[] = [];
		const refuse = (name: string) => () => { forbidden.push(name); throw new Error(`unexpected ${name}`); };
		const fs = nodeRequire("node:fs/promises") as typeof import("node:fs/promises");
		const { plugin } = instantiate({
			platform: DESKTOP,
			onRequire: (id) => requests.push(id),
			modules: {
				"node:os": { ...nodeRequire("node:os"), homedir: () => home },
				"node:child_process": { spawn: refuse("spawn") },
				"node:fs/promises": { ...fs, mkdtemp: refuse("mkdtemp"), writeFile: refuse("writeFile") },
			},
		});
		await plugin.onload();
		expect(requests.filter((id) => id.startsWith("node:"))).toEqual([]);
		plugin.settings.userSkillsDir = "~/chosen";
		await plugin.refreshAgentSkills();
		const user = plugin.agentSkillLoad().user;
		expect(user.diagnostics).toEqual([]);
		expect(user.skills.map((s) => s.name).sort()).toEqual(["agents-only", "linked", "pi-only", "shared"]);
		expect(user.skills.find((s) => s.name === "shared")).toMatchObject({ filePath: custom, sourceDir: "~/chosen", content: "chosen wins" });
		expect(user.searched).toEqual([
			{ dir: "~/chosen", found: true, loaded: 1 },
			{ dir: "~/.pi/agent/skills", found: true, loaded: 1 },
			{ dir: "~/.agents/skills", found: true, loaded: 2 },
		]);
		put("chosen/shared/SKILL.md", "shared", "edited body");
		await plugin.refreshAgentSkills();
		expect(plugin.agentSkillLoad().user.skills.find((s) => s.name === "shared")?.content).toBe("edited body");
		expect(requests).toContain("node:child_process");
		expect(forbidden).toEqual([]);
	});

	it("contains bridge initialization failure without inventing builtin files", async () => {
		const { plugin } = instantiate({
			platform: DESKTOP,
			allowNodeBuiltins: false,
			modules: {
				"node:fs/promises": nodeRequire("node:fs/promises"),
				"node:path": nodeRequire("node:path"),
				"node:os": { homedir: () => "/home/tester" },
			},
		});
		await plugin.onload();
		await plugin.refreshAgentSkills();
		const user = plugin.agentSkillLoad().user;
		expect(user.skills).toEqual([]);
		expect(user.diagnostics).toEqual([expect.objectContaining({ code: "read_failed" })]);
		expect(user.searched.every((entry) => entry.found === undefined)).toBe(true);
		expect(plugin.agentSkillCatalog().some((entry) => entry.source === "builtin")).toBe(false);
	});
});

describe("built bundle installs the separate official skill resource", () => {
	for (const platform of [DESKTOP, MOBILE]) {
		it(`installs from an empty vault on ${platform.isMobile ? "mobile without Node" : "desktop"}`, async () => {
			const record = emptyRecord();
			const host = createObsidianHostModule(record, platform) as Parameters<typeof createSkillVault>[0] & { requestUrl: (params: { url: string; headers?: Record<string, string> }) => Promise<unknown> };
			const { vault, contents } = createSkillVault(host);
			const payload = readFileSync("dist/builtin-skills.json", "utf8");
			const { version } = JSON.parse(readFileSync("manifest.json", "utf8")) as { version: string };
			let requests = 0;
			host.requestUrl = async (params) => {
				requests++;
				expect(params.url).toBe(`https://github.com/YoungSx/piem/releases/download/${version}/builtin-skills.json`);
				expect(params.headers?.authorization).toBeUndefined();
				return { status: 200, headers: {}, arrayBuffer: new TextEncoder().encode(payload).buffer };
			};
			const required: string[] = [];
			const result = loadPluginBundle({ modules: { obsidian: host }, allowNodeBuiltins: false, exposeGlobalRequire: false, onRequire: (id) => required.push(id) }) as { default: new (app: unknown, manifest: unknown) => LoadedPlugin };
			const app = createStubApp() as { vault: Record<string, unknown> };
			Object.assign(app.vault, vault);
			const plugin = new result.default(app, { id: "piem", version });
			loadedPlugins.push(plugin);
			await plugin.onload();
			await plugin.prepareBuiltinSkills();
			expect(plugin.agentSkillLoad().builtin.install.status).toBe("ready");
			expect(plugin.agentSkillLoad().builtin.diagnostics).toEqual([]);
			expect(requests).toBe(1);
			const catalog = plugin.agentSkillCatalog();
			expect(catalog.filter((entry) => entry.source === "builtin")).toHaveLength(7);
			const summary = catalog.find((entry) => entry.skill.name === "summarize")!;
			expect(summary.skill.filePath).toBe("/Piem/builtin-skills/summarize/SKILL.md");
			expect(contents.get(summary.skill.filePath.slice(1))).toContain("name: summarize");
			expect(summary.skill.content).toContain("Call get_active_note");
			// The separate user-level loader probes Node and is refused by this
			// host. Official files still load, with no Node environment started.
			expect(required.filter((id) => id.startsWith("node:")).every((id) => id === "node:fs/promises")).toBe(true);
			expect(plugin.agentSkillLoad().user.skills).toEqual([]);
			await plugin.refreshAgentSkills();
			expect(requests).toBe(1);
		});
	}
});
