/**
 * Tests that the agents provider walks up from cwd to find capabilities in ancestor
 * .agent/ and .agents/ directories (project-level discovery).
 *
 * Instead of testing the full provider flow (which requires the entire capability registry),
 * this test verifies the building blocks (getProjectPathCandidates, scanSkillsFromDir)
 * with the same walk-up pattern used by the agents provider.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { getProjectPathCandidates } from "@oh-my-pi/pi-coding-agent/discovery/agents";
import { scanSkillsFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const PROVIDER_ID = "agents";

function writeSkill(dir: string, name: string, description: string): void {
	const skillDir = path.join(dir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill content.\n`,
	);
}

describe("agents provider project-level discovery", () => {
	let tempDir!: string;
	let repoRoot!: string;
	let subProject!: string;
	let ctx!: LoadContext;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-monorepo-"));
		repoRoot = path.join(tempDir, "repo");
		subProject = path.join(repoRoot, "packages", "my-app");
		fs.mkdirSync(subProject, { recursive: true });
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		ctx = { cwd: subProject, home: tempDir, repoRoot };
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	// =========================================================================
	// Skills
	// =========================================================================

	describe("skills", () => {
		test("finds skills at both sub-project and repo root, closest first", async () => {
			writeSkill(path.join(subProject, ".agents", "skills"), "local-skill", "From sub-project");
			writeSkill(path.join(repoRoot, ".agents", "skills"), "root-skill", "From repo root");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "skills").map(dir =>
					scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" }),
				),
			);
			const names = results.flatMap(r => r.items).map(s => s.name);
			expect(names).toContain("local-skill");
			expect(names).toContain("root-skill");
			expect(names.indexOf("local-skill")).toBeLessThan(names.indexOf("root-skill"));
		});

		test("discovers skills from both .agent and .agents at same level", async () => {
			writeSkill(path.join(repoRoot, ".agent", "skills"), "agent-skill", "From .agent");
			writeSkill(path.join(repoRoot, ".agents", "skills"), "agents-skill", "From .agents");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "skills").map(dir =>
					scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" }),
				),
			);
			const names = results.flatMap(r => r.items).map(s => s.name);
			expect(names).toContain("agent-skill");
			expect(names).toContain("agents-skill");
		});

		test("walk-up stops at repo root", async () => {
			writeSkill(path.join(tempDir, ".agents", "skills"), "above-repo-skill", "Above repo");
			writeSkill(path.join(repoRoot, ".agents", "skills"), "root-skill", "At repo root");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "skills").map(dir =>
					scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" }),
				),
			);
			const names = results.flatMap(r => r.items).map(s => s.name);
			expect(names).toContain("root-skill");
			expect(names).not.toContain("above-repo-skill");
		});

		test("project walk-up skips home directory (no repo root)", async () => {
			// Regression for https://github.com/can1357/oh-my-pi/issues/1116:
			// when cwd is under $HOME and no closer repoRoot exists, the walk-up
			// must NOT enumerate `~/.agent[s]/` as project paths — those belong
			// to the user level and getUserPathCandidates already covers them.
			const noRepoCtx: LoadContext = { cwd: subProject, home: repoRoot, repoRoot: null };
			// Skill above home (should NOT be found via project walk-up).
			writeSkill(path.join(tempDir, ".agents", "skills"), "above-home-skill", "Above home");
			// Skill *at* the home directory (must NOT be enumerated as project).
			writeSkill(path.join(repoRoot, ".agents", "skills"), "home-skill", "At home");
			// Skill at the sub-project (must still be found).
			writeSkill(path.join(subProject, ".agents", "skills"), "local-skill", "Sub-project");

			const candidates = getProjectPathCandidates(noRepoCtx, "skills");
			expect(candidates).not.toContain(path.join(repoRoot, ".agent", "skills"));
			expect(candidates).not.toContain(path.join(repoRoot, ".agents", "skills"));

			const results = await Promise.all(
				candidates.map(dir => scanSkillsFromDir(noRepoCtx, { dir, providerId: PROVIDER_ID, level: "project" })),
			);
			const names = results.flatMap(r => r.items).map(s => s.name);
			expect(names).toContain("local-skill");
			expect(names).not.toContain("home-skill");
			expect(names).not.toContain("above-home-skill");
		});

		test("returns empty when no ancestor has skills", async () => {
			const results = await Promise.all(
				getProjectPathCandidates(ctx, "skills").map(dir =>
					scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" }),
				),
			);
			expect(results.flatMap(r => r.items)).toHaveLength(0);
		});
	});
});
