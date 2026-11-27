/**
 * The deterministic session the status line and composer previews show: one
 * {@link StatusFacts} snapshot (model, usage, context, git, plan mode, quota,
 * a fixed clock) that variants override field by field.
 */
import type { PromptCacheStatus } from "../../modes/view-model/status-line/host";
import type { StatusLineSettings } from "../../modes/view-model/status-line/types";
import type { StatusFacts, StatusPlacement } from "../../ui/status/facts";

export const GALLERY_CONTEXT_WINDOW = 200_000;

/** Last prompt-cache touch of the gallery samples: a fixed local time, so clock text is stable. */
const PROMPT_CACHE_TOUCHED_AT = new Date(2026, 7, 29, 14, 5).getTime();
const PROMPT_CACHE_WARM: PromptCacheStatus = {
	state: "warm",
	inferred: false,
	tier: "short",
	touchedAt: PROMPT_CACHE_TOUCHED_AT,
	ttlMs: 5 * 60_000,
	cachedTokens: 316_000,
	nextTokens: 320_200,
	warming: {
		state: "scheduled",
		nextWarmAt: PROMPT_CACHE_TOUCHED_AT + 4 * 60_000,
		stopsAt: PROMPT_CACHE_TOUCHED_AT + 30 * 60_000,
	},
};

/** Prompt-cache samples, one per lifecycle the `cache` marker and its details distinguish. */
export const GALLERY_PROMPT_CACHE = {
	warm: PROMPT_CACHE_WARM,
	refreshing: {
		...PROMPT_CACHE_WARM,
		tier: "long",
		ttlMs: 60 * 60_000,
		warming: { state: "refreshing", stopsAt: PROMPT_CACHE_TOUCHED_AT + 60 * 60_000 },
	},
	likelyWarm: { ...PROMPT_CACHE_WARM, inferred: true, warming: undefined },
	coldExpired: {
		...PROMPT_CACHE_WARM,
		state: "cold",
		reason: { kind: "expired", at: PROMPT_CACHE_TOUCHED_AT - 9 * 60_000 },
		touchedAt: PROMPT_CACHE_TOUCHED_AT - 14 * 60_000,
		warming: { state: "inactive", reason: "30-minute idle safety limit reached" },
	},
	coldModel: {
		...PROMPT_CACHE_WARM,
		state: "cold",
		reason: { kind: "model", from: "Claude Opus 4.5", to: "Claude Sonnet 4.5" },
		warming: undefined,
	},
} satisfies Record<string, PromptCacheStatus>;

/** The gallery's fixed wall clock (the `time` segment). */
export const GALLERY_NOW = new Date(2026, 7, 29, 14, 7, 9).getTime();

/** The gallery session's status facts, with `overrides` applied. */
export function galleryStatusFacts(overrides: Partial<StatusFacts> = {}): StatusFacts {
	const tokens = 124_000;
	return {
		model: {
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			thinking: true,
			contextWindow: GALLERY_CONTEXT_WINDOW,
		},
		thinkingLevel: "high",
		sessionName: "gallery",
		sessionId: "gallery-session-id",
		usage: {
			input: 12_400,
			output: 3_600,
			cacheRead: 48_000,
			cacheWrite: 1_200,
			orchestrationInput: 900,
			orchestrationOutput: 240,
			premiumRequests: 2,
			cost: 0.42,
		},
		usingSubscription: false,
		advisorCost: { cost: 0.08, usingSubscription: false },
		tokensPerSecond: 87.3,
		context: { tokens, window: GALLERY_CONTEXT_WINDOW, percent: (tokens / GALLERY_CONTEXT_WINDOW) * 100 },
		autoCompact: true,
		compaction: { thresholdPercent: 90, speculationPercent: null },
		speculation: "idle",
		cwd: "/workspace/oh-my-pi",
		git: {
			branch: "gallery/reference",
			status: { staged: 2, unstaged: 3, untracked: 1 },
			pr: { number: 1842, url: "https://github.com/can1357/oh-my-pi/pull/1842" },
		},
		hostname: "gallery-host",
		now: GALLERY_NOW,
		plan: { enabled: true, paused: false },
		collab: { role: "host", participantCount: 3 },
		subagents: 0,
		jobs: 0,
		activeMs: 372_000,
		quota: { tier: "Pro", fiveHour: { percent: 32, resetMinutes: 71 }, sevenDay: { percent: 68, resetHours: 52 } },
		hooks: [],
		...overrides,
	};
}

/** A custom status line of `left` and `right` segments, accent off. */
export function galleryStatusSettings(
	left: StatusLineSettings["leftSegments"],
	right: StatusLineSettings["rightSegments"],
	extra: Omit<StatusLineSettings, "leftSegments" | "rightSegments"> = {},
): StatusLineSettings {
	return {
		preset: "custom",
		leftSegments: left,
		rightSegments: right,
		separator: "powerline-thin",
		sessionAccent: false,
		...extra,
	};
}

/** The status bar alone, both groups on one row. */
export const GALLERY_BAR_PLACEMENT: StatusPlacement = { bar: "full", gap: false, autocomplete: false };
