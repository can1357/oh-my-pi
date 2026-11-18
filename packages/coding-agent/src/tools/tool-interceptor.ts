/**
 * Tool intent interceptor - redirects or blocks tool calls using regex patterns
 * and/or batched judge questions (`toolInterceptor.rules`).
 */
import type { Judge, JudgmentState, NoulQuestion } from "@oh-my-pi/pi-ai";
import { isRecord, logger, untilAborted } from "@oh-my-pi/pi-utils";
import { jevPrefix, JUDGED_CONTENT_MAX_TOKENS, JUDGED_RULE_THRESHOLD } from "../export/ttsr";
import type { ApprovalPolicy } from "./approval";
import type { InterceptionResult } from "./bash-interceptor";
import { DEFAULT_TOOL_INTERCEPTOR_RULES, type ToolInterceptorRule } from "./settings";

export interface CheckToolInterceptionOptions {
	/** Tool names available in the current session (gates `suggestedTool` when provided). */
	availableTools?: readonly string[];
	/** Additional tool identities for the call (e.g. `policyKey` or `customWireName`). */
	toolAliases?: readonly string[];
	/** Effective approval policy for the call (`"allow"` or `"prompt"`), used to filter `whenPolicy` rules. */
	policy?: ApprovalPolicy;
	/** Interceptor rules to evaluate in order. Defaults to `DEFAULT_TOOL_INTERCEPTOR_RULES`. */
	rules?: readonly ToolInterceptorRule[];
	/** Judge instance or lazy resolver, called only when at least one `question` rule survives prefiltering. */
	judge?: Judge | (() => Judge | undefined);
	/** Cancellation signal forwarded to `judge.judge()`. */
	signal?: AbortSignal;
	/** Per-call judge timeout in milliseconds (defaults to 3000ms). */
	timeoutMs?: number;
	/** Session/settings object used to rate-limit fail-open warnings once per session. */
	warnScope?: object;
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

const compiledGlobs = new Map<string, Bun.Glob>();
const compiledRegexes = new WeakMap<ToolInterceptorRule, { pattern: string; flags: string; regex: RegExp | null }>();

function matchesToolPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return name === pattern;
	let glob = compiledGlobs.get(pattern);
	if (!glob) {
		glob = new Bun.Glob(pattern);
		compiledGlobs.set(pattern, glob);
	}
	return glob.match(name);
}

function ruleAppliesToTool(rule: ToolInterceptorRule, names: readonly string[]): boolean {
	const patterns = normalizeTargetPatterns(rule);
	return patterns.some(pattern => names.some(name => matchesToolPattern(name, pattern)));
}

function ruleAppliesToPolicy(rule: ToolInterceptorRule, policy: ApprovalPolicy | undefined): boolean {
	if (rule.whenPolicy !== "prompt" && rule.whenPolicy !== "allow") return true;
	return policy === rule.whenPolicy;
}

/**
 * Whether any rule in `rules` could apply to `toolNames` under `options`.
 * Used by speculative execution gates so speculation is only vetoed for tools
 * targeted by an active rule.
 */
export function hasApplicableToolInterceptorRules(
	toolNames: string | readonly string[],
	options: {
		rules?: readonly ToolInterceptorRule[];
		availableTools?: readonly string[];
		policy?: ApprovalPolicy;
	} = {},
): boolean {
	const rules = options.rules ?? DEFAULT_TOOL_INTERCEPTOR_RULES;
	const names = (typeof toolNames === "string" ? [toolNames] : [...toolNames]).filter(Boolean);
	if (names.length === 0) return false;
	const availableTools = options.availableTools;
	for (const rule of rules) {
		if (!ruleAppliesToPolicy(rule, options.policy)) continue;
		if (!ruleAppliesToTool(rule, names)) continue;
		const suggestedTool = rule.suggestedTool?.trim() || undefined;
		if (suggestedTool && !availableTools?.includes(suggestedTool)) continue;
		const hasPattern = typeof rule.pattern === "string" && rule.pattern.length > 0;
		const hasQuestion = typeof rule.question === "string" && rule.question.trim().length > 0;
		if (hasPattern || hasQuestion) return true;
	}
	return false;
}

const DEFAULT_JUDGMENT_TIMEOUT_MS = 3_000;
const warnedMissingJudgeScopes = new WeakSet<object>();
const warnedJudgeFailureScopes = new WeakSet<object>();
let warnedMissingJudgeFallback = false;
let warnedJudgeFailureFallback = false;

function shouldWarnOnce(scopes: WeakSet<object>, scope: object | undefined, kind: "missing" | "failure"): boolean {
	if (scope) {
		if (scopes.has(scope)) return false;
		scopes.add(scope);
		return true;
	}
	if (kind === "missing") {
		if (warnedMissingJudgeFallback) return false;
		warnedMissingJudgeFallback = true;
		return true;
	}
	if (warnedJudgeFailureFallback) return false;
	warnedJudgeFailureFallback = true;
	return true;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Format the user/model-facing deny reason, surfacing `suggestedTool` when omitted from `message`. */
export function formatInterceptionDenyReason(interception: InterceptionResult): string | undefined {
	const message = interception.message?.trim();
	const suggestedTool = interception.suggestedTool?.trim();
	if (!message) return suggestedTool ? `Use the \`${suggestedTool}\` tool instead.` : undefined;
	if (!suggestedTool) return message;
	const toolToken = new RegExp(`(?:^|[^\\w-])${escapeRegExp(suggestedTool)}(?:$|[^\\w-])`);
	if (toolToken.test(message)) return message;
	return `${message} (Suggested tool: \`${suggestedTool}\`)`;
}

const PRIMARY_ARG_KEYS = ["code", "command", "input", "content", "path", "query"] as const;

function extractCandidateStrings(toolName: string, args: unknown): string[] {
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
		if (toolName === "eval" && typeof args.code === "string") {
			push(args.code);
			return candidates;
		}
		if (toolName === "bash" && typeof args.command === "string") {
			push(args.command);
			return candidates;
		}
		for (const key of PRIMARY_ARG_KEYS) {
			const value = args[key];
			if (typeof value === "string") push(value);
		}
		try {
			const { i: _intent, ...rest } = args;
			push(JSON.stringify(rest));
		} catch {
			// Ignore non-serializable values
		}
	}
	return candidates;
}

function getCompiledRuleRegex(rule: ToolInterceptorRule): RegExp | null {
	if (!rule.pattern) return null;
	const flags = rule.flags ?? "";
	const cached = compiledRegexes.get(rule);
	if (cached && cached.pattern === rule.pattern && cached.flags === flags) {
		return cached.regex;
	}
	let regex: RegExp | null;
	try {
		regex = new RegExp(rule.pattern, flags);
	} catch {
		regex = null;
	}
	compiledRegexes.set(rule, { pattern: rule.pattern, flags, regex });
	return regex;
}

function matchesRulePattern(rule: ToolInterceptorRule, candidates: readonly string[]): boolean {
	const regex = getCompiledRuleRegex(rule);
	if (!regex) return false;
	for (const candidate of candidates) {
		regex.lastIndex = 0;
		if (regex.test(candidate)) return true;
	}
	return false;
}

function buildToolJudgmentState(toolName: string, args: unknown): JudgmentState {
	if (isRecord(args)) {
		if (toolName === "eval" && typeof args.code === "string") {
			return {
				tool: toolName,
				...(typeof args.language === "string" ? { language: args.language } : {}),
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
	const rules = options.rules ?? DEFAULT_TOOL_INTERCEPTOR_RULES;
	const names = [toolName, ...(options.toolAliases ?? [])].filter(Boolean);
	const availableTools = options.availableTools;
	let candidates: string[] | undefined;
	const judgedCandidates: Array<{ rule: ToolInterceptorRule; question: string; suggestedTool?: string }> = [];
	let fallbackPatternBlock: InterceptionResult | undefined;

	for (const rule of rules) {
		if (!ruleAppliesToPolicy(rule, options.policy)) continue;
		if (!ruleAppliesToTool(rule, names)) continue;
		const suggestedTool = rule.suggestedTool?.trim() || undefined;
		if (suggestedTool && !availableTools?.includes(suggestedTool)) continue;

		const hasPattern = typeof rule.pattern === "string" && rule.pattern.length > 0;
		const question = typeof rule.question === "string" ? rule.question.trim() : "";
		const hasQuestion = question.length > 0;

		if (!hasPattern && !hasQuestion) continue;

		if (hasPattern) {
			candidates ??= extractCandidateStrings(toolName, args);
			if (!matchesRulePattern(rule, candidates)) continue;
			if (!hasQuestion) {
				const patternBlock: InterceptionResult = {
					block: true,
					message: rule.message,
					suggestedTool,
				};
				if (judgedCandidates.length === 0) return patternBlock;
				// Earlier `question` rules exist: run the batch for them first so rule order is preserved,
				// falling back to this pattern-only match if none of the earlier questions block.
				fallbackPatternBlock = patternBlock;
				break;
			}
		}

		if (hasQuestion) {
			judgedCandidates.push({ rule, question, suggestedTool });
		}
	}

	if (judgedCandidates.length === 0) return fallbackPatternBlock ?? { block: false };

	const questions: Record<string, NoulQuestion> = {};
	for (const [index, candidate] of judgedCandidates.entries()) {
		questions[`q${index}`] = { type: "noul", instructions: candidate.question };
	}

	const timeoutMs =
		typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
			? options.timeoutMs
			: DEFAULT_JUDGMENT_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const judgeSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	try {
		const judge = typeof options.judge === "function" ? options.judge() : options.judge;
		if (!judge) {
			if (shouldWarnOnce(warnedMissingJudgeScopes, options.warnScope, "missing")) {
				logger.warn("toolInterceptor: judge role unavailable; question-backed rules are failing open", {
					tool: toolName,
				});
			}
			return fallbackPatternBlock ?? { block: false };
		}
		const state = buildToolJudgmentState(toolName, args);
		const { answers } = await untilAborted(judgeSignal, () =>
			judge.judge({ state, questions }, { signal: judgeSignal }),
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
		if (shouldWarnOnce(warnedJudgeFailureScopes, options.warnScope, "failure")) {
			logger.warn("toolInterceptor: judge evaluation failed; question-backed rules are failing open", {
				tool: toolName,
				error: String(error),
			});
		} else {
			logger.debug("toolInterceptor judge failed", { tool: toolName, error: String(error) });
		}
	}

	return fallbackPatternBlock ?? { block: false };
}
