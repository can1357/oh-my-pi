/**
 * Time Traveling Stream Rules (TTSR) Manager
 *
 * Manages rules that get injected mid-stream when their condition pattern matches
 * the agent's output. When a match occurs, the stream is aborted, the rule is
 * injected as a system reminder, and the request is retried.
 *
 * Judged rules (`question`) never match mid-stream: the session asks the judge
 * model about each completed output ({@link TtsrManager.judgedCandidates}) and
 * delivers a yes as a non-interrupting warning.
 */
import * as path from "node:path";
import type { Judge, JudgeOptions, NoulQuestion } from "@oh-my-pi/pi-ai";
import { AstMatchStrictness, astMatch, countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { compileRuleCondition, type Rule } from "../capability/rule";
import type { TtsrSettings } from "../config/settings";

export type TtsrMatchSource = "text" | "thinking" | "tool";

/** Context about the stream content currently being checked against TTSR rules. */
export interface TtsrMatchContext {
	source: TtsrMatchSource;
	/** Tool name for tool argument deltas, e.g. "edit" or "write". */
	toolName?: string;
	/** Candidate file paths associated with the current stream chunk. */
	filePaths?: string[];
	/** Stable key to isolate buffering (for example a tool call ID). */
	streamKey?: string;
}

/** One completed assistant output (reply, reasoning, or one file of a tool call) as rules see it. */
export interface TtsrOutput {
	content: string;
	context: TtsrMatchContext;
	/** How warnings name the output, e.g. "reply" or "`edit` call on `src/a.ts`". */
	subject: string;
}

/** A judged rule eligible for one output, with its question. */
export interface JudgedCandidate {
	rule: Rule;
	question: string;
}

/** Yes-probability at or above which a judged rule counts as violated. */
export const JUDGED_RULE_THRESHOLD = 0.7;
/**
 * Jev tokens of output content sent per judgment. Jev rejects a judgment branch
 * past ~33k tokens (`max_tokens_exceeded`), and each branch also carries the
 * request template, the state keys, the subject and one question.
 */
export const JUDGED_CONTENT_MAX_TOKENS = 32_000;

/** Longest prefix of `text` within `maxTokens` Jev tokens, never ending on half a surrogate pair. */
function jevPrefix(text: string, maxTokens: number): string {
	if (countTokens(text, Encoding.Jev) <= maxTokens) return text;
	// Counts grow with length up to whole-word jitter, so bisect; `lo` always fits, `hi` never does.
	let lo = 0;
	let hi = text.length;
	while (hi - lo > 1) {
		const mid = (lo + hi) >>> 1;
		if (countTokens(text.slice(0, mid), Encoding.Jev) <= maxTokens) lo = mid;
		else hi = mid;
	}
	const last = text.charCodeAt(lo - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? lo - 1 : lo);
}

/**
 * Ask every candidate's question about `output` in one request — Jev bills the
 * shared state once — and return the rules judged violated. Judge failures
 * propagate to the caller.
 */
export async function judgeRules(
	judge: Judge,
	output: TtsrOutput,
	candidates: readonly JudgedCandidate[],
	options?: JudgeOptions,
): Promise<Rule[]> {
	const questions: Record<string, NoulQuestion> = {};
	for (const [index, candidate] of candidates.entries()) {
		questions[`q${index}`] = { type: "noul", instructions: candidate.question };
	}
	const { answers } = await judge.judge(
		{ state: { output: output.subject, content: jevPrefix(output.content, JUDGED_CONTENT_MAX_TOKENS) }, questions },
		options,
	);
	return candidates
		.filter((_, index) => answers[`q${index}`].noul >= JUDGED_RULE_THRESHOLD)
		.map(candidate => candidate.rule);
}

interface ToolScope {
	toolName?: string;
	pathGlob?: Bun.Glob;
	pathPattern?: string;
}

interface TtsrScope {
	allowText: boolean;
	allowThinking: boolean;
	allowAnyTool: boolean;
	toolScopes: ToolScope[];
}

interface TtsrEntry {
	rule: Rule;
	conditions: RegExp[];
	/** ast-grep pattern strings; matched only against edit/write tool snapshots. */
	astConditions: string[];
	/** Judge question; set → conditions only prefilter completed output, never stream matches. */
	question?: string;
	scope: TtsrScope;
	globalPathGlobs?: Bun.Glob[];
}

/** Tracks when a rule was last injected (for repeat gating). */
interface InjectionRecord {
	/** Message count (turn index) when the rule was last injected. */
	lastInjectedAt: number;
}

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
	enabled: true,
	judge: "auto",
	contextMode: "discard",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
	builtinRules: true,
	disabledRules: [],
};

const DEFAULT_SCOPE: TtsrScope = {
	allowText: true,
	allowThinking: false,
	allowAnyTool: true,
	toolScopes: [],
};

export class TtsrManager {
	readonly #settings: Required<TtsrSettings>;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #buffers = new Map<string, string>();
	/** Last snapshot evaluated for AST conditions, keyed by stream key, to dedupe matcher runs. */
	readonly #lastAstSnapshots = new Map<string, string>();
	#messageCount = 0;
	#canMatchText = false;
	#canMatchThinking = false;
	#hasJudgedRules = false;

	constructor(settings?: TtsrSettings) {
		this.#settings = { ...DEFAULT_SETTINGS, ...settings };
	}

	/** Check if a rule can be triggered based on repeat settings. */
	#canTrigger(ruleName: string): boolean {
		const record = this.#injectionRecords.get(ruleName);
		if (!record) {
			return true;
		}

		if (this.#settings.repeatMode === "once") {
			return false;
		}

		const gap = this.#messageCount - record.lastInjectedAt;
		return gap >= this.#settings.repeatGap;
	}

	#compileConditions(rule: Rule): RegExp[] {
		const compiled: RegExp[] = [];
		for (const pattern of rule.condition ?? []) {
			try {
				compiled.push(compileRuleCondition(pattern));
			} catch (error) {
				logger.warn("TTSR condition has invalid regex pattern, skipping condition", {
					ruleName: rule.name,
					pattern,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return compiled;
	}

	#compileGlobalPathGlobs(globs: Rule["globs"]): Bun.Glob[] | undefined {
		if (!globs || globs.length === 0) {
			return undefined;
		}

		const compiled = globs
			.map(glob => glob.trim())
			.filter(glob => glob.length > 0)
			.map(glob => new Bun.Glob(glob));
		return compiled.length > 0 ? compiled : undefined;
	}

	#parseToolScopeToken(token: string): ToolScope | undefined {
		const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(
			token,
		);
		if (!match) {
			return undefined;
		}

		const groups = match.groups;
		const hasToolPrefix = groups?.prefix !== undefined;
		const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase();
		const pathPattern = groups?.path?.trim();

		if (!pathPattern) {
			return { toolName };
		}

		return {
			toolName,
			pathPattern,
			pathGlob: new Bun.Glob(pathPattern),
		};
	}

	#buildScope(rule: Rule): TtsrScope {
		if (!rule.scope || rule.scope.length === 0) {
			return {
				allowText: DEFAULT_SCOPE.allowText,
				allowThinking: DEFAULT_SCOPE.allowThinking,
				allowAnyTool: DEFAULT_SCOPE.allowAnyTool,
				toolScopes: [...DEFAULT_SCOPE.toolScopes],
			};
		}

		const scope: TtsrScope = {
			allowText: false,
			allowThinking: false,
			allowAnyTool: false,
			toolScopes: [],
		};

		for (const rawToken of rule.scope) {
			const token = rawToken.trim();
			const normalizedToken = token.toLowerCase();
			if (token.length === 0) {
				continue;
			}

			if (normalizedToken === "text") {
				scope.allowText = true;
				continue;
			}

			if (normalizedToken === "thinking") {
				scope.allowThinking = true;
				continue;
			}

			if (normalizedToken === "tool" || normalizedToken === "toolcall") {
				scope.allowAnyTool = true;
				continue;
			}

			const toolScope = this.#parseToolScopeToken(token);
			if (!toolScope) {
				logger.warn("TTSR scope token is invalid, skipping token", {
					ruleName: rule.name,
					token: rawToken,
				});
				continue;
			}

			if (!toolScope.toolName && !toolScope.pathGlob) {
				scope.allowAnyTool = true;
				continue;
			}

			scope.toolScopes.push(toolScope);
		}

		return scope;
	}

	#hasReachableScope(scope: TtsrScope): boolean {
		return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
	}

	#bufferKey(context: TtsrMatchContext): string {
		if (context.streamKey && context.streamKey.trim().length > 0) {
			return context.streamKey;
		}
		if (context.source !== "tool") {
			return context.source;
		}
		const toolName = context.toolName?.trim().toLowerCase();
		return toolName ? `tool:${toolName}` : "tool";
	}

	#normalizePath(pathValue: string): string {
		return pathValue.replaceAll("\\", "/");
	}

	#matchesGlob(glob: Bun.Glob, filePaths: string[] | undefined): boolean {
		if (!filePaths || filePaths.length === 0) {
			return false;
		}
		for (const filePath of filePaths) {
			const normalized = this.#normalizePath(filePath);
			if (glob.match(normalized)) {
				return true;
			}
			const slashIndex = normalized.lastIndexOf("/");
			const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
			if (basename !== normalized && glob.match(basename)) {
				return true;
			}
		}

		return false;
	}

	#matchesGlobalPaths(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (!entry.globalPathGlobs || entry.globalPathGlobs.length === 0) {
			return true;
		}

		for (const glob of entry.globalPathGlobs) {
			if (this.#matchesGlob(glob, context.filePaths)) {
				return true;
			}
		}

		return false;
	}

	#matchesScope(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (context.source === "text") {
			return entry.scope.allowText;
		}

		if (context.source === "thinking") {
			return entry.scope.allowThinking;
		}

		if (entry.scope.allowAnyTool) {
			return true;
		}

		const toolName = context.toolName?.trim().toLowerCase();
		for (const toolScope of entry.scope.toolScopes) {
			if (toolScope.toolName && toolScope.toolName !== toolName) {
				continue;
			}
			if (toolScope.pathGlob && !this.#matchesGlob(toolScope.pathGlob, context.filePaths)) {
				continue;
			}
			return true;
		}

		return false;
	}

	#matchesCondition(entry: TtsrEntry, streamBuffer: string): boolean {
		for (const condition of entry.conditions) {
			condition.lastIndex = 0;
			if (condition.test(streamBuffer)) {
				return true;
			}
		}
		return false;
	}

	/** Add a TTSR rule to be monitored. */
	addRule(rule: Rule): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		if (this.#rules.has(rule.name)) {
			return false;
		}

		const conditions = this.#compileConditions(rule);
		const astConditions = (rule.astCondition ?? []).map(pattern => pattern.trim()).filter(p => p.length > 0);
		const question = rule.question?.trim() || undefined;
		if (conditions.length === 0 && astConditions.length === 0 && !question) {
			return false;
		}

		const scope = this.#buildScope(rule);
		if (!this.#hasReachableScope(scope)) {
			logger.warn("TTSR scope excludes all streams, skipping rule", {
				ruleName: rule.name,
				scope: rule.scope,
			});
			return false;
		}
		const globalPathGlobs = this.#compileGlobalPathGlobs(rule.globs);
		this.#rules.set(rule.name, {
			rule,
			conditions,
			astConditions,
			question,
			scope,
			globalPathGlobs,
		});
		if (question) {
			this.#hasJudgedRules = true;
		} else {
			if (scope.allowText) this.#canMatchText = true;
			if (scope.allowThinking) this.#canMatchThinking = true;
		}

		logger.debug("TTSR rule registered", {
			ruleName: rule.name,
			conditions: rule.condition,
			astConditions: rule.astCondition,
			question,
			scope: rule.scope,
			globs: rule.globs,
		});

		return true;
	}

	/**
	 * Add a stream chunk to its scoped buffer and return matching rules.
	 *
	 * Buffers are isolated by source/tool key so matches don't bleed across
	 * assistant prose, thinking text, and unrelated tool argument streams.
	 */
	checkDelta(delta: string, context: TtsrMatchContext): Rule[] {
		if (context.source === "text" && !this.#canMatchText) {
			return [];
		}
		if (context.source === "thinking" && !this.#canMatchThinking) {
			return [];
		}
		const bufferKey = this.#bufferKey(context);
		const nextBuffer = `${this.#buffers.get(bufferKey) ?? ""}${delta}`;
		this.#buffers.set(bufferKey, nextBuffer);
		return this.#matchBuffer(nextBuffer, context);
	}

	/**
	 * Replace the scoped buffer with a tool-provided normalized snapshot and
	 * return matching rules.
	 *
	 * Used for tools exposing `matcherDigest`: the digest is recomputed from the
	 * full (partial) arguments on every delta, so it replaces the buffer instead
	 * of being appended to it.
	 */
	checkSnapshot(snapshot: string, context: TtsrMatchContext): Rule[] {
		const bufferKey = this.#bufferKey(context);
		this.#buffers.set(bufferKey, snapshot);
		return this.#matchBuffer(snapshot, context);
	}

	/** Derive an ast-grep language alias from candidate paths (bare extension, e.g. "ts"), if any. */
	#deriveLang(filePaths: string[] | undefined): string | undefined {
		for (const filePath of filePaths ?? []) {
			const ext = path.extname(this.#normalizePath(filePath));
			if (ext.length > 1) {
				return ext.slice(1).toLowerCase();
			}
		}
		return undefined;
	}

	/**
	 * Evaluate ast-grep `astCondition` rules against a reconstructed tool snapshot.
	 *
	 * Only edit/write tool streams reach here (AST conditions need a language, which
	 * we infer from the file extension on the tool's path argument). The snapshot is
	 * matched in memory by the native engine (`astMatch`), so this is async and
	 * intentionally throttled: identical consecutive snapshots (the common case when
	 * only non-source arguments change between deltas) are skipped.
	 */
	async checkAstSnapshot(snapshot: string, context: TtsrMatchContext): Promise<Rule[]> {
		if (!this.#settings.enabled || context.source !== "tool") {
			return [];
		}

		const lang = this.#deriveLang(context.filePaths);
		if (!lang) {
			return [];
		}

		const candidates: TtsrEntry[] = [];
		for (const [name, entry] of this.#rules) {
			if (entry.astConditions.length === 0 || entry.question) {
				continue;
			}
			if (
				!this.#canTrigger(name) ||
				!this.#matchesScope(entry, context) ||
				!this.#matchesGlobalPaths(entry, context)
			) {
				continue;
			}
			candidates.push(entry);
		}
		if (candidates.length === 0) {
			return [];
		}

		// Throttle: skip re-running the matcher when the source content is unchanged.
		const bufferKey = this.#bufferKey(context);
		if (this.#lastAstSnapshots.get(bufferKey) === snapshot) {
			return [];
		}
		this.#lastAstSnapshots.set(bufferKey, snapshot);

		const matches: Rule[] = [];
		for (const entry of candidates) {
			if (await this.#astConditionsMatch(entry.astConditions, snapshot, lang)) {
				matches.push(entry.rule);
				logger.debug("TTSR ast condition matched", {
					ruleName: entry.rule.name,
					astConditions: entry.rule.astCondition,
					toolName: context.toolName,
					filePaths: context.filePaths,
				});
			}
		}
		return matches;
	}

	async #astConditionsMatch(patterns: string[], source: string, lang: string): Promise<boolean> {
		try {
			const result = await astMatch({
				patterns,
				source,
				lang,
				strictness: AstMatchStrictness.Smart,
				limit: 1,
			});
			return result.totalMatches > 0;
		} catch (error) {
			logger.warn("TTSR ast match failed, treating as no match", {
				patterns,
				lang,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/** True when any stream-matched rule carries ast-grep conditions. */
	hasAstRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		for (const entry of this.#rules.values()) {
			if (entry.astConditions.length > 0 && !entry.question) {
				return true;
			}
		}
		return false;
	}

	/** True when any registered rule is judged (`question`). */
	hasJudgedRules(): boolean {
		return this.#settings.enabled && this.#hasJudgedRules;
	}

	/**
	 * Judged rules to ask about one completed output: in scope, inside the rule's
	 * path globs, past the repeat gate, and — when the rule also declares
	 * `condition`/`astCondition` — passing that cheap prefilter first.
	 */
	async judgedCandidates(content: string, context: TtsrMatchContext): Promise<JudgedCandidate[]> {
		if (!this.hasJudgedRules()) {
			return [];
		}
		const candidates: JudgedCandidate[] = [];
		for (const [name, entry] of this.#rules) {
			if (
				!entry.question ||
				!this.#canTrigger(name) ||
				!this.#matchesScope(entry, context) ||
				!this.#matchesGlobalPaths(entry, context) ||
				!(await this.#passesPrefilter(entry, content, context))
			) {
				continue;
			}
			candidates.push({ rule: entry.rule, question: entry.question });
		}
		return candidates;
	}

	async #passesPrefilter(entry: TtsrEntry, content: string, context: TtsrMatchContext): Promise<boolean> {
		if (entry.conditions.length === 0 && entry.astConditions.length === 0) {
			return true;
		}
		if (this.#matchesCondition(entry, content)) {
			return true;
		}
		const lang = context.source === "tool" ? this.#deriveLang(context.filePaths) : undefined;
		return lang !== undefined && entry.astConditions.length > 0
			? this.#astConditionsMatch(entry.astConditions, content, lang)
			: false;
	}

	/**
	 * Claim judged verdicts for delivery: drop rules another verdict already
	 * claimed or that cannot repeat yet, and mark the rest injected so
	 * concurrent judgments cannot deliver them twice.
	 */
	claim(rules: readonly Rule[]): Rule[] {
		const claimed = rules.filter(rule => this.#canTrigger(rule.name));
		this.markInjected(claimed);
		return claimed;
	}

	#matchBuffer(buffer: string, context: TtsrMatchContext): Rule[] {
		if (!this.#settings.enabled) {
			return [];
		}
		const matches: Rule[] = [];
		for (const [name, entry] of this.#rules) {
			if (entry.question || !this.#canTrigger(name)) {
				continue;
			}
			if (!this.#matchesScope(entry, context)) {
				continue;
			}
			if (!this.#matchesGlobalPaths(entry, context)) {
				continue;
			}
			if (!this.#matchesCondition(entry, buffer)) {
				continue;
			}

			matches.push(entry.rule);
			logger.debug("TTSR condition matched", {
				ruleName: name,
				conditions: entry.rule.condition,
				source: context.source,
				toolName: context.toolName,
				filePaths: context.filePaths,
			});
		}

		return matches;
	}

	/** Mark rules as injected (won't trigger again until conditions allow). */
	markInjected(rulesToMark: Rule[]): void {
		this.markInjectedByNames(rulesToMark.map(rule => rule.name));
	}

	/** Mark rule names as injected (won't trigger again until conditions allow). */
	markInjectedByNames(ruleNames: string[]): void {
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) {
				continue;
			}
			const record = this.#injectionRecords.get(ruleName);
			if (!record) {
				this.#injectionRecords.set(ruleName, { lastInjectedAt: this.#messageCount });
			} else {
				record.lastInjectedAt = this.#messageCount;
			}
			logger.debug("TTSR rule marked as injected", {
				ruleName,
				messageCount: this.#messageCount,
				repeatMode: this.#settings.repeatMode,
			});
		}
	}

	/** Get names of all injected rules (for persistence). */
	getInjectedRuleNames(): string[] {
		return Array.from(this.#injectionRecords.keys());
	}

	/** Restore injected state from a list of rule names. */
	restoreInjected(ruleNames: string[]): void {
		for (const name of ruleNames) {
			this.#injectionRecords.set(name, { lastInjectedAt: 0 });
		}
		if (ruleNames.length > 0) {
			logger.debug("TTSR injected state restored", { ruleNames });
		}
	}

	/**
	 * Reset stream buffers. Called at every stream boundary: a new turn, a new
	 * assistant message within a turn, and a restarted response. Buffers never
	 * span two assistant messages; repeat-after-gap counters are untouched.
	 */
	resetBuffer(): void {
		this.#buffers.clear();
		this.#lastAstSnapshots.clear();
	}

	/** Check if any TTSR rules are registered. */
	hasRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		return this.#rules.size > 0;
	}

	/**
	 * Atomically replace monitored rules while retaining injection state for names
	 * that remain registered.
	 *
	 * Returns the names accepted for TTSR monitoring so the caller can bucket
	 * rejected conditional rules through its normal fallback path.
	 */
	replaceRules(rules: readonly Rule[]): Set<string> {
		const replacement = new TtsrManager(this.#settings);
		for (const rule of rules) {
			replacement.addRule(rule);
		}

		const registered = new Set(replacement.#rules.keys());
		this.#rules.clear();
		for (const [name, entry] of replacement.#rules) {
			this.#rules.set(name, entry);
		}
		this.#canMatchText = replacement.#canMatchText;
		this.#canMatchThinking = replacement.#canMatchThinking;
		this.#hasJudgedRules = replacement.#hasJudgedRules;
		this.resetBuffer();

		for (const name of this.#injectionRecords.keys()) {
			if (!registered.has(name)) this.#injectionRecords.delete(name);
		}
		return registered;
	}

	/** All rules currently registered for TTSR monitoring, in registration order. */
	getRules(): Rule[] {
		return Array.from(this.#rules.values(), entry => entry.rule);
	}

	/** Increment message counter (call after each turn). */
	incrementMessageCount(): void {
		this.#messageCount++;
	}

	/** Get current message count. */
	getMessageCount(): number {
		return this.#messageCount;
	}

	/** Get settings. */
	getSettings(): Required<TtsrSettings> {
		return this.#settings;
	}
}
