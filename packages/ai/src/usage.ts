/**
 * Usage reporting types for provider quota/limit endpoints.
 *
 * Provides a normalized schema to represent multiple limit windows, model tiers,
 * and shared quotas across providers.
 */
import { type } from "@oh-my-pi/omptype";
import type { FetchImpl, Provider } from "./types";
export type UsageUnit = "percent" | "tokens" | "requests" | "credits" | "usd" | "minutes" | "bytes" | "unknown";

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
	/**
	 * Verb rendered before the {@link resetsAt} countdown (e.g. "tick", "regen").
	 * Defaults to "resets" — override for rolling windows where the timestamp is
	 * an incremental regeneration step rather than a full window reset.
	 */
	resetLabel?: string;
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

/**
 * Aggregated request usage a client observed for one (provider, model) pair.
 * Clients fold every completed request into per-pair buckets and flush them to
 * the auth broker on a short cadence, so the broker can attribute token burn
 * to the install that produced it.
 */
export interface ObservedUsageEntry {
	/** Epoch ms of the newest request folded into this bucket. */
	at: number;
	provider: Provider;
	model: string;
	/** Completed requests folded into this bucket. */
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Estimated USD cost of the folded requests (0 when unknown). */
	costUsd: number;
}

/** One client's observed-usage report, keyed by its stable install id. */
export interface ClientUsageReport {
	/** Stable per-machine install id — the client primary key. */
	installId: string;
	/** Human-readable machine name for display surfaces. */
	hostname?: string;
	/** Application label for the process that burned the tokens (e.g. `omp`, `robomp`). */
	app?: string;
	entries: ObservedUsageEntry[];
}

/**
 * Identity a client presents for usage attribution. Defaults to this
 * process's install id / hostname / app label; the auth-gateway overrides it
 * with the identity its caller sent so token burn lands on the originating
 * machine and application instead of the gateway host.
 */
export interface ClientUsageIdentity {
	installId: string;
	hostname?: string;
	app?: string;
}

/** Per-provider aggregate of one client's recorded usage. */
export interface ClientProviderUsage {
	/** Application label the usage was reported under; absent for legacy rows. */
	app?: string;
	provider: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

/** One known client with its usage aggregates over the queried window. */
export interface ClientUsageClientSummary {
	installId: string;
	hostname?: string;
	firstSeen: number;
	lastSeen: number;
	providers: ClientProviderUsage[];
}

/** Aggregated per-client usage recorded by the broker host. */
export interface ClientUsageSummary {
	clients: ClientUsageClientSummary[];
}

// ─── Zod schemas (wire-shape validation for the broker `/v1/usage` endpoint) ─

export const usageUnitSchema = type(
	"'percent' | 'tokens' | 'requests' | 'credits' | 'usd' | 'minutes' | 'bytes' | 'unknown'",
);
export const usageStatusSchema = type("'ok' | 'warning' | 'exhausted' | 'unknown'");

export const usageWindowSchema = type({
	id: "string",
	label: "string",
	"durationMs?": "number",
	"resetsAt?": "number",
	"resetLabel?": "string",
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
	/** Organization/workspace the credential is scoped to (see OAuthCredentials.orgId). */
	orgId?: string;
	/** Human-readable organization name for display. */
	orgName?: string;
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
	/** Whether a failed refresh may serve the previous successful report. Defaults to true. */
	retainLastGoodOnFailure?: boolean;
	/** Provider-specific cool-down after a failed refresh. Defaults to the shared short backoff. */
	failureBackoffMs?: number;
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
	 * Restrict limits for the opt-in, non-destructive usage-reserve health
	 * check ({@link AuthStorage.getModelUsageHealth}). Distinct from
	 * {@link scopeLimits}, which gates credential-wide hard blocks: a provider
	 * whose model/tier counters are trusted only at confirmed exhaustion for
	 * hard-blocking can still expose them here so the reserve margin protects
	 * the mapped quota before it hits the cap. Falls back to {@link scopeLimits}
	 * when omitted.
	 */
	scopeLimitsForReserve?(report: UsageReport, context?: CredentialRankingContext): UsageLimit[];
	/**
	 * Return a provider-local backoff scope for the requested model. Providers
	 * with backend-specific quotas use this so one exhausted model family does
	 * not block unrelated families on the same OAuth credential.
	 */
	blockScope?(context?: CredentialRankingContext): string | undefined;
	/**
	 * Scopes that apply to a request, most specific first. With a context, the
	 * request's own scope plus any legacy catch-all scope whose blocks still
	 * apply to everything. Without one — reconciliation runs with no request —
	 * every scope whose blocks must be healed.
	 *
	 * A provider that scopes backoff by model family must implement this, or a
	 * block written under one scope is invisible to requests and to healing.
	 */
	blockScopes?(context?: CredentialRankingContext): string[];
	/**
	 * Backoff scopes a fresh usage report can vouch for, each with the limits
	 * gating it. {@link AuthStorage} clears a stale block under a returned scope
	 * once every listed limit is below exhaustion, so a 429 whose retry-after
	 * overstated the real reset does not sideline a recovered account until the
	 * clock runs out. Scopes not returned expire by clock only. Codex heals
	 * through its meter metadata instead and omits this.
	 */
	healableBlockScopes?(report: UsageReport): { blockScope: string; limits: UsageLimit[] }[];
	/** Fallback window durations (ms) when limits don't specify durationMs. */
	windowDefaults: {
		primaryMs: number;
		secondaryMs: number;
	};
	/**
	 * Optional: priority boost for specific credential states (e.g., fresh 5h
	 * ticker start). `primaryUncapped` is true only when the fetched report has
	 * an applicable secondary window but no applicable primary window.
	 */
	hasPriorityBoost?(
		primary: UsageLimit | undefined,
		primaryUncapped?: boolean,
		context?: CredentialRankingContext,
	): boolean;
}
