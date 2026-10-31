import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Tool, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { JobWidgetEntry } from "../tools/job-widget";
import type { CompactionBoundaries } from "./context-usage";
import type { StatusLineSettings, StatusResetExpiry } from "./types";

export interface StatusAccountIdentity {
	accountId?: string;
	email?: string;
	projectId?: string;
	orgId?: string;
}

/** Nested repository selected as the active workspace context. */
export interface ActiveRepoContext {
	cwd: string;
	repoRoot: string;
	relativeRepoRoot: string;
	source: "single-direct-child-repo";
}

/** Why the next request rewrites the cached prompt prefix instead of reading it. */
export type PromptCacheColdReason =
	| { kind: "expired"; at: number }
	/** omp's warm refresh found the entry gone. */
	| { kind: "refresh-missed" }
	| { kind: "model"; from: string; to: string }
	| { kind: "thinking"; from: string; to: string }
	| { kind: "tools" }
	| { kind: "system-prompt" }
	| { kind: "retention" }
	| { kind: "compaction" };

/** omp's cache warmer as it concerns the entry. */
export interface PromptCacheWarming {
	/** `scheduled`: a refresh decision is armed; `refreshing`: a refresh is in flight. */
	state: "scheduled" | "refreshing" | "inactive";
	/** When the armed refresh decides. */
	nextWarmAt?: number;
	/** When warming gives up: its 60-minute streaming or 30-minute idle safety window. */
	stopsAt?: number;
	/** Why nothing is scheduled. */
	reason?: string;
}

/** What the next request finds in the prompt cache: the `cache` segment's chip and its details. */
export interface PromptCacheStatus {
	/** `cold`: the next request rewrites the cached prefix. */
	state: "warm" | "cold";
	/** Why it is cold; absent while warm. */
	reason?: PromptCacheColdReason;
	/** Read off the transcript of a reopened session, not a response this process saw: thinking level, tools and credential are unknown. */
	inferred: boolean;
	/** Retention tier the entry was written under: `short` (5m) or `long` (1h). */
	tier: "short" | "long";
	/** Send time of the last request that read or wrote the entry. */
	touchedAt: number;
	/** Lifetime after the last touch; undefined when the provider never expires the entry. */
	ttlMs?: number;
	/** Prompt tokens of the request that wrote or last read the entry: what a warm cache serves. */
	cachedTokens: number;
	/** Estimated prompt tokens of the next request. */
	nextTokens: number;
	/** Absent when the entry was inferred. */
	warming?: PromptCacheWarming;
}

export interface StatusLineSession {
	state: { model?: Model; thinkingLevel?: ThinkingLevel; messages: readonly AgentMessage[] };
	model?: Model;
	messages?: readonly AgentMessage[];
	sessionFile?: string;
	isStreaming: boolean;
	isAutoThinking: boolean;
	contextUsageRevision?: number;
	systemPrompt?: readonly string[];
	agent?: { state?: { tools?: readonly Pick<Tool, "name" | "description" | "parameters">[] }; tokenizer?: unknown };
	skills?: readonly unknown[];
	compactionSpeculation?: "idle" | "running" | "armed";
	sessionManager: {
		getSessionName(): string | undefined;
		getSessionId(): string;
		getUsageStatistics(): {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			orchestrationInput: number;
			orchestrationOutput: number;
			orchestrationCacheRead: number;
			premiumRequests: number;
			cost: number;
			/** Portion of `cost` carried by completed subagent task results. */
			subagentCost?: number;
		};
	};
	modelRegistry: {
		isUsingOAuth(model: Model): boolean;
	};
	getContextUsage(): { tokens: number; contextWindow: number; percent: number | null } | undefined;
	autoResolvedThinkingLevel(): string | undefined;
	isFastModeActive(): boolean;
	/** Anthropic usage-limit label (`limit reached · wrapping up · resets 14:30`, `low priority until 14:30 · 62% left`). */
	getAnthropicSlowModeLabel?(): string | undefined;
	getPrewalkState?(): unknown;
	getAsyncJobSnapshot(): { running: readonly { type: string; agentId?: string }[] } | null | undefined;
	/** Widgets of the running background jobs, in job order; the jobs segment appends the freshest one's glance. */
	getRunningJobWidgets?(): readonly JobWidgetEntry[];
	getGoalModeState(): { goal?: { status: string; tokensUsed: number; tokenBudget?: number } } | undefined;
	getAdvisorStatusOverview?(): { configured: boolean; advisors: readonly { status: string; yielded: boolean }[] };
	getAdvisorCost?(): number;
	isAdvisorUsingSubscription?(): boolean;
	/**
	 * What the next request finds in the prompt cache at `nowMs`; undefined when there is nothing to reason about.
	 * `nextTokens` is the caller's current context token count, so the session need not recount it.
	 */
	getPromptCacheStatus?(nowMs: number, nextTokens?: number): PromptCacheStatus | undefined;
}

export interface FooterSession {
	state: Pick<StatusLineSession["state"], "model" | "thinkingLevel">;
	isAutoThinking: boolean;
	autoResolvedThinkingLevel(): string | undefined;
	getContextUsage: StatusLineSession["getContextUsage"];
	modelRegistry: Pick<StatusLineSession["modelRegistry"], "isUsingOAuth">;
	/**
	 * Cumulative session rollup. Unlike the active-window stats it spans every
	 * entry in the session, so compaction does not reset the counters, and it
	 * folds in usage carried by completed `task` tool results.
	 */
	sessionManager: { getUsageStatistics: StatusLineSession["sessionManager"]["getUsageStatistics"] };
}

/**
 * Runtime services stay in the host; renderers only consume these capabilities.
 * `TSession` is the host's concrete session type (a structural superset of {@link StatusLineSession}).
 */
export interface StatusLineHost<TSession extends StatusLineSession = StatusLineSession> {
	getSettings(): StatusLineSettings;
	gitEnabled(): boolean;
	codexResetFireworksEnabled(): boolean;
	getSettingsRevision(): number;
	getSessionSettingsIdentity(session: TSession): unknown;
	getSessionSettingsRevision(session: TSession): number;
	goalStatusInFooter(session: TSession): boolean;
	activeAccount(session: TSession, provider: string): StatusAccountIdentity | undefined;
	canFetchUsageReports(session: TSession): boolean;
	fetchUsageReports(session: TSession, signal: AbortSignal): Promise<unknown>;
	resolveActiveRepo(cwd: string): ActiveRepoContext | null;
	lookupPullRequest(cwd: string): Promise<{ stdout: string; exitCode: number }>;
	calculateTokensPerSecond(messages: readonly AgentMessage[], isStreaming: boolean): number | null;
	limitMatchesActiveAccount(report: UsageReport, limit: UsageLimit, identity: StatusAccountIdentity): boolean;
	classifyResetExpiry?(report: UsageReport, nowMs: number): StatusResetExpiry | undefined;
	/**
	 * One-line warning for saved resets anywhere in the pool that are about to expire.
	 * The host owns deduplication: a returned warning counts as shown, so each saved
	 * reset is warned about once, not once per refresh or conversation.
	 */
	resetExpiryNotice?(session: TSession, reports: readonly UsageReport[], nowMs: number): string | undefined;
	computeCompactionBoundaries(session: TSession, contextWindow: number, model?: Model): CompactionBoundaries | null;
}

export interface FooterHost {
	gitEnabled(): boolean;
}
