import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Tool, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { CompactionBoundaries } from "./context-usage";
import type { StatusLineSettings } from "./types";

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
		};
	};
	modelRegistry: {
		isUsingOAuth(model: Model): boolean;
	};
	getContextUsage(): { tokens: number; contextWindow: number; percent: number | null } | undefined;
	autoResolvedThinkingLevel(): string | undefined;
	isFastModeActive(): boolean;
	getPrewalkState?(): unknown;
	getAsyncJobSnapshot(): { running: readonly { type: string; agentId?: string }[] } | null | undefined;
	getGoalModeState(): { goal?: { status: string; tokensUsed: number; tokenBudget?: number } } | undefined;
	getAdvisorStatusOverview?(): { configured: boolean; advisors: readonly { status: string; yielded: boolean }[] };
	getAdvisorCost?(): number;
	isAdvisorUsingSubscription?(): boolean;
}

export interface FooterSession {
	state: Pick<StatusLineSession["state"], "model" | "thinkingLevel">;
	isAutoThinking: boolean;
	autoResolvedThinkingLevel(): string | undefined;
	getContextUsage: StatusLineSession["getContextUsage"];
	modelRegistry: Pick<StatusLineSession["modelRegistry"], "isUsingOAuth">;
	sessionManager: { getEntries(): readonly { type: string; message?: AgentMessage }[] };
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
	/**
	 * Advisor roster whose provider usage windows the cost segment may show
	 * instead of the token-imputed dollar amount: one entry per configured
	 * advisor, identified by provider plus that advisor's own OAuth session.
	 * Empty when no advisors are configured, and no advisor windows are then
	 * rendered. Account identities are derived inside the component through
	 * {@link activeAccount}, so hosts report the roster alone.
	 */
	getAdvisorUsageAccounts(session: TSession): readonly { provider: string; providerSessionId?: string }[];
	canFetchUsageReports(session: TSession): boolean;
	fetchUsageReports(session: TSession, signal: AbortSignal): Promise<unknown>;
	resolveActiveRepo(cwd: string): ActiveRepoContext | null;
	lookupPullRequest(cwd: string): Promise<{ stdout: string; exitCode: number }>;
	calculateTokensPerSecond(messages: readonly AgentMessage[], isStreaming: boolean): number | null;
	limitMatchesActiveAccount(report: UsageReport, limit: UsageLimit, identity: StatusAccountIdentity): boolean;
	computeCompactionBoundaries(session: TSession, contextWindow: number, model?: Model): CompactionBoundaries | null;
}

export interface FooterHost {
	gitEnabled(): boolean;
}
