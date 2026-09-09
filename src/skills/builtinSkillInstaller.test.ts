import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BuiltinSkillInstaller } from "./builtinSkillInstaller";
import type { BuiltinSkillFile } from "./builtinSkillPackage";
import { normalizeBuiltinSkillState, type BuiltinSkillState } from "./builtinSkillState";
import { sha256Hex } from "./skillHash";
import { stubWindowTimers } from "../testUtils/windowStub";

let restoreTimers: () => void;
const installers: BuiltinSkillInstaller[] = [];
beforeEach(() => { restoreTimers = stubWindowTimers(); });
afterEach(() => {
	for (const installer of installers.splice(0)) installer.dispose();
	restoreTimers();
});

const ENTRY = "summarize/SKILL.md";
const body = (text: string) => `---\nname: summarize\ndescription: Summarize notes\n---\n${text}`;
const files = (text: string): BuiltinSkillFile[] => [{ path: ENTRY, content: body(text) }];

async function harness(options: {
	version?: string;
	remote?: BuiltinSkillFile[];
	local?: Map<string, string>;
	state?: BuiltinSkillState;
	readPackage?: (signal: AbortSignal) => Promise<string>;
	timeoutMs?: number;
	beforeWrite?: (path: string, local: Map<string, string>) => void;
	failWrite?: boolean;
	dropWrite?: boolean;
	failSave?: () => boolean;
} = {}) {
	const version = options.version ?? "2.0.0";
	const remote = options.remote ?? files("Original instructions");
	const text = JSON.stringify({ schema: 1, version, files: remote });
	const asset = { sha256: await sha256Hex(text), bytes: new TextEncoder().encode(text).byteLength, names: [...new Set(remote.map((file) => file.path.split("/")[0]!))] };
	const local = options.local ?? new Map<string, string>();
	const store = { state: options.state };
	let downloads = 0;
	let writes = 0;
	let requestedUrl = "";
	let requestedHeaders: HeadersInit | undefined;
	const installer = new BuiltinSkillInstaller({
		version, asset, timeoutMs: options.timeoutMs,
		files: {
			read: async (path) => local.get(path),
			write: async (path, next, expected, signal) => {
				signal.throwIfAborted();
				options.beforeWrite?.(path, local);
				if (options.failWrite) throw new Error("read-only");
				if (local.get(path) !== expected) throw new Error("concurrent edit");
				writes++;
				if (!options.dropWrite) local.set(path, next);
			},
		},
		fetch: async (url, init) => {
			downloads++;
			requestedUrl = String(url);
			requestedHeaders = init?.headers;
			return new Response(text);
		},
		getState: () => store.state,
		saveState: async (state) => {
			if (options.failSave?.()) throw new Error("state write failed");
			store.state = structuredClone(state);
		},
		readPackage: options.readPackage,
	});
	installers.push(installer);
	return { installer, local, store, text, asset, downloads: () => downloads, writes: () => writes, url: () => requestedUrl, headers: () => requestedHeaders };
}

describe("official skill installation", () => {
	it("downloads the matching release once, creates real files, and records confirmed ownership", async () => {
		const h = await harness();
		const first = h.installer.prepare();
		expect(h.installer.prepare()).toBe(first);
		expect((await first).status).toBe("ready");
		expect(h.local.get(ENTRY)).toBe(body("Original instructions"));
		expect(h.store.state?.files[ENTRY]).toBe(await sha256Hex(h.local.get(ENTRY)!));
		expect(h.store.state?.complete).toBe(true);
		await h.installer.prepare();
		expect(h.downloads()).toBe(1);
		expect(h.url()).toBe("https://github.com/YoungSx/piem/releases/download/2.0.0/builtin-skills.json");
		expect(h.headers()).toBeUndefined();
	});

	it("reuses files across plugin reloads without downloading or overwriting edits", async () => {
		const first = await harness();
		await first.installer.prepare();
		first.local.set(ENTRY, body("My version"));
		const next = await harness({ local: first.local, state: first.store.state });
		const report = await next.installer.prepare();
		expect(report.status).toBe("ready");
		expect(report.modified).toEqual([ENTRY]);
		expect(next.downloads()).toBe(0);
		expect(next.writes()).toBe(0);
		expect(first.local.get(ENTRY)).toBe(body("My version"));
	});

	it("upgrades pristine files while keeping local edits and unknown existing files", async () => {
		const first = await harness();
		await first.installer.prepare();
		const upgrade = await harness({ version: "2.1.0", remote: files("New instructions"), local: first.local, state: first.store.state });
		expect((await upgrade.installer.prepare()).status).toBe("ready");
		expect(first.local.get(ENTRY)).toBe(body("New instructions"));
		first.local.set(ENTRY, body("User changes"));
		const conflict = await harness({ version: "2.2.0", remote: files("More changes"), local: first.local, state: upgrade.store.state });
		expect((await conflict.installer.prepare()).problems).toContainEqual({ path: ENTRY, reason: "modified" });
		expect(first.local.get(ENTRY)).toBe(body("User changes"));
		const unknown = await harness({ local: first.local });
		expect((await unknown.installer.prepare()).problems).toContainEqual({ path: ENTRY, reason: "unowned" });
		expect(unknown.writes()).toBe(0);
	});

	it("keeps a local edit when only the plugin version changed", async () => {
		const first = await harness();
		await first.installer.prepare();
		first.local.set(ENTRY, body("User changes"));
		const next = await harness({ version: "2.0.1", local: first.local, state: first.store.state });
		const report = await next.installer.prepare();
		expect(report.status).toBe("ready");
		expect(report.modified).toEqual([ENTRY]);
		expect(next.writes()).toBe(0);
	});

	it("keeps deleted skills deleted until explicit restoration, including across upgrades", async () => {
		const first = await harness();
		await first.installer.prepare();
		first.local.delete(ENTRY);
		const next = await harness({ version: "2.1.0", local: first.local, state: first.store.state });
		expect((await next.installer.prepare()).removed).toEqual(["summarize"]);
		expect(next.local.has(ENTRY)).toBe(false);
		expect(next.store.state?.removed).toEqual(["summarize"]);
		expect((await next.installer.prepare({ restore: true })).removed).toEqual([]);
		expect(next.local.has(ENTRY)).toBe(true);
	});

	it("does not roll newer files back on an older device", async () => {
		const first = await harness({ version: "3.0.0" });
		await first.installer.prepare();
		const old = await harness({ version: "2.0.0", local: first.local, state: first.store.state });
		expect((await old.installer.prepare()).status).toBe("newer");
		expect(old.downloads()).toBe(0);
		expect(old.writes()).toBe(0);
	});

	it("rejects corrupt downloads before writing and retries only on request", async () => {
		let corrupt = true;
		let calls = 0;
		const h = await harness({ readPackage: async () => { calls++; return corrupt ? "{}" : h.text; } });
		expect((await h.installer.prepare()).status).toBe("failed");
		expect(h.local.size).toBe(0);
		await h.installer.prepare();
		expect(calls).toBe(1);
		corrupt = false;
		expect((await h.installer.prepare({ retry: true })).status).toBe("ready");
		expect(calls).toBe(2);
	});

	it("reports write failures and unconfirmed writes without recording success", async () => {
		for (const options of [{ failWrite: true }, { dropWrite: true }]) {
			const h = await harness(options);
			expect((await h.installer.prepare()).status).toBe("issues");
			expect(h.store.state?.complete).toBe(false);
			expect(h.store.state?.files).toEqual({});
		}
	});

	it("refuses an edit arriving between planning and conditional write", async () => {
		const first = await harness();
		await first.installer.prepare();
		const h = await harness({
			version: "2.1.0", remote: files("Upgrade"), local: first.local, state: first.store.state,
			beforeWrite: (path, local) => local.set(path, body("Saved in the editor")),
		});
		expect((await h.installer.prepare()).status).toBe("issues");
		expect(h.local.get(ENTRY)).toBe(body("Saved in the editor"));
		expect(h.writes()).toBe(0);
	});

	it("recovers a crash after file write but before ownership save", async () => {
		let fail = true;
		const first = await harness({ failSave: () => fail });
		expect((await first.installer.prepare()).status).toBe("failed");
		expect(first.local.has(ENTRY)).toBe(true);
		expect(first.store.state).toBeUndefined();
		fail = false;
		expect((await first.installer.prepare({ retry: true })).status).toBe("ready");
		expect(first.writes()).toBe(1);
		expect(first.store.state?.complete).toBe(true);
	});

	it("times out an uncooperative transport and ignores its late response", async () => {
		let resolve!: (text: string) => void;
		const h = await harness({ timeoutMs: 5, readPackage: () => new Promise<string>((done) => { resolve = done; }) });
		expect((await h.installer.prepare()).status).toBe("failed");
		resolve(h.text);
		await Promise.resolve();
		await Promise.resolve();
		expect(h.writes()).toBe(0);
	});

	it("unloading ends a pending download and prevents late writes", async () => {
		let started!: () => void;
		const downloading = new Promise<void>((done) => { started = done; });
		let resolve!: (text: string) => void;
		const h = await harness({ readPackage: () => { started(); return new Promise<string>((done) => { resolve = done; }); } });
		const task = h.installer.prepare();
		await downloading;
		h.installer.dispose();
		await task;
		resolve(h.text);
		await Promise.resolve();
		expect(h.writes()).toBe(0);
	});

	it("keeps the entry inactive when a referenced resource cannot be installed", async () => {
		const h = await harness({ remote: [{ path: "summarize/references/detail.md", content: "Resource" }, ...files("Read references/detail.md")], failWrite: true });
		expect((await h.installer.prepare()).status).toBe("issues");
		expect(h.local.has(ENTRY)).toBe(false);
	});

	it("drops malformed ownership rather than authorizing an overwrite", () => {
		expect(normalizeBuiltinSkillState({ schema: 1, version: "2.0.0", digest: "a".repeat(64), complete: true, files: { "../outside.md": "b".repeat(64) }, removed: [] })).toBeUndefined();
	});
});
