/**
 * Tests that the agents provider walks up from cwd to find capabilities in ancestor
 * .agent/ and .agents/ directories (project-level discovery).
 *
 * Instead of testing the full provider flow (which requires the entire capability registry),
 * this test verifies the building blocks (scanSkillsFromDir, loadFilesFromDir, readFile)
 * with the same walk-up pattern used by the agents provider.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, readFile } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { getProjectPathCandidates } from "@oh-my-pi/pi-coding-agent/discovery/agents";
import {
	buildRuleFromMarkdown,
	calculateDepth,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
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

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
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
		test("finds .agents/skills in monorepo root from sub-project cwd", async () => {
			writeSkill(path.join(repoRoot, ".agents", "skills"), "root-skill", "From repo root");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "skills").map(dir =>
					scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" }),
				),
			);
			const names = results.flatMap(r => r.items).map(s => s.name);
			expect(names).toContain("root-skill");
		});

		test("finds .agent/skills in monorepo root from sub-project cwd", async () => {
			writeSkill(path.join(repoRoot, ".agent", "skills"), "root-skill", "From repo root");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "skills").map(dir =>
					scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" }),
				),
			);
			const names = results.flatMap(r => r.items).map(s => s.name);
			expect(names).toContain("root-skill");
		});

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

		test("project and user candidates do not overlap when cwd is under home", () => {
			// Regression for https://github.com/can1357/oh-my-pi/issues/1116.
			const noRepoCtx: LoadContext = { cwd: subProject, home: repoRoot, repoRoot: null };
			const project = getProjectPathCandidates(noRepoCtx, "skills");
			const user = [".agent", ".agents"].map(b => path.join(repoRoot, b, "skills"));
			const overlap = project.filter(p => user.includes(p));
			expect(overlap).toEqual([]);
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

	// =========================================================================
	// Rules
	// =========================================================================

	describe("rules", () => {
		test("finds .agents/rules in monorepo root from sub-project cwd", async () => {
			writeFile(path.join(repoRoot, ".agents", "rules", "my-rule.md"), "# My Rule\n\nDo the thing.");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "rules").map(dir =>
					loadFilesFromDir<Rule>(ctx, dir, PROVIDER_ID, "project", {
						extensions: ["md", "mdc"],
						transform: (name, content, filePath, source) =>
							buildRuleFromMarkdown(name, content, filePath, source, {
								stripNamePattern: /\.(md|mdc)$/,
							}),
					}),
				),
			);
			const names = results.flatMap(r => r.items).map(r => r.name);
			expect(names).toContain("my-rule");
		});

		test("finds rules at both sub-project and repo root, closest first", async () => {
			writeFile(path.join(subProject, ".agents", "rules", "local-rule.md"), "# Local\n\nLocal rule.");
			writeFile(path.join(repoRoot, ".agents", "rules", "root-rule.md"), "# Root\n\nRoot rule.");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "rules").map(dir =>
					loadFilesFromDir<Rule>(ctx, dir, PROVIDER_ID, "project", {
						extensions: ["md", "mdc"],
						transform: (name, content, filePath, source) =>
							buildRuleFromMarkdown(name, content, filePath, source, {
								stripNamePattern: /\.(md|mdc)$/,
							}),
					}),
				),
			);
			const names = results.flatMap(r => r.items).map(r => r.name);
			expect(names).toContain("local-rule");
			expect(names).toContain("root-rule");
			expect(names.indexOf("local-rule")).toBeLessThan(names.indexOf("root-rule"));
		});

		test("walk-up stops at repo root", async () => {
			writeFile(path.join(tempDir, ".agents", "rules", "above-rule.md"), "# Above\n\nAbove rule.");
			writeFile(path.join(repoRoot, ".agents", "rules", "root-rule.md"), "# Root\n\nRoot rule.");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "rules").map(dir =>
					loadFilesFromDir<Rule>(ctx, dir, PROVIDER_ID, "project", {
						extensions: ["md", "mdc"],
						transform: (name, content, filePath, source) =>
							buildRuleFromMarkdown(name, content, filePath, source, {
								stripNamePattern: /\.(md|mdc)$/,
							}),
					}),
				),
			);
			const names = results.flatMap(r => r.items).map(r => r.name);
			expect(names).toContain("root-rule");
			expect(names).not.toContain("above-rule");
		});
	});

	// =========================================================================
	// Prompts
	// =========================================================================

	describe("prompts", () => {
		test("finds .agents/prompts in monorepo root from sub-project cwd", async () => {
			writeFile(path.join(repoRoot, ".agents", "prompts", "my-prompt.md"), "You are a helpful assistant.");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "prompts").map(dir =>
					loadFilesFromDir(ctx, dir, PROVIDER_ID, "project", {
						extensions: ["md"],
						transform: (name, content, filePath, source) => ({
							name: name.replace(/\.md$/, ""),
							path: filePath,
							content,
							_source: source,
						}),
					}),
				),
			);
			const names = results.flatMap(r => r.items).map(p => p.name);
			expect(names).toContain("my-prompt");
		});

		test("finds prompts at both sub-project and repo root, closest first", async () => {
			writeFile(path.join(subProject, ".agents", "prompts", "local.md"), "Local prompt.");
			writeFile(path.join(repoRoot, ".agents", "prompts", "root.md"), "Root prompt.");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "prompts").map(dir =>
					loadFilesFromDir(ctx, dir, PROVIDER_ID, "project", {
						extensions: ["md"],
						transform: (name, content, filePath, source) => ({
							name: name.replace(/\.md$/, ""),
							path: filePath,
							content,
							_source: source,
						}),
					}),
				),
			);
			const names = results.flatMap(r => r.items).map(p => p.name);
			expect(names).toContain("local");
			expect(names).toContain("root");
			expect(names.indexOf("local")).toBeLessThan(names.indexOf("root"));
		});
	});

	// =========================================================================
	// Commands
	// =========================================================================

	describe("commands", () => {
		test("finds .agents/commands in monorepo root from sub-project cwd", async () => {
			writeFile(path.join(repoRoot, ".agents", "commands", "deploy.md"), "Run the deploy pipeline.");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "commands").map(dir =>
					loadFilesFromDir(ctx, dir, PROVIDER_ID, "project", {
						extensions: ["md"],
						transform: (name, content, filePath, source) => ({
							name: name.replace(/\.md$/, ""),
							path: filePath,
							content,
							level: "project" as const,
							_source: source,
						}),
					}),
				),
			);
			const names = results.flatMap(r => r.items).map(c => c.name);
			expect(names).toContain("deploy");
		});

		test("finds commands at both sub-project and repo root, closest first", async () => {
			writeFile(path.join(subProject, ".agents", "commands", "local-cmd.md"), "Local command.");
			writeFile(path.join(repoRoot, ".agents", "commands", "root-cmd.md"), "Root command.");

			const results = await Promise.all(
				getProjectPathCandidates(ctx, "commands").map(dir =>
					loadFilesFromDir(ctx, dir, PROVIDER_ID, "project", {
						extensions: ["md"],
						transform: (name, content, filePath, source) => ({
							name: name.replace(/\.md$/, ""),
							path: filePath,
							content,
							level: "project" as const,
							_source: source,
						}),
					}),
				),
			);
			const names = results.flatMap(r => r.items).map(c => c.name);
			expect(names).toContain("local-cmd");
			expect(names).toContain("root-cmd");
			expect(names.indexOf("local-cmd")).toBeLessThan(names.indexOf("root-cmd"));
		});
	});

	// =========================================================================
	// Context Files (AGENTS.md)
	// =========================================================================

	describe("context files (AGENTS.md)", () => {
		test("finds .agents/AGENTS.md in monorepo root from sub-project cwd", async () => {
			writeFile(path.join(repoRoot, ".agents", "AGENTS.md"), "# Project Rules\n\nFollow these rules.");

			const paths = getProjectPathCandidates(ctx, "AGENTS.md");
			const results = await Promise.all(paths.map(p => readFile(p)));
			const found = results.filter(r => r !== null);
			expect(found).toHaveLength(1);
			expect(found[0]).toContain("Project Rules");
		});

		test("finds AGENTS.md at both sub-project and repo root", async () => {
			writeFile(path.join(subProject, ".agents", "AGENTS.md"), "# Local Rules");
			writeFile(path.join(repoRoot, ".agents", "AGENTS.md"), "# Root Rules");

			const paths = getProjectPathCandidates(ctx, "AGENTS.md");
			const results = await Promise.all(paths.map(p => readFile(p)));
			const found = results.filter(r => r !== null);
			expect(found).toHaveLength(2);
			// Closest first (sub-project before root)
			expect(found[0]).toContain("Local Rules");
			expect(found[1]).toContain("Root Rules");
		});

		test("walk-up stops at repo root", async () => {
			writeFile(path.join(tempDir, ".agents", "AGENTS.md"), "# Above Repo");
			writeFile(path.join(repoRoot, ".agents", "AGENTS.md"), "# Root Rules");

			const paths = getProjectPathCandidates(ctx, "AGENTS.md");
			const results = await Promise.all(paths.map(p => readFile(p)));
			const found = results.filter(r => r !== null);
			expect(found).toHaveLength(1);
			expect(found[0]).toContain("Root Rules");
		});

		test("multi-level context files get distinct depth values for dedup", async () => {
			writeFile(path.join(subProject, ".agents", "AGENTS.md"), "# Local Rules");
			writeFile(path.join(repoRoot, ".agents", "AGENTS.md"), "# Root Rules");

			const paths = getProjectPathCandidates(ctx, "AGENTS.md");
			const items: Array<{ content: string; depth: number }> = [];
			for (const p of paths) {
				const content = await readFile(p);
				if (!content) continue;
				const ancestorDir = path.dirname(path.dirname(p));
				const depth = calculateDepth(ctx.cwd, ancestorDir, path.sep);
				items.push({ content, depth });
			}

			expect(items).toHaveLength(2);
			// Depths must differ so dedup keys are distinct
			expect(items[0]!.depth).not.toBe(items[1]!.depth);
			// Local (depth 0) before root (positive depth)
			expect(items[0]!.depth).toBe(0);
			expect(items[0]!.content).toContain("Local Rules");
			expect(items[1]!.depth).toBeGreaterThan(0);
			expect(items[1]!.content).toContain("Root Rules");
		});
	});

	// =========================================================================
	// System Prompt (SYSTEM.md)
	// =========================================================================

	describe("system prompt (SYSTEM.md)", () => {
		test("finds .agents/SYSTEM.md in monorepo root from sub-project cwd", async () => {
			writeFile(path.join(repoRoot, ".agents", "SYSTEM.md"), "You are a coding assistant.");

			const paths = getProjectPathCandidates(ctx, "SYSTEM.md");
			const results = await Promise.all(paths.map(p => readFile(p)));
			const found = results.filter(r => r !== null);
			expect(found).toHaveLength(1);
			expect(found[0]).toContain("coding assistant");
		});

		test("finds SYSTEM.md at both sub-project and repo root", async () => {
			writeFile(path.join(subProject, ".agents", "SYSTEM.md"), "# Local System");
			writeFile(path.join(repoRoot, ".agents", "SYSTEM.md"), "# Root System");

			const paths = getProjectPathCandidates(ctx, "SYSTEM.md");
			const results = await Promise.all(paths.map(p => readFile(p)));
			const found = results.filter(r => r !== null);
			expect(found).toHaveLength(2);
			expect(found[0]).toContain("Local System");
			expect(found[1]).toContain("Root System");
		});

		test("walk-up stops at repo root", async () => {
			writeFile(path.join(tempDir, ".agents", "SYSTEM.md"), "# Above Repo");
			writeFile(path.join(repoRoot, ".agents", "SYSTEM.md"), "# Root System");

			const paths = getProjectPathCandidates(ctx, "SYSTEM.md");
			const results = await Promise.all(paths.map(p => readFile(p)));
			const found = results.filter(r => r !== null);
			expect(found).toHaveLength(1);
			expect(found[0]).toContain("Root System");
		});
	});
});
