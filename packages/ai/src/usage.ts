/**
 * Usage reporting types for provider quota/limit endpoints.
 *
 * Provides a normalized schema to represent multiple limit windows, model tiers,
 * and shared quotas across providers.
 */
import { type } from "arktype";
import type { FetchImpl, Provider } from "./types";
export type UsageUnit = "percent" | "tokens" | "requests" | "usd" | "minutes" | "bytes" | "unknown";

export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

/** Time window for a limit (e.g. 5h, 7d, monthly). */
export interface UsageWindow {
	/** Stable identifier (e.g. "5h", "7d", "monthly"). */
	id: string;
	/** Human label (e.g. "5 Hour", "7 Day"). */
	label: string;
	/** Window duration in milliseconds, when known. */
	durationMs?: number;
	/** Absolute reset timestamp in milliseconds since epoch. */
	resetsAt?: number;
}

/** Quantitative usage data. */
export interface UsageAmount {
	/** Amount used in the given unit. */
	used?: number;
	/** Maximum limit in the given unit. */
	limit?: number;
	/** Remaining amount in the given unit. */
	remaining?: number;
	/** Fraction used (0..1). */
	usedFraction?: number;
	/** Fraction remaining (0..1). */
	remainingFraction?: number;
	/** Unit for the amounts (percent, tokens, etc.). */
	unit: UsageUnit;
}

/** Scope metadata describing what the limit applies to. */
export interface UsageScope {
	provider: Provider;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	modelId?: string;
	tier?: string;
	windowId?: string;
	shared?: boolean;
}

/** Normalized limit entry for a single window or quota bucket. */
export interface UsageLimit {
	/** Stable identifier for this limit entry. */
	id: string;
	/** Human label for display. */
	label: string;
	scope: UsageScope;
	window?: UsageWindow;
	amount: UsageAmount;
	status?: UsageStatus;
	notes?: string[];
}

/**
 * Per-credit detail for a saved/banked rate-limit reset.
 *
 * Populated when the provider's listing endpoint returns individual credit
 * metadata (e.g. OpenAI Codex `wham/rate-limit-reset-credits`). Callers that
 * only need the count can ignore this; display layers use `expiresAt` to show
 * when banked resets expire ([#3339](https://github.com/can1357/oh-my-pi/issues/3339)).
 */
export interface UsageResetCreditDetail {
	/** ISO timestamp when the credit was granted. */
	grantedAt?: string;
	/** ISO timestamp when the credit expires and can no longer be redeemed. */
	expiresAt?: string;
	/** Backend status, e.g. `available`, `redeemed`. */
	status?: string;
}

/**
 * Saved/banked rate-limit resets an account can redeem on demand.
 *
 * Surfaced by providers that let users defer a usage-window reset and spend it
 * later (OpenAI Codex "saved rate limit resets"). The redeem itself is a
 * separate, provider-specific action; this is the read-only count for display.
 */
export interface UsageResetCredits {
	/** Number of resets available to redeem right now. */
	availableCount: number;
	/** Individual credit details (expiry dates, etc.) when the provider exposes them. */
	credits?: UsageResetCreditDetail[];
}

/** Aggregated usage report for a provider. */
export interface UsageReport {
	provider: Provider;
	fetchedAt: number;
	limits: UsageLimit[];
	/** Saved rate-limit resets the account can redeem, when the provider reports them. */
	resetCredits?: UsageResetCredits;
	/**
	 * Provider-wide disclaimers shown once above per-account sections.
	 * Use this for caveats that apply to every limit (e.g. "OMP-observed
	 * spend only"). Per-limit notes that differ per window (e.g. "Overage
	 * requests: N") stay on {@link UsageLimit.notes}.
	 */
	notes?: string[];
	metadata?: Record<string, unknown>;
	raw?: unknown;
}

/**
 * Resolve a limit's used fraction (0..1; >1 means overage) from whichever
 * amount fields the provider populated. Precedence mirrors the usage UIs:
 * explicit fraction > used/limit > percent-unit used > inverted remaining.
 */
export function resolveUsedFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}

/**
 * One recorded usage-limit snapshot: a single limit window of one account at
 * a point in time. The usage cache itself is latest-snapshot-only; history
 * rows are appended by the auth storage layer whenever a fresh report is
 * fetched, so limit utilization stays inspectable over time.
 */
export interface UsageHistoryEntry {
	/** Epoch ms the report was fetched. */
	recordedAt: number;
	provider: Provider;
	/** Stable credential identity key (account/email/project derived). */
	accountKey: string;
	email?: string;
	accountId?: string;
	/** {@link UsageLimit.id} of the recorded window. */
	limitId: string;
	/** Human label of the limit. */
	label: string;
	windowLabel?: string;
	/** Used fraction (0..1) when resolvable. */
	usedFraction?: number;
	status?: UsageStatus;
	/** Epoch ms the window resets, when known. */
	resetsAt?: number;
}

/** Filter for reading recorded usage history. */
export interface UsageHistoryQuery {
	provider?: string;
	/** Inclusive lower bound on {@link UsageHistoryEntry.recordedAt} (epoch ms). */
	sinceMs?: number;
}
/** One observed provider request cost, attributed to the credential that made it. */
export interface UsageCostHistoryEntry {
	/** Epoch ms the request completed. */
	recordedAt: number;
	provider: Provider;
	/** Stable credential identity key (account/email/project/secret derived). */
	accountKey: string;
	/** Estimated request cost in USD. */
	costUsd: number;
}

/** Filter for reading observed request costs. */
export interface UsageCostHistoryQuery {
	provider?: string;
	accountKey?: string;
	/** Inclusive lower bound on {@link UsageCostHistoryEntry.recordedAt} (epoch ms). */
	sinceMs?: number;
}

// ─── Zod schemas (wire-shape validation for the broker `/v1/usage` endpoint) ─

export const usageUnitSchema = type("'percent' | 'tokens' | 'requests' | 'usd' | 'minutes' | 'bytes' | 'unknown'");
export const usageStatusSchema = type("'ok' | 'warning' | 'exhausted' | 'unknown'");

export const usageWindowSchema = type({
	id: "string",
	label: "string",
	"durationMs?": "number",
	"resetsAt?": "number",
});

export const usageAmountSchema = type({
	"used?": "number",
	"limit?": "number",
	"remaining?": "number",
	"usedFraction?": "number",
	"remainingFraction?": "number",
	unit: usageUnitSchema,
});

export const usageScopeSchema = type({
	provider: "string",
	"accountId?": "string",
	"projectId?": "string",
	"orgId?": "string",
	"modelId?": "string",
	"tier?": "string",
	"windowId?": "string",
	"shared?": "boolean",
});

export const usageLimitSchema = type({
	id: "string",
	label: "string",
	scope: usageScopeSchema,
	"window?": usageWindowSchema,
	amount: usageAmountSchema,
	"status?": usageStatusSchema,
	"notes?": "string[]",
});

export const usageResetCreditDetailSchema = type({
	"grantedAt?": "string",
	"expiresAt?": "string",
	"status?": "string",
});

export const usageResetCreditsSchema = type({
	availableCount: "number",
	"credits?": usageResetCreditDetailSchema.array(),
});

export const usageReportSchema = type({
	provider: "string",
	fetchedAt: "number",
	limits: usageLimitSchema.array(),
	"resetCredits?": usageResetCreditsSchema,
	"notes?": "string[]",
	"metadata?": { "[string]": "unknown" },
	// `raw` is provider-specific and may be anything; the broker strips it before
	// sending the report over the wire, so accept-but-ignore here.
	"raw?": "unknown",
});

/** Optional logger for usage fetchers. */
export interface UsageLogger {
	debug(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

/** Credential bundle for usage endpoints. */
export interface UsageCredential {
	type: "api_key" | "oauth";
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	accountId?: string;
	projectId?: string;
	email?: string;
	enterpriseUrl?: string;
	metadata?: Record<string, unknown>;
	apiEndpoint?: string;
}

/** Parameters provided to a usage fetcher. */
export interface UsageFetchParams {
	provider: Provider;
	credential: UsageCredential;
	/** Stable credential identity key derived by the auth storage layer. */
	accountKey?: string;
	baseUrl?: string;
	signal?: AbortSignal;
}

/** Shared runtime utilities for fetchers. */
export interface UsageFetchContext {
	fetch: FetchImpl;
	logger?: UsageLogger;
	retryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	/** Observed request-cost history for providers without upstream usage APIs. */
	listUsageCosts?: (query?: UsageCostHistoryQuery) => UsageCostHistoryEntry[];
}

/** Provider implementation for fetching usage information. */
export interface UsageProvider {
	id: Provider;
	fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null>;
	/** Parse provider rate-limit response headers (lowercased keys) into a usage report, if supported. */
	parseRateLimitHeaders?(headers: Record<string, string>, now?: number): UsageReport | null;
	supports?(params: UsageFetchParams): boolean;
	/** True when fetchUsage contacts upstream and can authenticate the credential for health checks. */
	validatesCredentials?: boolean;
}

/** Request context used when ranking usage for a specific model. */
export interface CredentialRankingContext {
	/** Provider model id, when the caller is selecting a credential for one model. */
	modelId?: string;
}

/** Strategy for usage-based credential ranking. Providers implement this to opt into smart credential selection. */
export interface CredentialRankingStrategy {
	/** Extract the primary (short) and secondary (long) window limits from a usage report. */
	findWindowLimits(
		report: UsageReport,
		context?: CredentialRankingContext,
	): {
		primary?: UsageLimit;
		secondary?: UsageLimit;
	};
	/**
	 * Restrict limits to the ones relevant for the requested model before
	 * credential-wide exhaustion checks and ranking. Providers with shared
	 * account-wide quotas can omit this and use all limits.
	 */
	scopeLimits?(report: UsageReport, context?: CredentialRankingContext): UsageLimit[];
	/**
	 * Return a provider-local backoff scope for the requested model. Providers
	 * with backend-specific quotas use this so one exhausted model family does
	 * not block unrelated families on the same OAuth credential.
	 */
	blockScope?(context?: CredentialRankingContext): string | undefined;
	/** Fallback window durations (ms) when limits don't specify durationMs. */
	windowDefaults: {
		primaryMs: number;
		secondaryMs: number;
	};
	/** Optional: priority boost for specific credential states (e.g., fresh 5h ticker start). */
	hasPriorityBoost?(primary: UsageLimit | undefined): boolean;
}
