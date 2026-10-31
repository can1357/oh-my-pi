import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";

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

/** Prompt-cache samples, one per lifecycle the `cache` chip and its details distinguish. */
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

export interface GallerySessionOptions {
	contextTokens?: number;
	fastMode?: boolean;
	advisorStatus?: "running" | "quota_exhausted" | "error" | "paused";
	advisorYielded?: boolean;
	usingSubscription?: boolean;
	cost?: number;
	premiumRequests?: number;
	advisorCost?: number;
	goalStatus?: "active" | "paused" | "complete" | "budget-limited" | "dropped";
	/** What `getPromptCacheStatus` reports; absent hides the `cache` chip. */
	promptCache?: PromptCacheStatus;
}

/** Deterministic session double for production composer/status renderers. */
export function createGallerySession(options: GallerySessionOptions = {}): AgentSession {
	const contextTokens = options.contextTokens ?? 124_000;
	const model = {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		contextWindow: GALLERY_CONTEXT_WINDOW,
		thinking: true,
		provider: "anthropic",
	};
	const messages = [{ role: "user", content: "Show the production preview" }];
	const goalStatus = options.goalStatus ?? "active";
	return {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		state: { messages, model, thinkingLevel: "high" },
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isStreaming: false,
		modelRegistry: { isUsingOAuth: () => options.usingSubscription ?? false },
		settings: Settings.isolated({ "goal.statusInFooter": true, "compaction.reserveTokens": 20_000 }),
		sessionManager: {
			getUsageStatistics: () => ({
				input: 12_400,
				output: 3_600,
				cacheRead: 48_000,
				cacheWrite: 1_200,
				totalTokens: 65_200,
				orchestrationInput: 900,
				orchestrationOutput: 240,
				orchestrationCacheRead: 3_000,
				premiumRequests: options.premiumRequests ?? 2,
				cost: options.cost ?? 0.42,
			}),
			getSessionName: () => "gallery",
			getSessionId: () => "gallery-session-id",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => options.fastMode ?? false,
		getContextUsage: () => ({
			tokens: contextTokens,
			contextWindow: GALLERY_CONTEXT_WINDOW,
			percent: (contextTokens / GALLERY_CONTEXT_WINDOW) * 100,
		}),
		contextUsageRevision: 0,
		getGoalModeState: () => ({
			goal: { status: goalStatus, tokensUsed: 12_400, tokenBudget: 50_000 },
		}),
		getAdvisorStatusOverview: () =>
			options.advisorStatus
				? {
						configured: true,
						advisors: [
							{
								status: options.advisorStatus,
								yielded: options.advisorYielded ?? false,
								backlog: 0,
								isPaused: false,
							},
						],
					}
				: { configured: false, advisors: [] },
		getAdvisorCost: () => options.advisorCost ?? 0.08,
		isAdvisorUsingSubscription: () => false,
		getPrewalkState: () => false,
		getPromptCacheStatus: () => options.promptCache,
		compactionSpeculation: "idle",
	} as unknown as AgentSession;
}
