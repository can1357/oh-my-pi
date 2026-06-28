/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, refreshing credentials, and usage tracking.
 *
 * This module defines:
 * - `AuthCredentialStore` interface: persistence abstraction (SQLite, remote vault, …)
 * - `AuthStorage` class: credential management with round-robin, usage limits, OAuth refresh
 * - `SqliteAuthCredentialStore`: concrete SQLite-backed implementation
 */
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, logger } from "@pk-nerdsaver-ai/pi-utils";
import type { ApiKeyResolver } from "./auth-retry";
import * as AIError from "./error";
import { isUsageLimitOutcome } from "./error/rate-limit";
import { getProviderDefinition, PASTE_CODE_LOGIN_PROVIDERS } from "./registry";
import { getOAuthApiKey, getOAuthProvider, refreshOAuthToken } from "./registry/oauth";
import type { OAuthController, OAuthCredentials, OAuthProvider, OAuthProviderId } from "./registry/oauth/types";
import { getEnvApiKey, getEnvApiKeyName } from "./stream";
import type { Provider } from "./types";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageCostHistoryEntry,
	UsageCostHistoryQuery,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLimit,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "./usage";
import { resolveUsedFraction } from "./usage";
import { claudeRankingStrategy, claudeUsageProvider } from "./usage/claude";
import { googleGeminiCliUsageProvider } from "./usage/gemini";
import { githubCopilotUsageProvider } from "./usage/github-copilot";
import { antigravityRankingStrategy, antigravityUsageProvider } from "./usage/google-antigravity";
import { kimiUsageProvider } from "./usage/kimi";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "./usage/ollama";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./usage/openai-codex";
import {
	type CodexResetConsumeCode,
	type CodexResetCredit,
	consumeCodexResetCredit,
	listCodexResetCredits,
} from "./usage/openai-codex-reset";
import { opencodeGoUsageProvider } from "./usage/opencode-go";
import { zaiUsageProvider } from "./usage/zai";

const USAGE_RANKING_METRIC_EPSILON = 1e-9;

// ─────────────────────────────────────────────────────────────────────────────
// Credential Types
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthCredentialEntry = AuthCredential | AuthCredential[];

export type AuthStorageData = Record<string, AuthCredentialEntry>;

/**
 * Cascade leg that supplies a provider's active credential, highest precedence
 * first — mirrors {@link AuthStorage.getApiKey}'s resolution order.
 */
export type CredentialOriginKind = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";

/**
 * Structured provenance for a provider's auth, for UI that needs a machine
 * tag (the `/login` provider list) rather than the prose of
 * {@link AuthStorage.describeCredentialSource}.
 */
export interface CredentialOrigin {
	kind: CredentialOriginKind;
	/** Env var name when `kind === "env"` and a single named variable backs it. */
	envVar?: string;
}

/**
 * Serialized representation of AuthStorage for passing to subagent workers.
 * Contains only the essential credential data, not runtime state.
 */
export interface SerializedAuthStorage {
	credentials: Record<
		string,
		Array<{
			id: number;
			type: "api_key" | "oauth";
			data: Record<string, unknown>;
		}>
	>;
	runtimeOverrides?: Record<string, string>;
	dbPath?: string;
}

/**
 * Auth credential with database row ID for updates/deletes.
 * Wraps AuthCredential with storage metadata.
 */
export interface StoredAuthCredential {
	id: number;
	provider: string;
	credential: AuthCredential;
	disabledCause: string | null;
}

/**
 * Per-credential health record returned by {@link AuthStorage.checkCredentials}.
 *
 * Use this to identify which credential in a multi-account pool is causing
 * auth errors. `ok` is tri-state:
 *
 * - `true` — credential authenticated against the provider's auth-verifying
 *   probe (today: the usage endpoint). For OAuth this also exercises refresh
 *   when the access token was expired.
 * - `false` — the probe rejected the credential (401/403/refresh failure/etc).
 *   `reason` carries the upstream error string.
 * - `null` — no probe is configured for this provider (or the configured
 *   probe doesn't support this credential type). The credential's auth
 *   status is unverifiable from here.
 */
export interface CredentialHealthResult {
	/** Database row id (matches {@link StoredAuthCredential.id}). */
	id: number;
	provider: string;
	type: AuthCredential["type"];
	/** OAuth email if known on the stored credential or surfaced by the probe. */
	email?: string;
	/** OAuth account id / org id if known. */
	accountId?: string;
	/** `true` when the refresh token lives on a remote broker (sentinel was present). */
	remoteRefresh?: true;
	ok: boolean | null;
	/** Failure / unverifiable reason; absent when `ok === true`. */
	reason?: string;
	/** Probe usage report (raw payload stripped) when `ok === true`. */
	report?: Omit<UsageReport, "raw">;
	/**
	 * Result of the optional end-to-end completion probe (see
	 * {@link CheckCredentialsOptions.completionProbe}). Absent when no probe was
	 * supplied. The completion probe exercises the provider's chat-completion
	 * endpoint with the credential's bearer bytes, which is a stricter signal
	 * than the usage endpoint (some providers happily 200 a `/usage` call while
	 * the chat endpoint 401s the same bearer).
	 */
	completion?: CredentialCompletionResult;
}

/**
 * Outcome of the end-to-end completion probe. `null` means the probe was
 * skipped (no bearer bytes were available — e.g. OAuth refresh failed
 * upstream of the probe).
 */
export interface CredentialCompletionResult {
	ok: boolean | null;
	/** Failure / unverifiable reason; absent when `ok === true`. */
	reason?: string;
	/** Probe model id used (carried back from the caller for display). */
	modelId?: string;
	/** Round-trip latency in milliseconds. */
	latencyMs?: number;
}

/**
 * Credential payload handed to {@link CompletionProbe}. For API-key
 * credentials only the bytes are exposed; for OAuth, every identity field
 * carried by the refreshed credential is included so the probe can compose
 * provider-specific apiKey shapes (e.g. GitHub Copilot / Google Gemini CLI
 * expect a JSON blob with `token` + `projectId`, not the raw access token).
 *
 * `refreshToken` may be {@link REMOTE_REFRESH_SENTINEL} when the credential
 * lives behind a broker; the chat endpoint never reads it, so the probe can
 * forward it verbatim into the structured shape without harm.
 */
export type CompletionProbeCredential =
	| { type: "api_key"; apiKey: string }
	| {
			type: "oauth";
			accessToken: string;
			refreshToken?: string;
			expiresAt?: number;
			accountId?: string;
			projectId?: string;
			email?: string;
			enterpriseUrl?: string;
			apiEndpoint?: string;
	  };

/**
 * Caller-supplied bearer probe. Receives the post-refresh credential for a
 * single row and reports whether a real chat-completion round-trip succeeds.
 * The check-credentials pipeline calls this AFTER any OAuth refresh so the
 * bytes match what a live request would send.
 */
export interface CompletionProbeInput {
	provider: Provider;
	credentialId: number;
	credential: CompletionProbeCredential;
	signal: AbortSignal;
}

export type CompletionProbe = (input: CompletionProbeInput) => Promise<CredentialCompletionResult>;

export interface CheckCredentialsOptions {
	signal?: AbortSignal;
	/** Per-credential probe timeout (ms). Defaults to the configured usage request timeout. */
	timeoutMs?: number;
	/** Provider → base URL override, same shape as {@link AuthStorage.fetchUsageReports}. */
	baseUrlResolver?: (provider: Provider) => string | undefined;
	/**
	 * Optional end-to-end probe. When provided, `checkCredentials` invokes it
	 * for every credential where a usable bearer is available (API key, or
	 * OAuth access token after refresh-on-expiry succeeded). The result lands
	 * on {@link CredentialHealthResult.completion}.
	 *
	 * The probe runs INDEPENDENTLY of whether a {@link UsageProvider} is
	 * configured: providers without a usage endpoint still benefit from the
	 * extra signal. The probe is NOT invoked when OAuth refresh fails — the
	 * bytes would be stale anyway and the upstream failure is already captured
	 * on `reason`.
	 */
	completionProbe?: CompletionProbe;
	/** Per-credential completion probe timeout (ms). Defaults to `timeoutMs`. */
	completionTimeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Broker Snapshot Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentinel value placed in OAuth `refresh` fields when a credential is shared
 * via {@link AuthStorage.exportSnapshot}. Refresh tokens never leave the broker;
 * clients must call back to refresh.
 */
export const REMOTE_REFRESH_SENTINEL = "__remote__" as const;
export type RemoteRefreshSentinel = typeof REMOTE_REFRESH_SENTINEL;

/** OAuth credential with refresh token replaced by the broker sentinel. */
export type RemoteOAuthCredential = Omit<OAuthCredential, "refresh"> & {
	refresh: RemoteRefreshSentinel;
};

/** Discriminated credential payload as published by the broker. */
export type SnapshotCredential = ApiKeyCredential | RemoteOAuthCredential;

export interface AuthCredentialSnapshotEntry {
	id: number;
	provider: string;
	credential: SnapshotCredential;
	identityKey: string | null;
}

/**
 * Wire-shaped snapshot exported by {@link AuthStorage.exportSnapshot} and
 * served by the auth-broker server on `GET /v1/snapshot`.
 */
export interface AuthCredentialSnapshot {
	generation: number;
	generatedAt: number;
	credentials: AuthCredentialSnapshotEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthCredentialStore interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persistence abstraction consumed by {@link AuthStorage}.
 *
 * Concrete implementations:
 * - {@link SqliteAuthCredentialStore} — local SQLite-backed store (default).
 * - `RemoteAuthCredentialStore` from `./auth-broker` — client-side snapshot of
 *   a remote broker; mutating methods (`replace*`, `upsert*`, `delete*ForProvider`)
 *   throw because login flows route through the broker, not the client.
 */
export interface AuthCredentialStore {
	close(): void;
	listAuthCredentials(provider?: string): StoredAuthCredential[];
	updateAuthCredential(id: number, credential: AuthCredential): void;
	deleteAuthCredential(id: number, disabledCause: string): void;
	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string): boolean;
	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[];
	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[];
	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void;
	getCache(key: string, options?: { includeExpired?: boolean }): string | null;
	setCache(key: string, value: string, expiresAtSec: number): void;
	cleanExpiredCache(): void;
	/**
	 * Append usage-limit snapshots for trend history. Optional: stores without
	 * durable storage (e.g. the broker remote store) omit it and recording is
	 * skipped — the broker host records into its own database instead.
	 */
	recordUsageSnapshots?(entries: UsageHistoryEntry[]): void;
	/** Append observed request costs for providers without upstream usage APIs. */
	recordUsageCosts?(entries: UsageCostHistoryEntry[]): void;
	/** Read observed request costs, oldest first. */
	listUsageCosts?(query?: UsageCostHistoryQuery): UsageCostHistoryEntry[];
	/** Read recorded usage-limit snapshots, oldest first. */
	listUsageHistory?(query?: UsageHistoryQuery): UsageHistoryEntry[];
	/**
	 * Optional store-supplied OAuth refresh. When present, `AuthStorage` uses
	 * it before the per-provider local refresh path. `RemoteAuthCredentialStore`
	 * implements this against the broker; SQLite stores leave it undefined.
	 *
	 * Precedence: `AuthStorageOptions.refreshOAuthCredential` > this hook > local.
	 *
	 * `signal` propagates the agent's cancel (ESC, request abort, …) all the
	 * way to the broker fetch so a hung connection can't strand the caller
	 * for `timeoutMs * (maxRetries + 1)`.
	 */
	refreshOAuthCredential?(
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredentials>;
	/**
	 * Optional async pre-read hook invoked after AuthStorage selects a stored
	 * credential but before it returns that credential for an outbound request.
	 * Remote broker stores use this to wait out imminent rotations and refresh
	 * their local snapshot before the caller sees a stale access token.
	 */
	prepareForRequest?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean | undefined>;
	/**
	 * Optional store-supplied aggregate usage fetch. When present, `AuthStorage`
	 * routes `fetchUsageReports()` here instead of fanning out per-credential.
	 * `RemoteAuthCredentialStore` proxies to the broker (whose datacenter IP
	 * isn't rate-limited like a heavy residential client).
	 *
	 * Precedence: `AuthStorageOptions.fetchUsageReports` > this hook > local fan-out.
	 *
	 * `signal` propagates the agent's cancel down to the broker fetch.
	 */
	fetchUsageReports?(signal?: AbortSignal): Promise<UsageReport[] | null>;
	/**
	 * Optional store-supplied per-credential usage report lookup. When present,
	 * `AuthStorage` consults this before its own per-credential upstream fetch
	 * (`#getUsageReport`). `RemoteAuthCredentialStore` implements this against
	 * the broker's aggregate `/v1/usage` (one coalesced round-trip shared across
	 * all callers) so multi-credential ranking on the client never hits the
	 * upstream provider's rate-limited usage endpoint from the laptop IP.
	 *
	 * Returning `null` is authoritative — `AuthStorage` does NOT fall back to
	 * the local fetch path. The store hook owns the decision, since falling
	 * back would re-introduce the per-IP rate-limit problem the broker exists
	 * to avoid.
	 *
	 * `signal` propagates the agent's cancel down to the broker fetch.
	 */
	getUsageReport?(provider: Provider, credential: OAuthCredential, signal?: AbortSignal): Promise<UsageReport | null>;
	/**
	 * Optional store hook to invalidate a specific credential after the upstream
	 * provider returned 401 on a supposedly-fresh key. Remote stores force the
	 * broker to re-issue the row; local stores can leave it undefined and let
	 * {@link AuthStorage.invalidateCredentialMatching} fall back to `reload()`.
	 */
	markCredentialSuspect?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<void>;
	/**
	 * Optional async write hook for upserting a single credential. When present,
	 * `AuthStorage.#upsertOAuthCredential` routes through this instead of the
	 * sync `upsertAuthCredentialForProvider`. `RemoteAuthCredentialStore` uses
	 * it to send the upsert to the broker via `POST /v1/credential`.
	 *
	 * Implementations MUST update the in-memory snapshot before returning so the
	 * post-write read path is consistent.
	 */
	upsertAuthCredentialRemote?(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]>;
	/**
	 * Optional async write hook for replace-all semantics (e.g. API-key login
	 * overwriting any previous keys for the same provider). When present,
	 * `AuthStorage.set` routes through this instead of the sync
	 * `replaceAuthCredentialsForProvider`.
	 */
	replaceAuthCredentialsRemote?(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]>;
	/**
	 * Optional async write hook for disabling one stored credential. Remote stores
	 * use it to await broker persistence before AuthStorage updates its snapshot.
	 */
	deleteAuthCredentialRemote?(id: number, disabledCause: string): Promise<boolean>;
	/**
	 * Optional async write hook for clearing every credential for a provider
	 * (logout). When present, `AuthStorage.remove` routes through this instead
	 * of the sync `deleteAuthCredentialsForProvider`.
	 */
	deleteAuthCredentialsRemote?(provider: string, disabledCause: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthStorage Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event payload describing a credential that was just soft-disabled.
 *
 * Today the only call site is OAuth refresh failures with a definitive cause
 * (`invalid_grant`, `401/403` not from a network blip, etc.) — the
 * disabled_cause string is the verbatim error captured for forensics.
 *
 * Subscribers can use this to surface a notification, banner, or auto-launch
 * a re-login flow instead of letting the credential silently disappear.
 */
export interface CredentialDisabledEvent {
	provider: string;
	disabledCause: string;
}

export type AuthStorageOptions = {
	usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	usageFetch?: typeof fetch;
	usageRequestTimeoutMs?: number;
	usageLogger?: UsageLogger;
	/**
	 * Resolve a config value (API key, header value, etc.) to an actual value.
	 * - coding-agent injects its resolveConfigValue (supports "!command" syntax via pi-natives)
	 * - Default: checks environment variable first, then treats as literal
	 */
	configValueResolver?: (config: string) => Promise<string | undefined>;
	/**
	 * Optional callback fired when AuthStorage automatically disables a
	 * credential because something detected it as no longer usable — today
	 * that's the OAuth refresh-failure path in `getApiKey`. NOT fired for
	 * user-initiated `remove()` (the user already knows) or dedup of
	 * duplicate credentials (uninteresting hygiene).
	 */
	onCredentialDisabled?: (event: CredentialDisabledEvent) => void | Promise<void>;
	/**
	 * Override OAuth refresh. When set, `AuthStorage` calls this instead of the
	 * per-provider local refresh function. Receives the credential id so the
	 * implementation can address remote credentials.
	 *
	 * Must return updated {@link OAuthCredentials} with at least `access` and
	 * `expires`. `refresh` may be an opaque sentinel (e.g. `"__remote__"`) when
	 * the actual refresh token never leaves the broker.
	 */
	refreshOAuthCredential?: (
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	) => Promise<OAuthCredentials>;
	/**
	 * Human-readable description of the credential store backing this
	 * AuthStorage instance. Surfaced through {@link AuthStorage.describeCredentialSource}
	 * so the TUI can show where a token came from (broker URL or local SQLite path).
	 *
	 * Examples:
	 * - `"local ~/.omp/agent/agent.db"`
	 * - `"broker http://omp.internal:8765"`
	 */
	sourceLabel?: string;
	/**
	 * Override `fetchUsageReports`. When set, `AuthStorage.fetchUsageReports`
	 * calls this instead of fanning out per-credential. The primary use case is
	 * routing through a broker that egresses from a less-throttled IP — e.g. a
	 * residential laptop trips Anthropic's per-IP rate limit on the usage
	 * endpoint and drops 2-of-5 credentials, while the VPS broker gets all 5.
	 *
	 * Implementations may return null when no usage data is available; the
	 * AuthStorage caller surfaces that to its own consumer unchanged.
	 */
	fetchUsageReports?: (signal?: AbortSignal) => Promise<UsageReport[] | null>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Default Config Value Resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default config value resolver that checks env vars and treats as literal.
 * Does NOT support "!command" syntax (that requires pi-natives).
 */
async function defaultConfigValueResolver(config: string): Promise<string | undefined> {
	const envValue = process.env[config];
	return envValue || config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Providers (defaults)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_USAGE_PROVIDERS: UsageProvider[] = [
	openaiCodexUsageProvider,
	kimiUsageProvider,
	antigravityUsageProvider,
	googleGeminiCliUsageProvider,
	ollamaUsageProvider,
	ollamaCloudUsageProvider,
	claudeUsageProvider,
	zaiUsageProvider,
	opencodeGoUsageProvider,
	githubCopilotUsageProvider,
];

const DEFAULT_USAGE_PROVIDER_MAP = new Map<Provider, UsageProvider>(
	DEFAULT_USAGE_PROVIDERS.map(provider => [provider.id, provider]),
);

const USAGE_CACHE_PREFIX = "usage_cache:";
// 5 min stale tolerance. Anthropic / OpenAI rate-limit /usage hard at the IP
// level so we can't fetch all N credentials every cycle; with a long cache
// each credential's last-known value sticks visible while peers retry. UI
// data (5h / 7d / monthly limits) is fine being a few minutes stale.
const USAGE_REPORT_TTL_MS = 5 * 60_000;
const USAGE_HEADER_INGEST_INTERVAL_MS = 60_000;
const USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000;
/**
 * Downsample usage history to at most one row per hour per account window: a
 * snapshot landing in the same hour bucket as the series' latest row
 * overwrites it in place. That bound makes further retention pruning
 * unnecessary — 1 row/hour is ~9k rows per account window per year.
 */
const USAGE_HISTORY_BUCKET_MS = 60 * 60_000;
/**
 * Per-credential cool-down after a usage fetch fails. While this window is
 * active we serve the last successful value to avoid dropping the credential
 * from the report; without a previous value we just return null and retry
 * on the next poll.
 */
const USAGE_FAILURE_BACKOFF_MS = 10_000;
// Bumped from 3s — Claude usage retries up to 3 times with exponential backoff
// (~3.5s total worst case); a tight per-request budget aborts retries mid-cycle.
const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 10_000;
const USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES: Partial<Record<Provider, number>> = {
	"google-antigravity": 2,
};
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;
/**
 * Refresh OAuth access tokens this many ms before their stated expiry. The
 * skew exists so callers downstream of {@link AuthStorage} (stream providers,
 * usage probes, web_search) never observe a credential that is expired or
 * about to expire mid-request — there's a single rotation point and everyone
 * downstream trusts the token they receive.
 *
 * Set to 60s: comfortably absorbs request RTT + a clock-skew window without
 * triggering a refresh on every request. Provider token endpoints typically
 * mint access tokens with 30-60min lifetimes, so refreshing 60s early changes
 * the rotation cadence by <4%.
 */
const OAUTH_REFRESH_SKEW_MS = 60_000;
/**
 * Cap on the buffered credential_disabled backlog held while no handler is attached.
 * In practice the backlog is 0–N where N ≈ active providers (≤ ~20). The cap exists so
 * pathological detach-without-reattach loops can't grow memory unboundedly.
 */
const MAX_PENDING_DISABLED_EVENTS = 32;

// Re-exported from the error module (its new home) to preserve the public
// `@pk-nerdsaver-ai/pi-ai` entrypoint and the in-module call sites below.
export { isDefinitiveOAuthFailure } from "./error/auth-classify";

/**
 * Outcome of {@link AuthStorage.markUsageLimitReached}.
 *
 * `switched` is `true` when an unblocked same-type sibling credential is
 * available right now, so the caller can retry immediately and the next
 * `getApiKey` will hand it out. When `false`, `retryAtMs` (epoch ms) carries
 * the earliest moment any same-type sibling's temporary block expires —
 * callers should prefer waiting until then over the provider's (often
 * multi-hour) retry-after when it is sooner. `retryAtMs` is `undefined` when
 * no sibling credentials exist at all, or when the session has no tracked
 * credential to rotate away from.
 */
export interface UsageLimitMarkResult {
	switched: boolean;
	retryAtMs?: number;
}

type UsageCacheEntry<T> = {
	value: T;
	expiresAt: number;
};

interface UsageCache {
	get<T>(key: string): UsageCacheEntry<T> | undefined;
	getStale<T>(key: string): UsageCacheEntry<T> | undefined;
	set<T>(key: string, entry: UsageCacheEntry<T>): void;
	cleanup?(): void;
}

type UsageRequestDescriptor = {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
};

type AuthApiKeyOptions = {
	baseUrl?: string;
	modelId?: string;
	/**
	 * Caller's cancel signal. Threaded into any broker-bound OAuth refresh so
	 * `ESC` / request abort actually kills a hung broker fetch instead of
	 * stranding the caller for `timeoutMs * (maxRetries + 1)`.
	 */
	signal?: AbortSignal;
	/**
	 * Force a re-mint of the session-preferred OAuth credential's access token,
	 * bypassing the not-yet-expired short-circuit. Powers step (b) of the
	 * auth-retry policy ("refresh the SAME account") so a locally-cached token
	 * that a peer/broker rotated out from under us is replaced before retrying.
	 */
	forceRefresh?: boolean;
};
type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential };

/**
 * Refreshed OAuth access plus identity metadata returned by
 * {@link AuthStorage.getOAuthAccess}. Callers that authenticate via a bearer
 * AND need the credential's identity (Codex `chatgpt-account-id`, Google
 * `projectId`, GitHub `enterpriseUrl`) consume this shape directly; the
 * refresh slot is deliberately omitted because rotating refresh tokens never
 * leave {@link AuthStorage}.
 */
export interface OAuthAccess {
	accessToken: string;
	credentialId?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
}

export interface OAuthAccessFailure {
	credentialId?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
	error: string;
}

/**
 * Identity of the OAuth credential a session is currently routed to. Read-only
 * display/metadata shape: `accountId` is the provider's account UUID, `email`
 * the user-facing login, `projectId` the GCP-style project for providers that
 * key usage on it (Gemini CLI / Antigravity).
 */
export interface OAuthAccountIdentity {
	accountId?: string;
	email?: string;
	projectId?: string;
}

export type OAuthAccessResolution = ({ ok: true } & OAuthAccess) | ({ ok: false } & OAuthAccessFailure);

/**
 * Read-only identity of one stored OAuth account, in stable storage order.
 * Returned by {@link AuthStorage.listOAuthAccounts}; `position` (0-based) is the
 * selector accepted by {@link AuthStorage.getOAuthAccessAt}.
 */
export interface OAuthAccountSummary {
	position: number;
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
}
export interface InvalidateCredentialMatchingOptions {
	signal?: AbortSignal;
	sessionId?: string;
}

/**
 * Identifies which stored account to redeem a saved rate-limit reset for.
 * Any one field is enough; `credentialId` is the most precise.
 */
export interface ResetCreditTarget {
	credentialId?: number;
	accountId?: string;
	email?: string;
}

/** Outcome of {@link AuthStorage.redeemResetCredit}. */
export interface ResetCreditRedeemOutcome {
	/** `true` only when a reset was actually applied (`code === "reset"`). */
	ok: boolean;
	/**
	 * Result code. Backend codes: `reset` (success), `already_redeemed`,
	 * `no_credit`, `nothing_to_reset`. Locally-synthesized: `no_account`
	 * (target not found), `account_unavailable` (token refresh failed),
	 * `http_<status>` (unexpected HTTP).
	 */
	code: CodexResetConsumeCode;
	accountId?: string;
	email?: string;
	/** The credit that was spent (when one was). */
	creditId?: string;
}

/** One stored account's live saved-reset status, from {@link AuthStorage.listResetCredits}. */
export interface ResetCreditAccountStatus {
	credentialId?: number;
	accountId?: string;
	email?: string;
	/** Resets redeemable for this account right now (live, not cached). */
	availableCount: number;
	credits: CodexResetCredit[];
	/** Whether this is the given session's active account. */
	active: boolean;
	/** Set when the account's token refresh or list call failed. */
	error?: string;
}

function isAbortSignalOption(
	value: InvalidateCredentialMatchingOptions | AbortSignal | undefined,
): value is AbortSignal {
	return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value;
}

function requiresOpenAICodexProModel(provider: string, modelId: string | undefined): boolean {
	return provider === "openai-codex" && typeof modelId === "string" && modelId.includes("-spark");
}

function getUsagePlanType(report: UsageReport | null): string | undefined {
	const metadata = report?.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
	const planType = (metadata as { planType?: unknown }).planType;
	return typeof planType === "string" ? planType.toLowerCase() : undefined;
}

function getOpenAICodexPlanPriority(report: UsageReport | null): number {
	const planType = getUsagePlanType(report);
	if (!planType) return 1;
	return planType.includes("pro") ? 0 : 2;
}

function hasOpenAICodexProPlan(report: UsageReport | null): boolean {
	return getUsagePlanType(report)?.includes("pro") === true;
}

function compareUsageRankingMetric(left: number, right: number): number {
	if (left === right) return 0;
	if (!Number.isFinite(left) || !Number.isFinite(right)) return left < right ? -1 : 1;
	const delta = left - right;
	const tolerance = Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
	return Math.abs(delta) <= tolerance ? 0 : delta;
}

function resolveDefaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return DEFAULT_USAGE_PROVIDER_MAP.get(provider);
}

const DEFAULT_RANKING_STRATEGIES = new Map<Provider, CredentialRankingStrategy>([
	["openai-codex", codexRankingStrategy],
	["anthropic", claudeRankingStrategy],
	["google-antigravity", antigravityRankingStrategy],
]);

function resolveDefaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return DEFAULT_RANKING_STRATEGIES.get(provider);
}

function parseUsageCacheEntry<T>(raw: string): UsageCacheEntry<T> | undefined {
	try {
		const parsed = JSON.parse(raw) as { value?: T; expiresAt?: unknown };
		const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined;
		if (!expiresAt || !Number.isFinite(expiresAt)) return undefined;
		return { value: parsed.value as T, expiresAt };
	} catch {
		return undefined;
	}
}

/**
 * Race `promise` against `signal`, rejecting only this caller when the signal
 * fires. The underlying promise keeps running so other awaiters on the same
 * single-flight fetch aren't punished by a peer's cancel.
 */
function raceUsageWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new AIError.AbortError("usage fetch aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(new AIError.AbortError("usage fetch aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			value => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			err => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

function raceCredentialRefreshWithSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	message = "credential refresh aborted",
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new AIError.AbortError(message));
	const abort = Promise.withResolvers<never>();
	const onAbort = (): void => abort.reject(new AIError.AbortError(message));
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, abort.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

function authCredentialEquals(left: AuthCredential, right: AuthCredential): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "api_key") {
		return right.type === "api_key" && left.key === right.key;
	}
	if (right.type !== "oauth") return false;
	return (
		left.access === right.access &&
		left.refresh === right.refresh &&
		left.expires === right.expires &&
		left.accountId === right.accountId &&
		left.email === right.email &&
		left.projectId === right.projectId &&
		left.enterpriseUrl === right.enterpriseUrl
	);
}

function storedCredentialArraysEqual(left: StoredCredential[], right: StoredCredential[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const leftEntry = left[index];
		const rightEntry = right[index];
		if (!leftEntry || !rightEntry) return false;
		if (leftEntry.id !== rightEntry.id) return false;
		if (!authCredentialEquals(leftEntry.credential, rightEntry.credential)) return false;
	}
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Cache (backed by AuthCredentialStore)
// ─────────────────────────────────────────────────────────────────────────────

class AuthStorageUsageCache implements UsageCache {
	constructor(private store: AuthCredentialStore) {}

	get<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`);
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	getStale<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`, { includeExpired: true });
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	set<T>(key: string, entry: UsageCacheEntry<T>): void {
		const payload = JSON.stringify({ value: entry.value, expiresAt: entry.expiresAt });
		const durableExpiresAt =
			entry.value === null ? entry.expiresAt : Math.max(entry.expiresAt, Date.now() + USAGE_LAST_GOOD_RETENTION_MS);
		this.store.setCache(`${USAGE_CACHE_PREFIX}${key}`, payload, Math.floor(durableExpiresAt / 1000));
	}

	cleanup(): void {
		this.store.cleanExpiredCache();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory representation
// ─────────────────────────────────────────────────────────────────────────────

type StoredCredential = { id: number; credential: AuthCredential };
type OAuthSelection = { credential: OAuthCredential; index: number };
type StoredOAuthSelection = { credentialId: number; credential: OAuthCredential; index: number };

type OAuthCandidate = {
	selection: OAuthSelection;
	usage: UsageReport | null;
	usageChecked: boolean;
};

type RankedOAuthCandidate = OAuthCandidate & {
	blocked: boolean;
	blockedUntil?: number;
	hasPriorityBoost: boolean;
	planPriority: number;
	secondaryUsed: number;
	secondaryDrainRate: number;
	primaryUsed: number;
	primaryDrainRate: number;
	orderPos: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// AuthStorage Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credential storage backed by an AuthCredentialStore.
 * Reads from storage on reload(), manages round-robin credential selection,
 * usage limit tracking, and OAuth token refresh.
 */
export class AuthStorage {
	static readonly #defaultBackoffMs = 60_000; // Default backoff when no reset time available

	/** Provider -> credentials cache, populated from store on reload(). */
	#data: Map<string, StoredCredential[]> = new Map();
	#runtimeOverrides: Map<string, string> = new Map();
	#configOverrides: Map<string, string> = new Map();
	/** Tracks next credential index per provider:type key for round-robin distribution (non-session use). */
	#providerRoundRobinIndex: Map<string, number> = new Map();
	/** Tracks the last used credential per provider for a session (used for rate-limit switching). */
	#sessionLastCredential: Map<string, Map<string, { type: AuthCredential["type"]; index: number }>> = new Map();
	/** Maps provider:type -> credentialIndex -> blockedUntilMs for temporary backoff. */
	#credentialBackoff: Map<string, Map<number, number>> = new Map();
	#usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	#rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	#usageCache: UsageCache;
	#usageRequestInFlight: Map<string, Promise<UsageReport | null>> = new Map();
	#usageHeaderIngestAt: Map<string, number> = new Map();
	#usageReportsInFlight: Map<string, Promise<UsageReport[] | null>> = new Map();
	#usageFetch: typeof fetch;
	#usageRequestTimeoutMs: number;
	#usageLogger?: UsageLogger;
	#fallbackResolver?: (provider: string) => string | undefined;
	#store: AuthCredentialStore;
	#configValueResolver: (config: string) => Promise<string | undefined>;
	#refreshOAuthCredentialOverride?: AuthStorageOptions["refreshOAuthCredential"];
	#fetchUsageReportsOverride?: AuthStorageOptions["fetchUsageReports"];
	#sourceLabel?: string;
	#credentialDisabledListeners: Set<(event: CredentialDisabledEvent) => void | Promise<void>> = new Set();
	/**
	 * Buffer for credential_disabled events fired while no listener is subscribed.
	 * Drained (in insertion order) to the first listener that triggers the empty→non-empty
	 * transition via {@link AuthStorage.onCredentialDisabled}. Bounded at
	 * {@link MAX_PENDING_DISABLED_EVENTS}; oldest entries are dropped to keep memory predictable
	 * if a long-lived AuthStorage somehow accumulates a backlog (provider count is naturally small,
	 * but a process that runs without subscribers for a long time shouldn't grow this unboundedly).
	 */
	#pendingDisabledEvents: CredentialDisabledEvent[] = [];
	#generation = 1;
	#generationListeners: Set<(generation: number) => void> = new Set();
	#oauthRefreshInFlight: Map<number, Promise<AuthCredentialSnapshotEntry>> = new Map();
	#oauthCredentialRefreshInFlight: Map<number, Promise<OAuthCredentials>> = new Map();
	#closed = false;

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		this.#store = store;
		this.#configValueResolver = options.configValueResolver ?? defaultConfigValueResolver;
		this.#usageProviderResolver = options.usageProviderResolver ?? resolveDefaultUsageProvider;
		this.#rankingStrategyResolver = options.rankingStrategyResolver ?? resolveDefaultRankingStrategy;
		this.#usageCache = new AuthStorageUsageCache(this.#store);
		// Opportunistic hygiene, once per AuthStorage lifetime: drop expired
		// cache rows (24h last-good retention). A cheap indexed DELETE;
		// failures must never block construction.
		try {
			this.#store.cleanExpiredCache();
		} catch {
			// Best-effort.
		}
		this.#usageFetch = options.usageFetch ?? fetch;
		this.#usageRequestTimeoutMs = options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS;
		this.#refreshOAuthCredentialOverride = options.refreshOAuthCredential;
		this.#fetchUsageReportsOverride = options.fetchUsageReports;
		this.#sourceLabel = options.sourceLabel;
		if (options.onCredentialDisabled) {
			// Constructor-registered subscribers are permanent for this AuthStorage's lifetime;
			// the unsubscribe handle is intentionally discarded.
			this.onCredentialDisabled(options.onCredentialDisabled);
		}
		this.#usageLogger =
			options.usageLogger ??
			({
				debug: (message, meta) => logger.debug(message, meta),
				warn: (message, meta) => logger.warn(message, meta),
			} satisfies UsageLogger);
	}

	/**
	 * Create an AuthStorage instance backed by a AuthCredentialStore.
	 * Convenience factory for standalone use (e.g., pi-ai CLI).
	 * @param dbPath - Path to SQLite database
	 */
	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		return new AuthStorage(store, options);
	}

	/**
	 * Close the underlying credential store.
	 *
	 * After calling this, the instance must not be reused.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#store.close();
	}

	getGeneration(): number {
		return this.#generation;
	}

	onGenerationChanged(listener: (generation: number) => void): () => void {
		this.#generationListeners.add(listener);
		return () => {
			this.#generationListeners.delete(listener);
		};
	}

	offGenerationChanged(listener: (generation: number) => void): void {
		this.#generationListeners.delete(listener);
	}

	#bumpGeneration(reason: string): void {
		this.#generation += 1;
		for (const listener of [...this.#generationListeners]) {
			try {
				listener(this.#generation);
			} catch (error) {
				logger.debug("AuthStorage generation listener failed", { reason, error: String(error) });
			}
		}
	}

	/**
	 * Subscribe to {@link CredentialDisabledEvent}s. Multiple subscribers are supported and
	 * each fires for every disable event; subscribers are invoked in registration order with
	 * exceptions and async rejections isolated per-listener so a misbehaving subscriber
	 * cannot break the disable path or starve the rest of the chain.
	 *
	 * If `credential_disabled` events were emitted while no listener was subscribed, they are
	 * replayed (in insertion order) to the listener that triggers the empty→non-empty
	 * transition. The drain is one-shot — listeners that subscribe after that no longer see
	 * past events.
	 *
	 * Returns an unsubscribe function. The function is idempotent: calling it more than once
	 * is a no-op. After every subscriber has unsubscribed, subsequent disable events buffer
	 * again until the next subscribe.
	 *
	 * @param listener Callback invoked with each disable event. May be sync or async.
	 * @returns A function that removes this listener from the subscriber set.
	 */
	onCredentialDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
		const wasEmpty = this.#credentialDisabledListeners.size === 0;
		this.#credentialDisabledListeners.add(listener);
		if (wasEmpty && this.#pendingDisabledEvents.length > 0) {
			const drained = this.#pendingDisabledEvents;
			this.#pendingDisabledEvents = [];
			for (const event of drained) {
				this.#invokeListener(listener, event);
			}
		}
		return () => {
			this.#credentialDisabledListeners.delete(listener);
		};
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.#runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.#runtimeOverrides.delete(provider);
	}

	/**
	 * Register a per-provider API key sourced from user configuration
	 * (e.g. `models.yml` `providers.<name>.apiKey`). Higher priority than
	 * stored credentials and OAuth tokens — when the user pins a key in
	 * config, that key is what authenticates outbound requests, regardless
	 * of whatever the broker happens to have loaded for that provider.
	 *
	 * Lower priority than {@link setRuntimeApiKey} so a CLI `--api-key`
	 * still wins for the duration of a single invocation.
	 */
	setConfigApiKey(provider: string, apiKey: string): void {
		this.#configOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a single config-sourced API key override.
	 */
	removeConfigApiKey(provider: string): void {
		this.#configOverrides.delete(provider);
	}

	/**
	 * Drop every config-sourced API key. Called by `ModelRegistry` before
	 * re-parsing `models.yml` so removed entries actually disappear.
	 */
	clearConfigApiKeys(): void {
		this.#configOverrides.clear();
	}

	/**
	 * Set a fallback resolver for API keys not found in storage or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.#fallbackResolver = resolver;
	}

	/**
	 * Reload credentials from storage.
	 */
	async reload(): Promise<void> {
		const records = this.#store.listAuthCredentials();
		const grouped = new Map<string, StoredCredential[]>();
		for (const record of records) {
			const list = grouped.get(record.provider) ?? [];
			list.push({ id: record.id, credential: record.credential });
			grouped.set(record.provider, list);
		}

		const dedupedGrouped = new Map<string, StoredCredential[]>();
		for (const [provider, entries] of grouped.entries()) {
			const deduped = this.#pruneDuplicateStoredCredentials(provider, entries);
			if (deduped.length > 0) {
				dedupedGrouped.set(provider, deduped);
			}
		}

		const removedProviders = new Set(this.#data.keys());
		for (const [provider, entries] of dedupedGrouped) {
			this.#setStoredCredentials(provider, entries);
			removedProviders.delete(provider);
		}
		for (const provider of removedProviders) {
			this.#setStoredCredentials(provider, []);
		}
	}

	/**
	 * Gets cached credentials for a provider.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @returns Array of stored credentials, empty if none exist
	 */
	#getStoredCredentials(provider: string): StoredCredential[] {
		return this.#data.get(provider) ?? [];
	}

	/**
	 * Updates in-memory credential cache for a provider.
	 * Removes the provider entry entirely if credentials array is empty.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @param credentials - Array of stored credentials to cache
	 */
	#setStoredCredentials(provider: string, credentials: StoredCredential[]): void {
		const current = this.#data.get(provider) ?? [];
		if (storedCredentialArraysEqual(current, credentials)) return;
		if (credentials.length === 0) {
			this.#data.delete(provider);
		} else {
			this.#data.set(provider, credentials);
		}
		this.#bumpGeneration("credentials");
	}

	#resolveOAuthDedupeIdentityKey(provider: string, credential: OAuthCredential): string | null {
		return resolveCredentialIdentityKey(provider, credential);
	}

	#dedupeOAuthCredentials(provider: string, credentials: AuthCredential[]): AuthCredential[] {
		const seen = new Set<string>();
		const deduped: AuthCredential[] = [];
		for (let index = credentials.length - 1; index >= 0; index -= 1) {
			const credential = credentials[index];
			if (credential.type !== "oauth") {
				deduped.push(credential);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
			if (!identityKey) {
				deduped.push(credential);
				continue;
			}
			if (seen.has(identityKey)) {
				continue;
			}
			seen.add(identityKey);
			deduped.push(credential);
		}
		return deduped.reverse();
	}

	#pruneDuplicateStoredCredentials(provider: string, entries: StoredCredential[]): StoredCredential[] {
		const seen = new Set<string>();
		const kept: StoredCredential[] = [];
		const removed: StoredCredential[] = [];
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			const credential = entry.credential;
			if (credential.type !== "oauth") {
				kept.push(entry);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
			if (!identityKey) {
				kept.push(entry);
				continue;
			}
			if (seen.has(identityKey)) {
				removed.push(entry);
				continue;
			}
			seen.add(identityKey);
			kept.push(entry);
		}
		if (removed.length > 0) {
			for (const entry of removed) {
				this.#store.deleteAuthCredential(entry.id, "deduplicated duplicate credential");
			}
			this.#resetProviderAssignments(provider);
		}
		return kept.reverse();
	}

	/** Returns all credentials for a provider as an array */
	#getCredentialsForProvider(provider: string): AuthCredential[] {
		return this.#getStoredCredentials(provider).map(entry => entry.credential);
	}

	/** Composite key for round-robin tracking: "anthropic:oauth" or "openai:api_key" */
	#getProviderTypeKey(provider: string, type: AuthCredential["type"]): string {
		return `${provider}:${type}`;
	}

	/**
	 * Returns next index in round-robin sequence for load distribution.
	 * Increments stored counter and wraps at total.
	 */
	#getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.#providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.#providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	/**
	 * FNV-1a hash for deterministic session-to-credential mapping.
	 * Ensures the same session always starts with the same credential.
	 */
	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	/**
	 * Returns credential indices in priority order for selection.
	 * With sessionId: starts from hashed index (consistent per session).
	 * Without sessionId: starts from round-robin index (load balancing).
	 * Order wraps around so all credentials are tried if earlier ones are blocked.
	 */
	#getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		const start = sessionId
			? this.#getHashedIndex(sessionId, total)
			: this.#getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	#toScopedBackoffKey(providerKey: string, blockScope: string | undefined): string {
		return blockScope ? `${providerKey}\0${blockScope}` : providerKey;
	}

	/** Returns block expiry timestamp for a credential/key pair, cleaning up expired entries. */
	#getCredentialBlockedUntilForKey(backoffKey: string, credentialIndex: number): number | undefined {
		const backoffMap = this.#credentialBackoff.get(backoffKey);
		if (!backoffMap) return undefined;
		const blockedUntil = backoffMap.get(credentialIndex);
		if (!blockedUntil) return undefined;
		if (blockedUntil <= Date.now()) {
			backoffMap.delete(credentialIndex);
			if (backoffMap.size === 0) {
				this.#credentialBackoff.delete(backoffKey);
			}
			return undefined;
		}
		return blockedUntil;
	}

	/** Returns block expiry timestamp for a credential, checking global then scoped blocks. */
	#getCredentialBlockedUntil(
		providerKey: string,
		credentialIndex: number,
		blockScope: string | undefined = undefined,
	): number | undefined {
		const globalBlockedUntil = this.#getCredentialBlockedUntilForKey(providerKey, credentialIndex);
		if (globalBlockedUntil !== undefined || !blockScope) return globalBlockedUntil;
		return this.#getCredentialBlockedUntilForKey(this.#toScopedBackoffKey(providerKey, blockScope), credentialIndex);
	}

	/** Checks if a credential is temporarily blocked due to usage limits. */
	#isCredentialBlocked(
		providerKey: string,
		credentialIndex: number,
		blockScope: string | undefined = undefined,
	): boolean {
		return this.#getCredentialBlockedUntil(providerKey, credentialIndex, blockScope) !== undefined;
	}

	/** Marks a credential as blocked until the specified time. */
	#markCredentialBlocked(
		providerKey: string,
		credentialIndex: number,
		blockedUntilMs: number,
		blockScope: string | undefined = undefined,
	): void {
		const backoffKey = this.#toScopedBackoffKey(providerKey, blockScope);
		const backoffMap = this.#credentialBackoff.get(backoffKey) ?? new Map<number, number>();
		const existing = backoffMap.get(credentialIndex) ?? 0;
		backoffMap.set(credentialIndex, Math.max(existing, blockedUntilMs));
		this.#credentialBackoff.set(backoffKey, backoffMap);
	}

	/** Records which credential was used for a session (for rate-limit switching). */
	#recordSessionCredential(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
	): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider) ?? new Map();
		sessionMap.set(sessionId, { type, index });
		this.#sessionLastCredential.set(provider, sessionMap);

		try {
			const credentialId = this.#getStoredCredentials(provider)[index]?.id;
			if (credentialId !== undefined) {
				const cacheKey = `session:sticky:${provider}:${sessionId}`;
				const cacheValue = JSON.stringify({ type, index, credentialId });
				// Expires in 30 days
				const expiresAtSec = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
				this.#store.setCache(cacheKey, cacheValue, expiresAtSec);
			}
		} catch (err) {
			logger.debug("Failed to write session sticky credential to persistent store cache", { err });
		}
	}

	/** Retrieves the last credential used by a session. */
	#getSessionCredential(
		provider: string,
		sessionId: string | undefined,
	): { type: AuthCredential["type"]; index: number } | undefined {
		if (!sessionId) return undefined;
		let sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap?.has(sessionId)) {
			return sessionMap.get(sessionId);
		}
		try {
			const cacheKey = `session:sticky:${provider}:${sessionId}`;
			const raw = this.#store.getCache(cacheKey);
			if (raw) {
				const val = JSON.parse(raw) as { type: AuthCredential["type"]; index: number; credentialId?: number };

				if (val.credentialId !== undefined) {
					const stored = this.#getStoredCredentials(provider);
					const actualIndex = stored.findIndex(entry => entry.id === val.credentialId);
					if (actualIndex === -1 || stored[actualIndex]?.credential.type !== val.type) {
						this.#store.setCache(cacheKey, "", 0);
						return undefined;
					}
					val.index = actualIndex;
				} else {
					// Fallback: drop unsafe index-only cache rows to prevent wrong-account routing
					this.#store.setCache(cacheKey, "", 0);
					return undefined;
				}

				if (!sessionMap) {
					sessionMap = new Map();
					this.#sessionLastCredential.set(provider, sessionMap);
				}
				const sessionVal = { type: val.type, index: val.index };
				sessionMap.set(sessionId, sessionVal);
				return sessionVal;
			}
		} catch (err) {
			logger.debug("Failed to read session sticky credential from persistent store cache", { err });
		}
		return undefined;
	}

	/** Clears the last credential used by a session for a provider. */
	#clearSessionCredential(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap) {
			sessionMap.delete(sessionId);
			if (sessionMap.size === 0) {
				this.#sessionLastCredential.delete(provider);
			}
		}
		try {
			const cacheKey = `session:sticky:${provider}:${sessionId}`;
			this.#store.setCache(cacheKey, "", 0);
		} catch (err) {
			logger.debug("Failed to clear session sticky credential from persistent store cache", { err });
		}
	}

	/**
	 * Selects a credential of the specified type for a provider.
	 * Returns both the credential and its index in the original array (for updates/removal).
	 * Uses deterministic hashing for session stickiness and skips blocked credentials when possible.
	 */
	#selectCredentialByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
	): { credential: Extract<AuthCredential, { type: T }>; index: number } | undefined {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: Extract<AuthCredential, { type: T }>; index: number } =>
					entry.credential.type === type,
			);

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.#getProviderTypeKey(provider, type);
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];

		for (const idx of order) {
			const candidate = credentials[idx];
			if (!this.#isCredentialBlocked(providerKey, candidate.index)) {
				return candidate;
			}
		}

		return fallback;
	}

	/**
	 * Clears round-robin and session assignment state for a provider.
	 * Called when credentials are added/removed to prevent stale index references.
	 */
	#resetProviderAssignments(provider: string): void {
		for (const key of this.#providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#providerRoundRobinIndex.delete(key);
			}
		}
		this.#sessionLastCredential.delete(provider);
		for (const key of this.#credentialBackoff.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#credentialBackoff.delete(key);
			}
		}
	}

	/** Updates credential at index in-place (used for OAuth token refresh) */
	#replaceCredentialAt(provider: string, index: number, credential: AuthCredential): void {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return;
		const target = entries[index];
		this.#store.updateAuthCredential(target.id, credential);
		const updated = [...entries];
		updated[index] = { id: target.id, credential };
		this.#setStoredCredentials(provider, updated);
	}

	/**
	 * CAS-style disable used when OAuth refresh definitively fails: only disables
	 * persisted `data` still matches the credential we attempted to refresh.
	 * Returns `false` when a peer rotated the row between our pre-check and the
	 * disable, so the caller can reload and retry instead of clobbering the
	 * freshly-rotated credential.
	 */
	#tryDisableCredentialAtIfMatches(
		provider: string,
		index: number,
		expectedCredential: AuthCredential,
		disabledCause: string,
	): boolean {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return false;
		const target = entries[index];
		const serialized = serializeCredential(provider, expectedCredential);
		if (!serialized) return false;
		const disabled = this.#store.tryDisableAuthCredentialIfMatches(target.id, serialized.data, disabledCause);
		if (!disabled) return false;
		const updated = entries.filter((_value, idx) => idx !== index);
		this.#setStoredCredentials(provider, updated);
		this.#resetProviderAssignments(provider);
		this.#emitCredentialDisabled({ provider, disabledCause });
		return true;
	}

	/**
	 * Persist a refreshed credential addressed by id, not a positional index.
	 * A concurrent disable can reorder/shrink the provider's row array while an
	 * async refresh is in flight, so a pre-await index is unsafe; resolving the
	 * row by id at write time lands the rotated token on the correct row. Returns
	 * the row's current index, or -1 when it was disabled/removed mid-refresh.
	 */
	#replaceCredentialById(provider: string, id: number, credential: AuthCredential): number {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === id);
		if (index === -1) return -1;
		this.#store.updateAuthCredential(id, credential);
		const updated = [...entries];
		updated[index] = { id, credential };
		this.#setStoredCredentials(provider, updated);
		return index;
	}

	/**
	 * CAS-disable the row with `id`, but only if its persisted credential still
	 * matches `expected` — i.e. no peer/login rotated it while we refreshed.
	 * Addresses the row by id (re-resolved here, then matched on `data` in the
	 * store) so a concurrent reorder can't tear down the wrong credential.
	 */
	#disableCredentialByIdIfMatches(
		provider: string,
		id: number,
		expected: AuthCredential,
		disabledCause: string,
	): boolean {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === id);
		if (index === -1) return false;
		return this.#tryDisableCredentialAtIfMatches(provider, index, expected, disabledCause);
	}

	#emitCredentialDisabled(event: CredentialDisabledEvent): void {
		if (this.#credentialDisabledListeners.size === 0) {
			// No subscribers — buffer for later replay. Cap the backlog so a process that runs
			// without subscribers for a long time can't grow memory unboundedly; drop oldest
			// under pressure.
			if (this.#pendingDisabledEvents.length >= MAX_PENDING_DISABLED_EVENTS) {
				this.#pendingDisabledEvents.shift();
			}
			this.#pendingDisabledEvents.push(event);
			return;
		}
		// Snapshot before iteration so a listener that subscribes/unsubscribes during fan-out
		// can't observe a partially-mutated set or receive an event it just registered for.
		const listeners = [...this.#credentialDisabledListeners];
		for (const listener of listeners) {
			this.#invokeListener(listener, event);
		}
	}

	#invokeListener(
		listener: (event: CredentialDisabledEvent) => void | Promise<void>,
		event: CredentialDisabledEvent,
	): void {
		const logListenerError = (error: unknown): void => {
			logger.warn("onCredentialDisabled listener threw", { provider: event.provider, error: String(error) });
		};
		try {
			const result = listener(event);
			if (result && typeof (result as PromiseLike<void>).then === "function") {
				(result as Promise<void>).catch(logListenerError);
			}
		} catch (error) {
			logListenerError(error);
		}
	}

	/**
	 * Get credential for a provider (first entry if multiple).
	 */
	get(provider: string): AuthCredential | undefined {
		return this.#getCredentialsForProvider(provider)[0];
	}

	/**
	 * Set credential for a provider.
	 */
	async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		const normalized = Array.isArray(credential) ? credential : [credential];
		const deduped = this.#dedupeOAuthCredentials(provider, normalized);
		const stored = this.#store.replaceAuthCredentialsRemote
			? await this.#store.replaceAuthCredentialsRemote(provider, deduped)
			: this.#store.replaceAuthCredentialsForProvider(provider, deduped);
		this.#setStoredCredentials(
			provider,
			stored.map(record => ({ id: record.id, credential: record.credential })),
		);
		this.#resetProviderAssignments(provider);
	}

	/**
	 * List stored credential rows, optionally filtered by provider.
	 */
	listStoredCredentials(provider?: string): StoredAuthCredential[] {
		if (provider !== undefined) {
			return this.#getStoredCredentials(provider).map(entry => ({
				id: entry.id,
				provider,
				credential: entry.credential,
				disabledCause: null,
			}));
		}
		const rows: StoredAuthCredential[] = [];
		for (const [storedProvider, entries] of this.#data) {
			for (const entry of entries) {
				rows.push({
					id: entry.id,
					provider: storedProvider,
					credential: entry.credential,
					disabledCause: null,
				});
			}
		}
		return rows;
	}

	async #upsertOAuthCredential(provider: string, credential: OAuthCredential): Promise<void> {
		const stored = this.#store.upsertAuthCredentialRemote
			? await this.#store.upsertAuthCredentialRemote(provider, credential)
			: this.#store.upsertAuthCredentialForProvider(provider, credential);
		this.#setStoredCredentials(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential })),
		);
		this.#resetProviderAssignments(provider);
	}

	/**
	 * Remove credential for a provider.
	 */
	async remove(provider: string): Promise<void> {
		if (this.#store.deleteAuthCredentialsRemote) {
			await this.#store.deleteAuthCredentialsRemote(provider, "deleted by user");
		} else {
			this.#store.deleteAuthCredentialsForProvider(provider, "deleted by user");
		}
		this.#setStoredCredentials(provider, []);
		this.#resetProviderAssignments(provider);
	}

	/**
	 * Remove one stored credential for a provider.
	 */
	async removeCredential(provider: string, credentialId: number): Promise<boolean> {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === credentialId);
		if (index === -1) return false;

		if (this.#store.deleteAuthCredentialRemote) {
			const deleted = await this.#store.deleteAuthCredentialRemote(credentialId, "deleted by user");
			if (!deleted) return false;
		} else {
			this.#store.deleteAuthCredential(credentialId, "deleted by user");
		}
		this.#setStoredCredentials(
			provider,
			entries.filter((_entry, entryIndex) => entryIndex !== index),
		);
		this.#resetProviderAssignments(provider);
		return true;
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return [...this.#data.keys()];
	}

	/**
	 * Check if credentials exist for a provider in storage.
	 */
	has(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).length > 0;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.#fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * True iff a dedicated, non-env credential source is configured for this
	 * provider — i.e. anything in the cascade EXCEPT `getEnvApiKey(provider)`.
	 *
	 * Mirrors `hasAuth` minus the env-fallback leg. Useful for callers that
	 * need to distinguish "the user explicitly configured this provider"
	 * from "an env var happens to alias this provider via the cross-provider
	 * fallback map" (see e.g. `xai-oauth → XAI_OAUTH_TOKEN || XAI_API_KEY` in
	 * `stream.ts`). Without that distinction, an `XAI_API_KEY`-only setup
	 * silently satisfies xai-oauth and routes around `providers.xai.baseUrl`.
	 */
	hasNonEnvCredential(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (this.#fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Classify where a provider's auth comes from, following the same precedence
	 * as {@link AuthStorage.getApiKey}: runtime override → config override →
	 * stored credential (api_key before oauth, matching getApiKey) → env var →
	 * fallback resolver. Returns undefined when no auth is configured.
	 *
	 * Compact, structured counterpart to {@link describeCredentialSource}.
	 */
	getCredentialOrigin(provider: string): CredentialOrigin | undefined {
		if (this.#runtimeOverrides.has(provider)) return { kind: "runtime" };
		if (this.#configOverrides.has(provider)) return { kind: "config" };
		const stored = this.#getCredentialsForProvider(provider);
		if (stored.length > 0) {
			return { kind: stored.some(credential => credential.type === "api_key") ? "api_key" : "oauth" };
		}
		if (getEnvApiKey(provider)) return { kind: "env", envVar: getEnvApiKeyName(provider) };
		if (this.#fallbackResolver?.(provider)) return { kind: "fallback" };
		return undefined;
	}

	/**
	 * Check if OAuth credentials are configured for a provider.
	 */
	hasOAuth(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth");
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuthCredential(provider: string): OAuthCredential | undefined {
		return this.#getCredentialsForProvider(provider).find(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
	}

	#resolveActiveOAuthCredential(provider: string, sessionId?: string): OAuthCredential | undefined {
		const allCredentials = this.#getCredentialsForProvider(provider);
		const oauthCredentials = allCredentials.filter((c): c is OAuthCredential => c.type === "oauth");
		if (oauthCredentials.length === 0) return undefined;

		// Runtime / config overrides bypass OAuth account_uuid attribution — the
		// caller is authenticating with an explicit key, not the broker's OAuth.
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) return undefined;

		// Prefer the session-sticky credential when available.
		const sessionPref = this.#getSessionCredential(provider, sessionId);
		// If the session has been routed to a stored API key, do not inject OAuth account_uuid.
		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		// When no session-sticky credential is recorded yet (first call before any getApiKey,
		// or all stored credentials are unavailable), the request falls through to the env-key
		// or fallback-resolver path in getApiKey() — neither is OAuth-authenticated, so
		// account_uuid injection would misattribute traffic. Only apply this guard when
		// sessionPref is absent; a recorded OAuth sticky (sessionPref.type === "oauth") must
		// NOT be blocked even if an env key also happens to exist.
		if (!sessionPref && (getEnvApiKey(provider) || this.#fallbackResolver?.(provider))) return undefined;
		// Resolve the sticky index against the full credential list — the index is
		// recorded against the unfiltered provider array (by #recordSessionCredential /
		// #tryOAuthCredential), not the OAuth-only subset, so dereferencing it into the
		// filtered array would be off-by-N when any non-OAuth credential precedes the
		// OAuth ones (e.g. [api_key, oauth_A, oauth_B] stored order).
		const stickyCredential = sessionPref?.type === "oauth" ? allCredentials[sessionPref.index] : undefined;
		return stickyCredential?.type === "oauth" ? stickyCredential : oauthCredentials[0];
	}

	/**
	 * Get the OAuth `accountId` for a provider, preferring the credential that is
	 * session-sticky for `sessionId` when multiple OAuth credentials are configured.
	 * Falls back to the first OAuth credential when no session preference exists (e.g.
	 * first call before any `getApiKey` has been issued, or single-credential setups).
	 * Returns `undefined` when no OAuth credential carries an `accountId`.
	 */
	getOAuthAccountId(provider: string, sessionId?: string): string | undefined {
		const preferred = this.#resolveActiveOAuthCredential(provider, sessionId);
		const accountId = preferred?.accountId;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	}

	/**
	 * Get the OAuth account identity for a provider, preferring the credential that
	 * is session-sticky for `sessionId`. This is a read-only lookup for display and
	 * metadata paths; it does not refresh tokens, rank usage, or advance selection.
	 */
	getOAuthAccountIdentity(provider: string, sessionId?: string): OAuthAccountIdentity | undefined {
		const preferred = this.#resolveActiveOAuthCredential(provider, sessionId);
		if (!preferred) return undefined;
		const identity: OAuthAccountIdentity = {};
		if (typeof preferred.accountId === "string" && preferred.accountId.length > 0) {
			identity.accountId = preferred.accountId;
		}
		if (typeof preferred.email === "string" && preferred.email.length > 0) {
			identity.email = preferred.email;
		}
		if (typeof preferred.projectId === "string" && preferred.projectId.length > 0) {
			identity.projectId = preferred.projectId;
		}
		if (!identity.accountId && !identity.email && !identity.projectId) return undefined;
		return identity;
	}

	/**
	 * Get all credentials.
	 */
	getAll(): AuthStorageData {
		const result: AuthStorageData = {};
		for (const [provider, entries] of this.#data.entries()) {
			const credentials = entries.map(entry => entry.credential);
			if (credentials.length === 1) {
				result[provider] = credentials[0];
			} else if (credentials.length > 1) {
				result[provider] = credentials;
			}
		}
		return result;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(
		provider: OAuthProviderId,
		ctrl: OAuthController & {
			/** onAuth is required by auth-storage but optional in OAuthController */
			onAuth: (info: { url: string; instructions?: string }) => void;
			/** onPrompt is required for some providers (github-copilot, openai-codex) */
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
		},
	): Promise<void> {
		// Only paste-code providers (fixed non-loopback redirect, e.g. GitLab Duo
		// Agent's vscode:// URI) get a default manual-code prompt. For loopback OAuth
		// providers the `OAuthCallbackFlow` would otherwise race this readline prompt
		// against the HTTP callback and, when the callback wins, leave the prompt
		// outstanding — a dirty/blocked terminal. Synthesizing the default only for
		// paste-code providers is the authoritative gate (it covers every caller, not
		// just the CLI); an explicit caller-supplied `onManualCodeInput` is still
		// honored for any provider as an escape hatch.
		const manualCodeInput = PASTE_CODE_LOGIN_PROVIDERS.has(provider)
			? () => ctrl.onPrompt({ message: "Paste the authorization code (or full redirect URL):" })
			: undefined;
		// Built-in registry first, then runtime-registered extension providers.
		const def = getProviderDefinition(provider) ?? getOAuthProvider(provider);
		if (!def?.login) {
			throw new AIError.ConfigurationError(`Unknown OAuth provider: ${provider}`);
		}
		const result = await def.login({
			onAuth: ctrl.onAuth,
			onProgress: ctrl.onProgress,
			onPrompt: ctrl.onPrompt,
			onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
			signal: ctrl.signal,
			fetch: ctrl.fetch,
		});
		if (typeof result === "string") {
			// Some flows (e.g. ollama) return "" to signal that no key was entered.
			if (!result) {
				return;
			}
			const newCredential: ApiKeyCredential = { type: "api_key", key: result };
			const stored = this.#store.upsertAuthCredentialRemote
				? await this.#store.upsertAuthCredentialRemote(provider, newCredential)
				: this.#store.upsertAuthCredentialForProvider(provider, newCredential);
			this.#setStoredCredentials(
				provider,
				stored.map(entry => ({ id: entry.id, credential: entry.credential })),
			);
			this.#resetProviderAssignments(provider);
			return;
		}
		const newCredential: OAuthCredential = { type: "oauth", ...result };
		// Use #upsertOAuthCredential to upsert the new credential.
		// Any legacy api_key rows from older versions will be cleaned up so they do not
		// shadow the new OAuth row, while preserving other active OAuth credentials.
		await this.#upsertOAuthCredential(def.storeCredentialsAs ?? provider, newCredential);
	}

	/**
	 * Logout from a provider.
	 */
	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Usage API Integration
	// Queries provider usage endpoints to detect rate limits before they occur.
	// ─────────────────────────────────────────────────────────────────────────────

	#buildUsageCredential(credential: OAuthCredential): UsageCredential {
		return {
			type: "oauth",
			accessToken: credential.access,
			refreshToken: credential.refresh,
			expiresAt: credential.expires,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
		};
	}

	#buildUsageCacheIdentity(credential: UsageCredential): string {
		const parts: string[] = [credential.type];
		const accountId = credential.accountId?.trim();
		if (accountId) parts.push(`account:${accountId}`);
		const email = credential.email?.trim().toLowerCase();
		if (email) parts.push(`email:${email}`);
		const projectId = credential.projectId?.trim();
		if (projectId) parts.push(`project:${projectId}`);
		const enterpriseUrl = credential.enterpriseUrl?.trim().toLowerCase();
		if (enterpriseUrl) parts.push(`enterprise:${enterpriseUrl}`);
		// Only fall back to a secret-derived key when a stable account identifier is unavailable.
		// Including the token hash when accountId/email are present causes cache misses on
		// every OAuth refresh — usage data is per-account, not per-token.
		const hasStableIdentifier = Boolean(accountId || email);
		if (!hasStableIdentifier) {
			const secret = credential.apiKey?.trim() || credential.refreshToken?.trim() || credential.accessToken?.trim();
			if (secret) {
				parts.push(`secret:${Bun.hash(secret).toString(16)}`);
			} else {
				parts.push("anonymous");
			}
		}
		return parts.join("|");
	}

	#normalizeUsageBaseUrl(baseUrl?: string): string {
		return baseUrl?.trim().replace(/\/+$/, "") ?? "";
	}

	#buildUsageReportCacheKey(request: UsageRequestDescriptor): string {
		const baseUrl = this.#normalizeUsageBaseUrl(request.baseUrl) || "default";
		const identity = this.#buildUsageCacheIdentity(request.credential);
		const versionOverride = USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES[request.provider];
		const providerKey = versionOverride === undefined ? request.provider : `${versionOverride}:${request.provider}`;
		return `report:${providerKey}:${baseUrl}:${identity}`;
	}

	#buildUsageReportsCacheKey(requests: ReadonlyArray<UsageRequestDescriptor>): string {
		const snapshot = requests
			.map(request => {
				const versionOverride = USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES[request.provider];
				const providerKey =
					versionOverride === undefined ? request.provider : `${versionOverride}:${request.provider}`;
				return `${providerKey}:${this.#normalizeUsageBaseUrl(request.baseUrl) || "default"}:${this.#buildUsageCacheIdentity(request.credential)}`;
			})
			.sort()
			.join("\n");
		return `reports:${Bun.hash(snapshot).toString(16)}`;
	}

	#buildUsageRequest(provider: Provider, credential: UsageCredential, baseUrl?: string): UsageRequestDescriptor {
		return { provider, credential, baseUrl };
	}

	#buildUsageRequestForOauth(
		provider: Provider,
		credential: OAuthCredential,
		baseUrl?: string,
	): UsageRequestDescriptor {
		return this.#buildUsageRequest(provider, this.#buildUsageCredential(credential), baseUrl);
	}

	#buildRefreshableOauthCredential(credential: UsageCredential): OAuthCredential | null {
		if (!credential.accessToken || !credential.refreshToken || credential.expiresAt === undefined) {
			return null;
		}
		return {
			type: "oauth",
			access: credential.accessToken,
			refresh: credential.refreshToken,
			expires: credential.expiresAt,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
		};
	}

	/**
	 * Translate a refreshed {@link UsageCredential} into the public
	 * {@link CompletionProbeCredential} shape. Returns `null` when the
	 * credential lacks any usable bearer bytes (e.g. an API-key row with an
	 * empty key, or an OAuth row that never had an `access` token written).
	 */
	#buildCompletionProbeCredential(credential: UsageCredential): CompletionProbeCredential | null {
		if (credential.type === "api_key") {
			return credential.apiKey ? { type: "api_key", apiKey: credential.apiKey } : null;
		}
		if (!credential.accessToken) return null;
		return {
			type: "oauth",
			accessToken: credential.accessToken,
			refreshToken: credential.refreshToken,
			expiresAt: credential.expiresAt,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
		};
	}

	#mergeRefreshedUsageCredential(credential: UsageCredential, refreshed: OAuthCredentials): UsageCredential {
		return {
			...credential,
			accessToken: refreshed.access,
			refreshToken: refreshed.refresh,
			expiresAt: refreshed.expires,
			accountId: refreshed.accountId ?? credential.accountId,
			projectId: refreshed.projectId ?? credential.projectId,
			email: refreshed.email ?? credential.email,
			enterpriseUrl: refreshed.enterpriseUrl ?? credential.enterpriseUrl,
			apiEndpoint: refreshed.apiEndpoint ?? credential.apiEndpoint,
		};
	}

	/**
	 * Find the stored credential id matching a {@link UsageCredential} so the
	 * refresh override can address the row. Mirrors the matching logic in
	 * {@link AuthStorage.#persistRefreshedUsageCredential}.
	 */
	#findStoredCredentialIdForUsageCredential(provider: Provider, previous: UsageCredential): number | undefined {
		const entries = this.#getStoredCredentials(provider);
		const match = entries.find(entry => {
			if (entry.credential.type !== "oauth") return false;
			if (previous.refreshToken && entry.credential.refresh === previous.refreshToken) return true;
			if (previous.accessToken && entry.credential.access === previous.accessToken) return true;
			return (
				entry.credential.accountId === previous.accountId &&
				entry.credential.email === previous.email &&
				entry.credential.projectId === previous.projectId
			);
		});
		return match?.id;
	}

	#persistRefreshedUsageCredential(provider: Provider, previous: UsageCredential, next: UsageCredential): void {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => {
			if (entry.credential.type !== "oauth") return false;
			if (previous.refreshToken && entry.credential.refresh === previous.refreshToken) return true;
			if (previous.accessToken && entry.credential.access === previous.accessToken) return true;
			return (
				entry.credential.accountId === previous.accountId &&
				entry.credential.email === previous.email &&
				entry.credential.projectId === previous.projectId
			);
		});
		if (index === -1) return;
		const existing = entries[index]!.credential;
		if (existing.type !== "oauth") return;
		this.#replaceCredentialAt(provider, index, {
			type: "oauth",
			access: next.accessToken ?? existing.access,
			refresh: next.refreshToken ?? existing.refresh,
			expires: next.expiresAt ?? existing.expires,
			accountId: next.accountId,
			projectId: next.projectId,
			email: next.email,
			enterpriseUrl: next.enterpriseUrl,
			apiEndpoint: next.apiEndpoint,
		});
	}

	async #fetchUsageUncached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const resolver = this.#usageProviderResolver;
		if (!resolver) return null;

		const providerImpl = resolver(request.provider);
		if (!providerImpl) return null;

		const timeoutSignal =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? AbortSignal.timeout(timeoutMs)
				: undefined;
		let params: UsageFetchParams = {
			...request,
			accountKey: this.#buildUsageCacheIdentity(request.credential),
			signal: timeoutSignal,
		};

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() + OAUTH_REFRESH_SKEW_MS >= request.credential.expiresAt
		) {
			const refreshableCredential = this.#buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshableCredentialId = this.#findStoredCredentialIdForUsageCredential(
						request.provider,
						request.credential,
					);
					const refreshed = await this.#refreshOAuthCredential(
						request.provider,
						refreshableCredential,
						refreshableCredentialId,
						timeoutSignal,
					);
					const refreshedCredential = this.#mergeRefreshedUsageCredential(request.credential, refreshed);
					this.#persistRefreshedUsageCredential(request.provider, request.credential, refreshedCredential);
					params = {
						...request,
						credential: refreshedCredential,
						accountKey: this.#buildUsageCacheIdentity(refreshedCredential),
						signal: timeoutSignal,
					};
				} catch (error) {
					const errorMsg = String(error);
					// Definitive failure (invalid_grant / 401 not from a network blip) means
					// the refresh token itself is dead — probing with the original credential
					// will 401, the catch below will return null, and #fetchUsageCached's
					// last-good fallback will surface yesterday's report indefinitely
					// (including its already-elapsed `resetsAt`). CAS-disable the row and
					// clear the cache so the credential drops out of the report instead of
					// freezing in place until the user notices and re-logs in.
					if (AIError.isDefinitiveOAuthFailure(errorMsg)) {
						const credentialId = this.#findStoredCredentialIdForUsageCredential(
							request.provider,
							request.credential,
						);
						if (credentialId !== undefined) {
							const entries = this.#getStoredCredentials(request.provider);
							const index = entries.findIndex(entry => entry.id === credentialId);
							if (index !== -1) {
								const disabled = this.#tryDisableCredentialAtIfMatches(
									request.provider,
									index,
									refreshableCredential,
									`oauth refresh failed during usage probe: ${errorMsg}`,
								);
								if (disabled) {
									this.#usageLogger?.warn(
										"Usage credential refresh failed definitively; credential disabled",
										{ provider: request.provider, credentialId, error: errorMsg },
									);
									// Neutralize last-good for this cache key: write a null
									// entry with an immediately-elapsed expiry so a future
									// getStale lookup (e.g. on re-login under the same
									// account identity) can't replay the stale report.
									this.#usageCache.set(this.#buildUsageReportCacheKey(request), {
										value: null,
										expiresAt: 0,
									});
									return null;
								}
							}
						}
					}
					this.#usageLogger?.debug("Usage credential refresh failed, using original credential", {
						provider: request.provider,
						error: errorMsg,
					});
				}
			}
		}

		if (providerImpl.supports && !providerImpl.supports(params)) return null;

		try {
			return await providerImpl.fetchUsage(params, {
				fetch: this.#usageFetch,
				logger: this.#usageLogger,
				listUsageCosts: query => this.#store.listUsageCosts?.(query) ?? [],
			});
		} catch (error) {
			logger.debug("AuthStorage usage fetch failed", {
				provider: request.provider,
				error: String(error),
			});
			return null;
		}
	}

	async #fetchUsageCached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const cacheKey = this.#buildUsageReportCacheKey(request);
		const now = Date.now();
		const cached = this.#usageCache.get<UsageReport | null>(cacheKey);
		// Fresh cache hit: return whatever's there (success or null fallback).
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const inFlight = this.#usageRequestInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const promise = (async () => {
			const report = await this.#fetchUsageUncached(request, timeoutMs);
			const ttlJitter = USAGE_REPORT_TTL_MS * (Math.random() * 0.5 - 0.25);
			if (report !== null) {
				// Success: stagger per-credential cache expiry so all accounts don't
				// refresh in the same window — Anthropic / OpenAI rate-limit `/usage`
				// per source IP regardless of account, and synchronized 5-credential
				// fan-out trips 429s every cycle. With ±25% jitter on TTL the refresh
				// times decorrelate within a few cycles.
				this.#usageCache.set(cacheKey, { value: report, expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter });
				this.#recordUsageHistory(request, report);
				return report;
			}
			// Failure: cache the LAST GOOD value (if any) with a short jittered TTL
			// so the credential cools down briefly without dropping out of the
			// report. If we never had a good value, return null this cycle and
			// don't write — let the next poll retry.
			const lastGood = this.#usageCache.getStale<UsageReport | null>(cacheKey)?.value ?? null;
			if (lastGood !== null) {
				const backoffJitter = USAGE_FAILURE_BACKOFF_MS * (Math.random() * 0.5 - 0.25);
				const coolDown = Date.now() + USAGE_FAILURE_BACKOFF_MS + backoffJitter;
				this.#usageCache.set(cacheKey, { value: lastGood, expiresAt: coolDown });
			}
			return lastGood;
		})().finally(() => {
			this.#usageRequestInFlight.delete(cacheKey);
		});

		this.#usageRequestInFlight.set(cacheKey, promise);
		return promise;
	}

	/**
	 * Append a freshly fetched report to durable usage history (when the store
	 * supports it). The usage cache is latest-snapshot-only — these rows are
	 * the only place limit utilization is kept over time.
	 */
	#recordUsageHistory(request: UsageRequestDescriptor, report: UsageReport): void {
		const record = this.#store.recordUsageSnapshots;
		if (!record || report.limits.length === 0) return;
		const recordedAt = Number.isFinite(report.fetchedAt) && report.fetchedAt > 0 ? report.fetchedAt : Date.now();
		const accountKey = this.#buildUsageCacheIdentity(request.credential);
		const metadata = report.metadata ?? {};
		const metaEmail = typeof metadata.email === "string" ? metadata.email : undefined;
		const metaAccountId = typeof metadata.accountId === "string" ? metadata.accountId : undefined;
		const entries: UsageHistoryEntry[] = report.limits.map(limit => ({
			recordedAt,
			provider: request.provider,
			accountKey,
			email: request.credential.email ?? metaEmail,
			accountId: request.credential.accountId ?? limit.scope.accountId ?? metaAccountId,
			limitId: limit.id,
			label: limit.label,
			windowLabel: limit.window?.label ?? limit.scope.windowId,
			usedFraction: resolveUsedFraction(limit),
			status: limit.status,
			resetsAt: limit.window?.resetsAt,
		}));
		try {
			record.call(this.#store, entries);
		} catch (error) {
			this.#usageLogger?.debug("usage history record failed", {
				provider: request.provider,
				error: String(error),
			});
		}
	}

	/**
	 * Recorded usage-limit snapshots, oldest first. Empty when the underlying
	 * store has no durable history (e.g. a broker-backed remote store).
	 */
	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.#store.listUsageHistory?.(query) ?? [];
	}

	/** Record one observed provider request cost for later local usage aggregation. */
	recordUsageCost(
		provider: Provider,
		costUsd: number,
		options?: { sessionId?: string; recordedAt?: number; baseUrl?: string },
	): boolean {
		if (!Number.isFinite(costUsd) || costUsd <= 0) return false;
		const record = this.#store.recordUsageCosts;
		if (!record) return false;
		const credential = this.#resolveObservedUsageCredential(provider, options?.sessionId);
		if (!credential) return false;
		const entry: UsageCostHistoryEntry = {
			recordedAt: options?.recordedAt ?? Date.now(),
			provider,
			accountKey: this.#buildUsageCacheIdentity(credential),
			costUsd,
		};
		try {
			record.call(this.#store, [entry]);
			const cacheKey = this.#buildUsageReportCacheKey({
				provider,
				credential,
				baseUrl: options?.baseUrl,
			});
			const existing = this.#usageCache.getStale<UsageReport | null>(cacheKey);
			this.#usageCache.set(cacheKey, { value: existing?.value ?? null, expiresAt: Date.now() - 1 });
			return true;
		} catch (error) {
			this.#usageLogger?.debug("usage cost record failed", {
				provider,
				error: String(error),
			});
			return false;
		}
	}

	#resolveObservedUsageCredential(provider: Provider, sessionId?: string): UsageCredential | undefined {
		const entries = this.#getStoredCredentials(provider);
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		if (sessionCredential) {
			const credential = entries[sessionCredential.index]?.credential;
			if (credential) {
				return credential.type === "api_key"
					? { type: "api_key", apiKey: credential.key }
					: this.#buildUsageCredential(credential);
			}
		}
		if (entries.length === 1) {
			const credential = entries[0]!.credential;
			return credential.type === "api_key"
				? { type: "api_key", apiKey: credential.key }
				: this.#buildUsageCredential(credential);
		}
		const envKey = getEnvApiKey(provider);
		if (envKey) return { type: "api_key", apiKey: envKey };
		return undefined;
	}

	ingestUsageHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string },
	): boolean {
		if (this.#fetchUsageReportsOverride || this.#store.fetchUsageReports) return false;

		const credential = this.#resolveActiveOAuthCredential(provider, options?.sessionId);
		if (!credential) return false;

		const cacheKey = this.#buildUsageReportCacheKey(
			this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
		);
		const now = Date.now();
		const last = this.#usageHeaderIngestAt.get(cacheKey);
		if (last !== undefined && now - last < USAGE_HEADER_INGEST_INTERVAL_MS) return false;

		const parsedReport = this.#usageProviderResolver?.(provider)?.parseRateLimitHeaders?.(headers, now);
		if (!parsedReport) return false;
		const metadata: Record<string, unknown> = { ...(parsedReport.metadata ?? {}) };
		if (credential.accountId && metadata.accountId === undefined) metadata.accountId = credential.accountId;
		if (credential.email && metadata.email === undefined) metadata.email = credential.email;
		if (credential.projectId && metadata.projectId === undefined) metadata.projectId = credential.projectId;
		const report: UsageReport = { ...parsedReport, metadata };

		const prior = this.#usageCache.getStale<UsageReport | null>(cacheKey)?.value;
		let merged = report;
		if (prior && Array.isArray(prior.limits)) {
			const headerLimitsById = new Map(report.limits.map(limit => [limit.id, limit]));
			const limits: UsageLimit[] = [];
			for (const limit of prior.limits) {
				const replacement = headerLimitsById.get(limit.id);
				if (replacement) {
					limits.push(replacement);
					headerLimitsById.delete(limit.id);
				} else {
					limits.push(limit);
				}
			}
			for (const limit of headerLimitsById.values()) {
				limits.push(limit);
			}
			merged = {
				...prior,
				fetchedAt: now,
				limits,
				metadata: {
					...(report.metadata ?? {}),
					...(prior.metadata ?? {}),
					headersUpdatedAt: now,
				},
			};
		}

		this.#usageCache.set(cacheKey, { value: merged, expiresAt: now + USAGE_REPORT_TTL_MS });
		this.#usageHeaderIngestAt.set(cacheKey, now);
		return true;
	}

	#collectUsageRequests(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
	}): UsageRequestDescriptor[] {
		const resolver = this.#usageProviderResolver;
		if (!resolver) return [];

		const requests: UsageRequestDescriptor[] = [];
		const providers = new Set<string>([
			...this.#data.keys(),
			...DEFAULT_USAGE_PROVIDERS.map(provider => provider.id),
		]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			const providerImpl = resolver(provider);
			if (!providerImpl) continue;
			const baseUrl = options?.baseUrlResolver?.(provider);
			let entries = this.#getStoredCredentials(providerId);
			if (entries.length > 0) {
				const dedupedEntries = this.#pruneDuplicateStoredCredentials(providerId, entries);
				if (dedupedEntries.length !== entries.length) {
					this.#setStoredCredentials(providerId, dedupedEntries);
				}
				entries = dedupedEntries;
			}

			if (entries.length === 0) {
				const runtimeKey = this.#runtimeOverrides.get(providerId);
				const envKey = getEnvApiKey(providerId);
				const apiKey = runtimeKey ?? envKey;
				if (!apiKey) continue;
				const request = this.#buildUsageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			for (const entry of entries) {
				const credential = entry.credential;
				const request =
					credential.type === "api_key"
						? this.#buildUsageRequest(provider, { type: "api_key", apiKey: credential.key }, baseUrl)
						: this.#buildUsageRequestForOauth(provider, credential, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
			}
		}

		return requests;
	}

	#getUsageReportMetadataValue(report: UsageReport, key: string): string | undefined {
		const metadata = report.metadata;
		if (!metadata || typeof metadata !== "object") return undefined;
		const value = metadata[key];
		return typeof value === "string" ? value.trim() : undefined;
	}

	#getUsageReportScopeAccountId(report: UsageReport): string | undefined {
		const ids = new Set<string>();
		for (const limit of report.limits) {
			const accountId = limit.scope.accountId?.trim();
			if (accountId) ids.add(accountId);
		}
		if (ids.size === 1) return [...ids][0];
		return undefined;
	}

	#getUsageReportScopeProjectId(report: UsageReport): string | undefined {
		const ids = new Set<string>();
		for (const limit of report.limits) {
			const projectId = limit.scope.projectId?.trim();
			if (projectId) ids.add(projectId);
		}
		if (ids.size === 1) return [...ids][0];
		return undefined;
	}

	#getUsageReportIdentifiers(report: UsageReport): string[] {
		const identifiers: string[] = [];
		const email = this.#getUsageReportMetadataValue(report, "email");
		if (email) identifiers.push(`email:${email.toLowerCase()}`);
		if (report.provider === "openai-codex" || report.provider === "anthropic") {
			return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
		}
		const projectId =
			this.#getUsageReportMetadataValue(report, "projectId") ?? this.#getUsageReportScopeProjectId(report);
		// Only add project as a fallback when no email is available — two users
		// with different emails on the same GCP project must not merge.
		if (projectId && !email) identifiers.push(`project:${projectId}`);
		const accountId = this.#getUsageReportMetadataValue(report, "accountId");
		if (accountId) identifiers.push(`account:${accountId}`);
		const account = this.#getUsageReportMetadataValue(report, "account");
		if (account) identifiers.push(`account:${account}`);
		const user = this.#getUsageReportMetadataValue(report, "user");
		if (user) identifiers.push(`account:${user}`);
		const username = this.#getUsageReportMetadataValue(report, "username");
		if (username) identifiers.push(`account:${username}`);
		const scopeAccountId = this.#getUsageReportScopeAccountId(report);
		if (scopeAccountId) identifiers.push(`account:${scopeAccountId}`);
		return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
	}

	#mergeUsageReportGroup(reports: UsageReport[]): UsageReport {
		if (reports.length === 1) return reports[0];
		const sorted = [...reports].sort((a, b) => {
			const limitDiff = b.limits.length - a.limits.length;
			if (limitDiff !== 0) return limitDiff;
			return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
		});
		const base = sorted[0];
		const mergedLimits = [...base.limits];
		const limitIds = new Set(mergedLimits.map(limit => limit.id));
		const mergedMetadata: Record<string, unknown> = { ...(base.metadata ?? {}) };
		let fetchedAt = base.fetchedAt;

		for (const report of sorted.slice(1)) {
			fetchedAt = Math.max(fetchedAt, report.fetchedAt);
			for (const limit of report.limits) {
				if (!limitIds.has(limit.id)) {
					limitIds.add(limit.id);
					mergedLimits.push(limit);
				}
			}
			if (report.metadata) {
				for (const [key, value] of Object.entries(report.metadata)) {
					if (mergedMetadata[key] === undefined) {
						mergedMetadata[key] = value;
					}
				}
			}
		}

		return {
			...base,
			fetchedAt,
			limits: mergedLimits,
			metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
		};
	}

	#dedupeUsageReports(reports: UsageReport[]): UsageReport[] {
		const groups: UsageReport[][] = [];
		const idToGroup = new Map<string, number>();

		for (const report of reports) {
			const identifiers = this.#getUsageReportIdentifiers(report);
			let groupIndex: number | undefined;
			for (const identifier of identifiers) {
				const existing = idToGroup.get(identifier);
				if (existing !== undefined) {
					groupIndex = existing;
					break;
				}
			}
			if (groupIndex === undefined) {
				groupIndex = groups.length;
				groups.push([]);
			}
			groups[groupIndex].push(report);
			for (const identifier of identifiers) {
				idToGroup.set(identifier, groupIndex);
			}
		}

		const deduped = groups.map(group => this.#mergeUsageReportGroup(group));
		if (deduped.length !== reports.length) {
			this.#usageLogger?.debug("Usage reports deduped", {
				before: reports.length,
				after: deduped.length,
			});
		}
		return deduped;
	}

	#isUsageLimitExhausted(limit: UsageLimit): boolean {
		if (limit.status === "exhausted") return true;
		const amount = limit.amount;
		if (amount.usedFraction !== undefined && amount.usedFraction >= 1) return true;
		if (amount.remainingFraction !== undefined && amount.remainingFraction <= 0) return true;
		if (amount.used !== undefined && amount.limit !== undefined && amount.used >= amount.limit) return true;
		if (amount.remaining !== undefined && amount.remaining <= 0) return true;
		if (amount.unit === "percent" && amount.used !== undefined && amount.used >= 100) return true;
		return false;
	}

	/** Return the usage limits that apply to the requested model for this strategy. */
	#getScopedUsageLimits(
		strategy: CredentialRankingStrategy,
		report: UsageReport,
		context: CredentialRankingContext,
	): UsageLimit[] {
		return strategy.scopeLimits?.(report, context) ?? report.limits;
	}

	/** Returns true if usage indicates rate limit has been reached. */
	#isUsageLimitReached(limits: UsageLimit[]): boolean {
		return limits.some(limit => this.#isUsageLimitExhausted(limit));
	}

	/** Extracts the earliest reset timestamp from exhausted windows (in ms). */
	#getUsageResetAtMs(limits: UsageLimit[], nowMs: number): number | undefined {
		const candidates: number[] = [];
		for (const limit of limits) {
			if (!this.#isUsageLimitExhausted(limit)) continue;
			const window = limit.window;
			if (window?.resetsAt && window.resetsAt > nowMs) {
				candidates.push(window.resetsAt);
			}
		}
		if (candidates.length === 0) return undefined;
		return Math.min(...candidates);
	}

	async #getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		// Store-level hook (e.g. `RemoteAuthCredentialStore`) is authoritative
		// when present: the broker already aggregates usage from a less-throttled
		// IP, and falling back to the local per-credential fetch would defeat the
		// whole point of routing through it.
		const storeHook = this.#store.getUsageReport?.bind(this.#store);
		if (storeHook) {
			return storeHook(provider, credential, options?.signal);
		}
		return this.#fetchUsageCached(
			this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
			options?.timeoutMs ?? this.#usageRequestTimeoutMs,
		);
	}

	/**
	 * The {@link UsageProvider} registered for `provider`, or undefined when the
	 * provider has no usage endpoint at all. Lets callers tell "a credential we
	 * could have fetched usage for but didn't" apart from "a provider with no
	 * usage concept" (web-search keys, local/keyless servers, inference
	 * providers without a usage API) — the latter never warrants a usage row.
	 */
	usageProviderFor(provider: Provider): UsageProvider | undefined {
		return this.#usageProviderResolver?.(provider);
	}

	async fetchUsageReports(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
		/** Caller's cancel signal; only rejects this caller, never the shared upstream fetch. */
		signal?: AbortSignal;
	}): Promise<UsageReport[] | null> {
		// Caller override > store-level hook > local per-credential fan-out.
		// `RemoteAuthCredentialStore` implements the store hook so a gateway
		// backed by a broker automatically routes usage to the broker without
		// needing the caller to wire it explicitly.
		const override = this.#fetchUsageReportsOverride ?? this.#store.fetchUsageReports?.bind(this.#store);
		if (override) {
			// Reuse the in-flight map so concurrent callers (widget poll + format
			// dispatch + credential selection) coalesce into one upstream call.
			// Each caller's `signal` only cancels THAT caller's await; the
			// shared upstream fetch runs to completion so peers aren't punished.
			const OVERRIDE_KEY = "__override__";
			let shared = this.#usageReportsInFlight.get(OVERRIDE_KEY);
			if (!shared) {
				// Don't forward the caller signal into the shared fetch — first caller's
				// abort would otherwise cancel the upstream for every peer.
				shared = override().finally(() => {
					this.#usageReportsInFlight.delete(OVERRIDE_KEY);
				});
				this.#usageReportsInFlight.set(OVERRIDE_KEY, shared);
			}
			return raceUsageWithSignal(shared, options?.signal);
		}
		if (!this.#usageProviderResolver) return null;

		const requests = this.#collectUsageRequests(options);
		if (requests.length === 0) return [];

		this.#usageLogger?.debug("Usage fetch requested", {
			providers: [...new Set(requests.map(request => request.provider))].sort(),
		});

		// Per-credential caching with jitter lives in #fetchUsageCached, so we
		// don't store the aggregated result here — doing so locks the widget to
		// a single decorrelation snapshot for 30s, defeating the jitter (some
		// accounts can be missing from one fetch and present in the next; the
		// aggregate cache freezes whichever set landed first).
		const cacheKey = this.#buildUsageReportsCacheKey(requests);

		const inFlight = this.#usageReportsInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const promise = (async () => {
			for (const request of requests) {
				this.#usageLogger?.debug("Usage fetch queued", {
					provider: request.provider,
					credentialType: request.credential.type,
					baseUrl: request.baseUrl,
					accountId: request.credential.accountId,
					email: request.credential.email,
				});
			}

			const results = await Promise.all(
				requests.map(request => this.#fetchUsageCached(request, this.#usageRequestTimeoutMs)),
			);
			const reports = results.filter((report): report is UsageReport => report !== null);
			const deduped = this.#dedupeUsageReports(reports);
			// no outer cache write — see comment above.
			const resolved = deduped;
			this.#usageLogger?.debug("Usage fetch resolved", {
				reports: resolved.map(report => {
					const accountLabel =
						this.#getUsageReportMetadataValue(report, "email") ??
						this.#getUsageReportMetadataValue(report, "accountId") ??
						this.#getUsageReportMetadataValue(report, "account") ??
						this.#getUsageReportMetadataValue(report, "user") ??
						this.#getUsageReportMetadataValue(report, "username") ??
						this.#getUsageReportScopeAccountId(report);
					return {
						provider: report.provider,
						limits: report.limits.length,
						account: accountLabel,
					};
				}),
			});
			return resolved;
		})().finally(() => {
			this.#usageReportsInFlight.delete(cacheKey);
		});

		this.#usageReportsInFlight.set(cacheKey, promise);
		return promise;
	}

	/**
	 * Probe each stored credential against its provider's auth-verifying usage
	 * endpoint and report per-credential auth health.
	 *
	 * Surfaces the identity of failing credentials so callers running a
	 * multi-account pool (e.g. a broker-backed auth-gateway) can tell which
	 * row is producing 401s. The probe mirrors the per-credential fan-out
	 * inside {@link AuthStorage.fetchUsageReports} (OAuth refresh-on-expiry,
	 * then `UsageProvider.fetchUsage`) but does NOT swallow errors — every
	 * credential gets either `ok: true`, `ok: false` with `reason`, or
	 * `ok: null` when no probe is configured for the provider.
	 *
	 * Iterates sequentially to avoid synchronized N-account fan-out that
	 * upstream `/usage` rate limiters (per source IP) treat as a burst.
	 *
	 * Only inspects active rows from {@link AuthCredentialStore.listAuthCredentials};
	 * soft-disabled rows are already known-bad and don't need a network probe.
	 * Environment-variable API keys are not enumerated — the caller's intent
	 * here is "which of my stored credentials is broken".
	 *
	 * Pass {@link CheckCredentialsOptions.completionProbe} to additionally
	 * exercise each credential against the provider's chat-completion endpoint
	 * (strict mode). The result lands on
	 * {@link CredentialHealthResult.completion}; the usage `ok` field is
	 * unchanged so callers can tell the two signals apart.
	 */
	async checkCredentials(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		options?.signal?.throwIfAborted();
		const stored = this.#store.listAuthCredentials();
		const resolver = this.#usageProviderResolver;
		const timeoutMs = options?.timeoutMs ?? this.#usageRequestTimeoutMs;
		const completionProbe = options?.completionProbe;
		const completionTimeoutMs = options?.completionTimeoutMs ?? timeoutMs;
		const ctx: UsageFetchContext = {
			fetch: this.#usageFetch,
			logger: this.#usageLogger,
			listUsageCosts: query => this.#store.listUsageCosts?.(query) ?? [],
		};

		const results: CredentialHealthResult[] = [];
		for (const row of stored) {
			options?.signal?.throwIfAborted();
			const base: CredentialHealthResult = {
				id: row.id,
				provider: row.provider,
				type: row.credential.type,
				ok: null,
			};
			if (row.credential.type === "oauth") {
				if (row.credential.email) base.email = row.credential.email;
				if (row.credential.accountId) base.accountId = row.credential.accountId;
				if (row.credential.refresh === REMOTE_REFRESH_SENTINEL) base.remoteRefresh = true;
			}

			const baseUrl = options?.baseUrlResolver?.(row.provider as Provider);
			const cred = row.credential;
			const initialRequest: UsageRequestDescriptor =
				cred.type === "api_key"
					? this.#buildUsageRequest(row.provider as Provider, { type: "api_key", apiKey: cred.key }, baseUrl)
					: this.#buildUsageRequestForOauth(row.provider as Provider, cred, baseUrl);

			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const probeSignal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
			let params: UsageFetchParams & { signal: AbortSignal } = {
				...initialRequest,
				accountKey: this.#buildUsageCacheIdentity(initialRequest.credential),
				signal: probeSignal,
			};
			let refreshError: string | undefined;

			// Refresh expired OAuth before probing — without this an expired access
			// token reports as `false` when the credential is actually healthy
			// (broker would happily refresh it on the next real request). The
			// refreshed bytes feed BOTH the usage probe and the optional
			// completion probe; we do it up-front so it runs even when no
			// `UsageProvider` is registered for this provider.
			if (
				cred.type === "oauth" &&
				initialRequest.credential.type === "oauth" &&
				initialRequest.credential.expiresAt !== undefined &&
				Date.now() >= initialRequest.credential.expiresAt
			) {
				const refreshable = this.#buildRefreshableOauthCredential(initialRequest.credential);
				if (refreshable) {
					try {
						const refreshed = await this.#refreshOAuthCredential(
							row.provider as Provider,
							refreshable,
							row.id,
							probeSignal,
						);
						const refreshedCredential = this.#mergeRefreshedUsageCredential(initialRequest.credential, refreshed);
						this.#persistRefreshedUsageCredential(
							row.provider as Provider,
							initialRequest.credential,
							refreshedCredential,
						);
						params = {
							...params,
							credential: refreshedCredential,
							accountKey: this.#buildUsageCacheIdentity(refreshedCredential),
						};
					} catch (error) {
						refreshError = `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
			}

			if (refreshError) {
				base.ok = false;
				base.reason = refreshError;
				// Refresh failed → the access token is unusable. Skip both probes;
				// they would only re-surface the same upstream failure.
				results.push(base);
				continue;
			}

			const providerImpl = resolver?.(row.provider as Provider);
			if (!providerImpl) {
				base.reason = `no usage probe configured for provider ${row.provider}`;
			} else if (providerImpl.supports && !providerImpl.supports(initialRequest)) {
				base.reason = `usage probe does not support ${cred.type} credentials for ${row.provider}`;
			} else if (providerImpl.validatesCredentials === false) {
				base.reason = `usage probe for ${row.provider} does not validate credentials`;
			} else {
				try {
					const report = await providerImpl.fetchUsage(params, ctx);
					if (report === null) {
						base.reason = "usage probe returned no data for this credential";
					} else {
						base.ok = true;
						const accountId = this.#getUsageReportMetadataValue(report, "accountId");
						const email = this.#getUsageReportMetadataValue(report, "email");
						if (accountId) base.accountId = accountId;
						if (email) base.email = email;
						const { raw: _raw, ...trimmed } = report;
						base.report = trimmed;
					}
				} catch (error) {
					base.ok = false;
					base.reason = error instanceof Error ? error.message : String(error);
				}
			}

			if (completionProbe) {
				const probeCred = this.#buildCompletionProbeCredential(params.credential);
				if (!probeCred) {
					base.completion = {
						ok: null,
						reason: `no bearer bytes available for ${row.credential.type} credential`,
					};
				} else {
					const completionTimeoutSignal = AbortSignal.timeout(completionTimeoutMs);
					const completionSignal = options?.signal
						? AbortSignal.any([options.signal, completionTimeoutSignal])
						: completionTimeoutSignal;
					try {
						base.completion = await completionProbe({
							provider: row.provider as Provider,
							credentialId: row.id,
							credential: probeCred,
							signal: completionSignal,
						});
					} catch (error) {
						base.completion = {
							ok: false,
							reason: error instanceof Error ? error.message : String(error),
						};
					}
				}
			}

			results.push(base);
		}

		return results;
	}

	/**
	 * Marks the current session's credential as temporarily blocked due to usage limits.
	 * Uses usage reports to determine accurate reset time when available.
	 * Returns whether a sibling credential is available now; when none is, also
	 * reports the earliest time a blocked sibling becomes available again so
	 * callers can wait for the sibling instead of the provider's full window.
	 */
	async markUsageLimitReached(
		provider: string,
		sessionId: string | undefined,
		options?: { retryAfterMs?: number; baseUrl?: string; modelId?: string; signal?: AbortSignal },
	): Promise<UsageLimitMarkResult> {
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		if (!sessionCredential) return { switched: false };

		const providerKey = this.#getProviderTypeKey(provider, sessionCredential.type);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy?.blockScope?.(rankingContext);
		const now = Date.now();
		let blockedUntil = now + (options?.retryAfterMs ?? AuthStorage.#defaultBackoffMs);

		if (sessionCredential.type === "oauth" && strategy) {
			const credential = this.#getCredentialsForProvider(provider)[sessionCredential.index];
			if (credential?.type === "oauth") {
				const report = await this.#getUsageReport(provider, credential, options);
				if (report) {
					const scopedLimits = this.#getScopedUsageLimits(strategy, report, rankingContext);
					if (this.#isUsageLimitReached(scopedLimits)) {
						const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
						if (resetAtMs && resetAtMs > blockedUntil) {
							blockedUntil = resetAtMs;
						}
					}
				}
			}
		}

		this.#markCredentialBlocked(providerKey, sessionCredential.index, blockedUntil, blockScope);

		const remainingCredentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: AuthCredential; index: number } =>
					entry.credential.type === sessionCredential.type && entry.index !== sessionCredential.index,
			);

		let retryAtMs: number | undefined;
		for (const candidate of remainingCredentials) {
			const candidateBlockedUntil = this.#getCredentialBlockedUntil(providerKey, candidate.index, blockScope);
			if (candidateBlockedUntil === undefined) return { switched: true };
			if (retryAtMs === undefined || candidateBlockedUntil < retryAtMs) retryAtMs = candidateBlockedUntil;
		}
		return { switched: false, retryAtMs };
	}

	#resolveWindowResetAt(window: UsageLimit["window"]): number | undefined {
		if (!window) return undefined;
		if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
			return window.resetsAt;
		}
		return undefined;
	}

	#normalizeUsageFraction(limit: UsageLimit | undefined): number {
		const usedFraction = limit?.amount.usedFraction;
		if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction)) {
			return 0.5;
		}
		return Math.min(Math.max(usedFraction, 0), 1);
	}

	/** Computes `usedFraction / elapsedHours` — consumption rate per hour within the current window. Lower drain rate = less pressure = preferred. */
	#computeWindowDrainRate(limit: UsageLimit | undefined, nowMs: number, fallbackDurationMs: number): number {
		const usedFraction = this.#normalizeUsageFraction(limit);
		const durationMs = limit?.window?.durationMs ?? fallbackDurationMs;
		if (!Number.isFinite(durationMs) || durationMs <= 0) {
			return usedFraction;
		}
		const resetAt = this.#resolveWindowResetAt(limit?.window);
		if (!Number.isFinite(resetAt)) {
			return usedFraction;
		}
		const remainingWindowMs = (resetAt as number) - nowMs;
		const clampedRemainingWindowMs = Math.min(Math.max(remainingWindowMs, 0), durationMs);
		const elapsedMs = durationMs - clampedRemainingWindowMs;
		if (elapsedMs <= 0) {
			return usedFraction;
		}
		const elapsedHours = elapsedMs / (60 * 60 * 1000);
		if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
			return usedFraction;
		}
		return usedFraction / elapsedHours;
	}

	#compareRankedOAuthCandidatePriority(
		left: RankedOAuthCandidate,
		right: RankedOAuthCandidate,
		provider: string,
		modelId: string | undefined,
	): number {
		if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
		if (left.blocked && right.blocked) {
			const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
			const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
			if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
			return 0;
		}
		if (requiresOpenAICodexProModel(provider, modelId) && left.planPriority !== right.planPriority) {
			return left.planPriority - right.planPriority;
		}
		if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
		let metric = compareUsageRankingMetric(left.secondaryDrainRate, right.secondaryDrainRate);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(left.secondaryUsed, right.secondaryUsed);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(left.primaryDrainRate, right.primaryDrainRate);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(left.primaryUsed, right.primaryUsed);
		if (metric !== 0) return metric;
		return 0;
	}

	#compareRankedOAuthCandidates(
		left: RankedOAuthCandidate,
		right: RankedOAuthCandidate,
		provider: string,
		modelId: string | undefined,
	): number {
		const priority = this.#compareRankedOAuthCandidatePriority(left, right, provider, modelId);
		return priority !== 0 ? priority : left.orderPos - right.orderPos;
	}

	#orderRankedOAuthCandidates(
		candidates: RankedOAuthCandidate[],
		sessionId: string | undefined,
		provider: string,
		modelId: string | undefined,
	): OAuthCandidate[] {
		candidates.sort((left, right) => this.#compareRankedOAuthCandidates(left, right, provider, modelId));
		if (!sessionId) {
			return candidates.map(candidate => ({
				selection: candidate.selection,
				usage: candidate.usage,
				usageChecked: candidate.usageChecked,
			}));
		}

		const unblocked = candidates.filter(candidate => !candidate.blocked);
		if (unblocked.length <= 1) {
			return candidates.map(candidate => ({
				selection: candidate.selection,
				usage: candidate.usage,
				usageChecked: candidate.usageChecked,
			}));
		}

		const priorityByCandidate = new Map<RankedOAuthCandidate, number>();
		let bucketIndex = 0;
		let previous = unblocked[0];
		const bucketByCandidate = new Map<RankedOAuthCandidate, number>();
		for (const candidate of unblocked) {
			if (
				candidate !== previous &&
				this.#compareRankedOAuthCandidatePriority(previous, candidate, provider, modelId) !== 0
			) {
				bucketIndex += 1;
			}
			bucketByCandidate.set(candidate, bucketIndex);
			previous = candidate;
		}
		const maxBucket = bucketIndex;
		for (const candidate of unblocked) {
			const bucket = bucketByCandidate.get(candidate) ?? 0;
			priorityByCandidate.set(candidate, maxBucket === 0 ? 0 : 1 - bucket / maxBucket);
		}

		let totalWeight = 0;
		for (const candidate of unblocked) {
			totalWeight += 1 + (priorityByCandidate.get(candidate) ?? 0);
		}

		const hit = ((Bun.hash.xxHash32(sessionId) >>> 0) / 2 ** 32) * totalWeight;
		let cursor = 0;
		let selected = unblocked[unblocked.length - 1];
		for (const candidate of unblocked) {
			cursor += 1 + (priorityByCandidate.get(candidate) ?? 0);
			if (hit < cursor) {
				selected = candidate;
				break;
			}
		}

		const ordered = [
			selected,
			...unblocked.filter(candidate => candidate !== selected),
			...candidates.filter(candidate => candidate.blocked),
		];
		return ordered.map(candidate => ({
			selection: candidate.selection,
			usage: candidate.usage,
			usageChecked: candidate.usageChecked,
		}));
	}

	async #rankOAuthSelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		credentials: OAuthSelection[];
		options?: AuthApiKeyOptions;
		sessionId?: string;
		strategy: CredentialRankingStrategy;
		rankingContext: CredentialRankingContext;
		blockScope?: string;
	}): Promise<OAuthCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedOAuthCandidate[] = [];
		// Pre-fetch usage reports in parallel for non-blocked credentials.
		// Wrap with a timeout so slow/429'd fetches don't indefinitely block
		// credential selection — better to pick a credential without usage data
		// than to hang the agent waiting for rate-limited usage endpoints.
		const usageTimeout = Math.max(5000, this.#usageRequestTimeoutMs * 1.5);
		const usagePromise = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#getCredentialBlockedUntil(args.providerKey, selection.index, args.blockScope);
				if (blockedUntil !== undefined) return { selection, usage: null, usageChecked: false, blockedUntil };
				const usage = await this.#getUsageReport(args.provider, selection.credential, {
					...args.options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				return { selection, usage, usageChecked: true, blockedUntil: undefined as number | undefined };
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		// `Bun.sleep` keeps the event loop alive even after Promise.race resolves,
		// which leaks a 7.5–15s timer per credential-selection call. Use an unref'd
		// timer so the timeout doesn't pin the process and clear it on the happy
		// path so memory drops immediately.
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			return (
				result ??
				args.order.map(idx => {
					const selection = args.credentials[idx];
					return selection ? { selection, usage: null, usageChecked: false, blockedUntil: undefined } : null;
				})
			);
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage ? this.#getScopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && scopedLimits && this.#isUsageLimitReached(scopedLimits)) {
				const resetAtMs = this.#getUsageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs;
				this.#markCredentialBlocked(args.providerKey, selection.index, blockedUntil, args.blockScope);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const secondaryTarget = secondary ?? primary;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary) ?? false,
				planPriority: getOpenAICodexPlanPriority(usage),
				secondaryUsed: this.#normalizeUsageFraction(secondaryTarget),
				secondaryDrainRate: this.#computeWindowDrainRate(
					secondaryTarget,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: this.#normalizeUsageFraction(primary),
				primaryDrainRate: this.#computeWindowDrainRate(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return this.#orderRankedOAuthCandidates(ranked, args.sessionId, args.provider, args.options?.modelId);
	}

	/**
	 * Resolves an OAuth credential, trying credentials in priority order.
	 * Skips blocked credentials and checks usage limits for providers with usage data.
	 * Falls back to earliest-unblocking credential if all are blocked.
	 *
	 * Returns both the API key bytes for outbound requests AND the refreshed
	 * {@link OAuthCredential} so callers needing identity metadata (account id,
	 * project id, etc.) do not have to dereference the snapshot themselves.
	 */
	async #resolveOAuthSelection(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthResolutionResult | undefined> {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: OAuthCredential; index: number } => entry.credential.type === "oauth");

		if (credentials.length === 0) return undefined;

		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy?.blockScope?.(rankingContext);
		const requiresProModel = requiresOpenAICodexProModel(provider, options?.modelId);
		const checkUsage = strategy !== undefined && (credentials.length > 1 || requiresProModel);
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		// Skip ranking only when the session already has a working preferred credential — re-ranking
		// mid-session causes account switches that cold-start the server-side prompt cache. New sessions
		// (no preference) and sessions whose preferred is blocked still rank, so we pick the account
		// with the most headroom proactively and fall back intelligently when rate-limited.
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined &&
			!this.#isCredentialBlocked(providerKey, sessionPreferredIndex, blockScope);
		const shouldRank = checkUsage && (!sessionPreferredIsAvailable || requiresProModel);
		const rankingOrder = shouldRank && sessionId ? credentials.map((_credential, index) => index) : order;
		const candidates = shouldRank
			? await this.#rankOAuthSelections({
					providerKey,
					provider,
					order: rankingOrder,
					credentials,
					options,
					sessionId,
					strategy: strategy!,
					rankingContext,
					blockScope,
				})
			: order
					.map(idx => credentials[idx])
					.filter((selection): selection is { credential: OAuthCredential; index: number } => Boolean(selection))
					.map(selection => ({ selection, usage: null, usageChecked: false }));

		if (sessionPreferredIndex !== undefined && !requiresProModel) {
			const sessionPreferredCandidate = candidates.findIndex(
				candidate =>
					!this.#isCredentialBlocked(providerKey, candidate.selection.index, blockScope) &&
					candidate.selection.index === sessionPreferredIndex,
			);
			if (sessionPreferredCandidate > 0) {
				const [preferred] = candidates.splice(sessionPreferredCandidate, 1);
				candidates.unshift(preferred);
			}
		}
		// Step (b) of the auth-retry policy: when `forceRefresh` is set, re-mint
		// the session-preferred credential (or the first candidate when no
		// session preference exists yet) even if its cached token still looks
		// valid — a peer/broker may have rotated it out from under us.
		const forceRefreshIndex = options?.forceRefresh
			? (sessionPreferredIndex ?? candidates[0]?.selection.index)
			: undefined;
		await Promise.all(
			candidates.map(async candidate => {
				const force = forceRefreshIndex !== undefined && candidate.selection.index === forceRefreshIndex;
				const initialCredentialId = this.#getStoredCredentials(provider)[candidate.selection.index]?.id;
				let syncedPeerCredential = false;
				if (initialCredentialId !== undefined) {
					const beforeSync = candidate.selection.credential;
					if (!this.#syncOAuthSelectionFromStore(provider, candidate.selection, initialCredentialId)) return;
					syncedPeerCredential = !authCredentialEquals(beforeSync, candidate.selection.credential);
				}
				const hasFreshAccess = Date.now() + OAUTH_REFRESH_SKEW_MS < candidate.selection.credential.expires;
				if ((!force || syncedPeerCredential) && hasFreshAccess) return;
				const latestCredential = this.#getCredentialsForProvider(provider)[candidate.selection.index];
				if (
					!force &&
					latestCredential?.type === "oauth" &&
					Date.now() + OAUTH_REFRESH_SKEW_MS < latestCredential.expires
				) {
					candidate.selection.credential = latestCredential;
					return;
				}
				try {
					const credentialId = this.#getStoredCredentials(provider)[candidate.selection.index]?.id;
					// Hand #refreshOAuthCredential a stale clone (expires:0) so its
					// not-yet-expired short-circuit doesn't suppress the forced
					// re-mint; an in-flight peer refresh is still awaited via the
					// per-credential single-flight.
					const refreshTarget = force
						? { ...candidate.selection.credential, expires: 0 }
						: candidate.selection.credential;
					const refreshedCredentials = await this.#refreshOAuthCredential(
						provider,
						refreshTarget,
						credentialId,
						options?.signal,
					);
					const updated: OAuthCredential = {
						...candidate.selection.credential,
						...refreshedCredentials,
						type: "oauth",
					};
					candidate.selection.credential = updated;
					if (credentialId !== undefined) {
						const idx = this.#replaceCredentialById(provider, credentialId, updated);
						if (idx !== -1) candidate.selection.index = idx;
					} else {
						this.#replaceCredentialAt(provider, candidate.selection.index, updated);
					}
				} catch (error) {
					// Recovery for definitive failures (incl. peer rotation) lives in
					// #tryOAuthCredential; log instead of swallowing silently — a bare
					// catch here hid stale-refresh-token replays from concurrent
					// sessions (one-turn 401 "Invalid authentication credentials").
					logger.debug("OAuth preflight refresh failed", {
						provider,
						index: candidate.selection.index,
						error: String(error),
					});
				}
			}),
		);

		// Skip the Pro-plan filter when no candidate is confirmed Pro, so users with only
		// non-Pro accounts can still attempt Spark requests (e.g. trial/grandfathered access).
		const enforceProRequirement =
			requiresProModel && candidates.some(candidate => hasOpenAICodexProPlan(candidate.usage));

		const fallback = candidates[0];

		for (const candidate of candidates) {
			const resolved = await this.#tryOAuthCredential(
				provider,
				candidate.selection,
				providerKey,
				sessionId,
				options,
				{
					checkUsage,
					allowBlocked: false,
					prefetchedUsage: candidate.usage,
					usagePrechecked: candidate.usageChecked,
					enforceProRequirement,
					strategy,
					rankingContext,
					blockScope,
				},
			);
			if (resolved) return resolved;
		}

		if (fallback && this.#isCredentialBlocked(providerKey, fallback.selection.index, blockScope)) {
			return this.#tryOAuthCredential(provider, fallback.selection, providerKey, sessionId, options, {
				checkUsage,
				allowBlocked: true,
				prefetchedUsage: fallback.usage,
				usagePrechecked: fallback.usageChecked,
				enforceProRequirement,
				strategy,
				rankingContext,
				blockScope,
			});
		}

		return undefined;
	}

	async #refreshOAuthCredential(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		if (credentialId !== undefined) {
			const existing = this.#oauthCredentialRefreshInFlight.get(credentialId);
			if (existing) return raceCredentialRefreshWithSignal(existing, signal);
		}
		if (Date.now() + OAUTH_REFRESH_SKEW_MS < credential.expires) return credential;
		if (credentialId === undefined) {
			return this.#refreshOAuthCredentialUnshared(provider, credential, undefined, signal);
		}
		const promise = this.#refreshOAuthCredentialUnshared(provider, credential, credentialId).finally(() => {
			this.#oauthCredentialRefreshInFlight.delete(credentialId);
		});
		this.#oauthCredentialRefreshInFlight.set(credentialId, promise);
		return raceCredentialRefreshWithSignal(promise, signal);
	}

	async #refreshOAuthCredentialUnshared(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		let refreshPromise: Promise<OAuthCredentials>;
		// Caller override > store-level hook > local per-provider refresh.
		// `RemoteAuthCredentialStore` exposes the hook so a broker-backed gateway
		// routes refresh through the broker without explicit wiring.
		const storeRefresh = this.#store.refreshOAuthCredential?.bind(this.#store);
		const overrideRefresh = this.#refreshOAuthCredentialOverride ?? storeRefresh;
		if (overrideRefresh && credentialId !== undefined) {
			refreshPromise = overrideRefresh(provider, credentialId, credential, signal);
		} else {
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				if (!customProvider.refreshToken) {
					throw new AIError.OAuthError(`OAuth provider "${provider}" does not support token refresh`, {
						kind: "configuration",
						provider,
					});
				}
				refreshPromise = customProvider.refreshToken(credential);
			} else {
				refreshPromise = refreshOAuthToken(provider as OAuthProvider, credential);
			}
		}
		// Bound the refresh so a slow/hanging token endpoint cannot stall credential selection.
		// Caller-driven abort jumps the gun on the timeout — the agent's ESC must
		// take priority over the floor timeout.
		let timeout: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const cancellation = Promise.withResolvers<never>();
		timeout = setTimeout(
			() =>
				cancellation.reject(
					new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					}),
				),
			DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
		);
		if (signal) {
			if (signal.aborted) {
				cancellation.reject(new AIError.AbortError("OAuth token refresh aborted by caller"));
			} else {
				onAbort = () => cancellation.reject(new AIError.AbortError("OAuth token refresh aborted by caller"));
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		try {
			return await Promise.race([refreshPromise, cancellation.promise]);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	#syncOAuthSelectionFromStore(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		credentialId: number,
	): boolean {
		const latestRows = this.#store.listAuthCredentials(provider);
		this.#setStoredCredentials(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		const latestIndex = latestRows.findIndex(row => row.id === credentialId);
		if (latestIndex === -1) return false;
		const latest = latestRows[latestIndex];
		if (latest?.credential.type !== "oauth") return false;
		selection.index = latestIndex;
		selection.credential = latest.credential;
		return true;
	}

	async #prepareOAuthCredentialForRequest(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		options: AuthApiKeyOptions | undefined,
	): Promise<boolean> {
		const stored = this.#getStoredCredentials(provider);
		const selected = stored[selection.index];
		if (selected?.credential.type !== "oauth") return false;

		const prepare = this.#store.prepareForRequest?.bind(this.#store);
		if (prepare) {
			await prepare(selected.id, { signal: options?.signal });
		}
		return this.#syncOAuthSelectionFromStore(provider, selection, selected.id);
	}

	/** Attempts to use a single OAuth credential, checking usage and refreshing token. */
	async #tryOAuthCredential(
		provider: Provider,
		selection: { credential: OAuthCredential; index: number },
		providerKey: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		usageOptions: {
			checkUsage: boolean;
			allowBlocked: boolean;
			prefetchedUsage?: UsageReport | null;
			usagePrechecked?: boolean;
			enforceProRequirement?: boolean;
			strategy?: CredentialRankingStrategy;
			rankingContext?: CredentialRankingContext;
			blockScope?: string;
			/** When false, a definitive failure of THIS credential returns undefined instead of falling back to the ranked/round-robin selector (target-only resolution). */
			allowFallback?: boolean;
		},
	): Promise<OAuthResolutionResult | undefined> {
		const {
			checkUsage,
			allowBlocked,
			prefetchedUsage = null,
			usagePrechecked = false,
			enforceProRequirement,
			strategy,
			rankingContext,
			blockScope,
			allowFallback = true,
		} = usageOptions;
		if (!allowBlocked && this.#isCredentialBlocked(providerKey, selection.index, blockScope)) {
			return undefined;
		}

		if (!(await this.#prepareOAuthCredentialForRequest(provider, selection, options))) {
			return undefined;
		}
		// Capture the row id once, immediately after #prepareOAuthCredentialForRequest
		// resynced selection.index from the store. A concurrent disable during the
		// usage/refresh awaits below can shift positional indices, so every later
		// refresh / persist / CAS-disable addresses the row by this stable id.
		const credentialId = this.#getStoredCredentials(provider)[selection.index]?.id;

		const requiresProModel = requiresOpenAICodexProModel(provider, options?.modelId);
		const applyProFilter = enforceProRequirement ?? requiresProModel;
		let usage: UsageReport | null = null;
		let usageChecked = false;

		if ((checkUsage && !allowBlocked) || requiresProModel) {
			if (usagePrechecked) {
				usage = prefetchedUsage;
				usageChecked = true;
			} else {
				usage = await this.#getUsageReport(provider, selection.credential, {
					...options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				usageChecked = true;
			}
			if (applyProFilter && !hasOpenAICodexProPlan(usage)) {
				return undefined;
			}
			if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
				const scopedLimits = this.#getScopedUsageLimits(strategy, usage, rankingContext);
				if (this.#isUsageLimitReached(scopedLimits)) {
					const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
					this.#markCredentialBlocked(
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
						blockScope,
					);
					return undefined;
				}
			}
		}

		try {
			let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				const refreshedCredentials = await this.#refreshOAuthCredential(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const apiKey = customProvider.getApiKey
					? customProvider.getApiKey(refreshedCredentials)
					: refreshedCredentials.access;
				result = { newCredentials: refreshedCredentials, apiKey };
			} else {
				// Refresh first through the broker-aware single-flighted machinery
				// so transient failures surface as network errors (5-min temp block)
				// instead of `getOAuthApiKey`'s "expired" precondition error, which
				// the definitive-failure regex below would otherwise classify as
				// auth failure and soft-disable a still-valid credential.
				const refreshedCredentials = await this.#refreshOAuthCredential(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const oauthCreds: Record<string, OAuthCredentials> = {
					[provider]: refreshedCredentials,
				};
				result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
			}
			if (!result) return undefined;
			const updated: OAuthCredential = {
				type: "oauth",
				access: result.newCredentials.access,
				refresh: result.newCredentials.refresh,
				expires: result.newCredentials.expires,
				accountId: result.newCredentials.accountId ?? selection.credential.accountId,
				email: result.newCredentials.email ?? selection.credential.email,
				projectId: result.newCredentials.projectId ?? selection.credential.projectId,
				enterpriseUrl: result.newCredentials.enterpriseUrl ?? selection.credential.enterpriseUrl,
				apiEndpoint: result.newCredentials.apiEndpoint ?? selection.credential.apiEndpoint,
			};
			if (credentialId !== undefined) {
				const idx = this.#replaceCredentialById(provider, credentialId, updated);
				if (idx !== -1) selection.index = idx;
			} else {
				this.#replaceCredentialAt(provider, selection.index, updated);
			}
			if ((checkUsage && !allowBlocked) || requiresProModel) {
				const sameAccount = selection.credential.accountId === updated.accountId;
				if (!usageChecked || !sameAccount) {
					usage = await this.#getUsageReport(provider, updated, {
						...options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
				}
				if (applyProFilter && !hasOpenAICodexProPlan(usage)) {
					return undefined;
				}
				if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
					const scopedLimits = this.#getScopedUsageLimits(strategy, usage, rankingContext);
					if (this.#isUsageLimitReached(scopedLimits)) {
						const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
						this.#markCredentialBlocked(
							providerKey,
							selection.index,
							resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
							blockScope,
						);
						return undefined;
					}
				}
			}
			this.#recordSessionCredential(provider, sessionId, "oauth", selection.index);
			return { apiKey: result.apiKey, credential: updated };
		} catch (error) {
			const errorMsg = String(error);
			// Only remove credentials for definitive auth failures
			// Keep credentials for transient errors (network, 5xx) and block temporarily
			const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);

			logger.warn("OAuth token refresh failed", {
				provider,
				index: selection.index,
				error: errorMsg,
				isDefinitiveFailure,
			});

			if (isDefinitiveFailure) {
				// The credential at this index may have been rotated by another process between
				// our in-memory snapshot and the refresh attempt: Anthropic rotates refresh
				// tokens on every use, so the peer's success leaves our stored token invalid.
				// Re-read the row from disk before marking it disabled — if the persisted
				// refresh token has changed, the peer rotation succeeded and we should pick
				// up the new credential instead of soft-deleting the row that the peer just
				// updated.
				if (credentialId !== undefined) {
					const latestRow = this.#store.listAuthCredentials(provider).find(row => row.id === credentialId);
					const latestCredential = latestRow?.credential;
					if (latestCredential?.type === "oauth" && latestCredential.refresh !== selection.credential.refresh) {
						logger.debug("OAuth refresh race detected; another process rotated token first", {
							provider,
							index: selection.index,
							credentialId,
						});
						await this.reload();
						if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
					}
				}
				// Permanently disable invalid credentials with an explicit cause for inspection/debugging.
				// Use a CAS-style disable conditioned on the row still containing the stale credential
				// we tried to refresh, so a peer rotation that lands between the pre-check above and
				// this disable doesn't soft-delete the freshly-rotated row.
				const disabled =
					credentialId !== undefined
						? this.#disableCredentialByIdIfMatches(
								provider,
								credentialId,
								selection.credential,
								`oauth refresh failed: ${errorMsg}`,
							)
						: this.#tryDisableCredentialAtIfMatches(
								provider,
								selection.index,
								selection.credential,
								`oauth refresh failed: ${errorMsg}`,
							);
				if (!disabled) {
					logger.debug("OAuth refresh disable lost CAS; reloading after peer rotation", {
						provider,
						index: selection.index,
					});
					await this.reload();
					if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
				}
				if (this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth")) {
					if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
				}
			} else {
				// Block temporarily for transient failures (5 minutes)
				this.#markCredentialBlocked(providerKey, selection.index, Date.now() + 5 * 60 * 1000);
			}
		}

		return undefined;
	}

	/**
	 * Peek at API key for a provider without refreshing OAuth tokens.
	 * Used for model discovery where we only need to know if credentials exist
	 * and get a best-effort token. For GitHub Copilot we preserve enterprise
	 * routing metadata so discovery can hit the correct host.
	 */
	async peekApiKey(provider: string): Promise<string | undefined> {
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const configKey = this.#configOverrides.get(provider);
		if (configKey) {
			return configKey;
		}

		const apiKeySelection = this.#selectCredentialByType(provider, "api_key");
		if (apiKeySelection) {
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

		// Return current OAuth access token only if it is not already expired.
		const oauthSelection = this.#selectCredentialByType(provider, "oauth");
		if (oauthSelection) {
			const expiresAt = oauthSelection.credential.expires;
			if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
				if (provider === "github-copilot") {
					return JSON.stringify({
						token: oauthSelection.credential.access,
						enterpriseUrl: oauthSelection.credential.enterpriseUrl,
						apiEndpoint: oauthSelection.credential.apiEndpoint,
					});
				}
				return oauthSelection.credential.access;
			}
		}

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		return this.#fallbackResolver?.(provider) ?? undefined;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. Config override (models.yml `providers.<name>.apiKey`)
	 * 3. API key from storage
	 * 4. OAuth token from storage (auto-refreshed)
	 * 5. Environment variable
	 * 6. Fallback resolver (models.yml custom providers, last-resort)
	 */
	async getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		// Config override: explicit apiKey pinned in models.yml beats the broker's
		// OAuth credentials. The user redirected a provider at a custom baseUrl
		// (e.g. an auth-gateway) and supplied the bearer for that endpoint —
		// honor it instead of forwarding an upstream OAuth token that the proxy
		// won't accept.
		const configKey = this.#configOverrides.get(provider);
		if (configKey) {
			return configKey;
		}

		const apiKeySelection = this.#selectCredentialByType(provider, "api_key", sessionId);
		if (apiKeySelection) {
			this.#recordSessionCredential(provider, sessionId, "api_key", apiKeySelection.index);
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

		const oauthResolved = await this.#resolveOAuthSelection(provider, sessionId, options);
		if (oauthResolved) {
			return oauthResolved.apiKey;
		}

		// Fall back to environment variable or custom resolver. If we reach here after
		// an OAuth miss, the session sticky (if any) is stale — the request will
		// authenticate via env/fallback, not OAuth, so clear the sticky now so that
		// getOAuthAccountId() correctly suppresses account_uuid for this session.
		if (sessionId) this.#sessionLastCredential.get(provider)?.delete(sessionId);
		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		return this.#fallbackResolver?.(provider) ?? undefined;
	}

	/**
	 * Resolve the OAuth credential for `provider`, refreshing through the same
	 * pipeline as {@link AuthStorage.getApiKey} but returning the refreshed
	 * {@link OAuthAccess} (raw access token + identity metadata) instead of
	 * the API-key bytes.
	 *
	 * Use this when the caller needs to inject identity headers alongside the
	 * bearer (Codex `chatgpt-account-id`, Google `project`, GitHub
	 * `enterpriseUrl`). For pure "give me the bytes for `Authorization`"
	 * scenarios, prefer {@link AuthStorage.getApiKey}.
	 *
	 * Returns `undefined` when no OAuth credential is available, the
	 * credential fails to refresh, or runtime/config overrides have replaced
	 * OAuth with an explicit API key.
	 */
	async getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccess | undefined> {
		// Runtime / config overrides intentionally short-circuit OAuth: when the
		// user has pinned an API key, they expect the OAuth identity to be
		// suppressed (same contract as `getOAuthAccountId`).
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return undefined;
		}
		const resolved = await this.#resolveOAuthSelection(provider, sessionId, options);
		if (!resolved) return undefined;
		const { credential } = resolved;
		return {
			accessToken: credential.access,
			accountId: credential.accountId,
			email: credential.email,
			projectId: credential.projectId,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
		};
	}

	/** Stored OAuth credentials for `provider` in stable order, paired with their full-list index and row id. */
	#getStoredOAuthSelections(provider: string): StoredOAuthSelection[] {
		return this.#getStoredCredentials(provider)
			.map((entry, index) => ({ credentialId: entry.id, credential: entry.credential, index }))
			.filter((entry): entry is StoredOAuthSelection => entry.credential.type === "oauth");
	}

	/** Refresh one stored OAuth selection and shape it as an {@link OAuthAccessResolution}. */
	async #resolveStoredOAuthAccess(
		provider: string,
		selection: StoredOAuthSelection,
		providerKey: string,
		options: AuthApiKeyOptions | undefined,
	): Promise<OAuthAccessResolution> {
		try {
			const resolved = await this.#tryOAuthCredential(
				provider,
				{ credential: selection.credential, index: selection.index },
				providerKey,
				undefined,
				options,
				{ checkUsage: false, allowBlocked: true, allowFallback: false },
			);
			if (!resolved) {
				return {
					ok: false,
					credentialId: selection.credentialId,
					accountId: selection.credential.accountId,
					email: selection.credential.email,
					projectId: selection.credential.projectId,
					enterpriseUrl: selection.credential.enterpriseUrl,
					error: "OAuth access unavailable",
				};
			}
			const { credential } = resolved;
			return {
				ok: true,
				credentialId: selection.credentialId,
				accessToken: credential.access,
				accountId: credential.accountId,
				email: credential.email,
				projectId: credential.projectId,
				enterpriseUrl: credential.enterpriseUrl,
			};
		} catch (error) {
			return {
				ok: false,
				credentialId: selection.credentialId,
				accountId: selection.credential.accountId,
				email: selection.credential.email,
				projectId: selection.credential.projectId,
				enterpriseUrl: selection.credential.enterpriseUrl,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Read-only list of stored OAuth accounts for `provider` in stable storage
	 * order, WITHOUT refreshing any token. The array position (0-based) is the
	 * selector accepted by {@link AuthStorage.getOAuthAccessAt}; a "pick the Nth
	 * account" UI should render `position + 1`.
	 */
	listOAuthAccounts(provider: string): OAuthAccountSummary[] {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return [];
		}
		return this.#getStoredOAuthSelections(provider).map((selection, position) => ({
			position,
			credentialId: selection.credentialId,
			accountId: selection.credential.accountId,
			email: selection.credential.email,
			projectId: selection.credential.projectId,
			enterpriseUrl: selection.credential.enterpriseUrl,
		}));
	}

	/**
	 * Resolve every stored OAuth credential for `provider` independently.
	 *
	 * Refreshes credentials through the same broker/local path as
	 * {@link AuthStorage.getOAuthAccess}, but does not rank, round-robin, or
	 * stop after the first usable account. Intended for diagnostics that must
	 * exercise each stored account exactly once.
	 */
	async getOAuthAccesses(provider: string, options?: AuthApiKeyOptions): Promise<OAuthAccessResolution[]> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return [];
		}
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		return Promise.all(
			this.#getStoredOAuthSelections(provider).map(selection =>
				this.#resolveStoredOAuthAccess(provider, selection, providerKey, options),
			),
		);
	}

	/**
	 * Resolve a single stored OAuth credential by its account position (0-based,
	 * matching {@link AuthStorage.listOAuthAccounts}). Refreshes ONLY that
	 * credential ({@link #resolveStoredOAuthAccess} runs with `allowFallback:
	 * false`), so — unlike {@link AuthStorage.getOAuthAccesses} — a definitive
	 * failure of the targeted account surfaces as a failed resolution rather than
	 * silently rotating or rate-tripping a sibling.
	 *
	 * Returns `undefined` when `position` is out of range or runtime/config
	 * overrides have replaced OAuth with an explicit API key.
	 */
	async getOAuthAccessAt(
		provider: string,
		position: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return undefined;
		}
		const selection = this.#getStoredOAuthSelections(provider)[position];
		if (!selection) return undefined;
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		return this.#resolveStoredOAuthAccess(provider, selection, providerKey, options);
	}

	/**
	 * List saved rate-limit resets for every stored OAuth account of `provider`
	 * (Codex), fetched LIVE from the dedicated `rate-limit-reset-credits` route.
	 *
	 * This deliberately bypasses the usage-report cache: `/wham/usage` is
	 * IP-rate-limited and may serve stale (or pre-feature) snapshots when many
	 * accounts are polled, which would hide redeemable credits. One entry per
	 * account, with the session's active account flagged and unreachable
	 * accounts carrying an `error`.
	 */
	async listResetCredits(options?: {
		provider?: string;
		sessionId?: string;
		baseUrlResolver?: (provider: string) => string | undefined;
		signal?: AbortSignal;
	}): Promise<ResetCreditAccountStatus[]> {
		const provider = options?.provider ?? "openai-codex";
		const accesses = await this.getOAuthAccesses(provider);
		if (accesses.length === 0) return [];
		const baseUrl = options?.baseUrlResolver?.(provider);
		const activeId = this.getOAuthAccountIdentity(provider, options?.sessionId);
		return Promise.all(
			accesses.map(async (access): Promise<ResetCreditAccountStatus> => {
				const active =
					!!activeId &&
					((!!activeId.accountId && activeId.accountId === access.accountId) ||
						(!!activeId.email && activeId.email === access.email));
				const base = {
					credentialId: access.credentialId,
					accountId: access.accountId,
					email: access.email,
					active,
				};
				if (!access.ok) return { ...base, availableCount: 0, credits: [], error: access.error };
				const list = await listCodexResetCredits({
					accessToken: access.accessToken,
					accountId: access.accountId,
					baseUrl,
					fetch: this.#usageFetch,
					signal: options?.signal,
				});
				if (!list) return { ...base, availableCount: 0, credits: [], error: "Failed to load saved resets" };
				return { ...base, availableCount: list.availableCount, credits: list.credits };
			}),
		);
	}

	/**
	 * Redeem one saved rate-limit reset (OpenAI Codex "saved resets") for a
	 * specific stored account.
	 *
	 * Resolves a fresh access token for the target account, picks an available
	 * credit (the given `creditId`, else the first redeemable one), spends it,
	 * and invalidates the cached usage report so the next `/usage` reflects the
	 * reset. Never throws for business outcomes — inspect the returned `code`.
	 */
	async redeemResetCredit(options: {
		target: ResetCreditTarget;
		provider?: string;
		creditId?: string;
		baseUrlResolver?: (provider: string) => string | undefined;
		signal?: AbortSignal;
	}): Promise<ResetCreditRedeemOutcome> {
		const provider = options.provider ?? "openai-codex";
		const baseUrl = options.baseUrlResolver?.(provider);
		const { target } = options;
		const accesses = await this.getOAuthAccesses(provider);
		const match = accesses.find(
			access =>
				(target.credentialId !== undefined && access.credentialId === target.credentialId) ||
				(!!target.accountId && access.accountId === target.accountId) ||
				(!!target.email && access.email === target.email),
		);
		if (!match) return { ok: false, code: "no_account", accountId: target.accountId, email: target.email };
		if (!match.ok) {
			return { ok: false, code: "account_unavailable", accountId: match.accountId, email: match.email };
		}

		let creditId = options.creditId;
		if (!creditId) {
			const list = await listCodexResetCredits({
				accessToken: match.accessToken,
				accountId: match.accountId,
				baseUrl,
				fetch: this.#usageFetch,
				signal: options.signal,
			});
			const credit = list?.credits.find(entry => (entry.status ?? "available") === "available") ?? list?.credits[0];
			if (!credit) return { ok: false, code: "no_credit", accountId: match.accountId, email: match.email };
			creditId = credit.id;
		}

		const result = await consumeCodexResetCredit({
			creditId,
			accessToken: match.accessToken,
			accountId: match.accountId,
			baseUrl,
			fetch: this.#usageFetch,
			signal: options.signal,
		});
		if (result.ok) {
			this.#invalidateUsageReportCache(provider, baseUrl);
			// The window this credential was blocked on (by markUsageLimitReached)
			// is now reset, so lift its temporary block — otherwise selection
			// keeps skipping/under-ranking the freshly-reset account.
			if (match.credentialId !== undefined) this.#clearCredentialBlocks(provider, match.credentialId);
		}
		return { ok: result.ok, code: result.code, accountId: match.accountId, email: match.email, creditId };
	}

	/**
	 * Force the next usage fetch for `provider` to bypass the 5-min cache, so
	 * `/usage` reflects a freshly-redeemed reset instead of stale numbers.
	 */
	#invalidateUsageReportCache(provider: string, baseUrl?: string): void {
		const expired = Date.now() - 1;
		for (const entry of this.#getStoredCredentials(provider)) {
			if (entry.credential.type !== "oauth") continue;
			const cacheKey = this.#buildUsageReportCacheKey(
				this.#buildUsageRequestForOauth(provider, entry.credential, baseUrl),
			);
			const existing = this.#usageCache.getStale<UsageReport | null>(cacheKey);
			this.#usageCache.set(cacheKey, { value: existing?.value ?? null, expiresAt: expired });
		}
	}

	/**
	 * Lift any temporary backoff blocks on one credential (across the bare
	 * `provider:oauth` key and its scoped `\0`-suffixed derivatives). Called
	 * after a saved reset is redeemed so the just-reset account is immediately
	 * selectable again instead of being skipped/under-ranked by a stale block
	 * that `markUsageLimitReached` set for the now-obsolete reset time.
	 */
	#clearCredentialBlocks(provider: string, credentialId: number): void {
		const index = this.#getStoredCredentials(provider).findIndex(entry => entry.id === credentialId);
		if (index < 0) return;
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const scopedPrefix = `${providerKey}\0`;
		for (const [key, backoffMap] of this.#credentialBackoff) {
			if (key !== providerKey && !key.startsWith(scopedPrefix)) continue;
			backoffMap.delete(index);
			if (backoffMap.size === 0) this.#credentialBackoff.delete(key);
		}
	}

	#extractStructuredApiKeyToken(apiKey: string): string | undefined {
		if (!apiKey.startsWith("{")) return undefined;
		try {
			const parsed = JSON.parse(apiKey) as { token?: unknown };
			return typeof parsed.token === "string" ? parsed.token : undefined;
		} catch {
			return undefined;
		}
	}

	async #credentialMatchesApiKey(credential: AuthCredential, apiKey: string): Promise<boolean> {
		if (credential.type === "api_key") {
			return (await this.#configValueResolver(credential.key)) === apiKey;
		}
		if (credential.access === apiKey) return true;
		return this.#extractStructuredApiKeyToken(apiKey) === credential.access;
	}

	async invalidateCredentialMatching(
		provider: string,
		apiKey: string,
		options?: InvalidateCredentialMatchingOptions,
	): Promise<boolean>;
	async invalidateCredentialMatching(provider: string, apiKey: string, signal?: AbortSignal): Promise<boolean>;
	async invalidateCredentialMatching(
		provider: string,
		apiKey: string,
		optionsOrSignal?: InvalidateCredentialMatchingOptions | AbortSignal,
	): Promise<boolean> {
		const signal = isAbortSignalOption(optionsOrSignal) ? optionsOrSignal : optionsOrSignal?.signal;
		const sessionId = isAbortSignalOption(optionsOrSignal) ? undefined : optionsOrSignal?.sessionId;
		const stored = this.#getStoredCredentials(provider);
		let matched: { id: number; type: AuthCredential["type"]; index: number } | undefined;
		for (let index = 0; index < stored.length; index++) {
			const entry = stored[index];
			if (entry && (await this.#credentialMatchesApiKey(entry.credential, apiKey))) {
				matched = { id: entry.id, type: entry.credential.type, index };
				break;
			}
		}

		if (!matched) {
			await this.reload();
			return false;
		}

		this.#clearSessionCredential(provider, sessionId);
		this.#markCredentialBlocked(
			this.#getProviderTypeKey(provider, matched.type),
			matched.index,
			Date.now() + AuthStorage.#defaultBackoffMs,
		);

		const markSuspect = this.#store.markCredentialSuspect?.bind(this.#store);
		if (markSuspect) {
			await markSuspect(matched.id, { signal });
		} else {
			await this.reload();
		}

		const latestRows = this.#store.listAuthCredentials(provider);
		this.#setStoredCredentials(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		return true;
	}

	/**
	 * Rotate away from the session's current credential after a retryable auth
	 * error — step (c) of the auth-retry policy. Stateless: looks up the
	 * session-sticky credential (no API-key matching needed), applies the
	 * storage action for the error class, then clears the sticky so the next
	 * {@link AuthStorage.getApiKey} for this session picks a sibling.
	 *
	 * - usage-limit / account-rate-limit error → {@link AuthStorage.markUsageLimitReached}
	 *   (temporary block via its own backoff — default plus server usage-report
	 *   reset; sticky left intact so the next resolve re-ranks around the block).
	 * - otherwise (hard 401 / auth failure) → mark the credential suspect (or
	 *   reload when no broker hook is wired) and block it, then drop the sticky.
	 *
	 * Returns whether another usable credential of the same type remains.
	 */
	async rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: { error?: unknown; modelId?: string; signal?: AbortSignal },
	): Promise<boolean> {
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		if (!sessionCredential) return false;

		const error = options?.error;
		const status = AIError.status(error);
		const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
		if (isUsageLimitOutcome(status, message)) {
			return (
				await this.markUsageLimitReached(provider, sessionId, {
					modelId: options?.modelId,
					signal: options?.signal,
				})
			).switched;
		}

		const providerKey = this.#getProviderTypeKey(provider, sessionCredential.type);
		// Snapshot sibling availability before mutating so a soft-deleting
		// suspect hook can't reindex the answer out from under us.
		const hasSibling = this.#getCredentialsForProvider(provider).some(
			(credential, index) =>
				credential.type === sessionCredential.type &&
				index !== sessionCredential.index &&
				!this.#isCredentialBlocked(providerKey, index),
		);
		const target = this.#getStoredCredentials(provider)[sessionCredential.index];
		this.#clearSessionCredential(provider, sessionId);
		this.#markCredentialBlocked(providerKey, sessionCredential.index, Date.now() + AuthStorage.#defaultBackoffMs);

		if (target) {
			const markSuspect = this.#store.markCredentialSuspect?.bind(this.#store);
			if (markSuspect) {
				await markSuspect(target.id, { signal: options?.signal });
			} else {
				await this.reload();
			}
			const latestRows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				latestRows.map(row => ({ id: row.id, credential: row.credential })),
			);
		}

		return hasSibling;
	}

	/**
	 * Build an {@link ApiKeyResolver} backed by this storage, implementing the
	 * central a/b/c auth-retry policy:
	 *
	 * - initial (`error: undefined`) → resolve the session credential.
	 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential.
	 * - step (c) `lastChance` → rotate to a sibling credential, then re-resolve.
	 *
	 * Used by web-search providers and other consumers that hold an AuthStorage
	 * directly (no ModelRegistry in scope).
	 */
	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver {
		const { sessionId, baseUrl, modelId } = options ?? {};
		return async ({ lastChance, error, signal }) => {
			if (error === undefined) {
				return this.getApiKey(provider, sessionId, { baseUrl, modelId, signal });
			}
			if (lastChance) {
				await this.rotateSessionCredential(provider, sessionId, { error, modelId, signal });
				return this.getApiKey(provider, sessionId, { baseUrl, modelId, signal });
			}
			return this.getApiKey(provider, sessionId, { baseUrl, modelId, forceRefresh: true, signal });
		};
	}

	// ─── Auth Broker integration ────────────────────────────────────────────

	/**
	 * Build a redacted snapshot of all loaded credentials for the auth-broker
	 * wire. OAuth refresh tokens are replaced with {@link REMOTE_REFRESH_SENTINEL}
	 * so clients never see the actual refresh token.
	 *
	 * Callers must {@link AuthStorage.reload} first when serving a stale snapshot
	 * (the broker server's HTTP handler does this).
	 */
	exportSnapshot(): AuthCredentialSnapshot {
		const entries: AuthCredentialSnapshotEntry[] = [];
		for (const [provider, stored] of this.#data) {
			for (const entry of stored) {
				const credential = entry.credential;
				const redacted: SnapshotCredential =
					credential.type === "api_key" ? credential : { ...credential, refresh: REMOTE_REFRESH_SENTINEL };
				entries.push({
					id: entry.id,
					provider,
					credential: redacted,
					identityKey: resolveCredentialIdentityKey(provider, credential),
				});
			}
		}
		return { generation: this.#generation, generatedAt: Date.now(), credentials: entries };
	}

	/**
	 * Refresh the OAuth credential with the given id through a per-credential
	 * single-flight. Concurrent callers for the same row await the same upstream
	 * refresh attempt, which is required for providers that rotate refresh tokens
	 * on every successful refresh.
	 */
	async refreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		const existing = this.#oauthRefreshInFlight.get(id);
		if (existing) return raceCredentialRefreshWithSignal(existing, signal);

		const promise = (async () => {
			this.#bumpGeneration("credential-refresh-start");
			try {
				return await this.#forceRefreshCredentialByIdUnshared(id, signal);
			} catch (error) {
				this.#bumpGeneration("credential-refresh-failure");
				throw error;
			} finally {
				this.#oauthRefreshInFlight.delete(id);
			}
		})();
		this.#oauthRefreshInFlight.set(id, promise);
		return raceCredentialRefreshWithSignal(promise, signal);
	}

	/**
	 * Force-refresh the OAuth credential with the given id, bypassing the
	 * not-yet-expired guard. Used by the auth-broker server to honour
	 * `POST /v1/credential/:id/refresh`.
	 *
	 * Returns the redacted snapshot entry for the refreshed row.
	 * Throws when no OAuth credential with that id is loaded.
	 */
	async forceRefreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		return this.refreshCredentialById(id, signal);
	}

	async #forceRefreshCredentialByIdUnshared(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			const target = entries[index];
			if (target.credential.type !== "oauth") {
				throw new AIError.ValidationError(
					`Credential ${id} is not OAuth (provider=${provider}, type=${target.credential.type})`,
				);
			}
			// The exact credential we are about to refresh — captured before the
			// await so a definitive failure can CAS-disable the row against the
			// value we actually attempted (NOT the expires:0 clone below).
			const attempted = target.credential;
			// Pass a clone with expires=0 so the cached not-yet-expired short-circuit
			// in #refreshOAuthCredential doesn't suppress the requested refresh.
			const stale: OAuthCredential = { ...attempted, expires: 0 };
			let refreshed: OAuthCredentials;
			try {
				refreshed = await this.#refreshOAuthCredential(provider as Provider, stale, id, signal);
			} catch (error) {
				// A definitively-dead grant tears the row down here, where the
				// attempted credential is known. CAS on the persisted credential so a
				// peer/login rotation in flight leaves the freshly-rotated row intact.
				if (AIError.isDefinitiveOAuthFailure(String(error))) {
					// CAS-loss (false) means a peer/login rotated the row mid-refresh, so
					// our #data copy is stale — reload so the next caller serves the
					// freshly-rotated credential rather than the dead token we attempted.
					if (
						!this.#disableCredentialByIdIfMatches(
							provider,
							id,
							attempted,
							`oauth refresh failed: ${String(error)}`,
						)
					) {
						await this.reload();
					}
				}
				throw error;
			}
			const updated: OAuthCredential = {
				type: "oauth",
				access: refreshed.access,
				refresh: refreshed.refresh,
				expires: refreshed.expires,
				accountId: refreshed.accountId ?? attempted.accountId,
				email: refreshed.email ?? attempted.email,
				projectId: refreshed.projectId ?? attempted.projectId,
				enterpriseUrl: refreshed.enterpriseUrl ?? attempted.enterpriseUrl,
				apiEndpoint: refreshed.apiEndpoint ?? attempted.apiEndpoint,
			};
			// Persist by id: the array may have been reordered/shrunk while the
			// refresh was in flight, so the pre-await positional index is unsafe. A
			// -1 means the row was disabled/removed mid-refresh — surface that as a
			// miss rather than implying a live row the snapshot won't contain.
			if (this.#replaceCredentialById(provider, id, updated) === -1) {
				throw new AIError.ValidationError(`No credential with id=${id}`);
			}
			return {
				id,
				provider,
				credential: { ...updated, refresh: REMOTE_REFRESH_SENTINEL },
				identityKey: resolveCredentialIdentityKey(provider, updated),
			};
		}
		throw new AIError.ValidationError(`No credential with id=${id}`);
	}

	/**
	 * Disable the credential with the given id and emit a
	 * {@link CredentialDisabledEvent}. Used by the auth-broker server to honour
	 * `POST /v1/credential/:id/disable`. Returns `false` when no such row exists.
	 */
	disableCredentialById(id: number, disabledCause: string): boolean {
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			this.#store.deleteAuthCredential(id, disabledCause);
			const next = entries.filter((_value, idx) => idx !== index);
			this.#setStoredCredentials(provider, next);
			this.#resetProviderAssignments(provider);
			this.#emitCredentialDisabled({ provider, disabledCause });
			return true;
		}
		return false;
	}

	/**
	 * Upsert a credential into the underlying store, refresh the in-memory
	 * snapshot, and return the redacted snapshot entries for the provider.
	 *
	 * Used by the auth-broker server to honour `POST /v1/credential`. The
	 * persistence layer (`SqliteAuthCredentialStore.upsertAuthCredentialForProvider`)
	 * does identity-key matching, so re-uploading the same email/account replaces
	 * the existing row instead of inserting a duplicate.
	 */
	upsertCredential(provider: string, credential: AuthCredential): AuthCredentialSnapshotEntry[] {
		const stored = this.#store.upsertAuthCredentialForProvider(provider, credential);
		this.#setStoredCredentials(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential })),
		);
		this.#resetProviderAssignments(provider);
		return stored.map(entry => {
			const persisted = entry.credential;
			const redacted: SnapshotCredential =
				persisted.type === "api_key" ? persisted : { ...persisted, refresh: REMOTE_REFRESH_SENTINEL };
			return {
				id: entry.id,
				provider: entry.provider,
				credential: redacted,
				identityKey: resolveCredentialIdentityKey(provider, persisted),
			};
		});
	}

	/**
	 * Describe where the active credential for a provider came from.
	 *
	 * Surfaces four layers, highest precedence first:
	 *   1. Runtime override (`--api-key`).
	 *   2. Config override (`models.yml` `providers.<name>.apiKey`).
	 *   3. Stored credential (the one this session is currently sticky to, or the
	 *      one round-robin would pick next when no session id is supplied).
	 *   4. Env var / fallback resolver — when no stored credential exists.
	 *
	 * The string is purely informational; consumers must not parse it.
	 */
	describeCredentialSource(provider: string, sessionId?: string): string | undefined {
		if (this.#runtimeOverrides.has(provider)) {
			return "runtime override (--api-key)";
		}
		if (this.#configOverrides.has(provider)) {
			return "config override (models.yml)";
		}

		const baseLabel = this.#sourceLabel ?? "local store";
		const stored = this.#getStoredCredentials(provider);
		if (stored.length === 0) {
			if (getEnvApiKey(provider)) return `env ${baseLabel ? `(fallback over ${baseLabel})` : ""}`.trim();
			if (this.#fallbackResolver?.(provider) !== undefined) return `fallback resolver`;
			return undefined;
		}

		const session = sessionId ? this.#sessionLastCredential.get(provider)?.get(sessionId) : undefined;
		// Same selection logic as #selectCredentialByType for "no session" lookups: prefer
		// the type with stored credentials, lean OAuth before api_key. We don't run the
		// full round-robin here because describing the source shouldn't advance the index.
		const preferredType: AuthCredential["type"] =
			session?.type ?? (stored.some(entry => entry.credential.type === "oauth") ? "oauth" : "api_key");
		const typed = stored
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => entry.credential.type === preferredType);
		if (typed.length === 0) return baseLabel;
		const index = session?.index ?? typed[0].index;
		const chosen = stored[index] ?? typed[0].entry;
		const credential = chosen.credential;
		const identity =
			credential.type === "oauth"
				? (credential.email ?? credential.accountId ?? credential.projectId ?? `cred ${chosen.id}`)
				: `cred ${chosen.id}`;
		return `${baseLabel} · ${preferredType} #${chosen.id} (${identity})`;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// SqliteAuthCredentialStore
// ─────────────────────────────────────────────────────────────────────────────

/** Row shape for auth_credentials table queries */
type AuthRow = {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
	disabled_cause: string | null;
	identity_key: string | null;
};

type SerializedCredentialRecord = {
	credentialType: AuthCredential["type"];
	data: string;
	identityKey: string | null;
};

const AUTH_SCHEMA_VERSION = 4;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

/**
 * SQLite's busy result code family — base `SQLITE_BUSY` plus the extended
 * variants `SQLITE_BUSY_RECOVERY` (concurrent WAL recovery), `SQLITE_BUSY_SNAPSHOT`,
 * and `SQLITE_BUSY_TIMEOUT`. All warrant the same backoff-and-retry treatment.
 */
export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object") return false;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

function normalizeStoredAccountId(accountId: string | null | undefined): string | null {
	const normalized = accountId?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeStoredEmail(email: string | null | undefined): string | null {
	const normalized = email?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeStoredIdentityKey(identityKey: string | null | undefined): string | null {
	const normalized = identityKey?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

function serializeCredential(provider: string, credential: AuthCredential): SerializedCredentialRecord | null {
	if (credential.type === "api_key") {
		return {
			credentialType: "api_key",
			data: JSON.stringify({ key: credential.key }),
			identityKey: null,
		};
	}
	if (credential.type === "oauth") {
		const { type: _type, ...rest } = credential;
		return {
			credentialType: "oauth",
			data: JSON.stringify(rest),
			identityKey: resolveCredentialIdentityKey(provider, credential),
		};
	}
	return null;
}

function deserializeCredential(row: AuthRow): AuthCredential | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.data);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	if (row.credential_type === "api_key") {
		const data = parsed as Record<string, unknown>;
		if (typeof data.key === "string") {
			return { type: "api_key", key: data.key };
		}
	}
	if (row.credential_type === "oauth") {
		return { type: "oauth", ...(parsed as Record<string, unknown>) } as AuthCredential;
	}
	return null;
}

function normalizeDisabledCause(disabledCause: string): string {
	const normalized = disabledCause.trim();
	return normalized.length > 0 ? normalized : "disabled";
}

function toStoredAuthCredential(row: AuthRow, credential: AuthCredential): StoredAuthCredential {
	return { id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause };
}

function resolveProviderCredentialIdentityKey(provider: string, identifiers: string[]): string | null {
	const emailIdentifier = identifiers.find(identifier => identifier.startsWith("email:"));
	if ((provider === "openai-codex" || provider === "anthropic") && emailIdentifier) return emailIdentifier;
	const accountIdentifier = identifiers.find(identifier => identifier.startsWith("account:"));
	if (accountIdentifier) return accountIdentifier;
	if (emailIdentifier) return emailIdentifier;
	const projectIdentifier = identifiers.find(identifier => identifier.startsWith("project:"));
	if (projectIdentifier) return projectIdentifier;
	return null;
}

function resolveCredentialIdentityKey(provider: string, credential: AuthCredential): string | null {
	if (credential.type === "api_key") return null;
	return resolveProviderCredentialIdentityKey(provider, extractOAuthCredentialIdentifiers(credential));
}

function resolveRowCredentialIdentityKey(provider: string, row: AuthRow): string | null {
	const identityKey = normalizeStoredIdentityKey(row.identity_key);
	if (identityKey) return identityKey;
	const credential = deserializeCredential(row);
	return credential?.type === "oauth" ? resolveCredentialIdentityKey(provider, credential) : null;
}

function matchesReplacementCredential(
	provider: string,
	existing: AuthCredential | null,
	existingIdentityKey: string | null,
	incoming: AuthCredential,
): boolean {
	if (!existing || existing.type !== incoming.type) return false;
	if (incoming.type === "api_key") {
		return existing.type === "api_key" && existing.key === incoming.key;
	}
	const incomingIdentityKey = resolveCredentialIdentityKey(provider, incoming);
	return incomingIdentityKey !== null && incomingIdentityKey === existingIdentityKey;
}

function extractOAuthCredentialIdentifiers(credential: OAuthCredential): string[] {
	const identifiers = new Set<string>();
	const accountId = normalizeStoredAccountId(credential.accountId);
	if (accountId) identifiers.add(`account:${accountId}`);
	const email = normalizeStoredEmail(credential.email);
	if (email) identifiers.add(`email:${email}`);
	const projectId = normalizeStoredAccountId(credential.projectId);
	if (projectId) identifiers.add(`project:${projectId}`);
	const accessIdentifiers = extractOAuthTokenIdentifiers(credential.access) ?? [];
	for (const identifier of accessIdentifiers) {
		identifiers.add(identifier);
	}
	const refreshIdentifiers = extractOAuthTokenIdentifiers(credential.refresh) ?? [];
	for (const identifier of refreshIdentifiers) {
		identifiers.add(identifier);
	}
	return [...identifiers];
}

function extractOAuthTokenIdentifiers(token: string | undefined): string[] | undefined {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(
			new TextDecoder("utf-8").decode(Uint8Array.fromBase64(parts[1], { alphabet: "base64url" })),
		) as Record<string, unknown>;
		const identifiers = new Set<string>();
		const directEmail = normalizeStoredEmail(typeof payload.email === "string" ? payload.email : undefined);
		if (directEmail) identifiers.add(`email:${directEmail}`);
		const openAiProfile = payload["https://api.openai.com/profile"];
		if (typeof openAiProfile === "object" && openAiProfile !== null && !Array.isArray(openAiProfile)) {
			const claimEmail = normalizeStoredEmail(
				(openAiProfile as Record<string, unknown>).email as string | undefined,
			);
			if (claimEmail) identifiers.add(`email:${claimEmail}`);
		}
		const openAiAuth = payload["https://api.openai.com/auth"];
		const authClaims =
			typeof openAiAuth === "object" && openAiAuth !== null && !Array.isArray(openAiAuth)
				? (openAiAuth as Record<string, unknown>)
				: undefined;
		const accountId = normalizeStoredAccountId(
			typeof payload.account_id === "string"
				? payload.account_id
				: typeof payload.accountId === "string"
					? payload.accountId
					: typeof payload.user_id === "string"
						? payload.user_id
						: typeof payload.sub === "string"
							? payload.sub
							: typeof authClaims?.chatgpt_account_id === "string"
								? authClaims.chatgpt_account_id
								: undefined,
		);
		if (accountId) identifiers.add(`account:${accountId}`);
		return identifiers.size > 0 ? [...identifiers] : undefined;
	} catch {
		return undefined;
	}
}
/**
 * Default SQLite-backed implementation of {@link AuthCredentialStore}.
 *
 * Used by the pi-ai CLI and as the default store for `AuthStorage.create()`.
 * Also exposes convenience methods (`saveOAuth`, `getOAuth`, `saveApiKey`,
 * `getApiKey`, `listProviders`, `deleteProvider`) that callers can use directly
 * without going through `AuthStorage`.
 */
export class SqliteAuthCredentialStore implements AuthCredentialStore {
	#db: Database;
	#listActiveStmt: Statement;
	#listActiveByProviderStmt: Statement;
	#listDisabledByProviderStmt: Statement;
	#insertStmt: Statement;
	#updateStmt: Statement;
	#deleteStmt: Statement;
	#deleteIfMatchesStmt: Statement;
	#deleteByProviderStmt: Statement;
	#hardDeleteStmt: Statement;
	#getCacheStmt: Statement;
	#getCacheIncludingExpiredStmt: Statement;
	#upsertCacheStmt: Statement;
	#deleteExpiredCacheStmt: Statement;
	#insertUsageHistoryStmt: Statement;
	#insertUsageCostStmt: Statement;
	#listUsageCostsStmt: Statement;
	#lastUsageHistoryStmt: Statement;
	#listUsageHistoryStmt: Statement;
	#updateUsageHistoryStmt: Statement;
	#closed = false;

	constructor(db: Database) {
		this.#db = db;
		this.#initializeSchema();

		this.#listActiveStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listActiveByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listDisabledByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
		);
		this.#insertStmt = this.#db.prepare(
			`INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ${SQLITE_NOW_EPOCH}, ${SQLITE_NOW_EPOCH}) RETURNING id`,
		);
		this.#updateStmt = this.#db.prepare(
			`UPDATE auth_credentials SET credential_type = ?, data = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#deleteStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#deleteIfMatchesStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND data = ? AND disabled_cause IS NULL`,
		);
		this.#deleteByProviderStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE provider = ? AND disabled_cause IS NULL`,
		);
		this.#hardDeleteStmt = this.#db.prepare("DELETE FROM auth_credentials WHERE id = ?");
		this.#getCacheStmt = this.#db.prepare(
			`SELECT value FROM cache WHERE key = ? AND expires_at > ${SQLITE_NOW_EPOCH}`,
		);
		this.#getCacheIncludingExpiredStmt = this.#db.prepare("SELECT value FROM cache WHERE key = ?");
		this.#upsertCacheStmt = this.#db.prepare(
			"INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
		);
		this.#deleteExpiredCacheStmt = this.#db.prepare(`DELETE FROM cache WHERE expires_at <= ${SQLITE_NOW_EPOCH}`);
		this.#insertUsageHistoryStmt = this.#db.prepare(
			"INSERT INTO usage_history (recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.#lastUsageHistoryStmt = this.#db.prepare(
			"SELECT id, recorded_at FROM usage_history WHERE provider = ? AND account_key = ? AND limit_id = ? ORDER BY recorded_at DESC LIMIT 1",
		);
		this.#updateUsageHistoryStmt = this.#db.prepare(
			"UPDATE usage_history SET recorded_at = ?, email = ?, account_id = ?, label = ?, window_label = ?, used_fraction = ?, status = ?, resets_at = ? WHERE id = ?",
		);
		this.#listUsageHistoryStmt = this.#db.prepare(
			"SELECT recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at FROM usage_history WHERE recorded_at >= ? AND (? IS NULL OR provider = ?) ORDER BY recorded_at ASC",
		);
		this.#insertUsageCostStmt = this.#db.prepare(
			"INSERT INTO usage_cost_history (recorded_at, provider, account_key, cost_usd) VALUES (?, ?, ?, ?)",
		);
		this.#listUsageCostsStmt = this.#db.prepare(
			"SELECT recorded_at, provider, account_key, cost_usd FROM usage_cost_history WHERE recorded_at >= ? AND (? IS NULL OR provider = ?) AND (? IS NULL OR account_key = ?) ORDER BY recorded_at ASC",
		);
	}

	static async open(dbPath: string = getAgentDbPath()): Promise<SqliteAuthCredentialStore> {
		const dir = path.dirname(dbPath);
		const dirExists = await fs
			.stat(dir)
			.then(s => s.isDirectory())
			.catch(() => false);
		if (!dirExists) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		}

		// Concurrent omp startups can race against WAL recovery and the schema
		// init's first lock-taking statement. Bun's default `busy_timeout` is 0,
		// so retry the open on `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY` with bounded
		// exponential backoff before surfacing the failure. See issue #2421.
		const maxAttempts = 4;
		const baseDelayMs = 100;
		let lastBusyError: Error | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			let db: Database | undefined;
			try {
				db = new Database(dbPath);
				try {
					await fs.chmod(dbPath, 0o600);
				} catch {
					// Ignore chmod failures (e.g., Windows)
				}
				return new SqliteAuthCredentialStore(db);
			} catch (err) {
				db?.close();
				if (!isSqliteBusyError(err)) {
					throw err;
				}
				lastBusyError = err instanceof Error ? err : new Error(String(err));
				if (attempt < maxAttempts - 1) {
					await Bun.sleep(baseDelayMs * 2 ** attempt);
				}
			}
		}
		throw new AIError.ConfigurationError(
			`Failed to open auth database at '${dbPath}' after ${maxAttempts} attempts: ${lastBusyError?.message}`,
			{ cause: lastBusyError },
		);
	}

	#initializeSchema(): void {
		// Install the busy handler BEFORE any lock-taking statement (incl.
		// `PRAGMA journal_mode=WAL`, which acquires an exclusive lock during WAL
		// recovery). Without this, concurrent omp startups can crash here with
		// `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY`. See issue #2421.
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			CREATE TABLE IF NOT EXISTS auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS cache (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
			CREATE TABLE IF NOT EXISTS usage_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				provider TEXT NOT NULL,
				account_key TEXT NOT NULL,
				email TEXT,
				account_id TEXT,
				limit_id TEXT NOT NULL,
				label TEXT NOT NULL,
				window_label TEXT,
				used_fraction REAL,
				status TEXT,
				resets_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_usage_history_series ON usage_history(provider, account_key, limit_id, recorded_at);
			CREATE TABLE IF NOT EXISTS usage_cost_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				provider TEXT NOT NULL,
				account_key TEXT NOT NULL,
				cost_usd REAL NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_usage_cost_history_lookup ON usage_cost_history(provider, account_key, recorded_at);
			CREATE INDEX IF NOT EXISTS idx_usage_history_recorded ON usage_history(recorded_at);
		`);

		if (!this.#authCredentialsTableExists()) {
			this.#createAuthCredentialsTable();
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
			return;
		}

		const recordedVersion = this.#readAuthSchemaVersion();
		const schemaVersion = recordedVersion ?? this.#inferAuthSchemaVersion();
		if (schemaVersion > AUTH_SCHEMA_VERSION) {
			logger.warn("SqliteAuthCredentialStore schema version mismatch", {
				current: schemaVersion,
				expected: AUTH_SCHEMA_VERSION,
			});
		} else if (schemaVersion < AUTH_SCHEMA_VERSION) {
			this.#migrateAuthSchema(schemaVersion);
		}

		this.#createAuthCredentialIndexes();
		this.#backfillCredentialIdentityKeys();
		// Rewriting an already-current version row is a no-op write transaction
		// on every boot; only persist when the recorded version actually changes.
		if (recordedVersion !== AUTH_SCHEMA_VERSION && schemaVersion <= AUTH_SCHEMA_VERSION) {
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
		}
	}

	#authCredentialsTableExists(): boolean {
		const stmt = this.#db.prepare(
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'",
		);
		try {
			const row = stmt.get() as { present?: number } | undefined;
			return row?.present === 1;
		} finally {
			stmt.finalize();
		}
	}

	#readAuthSchemaVersion(): number | null {
		const stmt = this.#db.prepare("SELECT version FROM auth_schema_version WHERE id = 1");
		try {
			const row = stmt.get() as { version?: number } | undefined;
			return typeof row?.version === "number" ? row.version : null;
		} finally {
			stmt.finalize();
		}
	}

	#writeAuthSchemaVersion(version: number): void {
		const stmt = this.#db.prepare("INSERT OR REPLACE INTO auth_schema_version(id, version) VALUES (1, ?)");
		try {
			stmt.run(version);
		} finally {
			stmt.finalize();
		}
	}

	#inferAuthSchemaVersion(): number {
		const stmt = this.#db.prepare("PRAGMA table_info(auth_credentials)");
		try {
			const cols = stmt.all() as Array<{ name?: string }>;
			return this.#inferAuthSchemaVersionFromColumns(cols);
		} finally {
			stmt.finalize();
		}
	}

	#inferAuthSchemaVersionFromColumns(cols: Array<{ name?: string }>): number {
		const hasDisabledCause = cols.some(column => column.name === "disabled_cause");
		const hasIdentityKey = cols.some(column => column.name === "identity_key");
		const hasAccountId = cols.some(column => column.name === "account_id");
		const hasEmail = cols.some(column => column.name === "email");
		if (hasIdentityKey) return 3;
		if (hasAccountId || hasEmail) return 2;
		if (hasDisabledCause) return 1;
		return 0;
	}

	#createAuthCredentialsTable(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
				updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
			);
		`);
		this.#createAuthCredentialIndexes();
	}

	#createAuthCredentialIndexes(): void {
		this.#db.run(`
			CREATE INDEX IF NOT EXISTS idx_auth_provider ON auth_credentials(provider);
			CREATE INDEX IF NOT EXISTS idx_auth_provider_identity ON auth_credentials(provider, identity_key) WHERE identity_key IS NOT NULL;
		`);
	}

	#migrateAuthSchema(fromVersion: number): void {
		if (fromVersion < 1) {
			this.#migrateAuthSchemaV0ToV1();
		}
		if (fromVersion < 3) {
			this.#migrateAuthSchemaV1OrV2ToV3();
		}
		if (fromVersion < 4) {
			this.#migrateAuthSchemaV3ToV4();
		}
	}

	#migrateAuthSchemaV0ToV1(): void {
		const migrate = this.#db.transaction(() => {
			const stmt = this.#db.prepare("PRAGMA table_info(auth_credentials)");
			let hasDisabled = false;
			try {
				const v0Cols = stmt.all() as Array<{ name?: string }>;
				hasDisabled = v0Cols.some(col => col.name === "disabled");
			} finally {
				stmt.finalize();
			}

			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v0");
			this.#db.run(`
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
					updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
				);
			`);
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					${hasDisabled ? "CASE WHEN disabled = 1 THEN 'disabled' ELSE NULL END" : "NULL"},
					created_at,
					updated_at
				FROM auth_credentials_v0
			`);
			this.#db.run("DROP TABLE auth_credentials_v0");
		});
		migrate();
	}

	#migrateAuthSchemaV1OrV2ToV3(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_legacy");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					NULL,
					created_at,
					updated_at
				FROM auth_credentials_legacy
			`);
			this.#db.run("DROP TABLE auth_credentials_legacy");
		});
		migrate();
	}

	#migrateAuthSchemaV3ToV4(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v3");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					identity_key,
					created_at,
					updated_at
				FROM auth_credentials_v3
			`);
			this.#db.run("DROP TABLE auth_credentials_v3");
		});
		migrate();
	}

	#backfillCredentialIdentityKeys(): void {
		const selectRowsStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE identity_key IS NULL ORDER BY id ASC",
		);
		let rows: AuthRow[];
		try {
			rows = selectRowsStmt.all() as AuthRow[];
		} finally {
			selectRowsStmt.finalize();
		}
		if (rows.length === 0) return;

		let updateIdentity: Statement | null = null;
		try {
			for (const row of rows) {
				const identityKey = resolveRowCredentialIdentityKey(row.provider, row);
				// Rows whose identity cannot be derived stay NULL; writing NULL over
				// NULL would just burn a write transaction on every boot.
				if (identityKey === null) continue;
				updateIdentity ??= this.#db.prepare("UPDATE auth_credentials SET identity_key = ? WHERE id = ?");
				updateIdentity.run(identityKey, row.id);
			}
		} finally {
			updateIdentity?.finalize();
		}
	}

	// ─── AuthCredentialStore interface ──────────────────────────────────────

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const rows =
			(provider
				? (this.#listActiveByProviderStmt.all(provider) as AuthRow[])
				: (this.#listActiveStmt.all() as AuthRow[])) ?? [];

		const results: StoredAuthCredential[] = [];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (!credential) continue;
			results.push(toStoredAuthCredential(row, credential));
		}
		return results;
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		const replace = this.#db.transaction((providerName: string, items: AuthCredential[]) => {
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
			}));

			const result: StoredAuthCredential[] = [];
			const matchedExistingIds = new Set<number>();

			for (const credential of items) {
				const serialized = serializeCredential(providerName, credential);
				if (!serialized) continue;
				const match = existing.find(
					entry =>
						!matchedExistingIds.has(entry.id) &&
						matchesReplacementCredential(providerName, entry.credential, entry.identityKey, credential),
				);
				if (match) {
					matchedExistingIds.add(match.id);
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, match.id);
					result.push({ id: match.id, provider: providerName, credential, disabledCause: null });
				} else {
					const row = this.#insertStmt.get(
						providerName,
						serialized.credentialType,
						serialized.data,
						serialized.identityKey,
					) as { id?: number } | undefined;
					if (row?.id) {
						result.push({ id: row.id, provider: providerName, credential, disabledCause: null });
					}
				}
			}

			for (const row of existing) {
				if (!matchedExistingIds.has(row.id)) {
					this.#deleteStmt.run("replaced by newer credential", row.id);
				}
			}

			return result;
		});

		const result = replace(provider, credentials);
		this.#purgeSupersededDisabledRows(provider, result);
		return result;
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		const upsert = this.#db.transaction((providerName: string, item: AuthCredential) => {
			const serialized = serializeCredential(providerName, item);
			if (!serialized) return this.listAuthCredentials(providerName);
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
			}));

			if (item.type === "oauth") {
				for (const row of existing) {
					if (row.credential && row.credential.type === "api_key") {
						this.#deleteStmt.run("replaced by oauth login", row.id);
					}
				}
			}

			let targetId: number | null = null;
			for (const row of existing) {
				if (!matchesReplacementCredential(providerName, row.credential, row.identityKey, item)) continue;
				if (targetId === null) {
					targetId = row.id;
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, row.id);
					continue;
				}
				this.#deleteStmt.run("replaced by newer credential", row.id);
			}

			if (targetId === null) {
				const row = this.#insertStmt.get(
					providerName,
					serialized.credentialType,
					serialized.data,
					serialized.identityKey,
				) as { id?: number } | undefined;
				targetId = row?.id ?? null;
			}

			const activeRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const result: StoredAuthCredential[] = [];
			for (const row of activeRows) {
				const activeCredential = deserializeCredential(row);
				if (!activeCredential) continue;
				result.push(toStoredAuthCredential(row, activeCredential));
			}
			return result;
		});

		const result = upsert(provider, credential);
		this.#purgeSupersededDisabledRows(provider, result);
		return result;
	}

	/**
	 * Hard-deletes disabled rows for a provider when an active replacement exists.
	 * OAuth credentials match by identity key; API keys match by provider and type.
	 * Disabled rows without an active same-type replacement remain recoverable.
	 */
	#purgeSupersededDisabledRows(provider: string, activeRows: StoredAuthCredential[]): void {
		try {
			let hasActiveApiKey = false;
			const activeIdentityKeys = new Set<string>();
			for (const row of activeRows) {
				if (row.credential.type === "api_key") {
					hasActiveApiKey = true;
					continue;
				}
				const identityKey = resolveCredentialIdentityKey(provider, row.credential);
				if (identityKey) activeIdentityKeys.add(identityKey);
			}
			if (!hasActiveApiKey && activeIdentityKeys.size === 0) return;

			const disabledRows = this.#listDisabledByProviderStmt.all(provider) as AuthRow[];
			for (const row of disabledRows) {
				if (hasActiveApiKey && row.credential_type === "api_key") {
					this.#hardDeleteStmt.run(row.id);
					continue;
				}
				const identityKey = resolveRowCredentialIdentityKey(provider, row);
				if (identityKey && activeIdentityKeys.has(identityKey)) {
					this.#hardDeleteStmt.run(row.id);
				}
			}
		} catch {
			// Best-effort cleanup; don't let it break the main operation
		}
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		try {
			const providerStmt = this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?");
			let providerRow: { provider?: string } | undefined;
			try {
				providerRow = providerStmt.get(id) as { provider?: string } | undefined;
			} finally {
				providerStmt.finalize();
			}
			const provider = providerRow?.provider ?? "";
			const serialized = serializeCredential(provider, credential);
			if (!serialized) return;
			this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, id);
			if (provider) {
				this.#purgeSupersededDisabledRows(provider, this.listAuthCredentials(provider));
			}
		} catch {
			// Ignore update failures
		}
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		try {
			this.#deleteStmt.run(normalizeDisabledCause(disabledCause), id);
		} catch {
			// Ignore delete failures
		}
	}

	/**
	 * CAS-style disable: only soft-deletes the row when its `data` column still
	 * matches `expectedData` and the row has not already been disabled. Used by
	 * the OAuth refresh-failure path to avoid clobbering a peer that rotated the
	 * row between our pre-check and the disable.
	 */
	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string): boolean {
		try {
			const result = this.#deleteIfMatchesStmt.run(normalizeDisabledCause(disabledCause), id, expectedData) as {
				changes: number;
			};
			return result.changes === 1;
		} catch {
			return false;
		}
	}

	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		try {
			this.#deleteByProviderStmt.run(normalizeDisabledCause(disabledCause), provider);
		} catch {
			// Ignore delete failures
		}
	}

	getCache(key: string, options?: { includeExpired?: boolean }): string | null {
		try {
			const stmt = options?.includeExpired === true ? this.#getCacheIncludingExpiredStmt : this.#getCacheStmt;
			const row = stmt.get(key) as { value?: string } | undefined;
			return row?.value ?? null;
		} catch {
			return null;
		}
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		try {
			this.#upsertCacheStmt.run(key, value, expiresAtSec);
		} catch {
			// Ignore cache set failures
		}
	}

	cleanExpiredCache(): void {
		try {
			this.#deleteExpiredCacheStmt.run();
		} catch {
			// Ignore cleanup errors
		}
	}

	recordUsageSnapshots(entries: UsageHistoryEntry[]): void {
		try {
			for (const entry of entries) {
				const bucket = Math.floor(entry.recordedAt / USAGE_HISTORY_BUCKET_MS);
				const last = this.#lastUsageHistoryStmt.get(entry.provider, entry.accountKey, entry.limitId) as
					| { id: number; recorded_at: number }
					| undefined;
				if (last && Math.floor(last.recorded_at / USAGE_HISTORY_BUCKET_MS) === bucket) {
					this.#updateUsageHistoryStmt.run(
						entry.recordedAt,
						entry.email ?? null,
						entry.accountId ?? null,
						entry.label,
						entry.windowLabel ?? null,
						entry.usedFraction ?? null,
						entry.status ?? null,
						entry.resetsAt ?? null,
						last.id,
					);
					continue;
				}
				this.#insertUsageHistoryStmt.run(
					entry.recordedAt,
					entry.provider,
					entry.accountKey,
					entry.email ?? null,
					entry.accountId ?? null,
					entry.limitId,
					entry.label,
					entry.windowLabel ?? null,
					entry.usedFraction ?? null,
					entry.status ?? null,
					entry.resetsAt ?? null,
				);
			}
		} catch {
			// History is best-effort; never break the usage fetch path.
		}
	}

	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		try {
			const provider = query?.provider ?? null;
			const rows = this.#listUsageHistoryStmt.all(query?.sinceMs ?? 0, provider, provider) as Array<{
				recorded_at: number;
				provider: string;
				account_key: string;
				email: string | null;
				account_id: string | null;
				limit_id: string;
				label: string;
				window_label: string | null;
				used_fraction: number | null;
				status: string | null;
				resets_at: number | null;
			}>;
			return rows.map(row => ({
				recordedAt: row.recorded_at,
				provider: row.provider as Provider,
				accountKey: row.account_key,
				email: row.email ?? undefined,
				accountId: row.account_id ?? undefined,
				limitId: row.limit_id,
				label: row.label,
				windowLabel: row.window_label ?? undefined,
				usedFraction: row.used_fraction ?? undefined,
				status: (row.status ?? undefined) as UsageHistoryEntry["status"],
				resetsAt: row.resets_at ?? undefined,
			}));
		} catch {
			return [];
		}
	}
	recordUsageCosts(entries: UsageCostHistoryEntry[]): void {
		try {
			for (const entry of entries) {
				this.#insertUsageCostStmt.run(entry.recordedAt, entry.provider, entry.accountKey, entry.costUsd);
			}
		} catch {
			// Cost history is best-effort; never break request persistence.
		}
	}

	listUsageCosts(query?: UsageCostHistoryQuery): UsageCostHistoryEntry[] {
		try {
			const provider = query?.provider ?? null;
			const accountKey = query?.accountKey ?? null;
			const rows = this.#listUsageCostsStmt.all(
				query?.sinceMs ?? 0,
				provider,
				provider,
				accountKey,
				accountKey,
			) as Array<{
				recorded_at: number;
				provider: string;
				account_key: string;
				cost_usd: number;
			}>;
			return rows.map(row => ({
				recordedAt: row.recorded_at,
				provider: row.provider as Provider,
				accountKey: row.account_key,
				costUsd: row.cost_usd,
			}));
		} catch {
			return [];
		}
	}

	// ─── Convenience methods for CLI ────────────────────────────────────────

	/**
	 * Save OAuth credentials for a provider.
	 * Preserves unrelated identities and replaces only the matching credential.
	 */
	saveOAuth(provider: string, credentials: OAuthCredentials): void {
		const credential: AuthCredential = { type: "oauth", ...credentials };
		this.upsertAuthCredentialForProvider(provider, credential);
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuth(provider: string): OAuthCredentials | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "oauth") {
				const { type: _type, ...oauth } = credential;
				return oauth as OAuthCredentials;
			}
		}
		return null;
	}

	/**
	 * Save API key for a provider (replaces existing).
	 */
	saveApiKey(provider: string, apiKey: string): void {
		const credential: AuthCredential = { type: "api_key", key: apiKey };
		this.replaceAuthCredentialsForProvider(provider, [credential]);
	}

	/**
	 * Get API key for a provider.
	 */
	getApiKey(provider: string): string | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "api_key") {
				return credential.key;
			}
		}
		return null;
	}

	/**
	 * List all providers with credentials.
	 */
	listProviders(): string[] {
		const rows = this.#listActiveStmt.all() as AuthRow[];
		const providers = new Set<string>();
		for (const row of rows) {
			providers.add(row.provider);
		}
		return Array.from(providers);
	}

	/**
	 * Delete all credentials for a provider.
	 */
	deleteProvider(provider: string): void {
		this.deleteAuthCredentialsForProvider(provider, "deleted by user");
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#listActiveStmt.finalize();
		this.#listActiveByProviderStmt.finalize();
		this.#listDisabledByProviderStmt.finalize();
		this.#insertStmt.finalize();
		this.#updateStmt.finalize();
		this.#deleteStmt.finalize();
		this.#deleteIfMatchesStmt.finalize();
		this.#deleteByProviderStmt.finalize();
		this.#hardDeleteStmt.finalize();
		this.#getCacheStmt.finalize();
		this.#getCacheIncludingExpiredStmt.finalize();
		this.#upsertCacheStmt.finalize();
		this.#deleteExpiredCacheStmt.finalize();
		this.#insertUsageHistoryStmt.finalize();
		this.#lastUsageHistoryStmt.finalize();
		this.#listUsageHistoryStmt.finalize();
		this.#updateUsageHistoryStmt.finalize();
		this.#insertUsageCostStmt.finalize();
		this.#listUsageCostsStmt.finalize();
		this.#db.close();
	}
}
