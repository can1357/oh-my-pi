import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadModelRules,
	modelRulesBlock,
	type ModelRule,
	type ModelRuleDir,
	matchesModel,
	parseModelRule,
	selectModelRules,
} from "../src/extensibility/model-rules";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-rules-"));
	tempDirs.push(dir);
	return dir;
}

async function writeFile(dir: string, fileName: string, content: string): Promise<void> {
	await Bun.write(path.join(dir, fileName), content);
}

function ruleSource(pattern: string, body: string, extra: string = ""): string {
	return `---\nmodels:\n  - ${pattern}\n${extra}---\n${body}`;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("matchesModel", () => {
	test("matches a provider-scoped pattern only within one segment", () => {
		expect(matchesModel(["anthropic/opus*"], "anthropic/opus-4")).toBe(true);
		expect(matchesModel(["anthropic/opus*"], "openai/gpt-5")).toBe(false);
		expect(matchesModel(["anthropic/opus*"], "openrouter/opus-4")).toBe(false);
	});

	test("matches recursive patterns across segments", () => {
		expect(matchesModel(["**/*opus*"], "anthropic/claude-opus-4")).toBe(true);
		expect(matchesModel(["**/*opus*"], "x/y/opus-5")).toBe(true);
	});

	test("does not match deeper paths with a single-segment prefix", () => {
		expect(matchesModel(["*/opus*"], "x/y/opus-5")).toBe(false);
	});

	test("matches case-insensitively", () => {
		expect(matchesModel(["Anthropic/Opus*"], "anthropic/opus-4")).toBe(true);
	});
});

describe("parseModelRule", () => {
	test("parses scalar models into a single-element list", () => {
		const rule = parseModelRule("/rules/00-scalar.md", "---\nmodels: anthropic/opus*\n---\nBody", "global");
		expect(rule?.models).toEqual(["anthropic/opus*"]);
	});

	test("parses list models", () => {
		const rule = parseModelRule(
			"/rules/00-list.md",
			"---\nmodels:\n  - anthropic/opus*\n  - openai/gpt*\n---\nBody",
			"global",
		);
		expect(rule?.models).toEqual(["anthropic/opus*", "openai/gpt*"]);
	});

	test("falls back to the file stem when name is missing", () => {
		const rule = parseModelRule("/rules/00-name.md", "---\nmodels: a/*\n---\nBody", "global");
		expect(rule?.name).toBe("00-name");
	});

	test("uses the configured name", () => {
		const rule = parseModelRule("/rules/00-name.md", "---\nname: Custom\nmodels: a/*\n---\nBody", "global");
		expect(rule?.name).toBe("Custom");
	});

	test("honors enabled: false", () => {
		const rule = parseModelRule("/rules/00-off.md", ruleSource("a/*", "Body", "enabled: false\n"), "global");
		expect(rule?.enabledByDefault).toBe(false);
	});

	test("enables by default when enabled is omitted", () => {
		const rule = parseModelRule("/rules/00-on.md", ruleSource("a/*", "Body"), "global");
		expect(rule?.enabledByDefault).toBe(true);
	});

	test("returns undefined without frontmatter", () => {
		expect(parseModelRule("/rules/00-plain.md", "Just text", "global")).toBeUndefined();
	});

	test("returns undefined without models", () => {
		expect(parseModelRule("/rules/00-nomodels.md", "---\nname: A\n---\nBody", "global")).toBeUndefined();
	});

	test("returns undefined with an empty body", () => {
		expect(parseModelRule("/rules/00-emptybody.md", "---\nmodels: a/*\n---\n   \n", "global")).toBeUndefined();
	});
});

describe("loadModelRules", () => {
	test("loads global rules before project rules in sorted filename order", async () => {
		const root = await createTempDir();
		const globalDir = path.join(root, "global");
		const projectDir = path.join(root, "project");
		const missingDir = path.join(root, "missing");
		await fs.mkdir(globalDir, { recursive: true });
		await fs.mkdir(projectDir, { recursive: true });

		await writeFile(globalDir, "10-b.md", ruleSource("b/*", "BODY B"));
		await writeFile(globalDir, "00-a.md", ruleSource("a/*", "BODY A"));
		await writeFile(globalDir, "notes.txt", "ignored");
		await writeFile(projectDir, "00-c.md", ruleSource("c/*", "BODY C"));

		const dirs: ModelRuleDir[] = [
			{ scope: "global", dir: globalDir },
			{ scope: "global", dir: missingDir },
			{ scope: "project", dir: projectDir },
		];
		const rules = await loadModelRules(dirs);

		expect(rules.map(rule => rule.fileName)).toEqual(["00-a.md", "10-b.md", "00-c.md"]);
		expect(rules.map(rule => rule.scope)).toEqual(["global", "global", "project"]);
	});

	test("skips files with invalid YAML frontmatter", async () => {
		const root = await createTempDir();
		await writeFile(root, "00-ok.md", ruleSource("a/*", "BODY OK"));
		await writeFile(root, "10-bad.md", "---\nmodels: [a/*\nname: {\n---\nBody");

		const rules = await loadModelRules([{ scope: "project", dir: root }]);

		expect(rules.map(rule => rule.fileName)).toEqual(["00-ok.md"]);
	});

	test("a project rule with the same name replaces the global rule in its position", async () => {
		const root = await createTempDir();
		const globalDir = path.join(root, "global");
		const projectDir = path.join(root, "project");
		await writeFile(globalDir, "00-claude.md", ruleSource("a/*", "GLOBAL CLAUDE", "name: claude\n"));
		await writeFile(globalDir, "10-other.md", ruleSource("a/*", "GLOBAL OTHER"));
		await writeFile(projectDir, "00-extra.md", ruleSource("a/*", "PROJECT EXTRA"));
		await writeFile(
			projectDir,
			"50-claude.md",
			ruleSource("b/*", "PROJECT CLAUDE", "name: claude\nenabled: false\n"),
		);

		const rules = await loadModelRules([
			{ scope: "global", dir: globalDir },
			{ scope: "project", dir: projectDir },
		]);

		expect(rules.map(rule => rule.body)).toEqual(["PROJECT CLAUDE", "GLOBAL OTHER", "PROJECT EXTRA"]);
		expect(rules[0]).toMatchObject({
			scope: "project",
			models: ["b/*"],
			enabledByDefault: false,
			overridesGlobal: true,
		});
		expect(rules[2]?.overridesGlobal).toBe(false);
	});

	test("a project rule overrides a global rule by file stem when neither sets a name", async () => {
		const root = await createTempDir();
		const globalDir = path.join(root, "global");
		const projectDir = path.join(root, "project");
		await writeFile(globalDir, "00-style.md", ruleSource("a/*", "GLOBAL STYLE"));
		await writeFile(projectDir, "00-style.md", ruleSource("a/*", "PROJECT STYLE"));

		const rules = await loadModelRules([
			{ scope: "global", dir: globalDir },
			{ scope: "project", dir: projectDir },
		]);
		const prompt = modelRulesBlock(rules, "a/model", {});

		expect(prompt).toContain("PROJECT STYLE");
		expect(prompt).not.toContain("GLOBAL STYLE");
	});
});

describe("selectModelRules", () => {
	test("forces a disabled rule on with a true override", () => {
		const rule = parseModelRule("/rules/00-off.md", ruleSource("a/*", "Body", "enabled: false\n"), "global")!;
		expect(selectModelRules([rule], "a/model", {})).toEqual([]);
		expect(selectModelRules([rule], "a/model", { "00-off": true })).toEqual([rule]);
	});

	test("forces an enabled rule off with a false override", () => {
		const rule = parseModelRule("/rules/00-on.md", ruleSource("a/*", "Body"), "global")!;
		expect(selectModelRules([rule], "a/model", {})).toEqual([rule]);
		expect(selectModelRules([rule], "a/model", { "00-on": false })).toEqual([]);
	});

	test("ignores non-boolean override values", () => {
		const rule: ModelRule = parseModelRule("/rules/00-on.md", ruleSource("a/*", "Body"), "global")!;
		expect(selectModelRules([rule], "a/model", { "00-on": "no" })).toEqual([rule]);
	});

	test("keys overrides by rule name, not file name", () => {
		const rule = parseModelRule("/rules/00-x.md", ruleSource("a/*", "Body", "name: claude\n"), "global")!;
		expect(selectModelRules([rule], "a/model", { "00-x.md": false, "00-x": false })).toEqual([rule]);
		expect(selectModelRules([rule], "a/model", { claude: false })).toEqual([]);
	});
});

describe("modelRulesBlock", () => {
	test("returns undefined when no rule matches the model key", async () => {
		const root = await createTempDir();
		await writeFile(root, "00-a.md", ruleSource("anthropic/opus*", "OPUS RULE"));

		const prompt = modelRulesBlock(await loadModelRules([{ scope: "global", dir: root }]), "openai/gpt-5", {});

		expect(prompt).toBeUndefined();
	});

	test("renders matching rules as a model rule block", async () => {
		const root = await createTempDir();
		await writeFile(root, "00-a.md", ruleSource("anthropic/opus*", "OPUS RULE"));

		const prompt = modelRulesBlock(await loadModelRules([{ scope: "global", dir: root }]), "anthropic/opus-4", {});

		expect(prompt).toBe(
			'<model-rules>\n<model-rule name="00-a">\nOPUS RULE\n</model-rule>\n</model-rules>',
		);
	});
});
