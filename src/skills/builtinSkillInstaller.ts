import type { FetchFn } from "../net/obsidianFetch";
import { readBuiltinSkillPackage, type BuiltinSkillAsset, type BuiltinSkillFile } from "./builtinSkillPackage";
import { emptyBuiltinSkillReport, isNewerSkillVersion, type BuiltinSkillReport, type BuiltinSkillState } from "./builtinSkillState";
import type { BuiltinSkillFiles } from "./builtinSkillVault";
import { sha256Hex } from "./skillHash";

interface InstallerOptions {
	version: string;
	asset: BuiltinSkillAsset;
	files: BuiltinSkillFiles;
	fetch: FetchFn;
	getState(): BuiltinSkillState | undefined;
	saveState(state: BuiltinSkillState): Promise<void>;
	/** Development/tests can provide the build output without a published tag. */
	readPackage?: (signal: AbortSignal) => Promise<string>;
	timeoutMs?: number;
}

/** One preparation attempt per load; retry/restore are explicit settings actions. */
export class BuiltinSkillInstaller {
	private report = emptyBuiltinSkillReport();
	private pending?: Promise<BuiltinSkillReport>;
	private controller?: AbortController;
	private attempted = false;
	private disposed = false;

	constructor(private readonly options: InstallerOptions) {}

	getReport(): BuiltinSkillReport {
		return structuredClone(this.report);
	}

	prepare(options: { retry?: boolean; restore?: boolean } = {}): Promise<BuiltinSkillReport> {
		if (this.pending) return this.pending;
		if (this.disposed || (this.attempted && !options.retry && !options.restore)) return Promise.resolve(this.getReport());
		this.attempted = true;
		const report: BuiltinSkillReport = { ...emptyBuiltinSkillReport(), status: "preparing" };
		this.report = report;
		const controller = new AbortController();
		this.controller = controller;
		const timer = window.setTimeout(() => controller.abort(new Error("Built-in skill preparation timed out.")), this.options.timeoutMs ?? 15_000);
		const task = abortable(this.run(controller.signal, options.restore === true, report), controller.signal).catch((error: unknown) => {
			report.status = "failed";
			report.error = error instanceof Error ? error.message : String(error);
		}).finally(() => {
			window.clearTimeout(timer);
			this.controller = undefined;
			this.pending = undefined;
		});
		this.pending = task.then(() => this.getReport());
		return this.pending;
	}

	dispose(): void {
		this.disposed = true;
		this.controller?.abort(new Error("Plugin unloaded."));
	}

	private async run(signal: AbortSignal, restore: boolean, report: BuiltinSkillReport): Promise<void> {
		const { version, asset, files } = this.options;
		const previous = this.options.getState();
		if (previous && isNewerSkillVersion(previous.version, version)) {
			report.status = "newer";
			return;
		}
		const state: BuiltinSkillState = {
			schema: 1, version, digest: asset.sha256, complete: false,
			files: { ...previous?.files }, removed: restore ? [] : [...(previous?.removed ?? [])],
		};
		const local = new Map<string, string | undefined>();
		const unreadable = new Set<string>();
		const paths = new Set([...Object.keys(state.files), ...asset.names.map((name) => `${name}/SKILL.md`)]);
		for (const path of paths) {
			signal.throwIfAborted();
			try {
				local.set(path, await files.read(path));
			} catch (error) {
				signal.throwIfAborted();
				unreadable.add(path);
				report.problems.push({ path, reason: "read", message: String(error) });
			}
		}
		signal.throwIfAborted();
		for (const name of asset.names) {
			const path = `${name}/SKILL.md`;
			if (!restore && state.files[path] && local.has(path) && local.get(path) === undefined && !state.removed.includes(name)) state.removed.push(name);
		}
		report.removed = [...state.removed];
		if (previous?.digest === asset.sha256 && previous.complete && !restore
			&& asset.names.every((name) => state.files[`${name}/SKILL.md`] || state.removed.includes(name))) {
			for (const [path, content] of local) {
				if (content !== undefined && state.files[path] && await sha256Hex(content) !== state.files[path]) report.modified.push(path);
				if (content === undefined && !state.removed.includes(path.split("/")[0] ?? "")) report.problems.push({ path, reason: "modified" });
			}
			state.complete = report.problems.length === 0;
			if (JSON.stringify(state) !== JSON.stringify(previous)) await this.persist(state, signal);
			report.status = state.complete ? "ready" : "issues";
			return;
		}
		// A canceled network request may still finish in requestUrl. The race stops
		// waiting, and the signal fences below prevent its late bytes from writing.
		const text = await abortable(this.download(signal), signal);
		const pack = await readBuiltinSkillPackage(text, asset, version);
		signal.throwIfAborted();
		const remotePaths = new Set(pack.files.map((file) => file.path));
		for (const path of Object.keys(state.files)) {
			if (!remotePaths.has(path)) report.problems.push({ path, reason: "retired" });
		}
		for (const name of asset.names) {
			if (state.removed.includes(name)) continue;
			const resources = pack.files.filter((file) => file.path.startsWith(`${name}/`))
				.sort((a, b) => Number(a.path.endsWith("/SKILL.md")) - Number(b.path.endsWith("/SKILL.md")));
			for (const file of resources) {
				signal.throwIfAborted();
				if (unreadable.has(file.path)) break;
				if (!await this.installFile(file, state, local, signal, restore, report)) break;
				await this.persist(state, signal);
			}
		}
		state.complete = report.problems.length === 0;
		await this.persist(state, signal);
		report.status = state.complete ? "ready" : "issues";
	}

	private async download(signal: AbortSignal): Promise<string> {
		if (this.options.readPackage) return this.options.readPackage(signal);
		const url = `https://github.com/YoungSx/piem/releases/download/${encodeURIComponent(this.options.version)}/builtin-skills.json`;
		const response = await this.options.fetch(url, { signal, credentials: "omit" });
		if (!response.ok) throw new Error(`Built-in skill download failed (${response.status}).`);
		return response.text();
	}

	private async installFile(file: BuiltinSkillFile, state: BuiltinSkillState, local: Map<string, string | undefined>, signal: AbortSignal, restore: boolean, report: BuiltinSkillReport): Promise<boolean> {
		try {
			const current = local.has(file.path) ? local.get(file.path) : await this.options.files.read(file.path);
			signal.throwIfAborted();
			const nextHash = await sha256Hex(file.content);
			if (current === file.content) {
				state.files[file.path] = nextHash;
				return true;
			}
			const baseline = state.files[file.path];
			if (current !== undefined && baseline === nextHash) {
				report.modified.push(file.path);
				return true;
			}
			if (current !== undefined && (!baseline || await sha256Hex(current) !== baseline)) {
				report.problems.push({ path: file.path, reason: baseline ? "modified" : "unowned" });
				return false;
			}
			if (current === undefined && baseline && !file.path.endsWith("/SKILL.md") && !restore) {
				report.problems.push({ path: file.path, reason: "modified" });
				return false;
			}
			signal.throwIfAborted();
			this.assertVersion(state);
			await this.options.files.write(file.path, file.content, current, signal);
			signal.throwIfAborted();
			if (await this.options.files.read(file.path) !== file.content) throw new Error("Skill write could not be confirmed.");
			state.files[file.path] = nextHash;
			return true;
		} catch (error) {
			signal.throwIfAborted();
			report.problems.push({ path: file.path, reason: "write", message: String(error) });
			return false;
		}
	}

	private async persist(state: BuiltinSkillState, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		this.assertVersion(state);
		await this.options.saveState(structuredClone(state));
	}

	private assertVersion(state: BuiltinSkillState): void {
		const current = this.options.getState();
		if (current && isNewerSkillVersion(current.version, state.version)) throw new Error("A newer skill version was installed during preparation.");
	}
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let rejectAbort: () => void = () => undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			rejectAbort = () => {
				const reason = signal.reason instanceof Error ? signal.reason : new Error("Skill preparation aborted.");
				reject(reason);
			};
			signal.addEventListener("abort", rejectAbort, { once: true });
		})]);
	} finally {
		signal.removeEventListener("abort", rejectAbort);
	}
}
