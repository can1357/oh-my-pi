/**
 * What the status line and the footer show, as plain data: the host (session,
 * settings, git watchers, timers) computes a {@link StatusFacts} snapshot and
 * hands it to the screens through an accessor. The screens never read
 * sessions or settings themselves.
 */
import type { StatusLineSettings } from "../../modes/view-model/status-line/types";
import type { JobWidgetView } from "../../tools/details/job-widget";
import type { LoopConditionConfig, LoopLimitRuntime } from "../../modes/view-model/status-line/loop";
import type { PromptCacheStatus, SessionTreePosition } from "../../modes/view-model/status-line/host";

export type { StatusLineSettings };

/**
 * How long the brand's color takes to ease across a working-state edge (ms).
 * The status line drops a stale edge after this, so the bar stops reading the
 * terminal clock (and the renderer stops ticking) once the fade is over.
 */
export const BRAND_FADE_MS = 450;

/** The active model as the bar names it. */
export interface StatusModel {
	readonly id: string;
	/** Display name (`Claude Opus`); the id stands in when absent. */
	readonly name?: string;
	/** The model accepts a thinking level. */
	readonly thinking: boolean;
	readonly contextWindow?: number;
}

/** Cumulative session usage. */
export interface StatusUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly orchestrationInput?: number;
	readonly orchestrationOutput?: number;
	readonly premiumRequests: number;
	/** Spend, including completed subagent task results. */
	readonly cost: number;
	/** Part of `cost` carried by completed subagent task results. */
	readonly subagentCost?: number;
}

/** Context-window occupancy. */
export interface StatusContext {
	readonly tokens: number;
	/** 0 when unknown. */
	readonly window: number;
	/** Null while unknown (right after compaction). */
	readonly percent: number | null;
}

/** Subscription quota windows of the active account (the `usage` segment). */
export interface StatusQuota {
	readonly tier?: string;
	readonly fiveHour?: { readonly percent: number; readonly resetMinutes?: number };
	readonly daily?: { readonly percent: number; readonly resetMinutes?: number };
	readonly sevenDay?: { readonly percent: number; readonly resetHours?: number };
	readonly monthly?: { readonly percent: number; readonly resetHours?: number };
	readonly resetCredits?: {
		readonly bankedCount: number;
		readonly redeemableCount: number;
		readonly expiryHours?: number;
		readonly expired?: boolean;
		readonly unavailableReason?: string;
		readonly expiring?: { readonly tier: "soon" | "imminent"; readonly count: number };
	};
}

/** Advisor roster summary (the eye after the model name). */
export interface StatusAdvisor {
	/** Worst status in the roster. */
	readonly status: "running" | "quota_exhausted" | "error" | "idle";
	/** Every advisor finished reviewing the yielded turn. */
	readonly yielded: boolean;
}

/** One snapshot of everything the status line and footer show. */
export interface StatusFacts {
	readonly model?: StatusModel;
	readonly thinkingLevel?: string;
	readonly autoThinking?: boolean;
	/** The level auto thinking resolved for the turn, once classified. */
	readonly autoResolvedLevel?: string;
	readonly fastMode?: boolean;
	/** A retry fallback, not the configured model, serves the session as the displayed model. */
	readonly servingFallback?: boolean;
	/** Anthropic usage-limit stage label (wrap-up allowance, low priority). */
	readonly slowModeLabel?: string;
	readonly advisor?: StatusAdvisor;
	/** Session title; also seeds the session accent. */
	readonly sessionName?: string;
	readonly sessionId?: string;
	readonly pinned?: boolean;
	/** Subagent the view is proxied at, if any. */
	readonly focusedAgentId?: string;
	/** Active named profile (`work` → `π-work`). */
	readonly profile?: string;
	readonly usage: StatusUsage;
	readonly usingSubscription: boolean;
	/** Spend of the whole subagent tree (Agent Hub). */
	readonly subagentTreeCost?: number;
	readonly advisorCost?: { readonly cost: number; readonly usingSubscription: boolean };
	readonly pricingPeriod?: "peak" | "off-peak";
	readonly tokensPerSecond?: number | null;
	readonly context: StatusContext;
	readonly autoCompact: boolean;
	/** Where auto-compaction fires and where its background summary starts (percent of the window). */
	readonly compaction?: { readonly thresholdPercent: number; readonly speculationPercent: number | null };
	/** Background speculative compaction. */
	readonly speculation?: "idle" | "running" | "armed";
	/** Working directory; `home` shortens it to `~`. */
	readonly cwd: string;
	readonly home?: string;
	/** Nested repository the cwd resolves into (`↳ <root>`). */
	readonly activeRepoRoot?: string;
	/** Linked git worktree of a shared checkout. */
	readonly worktree?: { readonly projectName: string; readonly worktreeName: string };
	readonly git?: {
		readonly branch: string | null;
		readonly status: { readonly staged: number; readonly unstaged: number; readonly untracked: number } | null;
		readonly pr: { readonly number: number; readonly url: string } | null;
	};
	readonly hostname?: string;
	/** Wall clock (ms since epoch) for the `time` segment. */
	readonly now: number;
	readonly plan?: { readonly enabled: boolean; readonly paused: boolean };
	readonly prewalk?: boolean;
	readonly goal?: {
		readonly enabled: boolean;
		readonly paused: boolean;
		readonly status?: "active" | "paused" | "complete" | "budget-limited" | "dropped";
		readonly tokensUsed?: number;
		readonly tokenBudget?: number;
		/** `statusLine.goalStatusInFooter`: show the token budget. */
		readonly showBudget?: boolean;
	};
	readonly vibe?: boolean;
	readonly loop?: {
		readonly state: "waiting" | "running" | "paused";
		readonly limit?: LoopLimitRuntime;
		readonly condition?: LoopConditionConfig;
	};
	readonly vim?: {
		readonly mode: "insert" | "normal" | "visual" | "visual-line" | "replace";
		readonly pending: string;
		readonly selectedLines: number;
		readonly display: "text" | "icon" | "none";
	};
	readonly collab?: { readonly role: "host" | "guest"; readonly participantCount: number };
	readonly stream?: { readonly viewers: number };
	readonly recording?: boolean;
	/** Running subagents. */
	readonly subagents: number;
	/** Running background jobs. */
	readonly jobs: number;
	/** The freshest live widget among them: the jobs badge appends its headline and sparkline. */
	readonly jobGlance?: JobWidgetView;
	/** Active processing time this session, ms. */
	readonly activeMs: number;
	/** Terminal-clock ms the running turn started at; undefined while idle. */
	readonly turnStartedAt?: number;
	/** Terminal-clock ms the working state last changed: the brand's color fades from the old state's. */
	readonly brandEdgeAt?: number;
	readonly awaitingAnswer?: boolean;
	readonly treePosition?: SessionTreePosition;
	readonly quota?: StatusQuota;
	readonly promptCache?: PromptCacheStatus;
	/** Extension statuses, ordered by key. */
	readonly hooks: readonly string[];
}

/**
 * Where the composer puts the standalone bar: `full` carries both groups on
 * the bottom row, `left` only the left group (the right one lives in the
 * editor's top rule), `none` none (the bar is the editor's top border).
 * `gap` puts a blank row above it; `autocomplete` yields the row to the
 * editor's completion menu.
 */
export interface StatusPlacement {
	readonly bar: "full" | "left" | "none";
	readonly gap: boolean;
	readonly autocomplete: boolean;
}
