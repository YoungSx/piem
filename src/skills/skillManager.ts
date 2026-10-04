import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Skill } from "./piResources";
import { DEFAULT_SKILLS_DIR, loadVaultSkills } from "../agent/skillLoader";
import type { FetchFn } from "../net/obsidianFetch";
import {
	SkillImporter,
	type FetchedSkill,
	type FetchedSource,
	type SkillProvenance,
	type UpdatePlan,
} from "./skillImport";

/**
 * Vault-facing surface for the skills settings tab.
 *
 * {@link SkillImporter} owns the protocol work — fetching, hashing, planning
 * updates — against any {@link ExecutionEnv}. This class is the thin vault
 * adaptation on top of it: it lists what is actually installed (which the
 * importer never needs to do — it writes, it does not browse), maps a listed
 * skill back to its directory for update/delete, and turns the env's
 * never-throw `Result` contract into the thrown errors the UI's
 * `try`/`Notice` handling expects. Fetches travel on the caller's
 * transport-bound fetch, so a vault behind a restrictive network imports and
 * updates the same way its chat requests go out.
 */

/** One installed vault skill, as the settings row needs it. */
export interface SkillRow {
	/** Skill name as pi registers it (frontmatter value, else directory name). */
	name: string;
	description: string;
	/** Vault path of the SKILL.md. */
	path: string;
	/**
	 * Directory under the skills folder holding this skill, or `""` for a
	 * root-level skill file. Only directory skills can be updated or deleted
	 * from the panel — a root `.md` is an ordinary vault note the user owns.
	 */
	dirName: string;
	/**
	 * Where the skill was imported from, when a provenance sidecar is present
	 * and readable. Undefined for hand-authored skills.
	 */
	provenance?: SkillProvenance;
}

/**
 * The installed skills, as rows.
 *
 * Deliberately carries no diagnostics. This class performs its own load — a
 * fresh {@link ExecutionEnv}, a moment after the agent's — and reporting
 * problems from it would let the panel describe a read the agent never did:
 * two loads either side of a folder reattaching disagree, and the panel would
 * say clean while the prompt was built without those skills. The warnings come
 * from `ObsidianAgentService.getSkillLoad()` instead. What survives here is
 * what only a vault walk can answer and the agent's load never computes:
 * `dirName` and `provenance`, which update and delete need.
 */
export interface SkillInventory {
	rows: SkillRow[];
}

export class SkillManager {
	private readonly importer: SkillImporter;

	constructor(
		private readonly fetchImpl: FetchFn,
		private readonly env: ExecutionEnv,
		private readonly skillsDir: string = DEFAULT_SKILLS_DIR,
	) {
		this.importer = new SkillImporter(fetchImpl, env, skillsDir);
	}

	/** Lists installed skills. A vault without the skills folder lists as empty. */
	async listSkills(): Promise<SkillInventory> {
		const { skills } = await loadVaultSkills(this.env, this.skillsDir);
		const rows = await Promise.all(skills.map((skill) => this.toRow(skill)));
		return { rows };
	}

	/** Fetches a URL the user pasted, for preview before anything is written. */
	async fetchSource(url: string): Promise<FetchedSource> {
		return this.importer.fetchSource(url);
	}

	/** Writes one fetched skill into the vault with its provenance sidecar. */
	async install(source: FetchedSource, skill: FetchedSkill): Promise<void> {
		await this.importer.installSkill(source, skill);
	}

	/**
	 * Checks upstream and applies the change when it is clean.
	 *
	 * The plan is returned either way so the UI can report "already up to
	 * date" and refuse-with-reasons on conflicts. Conflicted plans are never
	 * applied — {@link SkillImporter.applyUpdate} throws on them, and the
	 * user's local edits stay on disk untouched.
	 */
	async update(dirName: string): Promise<UpdatePlan> {
		const provenance = await this.importer.readProvenance(dirName);
		if (!provenance) {
			throw new Error(`No import source recorded for "${dirName}".`);
		}
		const { source, skill, plan } = await this.importer.planUpdateFor(dirName, provenance);
		if (plan.status === "changed" && !plan.hasConflicts) {
			await this.importer.applyUpdate(dirName, source, skill, plan);
		}
		return plan;
	}

	/** Deletes a skill directory, sidecar included, recursive. */
	async remove(dirName: string): Promise<void> {
		const result = await this.env.remove(`/${this.skillsDir}/${dirName}`, { recursive: true }, BACKGROUND_CONTEXT);
		if (!result.ok) {
			throw new Error(result.error.message);
		}
	}

	/**
	 * Maps a loaded skill back to its install directory and provenance.
	 *
	 * `filePath` is the vault path of the SKILL.md, so the directory is the
	 * path segment between the skills folder and the file. A root-level
	 * `.md` skill has no directory and no sidecar; a nested one keeps its
	 * subpath, which is exactly what update and delete need.
	 */
	private async toRow(skill: Skill): Promise<SkillRow> {
		const prefix = `/${this.skillsDir}/`;
		const suffix = "/SKILL.md";
		const path = skill.filePath;
		const dirName = path.startsWith(prefix) && path.endsWith(suffix) ? path.slice(prefix.length, path.length - suffix.length) : "";
		const provenance = dirName === "" ? undefined : await this.importer.readProvenance(dirName);
		return { name: skill.name, description: skill.description, path, dirName, provenance };
	}
}
