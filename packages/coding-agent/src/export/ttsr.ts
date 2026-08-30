/**
 * Time Traveling Stream Rules (TTSR) Manager
 *
 * Manages rules that get injected mid-stream when their condition pattern matches
 * the agent's output. When a match occurs, the stream is aborted, the rule is
 * injected as a system reminder, and the request is retried.
 */
import * as path from "node:path";
import { AstMatchStrictness, astMatch } from "@oh-my-pi/pi-natives";
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

/** Order-sensitive equality of two optional string arrays. */
function stringArrayEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Whether two same-named rules compile to the SAME TTSR registration. Compares
 * only the fields that feed the compiled entry (conditions, ast conditions,
 * scope, globs) plus per-rule interrupt override — the inputs to
 * `#compileConditions`/`#buildScope`/`#compileGlobalPathGlobs`. An edit to any
 * of these must recompile the entry; an edit to unrelated fields (a rulebook
 * description, prose body) leaves the monitored behavior unchanged and keeps
 * the existing entry, so its trigger/injection state is preserved verbatim.
 */
function ttsrRuleContentEqual(a: Rule, b: Rule): boolean {
	return (
		stringArrayEqual(a.condition, b.condition) &&
		stringArrayEqual(a.astCondition, b.astCondition) &&
		stringArrayEqual(a.scope, b.scope) &&
		stringArrayEqual(a.globs, b.globs) &&
		a.interruptMode === b.interruptMode
	);
}

export class TtsrManager {
	#settings: Required<TtsrSettings>;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #buffers = new Map<string, string>();
	/** Last snapshot evaluated for AST conditions, keyed by stream key, to dedupe matcher runs. */
	readonly #lastAstSnapshots = new Map<string, string>();
	#messageCount = 0;
	#canMatchText = false;
	#canMatchThinking = false;

	constructor(settings?: TtsrSettings) {
		this.#settings = { ...DEFAULT_SETTINGS, ...settings };
	}

	/**
	 * Apply reloaded runtime settings (`ttsr.enabled`/`contextMode`/`interruptMode`/
	 * `repeatMode`/`repeatGap`, plus `builtinRules`/`disabledRules` gating) to the
	 * live manager on an in-session refresh, WITHOUT tearing it down: registered
	 * rules, injection records, buffers, and the message counter are preserved, so
	 * an already-injected rule stays injected and repeat gaps keep counting. Only
	 * the settings snapshot the runtime reads (`getSettings`, `#canTrigger`,
	 * enablement gates) is replaced.
	 */
	reconfigure(settings: Partial<TtsrSettings>): void {
		this.#settings = { ...this.#settings, ...settings };
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
		if (conditions.length === 0 && astConditions.length === 0) {
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
			scope,
			globalPathGlobs,
		});
		if (scope.allowText) this.#canMatchText = true;
		if (scope.allowThinking) this.#canMatchThinking = true;

		logger.debug("TTSR rule registered", {
			ruleName: rule.name,
			conditions: rule.condition,
			astConditions: rule.astCondition,
			scope: rule.scope,
			globs: rule.globs,
		});

		return true;
	}

	/**
	 * Register a condition-bearing rule, or — when a rule of the SAME name is
	 * already registered — recompile its entry in place if its TTSR-relevant
	 * content changed. This is the in-session refresh path: an edited rule keeps
	 * its name, so {@link addRule} alone returns early (name present) and leaves
	 * the STALE compiled conditions/scope/globs live — still matched, and still
	 * republished verbatim via `getRules()`/`rule://`. The injection record is
	 * keyed by name in a separate map, so replacing the `#rules` entry preserves
	 * it: an already-injected rule stays injected across the recompile.
	 *
	 * Returns whether the rule is registered for monitoring after the call, so a
	 * caller can bucket it as consumed (mirrors {@link hasRule}).
	 */
	addOrUpdateRule(rule: Rule): boolean {
		if (!this.#settings.enabled) return false;
		const existing = this.#rules.get(rule.name);
		if (!existing) return this.addRule(rule);
		if (ttsrRuleContentEqual(existing.rule, rule)) {
			// Recompilation is unnecessary — the compiled conditions/scope/globs
			// are unchanged — but `content`/`description` are deliberately omitted
			// from that predicate, so an edit to only the prose body or the
			// description would otherwise leave the STALE rule object live: matches
			// would inject the old `content` and `getRules()`/`rule://` would
			// republish it. Swap the stored reference to the fresh rule in place so
			// those fields are current, without touching the compiled entry or
			// `#injectionRecords`/arming flags.
			existing.rule = rule;
			return true;
		}
		// Recompile from the edited rule. Drop the stale entry first so `addRule`
		// (which no-ops on an existing name) proceeds; `#injectionRecords` is
		// untouched, so the injection state carries over. If the edit removed the
		// rule's usable condition or reachable scope it is no longer a TTSR rule:
		// shed its injection record and recompute the arming flags.
		this.#rules.delete(rule.name);
		const added = this.addRule(rule);
		if (!added) {
			this.#injectionRecords.delete(rule.name);
			this.#recomputeCanMatchFlags();
		}
		return added;
	}

	/**
	 * Reconcile the registered rule set against the names still discovered and
	 * ENABLED on an in-session refresh. A condition-bearing rule deleted from
	 * disk or added to `ttsr.disabledRules` is no longer in `keep`, so its stale
	 * registration is dropped here — otherwise `getRules()` would keep
	 * republishing it into `activeRules` (reachable via `rule://`, still
	 * triggering). Rules that survive keep their injection/trigger state
	 * untouched (the reuse-not-replace contract); only dropped rules shed their
	 * injection record. `canMatch*` flags are recomputed from the survivors so a
	 * removed text/thinking rule stops arming those buffers.
	 */
	retainRules(keep: ReadonlySet<string>): void {
		for (const name of [...this.#rules.keys()]) {
			if (keep.has(name)) continue;
			this.#rules.delete(name);
			this.#injectionRecords.delete(name);
		}
		this.#recomputeCanMatchFlags();
	}

	/** Recompute the text/thinking arming flags from the currently registered rules. */
	#recomputeCanMatchFlags(): void {
		this.#canMatchText = false;
		this.#canMatchThinking = false;
		for (const entry of this.#rules.values()) {
			if (entry.scope.allowText) this.#canMatchText = true;
			if (entry.scope.allowThinking) this.#canMatchThinking = true;
		}
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
			if (entry.astConditions.length === 0) {
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

	/** True when any registered rule carries ast-grep conditions. */
	hasAstRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		for (const entry of this.#rules.values()) {
			if (entry.astConditions.length > 0) {
				return true;
			}
		}
		return false;
	}

	#matchBuffer(buffer: string, context: TtsrMatchContext): Rule[] {
		if (!this.#settings.enabled) {
			return [];
		}
		const matches: Rule[] = [];
		for (const [name, entry] of this.#rules) {
			if (!this.#canTrigger(name)) {
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

	/** Reset stream buffers (called on new turn). */
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
	 * Whether a rule with this name is currently registered for TTSR monitoring.
	 * Distinct from `addRule`'s return (which is `true` only on the call that
	 * first registers a rule): a rule already registered on a prior reload is
	 * still held here, so bucketing can tell "consumed by TTSR" from "rejected".
	 */
	hasRule(name: string): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		return this.#rules.has(name);
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
