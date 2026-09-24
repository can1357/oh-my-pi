/**
 * Skillshare Provider
 *
 * Loads registry skills pinned by `skills.lock.json` from the unpacked store
 * (`~/.omp/skillshare/@scope/name/<version>/`). Project locks are found by
 * walking up from cwd like native `.omp/skills` (closest first); the user lock
 * lives in the agent dir. Priority 95 sits just below native (100) so authored
 * skills win name collisions.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type Skill, type SkillFrontmatter, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	getSkillStorePath,
	parseSkillId,
	readSkillsLock,
	readStoredIntegrity,
	SKILLS_LOCK_FILE,
	type SkillsLock,
} from "../skillshare/manifest";
import { getAncestorDirs } from "./builtin";
import { createSourceMeta, SOURCE_PATHS } from "./helpers";

export const SKILLSHARE_PROVIDER_ID = "skillshare";
const PRIORITY = 95;

async function loadLockedSkill(
	id: string,
	lock: SkillsLock,
	level: "user" | "project",
	warnings: string[],
): Promise<Skill | null> {
	const entry = lock.skills[id]!;
	// Ids are validated when the lock is parsed.
	const { scope, name } = parseSkillId(id)!;
	const storeDir = getSkillStorePath(scope, name, entry.version);
	// Only a completed unpack of the locked bytes counts; anything else is restored by `omp skill update`.
	if ((await readStoredIntegrity(storeDir)) !== entry.integrity) {
		logger.debug("Skillshare skill missing from store; run `omp skill update` to restore it", {
			id,
			version: entry.version,
			storeDir,
		});
		return null;
	}
	const skillPath = path.join(storeDir, "SKILL.md");
	let text: string;
	try {
		text = await fs.readFile(skillPath, "utf8");
	} catch (error) {
		if (!isEnoent(error)) warnings.push(`Failed to read skill file: ${skillPath} (${String(error)})`);
		else logger.debug("Skillshare store dir has no SKILL.md", { id, version: entry.version, storeDir });
		return null;
	}
	const { frontmatter, body } = parseFrontmatter(text, { source: skillPath });
	if (frontmatter.enabled === false) return null;
	const rawName = frontmatter.name;
	return {
		name: typeof rawName === "string" && rawName.trim() ? rawName.trim() : name,
		path: skillPath,
		content: body,
		frontmatter: frontmatter as SkillFrontmatter,
		// Registry content is untrusted: keep `skill://` access inside the unpacked package.
		containRoot: await fs.realpath(storeDir),
		level,
		_source: createSourceMeta(SKILLSHARE_PROVIDER_ID, skillPath, level, `skillshare:${id}@${entry.version}`),
	};
}

async function loadLock(lockPath: string, level: "user" | "project", warnings: string[]): Promise<Skill[]> {
	let lock: SkillsLock;
	try {
		lock = await readSkillsLock(lockPath);
	} catch (error) {
		warnings.push(`Failed to read skills lock: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	const ids = Object.keys(lock.skills).sort();
	const skills = await Promise.all(ids.map(id => loadLockedSkill(id, lock, level, warnings)));
	return skills.filter((skill): skill is Skill => skill !== null);
}

/** Load every skill pinned by project locks (closest first) and the user lock. */
export async function loadSkillshareSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const warnings: string[] = [];
	const projectLocks = getAncestorDirs(ctx.cwd, ctx.repoRoot ?? ctx.home).map(({ dir }) =>
		loadLock(path.join(dir, SOURCE_PATHS.native.projectDir, SKILLS_LOCK_FILE), "project", warnings),
	);
	const userLock = loadLock(path.join(getAgentDir(), SKILLS_LOCK_FILE), "user", warnings);
	const results = await Promise.all([...projectLocks, userLock]);
	return { items: results.flat(), warnings };
}

registerProvider<Skill>(skillCapability.id, {
	id: SKILLSHARE_PROVIDER_ID,
	displayName: "Skillshare",
	description: "Registry skills installed with `omp skill install` (skills.lock.json)",
	priority: PRIORITY,
	load: loadSkillshareSkills,
});
