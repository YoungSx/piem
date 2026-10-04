import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-durable/env";
import { resolve, dirname } from "pathe";

/** One invocation's files: no global fs replacement, caches or desktop imports. */
export async function resourceSnapshot(env: ExecutionEnv, roots: string[], context: Context) {
	const files = new Map<string, { info: FileInfo; source: string; content?: string }>();
	const requested = new Set<string>();
	const requestedInfo = new Map<string, string>();
	const absent = new Set<string>();
	const errors = new Map<string, Error>();
	const children = new Map<string, FileInfo[]>();
	const canonical = new Map<string, string>();
	const visited = new Set<string>();
	const key = (path: string | URL) => resolve(String(path).replace(/\\/g, "/"));
	async function visit(input: string): Promise<void> {
		context.abortSignal?.throwIfAborted();
		const absolute = await env.absolutePath(input, context);
		if (!absolute.ok) { errors.set(key(input), absolute.error); return; }
		const path = key(absolute.value);
		if (visited.has(path)) return;
		visited.add(path);
		let info = await env.fileInfo(absolute.value, context);
		if (!info.ok) { if (info.error.code !== "not_found") errors.set(path, info.error); else absent.add(path); return; }
		const real = await env.canonicalPath(absolute.value, context);
		canonical.set(path, real.ok ? key(real.value) : path);
		if (info.value.kind === "symlink" && real.ok) {
			const target = await env.fileInfo(real.value, context);
			if (!target.ok) { errors.set(path, target.error); return; }
			info = { ok: true, value: { ...target.value, path: absolute.value, name: info.value.name } };
		}
		files.set(path, { info: info.value, source: absolute.value });
		if (info.value.kind === "directory") {
			const identity = canonical.get(path)!;
			for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
				if (canonical.get(parent) === identity) { children.set(path, []); return; }
			}
			const listed = await env.listDir(absolute.value, context);
			if (!listed.ok) { errors.set(path, listed.error); return; }
			children.set(path, listed.value);
		}
	}
	for (const root of roots) await visit(root);
	const missing = (path: string) => Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
	function get(path: string | URL) {
		const name = key(path);
		const error = errors.get(name);
		if (error) throw error;
		const file = files.get(name);
		if (!file) {
			if (!absent.has(name)) requestedInfo.set(name, String(path));
			throw missing(name);
		}
		return file;
	}
	const stat = (info: FileInfo) => ({
		isDirectory: () => info.kind === "directory", isFile: () => info.kind === "file", isSymbolicLink: () => info.kind === "symlink",
		size: info.size, mtimeMs: info.mtimeMs, ino: info.path, dev: "vault",
	});
	return {
		roots: roots.map(root => key(root)), errors,
		// The original synchronous loader decides which files matter (including
		// ignore rules and skill-root boundaries). Hydrate only its requested
		// reads, then rerun against the same invocation snapshot.
		async load<T>(read: () => T): Promise<T> {
			while (true) {
				const result = read();
				if (!requested.size && !requestedInfo.size) return result;
				for (const input of requestedInfo.values()) await visit(input);
				requestedInfo.clear();
				for (const path of requested) {
					const file = files.get(path)!;
					const content = await env.readTextFile(file.source, context);
					if (content.ok) file.content = content.value;
					else errors.set(path, content.error);
				}
				requested.clear();
			}
		},
		platform: {
			constants: { F_OK: 0, R_OK: 4 },
			existsSync: (path: string | URL) => {
				const name = key(path);
				if (!files.has(name) && !errors.has(name) && !absent.has(name)) requestedInfo.set(name, String(path));
				return files.has(name) || errors.has(name);
			},
			accessSync: (path: string | URL) => { get(path); },
			readFileSync: (path: string | URL) => {
				const file = get(path);
				if (file.content === undefined) {
					requested.add(key(path));
					throw missing(String(path));
				}
				return file.content;
			},
			statSync: (path: string | URL) => stat(get(path).info),
			realpathSync: (path: string | URL) => { get(path); return canonical.get(key(path)) ?? key(path); },
			readdirSync: (path: string | URL, options?: { withFileTypes?: boolean }) => {
				get(path);
				return (children.get(key(path)) ?? []).map(info => options?.withFileTypes ? { name: info.name, parentPath: dirname(info.path), ...stat(info) } : info.name);
			},
		},
	};
}
