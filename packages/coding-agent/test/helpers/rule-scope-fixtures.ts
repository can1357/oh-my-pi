import type { Rule, RuleScopeModel } from "@oh-my-pi/pi-coding-agent/capability/rule";

/** Model identities for rule model-scope tests. */
export const OPUS: RuleScopeModel = {
	provider: "anthropic",
	id: "claude-opus-5",
	identity: { class: "anthropic", family: "opus" },
};
export const SONNET: RuleScopeModel = {
	provider: "anthropic",
	id: "claude-sonnet-5",
	identity: { class: "anthropic", family: "sonnet" },
};
/** Sonnet routed through OpenRouter: the provider differs and the id carries the upstream prefix. */
export const ROUTED_SONNET: RuleScopeModel = {
	provider: "openrouter",
	id: "anthropic/claude-sonnet-5",
	identity: { class: "anthropic", family: "sonnet" },
};
export const GPT: RuleScopeModel = { provider: "openai", id: "gpt-5", identity: { class: "openai", family: "gpt" } };
/** A model the catalog cannot classify: class `unknown`, no family. */
export const UNCLASSIFIED: RuleScopeModel = { provider: "local", id: "my-model", identity: { class: "unknown" } };

/** Rule `name` at `/rules/<name>.md` from a project source of `provider`; `fields` override any default. */
export function testRule(name: string, fields: Partial<Rule> = {}, provider = "test"): Rule {
	const rulePath = fields.path ?? `/rules/${name}.md`;
	return {
		name,
		path: rulePath,
		content: name,
		_source: { provider, providerName: provider, path: rulePath, level: "project" },
		...fields,
	};
}
