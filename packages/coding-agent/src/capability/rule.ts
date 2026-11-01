/**
 * Rules Capability
 *
 * Project-specific rules from Cursor (.mdc), Windsurf (.md), and Cline formats.
 * Translated to a canonical shape regardless of source format.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { modelMatchesGlob } from "../config/model-glob";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

const CONDITION_GLOB_SCOPE_TOOLS = ["edit", "write"] as const;

/**
 * Provider id for the bundled default rules shipped with the agent.
 * Lowest priority, so any user/project/tool rule of the same name overrides
 * a bundled default. Also used to gate the whole bundled set via
 * `ttsr.builtinRules`.
 */
export const BUILTIN_DEFAULTS_PROVIDER_ID = "builtin-defaults";

/**
 * Parsed frontmatter from rule files.
 */
export interface RuleFrontmatter {
	/** Whether discovery should omit this rule. */
	enabled?: boolean;
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	/** New key for TTSR match conditions. */
	condition?: string | string[];
	/** TTSR match condition(s) expressed as ast-grep patterns (edit/write streams only). */
	astCondition?: string | string[];
	/** Natural-language yes/no question a judge model answers on each completed in-scope output. */
	question?: string;
	/** New key for TTSR stream scope. */
	scope?: string | string[];
	/** Agent-name globs this rule applies to; absent = every agent. `main` targets the top-level session. */
	agents?: string[] | string;
	/** Model globs (`enabledModels` grammar) this rule applies to; absent = every model. */
	models?: string[] | string;
	/** Provider globs this rule applies to; absent = every provider. */
	providers?: string[] | string;
	/** Model class globs (catalog identity `class`) this rule applies to; absent = every class. */
	class?: string[] | string;
	/** Model family globs (catalog identity `family`) this rule applies to; absent = every family. */
	family?: string[] | string;
	/** Per-rule TTSR interrupt mode override. */
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	[key: string]: unknown;
}

/**
 * A rule providing project-specific guidance and constraints.
 */
export interface Rule {
	/** Rule name (derived from filename) */
	name: string;
	/** Absolute path to rule file */
	path: string;
	/** Rule content (after frontmatter stripped) */
	content: string;
	/** Globs this rule applies to (if any) */
	globs?: string[];
	/** Whether to always include this rule */
	alwaysApply?: boolean;
	/** Description (for agent-requested rules) */
	description?: string;
	/** Regex condition(s) that can trigger TTSR interruption. */
	condition?: string[];
	/** ast-grep pattern condition(s) that can trigger TTSR interruption (edit/write streams only). */
	astCondition?: string[];
	/**
	 * Judged-rule question: asked of the `judge` model role once an in-scope output completes,
	 * never mid-stream. A yes delivers the rule as a non-interrupting warning; `condition` /
	 * `astCondition`, when also set, only gate whether the question is asked.
	 */
	question?: string;
	/** Optional stream scope tokens (for example: text, thinking, tool:edit(*.ts)). */
	scope?: string[];
	/** Lowercased agent-name globs this rule applies to (absent = every agent). */
	agents?: string[];
	/** Lowercased model globs matched against `provider/id` and the bare id (absent = every model). */
	models?: string[];
	/** Lowercased provider globs matched against `Model.provider` (absent = every provider). */
	providers?: string[];
	/** Lowercased globs matched against the model's identity class (absent = every class). */
	class?: string[];
	/** Lowercased globs matched against the model's identity family (absent = every family). */
	family?: string[];
	/** Per-rule TTSR interrupt mode override (falls back to global ttsr.interruptMode). */
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	/** Source metadata */
	_source: SourceMeta;
}

function normalizeRuleField(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const token = value.trim();
		return token.length > 0 ? [token] : undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	const tokens = value
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(item => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}

	return Array.from(new Set(tokens));
}

function splitScopeTokens(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			current += char;
			if (char === quote && value[i - 1] !== "\\") {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "(") {
			parenDepth++;
			current += char;
			continue;
		}
		if (char === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
			current += char;
			continue;
		}
		if (char === "[") {
			bracketDepth++;
			current += char;
			continue;
		}
		if (char === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			current += char;
			continue;
		}
		if (char === "{") {
			braceDepth++;
			current += char;
			continue;
		}
		if (char === "}") {
			braceDepth = Math.max(0, braceDepth - 1);
			current += char;
			continue;
		}
		if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			const token = current.trim();
			if (token.length > 0) {
				tokens.push(token);
			}
			current = "";
			continue;
		}
		current += char;
	}

	const tail = current.trim();
	if (tail.length > 0) {
		tokens.push(tail);
	}

	return tokens;
}
function normalizeScopeField(value: unknown): string[] | undefined {
	const normalized = normalizeRuleField(value);
	if (!normalized) {
		return undefined;
	}

	const tokens = normalized
		.flatMap(splitScopeTokens)
		.map(token => {
			// Tolerate malformed frontmatter (e.g. `scope: "text","thinking"`) whose
			// YAML-fallback parse leaves per-token quotes intact (issue #4796).
			const quote = token[0];
			if (token.length >= 2 && (quote === '"' || quote === "'") && token[token.length - 1] === quote) {
				return token.slice(1, -1).trim();
			}
			return token;
		})
		.filter(item => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}
	return Array.from(new Set(tokens));
}

/**
 * Parse a list-of-globs frontmatter field (`agents`, `models`, `providers`, `class`,
 * `family`) into lowercased, deduplicated glob patterns. Accepts a string, a
 * comma-separated string, or a YAML sequence; `{a,b}` brace groups survive the
 * comma split. Returns undefined when no pattern remains.
 */
export function parseRuleGlobs(value: unknown): string[] | undefined {
	const tokens = normalizeScopeField(value);
	if (!tokens) {
		return undefined;
	}
	return Array.from(new Set(tokens.map(token => token.replace(/\s*,\s*/g, ",").toLowerCase())));
}

/** Agent name used for the top-level (non-sub) session when evaluating `agents`. */
export const MAIN_AGENT_RULE_NAME = "main";

/** Fallback agent name used for a subagent session with no explicit `agentName` (see sdk.ts). */
export const SUB_AGENT_RULE_NAME = "sub";

/**
 * Whether a rule's `agents` scope admits `agentName`. A rule without `agents`
 * applies everywhere; `agentName === undefined` disables scoping entirely
 * (used by CLI inventory listings that must show every rule).
 */
export function ruleAppliesToAgent(rule: Pick<Rule, "agents">, agentName: string | undefined): boolean {
	const patterns = rule.agents;
	if (!patterns || patterns.length === 0 || agentName === undefined) {
		return true;
	}
	const name = agentName.trim().toLowerCase();
	return patterns.some(pattern => {
		if (pattern === name) {
			return true;
		}
		return new Bun.Glob(pattern).match(name);
	});
}

/** Model fields a rule's model scope is evaluated against. */
export type RuleScopeModel = Pick<Model<Api>, "provider" | "id" | "identity">;

function matchesAnyGlob(patterns: readonly string[] | undefined, value: string | undefined): boolean {
	if (!patterns || patterns.length === 0) return true;
	if (value === undefined) return false;
	const subject = value.toLowerCase();
	return patterns.some(raw => {
		const pattern = raw.toLowerCase();
		return pattern === subject || new Bun.Glob(pattern).match(subject);
	});
}

/**
 * Whether a rule's model scope (`models`, `providers`, `class`, `family`) admits
 * `model`. Patterns within one field are alternatives; every present field must
 * match. A rule without these fields applies to every model; `model === undefined`
 * disables scoping (CLI inventory listings). A `family` scope never matches a
 * model whose identity has no family.
 */
export function ruleAppliesToModel(
	rule: Pick<Rule, "models" | "providers" | "class" | "family">,
	model: RuleScopeModel | undefined,
): boolean {
	if (model === undefined) return true;
	if (rule.models && rule.models.length > 0 && !rule.models.some(pattern => modelMatchesGlob(pattern, model))) {
		return false;
	}
	return (
		matchesAnyGlob(rule.providers, model.provider) &&
		matchesAnyGlob(rule.class, model.identity.class) &&
		matchesAnyGlob(rule.family, model.identity.family)
	);
}

/**
 * Canonical identity of a rule's model scope: empty for an unscoped rule,
 * otherwise a stable encoding of every scope field. Same-named rules with
 * different scopes are distinct rules.
 */
export function ruleModelScopeKey(rule: Pick<Rule, "models" | "providers" | "class" | "family">): string {
	const fields = [rule.models, rule.providers, rule.class, rule.family];
	if (fields.every(field => !field || field.length === 0)) return "";
	return JSON.stringify(fields.map(field => (field ? [...field].sort() : [])));
}
/**
 * Heuristic for condition shorthand that looks like a file glob (for example `*.rs`).
 */
function isLikelyFileGlob(value: string): boolean {
	const token = value.trim();
	if (token.length === 0) {
		return false;
	}
	if (/[\\^$+|()]/.test(token)) {
		return false;
	}
	if (!/[?*[\]{}]/.test(token)) {
		return false;
	}
	if (token.includes("/")) {
		return true;
	}
	return /^\*\.[^\s/]+$/.test(token);
}

/**
 * Parse the TTSR trigger fields (`condition`, `astCondition`, `question`) and `scope` from rule frontmatter.
 *
 * - `condition` accepts string or string[]
 * - `scope` accepts string or string[]
 * - legacy `ttsr_trigger` / `ttsrTrigger` are accepted as a `condition` fallback
 * - condition tokens that look like file globs become scope shorthands:
 *   `*.rs` => `tool:edit(*.rs)`, `tool:write(*.rs)` and a catch-all condition `.*`
 * - `astCondition` holds ast-grep patterns and is kept verbatim (no glob inference)
 * - `question` accepts a single non-empty string
 */
export function parseRuleConditionAndScope(
	frontmatter: RuleFrontmatter,
): Pick<Rule, "condition" | "astCondition" | "question" | "scope"> {
	const rawCondition = frontmatter.condition ?? frontmatter.ttsr_trigger ?? frontmatter.ttsrTrigger;
	const parsedCondition = normalizeRuleField(rawCondition);
	const astCondition = normalizeRuleField(frontmatter.astCondition);
	const parsedScope = normalizeScopeField(frontmatter.scope);

	const inferredScope: string[] = [];
	const condition: string[] = [];
	for (const token of parsedCondition ?? []) {
		if (isLikelyFileGlob(token)) {
			for (const toolName of CONDITION_GLOB_SCOPE_TOOLS) {
				inferredScope.push(`tool:${toolName}(${token})`);
			}
			continue;
		}
		condition.push(token);
	}

	if (condition.length === 0 && inferredScope.length > 0) {
		condition.push(".*");
	}

	const scope = [...(parsedScope ?? []), ...inferredScope];
	return {
		condition: condition.length > 0 ? Array.from(new Set(condition)) : undefined,
		astCondition,
		question: typeof frontmatter.question === "string" ? frontmatter.question.trim() || undefined : undefined,
		scope: scope.length > 0 ? Array.from(new Set(scope)) : undefined,
	};
}

/** Leading PCRE-style inline flag group, e.g. `(?i)` or `(?ims)`. */
const INLINE_FLAG_PREFIX = /^\(\?([a-z]+)\)/;

/** Inline flags that map cleanly onto native `RegExp` flags. */
const TRANSLATABLE_INLINE_FLAGS = /^[ims]+$/;

/**
 * A sequence of positive lookaheads whose bodies all begin with greedy `[\s\S]*`
 * has the same result at index zero as it does at any later index. Each body
 * can consume the prefix itself before testing its predicate, so asking the
 * RegExp engine to retry the sequence at every character only repeats work.
 * Lazy `[\s\S]*?` prefixes are excluded because captures chosen by one
 * lookahead can make a later backreference depend on the starting position.
 */
function canMatchWholeBufferFromStart(source: string): boolean {
	let offset = 0;
	let lookaheads = 0;
	const prefix = "(?=[\\s\\S]*";
	while (source.startsWith(prefix, offset) && source[offset + prefix.length] !== "?") {
		let depth = 1;
		let inCharacterClass = false;
		let end = -1;
		for (let index = offset + 3; index < source.length; index++) {
			const char = source[index];
			if (char === "\\") {
				index++;
				continue;
			}
			if (inCharacterClass) {
				if (char === "]") inCharacterClass = false;
				continue;
			}
			if (char === "[") {
				inCharacterClass = true;
				continue;
			}
			if (char === "(") {
				depth++;
				continue;
			}
			if (char !== ")") continue;
			depth--;
			if (depth === 0) {
				end = index + 1;
				break;
			}
		}
		if (end === -1) return false;
		offset = end;
		lookaheads++;
	}
	return lookaheads > 0 && offset === source.length;
}

function optimizeRuleCondition(condition: RegExp): RegExp {
	if (condition.sticky || !canMatchWholeBufferFromStart(condition.source)) return condition;
	return new RegExp(condition.source, `${condition.flags}y`);
}

/**
 * Compile a rule `condition` into a `RegExp`, translating a leading PCRE-style
 * inline flag group into native `RegExp` flags.
 *
 * JS/Bun `RegExp` rejects inline flag prefixes such as `(?i)`, so a rule written
 * `condition: "(?i)pre.existing"` would otherwise throw at compile time and be
 * silently dropped (see issue #4796). Only a *leading* group of `i`/`m`/`s`
 * flags is translated; anything else — mid-pattern groups, unsupported flags —
 * is passed through verbatim so the native error still surfaces for genuinely
 * invalid patterns.
 */
export function compileRuleCondition(pattern: string): RegExp {
	const match = INLINE_FLAG_PREFIX.exec(pattern);
	if (match && TRANSLATABLE_INLINE_FLAGS.test(match[1])) {
		const flags = Array.from(new Set(match[1])).join("");
		return optimizeRuleCondition(new RegExp(pattern.slice(match[0].length), flags));
	}
	return optimizeRuleCondition(new RegExp(pattern));
}

let activeRules: readonly Rule[] = [];

/**
 * Process-global snapshot of rules the active session loaded.
 * Read by internal URL protocol handlers (rule://).
 */
export function getActiveRules(): readonly Rule[] {
	return activeRules;
}

/** Replace the active rule snapshot. Called once per top-level session. */
export function setActiveRules(value: readonly Rule[]): void {
	activeRules = value;
}

/** Reset the active rule snapshot. Test-only. */
export function resetActiveRulesForTests(): void {
	activeRules = [];
}

export const ruleCapability = defineCapability<Rule>({
	id: "rules",
	displayName: "Rules",
	description: "Project-specific rules and constraints (Cursor MDC, Windsurf, Cline formats)",
	key: rule => {
		const scopeKey = ruleModelScopeKey(rule);
		return scopeKey ? `${rule.name}\0${scopeKey}` : rule.name;
	},
	toExtensionId: rule => `rule:${rule.name}`,
	validate: rule => {
		if (!rule.name) return "Missing rule name";
		if (!rule.path) return "Missing rule path";
		if (!rule.content || typeof rule.content !== "string") return "Rule must have content";
		return undefined;
	},
});
