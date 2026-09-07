/**
 * The whole release, as one command.
 *
 * ## Why this exists
 *
 * The previous flow was "tag, and let CI stamp the version". It produced correct
 * release artifacts and a permanently wrong default branch: `stamp-version.mjs`
 * ran inside CI's throwaway checkout and was never committed back, so
 * `master`'s `manifest.json` sat at `0.1.0-alpha.9` while thirty-odd releases
 * shipped past it. Obsidian's plugin-store bot reads the version out of the
 * *default branch's* manifest and looks for a release tagged exactly that, so a
 * flawless 1.0.0 release was still invisible to it.
 *
 * The fix is to invert the order: bump and commit first, then tag that commit.
 * The tag then points at a tree that already carries the right version, and
 * nothing has to write back to the repository from CI.
 *
 * ## Why a script rather than a checklist
 *
 * Doing it by hand means editing three files, running five gates, committing,
 * tagging without a `v`, and pushing both refs — in that order, every time. Each
 * step has a way to go quietly wrong, and two of them already have:
 *
 * - A version number written in a fourth place drifts. `src/mcp/mcpManager.ts`
 *   reported `1.0.0` to every MCP server for two releases after 1.0.0, because
 *   the literal was typed once and nothing read it back. `check:version` now
 *   fails on that shape, and this script runs it before anything is pushed.
 * - A `v`-prefixed tag yields a release the plugin store cannot find, since
 *   Obsidian matches the manifest's version verbatim. This script writes the
 *   tag, so the prefix cannot come back.
 *
 * ## The one-way door
 *
 * Everything up to the push is local and reversible; the push is neither. So the
 * gates all run first, against the bumped tree, and the script stops with a
 * summary and waits for a typed confirmation before it pushes anything. Answer
 * anything but `yes` and you are left with a commit and a tag you can delete
 * (`git tag -d`, `git reset --hard HEAD~1`) — the state is inspectable, not
 * half-published.
 *
 * `--dry-run` stops before even the commit; `--yes` skips the prompt for CI or
 * for a rerun you have already eyeballed.
 *
 * ## Usage
 *
 *     npm run release -- patch          # 1.0.2 -> 1.0.3
 *     npm run release -- minor          # 1.0.2 -> 1.1.0
 *     npm run release -- major          # 1.0.2 -> 2.0.0
 *     npm run release -- 1.2.3          # explicit
 *     npm run release -- patch --dry-run
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { stdin, stdout } from "node:process";

/** The branch a release may be cut from: the one Obsidian's bot reads. */
const RELEASE_BRANCH = "master";

/**
 * The gates, in the order CI runs them, each against the already-bumped tree.
 *
 * Run here rather than left to CI because CI only speaks after the tag is
 * pushed, and a tag is public. A failure at this point costs a `git reset`; the
 * same failure after the push costs a deleted release and a burnt version
 * number, since Obsidian's bot may already have seen the tag.
 */
const GATES = [
	{ name: "build", command: ["npm", "run", "build"] },
	{ name: "bundle size and loader compatibility", command: ["npm", "run", "check:bundle"] },
	{ name: "hardcoded user-visible copy", command: ["npm", "run", "check:copy"] },
	{ name: "version drift", command: ["npm", "run", "check:version"] },
	{ name: "tests", command: ["bun", "test"] },
	{ name: "lint", command: ["npm", "run", "lint"] },
];

/** Files the release version is written into. Also the only places it may live. */
const VERSION_FILES = ["manifest.json", "package.json", "versions.json"];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/;

/** Prints a step heading, so a long run reads as progress rather than a wall. */
function step(message) {
	console.log(`\n▸ ${message}`);
}

function fail(message, hint) {
	console.error(`\n✗ ${message}`);
	if (hint) {
		console.error(`  ${hint}`);
	}
	process.exit(1);
}

/** Runs a command and returns its stdout, trimmed. Throws on a non-zero exit. */
function capture(command, args) {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

/** Runs a command with its output attached to this terminal. */
function run(command, args) {
	execFileSync(command, args, { stdio: "inherit" });
}

/**
 * The next version, from a bump keyword or an explicit SemVer string.
 *
 * A pre-release identifier is dropped by a bump rather than incremented: this
 * repo's alphas were `0.1.0-alpha.N`, and the only transitions that ever
 * mattered were alpha-to-alpha (explicit) and alpha-to-stable (a bump). Guessing
 * which one someone meant is worse than making them spell it out.
 */
function nextVersion(current, request) {
	const match = SEMVER.exec(current);
	if (!match) {
		fail(`manifest.json holds "${current}", which is not a version this can bump.`);
	}
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];

	if (request === "major") {
		return `${major + 1}.0.0`;
	}
	if (request === "minor") {
		return `${major}.${minor + 1}.0`;
	}
	if (request === "patch") {
		// A pre-release bumping to "patch" means finishing it: 1.0.0-alpha.3 ->
		// 1.0.0, not 1.0.1, because the number was already claimed by the alpha.
		return match[4] ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
	}
	if (SEMVER.test(request)) {
		return request;
	}
	fail(
		`"${request}" is neither a bump keyword nor a version.`,
		"Expected: patch | minor | major | an explicit SemVer such as 1.2.3 or 1.2.3-alpha.1",
	);
}

/**
 * Refuses to start unless the working tree is a state a release can be cut from.
 *
 * Checked up front, together, because each of these produces a bad release
 * rather than an error: a dirty tree tags whatever happened to be lying around,
 * a side branch tags a tree Obsidian's bot will never read, being behind
 * `origin` cuts a release that silently omits someone else's merged work, and a
 * HEAD that is already a release commit means the previous run never finished —
 * stacking a second bump on it burns a version number (four releases in a row
 * shipped a dead one that way, 1.0.35 through 1.0.54).
 */
function assertReleasableState() {
	step("Checking the working tree");

	const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch !== RELEASE_BRANCH) {
		fail(
			`On branch "${branch}", but a release must be cut from "${RELEASE_BRANCH}".`,
			`Obsidian's plugin-store bot reads the version from ${RELEASE_BRANCH}'s manifest.json, so a tag on any other branch produces a release it cannot find.`,
		);
	}

	const dirty = capture("git", ["status", "--porcelain"]);
	if (dirty !== "") {
		fail(
			"The working tree has uncommitted changes.",
			`This script commits the version bump on its own, so anything else staged or modified would ride along into the release commit. Commit or stash first:\n\n${dirty}`,
		);
	}

	// The re-entrancy guard. A run whose dispatch got duplicated (or that is
	// rerun after its designed crash at the push) finds the previous run's bump
	// already committed and the tree clean, so every check above passes and it
	// happily bumps a second time. A HEAD that is itself a release commit means
	// the bump is done and unfinished business remains: publish it or undo it —
	// never stack another bump on top.
	const lastSubject = capture("git", ["log", "-1", "--format=%s"]);
	if (lastSubject.startsWith("chore(release):")) {
		const bumped = JSON.parse(readFileSync("manifest.json", "utf8")).version;
		fail(
			`HEAD is already a release commit ("${lastSubject}").`,
			`The previous run bumped to ${bumped} and stopped at the push, which is its ` +
				"designed failure point. Finish that release instead of stacking a new one:\n" +
				`    git push origin ${bumped}\n` +
				`    git push origin master:release/bump-${bumped}   # then open the PR\n` +
				"or discard the bump and start over:\n" +
				`    git tag -d ${bumped} && git reset --hard HEAD~1`,
		);
	}

	run("git", ["fetch", "origin", RELEASE_BRANCH, "--tags", "--quiet"]);
	const behind = capture("git", ["rev-list", "--count", `HEAD..origin/${RELEASE_BRANCH}`]);
	if (behind !== "0") {
		fail(
			`Behind origin/${RELEASE_BRANCH} by ${behind} commit(s).`,
			"Those commits would be missing from the release. Pull first.",
		);
	}

	console.log(`  on ${branch}, clean, up to date with origin`);
}

/** Fails if the version has already been released, before anything is written. */
function assertVersionUnused(version) {
	const existing = capture("git", ["tag", "--list", version, `v${version}`]);
	if (existing !== "") {
		fail(
			`Version ${version} is already tagged (${existing.split("\n").join(", ")}).`,
			"A released version cannot be re-cut: Obsidian resolves the manifest's version to a tag, so reusing one would point the store at an older tree. Pick the next version instead.",
		);
	}

	const versions = JSON.parse(readFileSync("versions.json", "utf8"));
	if (Object.prototype.hasOwnProperty.call(versions, version)) {
		fail(
			`versions.json already has an entry for ${version}.`,
			"That means it was at least partly released before. Check `git tag` and the GitHub releases page.",
		);
	}
}

/**
 * Writes the version into every file that carries it.
 *
 * Deliberately not delegated to `npm version`: that writes `package.json` and
 * makes its own commit and tag, neither of which matches what Obsidian needs —
 * the manifest is the file that matters and the tag must carry no `v`.
 */
function stampVersion(version) {
	step(`Stamping ${version} into ${VERSION_FILES.join(", ")}`);

	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	manifest.version = version;
	writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	pkg.version = version;
	writeFileSync("package.json", `${JSON.stringify(pkg, null, "\t")}\n`);

	// The compatibility map the plugin store reads: which Obsidian version each
	// release needs. Keyed by our version, valued with the manifest's minimum.
	const versions = JSON.parse(readFileSync("versions.json", "utf8"));
	versions[version] = manifest.minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));

	console.log(`  manifest.json, package.json → ${version}`);
	console.log(`  versions.json → ${version}: ${manifest.minAppVersion}`);
}

/**
 * Runs every gate against the bumped tree, stopping at the first failure.
 *
 * Stopping early rather than collecting failures: these are ordered by cost and
 * the later ones are mostly meaningless if `build` failed. The gate's own output
 * is already on the terminal, so this adds only which one failed and what it
 * costs to recover.
 */
function runGates() {
	for (const gate of GATES) {
		step(`Gate: ${gate.name}`);
		try {
			run(gate.command[0], gate.command.slice(1));
		} catch {
			fail(
				`Gate "${gate.name}" failed. Nothing has been committed or pushed.`,
				`The version files are still stamped in your working tree; discard them with:\n    git checkout -- ${VERSION_FILES.join(" ")}`,
			);
		}
	}
}

/** Everything CI will check, restated so a mismatch is visible before the push. */
function summarise(previous, version) {
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const versions = JSON.parse(readFileSync("versions.json", "utf8"));

	console.log(`\n${"─".repeat(64)}`);
	console.log(`  Release ${previous} → ${version}`);
	console.log(`${"─".repeat(64)}`);
	console.log(`  manifest.json    ${manifest.version}`);
	console.log(`  package.json     ${pkg.version}`);
	console.log(`  versions.json    ${version}: ${versions[version]}`);
	console.log(`  tag              ${version}   (no "v" prefix — the store matches verbatim)`);
	console.log(`  commit           chore(release): ${version}`);
	console.log(`  pushing to       origin/${RELEASE_BRANCH} + tag ${version}`);
	console.log(`${"─".repeat(64)}`);

	const shortlog = capture("git", ["log", "--oneline", `${previous}..HEAD`]).split("\n").filter(Boolean);
	if (shortlog.length > 0) {
		console.log(`\n  ${shortlog.length} commit(s) since ${previous}:`);
		for (const line of shortlog.slice(0, 12)) {
			console.log(`    ${line}`);
		}
		if (shortlog.length > 12) {
			console.log(`    … and ${shortlog.length - 12} more`);
		}
	}
}

/**
 * The confirmation before the one-way door.
 *
 * A typed `yes` rather than a keypress: the push publishes a version number that
 * cannot be reused, and every step before it was reversible.
 */
async function confirm() {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const answer = await rl.question('\nPush this release? Type "yes" to publish: ');
		return answer.trim().toLowerCase() === "yes";
	} finally {
		rl.close();
	}
}

/**
 * The release commit's message.
 *
 * Explains the ordering rather than restating the version, because the ordering
 * is the part a future reader will not guess: the bump lands on the default
 * branch *before* the tag exists, which is what the tag-only flow got wrong.
 */
function commitMessage(version, commitCount) {
	return `chore(release): ${version}

${commitCount} commit(s) since the previous release.

The bump lands on ${RELEASE_BRANCH} before the tag is cut, so the tag points at
a tree that already carries ${version}. Obsidian's plugin-store bot reads the
version out of the default branch's manifest.json and looks for a release tagged
exactly that; a CI-side stamp never reaches the branch, which is how master sat
at 0.1.0-alpha.9 through thirty-odd releases.

Cut by scripts/release.mjs.`;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const assumeYes = args.includes("--yes");
const request = args.find((arg) => !arg.startsWith("--")) ?? "patch";

const previous = JSON.parse(readFileSync("manifest.json", "utf8")).version;
const version = nextVersion(previous, request);

console.log(`Releasing ${previous} → ${version}${dryRun ? "  (dry run)" : ""}`);

assertReleasableState();
assertVersionUnused(version);
stampVersion(version);
runGates();

const commitCount = capture("git", ["rev-list", "--count", `${previous}..HEAD`]);

if (dryRun) {
	step("Dry run: stopping before the commit");
	console.log(`  The version files are stamped to ${version} in your working tree.`);
	console.log(`  Discard with:  git checkout -- ${VERSION_FILES.join(" ")}`);
	process.exit(0);
}

// Committed and tagged before the confirmation, pushed after: both of these are
// local and undoable, and having them done means the summary describes a real
// commit rather than an intention. The push is the only step that is not.
step(`Committing and tagging ${version}`);
run("git", ["add", ...VERSION_FILES]);
run("git", ["commit", "--quiet", "--message", commitMessage(version, commitCount)]);
run("git", ["tag", version]);
console.log(`  ${capture("git", ["log", "--oneline", "-1"])}`);

summarise(previous, version);

if (!assumeYes && !(await confirm())) {
	console.log("\nNot pushed. The commit and tag are local; undo them with:");
	console.log(`    git tag -d ${version} && git reset --hard HEAD~1`);
	process.exit(1);
}

step("Pushing");
run("git", ["push", "origin", RELEASE_BRANCH]);
// Pushed after the branch, deliberately: the tag is what starts the release
// workflow, and it must not fire against a commit origin has not got yet.
run("git", ["push", "origin", version]);

console.log(`\n✓ ${version} pushed. The Release workflow builds and publishes from tag ${version}.`);
console.log("  Watch it with:  gh run list --workflow=release.yml --limit 1");
