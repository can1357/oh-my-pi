import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	type Rule,
	type RuleScopeModel,
	ruleAppliesToModel,
	ruleCapability,
} from "@oh-my-pi/pi-coding-agent/capability/rule";
import { bucketRules, composeActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule-buckets";
// Importing discovery registers all providers as a side effect.
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { BUILTIN_RULE_SOURCES } from "@oh-my-pi/pi-coding-agent/discovery/builtin-rules/index";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { OPUS, ROUTED_SONNET, SONNET, UNCLASSIFIED } from "../helpers/rule-scope-fixtures";

describe("model scope frontmatter", () => {
	it("accepts a string, a comma-separated string, and a YAML sequence, lowercased", () => {
		const rule = buildRuleFromMarkdown(
			"scoped.md",
			`---\nmodels: "Anthropic/Claude-*"\nproviders: "anthropic, OpenRouter"\nclass: [Anthropic, openai]\nfamily: "{opus, sonnet}"\n---\nbody`,
			"scoped.md",
			createSourceMeta("test", "scoped.md", "project"),
		);
		expect(rule.models).toEqual(["anthropic/claude-*"]);
		expect(rule.providers).toEqual(["anthropic", "openrouter"]);
		expect(rule.class).toEqual(["anthropic", "openai"]);
		expect(rule.family).toEqual(["{opus,sonnet}"]);
	});
});

describe("ruleAppliesToModel on a routed model", () => {
	const cases: Array<[string, Pick<Rule, "models" | "providers" | "class" | "family">, boolean]> = [
		["`*` does not cross the routed id's slash", { models: ["claude-*"] }, false],
		["`**/` spans the provider and upstream prefixes", { models: ["**/claude-*"] }, true],
		["the bare id carries the upstream prefix", { models: ["anthropic/*"] }, true],
		["SDK-supplied patterns match case-insensitively", { providers: ["OpenRouter"], class: ["Anthropic"] }, true],
	];
	for (const [label, scope, expected] of cases) {
		it(label, () => {
			expect(ruleAppliesToModel(scope, ROUTED_SONNET)).toBe(expected);
		});
	}
});

describe("malformed model scope globs", () => {
	it("treat an unclosed bracket or brace as non-matching without throwing", () => {
		for (const pattern of ["claude-[", "claude-{opus", "[", "{"]) {
			for (const field of ["models", "providers", "class", "family"] as const) {
				expect(ruleAppliesToModel({ [field]: [pattern] }, OPUS)).toBe(false);
			}
		}
	});
});

describe("same-named rule discovery", () => {
	let tempDir: string;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rule-model-scope-"));
		agentDir = path.join(tempDir, "home", ".omp", "agent");
		project = path.join(tempDir, "project");
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	function writeRule(dir: string, frontmatter: string, body: string, file = "style.md"): void {
		fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
		fs.writeFileSync(path.join(dir, "rules", file), `---\nalwaysApply: true\n${frontmatter}\n---\n${body}\n`);
	}

	async function loadRules(name = "style"): Promise<Rule[]> {
		const result = await loadCapability<Rule>(ruleCapability.id, {
			cwd: project,
			agentDir,
			providers: ["native", "builtin-defaults"],
		});
		return result.items.filter(rule => rule.name === name);
	}

	async function loadStyleBodies(): Promise<string[]> {
		return (await loadRules()).map(rule => rule.content.trim());
	}

	/** Bodies of the rules a session on `model` would apply, across every bucket. */
	function bodiesOn(rules: Rule[], model: RuleScopeModel): string[] {
		const ttsrManager = new TtsrManager();
		return composeActiveRules(bucketRules(rules, ttsrManager, { model }), ttsrManager).map(rule =>
			rule.content.trim(),
		);
	}

	it("lets a scoped project rule shadow a same-named user rule on every model", async () => {
		writeRule(agentDir, "", "user");
		writeRule(path.join(project, ".omp"), "family: opus", "project opus");
		const rules = await loadRules();
		expect(bodiesOn(rules, OPUS)).toEqual(["project opus"]);
		expect(bodiesOn(rules, SONNET)).toEqual([]);
	});

	it("lets a scoped project rule shadow a same-named builtin rule on every model", async () => {
		const builtinName = BUILTIN_RULE_SOURCES[0].name;
		writeRule(path.join(project, ".omp"), "family: opus", "project opus", `${builtinName}.md`);
		const rules = await loadRules(builtinName);
		expect(bodiesOn(rules, OPUS)).toEqual(["project opus"]);
		expect(bodiesOn(rules, SONNET)).toEqual([]);
	});

	it("keeps same-directory variants and applies each on its own model", async () => {
		writeRule(agentDir, "", "user");
		writeRule(path.join(project, ".omp"), "family: opus", "project opus", "style.md");
		writeRule(path.join(project, ".omp"), "family: sonnet", "project sonnet", "style.mdc");
		const rules = await loadRules();
		expect(bodiesOn(rules, OPUS)).toEqual(["project opus"]);
		expect(bodiesOn(rules, SONNET)).toEqual(["project sonnet"]);
		expect(bodiesOn(rules, UNCLASSIFIED)).toEqual([]);
	});

	it("keeps the unscoped precedence winner when the scopes are identical", async () => {
		writeRule(agentDir, "", "user");
		writeRule(path.join(project, ".omp"), "", "project");
		const unscoped = await loadStyleBodies();
		expect(unscoped).toHaveLength(1);

		clearCache();
		writeRule(agentDir, "family: opus", "user");
		writeRule(path.join(project, ".omp"), "family: opus", "project");
		expect(await loadStyleBodies()).toEqual(unscoped);
	});
});
