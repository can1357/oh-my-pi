import type { AgentSession } from "../../session/agent-session";

export const GALLERY_CONTEXT_WINDOW = 200_000;

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
		settings: {
			get: (path: string) => path === "goal.statusInFooter",
			getGroup: () => ({ enabled: true, reserveTokens: 20_000 }),
		},
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
						advisors: [{ status: options.advisorStatus, yielded: options.advisorYielded ?? false }],
					}
				: { configured: false, advisors: [] },
		getAdvisorCost: () => options.advisorCost ?? 0.08,
		isAdvisorUsingSubscription: () => false,
		getPrewalkState: () => false,
		compactionSpeculation: "idle",
	} as unknown as AgentSession;
}
