/**
 * Shared approval-rule pattern machinery.
 *
 * ONE implementation of the glob match syntax used by both `bash.patterns`
 * (evaluated inside BashTool.approval) and the generic `tools.approvalRules`
 * settings (evaluated in resolveApproval before per-tool policy). Lifted out of
 * tools/bash.ts so the two surfaces can never drift apart.
 *
 * Pattern syntax: `*` is the only wildcard; every other character is literal.
 * A pattern matches the normalized (whitespace-collapsed) input as a whole.
 *
 * Primary-string-arg mapping (contract 5):
 * - bash   → the `command` argument
 * - write/edit → the `path` argument (falling back to `file_path`)
 * - every other tool → matched on tool name alone; any `match` a rule carries
 *   for such a tool is ignored.
 */
import type { ApprovalPolicy } from "./approval";
import { tokenizeShellSegments } from "./shell-tokenize";

/** A `bash.patterns` entry: a match glob plus the approval it forces. */
export interface ApprovalPatternRule {
	match: string;
	approval: ApprovalPolicy;
}

/** A `tools.approvalRules` entry: tool-scoped; `match` is optional. */
export interface ApprovalRule {
	tool: string;
	match?: string;
	approval: ApprovalPolicy;
	reason?: string;
}

export interface MatchedApprovalRule {
	rule: ApprovalRule;
	index: number;
}

/** Tools whose approval rules pattern-match a primary string argument. */
const TOOLS_WITH_PRIMARY_STRING_ARG: Record<string, true> = {
	bash: true,
	write: true,
	edit: true,
};

const POLICY_VALUES: Record<ApprovalPolicy, true> = {
	allow: true,
	deny: true,
	prompt: true,
};

function normalizeMatchPattern(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

/** Convert a `*`-wildcard match pattern to an anchored whole-string RegExp. */
export function matchPatternToRegExp(pattern: string): RegExp {
	const escaped = normalizeMatchPattern(pattern)
		.split("*")
		.map(part => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "u");
}

function normalizeApprovalPolicy(value: unknown): ApprovalPolicy | undefined {
	if (typeof value !== "string") return undefined;
	const lowered = value.trim().toLowerCase();
	return lowered in POLICY_VALUES ? (lowered as ApprovalPolicy) : undefined;
}

/** Normalize an optional `match` field; a present-but-empty value is treated as absent. */
function normalizeMatch(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = normalizeMatchPattern(value);
	return normalized.length > 0 ? normalized : undefined;
}

/**
 * Parse a `bash.patterns` value (array of `{ match, approval }`) into normalized
 * rules. Malformed entries are dropped, exactly as before the shared module.
 */
export function normalizeApprovalPatternRules(value: unknown): ApprovalPatternRule[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(item => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
			const record = item as Record<string, unknown>;
			const match = normalizeMatch(record.match);
			const approval = normalizeApprovalPolicy(record.approval);
			return match && approval ? { match, approval } : undefined;
		})
		.filter((rule): rule is ApprovalPatternRule => !!rule);
}

/** Normalize a single `tools.approvalRules` entry, or `undefined` when invalid. */
export function normalizeApprovalRule(value: unknown): ApprovalRule | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.tool !== "string") return undefined;
	const tool = record.tool.trim();
	if (tool.length === 0) return undefined;
	const approval = normalizeApprovalPolicy(record.approval);
	if (!approval) return undefined;
	const match = normalizeMatch(record.match);
	const reason =
		typeof record.reason === "string" && record.reason.trim().length > 0 ? record.reason.trim() : undefined;
	return {
		tool,
		approval,
		...(match ? { match } : {}),
		...(reason ? { reason } : {}),
	};
}

/**
 * Parse a `tools.approvalRules` value (array of
 * `{ tool, match?, approval, reason? }`) into normalized rules. Malformed
 * entries are dropped; ordering is preserved for first-match-wins evaluation.
 */
export function normalizeApprovalRules(value: unknown): ApprovalRule[] {
	if (!Array.isArray(value)) return [];
	const rules: ApprovalRule[] = [];
	for (const item of value) {
		const rule = normalizeApprovalRule(item);
		if (rule) rules.push(rule);
	}
	return rules;
}

/** True when the whole normalized input matches the glob. */
export function stringMatchesPattern(input: string, pattern: string): boolean {
	const normalized = normalizeMatchPattern(input);
	if (normalized.length === 0) return false;
	return matchPatternToRegExp(pattern).test(normalized);
}

function shellSegments(input: string): string[] {
	return tokenizeShellSegments(input)
		.map(segment => segment.join(" "))
		.filter(segment => segment.length > 0);
}

/**
 * True when the normalized input or any shell segment of it matches the glob.
 * Reuses the shared shell tokenizer so compound-command matching stays in one
 * place and honors every command boundary.
 */
export function segmentMatchesPattern(input: string, pattern: string): boolean {
	const regex = matchPatternToRegExp(pattern);
	const normalized = normalizeMatchPattern(input);
	if (normalized.length === 0) return false;
	if (regex.test(normalized)) return true;
	return shellSegments(input).some(segment => regex.test(segment));
}

const SHELL_CONTROL_CHARS: Record<string, true> = {
	"\n": true,
	";": true,
	"&": true,
	"|": true,
	"<": true,
	">": true,
	"`": true,
	$: true,
	"(": true,
	")": true,
};
const REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;

/**
 * True when the input contains shell control syntax that an `allow` rule must
 * not ride over. `allow` must vouch for the ENTIRE command: shell control
 * syntax could smuggle an unsafe segment past a narrow allow. Also flags
 * quoted/escaped arguments (`git -c alias.x='!…'`, `sh -c "…"`) that another
 * shell would reinterpret as executable code.
 */
export function hasShellControl(input: string): boolean {
	let quote: "'" | '"' | undefined;
	let hasReinterpretableShellControl = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else if (Object.hasOwn(SHELL_CONTROL_CHARS, ch)) {
				hasReinterpretableShellControl = true;
			}
			continue;
		}
		if (ch === "\\") {
			const escaped = input[i + 1];
			if (escaped && Object.hasOwn(SHELL_CONTROL_CHARS, escaped)) {
				hasReinterpretableShellControl = true;
			}
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			// Expansion is active inside double quotes even in the original line.
			if (ch === "`" || ch === "$") return true;
			// Other control characters are literal here but become executable if a
			// `-c`/`-e` option reinterprets the argument through another shell.
			if (Object.hasOwn(SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (Object.hasOwn(SHELL_CONTROL_CHARS, ch)) return true;
	}
	// Options such as `git -c alias.x='!...'` and `sh -c "..."` reinterpret
	// otherwise literal quoted or escaped arguments as executable code.
	return hasReinterpretableShellControl && REINTERPRETED_ARGUMENT_RE.test(input);
}

/**
 * Whether a rule's glob applies to a primary string under approval-specific
 * matching: `allow` must vouch for the ENTIRE string (and, for shell-aware
 * inputs, must not ride a compound line), while `deny`/`prompt` fire on any
 * matching shell segment of a shell-aware input.
 */
export function ruleMatchesPrimary(primary: string, rule: ApprovalPatternRule, shellAware: boolean): boolean {
	if (rule.approval === "allow") {
		if (shellAware && hasShellControl(primary)) return false;
		return stringMatchesPattern(primary, rule.match);
	}
	if (shellAware) return segmentMatchesPattern(primary, rule.match);
	return stringMatchesPattern(primary, rule.match);
}

/** First `bash.patterns`-shaped rule whose glob matches `primary`. */
export function findApprovalPatternRule(
	primary: string,
	rules: readonly ApprovalPatternRule[],
	shellAware: boolean,
): ApprovalPatternRule | undefined {
	return rules.find(rule => ruleMatchesPrimary(primary, rule, shellAware));
}

function primaryStringArg(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/** Whether a tool's rules can pattern-match a primary string argument. */
export function toolMatchesOnPrimaryStringArg(toolName: string): boolean {
	return toolName in TOOLS_WITH_PRIMARY_STRING_ARG;
}

/**
 * Extract the primary string a tool call operates on for rule matching.
 * Only tools that act on a single free-form string support pattern matching:
 * bash → `command`; write/edit → `path` (falling back to `file_path`). Every
 * other tool returns `undefined` and matches approval rules on tool name alone.
 */
export function primaryStringArgForTool(toolName: string, args: unknown): string | undefined {
	if (toolName === "bash") return primaryStringArg(args, "command");
	if (toolName === "write" || toolName === "edit") {
		return primaryStringArg(args, "path") ?? primaryStringArg(args, "file_path");
	}
	return undefined;
}

/**
 * Apply ordered `tools.approvalRules` to a tool call: the first matching rule
 * wins. Rules for primary-arg tools with a `match` glob match that string
 * (bash commands with shell-aware semantics); any other rule matches on tool
 * name alone. A rule with a `match` for a primary-arg tool is skipped when the
 * call carries no primary string (e.g. a sloppy edit without a path).
 */
export function findApprovalRule(
	toolName: string,
	args: unknown,
	rules: readonly ApprovalRule[],
): MatchedApprovalRule | undefined {
	const primaryTool = toolMatchesOnPrimaryStringArg(toolName);
	for (let index = 0; index < rules.length; index++) {
		const rule = rules[index];
		if (rule.tool !== toolName) continue;
		if (!primaryTool || rule.match === undefined) return { rule, index };
		const primary = primaryStringArgForTool(toolName, args);
		if (primary === undefined) continue;
		const pattern: ApprovalPatternRule = { match: rule.match, approval: rule.approval };
		if (ruleMatchesPrimary(primary, pattern, toolName === "bash")) return { rule, index };
	}
	return undefined;
}
