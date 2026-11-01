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
// Importing discovery registers all providers as a side effect.
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

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
	const routed: RuleScopeModel = {
		provider: "openrouter",
		id: "anthropic/claude-sonnet-4.5",
		identity: { class: "anthropic", family: "sonnet" },
	};
	const cases: Array<[string, Pick<Rule, "models" | "providers" | "class" | "family">, boolean]> = [
		["`*` does not cross the routed id's slash", { models: ["claude-*"] }, false],
		["`**/` spans the provider and upstream prefixes", { models: ["**/claude-*"] }, true],
		["the bare id carries the upstream prefix", { models: ["anthropic/*"] }, true],
		["SDK-supplied patterns match case-insensitively", { providers: ["OpenRouter"], class: ["Anthropic"] }, true],
	];
	for (const [label, scope, expected] of cases) {
		it(label, () => {
			expect(ruleAppliesToModel(scope, routed)).toBe(expected);
		});
	}
});

describe("malformed model scope globs", () => {
	it("treat an unclosed bracket or brace as non-matching without throwing", () => {
		const opus: RuleScopeModel = {
			provider: "anthropic",
			id: "claude-opus-5",
			identity: { class: "anthropic", family: "opus" },
		};
		for (const pattern of ["claude-[", "claude-{opus", "[", "{"]) {
			for (const field of ["models", "providers", "class", "family"] as const) {
				expect(ruleAppliesToModel({ [field]: [pattern] }, opus)).toBe(false);
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

	function writeRule(dir: string, frontmatter: string, body: string): void {
		fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
		fs.writeFileSync(path.join(dir, "rules", "style.md"), `---\nalwaysApply: true\n${frontmatter}\n---\n${body}\n`);
	}

	async function loadStyleBodies(): Promise<string[]> {
		const result = await loadCapability<Rule>(ruleCapability.id, { cwd: project, agentDir, providers: ["native"] });
		return result.items.filter(rule => rule.name === "style").map(rule => rule.content.trim());
	}

	it("keeps variants with different model scopes", async () => {
		writeRule(agentDir, "family: opus", "user opus");
		writeRule(path.join(project, ".omp"), "family: sonnet", "project sonnet");
		expect((await loadStyleBodies()).sort()).toEqual(["project sonnet", "user opus"]);
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
