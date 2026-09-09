import type { HostRequire } from "./nodeSkillsHost";
import { Platform } from "obsidian";

/**
 * What counts as a usable extra directory for user-level skills.
 *
 * The two locations in {@link import("./userSkills").USER_SKILLS_DIRS} are the
 * ones pi itself reads, so they are not a choice anyone made here. A user whose
 * skills live somewhere else — a sync folder, a path their company mandates —
 * had no way to be seen short of editing source. This module is the rule set for
 * the single directory they can name themselves, and nothing more.
 *
 * Pure path logic, following {@link import("../session/sessionDir")}: no copy,
 * no translator, no filesystem, and `undefined` rather than a throw, so a
 * settings field can report the problem in place while the loader carries on
 * with the built-in pair. The wording for that report belongs in a copy module,
 * where a translator can own it.
 *
 * What this deliberately does not answer is whether the directory exists. It is
 * a host path, read through Pi's NodeExecutionEnv, and the settings panel that
 * validates it may be running on a phone with no filesystem
 * to ask. The only questions answered here are the ones a string can answer.
 */

/**
 * Example shown in the empty field.
 *
 * A named constant rather than a literal at the call site, for two reasons that
 * point the same way. The copy gate (`scripts/check-copy.mjs`) rejects a string
 * handed to `setPlaceholder`, and rightly, because most placeholders are copy.
 * This one is not: a path is the same text in every language, and a translated
 * `~/文档/skills` would name a directory that does not exist. So it lives beside
 * the rules it illustrates rather than in a translation table.
 *
 * It illustrates rather than defaults. An empty field means no extra directory,
 * so nothing here is ever read as a value the setting falls back to.
 */
export const USER_SKILLS_DIR_PLACEHOLDER = "~/Documents/skills";

/**
 * The slice of `node:path` this module needs.
 *
 * Declared structurally rather than as `typeof import("node:path")` so the file
 * names no node module even in a type position, and so {@link resolvePathFlavours}
 * has members to check one at a time. Both flavours are needed because the same
 * stored value is typed on whichever machine the user is sitting at, and the
 * verdict must not depend on which one that was.
 */
interface PathFlavours {
	win32: { isAbsolute: (path: string) => boolean };
	posix: { isAbsolute: (path: string) => boolean };
}

/**
 * Obsidian's desktop renderer exposes `require` (Electron with node
 * integration); declared here because the plugin never imports node builtins
 * statically — reading the free identifier is itself what throws on mobile, so
 * the read has to sit inside a function the caller guards.
 */
declare const require: (id: string) => unknown;

/** The bundle's own `require`, wrapped so the throwing read stays behind a call. */
function hostModuleLookup(id: string): unknown {
	return require(id);
}

/**
 * The two predicates, or `undefined` when this platform has none.
 *
 * Guarded member by member, for the reason
 * {@link import("./nodeSkillsHost").nodeSkillsHome} also guards against: a missing
 * `require` throws, but a mobile shim that answers every id with `undefined`
 * throws nothing, and returning its answer verbatim hands back a
 * populated-looking object whose members blow up on the first call. So the check
 * is the functions actually invoked, which keeps the truthiness of the result
 * meaning what its one reader assumes.
 */
function resolvePathFlavours(lookup: HostRequire): PathFlavours | undefined {
	try {
		const candidate = lookup("node:path") as { win32?: { isAbsolute?: unknown }; posix?: { isAbsolute?: unknown } } | undefined;
		if (typeof candidate?.win32?.isAbsolute !== "function" || typeof candidate?.posix?.isAbsolute !== "function") {
			return undefined;
		}
		return candidate as PathFlavours;
	} catch {
		return undefined;
	}
}

/**
 * Whether a path is rooted at the user's own home directory.
 *
 * Exactly `~`, `~/…`, or `~\…`. `~user/skills` is left out on purpose: nothing
 * downstream expands another user's home, so such a path would fall through to
 * being resolved as relative — the silent mismatch
 * {@link normalizeUserSkillsDir} rejects relative paths to avoid.
 */
function isHomeRooted(path: string): boolean {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

/**
 * Coerces a stored or typed directory into one the skill loader can be handed.
 *
 * Accepted: a `~`-rooted path, and an absolute path under either platform
 * flavour — POSIX `/home/me/skills`, Windows `C:\Users\me\skills`, UNC
 * `\\server\share\skills`. `~` is how the built-in entries are already written
 * and the only spelling of "my home" that survives being synced between
 * machines, so it is kept verbatim; expanding it belongs to the env that
 * resolves the path, not to the field that accepts it.
 *
 * Rejected: a bare relative path. There is no base to resolve it against that
 * the user would recognise — the user-skills environment runs
 * with the home directory as its cwd, so `skills` would quietly mean
 * `~/skills`, a directory the user never named. Nobody reports that as a bug,
 * because nothing looks wrong.
 *
 * `..` is allowed, and this is the one rule that inverts
 * {@link import("../session/sessionDir").normalizeSessionDir}. There, `..` must
 * be refused because the vault is a security boundary and a folder that escapes
 * it escapes the address space the plugin is permitted to write. Here the path
 * is outside the vault by definition, so `..` escapes nothing — it is ordinary
 * navigation, and `~/Sync/../shared/skills` is a path real machines really have.
 * Refusing it would be a rule enforcing a boundary that is not there.
 *
 * @param hostRequire Overrides the module lookup, following
 * {@link import("./nodeSkillsHost").nodeSkillsHome}: `undefined` means "use the
 * host's", and an explicit `null` models a shell exposing none — the only way a
 * test can reach the no-node branch, since the bundle's `require` is resolved at
 * evaluation time.
 */
export function normalizeUserSkillsDir(input: unknown, hostRequire?: HostRequire | null): string | undefined {
	if (typeof input !== "string") {
		return undefined;
	}
	// Whitespace is the only tidying that is safe on a path this module cannot
	// resolve. A trailing separator looks like noise and is not: `/` and `C:\`
	// are roots, and `path.win32.isAbsolute("C:")` is false, so trimming one off
	// would turn a valid path into a rejected one.
	const trimmed = input.trim();
	if (!trimmed) {
		return undefined;
	}
	// A synced desktop path is inert on mobile. Preserve it without asking
	// the host for node:path, which emits a notice in Obsidian's emulator.
	if (Platform.isMobile) return trimmed;
	if (isHomeRooted(trimmed)) {
		return trimmed;
	}
	const lookup = hostRequire === undefined ? hostModuleLookup : hostRequire;
	const flavours = lookup ? resolvePathFlavours(lookup) : undefined;
	if (!flavours) {
		// Without node, telling absolute from relative would mean re-implementing
		// two platforms' rules, and there is no filesystem for either answer to
		// matter: on mobile the user-skills loader skips the scan, so
		// this directory is inert whatever it says. Faced with a verdict that
		// cannot be trusted and cannot be acted on, accepting is the safer error.
		// The value is shared settings — a phone that rejected the Windows path
		// its desktop configured would report a problem that does not exist, and
		// hand the caller a reason to drop a setting that works. The flavour rule
		// is enforced on the platform that actually reads the directory.
		return trimmed;
	}
	return flavours.posix.isAbsolute(trimmed) || flavours.win32.isAbsolute(trimmed) ? trimmed : undefined;
}
