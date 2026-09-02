/**
 * Tests that scanSkillsFromDir discovers skills nested one namespace level deep
 * (<skills-dir>/<namespace>/<skill>/SKILL.md), the layout used by curated skill
 * pools symlinked into ~/.claude/skills and ~/.config/opencode/skills
 * (e.g. skills/core-ops/deel/SKILL.md). Flat skills keep working, a directory
 * that is itself a skill is not descended into, and discovery never recurses
 * past the single namespace level.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { scanSkillsFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function writeSkill(dir: string, name: string, description: string): void {
	const skillDir = path.join(dir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill content.\n`,
	);
}

describe("nested namespace skill discovery", () => {
	let tempDir!: string;
	let skillsDir!: string;
	let ctx!: LoadContext;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-skills-"));
		skillsDir = path.join(tempDir, "skills");
		fs.mkdirSync(skillsDir, { recursive: true });
		ctx = { cwd: tempDir, home: tempDir, repoRoot: null };
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	test("finds skills one namespace level deep alongside flat skills", async () => {
		// given: a flat skill and a namespaced pool (skills/core-ops/deel/SKILL.md)
		writeSkill(skillsDir, "flat-skill", "Flat skill");
		writeSkill(path.join(skillsDir, "core-ops"), "deel", "Contractor payments");
		writeSkill(path.join(skillsDir, "core-ops"), "onboarding", "Provision a hire");

		// when
		const result = await scanSkillsFromDir(ctx, { dir: skillsDir, providerId: "native", level: "user" });

		// then: nested skills surface under their own names next to flat ones
		const names = result.items.map(s => s.name);
		expect(names).toContain("flat-skill");
		expect(names).toContain("deel");
		expect(names).toContain("onboarding");
		const deel = result.items.find(s => s.name === "deel");
		expect(deel?.path).toBe(path.join(skillsDir, "core-ops", "deel", "SKILL.md"));
	});

	test("a directory that is itself a skill is not descended into", async () => {
		// given: a skill dir that also contains a nested dir with a SKILL.md (e.g. fixtures)
		writeSkill(skillsDir, "outer", "Outer skill");
		writeSkill(path.join(skillsDir, "outer"), "inner-fixture", "Should stay invisible");

		// when
		const result = await scanSkillsFromDir(ctx, { dir: skillsDir, providerId: "native", level: "user" });

		// then: only the outer skill loads; its children are content, not skills
		const names = result.items.map(s => s.name);
		expect(names).toContain("outer");
		expect(names).not.toContain("inner-fixture");
	});

	test("does not recurse past one namespace level", async () => {
		// given: a skill buried two namespace levels deep
		writeSkill(path.join(skillsDir, "ns-a", "ns-b"), "too-deep", "Beyond the supported depth");

		// when
		const result = await scanSkillsFromDir(ctx, { dir: skillsDir, providerId: "native", level: "user" });

		// then
		expect(result.items.map(s => s.name)).not.toContain("too-deep");
	});

	test("follows a symlinked namespace directory", async () => {
		// given: the production shape - skills/<ns> is a symlink to a pool elsewhere
		const pool = path.join(tempDir, "pool");
		writeSkill(pool, "linked-skill", "Reached through a namespace symlink");
		fs.symlinkSync(pool, path.join(skillsDir, "linked-ns"));

		// when
		const result = await scanSkillsFromDir(ctx, { dir: skillsDir, providerId: "native", level: "user" });

		// then
		const linked = result.items.find(s => s.name === "linked-skill");
		expect(linked?.path).toBe(path.join(skillsDir, "linked-ns", "linked-skill", "SKILL.md"));
	});
});
