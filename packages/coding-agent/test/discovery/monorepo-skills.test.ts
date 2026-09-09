/**
 * Tests that skill discovery walks up from cwd to find skills in ancestor config directories.
 *
 * Instead of testing the full provider flow (which requires the entire capability registry),
 * this test verifies scanSkillsFromDir — the building block every provider uses — finds skills
 * at different directory levels, and that the walk-up pattern produces the correct ordering.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { LoadContext, LoadResult } from "@oh-my-pi/pi-coding-agent/capability/types";
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

describe("monorepo skill discovery", () => {
	let tempDir!: string;
	let repoRoot!: string;
	let subProject!: string;
	let ctx!: LoadContext;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-monorepo-skills-"));
		repoRoot = path.join(tempDir, "repo");
		subProject = path.join(repoRoot, "packages", "my-app");
		fs.mkdirSync(subProject, { recursive: true });
		// Create .git at repo root so findRepoRoot can detect it
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		ctx = { cwd: subProject, home: tempDir, repoRoot };
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	test("finds skills in ancestor .omp/skills/ directories", async () => {
		// Root has a skill
		writeSkill(path.join(repoRoot, ".omp", "skills"), "root-skill", "From repo root");
		// Sub-project has a skill
		writeSkill(path.join(subProject, ".omp", "skills"), "local-skill", "From sub-project");

		// Simulate the walk-up pattern used by the builtin provider
		const results: LoadResult<Skill>[] = [];
		let current = subProject;
		while (true) {
			const result = await scanSkillsFromDir(ctx, {
				dir: path.join(current, ".omp", "skills"),
				providerId: "native",
				level: "project",
			});
			results.push(result);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}

		const allItems = results.flatMap(r => r.items);
		const names = allItems.map(s => s.name);

		// Both skills found
		expect(names).toContain("local-skill");
		expect(names).toContain("root-skill");
		// Local skill appears first (closest to cwd wins on dedup)
		expect(names.indexOf("local-skill")).toBeLessThan(names.indexOf("root-skill"));
	});

	test("closest skill wins when same name exists at multiple levels", async () => {
		// Same skill name at root and sub-project
		writeSkill(path.join(repoRoot, ".omp", "skills"), "shared-skill", "Root version");
		writeSkill(path.join(subProject, ".omp", "skills"), "shared-skill", "Local version");

		const results: LoadResult<Skill>[] = [];
		let current = subProject;
		while (true) {
			const result = await scanSkillsFromDir(ctx, {
				dir: path.join(current, ".omp", "skills"),
				providerId: "native",
				level: "project",
			});
			results.push(result);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}

		const allItems = results.flatMap(r => r.items);
		const sharedSkills = allItems.filter(s => s.name === "shared-skill");

		// Both found (dedup happens at capability level, not here)
		expect(sharedSkills).toHaveLength(2);
		// Closest comes first — will win dedup
		expect(sharedSkills[0]!.path).toContain("my-app");
	});

	test("works when no ancestor has skills", async () => {
		// No skills anywhere
		const results: LoadResult<Skill>[] = [];
		let current = subProject;
		while (true) {
			const result = await scanSkillsFromDir(ctx, {
				dir: path.join(current, ".omp", "skills"),
				providerId: "native",
				level: "project",
			});
			results.push(result);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}

		const allItems = results.flatMap(r => r.items);
		expect(allItems).toHaveLength(0);
	});

	test("finds skills across multiple ancestor levels", async () => {
		// Three levels: repo root, packages/, and sub-project
		const packagesDir = path.join(repoRoot, "packages");
		writeSkill(path.join(repoRoot, ".omp", "skills"), "root-skill", "Root");
		writeSkill(path.join(packagesDir, ".omp", "skills"), "packages-skill", "Packages");
		writeSkill(path.join(subProject, ".omp", "skills"), "app-skill", "App");

		const results: LoadResult<Skill>[] = [];
		let current = subProject;
		while (true) {
			const result = await scanSkillsFromDir(ctx, {
				dir: path.join(current, ".omp", "skills"),
				providerId: "native",
				level: "project",
			});
			results.push(result);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}

		const names = results.flatMap(r => r.items).map(s => s.name);
		expect(names).toContain("root-skill");
		expect(names).toContain("packages-skill");
		expect(names).toContain("app-skill");

		// Ordering: closest first
		expect(names.indexOf("app-skill")).toBeLessThan(names.indexOf("packages-skill"));
		expect(names.indexOf("packages-skill")).toBeLessThan(names.indexOf("root-skill"));
	});

	test("walk-up stops at repo root and does not find skills above it", async () => {
		// Skill ABOVE the repo root (should NOT be found)
		writeSkill(path.join(tempDir, ".omp", "skills"), "above-repo-skill", "Above repo");
		// Skill AT the repo root (should be found)
		writeSkill(path.join(repoRoot, ".omp", "skills"), "root-skill", "At repo root");

		// Simulate the walk-up with repo root boundary (matching builtin provider pattern)
		const results: LoadResult<Skill>[] = [];
		let current = subProject;
		while (true) {
			const result = await scanSkillsFromDir(ctx, {
				dir: path.join(current, ".omp", "skills"),
				providerId: "native",
				level: "project",
			});
			results.push(result);
			if (current === (ctx.repoRoot ?? ctx.home)) break; // stop at repo root or home
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}

		const names = results.flatMap(r => r.items).map(s => s.name);
		expect(names).toContain("root-skill");
		expect(names).not.toContain("above-repo-skill");
	});
});
