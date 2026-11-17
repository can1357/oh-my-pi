/**
 * Tool intent interceptor - redirects or blocks tool calls using regex patterns
 * and/or batched judge questions (`toolInterceptor.rules`).
 */
import type { Judge, JudgmentState, NoulQuestion } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { jevPrefix, JUDGED_CONTENT_MAX_TOKENS, JUDGED_RULE_THRESHOLD } from "../export/ttsr";
import type { ApprovalPolicy } from "./approval";
import type { InterceptionResult } from "./bash-interceptor";
import { unwrapHashlineHeaderPath } from "./hashline-header-path";
import { DEFAULT_TOOL_INTERCEPTOR_RULES, type ToolInterceptorRule } from "./settings";

export interface CheckToolInterceptionOptions {
	/** Tool names available in the current session (gates `suggestedTool` when provided). */
	availableTools?: readonly string[];
	/** Additional tool identities for the call (e.g. `policyKey` for an `xd://` device or `customWireName`). */
	toolAliases?: readonly string[];
	/** Effective approval policy for the call (`"allow"` or `"prompt"`), used to filter `whenPolicy` rules. */
	policy?: ApprovalPolicy;
	/** Interceptor rules to evaluate in order. Defaults to `DEFAULT_TOOL_INTERCEPTOR_RULES`. */
	rules?: readonly ToolInterceptorRule[];
	/** Judge instance or lazy resolver, called only when at least one `question` rule survives prefiltering. */
	judge?: Judge | (() => Judge | undefined);
	/** Cancellation signal forwarded to `judge.judge()`. */
	signal?: AbortSignal;
}

function normalizeTargetPatterns(rule: ToolInterceptorRule): readonly string[] {
	const raw = rule.tools;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		return trimmed.length > 0 ? [trimmed] : ["*"];
	}
	if (Array.isArray(raw)) {
		const items = raw
			.filter((item): item is string => typeof item === "string")
			.map(item => item.trim())
			.filter(Boolean);
		return items.length > 0 ? items : ["*"];
	}
	return ["*"];
}

function matchesToolPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return name === pattern;
	return new Bun.Glob(pattern).match(name);
}

function ruleAppliesToTool(rule: ToolInterceptorRule, names: readonly string[]): boolean {
	const patterns = normalizeTargetPatterns(rule);
	return patterns.some(pattern => names.some(name => matchesToolPattern(name, pattern)));
}

function ruleAppliesToPolicy(rule: ToolInterceptorRule, policy: ApprovalPolicy | undefined): boolean {
	if (rule.whenPolicy !== "prompt" && rule.whenPolicy !== "allow") return true;
	return policy === rule.whenPolicy;
}

const PRIMARY_ARG_KEYS = ["code", "command", "input", "content", "path", "query"] as const;
const XD_HELP_CONTENT_RE = /^\s*(\?|help)?\s*$/i;

function normalizeXdPath(args: unknown): string | undefined {
	if (!isRecord(args) || typeof args.path !== "string") return undefined;
	const unwrapped = unwrapHashlineHeaderPath(args.path.trim()).trim();
	return unwrapped.startsWith("xd://") ? unwrapped : undefined;
}

function isXdHelpQuery(args: unknown): boolean {
	if (!normalizeXdPath(args) || !isRecord(args)) return false;
	return typeof args.content === "string" && XD_HELP_CONTENT_RE.test(args.content);
}

function unwrapXdArgs(args: unknown): unknown {
	if (normalizeXdPath(args) && isRecord(args) && typeof args.content === "string") {
		try {
			const parsed: unknown = JSON.parse(args.content);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Keep outer args when content is not a JSON object
		}
	}
	return args;
}

function extractCandidateStrings(args: unknown): string[] {
	const candidates: string[] = [];
	const push = (value: string) => {
		if (!candidates.includes(value)) candidates.push(value);
		const trimmed = value.trim();
		if (trimmed !== value && !candidates.includes(trimmed)) candidates.push(trimmed);
	};

	if (typeof args === "string") {
		push(args);
		return candidates;
	}
	if (isRecord(args)) {
		if (typeof args.code === "string") {
			push(args.code);
			return candidates;
		}
		if (typeof args.command === "string") {
			push(args.command);
			return candidates;
		}
		for (const key of PRIMARY_ARG_KEYS) {
			const value = args[key];
			if (typeof value === "string") push(value);
		}
		try {
			const { i: _intent, title: _title, ...rest } = args;
			push(JSON.stringify(rest));
		} catch {
			// Ignore non-serializable values
		}
	}
	return candidates;
}

function matchesRulePattern(rule: ToolInterceptorRule, candidates: readonly string[]): boolean {
	if (!rule.pattern) return false;
	let regex: RegExp;
	try {
		regex = new RegExp(rule.pattern, rule.flags ?? "");
	} catch {
		return false;
	}
	for (const candidate of candidates) {
		regex.lastIndex = 0;
		if (regex.test(candidate)) return true;
	}
	return false;
}

function resolveEffectiveToolName(toolName: string, args: unknown, aliases?: readonly string[]): string {
	const xdPath = normalizeXdPath(args);
	if (xdPath) {
		if (aliases && aliases.length > 0 && aliases[0]) return aliases[0];
		const xdTarget = xdPath.slice("xd://".length).split(/[/?#]/, 1)[0]?.trim();
		if (xdTarget) return xdTarget;
	}
	return toolName;
}

function buildToolJudgmentState(toolName: string, args: unknown): JudgmentState {
	if (isRecord(args)) {
		if (toolName === "eval" && typeof args.code === "string") {
			return {
				tool: toolName,
				...(typeof args.language === "string" ? { language: args.language } : {}),
				...(typeof args.title === "string" ? { title: args.title } : {}),
				code: jevPrefix(args.code, JUDGED_CONTENT_MAX_TOKENS),
			};
		}
		let serialized = "";
		try {
			serialized = JSON.stringify(args, null, 2);
		} catch {
			serialized = String(args);
		}
		return {
			tool: toolName,
			arguments: jevPrefix(serialized, JUDGED_CONTENT_MAX_TOKENS),
		};
	}
	return {
		tool: toolName,
		arguments: jevPrefix(typeof args === "string" ? args : String(args ?? ""), JUDGED_CONTENT_MAX_TOKENS),
	};
}

/**
 * Evaluate tool interceptor rules (both `pattern` and `question` rules) for a tool call.
 *
 * - Rules with `pattern` only block immediately when matched (0ms, no judge call).
 * - Rules with `question` only are batched into a single `judge.judge()` call.
 * - Rules with both `pattern` and `question` use `pattern` as a fast prefilter and
 *   only query the judge when `pattern` matches.
 */
export async function checkToolInterception(
	toolName: string,
	args: unknown,
	options: CheckToolInterceptionOptions = {},
): Promise<InterceptionResult> {
	if (isXdHelpQuery(args)) return { block: false };
	const rules = options.rules ?? DEFAULT_TOOL_INTERCEPTOR_RULES;
	const names = [toolName, ...(options.toolAliases ?? [])].filter(Boolean);
	const availableTools = options.availableTools;
	const effectiveArgs = unwrapXdArgs(args);
	let candidates: string[] | undefined;
	const judgedCandidates: Array<{ rule: ToolInterceptorRule; question: string; suggestedTool?: string }> = [];

	for (const rule of rules) {
		if (!ruleAppliesToPolicy(rule, options.policy)) continue;
		if (!ruleAppliesToTool(rule, names)) continue;
		const suggestedTool = rule.suggestedTool?.trim() || undefined;
		if (suggestedTool && availableTools && !availableTools.includes(suggestedTool)) continue;

		const hasPattern = typeof rule.pattern === "string" && rule.pattern.length > 0;
		const question = typeof rule.question === "string" ? rule.question.trim() : "";
		const hasQuestion = question.length > 0;

		if (!hasPattern && !hasQuestion) continue;

		if (hasPattern) {
			candidates ??= extractCandidateStrings(effectiveArgs);
			if (!matchesRulePattern(rule, candidates)) continue;
			if (!hasQuestion) {
				return {
					block: true,
					message: rule.message,
					suggestedTool,
				};
			}
		}

		if (hasQuestion) {
			judgedCandidates.push({ rule, question, suggestedTool });
		}
	}

	if (judgedCandidates.length === 0) return { block: false };

	const judge = typeof options.judge === "function" ? options.judge() : options.judge;
	if (!judge) return { block: false };

	const questions: Record<string, NoulQuestion> = {};
	for (const [index, candidate] of judgedCandidates.entries()) {
		questions[`q${index}`] = { type: "noul", instructions: candidate.question };
	}

	try {
		const state = buildToolJudgmentState(
			resolveEffectiveToolName(toolName, args, options.toolAliases),
			effectiveArgs,
		);
		const { answers } = await judge.judge(
			{ state, questions },
			options.signal ? { signal: options.signal } : undefined,
		);
		for (const [index, candidate] of judgedCandidates.entries()) {
			const threshold = candidate.rule.threshold ?? JUDGED_RULE_THRESHOLD;
			const probability = answers[`q${index}`]?.noul ?? 0;
			if (probability >= threshold) {
				return {
					block: true,
					message: candidate.rule.message,
					suggestedTool: candidate.suggestedTool,
				};
			}
		}
	} catch (error) {
		if (options.signal?.aborted) throw error;
		logger.debug("toolInterceptor judge failed", { tool: toolName, error: String(error) });
	}

	return { block: false };
}
