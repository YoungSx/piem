import { describe, expect, it } from "bun:test";
import type { HostRequire } from "./nodeSkillsHost";
import { installObsidianStub, platformMock } from "../testUtils/obsidianStub";

installObsidianStub();
const { normalizeUserSkillsDir, USER_SKILLS_DIR_PLACEHOLDER } = await import("./userSkillsDir");

/**
 * The extra skills directory is the one place a user names a path outside the
 * vault, so the rules here are the whole of what stops a typo from becoming a
 * directory nobody reads and nobody is told about.
 *
 * Two things make these tests unusual for this repo. Both platform flavours are
 * asserted from one runner, because the same stored value is typed on whichever
 * machine the user happens to be at and synced to the other; a rule that only
 * held on the runner's own OS would be no rule at all. And the no-node branch is
 * asserted explicitly, because the settings panel exists on mobile, where this
 * validator has to answer without a filesystem to consult.
 *
 * The module reaches `node:path` through the host lookup, so a `null` lookup is
 * how a test reaches the mobile branch on a desktop runner — the same injection
 * point {@link import("./nodeSkillsHost").nodeSkillsHome} uses, for the same reason.
 */

/** A host serving nothing, as a mobile shim does: present, and answering `undefined`. */
const emptyRequire: HostRequire = () => undefined;

/** A host that has `require` but cannot serve builtins, as a throwing shell does. */
const throwingRequire: HostRequire = (id: string) => {
	throw new Error(`Cannot find module '${id}'`);
};

/** The host shapes that leave the validator with no way to judge absoluteness. */
const nodelessHosts: Array<[string, HostRequire | null]> = [
	["a shell exposing no require at all", null],
	["a shim answering every id with undefined", emptyRequire],
	["a shell whose require throws", throwingRequire],
	["a shell serving a path module with no flavours", () => ({ isAbsolute: () => true })],
	["a shell serving the win32 flavour but not the posix one", () => ({ win32: { isAbsolute: () => true } })],
];

describe("normalizeUserSkillsDir on a host with node", () => {
	it("keeps a home-rooted path verbatim, the spelling the built-in directories use", () => {
		// `~` is not expanded here: it is the only spelling of "my home" that
		// survives being synced between two machines whose homes differ.
		expect(normalizeUserSkillsDir("~/Documents/skills")).toBe("~/Documents/skills");
		expect(normalizeUserSkillsDir("~")).toBe("~");
	});

	it("accepts a home-rooted path spelled with a backslash, as a Windows user types it", () => {
		expect(normalizeUserSkillsDir("~\\Documents\\skills")).toBe("~\\Documents\\skills");
	});

	it("accepts a POSIX absolute path", () => {
		expect(normalizeUserSkillsDir("/home/me/skills")).toBe("/home/me/skills");
	});

	it("accepts a Windows drive path, on a POSIX runner as much as on Windows", () => {
		// The verdict must not depend on the machine judging it: a value stored
		// from a Windows desktop is read back by every other client of the vault.
		expect(normalizeUserSkillsDir("C:\\Users\\me\\skills")).toBe("C:\\Users\\me\\skills");
		expect(normalizeUserSkillsDir("C:/Users/me/skills")).toBe("C:/Users/me/skills");
	});

	it("accepts a UNC share, which is where a company-mandated path usually lives", () => {
		expect(normalizeUserSkillsDir("\\\\server\\share\\skills")).toBe("\\\\server\\share\\skills");
	});

	it("allows .., because a path outside the vault has no boundary left to escape", () => {
		// The rule that inverts from the chat folder's. There, `..` breaks out of
		// the vault, which is a security boundary; here the path is already
		// outside it, so `..` is navigation and refusing it would reject paths
		// real machines really have.
		expect(normalizeUserSkillsDir("~/Sync/../shared/skills")).toBe("~/Sync/../shared/skills");
		expect(normalizeUserSkillsDir("/home/me/../shared/skills")).toBe("/home/me/../shared/skills");
		expect(normalizeUserSkillsDir("C:\\Users\\me\\..\\shared")).toBe("C:\\Users\\me\\..\\shared");
	});

	it("trims surrounding whitespace, which a pasted path arrives with", () => {
		expect(normalizeUserSkillsDir("  ~/Documents/skills  ")).toBe("~/Documents/skills");
	});

	it("leaves a trailing separator alone, since trimming one can unmake a root", () => {
		// `C:\` is a path and `C:` is not, so tidying the separator away would
		// turn an accepted value into a rejected one.
		expect(normalizeUserSkillsDir("C:\\")).toBe("C:\\");
		expect(normalizeUserSkillsDir("/home/me/skills/")).toBe("/home/me/skills/");
	});

	it("rejects a bare relative path, which would silently mean somewhere else", () => {
		// The user-skills environment resolves against home, so `skills` would read
		// `~/skills` — a directory the user never typed, and a mismatch with no
		// symptom to report.
		expect(normalizeUserSkillsDir("skills")).toBeUndefined();
		expect(normalizeUserSkillsDir("./skills")).toBeUndefined();
		expect(normalizeUserSkillsDir("../skills")).toBeUndefined();
		expect(normalizeUserSkillsDir("Documents/skills")).toBeUndefined();
	});

	it("rejects another user's home, which nothing downstream expands", () => {
		// `~user` is not home-rooted for our purposes; accepting it would let it
		// fall through to being resolved as a relative path.
		expect(normalizeUserSkillsDir("~user/skills")).toBeUndefined();
	});

	it("rejects a drive letter with no path, which names no directory", () => {
		expect(normalizeUserSkillsDir("C:")).toBeUndefined();
	});

	it("rejects empty and whitespace-only input, which is how the field says none", () => {
		expect(normalizeUserSkillsDir("")).toBeUndefined();
		expect(normalizeUserSkillsDir("   ")).toBeUndefined();
	});

	it("rejects values that are not strings at all, as a hand-edited data.json may hold", () => {
		expect(normalizeUserSkillsDir(undefined)).toBeUndefined();
		expect(normalizeUserSkillsDir(null)).toBeUndefined();
		expect(normalizeUserSkillsDir(42)).toBeUndefined();
		expect(normalizeUserSkillsDir(["~/skills"])).toBeUndefined();
	});
});

describe("normalizeUserSkillsDir where node is unavailable", () => {
	it("preserves a synced desktop path on mobile without resolving any host module", () => {
		const before = platformMock.isMobile;
		const requested: string[] = [];
		platformMock.isMobile = true;
		try {
			const lookup: HostRequire = (id) => { requested.push(id); throw new Error("Node lookup emits a mobile notice"); };
			expect(normalizeUserSkillsDir(" C:\\Users\\smoke\\skills ", lookup)).toBe("C:\\Users\\smoke\\skills");
			expect(requested).toEqual([]);
		} finally {
			platformMock.isMobile = before;
		}
	});

	for (const [shape, lookup] of nodelessHosts) {
		describe(shape, () => {
			it("answers without throwing, since the settings panel runs here too", () => {
				expect(() => normalizeUserSkillsDir("~/Documents/skills", lookup)).not.toThrow();
			});

			it("still accepts a home-rooted path, which needs no platform knowledge", () => {
				expect(normalizeUserSkillsDir("~/Documents/skills", lookup)).toBe("~/Documents/skills");
			});

			it("keeps a path configured on a desktop rather than reporting a problem it cannot see", () => {
				// A phone has no filesystem for this directory, so every read of it
				// is `not_supported` and the value is inert. Rejecting it would
				// invent a fault in a setting that works on the machine that reads
				// it, and hand the caller a reason to discard it.
				expect(normalizeUserSkillsDir("C:\\Users\\me\\skills", lookup)).toBe("C:\\Users\\me\\skills");
				expect(normalizeUserSkillsDir("/home/me/skills", lookup)).toBe("/home/me/skills");
			});

			it("still refuses empty input, the one verdict that needs no platform rules", () => {
				expect(normalizeUserSkillsDir("", lookup)).toBeUndefined();
				expect(normalizeUserSkillsDir("   ", lookup)).toBeUndefined();
				expect(normalizeUserSkillsDir(42, lookup)).toBeUndefined();
			});
		});
	}
});

describe("USER_SKILLS_DIR_PLACEHOLDER", () => {
	it("illustrates the accepted shape, so the example cannot contradict the rule", () => {
		expect(normalizeUserSkillsDir(USER_SKILLS_DIR_PLACEHOLDER)).toBe(USER_SKILLS_DIR_PLACEHOLDER);
	});
});
