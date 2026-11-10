import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectAgentDir, parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import modelRulesTemplate from "../prompts/system/model-rules.md" with { type: "text" };

/** Identifies the configuration scope containing a model rule. */
export type ModelRuleScope = "global" | "project";

/** Describes a directory containing model rule files. */
export interface ModelRuleDir {
	scope: ModelRuleScope;
	dir: string;
}

/** Describes a parsed model rule and its matching metadata. */
export interface ModelRule {
	name: string;
	fileName: string;
	path: string;
	scope: ModelRuleScope;
	models: string[];
	enabledByDefault: boolean;
	body: string;
	/** True when this project rule replaced a global rule with the same name. */
	overridesGlobal: boolean;
}

/** Returns global and project model rule directories in loading order. */
export function getModelRuleDirs(cwd: string): ModelRuleDir[] {
	return [
		{ scope: "global", dir: path.join(getAgentDir(), "model-rules") },
		{ scope: "project", dir: path.join(getProjectAgentDir(cwd), "model-rules") },
	];
}

/** Parses a model rule with matching patterns and a non-empty body. */
export function parseModelRule(filePath: string, source: string, scope: ModelRuleScope): ModelRule | undefined {
	if (source.startsWith("\uFEFF")) source = source.slice(1);
	if (!source.startsWith("---")) return undefined;

	try {
		const { frontmatter, body } = parseFrontmatter(source, { source: filePath, level: "fatal" });
		const rawModels: unknown[] =
			typeof frontmatter.models === "string"
				? [frontmatter.models]
				: Array.isArray(frontmatter.models)
					? frontmatter.models
					: [];
		const models = rawModels
			.filter((model): model is string => typeof model === "string")
			.map(model => model.trim())
			.filter(model => model.length > 0);
		const trimmedBody = body.trim();
		if (models.length === 0 || trimmedBody.length === 0) return undefined;

		return {
			name:
				typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
					? frontmatter.name.trim()
					: path.basename(filePath, ".md"),
			fileName: path.basename(filePath),
			path: filePath,
			scope,
			models,
			enabledByDefault: frontmatter.enabled !== false,
			body: trimmedBody,
			overridesGlobal: false,
		};
	} catch {
		return undefined;
	}
}

/** Matches a provider/model key against case-insensitive glob patterns. */
export function matchesModel(patterns: readonly string[], modelKey: string): boolean {
	const key = modelKey.toLowerCase();
	return patterns.some(pattern => new Bun.Glob(pattern.toLowerCase()).match(key));
}

/**
 * Loads valid markdown rules in directory order and sorted filename order. A rule whose name repeats an earlier
 * rule's name replaces that rule in place, so a project rule overrides the global rule of the same name.
 */
export async function loadModelRules(dirs: readonly ModelRuleDir[]): Promise<ModelRule[]> {
	const rules: ModelRule[] = [];
	const indexByName = new Map<string, number>();
	for (const { scope, dir } of dirs) {
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			continue;
		}

		for (const fileName of entries.filter(entry => entry.endsWith(".md")).sort()) {
			const fullPath = path.join(dir, fileName);
			let source: string;
			try {
				source = await Bun.file(fullPath).text();
			} catch {
				continue;
			}
			const rule = parseModelRule(fullPath, source, scope);
			if (rule === undefined) continue;
			const index = indexByName.get(rule.name);
			if (index === undefined) {
				indexByName.set(rule.name, rules.length);
				rules.push(rule);
			} else {
				rule.overridesGlobal = rules[index]!.scope === "global" && rule.scope === "project";
				rules[index] = rule;
			}
		}
	}
	return rules;
}

/** Resolves a rule's enabled state using an own boolean override, keyed by rule name, when present. */
export function isModelRuleEnabled(rule: ModelRule, overrides: Readonly<Record<string, unknown>>): boolean {
	const value = Object.hasOwn(overrides, rule.name) ? overrides[rule.name] : undefined;
	return typeof value === "boolean" ? value : rule.enabledByDefault;
}

/** Selects enabled matching rules while preserving their input order. */
export function selectModelRules(
	rules: readonly ModelRule[],
	modelKey: string,
	overrides: Readonly<Record<string, unknown>>,
): ModelRule[] {
	return rules.filter(rule => isModelRuleEnabled(rule, overrides) && matchesModel(rule.models, modelKey));
}

/** Renders selected rules as a system prompt block; models selecting the same rules get identical bytes. */
export function renderModelRules(rules: readonly ModelRule[]): string {
	return prompt.render(modelRulesTemplate, { rules });
}

/** The rendered block for the enabled rules matching `modelKey`, or `undefined` when none match. */
export function modelRulesBlock(
	rules: readonly ModelRule[],
	modelKey: string,
	overrides: Readonly<Record<string, unknown>>,
): string | undefined {
	const selected = selectModelRules(rules, modelKey, overrides);
	return selected.length === 0 ? undefined : renderModelRules(selected);
}
