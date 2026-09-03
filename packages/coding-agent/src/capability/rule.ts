/**
 * Rules Capability
 *
 * Project-specific rules from Cursor (.mdc), Windsurf (.md), and Cline formats.
 * Translated to a canonical shape regardless of source format.
 */
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
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	/** New key for TTSR match conditions. */
	condition?: string | string[];
	/** TTSR match condition(s) expressed as ast-grep patterns (edit/write streams only). */
	astCondition?: string | string[];
	/** New key for TTSR stream scope. */
	scope?: string | string[];
	/** Agent-name globs this rule applies to; absent = every agent. `main` targets the top-level session. */
	agents?: string[] | string;
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
	/** Optional stream scope tokens (for example: text, thinking, tool:edit(*.ts)). */
	scope?: string[];
	/** Lowercased agent-name globs this rule applies to (absent = every agent). */
	agents?: string[];
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
 * Parse the `agents` frontmatter field into lowercased agent-name glob patterns.
 * Reuses the scope tokenizer for comma-separated spellings; `{a,b}` groups survive.
 */
export function parseRuleAgents(value: unknown): string[] | undefined {
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
 * Parse `condition` + `scope` from rule frontmatter.
 *
 * - `condition` accepts string or string[]
 * - `scope` accepts string or string[]
 * - legacy `ttsr_trigger` / `ttsrTrigger` are accepted as a `condition` fallback
 * - condition tokens that look like file globs become scope shorthands:
 *   `*.rs` => `tool:edit(*.rs)`, `tool:write(*.rs)` and a catch-all condition `.*`
 * - `astCondition` holds ast-grep patterns and is kept verbatim (no glob inference)
 */
export function parseRuleConditionAndScope(
	frontmatter: RuleFrontmatter,
): Pick<Rule, "condition" | "astCondition" | "scope"> {
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
		scope: scope.length > 0 ? Array.from(new Set(scope)) : undefined,
	};
}

/** Leading PCRE-style inline flag group, e.g. `(?i)` or `(?ims)`. */
const INLINE_FLAG_PREFIX = /^\(\?([a-z]+)\)/;

/** Inline flags that map cleanly onto native `RegExp` flags. */
const TRANSLATABLE_INLINE_FLAGS = /^[ims]+$/;

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
		return new RegExp(pattern.slice(match[0].length), flags);
	}
	return new RegExp(pattern);
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
	key: rule => rule.name,
	toExtensionId: rule => `rule:${rule.name}`,
	validate: rule => {
		if (!rule.name) return "Missing rule name";
		if (!rule.path) return "Missing rule path";
		if (!rule.content || typeof rule.content !== "string") return "Rule must have content";
		return undefined;
	},
});
