/**
 * Regression tests for top-level `RULES.md` sticky rules.
 *
 * `RULES.md` (singular, top-level) MUST be loaded as a sticky always-apply rule
 * from both `~/.omp/agent/RULES.md` (user) and the nearest `.omp/RULES.md`
 * (project, walked up from cwd to repoRoot).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
// Importing discovery registers all providers as a side effect.
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

let tempDir: string;
let home: string;
let project: string;

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

async function loadNativeRules(ctx: LoadContext): Promise<Rule[]> {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const native = cap.providers.find(p => p.id === "native");
	if (!native) throw new Error("native rules provider missing");
	const result = await (native.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

async function loadRulesCapability(cwd: string): Promise<Rule[]> {
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd, providers: ["native"] });
	return result.items;
}

beforeEach(() => {
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-md-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	setAgentDir(path.join(home, ".omp", "agent"));
});

afterEach(() => {
	clearCache();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(tempDir);
});

test("user ~/.omp/agent/RULES.md becomes an alwaysApply rule", async () => {
	writeFile(
		path.join(home, ".omp", "agent", "RULES.md"),
		"**CRITICAL**: You _MUST_ use beads task tracker for any project\n",
	);

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	const userRule = rules.find(r => r._source.level === "user" && r.name === "RULES");
	expect(userRule).toBeDefined();
	expect(userRule?.alwaysApply).toBe(true);
	expect(userRule?.content).toContain("beads task tracker");
});

test("project .omp/RULES.md becomes an alwaysApply rule", async () => {
	writeFile(path.join(project, ".omp", "RULES.md"), "# Project rule\nAlways say hi.\n");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	const projectRule = rules.find(r => r._source.level === "project" && r.name === "RULES@project");
	expect(projectRule).toBeDefined();
	expect(projectRule?.alwaysApply).toBe(true);
	expect(projectRule?.content).toContain("Always say hi.");
});

test("project RULES.md is found walking up from a sub-package cwd", async () => {
	const subPkg = path.join(project, "packages", "app");
	fs.mkdirSync(subPkg, { recursive: true });
	writeFile(path.join(project, ".omp", "RULES.md"), "# Repo-wide sticky rule\n");

	const rules = await loadNativeRules({ cwd: subPkg, home, repoRoot: project });

	const projectRule = rules.find(r => r._source.level === "project" && r.name === "RULES@project");
	expect(projectRule).toBeDefined();
	expect(projectRule?.alwaysApply).toBe(true);
	expect(projectRule?.path).toBe(path.join(project, ".omp", "RULES.md"));
});

test("user and project sticky RULES.md both survive public capability dedup", async () => {
	const userRulesPath = path.join(home, ".omp", "agent", "RULES.md");
	const projectRulesPath = path.join(project, ".omp", "RULES.md");
	const userRuleText = "User sticky rule: keep the personal safety checklist active.\n";
	const projectRuleText = "Project sticky rule: require repo-local release notes.\n";
	writeFile(userRulesPath, userRuleText);
	writeFile(projectRulesPath, projectRuleText);

	const rules = await loadRulesCapability(project);

	const stickyRules = rules.filter(rule => rule.path === userRulesPath || rule.path === projectRulesPath);
	expect(stickyRules).toHaveLength(2);

	const userRule = stickyRules.find(rule => rule._source.level === "user");
	const projectRule = stickyRules.find(rule => rule._source.level === "project");

	if (!userRule) throw new Error("user sticky rule missing");
	expect(userRule.name).toBe("RULES");
	expect(userRule.path).toBe(userRulesPath);
	expect(userRule._source.path).toBe(userRulesPath);
	expect(userRule.alwaysApply).toBe(true);
	expect(userRule.content).toContain(userRuleText.trim());
	expect("_shadowed" in userRule).toBe(false);

	if (!projectRule) throw new Error("project sticky rule missing");
	expect(projectRule.name).toBe("RULES@project");
	expect(projectRule.path).toBe(projectRulesPath);
	expect(projectRule._source.path).toBe(projectRulesPath);
	expect(projectRule.alwaysApply).toBe(true);
	expect(projectRule.content).toContain(projectRuleText.trim());
	expect("_shadowed" in projectRule).toBe(false);

	expect(userRule.name).not.toBe(projectRule.name);
	expect(userRule.content).not.toBe(projectRule.content);
});

test("alwaysApply is forced even when frontmatter says false", async () => {
	writeFile(path.join(home, ".omp", "agent", "RULES.md"), "---\nalwaysApply: false\n---\nStick around anyway.\n");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	const userRule = rules.find(r => r._source.level === "user" && r.name === "RULES");
	expect(userRule?.alwaysApply).toBe(true);
	expect(userRule?.content).toContain("Stick around anyway.");
});

test("enabled false omits a discovered rule", async () => {
	const rulesDir = path.join(home, ".omp", "agent", "rules");
	writeFile(
		path.join(rulesDir, "disabled-example.md"),
		"---\nenabled: false\ncondition: DISABLED_EXAMPLE\nscope: [tool:edit]\n---\nDisabled rule.\n",
	);
	writeFile(
		path.join(rulesDir, "active-example.md"),
		"---\ncondition: ACTIVE_EXAMPLE\nscope: [tool:edit]\n---\nActive rule.\n",
	);

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	expect(rules.find(rule => rule.name === "disabled-example")).toBeUndefined();
	expect(rules.find(rule => rule.name === "active-example")?.condition).toEqual(["ACTIVE_EXAMPLE"]);
});

test("absent RULES.md does not produce a rule", async () => {
	// No RULES.md anywhere — only a sibling .omp/rules/ to make sure the directory exists.
	writeFile(path.join(home, ".omp", "agent", "rules", "other.md"), "# Unrelated rule\n");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	expect(rules.find(r => r.name === "RULES")).toBeUndefined();
});
