/**
 * Per-extension JSON configuration, persisted in plugin settings.
 *
 * Audited community extensions expect a writable agent directory holding one
 * small JSON file each — `clarify.json`, `web-search.json`. There is no such
 * directory on mobile, and the bridge must never reach outside the Vault API,
 * so this stands in for it: a namespaced key/value map living in `data.json`.
 *
 * Ownership is structural rather than a list of known paths. Each extension is
 * handed a platform view built for its own id (see `extensionPlatform.ts`), and
 * that view is the only way to name a file — the owner comes from the view's
 * construction, never from the path the extension supplied. `pi-clarify` cannot
 * address `pi-web-search`'s namespace because it holds no view that can spell
 * it, and a `..` segment is rejected before it is ever split.
 *
 * Some entries are not stored text but a {@link ExtensionConfigProjection} over
 * settings the plugin already owns, so a value with its own UI keeps one source
 * of truth instead of a shadow copy that can disagree.
 *
 * Writes stage synchronously and persist through the caller's serializing
 * queue, because `writeFileSync` cannot await. Staging alone is not success:
 * {@link ExtensionConfigStore.flush} is what the host awaits before telling a
 * user their change was saved, and a rejected save restores the previous value.
 */

/** Root every extension config path lives under. Not a Vault path. */
export const EXTENSION_CONFIG_ROOT = "/extensions/config";

/**
 * Bounds on untrusted, extension-supplied keys and payloads.
 *
 * `data.json` is read and rewritten whole on every settings save, so an
 * extension that could append without limit would slow every later write.
 */
const MAX_OWNERS = 8;
const MAX_FILES = 4;
const MAX_BYTES = 4096;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]*\.json$/i;
const OWNER_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const has = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

/** Stored snapshots: extension id, then file name, then JSON text. */
export type ExtensionConfigData = Record<string, Record<string, string>>;

/** A host-owned value that answers as a config file without being stored as one. */
export interface ExtensionConfigProjection {
	owner: string;
	file: string;
	read(): string | undefined;
	/** `undefined` clears the value. Rejects rather than reporting a false save. */
	write(text: string | undefined): Promise<void>;
}

export interface ExtensionConfigStoreOptions {
	getData(): ExtensionConfigData | undefined;
	/** Replaces the stored map, or removes it when the last entry is cleared. */
	setData(data: ExtensionConfigData | undefined): void;
	/** Writes the settings file. Must reject when nothing was persisted. */
	persist(): Promise<void>;
	/** Serializes against every other extension-driven settings write. */
	queue<T>(work: () => Promise<T>): Promise<T>;
	projections?: readonly ExtensionConfigProjection[];
}

export interface ExtensionConfigStore {
	read(owner: string, file: string): string | undefined;
	list(owner: string): string[];
	/** Stages a value and enqueues its save. Throws on a rejected name or size. */
	stage(owner: string, file: string, text: string | undefined): void;
	/** Resolves once every staged value is persisted; rejects if one was not. */
	flush(): Promise<void>;
	/** Observe saves without clearing a failure an enclosing command must see. */
	settled(): Promise<void>;
}

function assertName(value: string, pattern: RegExp, what: string): string {
	if (!pattern.test(value)) throw new Error(`Invalid extension config ${what}: ${value}`);
	return value;
}

/** Normalizes persisted data, dropping anything outside the bounds above. */
export function normalizeExtensionConfig(value: unknown): ExtensionConfigData | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data: ExtensionConfigData = {};
	let owners = 0;
	for (const [owner, files] of Object.entries(value)) {
		if (owners >= MAX_OWNERS || !OWNER_NAME.test(owner)) continue;
		if (!files || typeof files !== "object" || Array.isArray(files)) continue;
		const kept: Record<string, string> = {};
		let count = 0;
		for (const [file, text] of Object.entries(files as Record<string, unknown>)) {
			if (count >= MAX_FILES || !FILE_NAME.test(file)) continue;
			if (typeof text !== "string" || text.length > MAX_BYTES) continue;
			kept[file] = text;
			count++;
		}
		if (count) { data[owner] = kept; owners++; }
	}
	return owners ? data : undefined;
}

export function createExtensionConfigStore(options: ExtensionConfigStoreOptions): ExtensionConfigStore {
	const projections = new Map((options.projections ?? []).map(entry => [`${entry.owner}/${entry.file}`, entry]));
	let tail: Promise<void> = Promise.resolve();
	const track = (work: Promise<void>): void => {
		// Retain the rejection for flush() while keeping the chain itself alive,
		// so one failed save cannot strand every later write behind it.
		tail = tail.then(() => work, () => work);
	};
	return {
		list: owner => {
			const names = new Set(Object.keys(options.getData()?.[owner] ?? {}));
			for (const entry of options.projections ?? []) {
				if (entry.owner === owner && entry.read() !== undefined) names.add(entry.file);
			}
			return [...names].sort();
		},
		read: (owner, file) => {
			const projection = projections.get(`${owner}/${file}`);
			if (projection) return projection.read();
			return options.getData()?.[owner]?.[file];
		},
		stage: (owner, file, text) => {
			assertName(owner, OWNER_NAME, "owner");
			assertName(file, FILE_NAME, "file name");
			if (text !== undefined && text.length > MAX_BYTES) throw new Error(`Extension config files are limited to ${MAX_BYTES} bytes.`);
			const projection = projections.get(`${owner}/${file}`);
			if (projection) { track(options.queue(() => projection.write(text))); return; }
			const current = options.getData();
			const files = current?.[owner];
			if (text !== undefined) {
				if (!files && Object.keys(current ?? {}).length >= MAX_OWNERS) throw new Error(`At most ${MAX_OWNERS} extensions may store configuration.`);
				if (files && !has(files, file) && Object.keys(files).length >= MAX_FILES) throw new Error(`At most ${MAX_FILES} configuration files per extension are supported.`);
			} else if (!files || !has(files, file)) return;
			// Rebuilt rather than mutated so a rejected save can restore the
			// exact previous map, including the absence of an owner.
			const previous = current;
			const next: ExtensionConfigData = { ...current };
			const owned = { ...files };
			if (text === undefined) delete owned[file]; else owned[file] = text;
			if (Object.keys(owned).length) next[owner] = owned; else delete next[owner];
			const value = Object.keys(next).length ? next : undefined;
			options.setData(value);
			track(options.queue(async () => {
				try { await options.persist(); }
				catch (error) {
					if (options.getData() === value) options.setData(previous);
					throw error;
				}
			}));
		},
		flush: () => {
			const pending = tail;
			// Absorb the settled rejection so the same failure is reported once.
			tail = pending.catch(() => undefined);
			return pending;
		},
		settled: () => tail,
	};
}
