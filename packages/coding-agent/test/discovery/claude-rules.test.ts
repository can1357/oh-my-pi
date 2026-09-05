import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetCapabilityForTests } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { bucketRules } from "@oh-my-pi/pi-coding-agent/capability/rule-buckets";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("Claude Code rules discovery", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		resetCapabilityForTests();
		clearFsCache();
		originalHome = process.env.HOME;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-rules-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		const settings = await Settings.init({ inMemory: true, cwd: project });
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		resetCapabilityForTests();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
		await removeWithRetries(root);
	});

	async function writeRuleFile(base: string, relPath: string, content: string): Promise<void> {
		const filePath = path.join(base, ".claude", "rules", relPath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content);
	}

	async function loadClaudeRules(cwd: string): Promise<Rule[]> {
		const result = await loadCapability<Rule>(ruleCapability.id, { cwd, providers: ["claude"] });
		return result.items;
	}

	test("discovers project .claude/rules markdown with MDC-style frontmatter", async () => {
		await writeRuleFile(
			project,
			"conventions.md",
			'---\ndescription: "Project coding conventions"\nalwaysApply: true\n---\nAlways format with tabs.\n',
		);

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "conventions");

		expect(rule).toBeDefined();
		expect(rule?.description).toBe("Project coding conventions");
		expect(rule?.alwaysApply).toBe(true);
		expect(rule?.content).toContain("Always format with tabs.");
		expect(rule?._source.provider).toBe("claude");
		expect(rule?._source.level).toBe("project");
	});

	test("discovers .mdc rule files alongside .md", async () => {
		await writeRuleFile(project, "security.mdc", '---\ndescription: Security review checklist\n---\nNever log credentials.\n');

		const rules = await loadClaudeRules(project);
		expect(rules.map(r => r.name)).toContain("security");
	});

	test("loads user ~/.claude/rules at the user level", async () => {
		await writeRuleFile(home, "global.md", "---\ndescription: Global rules\n---\nBe concise.\n");

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "global");

		expect(rule).toBeDefined();
		expect(rule?.description).toBe("Global rules");
		expect(rule?._source.level).toBe("user");
	});

	test("treats a plain pathless Claude rule as always-applicable", async () => {
		await writeRuleFile(project, "plain.md", "Always be concise.\n");

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "plain");

		expect(rule?.alwaysApply).toBe(true);

		const { alwaysApplyRules } = bucketRules(rules, new TtsrManager());
		expect(alwaysApplyRules.map(r => r.name)).toContain("plain");
	});

	test("maps Claude paths frontmatter to globs and buckets the rule into the rulebook", async () => {
		await writeRuleFile(project, "typescript.md", '---\npaths: ["**/*.ts", "**/*.tsx"]\n---\nUse strict TypeScript.\n');

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "typescript");

		expect(rule?.globs).toEqual(["**/*.ts", "**/*.tsx"]);
		expect(rule?.alwaysApply).toBe(false);
		expect(rule?.description).toBeDefined();

		const { rulebookRules, alwaysApplyRules } = bucketRules(rules, new TtsrManager());
		expect(rulebookRules.map(r => r.name)).toContain("typescript");
		expect(alwaysApplyRules.map(r => r.name)).not.toContain("typescript");
	});

	test("preserves OMP globs scoping on a shared file instead of forcing always-apply", async () => {
		await writeRuleFile(project, "shared.md", '---\ndescription: Shared scoped rule\nglobs: ["**/*.rs"]\n---\nRust rule.\n');

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "shared");

		expect(rule?.globs).toEqual(["**/*.rs"]);
		expect(rule?.alwaysApply).toBe(false);
	});

	test("does not overwrite OMP alwaysApply when Claude paths are also present", async () => {
		await writeRuleFile(project, "both.md", '---\nalwaysApply: true\npaths: ["**/*.ts"]\n---\nAlways rule.\n');

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "both");

		expect(rule?.alwaysApply).toBe(true);
		expect(rule?.globs).toBeUndefined();
	});

	test("does not promote an explicit alwaysApply:false on a shared rule", async () => {
		await writeRuleFile(project, "opt.md", '---\ndescription: Opt-in rule\nalwaysApply: false\n---\nBody.\n');

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "opt");

		expect(rule?.alwaysApply).toBe(false);

		const { alwaysApplyRules } = bucketRules(rules, new TtsrManager());
		expect(alwaysApplyRules.map(r => r.name)).not.toContain("opt");
	});

	test("leaves alwaysApply:false plus Claude paths untouched (OMP scoping wins)", async () => {
		await writeRuleFile(project, "mixed.md", '---\nalwaysApply: false\npaths: ["**/*.ts"]\n---\nBody.\n');

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "mixed");

		expect(rule?.alwaysApply).toBe(false);
		expect(rule?.globs).toBeUndefined();
	});

	test("preserves array glob elements with commas and brace patterns verbatim", async () => {
		await writeRuleFile(project, "sites.md", '---\npaths: ["docs/foo,bar.md", "**.{ts,tsx}"]\n---\nBody.\n');

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "sites");

		expect(rule?.globs).toEqual(["docs/foo,bar.md", "**.{ts,tsx}"]);
	});

	test("treats a scalar Claude path as a single atomic glob", async () => {
		await writeRuleFile(project, "scalar.md", '---\npaths: "**/*.{ts,tsx}"\n---\nBody.\n');

		const rules = await loadClaudeRules(project);
		const rule = rules.find(r => r.name === "scalar");

		expect(rule?.globs).toEqual(["**/*.{ts,tsx}"]);
	});

	test("discovers rules organized in nested subdirectories with a relative name", async () => {
		await writeRuleFile(project, "frontend/react.md", "Use function components.\n");

		const rules = await loadClaudeRules(project);
		expect(rules.map(r => r.name)).toContain("frontend/react");
	});

	test("keeps nested same-basename rules distinct instead of dropping one", async () => {
		await writeRuleFile(project, "frontend/style.md", "Frontend style.\n");
		await writeRuleFile(project, "backend/style.md", "Backend style.\n");

		const rules = await loadClaudeRules(project);
		expect(rules.map(r => r.name).sort()).toEqual(["backend/style", "frontend/style"]);
	});

	test("lets a project rule override a same-named user rule", async () => {
		await writeRuleFile(project, "security.md", "Project security rule.\n");
		await writeRuleFile(home, "security.md", "User security rule.\n");

		const rules = await loadClaudeRules(project);
		const survivors = rules.filter(r => r.name === "security");

		expect(survivors).toHaveLength(1);
		expect(survivors[0]?._source.level).toBe("project");
		expect(survivors[0]?.content).toContain("Project security rule.");
	});

	test("does not load ~/.claude/rules as project config when running from home", async () => {
		await writeRuleFile(home, "secret.md", "Secret home rule.\n");

		// No `providers` filter: `claude` is a foreign, non-opted-in user source,
		// and the cwd home scan must not alias ~/.claude/rules back in as project.
		const result = await loadCapability<Rule>(ruleCapability.id, { cwd: home });

		expect(result.items.filter(r => r._source.provider === "claude")).toEqual([]);
	});
});
