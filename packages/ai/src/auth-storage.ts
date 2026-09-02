/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, refreshing credentials, and usage tracking.
 *
 * This module defines:
 * - `AuthCredentialStore` interface: persistence abstraction (SQLite, remote vault, …)
 * - `AuthStorage` class: credential management with round-robin, usage limits, OAuth refresh
 * - re-exported `SqliteAuthCredentialStore`: concrete SQLite-backed implementation
 */
import { createHash } from "node:crypto";
import { planRequirementFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { $env, $envExact, extractRetryHint, getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import {
	isSqliteCorruptionError,
	resolveCredentialIdentityKey,
	SqliteAuthCredentialStore,
	serializeCredential,
	USAGE_REPORT_TTL_MS,
} from "./auth/sqlite-credential-store";
import type { ApiKeyResolver } from "./auth-retry";
import * as AIError from "./error";
import { isUsageLimitOutcome } from "./error/rate-limit";
import { getProviderDefinition, PASTE_CODE_LOGIN_PROVIDERS } from "./registry";
import { getOAuthApiKey, getOAuthProvider, refreshOAuthToken } from "./registry/oauth";
import type {
	OAuthAuthInfo,
	OAuthController,
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
} from "./registry/oauth/types";
import { AUTHENTICATED_SENTINEL } from "./registry/types";
import { getEnvApiKey, getEnvApiKeyName } from "./stream";
import type { Provider } from "./types";
import type {
	ClientUsageIdentity,
	ClientUsageReport,
	ClientUsageSummary,
	CredentialRankingContext,
	CredentialRankingStrategy,
	ObservedUsageEntry,
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
import { alibabaTokenPlanRankingStrategy, alibabaTokenPlanUsageProvider } from "./usage/alibaba-token-plan";
import { claudeRankingStrategy, claudeUsageProvider } from "./usage/claude";
import { clinePassUsageProvider } from "./usage/cline-pass";
import { cursorUsageProvider } from "./usage/cursor";
import { devinUsageProvider } from "./usage/devin";
import { googleGeminiCliUsageProvider } from "./usage/gemini";
import { githubCopilotUsageProvider } from "./usage/github-copilot";
import { antigravityRankingStrategy, antigravityUsageProvider } from "./usage/google-antigravity";
import { kimiRankingStrategy, kimiUsageProvider } from "./usage/kimi";
import { minimaxCodeUsageProvider } from "./usage/minimax-code";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "./usage/ollama";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./usage/openai-codex";
import {
	type CodexResetConsumeCode,
	type CodexResetCredit,
	consumeCodexResetCredit,
	listCodexResetCredits,
	pickSoonestExpiringCredit,
} from "./usage/openai-codex-reset";
import { opencodeGoRankingStrategy, opencodeGoUsageProvider } from "./usage/opencode-go";
import { syntheticUsageProvider } from "./usage/synthetic";
import { umansUsageProvider } from "./usage/umans";
import { xaiOauthUsageProvider } from "./usage/xai-oauth";
import { zaiRankingStrategy, zaiUsageProvider } from "./usage/zai";

export { isSqliteBusyError, isSqliteCorruptionError, SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";

const USAGE_RANKING_METRIC_EPSILON = 1e-9;
/**
 * Primary (short, e.g. 5h) window used-fraction at or above which a candidate
 * is demoted behind cooler siblings during ranking: a nearly exhausted short
 * window means an imminent mid-session block, so drain urgency defers to it.
 */
const PRIMARY_WINDOW_HOT_FRACTION = 0.85;
const OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT = 8;

/** SHA-256 bearer fingerprint, so superseded OAuth token bytes never enter the identity cache. */
function fingerprintOAuthBearer(bearer: string): string {
	return createHash("sha256").update(bearer).digest("base64url");
}
const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
/**
 * Anthropic-only idle window after which a session's pinned credential no
 * longer suppresses usage-based re-ranking. Anthropic caps OAuth prompt-cache
 * retention at `ttl: "1h"` (ephemeral ~5min otherwise), so after this long
 * without an Anthropic resolve the conversation-prefix cache is no longer
 * guaranteed warm. Other providers retain indefinite stickiness until their
 * own cache lifetimes are verified.
 */
const ANTHROPIC_SESSION_STICKY_CACHE_WARM_MS = 60 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Credential Types
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	source?: "login";
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

/** One persisted rate-limit block: credential row id + provider-type key + optional scope. */
export interface StoredCredentialBlock {
	/** SQLite row id of the credential (auth_credentials.id). */
	credentialId: number;
	/** `${provider}:${credentialType}` — same value as AuthStorage's in-memory providerKey. */
	providerKey: string;
	/** Block scope (e.g. "tier:fable"); empty string = unscoped. Never NUL-delimited. */
	blockScope: string;
	/** Epoch milliseconds. */
	blockedUntilMs: number;
	/** Last row update timestamp in epoch milliseconds, when provided by the backing store. */
	updatedAtMs?: number;
}

/**
 * Identity slice of a disabled (soft-deleted) credential tombstone — cause and
 * account identity only, never token material. Surfaced so auto-disabled
 * accounts (e.g. an expired Anthropic OAuth grant) stay visible in `omp usage`
 * instead of silently vanishing until the user notices missing quota.
 */
export interface DisabledCredentialSummary {
	/** Database row id (matches {@link StoredAuthCredential.id}). */
	id: number;
	provider: string;
	type: AuthCredential["type"];
	email?: string;
	accountId?: string;
	/** Organization/workspace the credential was scoped to (Anthropic/ChatGPT multi-subscription). */
	orgId?: string;
	orgName?: string;
	/** Verbatim disable cause captured when the row was torn down. */
	cause: string;
	/** Epoch ms the row was disabled (SQLite `updated_at`), when known. */
	disabledAtMs?: number;
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
	/** OAuth account id if known. */
	accountId?: string;
	/** Organization/workspace the credential is scoped to (Anthropic/ChatGPT multi-subscription). */
	orgId?: string;
	orgName?: string;
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
export interface CredentialRefreshLeaseFence {
	owner: string;
	nowMs: number;
}

export interface AuthCredentialStore {
	close(): void;
	/**
	 * Stateful probe for commits made by another process to the backing store.
	 * Returns true once per observed change.
	 */
	pollExternalChanges?(): boolean;
	/** Record the current auth revision after a local mutation already notified consumers. */
	acknowledgeLocalChanges?(): void;
	/** Optional hook to notify the underlying store that usage report cache is stale. */
	invalidateUsageCache?(signal?: AbortSignal): Promise<void>;
	listAuthCredentials(provider?: string): StoredAuthCredential[];
	/**
	 * Optional store hook to re-hydrate the credential snapshot from its
	 * backing source. Remote broker stores re-fetch `GET /v1/snapshot` so a
	 * disk-cached snapshot (up to an hour stale) cannot be paired with live
	 * per-credential data; local SQLite stores omit it — their reads are
	 * always current.
	 */
	refreshSnapshot?(): Promise<unknown>;
	/**
	 * Disabled credential tombstones (see {@link DisabledCredentialSummary}).
	 * Optional: remote stores forward to the broker's
	 * `GET /v1/credentials/disabled` (empty list when the broker predates the
	 * endpoint); stores without tombstones omit it.
	 */
	listDisabledCredentials?(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]>;
	updateAuthCredential(id: number, credential: AuthCredential): void;
	deleteAuthCredential(id: number, disabledCause: string): void;
	tryDisableAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		disabledCause: string,
		lease?: CredentialRefreshLeaseFence,
	): boolean;
	tryUpdateAuthCredentialIfMatches?(
		id: number,
		expectedData: string,
		credential: AuthCredential,
		lease?: CredentialRefreshLeaseFence,
	): boolean;
	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[];
	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[];
	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void;
	getCache(key: string, options?: { includeExpired?: boolean }): string | null;
	setCache(key: string, value: string, expiresAtSec: number): void;
	/** Drop all cache rows whose keys start with the supplied prefix. */
	deleteCachePrefix?(prefix: string): void;
	cleanExpiredCache(): void;
	/** Non-expired block for one (credential, providerKey, scope) key, or undefined. */
	getCredentialBlock?(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	/** Earliest time a shared-store block should be eligible for live-usage reconciliation. */
	getCredentialBlockReconcileAfter?(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	/** Upsert with MAX semantics: keep the later blockedUntilMs on conflict. */
	upsertCredentialBlock?(block: StoredCredentialBlock): void;
	/** Drop one block row for a credential/provider/scope key. */
	deleteCredentialBlock?(credentialId: number, providerKey: string, blockScope: string): void;
	/** Drop every block row for a credential (all providerKeys/scopes). */
	deleteCredentialBlocks?(credentialId: number): void;
	/** Prune rows with blocked_until_ms <= nowMs. */
	cleanExpiredCredentialBlocks?(nowMs: number): void;
	/** List non-expired blocks for broker snapshots. */
	listCredentialBlocks?(credentialIds: readonly number[]): StoredCredentialBlock[];
	tryAcquireCredentialRefreshLease?(credentialId: number, owner: string, expiresAtMs: number): boolean;
	getCredentialRefreshLeaseExpiresAt?(credentialId: number): number | undefined;
	releaseCredentialRefreshLease?(credentialId: number, owner: string): void;
	renewCredentialRefreshLease?(credentialId: number, owner: string, expiresAtMs: number): boolean;
	/**
	 * Append usage-limit snapshots for trend history. Optional: stores without
	 * durable storage (e.g. the broker remote store) omit it and recording is
	 * skipped — the broker host records into its own database instead.
	 */
	recordUsageSnapshots?(entries: UsageHistoryEntry[]): void;
	/** Read recorded usage-limit snapshots, oldest first. */
	listUsageHistory?(query?: UsageHistoryQuery): UsageHistoryEntry[];
	/**
	 * Client hook: forward locally observed request usage. Remote broker stores
	 * batch these to the broker so it can attribute token burn per install;
	 * local stores omit it and observation is skipped.
	 * `client` overrides the reporting identity (gateway requests attribute to
	 * the originating client, not the gateway host).
	 */
	recordObservedUsage?(entries: ObservedUsageEntry[], client?: ClientUsageIdentity): void;
	/** Broker host: persist one client's observed-usage report. */
	recordClientUsage?(report: ClientUsageReport): void;
	/** Broker host: aggregate recorded per-client usage since a timestamp. */
	getClientUsageSummary?(sinceMs: number): ClientUsageSummary;
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
	 * Optional store hook to ingest a parsed provider usage report for one OAuth
	 * credential. Remote broker stores use this to overlay header-derived limits
	 * onto their cached aggregate `/v1/usage` response without mutating broker
	 * state.
	 */
	ingestUsageReport?(provider: Provider, credential: OAuthCredential, report: UsageReport): boolean;
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
	const envValue = $envExact(config);
	return envValue || config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Providers (defaults)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_USAGE_PROVIDERS: UsageProvider[] = [
	alibabaTokenPlanUsageProvider,
	openaiCodexUsageProvider,
	kimiUsageProvider,
	minimaxCodeUsageProvider,
	antigravityUsageProvider,
	googleGeminiCliUsageProvider,
	ollamaUsageProvider,
	ollamaCloudUsageProvider,
	claudeUsageProvider,
	clinePassUsageProvider,
	zaiUsageProvider,
	umansUsageProvider,
	opencodeGoUsageProvider,
	githubCopilotUsageProvider,
	cursorUsageProvider,
	syntheticUsageProvider,
	xaiOauthUsageProvider,
	devinUsageProvider,
];

const DEFAULT_USAGE_PROVIDER_MAP = new Map<Provider, UsageProvider>(
	DEFAULT_USAGE_PROVIDERS.map(provider => [provider.id, provider]),
);

const USAGE_CACHE_PREFIX = "usage_cache:";
const USAGE_FORCE_REFRESH_CACHE_PREFIX = "force-refresh:";
const USAGE_HEADER_INGEST_INTERVAL_MS = 60_000;
const USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000;
/**
 * Per-credential cool-down after a usage fetch fails. While this window is
 * active we serve the last successful value to avoid dropping the credential
 * from the report; without a previous value we just return null and retry
 * on the next poll.
 */
const USAGE_FAILURE_BACKOFF_MS = 10_000;
/**
 * A manual invalidation persists across the next CLI process and serializes
 * same-provider probes, avoiding a cold-account burst against IP-limited
 * upstream usage endpoints.
 */
const USAGE_FORCE_REFRESH_TTL_MS = 5 * 60_000;
// Bumped from 3s — Claude usage retries up to 3 times with exponential backoff
// (~3.5s total worst case); a tight per-request budget aborts retries mid-cycle.
const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 10_000;
const USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES: Partial<Record<Provider, number>> = {
	"google-antigravity": 2,
	zai: 2,
	// v2: retires cached reports from the OMP-observed spend estimator (dollar
	// units) now that limits come from the upstream percent-based `/usage`
	// endpoint; the 24h last-good retention would otherwise keep serving them.
	"opencode-go": 2,
	// v2: cache identity gained an `org:` component so two subscriptions on one
	// account email stop sharing a slot. v3 retires parsed reports created before
	// Anthropic extra-usage rows existed; header ingestion can otherwise keep
	// renewing those incomplete reports throughout the 24h last-good retention.
	anthropic: 3,
};
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;
const OAUTH_REFRESH_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
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
const OAUTH_REFRESH_LEASE_TTL_MS = 15_000;
const OAUTH_REFRESH_LEASE_POLL_MS = 50;
const OAUTH_REFRESH_LEASE_RENEW_MS = 5_000;
const OAUTH_REFRESH_OPERATION_TIMEOUT_MS = 10_000;
/**
 * Cap on the buffered credential_disabled backlog held while no handler is attached.
 * In practice the backlog is 0–N where N ≈ active providers (≤ ~20). The cap exists so
 * pathological detach-without-reattach loops can't grow memory unboundedly.
 */
const MAX_PENDING_DISABLED_EVENTS = 32;

// Re-exported from the error module (its new home) to preserve the public
// `@oh-my-pi/pi-ai` entrypoint and the in-module call sites below.
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

export type ModelUsageHealthState = "healthy" | "reserve" | "depleted" | "unknown";

export interface ModelUsageAccountHealth {
	credentialId: number;
	credentialType: AuthCredential["type"];
	/** True when this credential is currently sticky for options.sessionId. */
	selected?: true;
	state: ModelUsageHealthState;
	remainingFraction?: number;
	resetsAt?: number;
}

export interface ModelUsageHealth {
	state: ModelUsageHealthState;
	accounts: ModelUsageAccountHealth[];
}

export interface ModelUsageHealthOptions {
	modelId?: string;
	sessionId?: string;
	baseUrl?: string;
	reserveFraction: number;
	signal?: AbortSignal;
}

type UsageCacheEntry<T> = {
	value: T;
	expiresAt: number;
};

interface UsageCache {
	get<T>(key: string): UsageCacheEntry<T> | undefined;
	getStale<T>(key: string): UsageCacheEntry<T> | undefined;
	set<T>(key: string, entry: UsageCacheEntry<T>): void;
	deletePrefix(prefix: string): boolean;
	cleanup?(): void;
}

type UsageRequestDescriptor = {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
};

type ForcedUsageRefresh = {
	all: boolean;
	providers: Set<Provider>;
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
type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential; credentialId?: number };

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
	/** Organization/workspace the credential is scoped to (Anthropic/ChatGPT multi-subscription). */
	orgId?: string;
	orgName?: string;
}

/**
 * Identity slice of the credential a successful {@link AuthStorage.login}
 * stored — lets callers confirm WHICH account (and for Anthropic, which
 * organization/subscription) was added, without exposing tokens.
 */
export interface OAuthLoginIdentity {
	type: "oauth" | "api_key";
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
}

export interface OAuthAccessFailure {
	credentialId?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;
	/** Organization/workspace the credential is scoped to (Anthropic/ChatGPT multi-subscription). */
	orgId?: string;
	orgName?: string;
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
	/** Organization/workspace the credential is scoped to (Anthropic/ChatGPT multi-subscription). */
	orgId?: string;
	orgName?: string;
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
	/** Organization/workspace the credential is scoped to (Anthropic/ChatGPT multi-subscription). */
	orgId?: string;
	orgName?: string;
	/** True when this account is the session-sticky OAuth credential requested by `listOAuthAccounts`. */
	active: boolean;
}
export interface InvalidateCredentialMatchingOptions {
	signal?: AbortSignal;
	sessionId?: string;
}

/** Options for refreshing one stored OAuth row through durable ownership. */
export interface StoredOAuthRefreshOptions<T extends OAuthCredential = OAuthCredential> {
	/** Stable row id when a provider has multiple OAuth credentials. */
	credentialId?: number;
	observedCredential?: T;
	credentialFromRow: (credential: OAuthCredential) => T | undefined;
	forceRefresh?: boolean;
	canRefresh?: (credential: T) => boolean;
	refreshSkewMs?: number;
	signal?: AbortSignal;
	keepCredentialOnRefreshFailure?: boolean | ((error: unknown) => boolean);
	onRefreshFailure?: (error: unknown) => void;
	refreshTimeoutMs?: number;
	refresh: (credential: T, signal?: AbortSignal) => Promise<OAuthCredentials>;
	mergeRefreshedCredential?: (credential: T, refreshed: OAuthCredentials) => T;
	isDefinitiveFailure?: (error: unknown) => boolean;
	disabledCause?: (error: unknown) => string;
}

/** Result of a stored OAuth refresh attempt. */
export interface StoredOAuthRefreshResult<T extends OAuthCredential = OAuthCredential> {
	credential: T | undefined;
	refreshed: boolean;
	removed: boolean;
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
	 * `credit_list_failed` (transport/auth failure while listing credits —
	 * retryable, unlike a genuine `no_credit`), `http_<status>` (unexpected
	 * HTTP).
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

type OpenAICodexPlanRequirement = "none" | "paid" | "pro";
type OpenAICodexPlanClass = "free" | "paid" | "pro" | "unknown";

const OPENAI_CODEX_PRO_PLAN_TOKENS: Record<string, true> = {
	pro: true,
};
const OPENAI_CODEX_PAID_PLAN_TOKENS: Record<string, true> = {
	plus: true,
	business: true,
	team: true,
	enterprise: true,
	edu: true,
	education: true,
	teacher: true,
	teachers: true,
	health: true,
	gov: true,
	government: true,
};
const OPENAI_CODEX_FREE_PLAN_TOKENS: Record<string, true> = {
	free: true,
	go: true,
};

/**
 * Account tier needed for model-aware Codex OAuth routing.
 *
 * GPT-5.6 Terra (including its local pro-mode alias) remains available on every
 * plan. Sol and Luna pro-mode aliases inherit their base models' paid tier;
 * only Spark currently has a documented Pro-plan preference in Codex.
 */
function resolveOpenAICodexPlanRequirement(provider: string, modelId: string | undefined): OpenAICodexPlanRequirement {
	if (provider !== "openai-codex" || typeof modelId !== "string") return "none";
	return (planRequirementFor("openai-codex", modelId) as OpenAICodexPlanRequirement | undefined) ?? "none";
}

const MODEL_ACCOUNT_POLICY_BLOCK_SCOPE_PREFIX = "model-policy:";
const MODEL_ACCOUNT_POLICY_PROVIDERS: Readonly<Record<string, true>> = {
	"openai-codex": true,
	cursor: true,
};

function modelAccountPolicyBlockScope(provider: string, modelId: string | undefined): string | undefined {
	if (!Object.hasOwn(MODEL_ACCOUNT_POLICY_PROVIDERS, provider) || typeof modelId !== "string") return undefined;
	const separator = modelId.lastIndexOf("/");
	const bareModelId = (separator === -1 ? modelId : modelId.slice(separator + 1)).trim().toLowerCase();
	if (!bareModelId || bareModelId.includes("\0")) return undefined;
	return `${MODEL_ACCOUNT_POLICY_BLOCK_SCOPE_PREFIX}${bareModelId}`;
}

function credentialBlockScopesForRequest(
	provider: string,
	strategy: CredentialRankingStrategy | undefined,
	rankingContext: CredentialRankingContext,
	blockScope: string | undefined,
): readonly string[] {
	const scopes = strategy?.blockScopes?.(rankingContext) ?? (blockScope ? [blockScope] : []);
	const modelPolicyScope = modelAccountPolicyBlockScope(provider, rankingContext.modelId);
	if (!modelPolicyScope || scopes.includes(modelPolicyScope)) return scopes;
	return [...scopes, modelPolicyScope];
}

function getUsagePlanType(report: UsageReport | null): string | undefined {
	const metadata = report?.metadata;
	if (!metadata) return undefined;
	const planType = metadata.planType;
	if (typeof planType !== "string") return undefined;
	const normalized = planType
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized.startsWith("chatgpt_") ? normalized.slice("chatgpt_".length) : normalized;
}

function classifyOpenAICodexPlan(report: UsageReport | null): OpenAICodexPlanClass {
	const planType = getUsagePlanType(report);
	if (!planType) return "unknown";
	// Pro Lite is a paid Codex tier, but does not imply full Pro-only model access.
	if (planType === "prolite" || planType === "pro_lite") return "paid";
	const tokens = planType.split("_");
	if (tokens.some(token => OPENAI_CODEX_PRO_PLAN_TOKENS[token] === true)) return "pro";
	if (tokens.some(token => OPENAI_CODEX_PAID_PLAN_TOKENS[token] === true)) return "paid";
	if (tokens.some(token => OPENAI_CODEX_FREE_PLAN_TOKENS[token] === true)) return "free";
	return "unknown";
}

function getOpenAICodexPlanEligibility(
	report: UsageReport | null,
	requirement: OpenAICodexPlanRequirement,
): boolean | undefined {
	if (requirement === "none") return true;
	const planClass = classifyOpenAICodexPlan(report);
	if (planClass === "unknown") return undefined;
	return requirement === "paid" ? planClass !== "free" : planClass === "pro";
}

function getOpenAICodexPlanPriority(report: UsageReport | null, requirement: OpenAICodexPlanRequirement): number {
	const eligibility = getOpenAICodexPlanEligibility(report, requirement);
	return eligibility === true ? 0 : eligibility === undefined ? 1 : 2;
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
	["alibaba-token-plan", alibabaTokenPlanRankingStrategy],
	["openai-codex", codexRankingStrategy],
	["anthropic", claudeRankingStrategy],
	["google-antigravity", antigravityRankingStrategy],
	["kimi-code", kimiRankingStrategy],
	["zai", zaiRankingStrategy],
	["opencode-go", opencodeGoRankingStrategy],
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

	deletePrefix(prefix: string): boolean {
		if (!this.store.deleteCachePrefix) return false;
		this.store.deleteCachePrefix(`${USAGE_CACHE_PREFIX}${prefix}`);
		return true;
	}

	cleanup(): void {
		this.store.cleanExpiredCache();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory representation
// ─────────────────────────────────────────────────────────────────────────────

type StoredCredential = { id: number; credential: AuthCredential };
type CredentialSelection<T extends AuthCredential> = { credential: T; index: number };
type OAuthSelection = CredentialSelection<OAuthCredential>;
type ApiKeySelection = CredentialSelection<ApiKeyCredential>;
type StoredOAuthSelection = { credentialId: number; credential: OAuthCredential; index: number };

type UsageCandidate<T extends AuthCredential> = {
	selection: CredentialSelection<T>;
	usage: UsageReport | null;
	usageChecked: boolean;
};

type OAuthCandidate = UsageCandidate<OAuthCredential>;
type ApiKeyCandidate = UsageCandidate<ApiKeyCredential>;
type UsageRankingResult<T extends AuthCredential> = UsageCandidate<T> & { blockedUntil: number | undefined };

type CredentialBlockRouting = {
	providerKey: string;
	strategy: CredentialRankingStrategy | undefined;
	rankingContext: CredentialRankingContext;
	blockScope: string | undefined;
	siblingBlockScopes: readonly string[];
};

type UsageRankedCandidate<T extends AuthCredential> = UsageCandidate<T> & {
	blocked: boolean;
	blockedUntil?: number;
	hasPriorityBoost: boolean;
	usageMeasured: boolean;
	planPriority: number;
	secondaryUsed: number;
	secondaryRequiredDrain: number;
	primaryUsed: number;
	primaryRequiredDrain: number;
	orderPos: number;
};
type RankedOAuthCandidate = UsageRankedCandidate<OAuthCredential>;
type RankedApiKeyCandidate = UsageRankedCandidate<ApiKeyCredential>;

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
	#sessionLastCredential: Map<
		string,
		Map<string, { type: AuthCredential["type"]; index: number; lastUsedAtMs?: number }>
	> = new Map();
	/** Recent bearer fingerprints resolved for each durable OAuth row; used only for delayed usage-limit attribution. */
	#oauthBearerFingerprints: Map<string, Map<number, string[]>> = new Map();
	/** Maps provider:type -> credentialIndex -> blockedUntilMs for temporary backoff. */
	#credentialBackoff: Map<string, Map<number, number>> = new Map();
	/** Earliest time a freshly-set in-memory block may be cleared by live usage reconciliation. */
	#credentialBackoffProbeAfter: Map<string, Map<number, number>> = new Map();
	/**
	 * Latched true once the persistent credential-block store reports an
	 * unrecoverable error (SQLite corruption / not-a-database). While set, every
	 * persisted-block read and write short-circuits for the life of the process:
	 * availability is preserved through {@link AuthStorage.#credentialBackoff}, but
	 * cross-process persistence is abandoned rather than re-querying a broken store
	 * on every credential evaluation.
	 */
	#persistedBlockStoreDamaged = false;
	#usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	/** Runtime extension providers take precedence over this configured/default resolver. */
	#runtimeUsageProviderOverrides: Map<Provider, { provider: UsageProvider; apiKey?: string }> = new Map();
	#usageReportCacheKeysByProvider: Map<Provider, Set<string>> = new Map();
	#rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	#usageCache: UsageCache;
	#usageCacheEpoch = 0;
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
		try {
			this.#store.cleanExpiredCredentialBlocks?.(Date.now());
		} catch (err) {
			// Best-effort, but init-time corruption must latch the block store
			// immediately so the first evaluation doesn't re-query a broken DB.
			this.#handlePersistedBlockStoreError(err);
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

	/**
	 * Reload state after another process commits to the backing store, then
	 * notify snapshot consumers even when only credential blocks changed.
	 */
	async pollExternalChanges(): Promise<boolean> {
		const pollExternalChanges = this.#store.pollExternalChanges?.bind(this.#store);
		if (!pollExternalChanges?.()) return false;
		const previousGeneration = this.#generation;
		await this.reload();
		if (this.#generation === previousGeneration) this.#bumpGeneration("external-store");
		return true;
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
		this.#store.acknowledgeLocalChanges?.();
		for (const listener of Array.from(this.#generationListeners)) {
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
	 * Install a runtime usage provider override (not persisted to disk).
	 *
	 * Runtime overrides are checked before the configured resolver, including its
	 * built-in fallback. Removing the override restores that resolver unchanged.
	 */
	setRuntimeUsageProvider(provider: Provider, usageProvider: UsageProvider, apiKey?: string): void {
		this.#runtimeUsageProviderOverrides.set(provider, { provider: usageProvider, apiKey });
		this.#invalidateUsageReportCacheForProvider(provider);
	}
	/** Remove a runtime usage provider override and restore configured/default resolution. */
	removeRuntimeUsageProvider(provider: Provider): void {
		if (!this.#runtimeUsageProviderOverrides.has(provider)) return;
		this.#invalidateUsageReportCacheForProvider(provider);
		this.#runtimeUsageProviderOverrides.delete(provider);
	}
	#resolveUsageProvider(provider: Provider): UsageProvider | undefined {
		return this.#runtimeUsageProviderOverrides.get(provider)?.provider ?? this.#usageProviderResolver?.(provider);
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
		let records: StoredAuthCredential[];
		try {
			records = this.#store.listAuthCredentials();
		} catch (err) {
			// Latch + surface repair guidance on corruption, but still fail the
			// reload: silently continuing with zero credentials would log the
			// user out of every provider without explanation.
			this.#handlePersistedBlockStoreError(err);
			throw err;
		}
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
		const trackedBearerFingerprints = this.#oauthBearerFingerprints.get(provider);
		if (trackedBearerFingerprints) {
			const activeOAuthIds = new Set(
				credentials.filter(entry => entry.credential.type === "oauth").map(entry => entry.id),
			);
			for (const credentialId of trackedBearerFingerprints.keys()) {
				if (!activeOAuthIds.has(credentialId)) trackedBearerFingerprints.delete(credentialId);
			}
			if (trackedBearerFingerprints.size === 0) this.#oauthBearerFingerprints.delete(provider);
		}
		if (credentials.length === 0) {
			this.#data.delete(provider);
		} else {
			this.#data.set(provider, credentials);
		}
		this.#bumpGeneration("credentials");
	}

	#recordOAuthBearerCredentialId(provider: string, bearer: string, credentialId: number | undefined): void {
		if (credentialId === undefined) return;
		const fingerprint = fingerprintOAuthBearer(bearer);
		const byCredentialId = this.#oauthBearerFingerprints.get(provider) ?? new Map<number, string[]>();
		const history = byCredentialId.get(credentialId) ?? [];
		const nextHistory = history.filter(previous => previous !== fingerprint);
		nextHistory.push(fingerprint);
		if (nextHistory.length > OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT) nextHistory.shift();
		byCredentialId.set(credentialId, nextHistory);
		this.#oauthBearerFingerprints.set(provider, byCredentialId);
	}

	#findOAuthCredentialIdForBearer(provider: string, bearer: string): number | undefined {
		const fingerprint = fingerprintOAuthBearer(bearer);
		for (const [credentialId, history] of this.#oauthBearerFingerprints.get(provider) ?? []) {
			if (history.includes(fingerprint)) return credentialId;
		}
		return undefined;
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

	/** Returns in-memory block expiry timestamp for a credential/key pair, cleaning up expired entries. */
	#getCredentialBlockedUntilForKey(backoffKey: string, credentialIndex: number, nowMs: number): number | undefined {
		const backoffMap = this.#credentialBackoff.get(backoffKey);
		if (!backoffMap) return undefined;
		const blockedUntil = backoffMap.get(credentialIndex);
		if (!blockedUntil) return undefined;
		if (blockedUntil <= nowMs) {
			backoffMap.delete(credentialIndex);
			if (backoffMap.size === 0) {
				this.#credentialBackoff.delete(backoffKey);
			}
			const probeAfterMap = this.#credentialBackoffProbeAfter.get(backoffKey);
			probeAfterMap?.delete(credentialIndex);
			if (probeAfterMap?.size === 0) this.#credentialBackoffProbeAfter.delete(backoffKey);
			return undefined;
		}
		return blockedUntil;
	}

	#readPersistedCredentialBlock(
		credentialId: number,
		providerKey: string,
		blockScope: string | undefined,
	): number | undefined {
		if (this.#persistedBlockStoreDamaged) return undefined;
		const getCredentialBlock = this.#store.getCredentialBlock?.bind(this.#store);
		if (!getCredentialBlock) return undefined;
		try {
			return getCredentialBlock(credentialId, providerKey, blockScope ?? "");
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) return undefined;
			logger.debug("Failed to read credential block from persistent store", {
				err,
				credentialId,
				providerKey,
				blockScope,
			});
			return undefined;
		}
	}

	#readPersistedCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number {
		if (this.#persistedBlockStoreDamaged) return 0;
		const getCredentialBlockReconcileAfter = this.#store.getCredentialBlockReconcileAfter?.bind(this.#store);
		if (!getCredentialBlockReconcileAfter) return 0;
		try {
			return getCredentialBlockReconcileAfter(credentialId, providerKey, blockScope) ?? 0;
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) return 0;
			// Advisory read: transient failures (e.g. SQLITE_BUSY) fall back to
			// the in-memory probe window, mirroring #readPersistedCredentialBlock.
			logger.debug("Failed to read credential block reconcile-after time from persistent store", {
				err,
				credentialId,
				providerKey,
				blockScope,
			});
			return 0;
		}
	}

	/** Returns block expiry timestamp for a credential, checking unscoped and scoped blocks. */
	#getCredentialBlockedUntil(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScopeOrScopes: string | readonly string[] | undefined = undefined,
	): number | undefined {
		const nowMs = Date.now();
		// A request honours its own scope plus any legacy catch-all scope, so a
		// block written before backoff was scoped still applies to everything.
		const scopes = (
			typeof blockScopeOrScopes === "string" ? [blockScopeOrScopes] : (blockScopeOrScopes ?? [])
		).filter(scope => scope.length > 0);
		let blockedUntil = this.#getCredentialBlockedUntilForKey(providerKey, credentialIndex, nowMs);
		for (const blockScope of scopes) {
			const scopedBlockedUntil = this.#getCredentialBlockedUntilForKey(
				this.#toScopedBackoffKey(providerKey, blockScope),
				credentialIndex,
				nowMs,
			);
			if (scopedBlockedUntil !== undefined && (blockedUntil === undefined || scopedBlockedUntil > blockedUntil)) {
				blockedUntil = scopedBlockedUntil;
			}
		}

		const credentialId = this.#getStoredCredentials(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return blockedUntil;
		const persistedGlobalBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, "");
		if (
			persistedGlobalBlockedUntil !== undefined &&
			(blockedUntil === undefined || persistedGlobalBlockedUntil > blockedUntil)
		) {
			blockedUntil = persistedGlobalBlockedUntil;
		}
		for (const blockScope of scopes) {
			const persistedScopedBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, blockScope);
			if (
				persistedScopedBlockedUntil !== undefined &&
				(blockedUntil === undefined || persistedScopedBlockedUntil > blockedUntil)
			) {
				blockedUntil = persistedScopedBlockedUntil;
			}
		}
		return blockedUntil;
	}

	/** Checks if a credential is temporarily blocked due to usage limits. */
	#isCredentialBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope: string | readonly string[] | undefined = undefined,
	): boolean {
		return this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope) !== undefined;
	}

	/** Marks a credential as blocked until the specified time. */
	#markCredentialBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockedUntilMs: number,
		blockScope: string | undefined = undefined,
	): void {
		const backoffKey = this.#toScopedBackoffKey(providerKey, blockScope);
		const backoffMap = this.#credentialBackoff.get(backoffKey) ?? new Map<number, number>();
		const existing = backoffMap.get(credentialIndex) ?? 0;
		const nextBlockedUntil = Math.max(existing, blockedUntilMs);
		backoffMap.set(credentialIndex, nextBlockedUntil);
		this.#credentialBackoff.set(backoffKey, backoffMap);
		const probeAfterMap = this.#credentialBackoffProbeAfter.get(backoffKey) ?? new Map<number, number>();
		probeAfterMap.set(credentialIndex, Math.min(nextBlockedUntil, Date.now() + USAGE_REPORT_TTL_MS));
		this.#credentialBackoffProbeAfter.set(backoffKey, probeAfterMap);
		this.#invalidateUsageReportCache(provider);

		const upsertCredentialBlock = this.#store.upsertCredentialBlock?.bind(this.#store);
		if (!upsertCredentialBlock || this.#persistedBlockStoreDamaged) return;
		const credentialId = this.#getStoredCredentials(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return;
		try {
			upsertCredentialBlock({
				credentialId,
				providerKey,
				blockScope: blockScope ?? "",
				blockedUntilMs: nextBlockedUntil,
			});
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) return;
			logger.debug("Failed to persist credential block", {
				err,
				credentialId,
				provider,
				providerKey,
				blockScope,
				blockedUntilMs: nextBlockedUntil,
			});
		}
	}

	#handlePersistedBlockStoreError(err: unknown): boolean {
		if (!isSqliteCorruptionError(err)) return false;
		this.#reportDamagedBlockStore(err);
		return true;
	}

	#assertPersistedBlockStoreWritable(): void {
		if (!this.#persistedBlockStoreDamaged) return;
		const store = this.#sourceLabel ?? `local ${getAgentDbPath()}`;
		throw new Error(`Persistent credential block store ${store} is unavailable after SQLite corruption`);
	}

	/**
	 * Latches {@link AuthStorage.#persistedBlockStoreDamaged} on the first
	 * unrecoverable persisted-block store error and surfaces it once at `error`
	 * level with the store location, so an operator can repair or replace it.
	 * Later reads/writes short-circuit silently — the in-memory backoff map keeps
	 * rate-limit blocks applying for the life of the process; only cross-process
	 * persistence is lost.
	 */
	#reportDamagedBlockStore(err: unknown): void {
		if (this.#persistedBlockStoreDamaged) return;
		this.#persistedBlockStoreDamaged = true;
		const store = this.#sourceLabel ?? `local ${getAgentDbPath()}`;
		logger.error(
			"Persistent credential store is corrupt; cross-process rate-limit persistence is disabled for this process. In-memory backoff still applies. Repair the store with `sqlite3 <path> '.recover'` or delete it to recreate on next login.",
			{ err, store },
		);
	}

	/**
	 * Records which credential was used for a session (for rate-limit switching).
	 * `lastUsedAtMs` backdates the sticky (session-file pin restores on resume);
	 * it defaults to now for live selections.
	 */
	#recordSessionCredential(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
		lastUsedAtMs?: number,
	): void {
		if (!sessionId) return;
		const nowMs = lastUsedAtMs ?? Date.now();
		const sessionMap = this.#sessionLastCredential.get(provider) ?? new Map();
		sessionMap.set(sessionId, { type, index, lastUsedAtMs: nowMs });
		this.#sessionLastCredential.set(provider, sessionMap);

		try {
			const credentialId = this.#getStoredCredentials(provider)[index]?.id;
			if (credentialId !== undefined) {
				const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
				const cacheValue = JSON.stringify({ type, index, credentialId, lastUsedAtMs: nowMs });
				// Expires in 30 days
				const expiresAtSec = Math.floor(nowMs / 1000) + 30 * 24 * 60 * 60;
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
	): { type: AuthCredential["type"]; index: number; lastUsedAtMs?: number } | undefined {
		if (!sessionId) return undefined;
		let sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap?.has(sessionId)) {
			return sessionMap.get(sessionId);
		}
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			const raw = this.#store.getCache(cacheKey);
			if (raw) {
				const val = JSON.parse(raw) as {
					type: AuthCredential["type"];
					index: number;
					credentialId?: number;
					lastUsedAtMs?: number;
				};

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
				const sessionVal = { type: val.type, index: val.index, lastUsedAtMs: val.lastUsedAtMs };
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
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
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
		filter?: (credential: AuthCredential) => boolean,
	): { credential: Extract<AuthCredential, { type: T }>; index: number } | undefined {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: Extract<AuthCredential, { type: T }>; index: number } => {
				if (entry.credential.type !== type) return false;
				return filter?.(entry.credential) ?? true;
			});

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.#getProviderTypeKey(provider, type);
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];

		for (const idx of order) {
			const candidate = credentials[idx];
			if (!this.#isCredentialBlocked(provider, providerKey, candidate.index)) {
				return candidate;
			}
		}

		return fallback;
	}

	async #rankApiKeySelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		credentials: ApiKeySelection[];
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
		rankingContext: CredentialRankingContext;
		blockScope?: string;
		/** Scopes a block may live under for this request; reads honour all of them. */
		blockScopes?: readonly string[];
	}): Promise<ApiKeyCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedApiKeyCandidate[] = [];
		const usageTimeout = Math.max(5000, this.#usageRequestTimeoutMs * 1.5);
		const usagePromise: Promise<Array<UsageRankingResult<ApiKeyCredential> | null>> = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				if (blockedUntil !== undefined) {
					return { selection, usage: null, usageChecked: false, blockedUntil };
				}
				const usage = await this.#getUsageReport(args.provider, selection.credential, {
					...args.options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				return { selection, usage, usageChecked: true, blockedUntil: undefined };
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			if (result) return result;
			return args.order.map(idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				return { selection, usage: null, usageChecked: false, blockedUntil };
			});
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
				this.#markCredentialBlocked(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
				);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const usageMeasured = primary !== undefined || secondary !== undefined;
			const primaryUncapped = primary === undefined && secondary !== undefined;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				usageMeasured,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary, primaryUncapped, args.rankingContext) ?? false,
				planPriority: 0,
				secondaryUsed: this.#normalizeUsageFraction(secondary),
				secondaryRequiredDrain: this.#computeWindowRequiredDrain(
					secondary,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: this.#normalizeUsageFraction(primary),
				primaryRequiredDrain: this.#computeWindowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return this.#orderUsageRankedCandidates(ranked, "none");
	}

	async #selectApiKeyCredential(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		filter?: (credential: ApiKeyCredential) => boolean,
	): Promise<ApiKeySelection | undefined> {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is ApiKeySelection => {
				if (entry.credential.type !== "api_key") return false;
				return filter?.(entry.credential) ?? true;
			});

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.#getProviderTypeKey(provider, "api_key");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];
		const strategy = this.#rankingStrategyResolver?.(provider);
		if (!strategy) {
			for (const idx of order) {
				const candidate = credentials[idx];
				if (!this.#isCredentialBlocked(provider, providerKey, candidate.index)) {
					return candidate;
				}
			}
			return fallback;
		}

		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const candidates = await this.#rankApiKeySelections({
			providerKey,
			provider,
			order,
			credentials,
			options,
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
		});
		return candidates[0]?.selection ?? fallback;
	}

	#clearProviderSessionCredentialCache(provider: string): void {
		try {
			this.#store.deleteCachePrefix?.(`${SESSION_STICKY_CACHE_PREFIX}${provider}:`);
		} catch (err) {
			logger.debug("Failed to clear provider session sticky credentials from persistent store cache", { err });
		}
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
		this.#clearProviderSessionCredentialCache(provider);
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
	 * Persist a refreshed credential by id only while the row still matches this
	 * process's snapshot. A peer rotation wins the CAS and is reloaded instead of
	 * being overwritten after this process releases its refresh lease.
	 *
	 * Returns the row's current index, or -1 when it was disabled or removed.
	 */
	#replaceCredentialById(provider: string, id: number, credential: AuthCredential): number {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === id);
		if (index === -1) return -1;
		const expected = serializeCredential(provider, entries[index]!.credential);
		if (
			expected &&
			this.#store.tryUpdateAuthCredentialIfMatches &&
			!this.#store.tryUpdateAuthCredentialIfMatches(id, expected.data, credential)
		) {
			const latest = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				latest.map(row => ({ id: row.id, credential: row.credential })),
			);
			return latest.findIndex(row => row.id === id);
		}
		if (!expected || !this.#store.tryUpdateAuthCredentialIfMatches) {
			this.#store.updateAuthCredential(id, credential);
		}
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

	/**
	 * Refresh one stored OAuth credential under durable row ownership.
	 */
	async refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>> {
		const refreshSkewMs = options.refreshSkewMs ?? OAUTH_REFRESH_SKEW_MS;
		const hasDurableLease =
			!!this.#store.tryAcquireCredentialRefreshLease &&
			!!this.#store.getCredentialRefreshLeaseExpiresAt &&
			!!this.#store.releaseCredentialRefreshLease &&
			!!this.#store.renewCredentialRefreshLease;
		const owner = crypto.randomUUID();
		let leasedCredentialId: number | undefined;

		while (hasDurableLease) {
			if (options.signal?.aborted) throw new AIError.AbortError("OAuth refresh ownership aborted by caller");
			const rows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				rows.map(row => ({ id: row.id, credential: row.credential })),
			);
			const row = rows.find(
				entry =>
					entry.credential.type === "oauth" &&
					(options.credentialId === undefined || entry.id === options.credentialId),
			);
			if (row?.credential.type !== "oauth") {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const current = options.credentialFromRow(row.credential);
			if (!current) {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const currentIsFresh = Date.now() + refreshSkewMs < current.expires;
			// A peer rotated the credential out from under the caller's observation.
			// Adopt the stored copy only when it is still usable; a stored copy that
			// is itself expired must fall through to a refresh rather than be handed
			// back and fail the downstream `getOAuthApiKey` expiry precondition.
			if (
				options.observedCredential &&
				!authCredentialEquals(current, options.observedCredential) &&
				currentIsFresh
			) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (!options.forceRefresh && currentIsFresh) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (options.canRefresh && !options.canRefresh(current)) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (this.#store.tryAcquireCredentialRefreshLease?.(row.id, owner, Date.now() + OAUTH_REFRESH_LEASE_TTL_MS)) {
				leasedCredentialId = row.id;
				break;
			}
			const leaseExpiresAt = this.#store.getCredentialRefreshLeaseExpiresAt?.(row.id);
			const waitMs =
				leaseExpiresAt === undefined
					? OAUTH_REFRESH_LEASE_POLL_MS
					: Math.min(Math.max(leaseExpiresAt - Date.now(), OAUTH_REFRESH_LEASE_POLL_MS), 250);
			await raceCredentialRefreshWithSignal(
				Bun.sleep(waitMs),
				options.signal,
				"OAuth refresh ownership wait aborted by caller",
			);
		}

		try {
			const rows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				rows.map(row => ({ id: row.id, credential: row.credential })),
			);
			const row = rows.find(
				entry =>
					entry.credential.type === "oauth" &&
					(options.credentialId === undefined || entry.id === options.credentialId),
			);
			if (row?.credential.type !== "oauth") {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const current = options.credentialFromRow(row.credential);
			if (!current) {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const currentIsFresh = Date.now() + refreshSkewMs < current.expires;
			// Re-check after acquiring the lease: only adopt the stored copy on an
			// observed mismatch when it is still usable, mirroring the pre-lease guard.
			if (
				options.observedCredential &&
				!authCredentialEquals(current, options.observedCredential) &&
				currentIsFresh
			) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (!options.forceRefresh && currentIsFresh) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (options.canRefresh && !options.canRefresh(current)) {
				return { credential: current, refreshed: false, removed: false };
			}
			const serialized = serializeCredential(provider, current);
			if (!serialized) return { credential: current, refreshed: false, removed: false };

			let stopLeaseRenewal = false;
			let leaseRenewalError: unknown;
			const leaseRenewalStopped = Promise.withResolvers<void>();
			const leaseRenewal =
				leasedCredentialId !== undefined
					? (async () => {
							while (!stopLeaseRenewal) {
								await Promise.race([Bun.sleep(OAUTH_REFRESH_LEASE_RENEW_MS), leaseRenewalStopped.promise]);
								if (stopLeaseRenewal) return;
								const renewed = this.#store.renewCredentialRefreshLease?.(
									leasedCredentialId,
									owner,
									Date.now() + OAUTH_REFRESH_LEASE_TTL_MS,
								);
								if (!renewed) {
									throw new AIError.ConfigurationError("OAuth refresh ownership was lost before persistence");
								}
							}
						})().catch(error => {
							leaseRenewalError = error;
						})
					: undefined;
			const refreshAbort = new AbortController();
			const refreshTimeout = setTimeout(() => {
				refreshAbort.abort(
					new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					}),
				);
			}, options.refreshTimeoutMs ?? OAUTH_REFRESH_OPERATION_TIMEOUT_MS);

			let refreshed: OAuthCredentials;
			try {
				try {
					refreshed = await options.refresh(current, refreshAbort.signal);
				} catch (error) {
					if (options.isDefinitiveFailure?.(error)) {
						const disabledCause = options.disabledCause?.(error) ?? `oauth refresh failed: ${String(error)}`;
						const disabled = this.#store.tryDisableAuthCredentialIfMatches(
							row.id,
							serialized.data,
							disabledCause,
							leasedCredentialId !== undefined ? { owner, nowMs: Date.now() } : undefined,
						);
						if (disabled) {
							this.#setStoredCredentials(
								provider,
								rows
									.filter(entry => entry.id !== row.id)
									.map(entry => ({ id: entry.id, credential: entry.credential })),
							);
							this.#resetProviderAssignments(provider);
							this.#emitCredentialDisabled({ provider, disabledCause });
							return { credential: undefined, refreshed: false, removed: true };
						}
						await this.reload();
						const latest = this.#getStoredCredentials(provider).find(entry => entry.id === row.id)?.credential;
						return {
							credential: latest?.type === "oauth" ? options.credentialFromRow(latest) : undefined,
							refreshed: false,
							removed: false,
						};
					}
					options.onRefreshFailure?.(error);
					const keepCredential =
						typeof options.keepCredentialOnRefreshFailure === "function"
							? options.keepCredentialOnRefreshFailure(error)
							: options.keepCredentialOnRefreshFailure === true;
					if (keepCredential) {
						return { credential: current, refreshed: false, removed: false };
					}
					throw error;
				}
			} finally {
				stopLeaseRenewal = true;
				leaseRenewalStopped.resolve();
				await leaseRenewal;
				clearTimeout(refreshTimeout);
			}
			if (leaseRenewalError) throw leaseRenewalError;

			const merged: T = options.mergeRefreshedCredential
				? options.mergeRefreshedCredential(current, refreshed)
				: {
						...current,
						access: refreshed.access,
						refresh: refreshed.refresh,
						expires: refreshed.expires,
						accountId: refreshed.accountId ?? current.accountId,
						email: refreshed.email ?? current.email,
						projectId: refreshed.projectId ?? current.projectId,
						enterpriseUrl: refreshed.enterpriseUrl ?? current.enterpriseUrl,
						apiEndpoint: refreshed.apiEndpoint ?? current.apiEndpoint,
						orgId: refreshed.orgId ?? current.orgId,
						orgName: refreshed.orgName ?? current.orgName,
					};
			if (this.#store.tryUpdateAuthCredentialIfMatches) {
				if (
					!this.#store.tryUpdateAuthCredentialIfMatches(
						row.id,
						serialized.data,
						merged,
						leasedCredentialId !== undefined ? { owner, nowMs: Date.now() } : undefined,
					)
				) {
					await this.reload();
					const latest = this.#getStoredCredentials(provider).find(entry => entry.id === row.id)?.credential;
					return {
						credential: latest?.type === "oauth" ? options.credentialFromRow(latest) : undefined,
						refreshed: false,
						removed: false,
					};
				}
			} else {
				this.#store.updateAuthCredential(row.id, merged);
			}
			this.#setStoredCredentials(
				provider,
				rows.map(entry => ({ id: entry.id, credential: entry.id === row.id ? merged : entry.credential })),
			);
			return { credential: merged, refreshed: true, removed: false };
		} finally {
			if (leasedCredentialId !== undefined) {
				this.#store.releaseCredentialRefreshLease?.(leasedCredentialId, owner);
			}
		}
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
	 * Dedicated auth for default-model availability (picker / `getAvailable`).
	 * Unlike {@link getApiKey}, this does not refresh OAuth tokens, and unlike
	 * {@link hasResolvableAuth} it ignores cross-provider env aliases so
	 * `XAI_API_KEY` does not auto-select SuperGrok (`xai-oauth`).
	 */
	hasAuth(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (this.#hasDedicatedEnvAuth(provider)) return true;
		if (this.#fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Like {@link hasAuth} but excludes providers whose only credential is the
	 * self-resolving {@link AUTHENTICATED_SENTINEL} — the marker AWS/Vertex
	 * transports return when a credential *source* merely exists (a stray
	 * `~/.aws` profile, an EC2 instance role, Application Default Credentials)
	 * without a usable key resolved yet. Default-model auto-selection uses this
	 * so an ambiently-available provider (e.g. `amazon-bedrock` via an unrelated
	 * AWS profile) does not win the startup default over a provider the user
	 * actually signed into and then 403 on the first turn. Explicit selection
	 * and picker visibility still go through {@link hasAuth}. See issue #9967.
	 */
	hasConcreteAuth(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if ((provider === "amazon-bedrock" || provider === "bedrock-mantle") && $env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
			return true;
		}
		if (provider === "xai-oauth") {
			if ($env.XAI_OAUTH_TOKEN?.trim()) return true;
		} else {
			const envApiKey = getEnvApiKey(provider);
			if (envApiKey !== undefined && envApiKey !== AUTHENTICATED_SENTINEL) return true;
		}
		const fallback = this.#fallbackResolver?.(provider);
		return fallback !== undefined && fallback !== AUTHENTICATED_SENTINEL;
	}

	/**
	 * Whether a request could resolve a key for this provider, including
	 * cross-provider env aliases (`xai-oauth` borrowing `XAI_API_KEY`).
	 * Use this for explicit model preflight (`xai-oauth/grok-4.6`); use
	 * {@link hasAuth} for auto-availability so the default picker stays on
	 * paid `xai` when only `XAI_API_KEY` is set.
	 */
	hasResolvableAuth(provider: string): boolean {
		if (this.hasAuth(provider)) return true;
		return Boolean(getEnvApiKey(provider));
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
	 * Env auth that belongs to this provider, not a cross-provider alias.
	 *
	 * `getEnvApiKey("xai-oauth")` also accepts `XAI_API_KEY` so an explicit
	 * `xai-oauth/…` stream can still borrow the paid key. Availability and
	 * origin must not: otherwise an API-key-only setup marks SuperGrok as
	 * signed in and `pickDefaultAvailableModel` prefers `xai-oauth/grok-4.6`
	 * over paid `xai/grok-4.6`.
	 */
	#hasDedicatedEnvAuth(provider: string): boolean {
		if (provider === "xai-oauth") {
			return Boolean($env.XAI_OAUTH_TOKEN?.trim());
		}
		return Boolean(getEnvApiKey(provider));
	}

	/**
	 * Classify where a provider's auth comes from, following the same precedence
	 * as {@link AuthStorage.getApiKey}: runtime override → config override →
	 * stored OAuth → login-stored api_key → env var → stored api_key →
	 * fallback resolver. Returns undefined when no auth is configured.
	 *
	 * Compact, structured counterpart to {@link describeCredentialSource}.
	 */
	getCredentialOrigin(provider: string): CredentialOrigin | undefined {
		if (this.#runtimeOverrides.has(provider)) return { kind: "runtime" };
		if (this.#configOverrides.has(provider)) return { kind: "config" };
		const stored = this.#getCredentialsForProvider(provider);
		if (stored.some(credential => credential.type === "oauth")) return { kind: "oauth" };
		if (stored.some(credential => credential.type === "api_key" && credential.source === "login")) {
			return { kind: "api_key" };
		}
		if (this.#hasDedicatedEnvAuth(provider)) return { kind: "env", envVar: getEnvApiKeyName(provider) };
		if (stored.some(credential => credential.type === "api_key")) return { kind: "api_key" };
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
		if (typeof preferred.orgId === "string" && preferred.orgId.length > 0) {
			identity.orgId = preferred.orgId;
		}
		if (typeof preferred.orgName === "string" && preferred.orgName.length > 0) {
			identity.orgName = preferred.orgName;
		}
		if (!identity.accountId && !identity.email && !identity.projectId && !identity.orgId) return undefined;
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
	 * Login to an OAuth provider. Resolves with the stored credential's
	 * identity slice (or `undefined` when nothing was stored) so callers can
	 * surface which account — and for Anthropic, which organization — the
	 * login registered.
	 */
	async login(
		provider: OAuthProviderId,
		ctrl: OAuthController & {
			/** onAuth is required by auth-storage but optional in OAuthController */
			onAuth: (info: OAuthAuthInfo) => void;
			/** onPrompt is required for some providers (github-copilot, openai-codex) */
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
		},
	): Promise<OAuthLoginIdentity | undefined> {
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
				return undefined;
			}
			const newCredential: ApiKeyCredential = { type: "api_key", key: result, source: "login" };
			const stored = this.#store.upsertAuthCredentialRemote
				? await this.#store.upsertAuthCredentialRemote(provider, newCredential)
				: this.#store.upsertAuthCredentialForProvider(provider, newCredential);
			this.#setStoredCredentials(
				provider,
				stored.map(entry => ({ id: entry.id, credential: entry.credential })),
			);
			this.#resetProviderAssignments(provider);
			return { type: "api_key" };
		}
		// Stamp the interactive-login instant: providers with an absolute grant
		// lifetime (Anthropic) need it to surface re-login deadlines, and token
		// refreshes only ever merge over this credential without clearing it.
		const newCredential: OAuthCredential = { type: "oauth", ...result, authorizedAt: Date.now() };
		// Use #upsertOAuthCredential to upsert the new credential.
		// Any legacy api_key rows from older versions will be cleaned up so they do not
		// shadow the new OAuth row, while preserving other active OAuth credentials.
		await this.#upsertOAuthCredential(def.storeCredentialsAs ?? provider, newCredential);
		return {
			type: "oauth",
			email: newCredential.email,
			accountId: newCredential.accountId,
			orgId: newCredential.orgId,
			orgName: newCredential.orgName,
		};
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

	#buildUsageCredential(credential: AuthCredential): UsageCredential {
		if (credential.type === "api_key") {
			return {
				type: "api_key",
				apiKey: credential.key,
			};
		}
		return {
			type: "oauth",
			accessToken: credential.access,
			refreshToken: credential.refresh,
			expiresAt: credential.expires,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			orgId: credential.orgId,
			orgName: credential.orgName,
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
		const orgId = credential.orgId?.trim();
		if (orgId) parts.push(`org:${orgId}`);
		const projectId = credential.projectId?.trim();
		if (projectId) parts.push(`project:${projectId}`);
		const enterpriseUrl = credential.enterpriseUrl?.trim().toLowerCase();
		if (enterpriseUrl) parts.push(`enterprise:${enterpriseUrl}`);
		// Only fall back to a secret-derived key when a stable account identifier is
		// unavailable. Including the token hash when accountId/email/orgId are present
		// causes cache misses on every OAuth refresh — usage data is per-account (or
		// per-org for org-only anthropic rows), not per-token.
		const hasStableIdentifier = Boolean(accountId || email || orgId);
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

	#usageCacheProviderKey(provider: Provider): string {
		const versionOverride = USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES[provider];
		return versionOverride === undefined ? provider : `${versionOverride}:${provider}`;
	}

	#usageForceRefreshCacheKey(provider?: Provider): string {
		return provider
			? `${USAGE_FORCE_REFRESH_CACHE_PREFIX}provider:${provider}`
			: `${USAGE_FORCE_REFRESH_CACHE_PREFIX}all`;
	}

	#markUsageForceRefresh(provider?: Provider): void {
		this.#usageCache.set(this.#usageForceRefreshCacheKey(provider), {
			value: true,
			expiresAt: Date.now() + USAGE_FORCE_REFRESH_TTL_MS,
		});
	}

	#hasUsageForceRefresh(provider?: Provider): boolean {
		const key = this.#usageForceRefreshCacheKey(provider);
		const entry = this.#usageCache.get<boolean>(key);
		if (entry?.value !== true) return false;
		if (entry.expiresAt > Date.now()) return true;
		this.#usageCache.set(key, { value: null, expiresAt: 0 });
		return false;
	}

	#usageForceRefresh(requests: readonly UsageRequestDescriptor[]): ForcedUsageRefresh {
		const all = this.#hasUsageForceRefresh();
		const providers = new Set<Provider>();
		for (const request of requests) providers.add(request.provider);
		if (!all) {
			for (const provider of providers) {
				if (!this.#hasUsageForceRefresh(provider)) providers.delete(provider);
			}
		}
		return { all, providers };
	}

	#clearUsageForceRefresh(refresh: ForcedUsageRefresh): void {
		if (refresh.all) this.#usageCache.set(this.#usageForceRefreshCacheKey(), { value: null, expiresAt: 0 });
		for (const provider of refresh.providers) {
			this.#usageCache.set(this.#usageForceRefreshCacheKey(provider), { value: null, expiresAt: 0 });
		}
	}
	#buildUsageReportCacheKey(request: UsageRequestDescriptor): string {
		const baseUrl = this.#normalizeUsageBaseUrl(request.baseUrl) || "default";
		const identity = this.#buildUsageCacheIdentity(request.credential);
		const providerKey = this.#usageCacheProviderKey(request.provider);
		const cacheKey = `report:${providerKey}:${baseUrl}:${identity}`;
		const cacheKeys = this.#usageReportCacheKeysByProvider.get(request.provider) ?? new Set<string>();
		cacheKeys.add(cacheKey);
		this.#usageReportCacheKeysByProvider.set(request.provider, cacheKeys);
		return cacheKey;
	}
	#buildUsageReportsCacheKey(requests: ReadonlyArray<UsageRequestDescriptor>): string {
		const snapshot = requests
			.map(request => {
				const providerKey = this.#usageCacheProviderKey(request.provider);
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
			orgId: credential.orgId,
			orgName: credential.orgName,
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
			orgId: refreshed.orgId ?? credential.orgId,
			orgName: refreshed.orgName ?? credential.orgName,
		};
	}

	/**
	 * Find the stored credential id matching a {@link UsageCredential} so the
	 * refresh override can address the row. Mirrors the matching logic in
	 * {@link AuthStorage.#persistRefreshedUsageCredential}.
	 */
	#findStoredCredentialIdForUsageCredential(provider: Provider, previous: UsageCredential): number | undefined {
		const entries = this.#getStoredCredentials(provider);
		// Broker-backed rows all carry REMOTE_REFRESH_SENTINEL as their refresh
		// token — it identifies nothing, and comparing it would match the FIRST
		// OAuth row regardless of which account/org is being refreshed.
		const previousRefresh =
			previous.refreshToken && previous.refreshToken !== REMOTE_REFRESH_SENTINEL ? previous.refreshToken : undefined;
		const match = entries.find(entry => {
			if (entry.credential.type !== "oauth") return false;
			if (previousRefresh && entry.credential.refresh === previousRefresh) return true;
			if (previous.accessToken && entry.credential.access === previous.accessToken) return true;
			return (
				entry.credential.accountId === previous.accountId &&
				entry.credential.email === previous.email &&
				entry.credential.projectId === previous.projectId &&
				entry.credential.orgId === previous.orgId
			);
		});
		return match?.id;
	}

	#persistRefreshedUsageCredential(
		provider: Provider,
		previous: UsageCredential,
		next: UsageCredential,
		credentialId = this.#findStoredCredentialIdForUsageCredential(provider, previous),
	): void {
		if (credentialId === undefined) return;
		const entry = this.#getStoredCredentials(provider).find(candidate => candidate.id === credentialId);
		if (entry?.credential.type !== "oauth") return;
		this.#replaceCredentialById(provider, credentialId, {
			type: "oauth",
			access: next.accessToken ?? entry.credential.access,
			refresh: next.refreshToken ?? entry.credential.refresh,
			expires: next.expiresAt ?? entry.credential.expires,
			accountId: next.accountId,
			projectId: next.projectId,
			email: next.email,
			enterpriseUrl: next.enterpriseUrl,
			apiEndpoint: next.apiEndpoint,
			orgId: next.orgId ?? entry.credential.orgId,
			orgName: next.orgName ?? entry.credential.orgName,
			// Not part of UsageCredential — carried from the stored row so the
			// interactive-login anchor survives usage-path refresh persists.
			authorizedAt: entry.credential.authorizedAt,
		});
	}

	async #fetchUsageUncached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const providerImpl = this.#resolveUsageProvider(request.provider);
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
					this.#persistRefreshedUsageCredential(
						request.provider,
						request.credential,
						refreshedCredential,
						refreshableCredentialId,
					);
					params = {
						...request,
						credential: refreshedCredential,
						accountKey: this.#buildUsageCacheIdentity(refreshedCredential),
						signal: timeoutSignal,
					};
				} catch (error) {
					const errorMsg = String(error);
					if (request.credential.expiresAt <= Date.now() && AIError.isDefinitiveOAuthFailure(errorMsg)) {
						// The current access token is unusable, so don't replay an
						// old usage report after its rotating refresh token is revoked.
						// This changes cache state only; usage polling remains
						// non-authoritative about the credential lifecycle.
						this.#usageCache.set(this.#buildUsageReportCacheKey(request), { value: null, expiresAt: 0 });
					}
					// Usage polling is advisory. A refresh can fail while the current
					// access token remains valid inside the refresh skew, so probe with
					// that token and never mutate credential state from this path.
					this.#usageLogger?.debug("Usage credential refresh failed, using original credential", {
						provider: request.provider,
						error: errorMsg,
					});
				}
			}
		}

		if (providerImpl.supports && !providerImpl.supports(params)) return null;

		try {
			const report = await providerImpl.fetchUsage(params, {
				fetch: this.#usageFetch,
				logger: this.#usageLogger,
			});
			// Attribute the report to the credential's organization. The orgId and
			// orgName fallbacks apply independently: Claude's usage endpoint stamps
			// orgId from the `anthropic-organization-id` response header but never
			// carries a display name, so the stored name must still be attached.
			// Never attach the stored name over a DIFFERENT org's report.
			if (report && params.credential.orgId !== undefined) {
				const metadata = report.metadata ?? {};
				const sameOrg = metadata.orgId === undefined || metadata.orgId === params.credential.orgId;
				const needsOrgId = metadata.orgId === undefined;
				const needsOrgName = sameOrg && params.credential.orgName !== undefined && metadata.orgName === undefined;
				if (needsOrgId || needsOrgName) {
					report.metadata = {
						...metadata,
						...(needsOrgId ? { orgId: params.credential.orgId } : {}),
						...(needsOrgName ? { orgName: params.credential.orgName } : {}),
					};
				}
			}
			return report;
		} catch (error) {
			if (error instanceof AIError.ProviderHttpError && (error.status === 401 || error.status === 403)) {
				// Definitive auth failure (revoked key, lapsed subscription): purge
				// the last-good report so #fetchUsageCached's failure branch can't
				// keep rendering and ranking from stale quota the way it does for
				// transient failures. Mirrors the definitive-OAuth-refresh path.
				this.#usageCache.set(this.#buildUsageReportCacheKey(request), { value: null, expiresAt: 0 });
			}
			logger.debug("AuthStorage usage fetch failed", {
				provider: request.provider,
				error: String(error),
			});
			return null;
		}
	}
	async #fetchUsageCached(
		request: UsageRequestDescriptor,
		options: { timeoutMs?: number; forceRefresh?: boolean } = {},
	): Promise<UsageReport | null> {
		const timeoutMs = options.timeoutMs;
		const forceRefresh = options.forceRefresh ?? false;
		const cacheKey = this.#buildUsageReportCacheKey(request);

		const now = Date.now();
		const cached = forceRefresh ? undefined : this.#usageCache.get<UsageReport | null>(cacheKey);
		// Fresh cache hit: return whatever's there (success or null fallback).
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const usageCacheEpoch = this.#usageCacheEpoch;
		const inFlightKey = `${cacheKey}\0${usageCacheEpoch}`;
		const inFlight = this.#usageRequestInFlight.get(inFlightKey);
		if (inFlight) return inFlight;
		const promise = (async () => {
			const report = await this.#fetchUsageUncached(request, timeoutMs);
			if (usageCacheEpoch !== this.#usageCacheEpoch) return report;
			const ttlJitter = USAGE_REPORT_TTL_MS * (Math.random() * 0.5 - 0.25);
			if (report !== null) {
				// Success: stagger per-credential cache expiry so all accounts don't
				// refresh in the same window — Anthropic / OpenAI rate-limit `/usage`
				// per source IP regardless of account, and synchronized 5-credential
				// fan-out trips 429s every cycle. With ±25% jitter on TTL the refresh
				// times decorrelate within a few cycles.
				this.#usageCache.set(cacheKey, { value: report, expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter });
				this.#recordUsageHistory(request, report);
				this.#reconcileCodexUsageBlock(request, report);
				return report;
			}
			// Failure: apply a short jittered cool-down so the credential doesn't
			// re-hit the endpoint on every poll. Most providers serve the last good
			// value through transient failures. Session-cookie providers can opt out
			// so an expired login does not display stale quota indefinitely.
			const retainLastGood =
				!forceRefresh && this.#resolveUsageProvider(request.provider)?.retainLastGoodOnFailure !== false;
			const lastGood = retainLastGood
				? (this.#usageCache.getStale<UsageReport | null>(cacheKey)?.value ?? null)
				: null;
			const backoffJitter = USAGE_FAILURE_BACKOFF_MS * (Math.random() * 0.5 - 0.25);
			const coolDown = Date.now() + USAGE_FAILURE_BACKOFF_MS + backoffJitter;
			this.#usageCache.set(cacheKey, { value: lastGood, expiresAt: coolDown });
			return lastGood;
		})().finally(() => {
			this.#usageRequestInFlight.delete(inFlightKey);
		});

		this.#usageRequestInFlight.set(inFlightKey, promise);
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

	/**
	 * Forward one completed request's usage to the store's observer hook.
	 * Broker-backed stores batch these into per-install reports so the broker
	 * can track actual token burn per client; local stores have no hook and
	 * the call is a no-op.
	 */
	recordObservedUsage(entry: {
		provider: Provider;
		model: string;
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
		costUsd?: number;
		at?: number;
		/** Attribution override; defaults to this process's install identity. */
		client?: ClientUsageIdentity;
	}): void {
		const record = this.#store.recordObservedUsage;
		if (!record) return;
		try {
			record.call(
				this.#store,
				[
					{
						at: entry.at ?? Date.now(),
						provider: entry.provider,
						model: entry.model,
						requests: 1,
						inputTokens: entry.usage.input,
						outputTokens: entry.usage.output,
						cacheReadTokens: entry.usage.cacheRead,
						cacheWriteTokens: entry.usage.cacheWrite,
						costUsd: Number.isFinite(entry.costUsd) ? (entry.costUsd ?? 0) : 0,
					},
				],
				entry.client,
			);
		} catch (error) {
			this.#usageLogger?.debug("observed usage record failed", {
				provider: entry.provider,
				error: String(error),
			});
		}
	}

	/** Broker host: persist one client's observed-usage report (per-install token burn). */
	recordClientUsage(report: ClientUsageReport): boolean {
		const record = this.#store.recordClientUsage;
		if (!record) return false;
		record.call(this.#store, report);
		return true;
	}

	/** Broker host: aggregate recorded per-client usage since `sinceMs`. */
	getClientUsageSummary(sinceMs: number): ClientUsageSummary {
		return this.#store.getClientUsageSummary?.(sinceMs) ?? { clients: [] };
	}

	ingestUsageHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string },
	): boolean {
		if (this.#fetchUsageReportsOverride) return false;
		const parseHeaders = this.#resolveUsageProvider(provider)?.parseRateLimitHeaders;
		if (!parseHeaders) return false;

		const credential = this.#resolveActiveOAuthCredential(provider, options?.sessionId);
		if (!credential) return false;

		const cacheKey = this.#buildUsageReportCacheKey(
			this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
		);
		const now = Date.now();
		const parsedReport = parseHeaders(headers, now);
		if (!parsedReport) return false;
		// Throttled to one ingest per interval — except when a window reads
		// exhausted: persist that snapshot immediately. A full-backed cache can
		// then block the next getApiKey; a cold header-only snapshot first probes
		// the usage endpoint.
		const exhausted = parsedReport.limits.some(limit => this.#isUsageLimitExhausted(limit));
		const last = this.#usageHeaderIngestAt.get(cacheKey);
		if (!exhausted && last !== undefined && now - last < USAGE_HEADER_INGEST_INTERVAL_MS) return false;
		const metadata: Record<string, unknown> = { ...parsedReport.metadata };
		if (credential.accountId && metadata.accountId === undefined) metadata.accountId = credential.accountId;
		if (credential.email && metadata.email === undefined) metadata.email = credential.email;
		if (credential.projectId && metadata.projectId === undefined) metadata.projectId = credential.projectId;
		if (credential.orgId && metadata.orgId === undefined) metadata.orgId = credential.orgId;
		if (credential.orgName && metadata.orgName === undefined) metadata.orgName = credential.orgName;
		const report: UsageReport = { ...parsedReport, metadata };

		const storeIngest = this.#store.ingestUsageReport?.bind(this.#store);
		if (storeIngest) {
			const ingested = storeIngest(provider, credential, report);
			if (ingested) this.#usageHeaderIngestAt.set(cacheKey, now);
			return ingested;
		}

		if (this.#fetchUsageReportsOverride || this.#store.fetchUsageReports) return false;
		const priorEntry = this.#usageCache.getStale<UsageReport | null>(cacheKey);
		const prior = priorEntry?.value;
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
					...report.metadata,
					...prior.metadata,
					source: prior.metadata?.source,
					headersUpdatedAt: now,
				},
			};
		}

		// Header ingestion merges values but never extends a cache entry's lifetime.
		// Preserve the existing expiry (including active failure cooldowns) so full
		// reports refetch on their original 5-minute schedule and full-payload-only
		// rows such as extra usage stay current; headers only refresh window rows
		// between fetches. A newly minted header-only report is durable but stale.
		const expiresAt = Math.max(priorEntry?.expiresAt ?? now - 1, now - 1);
		this.#usageCache.set(cacheKey, { value: merged, expiresAt });
		this.#usageHeaderIngestAt.set(cacheKey, now);
		return true;
	}

	async #collectUsageRequests(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
	}): Promise<UsageRequestDescriptor[]> {
		const requests: UsageRequestDescriptor[] = [];
		const providers = new Set<string>([
			...this.#data.keys(),
			...this.#runtimeUsageProviderOverrides.keys(),
			...DEFAULT_USAGE_PROVIDERS.map(provider => provider.id),
		]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			const providerImpl = this.#resolveUsageProvider(provider);
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

			// SuperGrok billing only accepts OAuth bearers. Catalog envVars for
			// xai-oauth are [XAI_OAUTH_TOKEN, XAI_API_KEY], so the generic path
			// would (a) build api_key usage requests from stored keys / the paid
			// API env var and (b) never fall through to XAI_OAUTH_TOKEN when a
			// non-OAuth row is the only stored credential. Skip api_key material
			// and only env-fallback to the dedicated OAuth bearer.
			if (providerId === "xai-oauth") {
				let hasUsableStoredOAuthCredential = false;
				for (const entry of entries) {
					if (entry.credential.type !== "oauth") continue;
					const request = this.#buildUsageRequestForOauth(provider, entry.credential, baseUrl);
					if (providerImpl.supports && !providerImpl.supports(request)) continue;
					requests.push(request);
					hasUsableStoredOAuthCredential = true;
				}
				const oauthToken = $env.XAI_OAUTH_TOKEN?.trim();
				if (!hasUsableStoredOAuthCredential && oauthToken) {
					const request = this.#buildUsageRequest(provider, { type: "oauth", accessToken: oauthToken }, baseUrl);
					if (!providerImpl.supports || providerImpl.supports(request)) requests.push(request);
				}
				continue;
			}

			if (entries.length === 0) {
				const runtimeKey = this.#runtimeOverrides.get(providerId);
				const extensionUsageKeyConfig = this.#runtimeUsageProviderOverrides.get(provider)?.apiKey,
					extensionUsageKey = extensionUsageKeyConfig
						? await this.#configValueResolver(extensionUsageKeyConfig)
						: undefined,
					envKey = getEnvApiKey(providerId);
				const apiKey = runtimeKey ?? extensionUsageKey ?? envKey;
				if (!apiKey) continue;
				const request = this.#buildUsageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			for (const entry of entries) {
				const credential = entry.credential;
				let request: UsageRequestDescriptor;
				if (credential.type === "api_key") {
					// Stored keys may be references (env var name, "!command") —
					// resolve to the actual secret before it reaches a provider
					// fetcher's Authorization header. Unresolvable references are
					// skipped: probing with the literal reference string would
					// 401 and flag a working credential as bad.
					const apiKey = await this.#configValueResolver(credential.key);
					if (!apiKey) continue;
					request = this.#buildUsageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				} else {
					request = this.#buildUsageRequestForOauth(provider, credential, baseUrl);
				}
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
		if (report.provider === "anthropic" || report.provider === "openai-codex") {
			// One account email can hold several org-scoped subscriptions
			// (Anthropic organizations, ChatGPT workspaces). Reports from
			// different orgs must not merge — scope every identifier by org
			// when the report carries one; fall back to the account when the
			// email could not be recovered so no-email reports still merge
			// per org. Org-less reports (pre-upgrade caches) keep their bare
			// identifiers and only merge among themselves.
			if (identifiers.length === 0) {
				const accountId =
					this.#getUsageReportMetadataValue(report, "accountId") ?? this.#getUsageReportScopeAccountId(report);
				if (accountId) identifiers.push(`account:${accountId}`);
			}
			const orgId = this.#getUsageReportMetadataValue(report, "orgId");
			if (orgId) {
				if (identifiers.length === 0) return [`${report.provider}:org:${orgId.toLowerCase()}`];
				return identifiers.map(
					identifier => `${report.provider}:org:${orgId.toLowerCase()}|${identifier.toLowerCase()}`,
				);
			}
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
		const mergedMetadata: Record<string, unknown> = { ...base.metadata };
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
		if (limit.status !== undefined && limit.status !== "unknown") return limit.status === "exhausted";
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

	/** Extracts when every currently exhausted window has reset (in ms). */
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
		return Math.max(...candidates);
	}

	async #getUsageReport(
		provider: Provider,
		credential: AuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		// Store-level hook (e.g. `RemoteAuthCredentialStore`) is authoritative
		// when present for OAuth: the broker already aggregates usage from a
		// less-throttled IP, and falling back to the local per-credential fetch
		// would defeat the point of routing through it. API-key credentials do
		// not have a broker per-credential hook, so they use the normal cached
		// provider fetch path.
		if (credential.type === "oauth") {
			const storeHook = this.#store.getUsageReport?.bind(this.#store);
			if (storeHook) {
				const report = await storeHook(provider, credential, options?.signal);
				if (report) {
					this.#reconcileCodexUsageBlock(
						this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
						report,
					);
				}
				return report;
			}
		}
		const usageCredential = this.#buildUsageCredential(credential);
		if (credential.type === "api_key") {
			const resolvedApiKey = await this.#configValueResolver(credential.key);
			if (!resolvedApiKey) return null;
			usageCredential.apiKey = resolvedApiKey;
		}
		return this.#fetchUsageCached(this.#buildUsageRequest(provider, usageCredential, options?.baseUrl), {
			timeoutMs: options?.timeoutMs ?? this.#usageRequestTimeoutMs,
		});
	}

	/**
	 * The {@link UsageProvider} registered for `provider`, or undefined when the
	 * provider has no usage endpoint at all. Lets callers tell "a credential we
	 * could have fetched usage for but didn't" apart from "a provider with no
	 * usage concept" (web-search keys, local/keyless servers, inference
	 * providers without a usage API) — the latter never warrants a usage row.
	 */
	usageProviderFor(provider: Provider): UsageProvider | undefined {
		return this.#resolveUsageProvider(provider);
	}

	/**
	 * Return model ids whose live reports map to a quantitative usage scope.
	 * Provider strategies supply model/tier mapping when available; otherwise
	 * only explicitly matching model ids and account-wide shared limits count.
	 * Label-only or ambiguous tier limits are excluded rather than guessed.
	 */
	getUsageReportingModelIds(
		provider: Provider,
		modelIds: readonly string[],
		reports: readonly UsageReport[],
	): string[] {
		const strategy = this.#rankingStrategyResolver?.(provider);
		const providerReports = reports.filter(report => report.provider === provider);
		if (providerReports.length === 0) return [];
		const seen = new Set<string>();
		const reporting: string[] = [];
		for (const modelId of modelIds) {
			if (seen.has(modelId)) continue;
			seen.add(modelId);
			const context: CredentialRankingContext = { modelId };
			const hasUsage = providerReports.some(report => {
				const limits = strategy
					? this.#getScopedUsageLimits(strategy, report, context)
					: report.limits.filter(limit => limit.scope.shared === true || limit.scope.modelId === modelId);
				return limits.some(limit => this.#isUsageLimitExhausted(limit) || resolveUsedFraction(limit) !== undefined);
			});
			if (hasUsage) reporting.push(modelId);
		}
		return reporting;
	}

	/**
	 * Inspect the credential pool that {@link getApiKey} would use for one model
	 * without advancing round-robin state or changing session stickiness.
	 *
	 * Pool aggregation is deliberately conservative: one healthy sibling makes
	 * the model healthy, while any unknown sibling prevents a depleted/reserve
	 * conclusion. Static runtime/config/env credentials return unknown because
	 * they bypass the managed account pool.
	 */
	async getModelUsageHealth(provider: Provider, options: ModelUsageHealthOptions): Promise<ModelUsageHealth> {
		options.signal?.throwIfAborted();
		const origin = this.getCredentialOrigin(provider);
		const strategy = this.#rankingStrategyResolver?.(provider);
		if (!origin || !strategy || (origin.kind !== "oauth" && origin.kind !== "api_key")) {
			return { state: "unknown", accounts: [] };
		}

		const stored = this.#getStoredCredentials(provider).map((entry, index) => ({ entry, index }));
		const oauthPool = stored.filter(({ entry }) => entry.credential.type === "oauth");
		const apiKeyPool = stored.filter(({ entry }) => entry.credential.type === "api_key");
		const loginApiKeyPool = apiKeyPool.filter(
			({ entry }) => entry.credential.type === "api_key" && entry.credential.source === "login",
		);
		const pool = origin.kind === "oauth" ? oauthPool : loginApiKeyPool;
		if (pool.length === 0) return { state: "unknown", accounts: [] };
		const sessionCredential = this.#getSessionCredential(provider, options.sessionId);
		const selectedCredentialId =
			sessionCredential?.type === origin.kind
				? this.#getStoredCredentials(provider)[sessionCredential.index]?.id
				: undefined;

		const rankingContext: CredentialRankingContext = { modelId: options.modelId };
		const planRequirement = resolveOpenAICodexPlanRequirement(provider, options.modelId);
		const planEligibilityByCredential = new Map<number, boolean | undefined>();
		const blockScope = strategy.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const reserveFraction = Number.isFinite(options.reserveFraction)
			? Math.max(0, Math.min(1, options.reserveFraction))
			: 0;
		const nowMs = Date.now();
		let accounts = await Promise.all(
			pool.map(async ({ entry, index }): Promise<ModelUsageAccountHealth> => {
				const credentialType = entry.credential.type;
				const providerKey = this.#getProviderTypeKey(provider, credentialType);
				let blockedUntil = this.#getCredentialBlockedUntil(provider, providerKey, index, blockScopes);
				if (blockedUntil !== undefined && provider !== "openai-codex") {
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: blockedUntil,
					};
				}

				let report: UsageReport | null;
				try {
					report = await raceUsageWithSignal(
						this.#getUsageReport(provider, entry.credential, {
							baseUrl: options.baseUrl,
							timeoutMs: this.#usageRequestTimeoutMs,
							signal: options.signal,
						}),
						options.signal,
					);
				} catch (error) {
					if (options.signal?.aborted) throw error;
					report = null;
				}
				if (planRequirement !== "none") {
					planEligibilityByCredential.set(entry.id, getOpenAICodexPlanEligibility(report, planRequirement));
				}

				if (provider === "openai-codex") {
					blockedUntil = this.#getCredentialBlockedUntil(provider, providerKey, index, blockScopes);
				}
				if (blockedUntil !== undefined) {
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: blockedUntil,
					};
				}
				if (!report) return { credentialId: entry.id, credentialType, state: "unknown" };

				// Reserve health is opt-in and non-destructive: prefer the strategy's
				// reserve scoping, which may expose mapped model/tier rows that the
				// hard-block scoper withholds until confirmed exhaustion.
				const limits =
					strategy.scopeLimitsForReserve?.(report, rankingContext) ??
					this.#getScopedUsageLimits(strategy, report, rankingContext);
				if (limits.length === 0) return { credentialId: entry.id, credentialType, state: "unknown" };

				const currentLimits = limits.filter(limit => {
					const resetsAt = limit.window?.resetsAt;
					return resetsAt === undefined || resetsAt > nowMs || report.fetchedAt >= resetsAt;
				});
				if (currentLimits.length === 0) {
					return { credentialId: entry.id, credentialType, state: "unknown" };
				}
				const activeExhausted = currentLimits.filter(limit => this.#isUsageLimitExhausted(limit));
				if (activeExhausted.length > 0) {
					const futureResets = activeExhausted
						.map(limit => limit.window?.resetsAt)
						.filter((resetsAt): resetsAt is number => resetsAt !== undefined && resetsAt > nowMs);
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: futureResets.length > 0 ? Math.min(...futureResets) : undefined,
					};
				}

				const usedFractions = currentLimits
					.map(resolveUsedFraction)
					.filter((fraction): fraction is number => fraction !== undefined);
				if (usedFractions.length === 0) {
					return { credentialId: entry.id, credentialType, state: "unknown" };
				}
				const remainingFraction = Math.max(0, 1 - Math.max(...usedFractions));
				return {
					credentialId: entry.id,
					credentialType,
					state: remainingFraction <= reserveFraction ? "reserve" : "healthy",
					remainingFraction,
				};
			}),
		);
		if (planRequirement !== "none") {
			accounts = accounts.filter(account => planEligibilityByCredential.get(account.credentialId) !== false);
		}
		if (selectedCredentialId !== undefined) {
			const selectedAccount = accounts.find(account => account.credentialId === selectedCredentialId);
			if (selectedAccount) selectedAccount.selected = true;
		}

		if (accounts.some(account => account.state === "healthy")) return { state: "healthy", accounts };
		if (accounts.some(account => account.state === "unknown")) return { state: "unknown", accounts };
		if (accounts.some(account => account.state === "reserve")) return { state: "reserve", accounts };
		return { state: "depleted", accounts };
	}

	/**
	 * Release a session's sticky credential so its next {@link getApiKey} call
	 * re-runs native pool ranking. This never blocks or penalizes the released
	 * account; usage-aware routing uses it when another sibling has more
	 * headroom, before considering a model/provider fallback.
	 */
	releaseSessionCredentialForReselection(provider: string, sessionId: string): boolean {
		if (!this.#getSessionCredential(provider, sessionId)) return false;
		this.#clearSessionCredential(provider, sessionId);
		return true;
	}

	/**
	 * Fetch every requested report, keeping normal polls parallel while a
	 * manually invalidated provider probes accounts one at a time.
	 */
	#fetchUsageRequests(
		requests: readonly UsageRequestDescriptor[],
		serializedProviders: ReadonlySet<Provider>,
	): Promise<Array<UsageReport | null>> {
		const tails = new Map<Provider, Promise<void>>();
		return Promise.all(
			requests.map(request => {
				const forceRefresh = serializedProviders.has(request.provider);
				if (!forceRefresh) {
					return this.#fetchUsageCached(request, { timeoutMs: this.#usageRequestTimeoutMs });
				}
				const tail = tails.get(request.provider) ?? Promise.resolve();
				const current = tail.then(() =>
					this.#fetchUsageCached(request, { timeoutMs: this.#usageRequestTimeoutMs, forceRefresh: true }),
				);
				tails.set(
					request.provider,
					current.then(
						() => undefined,
						() => undefined,
					),
				);
				return current;
			}),
		);
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
		const storeOverride = this.#store.fetchUsageReports?.bind(this.#store);
		const override = this.#fetchUsageReportsOverride ?? storeOverride;
		const shouldReconcileStoreHookReports =
			this.#fetchUsageReportsOverride === undefined && storeOverride !== undefined;
		if (override) {
			// Reuse the in-flight map so concurrent callers (widget poll + format
			// dispatch + credential selection) coalesce into one upstream call.
			// Each caller's `signal` only cancels THAT caller's await; the
			// shared upstream fetch runs to completion so peers aren't punished.
			const overrideKey = `__override__\0${this.#usageCacheEpoch}`;
			let shared = this.#usageReportsInFlight.get(overrideKey);
			if (!shared) {
				// Don't forward the caller signal into the shared fetch — first caller's
				// abort would otherwise cancel the upstream for every peer.
				shared = override().finally(() => {
					this.#usageReportsInFlight.delete(overrideKey);
				});
				this.#usageReportsInFlight.set(overrideKey, shared);
			}
			const reports = await raceUsageWithSignal(shared, options?.signal);
			if (shouldReconcileStoreHookReports && reports) this.#reconcileCodexUsageBlocksFromReports(reports);
			return reports;
		}
		if (!this.#usageProviderResolver && this.#runtimeUsageProviderOverrides.size === 0) return null;

		const requests = await this.#collectUsageRequests(options);
		if (requests.length === 0) return [];

		this.#usageLogger?.debug("Usage fetch requested", {
			providers: [...new Set(requests.map(request => request.provider))].sort(),
		});

		// Per-credential caching with jitter lives in #fetchUsageCached, so we
		// don't store the aggregated result here — doing so locks the widget to
		// a single decorrelation snapshot for 30s, defeating the jitter (some
		// accounts can be missing from one fetch and present in the next; the
		// aggregate cache freezes whichever set landed first).
		const forcedRefresh = this.#usageForceRefresh(requests);
		const cacheKey = `${this.#buildUsageReportsCacheKey(requests)}\0${this.#usageCacheEpoch}`;

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

			const results = await this.#fetchUsageRequests(requests, forcedRefresh.providers);
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
			this.#clearUsageForceRefresh(forcedRefresh);
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

		const timeoutMs = options?.timeoutMs ?? this.#usageRequestTimeoutMs;
		const completionProbe = options?.completionProbe;
		const completionTimeoutMs = options?.completionTimeoutMs ?? timeoutMs;
		const ctx: UsageFetchContext = {
			fetch: this.#usageFetch,
			logger: this.#usageLogger,
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
				if (row.credential.orgId) base.orgId = row.credential.orgId;
				if (row.credential.orgName) base.orgName = row.credential.orgName;
				if (row.credential.refresh === REMOTE_REFRESH_SENTINEL) base.remoteRefresh = true;
			}

			const baseUrl = options?.baseUrlResolver?.(row.provider as Provider);
			const cred = row.credential;
			let initialRequest: UsageRequestDescriptor;
			if (cred.type === "api_key") {
				// Stored keys may be references (env var name, "!command") — probe
				// with the resolved secret, not the reference string, so both the
				// usage probe and the completion probe exercise the real bytes.
				const apiKey = await this.#configValueResolver(cred.key);
				if (!apiKey) {
					base.reason = "api key reference could not be resolved";
					results.push(base);
					continue;
				}
				initialRequest = this.#buildUsageRequest(row.provider as Provider, { type: "api_key", apiKey }, baseUrl);
			} else {
				initialRequest = this.#buildUsageRequestForOauth(row.provider as Provider, cred, baseUrl);
			}

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
							row.id,
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

			const providerImpl = this.#resolveUsageProvider(row.provider as Provider);
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

	async #resolveCredentialTarget(
		provider: string,
		sessionId: string | undefined,
		options?: { credentialId?: number; apiKey?: string },
	): Promise<{ type: AuthCredential["type"]; index: number; explicit: boolean } | undefined> {
		const explicit = options?.credentialId !== undefined || options?.apiKey !== undefined;
		if (explicit) {
			const latestRows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				latestRows.map(row => ({ id: row.id, credential: row.credential })),
			);
		}
		if (options?.credentialId !== undefined) {
			const stored = this.#getStoredCredentials(provider);
			const index = stored.findIndex(entry => entry.id === options.credentialId);
			const entry = index === -1 ? undefined : stored[index];
			if (entry) return { type: entry.credential.type, index, explicit: true };
		}
		if (options?.apiKey !== undefined) {
			const stored = this.#getStoredCredentials(provider);
			for (let index = 0; index < stored.length; index++) {
				const entry = stored[index];
				if (entry && (await this.#credentialMatchesApiKey(entry.credential, options.apiKey))) {
					return { type: entry.credential.type, index, explicit: true };
				}
			}
		}
		if (explicit) return undefined;
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		return sessionCredential ? { ...sessionCredential, explicit: false } : undefined;
	}

	#credentialBlockRouting(
		provider: string,
		credentialType: AuthCredential["type"],
		modelId: string | undefined,
		blockScopeOverride?: string,
	): CredentialBlockRouting {
		const providerKey = this.#getProviderTypeKey(provider, credentialType);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const rankingContext: CredentialRankingContext = { modelId };
		const defaultBlockScope = strategy?.blockScope?.(rankingContext);
		const blockScope = blockScopeOverride ?? defaultBlockScope;
		const requestBlockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, defaultBlockScope);
		const siblingBlockScopes =
			blockScopeOverride && !requestBlockScopes.includes(blockScopeOverride)
				? [...requestBlockScopes, blockScopeOverride]
				: requestBlockScopes;
		return {
			providerKey,
			strategy,
			rankingContext,
			blockScope,
			siblingBlockScopes,
		};
	}

	#blockCredentialForRotation(
		provider: string,
		credentialType: AuthCredential["type"],
		targetIndex: number,
		blockedUntil: number,
		routing: CredentialBlockRouting,
	): UsageLimitMarkResult {
		if (targetIndex >= 0) {
			this.#markCredentialBlocked(provider, routing.providerKey, targetIndex, blockedUntil, routing.blockScope);
		}

		const remainingCredentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: AuthCredential; index: number } =>
					entry.credential.type === credentialType && entry.index !== targetIndex,
			);

		let retryAtMs: number | undefined;
		for (const candidate of remainingCredentials) {
			// Sibling availability must use the same scope set selection reads, or
			// this reports a sibling as free that selection will then refuse.
			const candidateBlockedUntil = this.#getCredentialBlockedUntil(
				provider,
				routing.providerKey,
				candidate.index,
				routing.siblingBlockScopes,
			);
			if (candidateBlockedUntil === undefined) return { switched: true };
			if (retryAtMs === undefined || candidateBlockedUntil < retryAtMs) retryAtMs = candidateBlockedUntil;
		}
		return { switched: false, retryAtMs };
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
		options?: {
			retryAfterMs?: number;
			baseUrl?: string;
			modelId?: string;
			apiKey?: string;
			credentialId?: number;
			signal?: AbortSignal;
		},
	): Promise<UsageLimitMarkResult> {
		let sessionCredential = await this.#resolveCredentialTarget(provider, sessionId, {
			credentialId: options?.credentialId,
			apiKey: options?.apiKey,
		});
		if (!sessionCredential && options?.credentialId === undefined && options?.apiKey !== undefined) {
			// Account quota survives OAuth bearer rotation. Attribute a delayed
			// usage-limit response through the durable row id captured when this
			// exact bearer was resolved; never use this alias for hard auth errors.
			const credentialId = this.#findOAuthCredentialIdForBearer(provider, options.apiKey);
			const index =
				credentialId === undefined
					? -1
					: this.#getStoredCredentials(provider).findIndex(
							entry => entry.id === credentialId && entry.credential.type === "oauth",
						);
			if (index >= 0) sessionCredential = { type: "oauth", index, explicit: true };
		}
		if (!sessionCredential) return { switched: false };
		const target = this.#getStoredCredentials(provider)[sessionCredential.index];
		if (!target || target.credential.type !== sessionCredential.type) return { switched: false };
		const credentialType = sessionCredential.type;
		const targetCredentialId = target.id;

		const routing = this.#credentialBlockRouting(provider, credentialType, options?.modelId);
		const now = Date.now();
		let blockedUntil = now + (options?.retryAfterMs ?? AuthStorage.#defaultBackoffMs);

		if (target && routing.strategy) {
			const report = await raceUsageWithSignal(
				this.#getUsageReport(provider, target.credential, options),
				options?.signal,
			);
			if (report) {
				const scopedLimits = this.#getScopedUsageLimits(routing.strategy, report, routing.rankingContext);
				if (this.#isUsageLimitReached(scopedLimits)) {
					const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
					if (resetAtMs && resetAtMs > blockedUntil) {
						blockedUntil = resetAtMs;
					}
				}
			}
		}
		options?.signal?.throwIfAborted();

		// Usage lookup may refresh, disable, or remove a row. Re-resolve its
		// durable id before applying positional in-memory and persisted blocks.
		const targetIndex = this.#getStoredCredentials(provider).findIndex(
			entry => entry.id === targetCredentialId && entry.credential.type === credentialType,
		);
		return this.#blockCredentialForRotation(provider, credentialType, targetIndex, blockedUntil, routing);
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

	/**
	 * Computes the required drain rate: `headroomFraction / remainingHours` —
	 * how fast the window's remaining quota must be consumed to fully use it
	 * before it resets and expires. Higher = more headroom at risk of expiring
	 * unused = ranked first, so selection chases quota that is about to be
	 * wasted ("use it or lose it"). Without a reset clock, the full window
	 * duration is assumed to remain so clocked and clockless scores stay comparable.
	 */
	#computeWindowRequiredDrain(limit: UsageLimit | undefined, nowMs: number, fallbackDurationMs: number): number {
		const headroom = 1 - this.#normalizeUsageFraction(limit);
		if (headroom <= 0) return 0;
		const resetAt = this.#resolveWindowResetAt(limit?.window);
		const durationMs = limit?.window?.durationMs ?? fallbackDurationMs;
		let remainingMs = resetAt === undefined ? durationMs : resetAt - nowMs;
		if (Number.isFinite(durationMs) && durationMs > 0) {
			remainingMs = Math.min(remainingMs, durationMs);
		}
		// Floor at one minute: a stale report whose reset already passed must
		// not produce an unbounded urgency score.
		const remainingHours = Math.max(remainingMs, 60_000) / (60 * 60 * 1000);
		return headroom / remainingHours;
	}

	#compareUsageRankedCandidatePriority(
		left: UsageRankedCandidate<AuthCredential>,
		right: UsageRankedCandidate<AuthCredential>,
		planRequirement: OpenAICodexPlanRequirement,
	): number {
		if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
		if (left.blocked && right.blocked) {
			const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
			const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
			if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
			return 0;
		}
		if (planRequirement !== "none" && left.planPriority !== right.planPriority) {
			return left.planPriority - right.planPriority;
		}
		if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
		// Short-window guard: candidates whose primary (e.g. 5h) window is
		// nearly exhausted rank behind cool ones regardless of drain urgency —
		// overflow lands on the next-most-urgent cool account instead.
		const leftHot = left.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
		const rightHot = right.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
		if (leftHot !== rightHot) return leftHot ? 1 : -1;
		// Usage-backed candidates outrank unmeasured ones: required-drain
		// scores are only comparable between measured windows, and the
		// clockless headroom fallback (0..1) must not let an account whose
		// usage fetch failed shadow a measured sibling.
		const leftMeasured = left.usageMeasured;
		const rightMeasured = right.usageMeasured;
		if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
		// Required drain, descending: the account whose remaining quota must
		// burn fastest to avoid expiring unused at its reset comes first, so
		// staggered resets land at ~100% utilization instead of stranding
		// headroom that a cooler sibling could have absorbed.
		let metric = compareUsageRankingMetric(right.secondaryRequiredDrain, left.secondaryRequiredDrain);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(left.secondaryUsed, right.secondaryUsed);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(right.primaryRequiredDrain, left.primaryRequiredDrain);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(left.primaryUsed, right.primaryUsed);
		if (metric !== 0) return metric;
		return 0;
	}

	#compareUsageRankedCandidates(
		left: UsageRankedCandidate<AuthCredential>,
		right: UsageRankedCandidate<AuthCredential>,
		planRequirement: OpenAICodexPlanRequirement,
	): number {
		const priority = this.#compareUsageRankedCandidatePriority(left, right, planRequirement);
		return priority !== 0 ? priority : left.orderPos - right.orderPos;
	}

	#orderUsageRankedCandidates<T extends AuthCredential>(
		candidates: UsageRankedCandidate<T>[],
		planRequirement: OpenAICodexPlanRequirement,
	): UsageCandidate<T>[] {
		candidates.sort((left, right) => this.#compareUsageRankedCandidates(left, right, planRequirement));
		return candidates.map(candidate => ({
			selection: candidate.selection,
			usage: candidate.usage,
			usageChecked: candidate.usageChecked,
		}));
	}

	async #rankOAuthSelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		planRequirement: OpenAICodexPlanRequirement;
		credentials: OAuthSelection[];
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
		rankingContext: CredentialRankingContext;
		blockScope?: string;
		/** Scopes a block may live under for this request; reads honour all of them. */
		blockScopes?: readonly string[];
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
				let blockedUntil = this.#getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				let usage: UsageReport | null = null;
				let usageChecked = false;
				if (blockedUntil !== undefined && args.provider === "openai-codex") {
					usage = await this.#getUsageReport(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
					blockedUntil = this.#getCredentialBlockedUntil(
						args.provider,
						args.providerKey,
						selection.index,
						args.blockScopes ?? args.blockScope,
					);
				}
				if (blockedUntil !== undefined) return { selection, usage, usageChecked, blockedUntil };
				if (!usageChecked) {
					usage = await this.#getUsageReport(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
				}
				return { selection, usage, usageChecked, blockedUntil: undefined as number | undefined };
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
				this.#markCredentialBlocked(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
				);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const usageMeasured = primary !== undefined || secondary !== undefined;
			const primaryUncapped = primary === undefined && secondary !== undefined;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				usageMeasured,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary, primaryUncapped, args.rankingContext) ?? false,
				planPriority: getOpenAICodexPlanPriority(usage, args.planRequirement),
				secondaryUsed: this.#normalizeUsageFraction(secondary),
				secondaryRequiredDrain: this.#computeWindowRequiredDrain(
					secondary,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: this.#normalizeUsageFraction(primary),
				primaryRequiredDrain: this.#computeWindowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return this.#orderUsageRankedCandidates(ranked, args.planRequirement);
	}

	/**
	 * Resolves an OAuth credential, trying credentials in priority order.
	 *
	 * Resolution ladder — a request in hand always beats "no API key":
	 * 1. strict: unblocked credentials only, usage limits respected, plan
	 *    filter enforced (when any account is confirmed eligible);
	 * 2. plan-fitting last resort: same plan filter, but blocked/exhausted
	 *    accounts are allowed (blocked candidates rank earliest-unblocking
	 *    first) so the caller gets real usage-limit semantics from the wire
	 *    instead of a missing key;
	 * 3. unfiltered last resort: the plan filter matched nothing usable —
	 *    skip it and try every account once; the server is the final arbiter
	 *    of model access.
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
		// Reads honour every scope that applies; the scalar above is for args that persist.
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const planRequirement = resolveOpenAICodexPlanRequirement(provider, options?.modelId);
		const hasPlanRequirement = planRequirement !== "none";
		const checkUsage = strategy !== undefined && (credentials.length > 1 || hasPlanRequirement);
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		const sessionPreferredCredential =
			sessionPreferredIndex !== undefined
				? credentials.find(entry => entry.index === sessionPreferredIndex)?.credential
				: undefined;
		const sessionPreferredCanRefreshOrUse =
			sessionPreferredCredential !== undefined &&
			(sessionPreferredCredential.refresh.trim().length > 0 ||
				Date.now() + OAUTH_REFRESH_SKEW_MS < sessionPreferredCredential.expires);
		// Skip ranking when the session already has a working preferred credential and its prompt
		// cache may still be warm. Only Anthropic has a verified idle boundary here; unverified
		// providers retain indefinite stickiness rather than risk switching while their prompt cache
		// remains warm. New Anthropic sessions (no preference), sessions whose preferred is blocked,
		// and sessions idle past {@link ANTHROPIC_SESSION_STICKY_CACHE_WARM_MS} still rank. Legacy
		// pins predating `lastUsedAtMs` count as warm until the next resolve rewrites the row.
		const sessionPreferredLastUsedAtMs =
			sessionCredential?.type === "oauth" ? sessionCredential.lastUsedAtMs : undefined;
		const sessionPreferredIsWarm =
			provider !== "anthropic" ||
			sessionPreferredLastUsedAtMs === undefined ||
			Date.now() - sessionPreferredLastUsedAtMs < ANTHROPIC_SESSION_STICKY_CACHE_WARM_MS;
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined &&
			sessionPreferredCanRefreshOrUse &&
			!this.#isCredentialBlocked(provider, providerKey, sessionPreferredIndex, blockScopes);
		const shouldRank = checkUsage && (!sessionPreferredIsAvailable || !sessionPreferredIsWarm || hasPlanRequirement);
		// When ranking, seed the pinned credential first in the evaluation order so it wins genuine
		// ties (the ranked comparator falls back to `orderPos`) without overriding a strictly-better
		// sibling — this respects the residual value of a same-account shared static prefix that other
		// workspace traffic may have kept warm, while still rotating away from a clearly-worse account.
		const baseRankingOrder = credentials.map((_credential, index) => index);
		let rankingOrder = shouldRank && sessionId ? baseRankingOrder : order;
		const sessionPreferredRankingPos =
			shouldRank && sessionId && sessionPreferredIndex !== undefined && !hasPlanRequirement
				? credentials.findIndex(entry => entry.index === sessionPreferredIndex)
				: -1;
		if (sessionPreferredRankingPos > 0) {
			rankingOrder = [
				sessionPreferredRankingPos,
				...baseRankingOrder.filter(index => index !== sessionPreferredRankingPos),
			];
		}
		const candidates = shouldRank
			? await this.#rankOAuthSelections({
					providerKey,
					provider,
					planRequirement,
					order: rankingOrder,
					credentials,
					options,
					strategy: strategy!,
					rankingContext,
					blockScope,
					blockScopes,
				})
			: order
					.map(idx => credentials[idx])
					.filter((selection): selection is { credential: OAuthCredential; index: number } => Boolean(selection))
					.map(selection => ({ selection, usage: null, usageChecked: false }));
		const preflightFailures = new Set<OAuthCandidate>();

		// On the warm skip path the candidate list follows the round-robin `order`, not the pin, so
		// hoist the pinned credential to the front to actually reuse it. When ranking ran, the pin is
		// already a mere tie-break via `rankingOrder`; do not override the ranked result here.
		if (!shouldRank && sessionPreferredIndex !== undefined && !hasPlanRequirement) {
			const sessionPreferredCandidate = candidates.findIndex(
				candidate =>
					!this.#isCredentialBlocked(provider, providerKey, candidate.selection.index, blockScopes) &&
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
				const credentialId = this.#getStoredCredentials(provider)[candidate.selection.index]?.id;
				try {
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
					// A failed preflight already exercised the provider refresh path.
					// Do not replay the same refresh token in the final candidate pass.
					const errorMsg = String(error);
					const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);
					logger.debug("OAuth preflight refresh failed", {
						provider,
						index: candidate.selection.index,
						error: errorMsg,
						isDefinitiveFailure,
					});
					if (isDefinitiveFailure) {
						// A dead grant discovered during preflight must be disabled here too —
						// the final candidate pass below skips every `preflightFailures` entry,
						// so if this branch only blocked the row (like the transient case), the
						// definitive failure would never reach `#tryOAuthCredential`'s own
						// disable logic and the row would be retried forever instead of torn down.
						const outcome = await this.#disableDefinitiveOAuthFailure(
							provider,
							credentialId,
							candidate.selection.credential,
							candidate.selection.index,
							errorMsg,
						);
						if (
							outcome !== "disabled" &&
							credentialId !== undefined &&
							this.#syncOAuthSelectionFromStore(provider, candidate.selection, credentialId)
						) {
							// A peer rotated this row (or won the disable CAS) between our
							// snapshot and the refresh; the helper reloaded storage and the row
							// still exists, so it now holds a valid, freshly rotated credential.
							// Re-sync the candidate onto it and leave it eligible so the final
							// pass retries with the live token instead of stranding it (mirrors
							// #tryOAuthCredential's peer-rotated re-resolve). If the peer instead
							// deleted/disabled the row, the re-sync fails and we fall through to
							// preflightFailures — leaving a stale index could rebind the candidate
							// to a sibling account with the wrong prefetched usage/plan.
							return;
						}
					} else if (credentialId !== undefined) {
						const latestIndex = this.#getStoredCredentials(provider).findIndex(
							entry => entry.id === credentialId,
						);
						if (latestIndex !== -1) {
							this.#markCredentialBlocked(
								provider,
								providerKey,
								latestIndex,
								Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
								blockScope,
							);
						}
					}
					preflightFailures.add(candidate);
				}
			}),
		);

		// Enforce a tier only when at least one account is confirmed eligible. If
		// every report is unknown or ineligible, preserve trial/grandfathered access
		// by allowing the normal candidate fallback to attempt the request.
		const enforcePlanRequirement =
			hasPlanRequirement &&
			candidates.some(candidate => getOpenAICodexPlanEligibility(candidate.usage, planRequirement) === true);

		// Plan-gated Codex models rank on every resolve to re-verify account tiers,
		// so the drain-urgency order can flip between two eligible accounts as their
		// usage headroom shifts. Promote the session-preferred credential back to the
		// front while it is unblocked and still plan-eligible (or the requirement is
		// unenforced and the pin is not known-ineligible) so an active session never
		// silently migrates accounts mid-conversation; blocked, exhausted, or
		// known-ineligible pins still fall through to the ranked sibling.
		if (hasPlanRequirement && sessionPreferredIndex !== undefined) {
			const sessionPreferredCandidate = candidates.findIndex(
				candidate =>
					!this.#isCredentialBlocked(provider, providerKey, candidate.selection.index, blockScopes) &&
					candidate.selection.index === sessionPreferredIndex,
			);
			if (sessionPreferredCandidate > 0) {
				const preferred = candidates[sessionPreferredCandidate]!;
				const planEligibility = getOpenAICodexPlanEligibility(preferred.usage, planRequirement);
				if (planEligibility === true || (!enforcePlanRequirement && planEligibility !== false)) {
					candidates.splice(sessionPreferredCandidate, 1);
					candidates.unshift(preferred);
				}
			}
		}

		const passes: Array<{ allowBlocked: boolean; enforcePlanRequirement: boolean }> = [
			{ allowBlocked: false, enforcePlanRequirement },
			{ allowBlocked: true, enforcePlanRequirement },
		];
		if (enforcePlanRequirement) passes.push({ allowBlocked: true, enforcePlanRequirement: false });

		for (const pass of passes) {
			for (const candidate of candidates) {
				if (preflightFailures.has(candidate)) continue;
				const resolved = await this.#tryOAuthCredential(
					provider,
					candidate.selection,
					providerKey,
					sessionId,
					options,
					{
						checkUsage,
						allowBlocked: pass.allowBlocked,
						prefetchedUsage: candidate.usage,
						usagePrechecked: candidate.usageChecked,
						planRequirement,
						enforcePlanRequirement: pass.enforcePlanRequirement,
						strategy,
						rankingContext,
						blockScope,
						blockScopes,
					},
				);
				if (resolved) return resolved;
			}
		}

		return undefined;
	}

	/**
	 * Handles a definitively-dead OAuth grant discovered during refresh (`invalid_grant`,
	 * `revoked`, …): checks for a peer rotation that raced the failure, then CAS-disables
	 * the row and emits `credential_disabled`. Shared by the eager preflight refresh in
	 * {@link AuthStorage.#resolveOAuthSelection} and the final-candidate refresh in
	 * {@link AuthStorage.#tryOAuthCredential} so both actually disable the credential — not
	 * just temporarily block it — on a definitive failure.
	 *
	 * Returns `"disabled"` once the row is torn down, `"peer-rotated"` when a concurrent
	 * process refreshed the same row first (the persisted refresh token no longer matches
	 * what we attempted — the caller should reload and retry with the new credential), or
	 * `"cas-lost"` when the disable itself lost a race and the caller should reload before
	 * continuing.
	 */
	async #disableDefinitiveOAuthFailure(
		provider: string,
		credentialId: number | undefined,
		attemptedCredential: OAuthCredential,
		index: number,
		errorMsg: string,
	): Promise<"disabled" | "peer-rotated" | "cas-lost"> {
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
			if (latestCredential?.type === "oauth" && latestCredential.refresh !== attemptedCredential.refresh) {
				logger.debug("OAuth refresh race detected; another process rotated token first", {
					provider,
					index,
					credentialId,
				});
				await this.reload();
				return "peer-rotated";
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
						attemptedCredential,
						`oauth refresh failed: ${errorMsg}`,
					)
				: this.#tryDisableCredentialAtIfMatches(
						provider,
						index,
						attemptedCredential,
						`oauth refresh failed: ${errorMsg}`,
					);
		if (!disabled) {
			logger.debug("OAuth refresh disable lost CAS; reloading after peer rotation", { provider, index });
			await this.reload();
			return "cas-lost";
		}
		return "disabled";
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
		const hasDurableLease =
			!!this.#store.tryAcquireCredentialRefreshLease &&
			!!this.#store.getCredentialRefreshLeaseExpiresAt &&
			!!this.#store.releaseCredentialRefreshLease &&
			!!this.#store.renewCredentialRefreshLease;
		if (credentialId !== undefined && hasDurableLease) {
			const forceRefresh = credential.expires === 0;
			const result = await this.refreshStoredOAuthCredential(provider, {
				credentialId,
				observedCredential: forceRefresh ? undefined : credential,
				credentialFromRow: row => row,
				forceRefresh,
				signal,
				refresh: (current, refreshSignal) =>
					this.#requestOAuthCredentialRefresh(
						provider,
						current,
						credentialId,
						signal && refreshSignal ? AbortSignal.any([signal, refreshSignal]) : (signal ?? refreshSignal),
					),
				isDefinitiveFailure: error => AIError.isDefinitiveOAuthFailure(String(error)),
				disabledCause: error => `oauth refresh failed: ${String(error)}`,
			});
			if (result.credential) {
				if (result.refreshed) {
					// We performed this refresh ourselves — trust the provider's new token
					// even when its lifetime is shorter than the refresh skew (some grants
					// are legitimately short-lived); the next resolve simply treats it as
					// due for refresh again instead of rejecting a token we just minted.
					if (Date.now() < result.credential.expires) return result.credential;
				} else if (Date.now() + OAUTH_REFRESH_SKEW_MS < result.credential.expires) {
					// Reloaded (not refreshed by us) credential — match #refreshOAuthCredential's
					// freshness contract: a reload within the refresh skew still counts as
					// needing refresh, so returning it here would make the final candidate pass
					// refresh the same row again and replay the token we just failed on.
					return result.credential;
				}
				throw new AIError.OAuthError(
					`OAuth refresh did not produce a usable credential for provider: ${provider}`,
					{
						kind: "token-refresh",
						provider,
					},
				);
			}
			throw new AIError.OAuthError(`OAuth credential no longer exists for provider: ${provider}`, {
				kind: "token-refresh",
				provider,
			});
		}
		return this.#requestOAuthCredentialRefresh(provider, credential, credentialId, signal);
	}

	async #requestOAuthCredentialRefresh(
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
				refreshPromise = customProvider.refreshToken(credential, signal);
			} else {
				refreshPromise = refreshOAuthToken(provider as OAuthProvider, credential, signal);
			}
		}
		// Bound the refresh so a slow/hanging token endpoint cannot stall credential selection.
		// Caller-driven abort jumps the gun on the timeout — the agent's ESC must
		// take priority over the floor timeout.
		const cancellation = Promise.withResolvers<never>();
		let onAbort: (() => void) | undefined;
		const timeout = setTimeout(
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
			clearTimeout(timeout);
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
			planRequirement?: OpenAICodexPlanRequirement;
			enforcePlanRequirement?: boolean;
			strategy?: CredentialRankingStrategy;
			rankingContext?: CredentialRankingContext;
			blockScope?: string;
			blockScopes?: readonly string[];
			/** When false, a definitive failure of THIS credential returns undefined instead of falling back to the ranked/round-robin selector (target-only resolution). */
			allowFallback?: boolean;
		},
	): Promise<OAuthResolutionResult | undefined> {
		const {
			checkUsage,
			allowBlocked,
			prefetchedUsage = null,
			usagePrechecked = false,
			planRequirement: providedPlanRequirement,
			enforcePlanRequirement,
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
			allowFallback = true,
		} = usageOptions;
		if (
			!allowBlocked &&
			this.#isCredentialBlocked(provider, providerKey, selection.index, blockScopes ?? blockScope)
		) {
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

		const planRequirement = providedPlanRequirement ?? resolveOpenAICodexPlanRequirement(provider, options?.modelId);
		const hasPlanRequirement = planRequirement !== "none";
		const applyPlanFilter = enforcePlanRequirement ?? hasPlanRequirement;
		let usage: UsageReport | null = null;
		let usageChecked = false;

		if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
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
			if (applyPlanFilter && getOpenAICodexPlanEligibility(usage, planRequirement) !== true) {
				return undefined;
			}
			if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
				const scopedLimits = this.#getScopedUsageLimits(strategy, usage, rankingContext);
				if (this.#isUsageLimitReached(scopedLimits)) {
					const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
					this.#markCredentialBlocked(
						provider,
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
				orgId: result.newCredentials.orgId ?? selection.credential.orgId,
				orgName: result.newCredentials.orgName ?? selection.credential.orgName,
				authorizedAt: result.newCredentials.authorizedAt ?? selection.credential.authorizedAt,
			};
			if (credentialId !== undefined) {
				const idx = this.#replaceCredentialById(provider, credentialId, updated);
				if (idx !== -1) selection.index = idx;
			} else {
				this.#replaceCredentialAt(provider, selection.index, updated);
			}
			if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
				const sameAccount = selection.credential.accountId === updated.accountId;
				if (!usageChecked || !sameAccount) {
					usage = await this.#getUsageReport(provider, updated, {
						...options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
				}
				if (applyPlanFilter && getOpenAICodexPlanEligibility(usage, planRequirement) !== true) {
					return undefined;
				}
				if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
					const scopedLimits = this.#getScopedUsageLimits(strategy, usage, rankingContext);
					if (this.#isUsageLimitReached(scopedLimits)) {
						const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
						this.#markCredentialBlocked(
							provider,
							providerKey,
							selection.index,
							resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
							blockScope,
						);
						return undefined;
					}
				}
			}
			this.#recordOAuthBearerCredentialId(provider, result.apiKey, credentialId);
			this.#recordSessionCredential(provider, sessionId, "oauth", selection.index);
			return { apiKey: result.apiKey, credential: updated, credentialId };
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
				const outcome = await this.#disableDefinitiveOAuthFailure(
					provider,
					credentialId,
					selection.credential,
					selection.index,
					errorMsg,
				);
				if (outcome === "peer-rotated") {
					if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
					return undefined;
				}
				if (outcome === "cas-lost") return undefined;
				if (this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth")) {
					if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
				}
			} else {
				// Block temporarily for transient failures (5 minutes)
				this.#markCredentialBlocked(
					provider,
					providerKey,
					selection.index,
					Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
				);
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

		// Precedence: a deliberate OAuth/login credential wins, then an explicit env var,
		// then a stored static api_key (which may be a stale broker-migrated copy) as a last resort.
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

		const loginApiKeySelection = this.#selectCredentialByType(
			provider,
			"api_key",
			undefined,
			credential => credential.type === "api_key" && credential.source === "login",
		);
		if (loginApiKeySelection) {
			return this.#configValueResolver(loginApiKeySelection.credential.key);
		}

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		const apiKeySelection = this.#selectCredentialByType(provider, "api_key");
		if (apiKeySelection) {
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

		return this.#fallbackResolver?.(provider) ?? undefined;
	}

	/**
	 * Get API key for a provider.
	 * Priority (first match wins):
	 * 1. Runtime override (CLI --api-key)
	 * 2. Config override (models.yml `providers.<name>.apiKey`)
	 * 3. OAuth token from storage (auto-refreshed)
	 * 4. API key persisted by a successful `/login`
	 * 5. Environment variable
	 * 6. Stored API key (e.g. a broker-migrated copy) — last resort, so an explicit env var wins
	 * 7. Fallback resolver (models.yml custom providers, last-resort)
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

		// Precedence: a deliberate OAuth/login credential wins, then an explicit env var,
		// then a stored static api_key (which may be a stale broker-migrated copy) as a last resort.
		const oauthResolved = await this.#resolveOAuthSelection(provider, sessionId, options);
		if (oauthResolved) {
			return oauthResolved.apiKey;
		}
		const loginApiKeySelection = await this.#selectApiKeyCredential(
			provider,
			sessionId,
			options,
			credential => credential.source === "login",
		);
		if (loginApiKeySelection) {
			this.#recordSessionCredential(provider, sessionId, "api_key", loginApiKeySelection.index);
			return this.#configValueResolver(loginApiKeySelection.credential.key);
		}

		// Past OAuth: the session sticky (if any) is stale — the request authenticates via
		// env/api_key/fallback, not OAuth, so clear it now so getOAuthAccountId() correctly
		// suppresses account_uuid for this session.
		if (sessionId) this.#sessionLastCredential.get(provider)?.delete(sessionId);

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;
		const apiKeySelection = await this.#selectApiKeyCredential(
			provider,
			sessionId,
			options,
			credential => credential.source !== "login",
		);
		if (apiKeySelection) {
			this.#recordSessionCredential(provider, sessionId, "api_key", apiKeySelection.index);
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

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
		const { credential, credentialId } = resolved;
		return {
			accessToken: credential.access,
			credentialId,
			accountId: credential.accountId,
			email: credential.email,
			projectId: credential.projectId,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
			orgId: credential.orgId,
			orgName: credential.orgName,
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
					orgId: selection.credential.orgId,
					orgName: selection.credential.orgName,
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
				orgId: credential.orgId,
				orgName: credential.orgName,
			};
		} catch (error) {
			return {
				ok: false,
				credentialId: selection.credentialId,
				accountId: selection.credential.accountId,
				email: selection.credential.email,
				projectId: selection.credential.projectId,
				enterpriseUrl: selection.credential.enterpriseUrl,
				orgId: selection.credential.orgId,
				orgName: selection.credential.orgName,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Read-only list of stored OAuth accounts for `provider` in stable storage
	 * order, WITHOUT refreshing any token. The array position (0-based) is the
	 * selector accepted by {@link AuthStorage.getOAuthAccessAt}; a "pick the Nth
	 * account" UI should render `position + 1`.
	 *
	 * When `sessionId` is supplied, the session-sticky OAuth credential is marked
	 * `active`. No account is active before that session has resolved or pinned a
	 * credential.
	 */
	listOAuthAccounts(provider: string, sessionId?: string): OAuthAccountSummary[] {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return [];
		}
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		const activeCredentialId =
			sessionCredential?.type === "oauth"
				? this.#getStoredCredentials(provider)[sessionCredential.index]?.id
				: undefined;
		return this.#getStoredOAuthSelections(provider).map((selection, position) => ({
			position,
			credentialId: selection.credentialId,
			accountId: selection.credential.accountId,
			email: selection.credential.email,
			projectId: selection.credential.projectId,
			enterpriseUrl: selection.credential.enterpriseUrl,
			orgId: selection.credential.orgId,
			orgName: selection.credential.orgName,
			active: selection.credentialId === activeCredentialId,
		}));
	}

	/**
	 * Pin one stored OAuth account as this session's preferred credential.
	 *
	 * The durable credential id keeps the pin stable across credential refreshes,
	 * storage reordering, and process restarts. Normal auth retry and usage-limit
	 * handling may still route around an unavailable account.
	 *
	 * `options.lastUsedAtMs` backdates the sticky's last-use timestamp so a pin
	 * restored from a persisted session keeps the provider's warm-window
	 * semantics: a resume inside the prompt-cache TTL reuses the account, a
	 * stale resume still re-ranks.
	 */
	pinSessionOAuthAccount(
		provider: string,
		sessionId: string,
		credentialId: number,
		options?: { lastUsedAtMs?: number },
	): boolean {
		if (!sessionId || this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return false;
		}
		const stored = this.#getStoredCredentials(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		const target = stored[index];
		if (target?.credential.type !== "oauth") return false;
		this.#recordSessionCredential(provider, sessionId, "oauth", index, options?.lastUsedAtMs);
		return true;
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
	 * Resolve one stored OAuth credential by its durable storage row id.
	 *
	 * Unlike the normal session resolver, this method never ranks, rotates, or
	 * falls back to sibling credentials. A forced refresh re-mints only the
	 * requested row, preserving exact-account affinity for operations whose
	 * provenance and policy boundary are tied to one workspace.
	 *
	 * Returns `undefined` when the row does not exist for `provider` or an
	 * explicit runtime/config API-key override suppresses OAuth.
	 */
	async getOAuthAccessByCredentialId(
		provider: string,
		credentialId: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return undefined;
		}
		const selection = this.#getStoredOAuthSelections(provider).find(
			candidate => candidate.credentialId === credentialId,
		);
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
			// Transport/auth failure is NOT "no credits": callers treat `no_credit`
			// as terminal for the episode, so conflating them would bury a live
			// credit behind one flaky request.
			if (!list) {
				return { ok: false, code: "credit_list_failed", accountId: match.accountId, email: match.email };
			}
			const credit = pickSoonestExpiringCredit(list.credits);
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
			if (this.#store.invalidateUsageCache) {
				await this.#store.invalidateUsageCache(options.signal).catch(err => {
					logger.debug("Failed to notify store of stale usage", { err });
				});
			}
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
		this.#usageCacheEpoch += 1;
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
	 * Expire cached reports for a provider after its runtime usage implementation changes.
	 * This keeps a newly installed extension provider from serving a built-in snapshot.
	 */
	#invalidateUsageReportCacheForProvider(provider: Provider): void {
		this.#usageCacheEpoch += 1;
		const expired = Date.now() - 1;
		const prefix = `report:${this.#usageCacheProviderKey(provider)}:`;
		if (this.#usageCache.deletePrefix(prefix)) return;
		const cacheKeys = new Set(this.#usageReportCacheKeysByProvider.get(provider));
		for (const entry of this.#getStoredCredentials(provider)) {
			cacheKeys.add(
				this.#buildUsageReportCacheKey({
					provider,
					credential: this.#buildUsageCredential(entry.credential),
				}),
			);
		}
		for (const cacheKey of cacheKeys) {
			this.#usageCache.set(cacheKey, { value: null, expiresAt: expired });
		}
	}
	/**
	 * Drop report snapshots for a user-requested refresh so a failed probe
	 * cannot replay the pre-invalidation last-good value. The persisted marker
	 * makes the next same-provider refresh serial rather than a cold fan-out.
	 */
	async #clearUsageReportCache(provider?: string): Promise<void> {
		this.#usageCacheEpoch += 1;
		const prefix = provider ? `report:${this.#usageCacheProviderKey(provider)}:` : "report:";
		if (!this.#usageCache.deletePrefix(prefix)) {
			// Third-party stores may not support prefix deletion. Clear every active
			// request key instead, including API-key and environment credentials.
			const requests = await this.#collectUsageRequests();
			for (const request of requests) {
				if (provider && request.provider !== provider) continue;
				this.#usageCache.set(this.#buildUsageReportCacheKey(request), { value: null, expiresAt: 0 });
			}
		}
		if (!this.#fetchUsageReportsOverride && !this.#store.fetchUsageReports) this.#markUsageForceRefresh(provider);
	}

	/**
	 * Discard cached usage reports before a user-requested refresh. The next
	 * read probes upstream serially per provider; a failure reports no fresh
	 * usage instead of replaying an invalidated last-good snapshot.
	 */
	async invalidateUsageCache(provider?: string, signal?: AbortSignal): Promise<void> {
		await this.#clearUsageReportCache(provider);

		if (this.#store.invalidateUsageCache) {
			await this.#store.invalidateUsageCache(signal).catch(err => {
				logger.debug("Failed to notify store of stale usage", { err });
			});
		}
	}

	#invalidateUsageReportCacheForProviderKey(providerKey: string): void {
		const oauthSuffix = ":oauth";
		if (!providerKey.endsWith(oauthSuffix)) return;
		this.#invalidateUsageReportCache(providerKey.slice(0, -oauthSuffix.length));
	}

	/**
	 * Lift any temporary backoff blocks on one credential (across the bare
	 * `provider:oauth` key and its scoped `\0`-suffixed derivatives). Called
	 * after a saved reset is redeemed so the just-reset account is immediately
	 * selectable again instead of being skipped/under-ranked by a stale block
	 * that `markUsageLimitReached` set for the now-obsolete reset time.
	 */
	#clearCredentialBlocks(provider: string, credentialId: number): void {
		try {
			this.deleteCredentialBlocks(credentialId);
		} catch (err) {
			logger.debug("Failed to clear persisted credential blocks", { err, provider, credentialId });
		}

		const index = this.#getStoredCredentials(provider).findIndex(entry => entry.id === credentialId);
		if (index < 0) return;
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const scopedPrefix = `${providerKey}\0`;
		for (const [key, backoffMap] of this.#credentialBackoff) {
			if (key !== providerKey && !key.startsWith(scopedPrefix)) continue;
			backoffMap.delete(index);
			if (backoffMap.size === 0) this.#credentialBackoff.delete(key);
		}
		for (const [key, probeAfterMap] of this.#credentialBackoffProbeAfter) {
			if (key !== providerKey && !key.startsWith(scopedPrefix)) continue;
			probeAfterMap.delete(index);
			if (probeAfterMap.size === 0) this.#credentialBackoffProbeAfter.delete(key);
		}
	}

	/**
	 * Self-heal a stale Codex usage-limit block: when a fresh live usage report
	 * says the account is allowed and below every reported limit, drop the
	 * persisted and in-memory `openai-codex:oauth` blocks so credential selection
	 * can re-include recovered seats before a stale block naturally expires.
	 */
	/**
	 * Narrow a usage report to the limits a backoff scope covers, so a scope is
	 * judged only by the meters it gates. A legacy scope that meant "block
	 * everything" keeps the whole report.
	 */
	#scopeUsageReportToBlockScope(
		report: UsageReport,
		blockScope: string | undefined,
		strategy: CredentialRankingStrategy | undefined,
	): UsageReport {
		if (!blockScope || !strategy?.scopeLimits || !strategy.blockScopes) return report;
		// Find a request context whose scope set leads with this scope; its scoped
		// limits are the ones this block gates.
		const modelId = blockScope === "spark" ? "gpt-5.3-codex-spark" : "gpt-5.3-codex";
		if (strategy.blockScopes({ modelId })[0] !== blockScope) return report;
		const scopedLimits = strategy.scopeLimits(report, { modelId });
		const meterStates = report.metadata?.meterStates;
		const meterState =
			meterStates !== null && typeof meterStates === "object"
				? (meterStates as Record<string, { allowed?: boolean; limitReached?: boolean }>)[blockScope]
				: undefined;
		return {
			...report,
			limits: scopedLimits,
			metadata:
				meterState || blockScope === "spark"
					? {
							...report.metadata,
							allowed: meterState?.allowed,
							limitReached: meterState?.limitReached,
						}
					: report.metadata,
		};
	}

	/**
	 * Clear one backoff scope. The in-memory backoff is per scope so it is
	 * dropped directly; the persisted store deletes a credential's blocks as a
	 * unit, so it is only purged once no other scope still holds a live block.
	 * Leaving a persisted row behind is safe: the scope it belongs to is
	 * unblocked in memory, and the row heals on the pass where its own meter
	 * recovers.
	 */
	#clearCredentialBlockScope(
		provider: string,
		credentialId: number,
		credentialIndex: number,
		providerKey: string,
		blockScope: string | undefined,
	): void {
		const key = this.#toScopedBackoffKey(providerKey, blockScope);
		const backoffMap = this.#credentialBackoff.get(key);
		backoffMap?.delete(credentialIndex);
		if (backoffMap?.size === 0) this.#credentialBackoff.delete(key);
		const probeAfterMap = this.#credentialBackoffProbeAfter.get(key);
		probeAfterMap?.delete(credentialIndex);
		if (probeAfterMap?.size === 0) this.#credentialBackoffProbeAfter.delete(key);
		try {
			this.deleteCredentialBlock(credentialId, providerKey, blockScope ?? "");
		} catch (err) {
			logger.debug("Failed to clear persisted credential block", { err, provider, credentialId, blockScope });
		}
	}

	#isHealthyCodexUsageReport(report: UsageReport): boolean {
		if (report.provider !== "openai-codex") return false;
		const metadata = report.metadata;
		if (metadata?.allowed !== true || metadata.limitReached !== false) return false;
		return !this.#isUsageLimitReached(report.limits);
	}

	#reconcileCodexUsageBlockForCredential(provider: Provider, credentialId: number, report: UsageReport): void {
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const credentialIndex = this.#getStoredCredentials(provider).findIndex(entry => entry.id === credentialId);
		if (credentialIndex < 0) return;
		// Mirror selection: consult the same strategy scope `markUsageLimitReached`
		// persists under, else a scoped block is invisible here and never healed.
		// Reconciliation has no request context, so it cannot know which scope a
		// block was written under. Heal every scope the strategy can produce, plus
		// any legacy scope it still lists, or a block persisted under one scope
		// stays invisible here forever.
		const strategy = this.#rankingStrategyResolver?.(provider);
		const blockScopes =
			strategy?.blockScopes?.() ?? [strategy?.blockScope?.({})].filter(scope => scope !== undefined);
		const scopesToHeal = blockScopes.length > 0 ? blockScopes : [undefined];
		for (const blockScope of scopesToHeal) {
			this.#healCodexUsageBlockScope(
				provider,
				providerKey,
				credentialId,
				credentialIndex,
				blockScope,
				report,
				strategy,
			);
		}
	}

	/**
	 * Heal one backoff scope against the limits that scope actually covers.
	 *
	 * Judging a scope by the whole report is wrong once scopes are per-meter: an
	 * exhausted Spark meter would keep a recovered chat block alive, and healing
	 * would then delete every scope including a block that is still valid. So
	 * each scope is evaluated against its own limits and cleared on its own.
	 */
	#healCodexUsageBlockScope(
		provider: Provider,
		providerKey: string,
		credentialId: number,
		credentialIndex: number,
		blockScope: string | undefined,
		report: UsageReport,
		strategy: CredentialRankingStrategy | undefined,
	): void {
		const scopedReport = this.#scopeUsageReportToBlockScope(report, blockScope, strategy);
		if (!this.#isHealthyCodexUsageReport(scopedReport)) return;
		const blockedUntilMs = this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope);
		if (blockedUntilMs === undefined) return;
		// `/usage` can lag the request path that just returned 429. Fresh local or
		// broker-sourced blocks get one usage-cache window before healthy reports may
		// clear them.
		const nowMs = Date.now();
		const scopedBackoffKey = this.#toScopedBackoffKey(providerKey, blockScope);
		const globalProbeAfterMs = this.#credentialBackoffProbeAfter.get(providerKey)?.get(credentialIndex) ?? 0;
		const scopedProbeAfterMs = this.#credentialBackoffProbeAfter.get(scopedBackoffKey)?.get(credentialIndex) ?? 0;
		const storeGlobalProbeAfterMs = this.#readPersistedCredentialBlockReconcileAfter(credentialId, providerKey, "");
		const storeScopedProbeAfterMs = this.#readPersistedCredentialBlockReconcileAfter(
			credentialId,
			providerKey,
			blockScope ?? "",
		);
		if (Math.max(globalProbeAfterMs, scopedProbeAfterMs, storeGlobalProbeAfterMs, storeScopedProbeAfterMs) > nowMs) {
			return;
		}
		this.#clearCredentialBlockScope(provider, credentialId, credentialIndex, providerKey, blockScope);
		logger.info("Cleared stale Codex usage-limit block after healthy live usage report", {
			credentialId,
			provider,
			blockScope,
			clearedBlockedUntilMs: blockedUntilMs,
		});
	}

	#reconcileCodexUsageBlock(request: UsageRequestDescriptor, report: UsageReport): void {
		if (request.provider !== "openai-codex") return;
		const credentialId = this.#findStoredCredentialIdForUsageCredential(request.provider, request.credential);
		if (credentialId === undefined) return;
		this.#reconcileCodexUsageBlockForCredential(request.provider, credentialId, report);
	}

	#findStoredCredentialIdsForUsageReport(report: UsageReport): number[] {
		if (report.provider !== "openai-codex") return [];
		const email = this.#getUsageReportMetadataValue(report, "email")?.toLowerCase();
		const accountId = (
			this.#getUsageReportMetadataValue(report, "accountId") ?? this.#getUsageReportScopeAccountId(report)
		)?.toLowerCase();
		if (!email && !accountId) return [];
		const matches: number[] = [];
		for (const entry of this.#getStoredCredentials(report.provider)) {
			const credential = entry.credential;
			if (credential.type !== "oauth") continue;
			const credentialEmail = credential.email?.trim().toLowerCase();
			const credentialAccountId = credential.accountId?.trim().toLowerCase();
			// Every identity dimension present on BOTH sides must agree — the
			// account id is shared workspace-wide and one email can span
			// workspaces, so a single-dimension match can cross-link siblings.
			const emailComparable = Boolean(email && credentialEmail);
			const accountComparable = Boolean(accountId && credentialAccountId);
			if (!emailComparable && !accountComparable) continue;
			if (emailComparable && credentialEmail !== email) continue;
			if (accountComparable && credentialAccountId !== accountId) continue;
			matches.push(entry.id);
		}
		return matches;
	}

	#reconcileCodexUsageBlocksFromReports(reports: UsageReport[]): void {
		const reconciled = new Set<number>();
		for (const report of reports) {
			for (const credentialId of this.#findStoredCredentialIdsForUsageReport(report)) {
				if (reconciled.has(credentialId)) continue;
				reconciled.add(credentialId);
				this.#reconcileCodexUsageBlockForCredential(report.provider, credentialId, report);
			}
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
			provider,
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
	 * Rotate away from the credential that failed after a retryable auth error —
	 * step (c) of the auth-retry policy. Prefer the failed stored row id supplied
	 * in `options.credentialId`, then the failed bearer supplied in
	 * `options.apiKey`, so overlapping requests cannot redirect rotation through
	 * stale session stickiness. Fall back to the session-sticky credential only
	 * when neither explicit target is available. For hard-auth errors, an explicit
	 * target that no longer matches storage returns `false` without mutation.
	 * Delayed usage-limit errors may instead recover the durable OAuth row from
	 * the bearer fingerprint recorded when the request resolved.
	 *
	 * - usage-limit / account-rate-limit error → {@link AuthStorage.markUsageLimitReached}
	 *   (temporary block via its own backoff — default plus server usage-report
	 *   reset; sticky left intact so the next resolve re-ranks around the block).
	 * - exact model-entitlement denial (Codex ChatGPT account or Cursor plan) →
	 *   temporarily block only that requested model, then rotate.
	 * - other account-scoped policy denial → temporarily block that account
	 *   without marking its credential suspect, then rotate through siblings.
	 * - otherwise (hard 401 / auth failure) → mark the credential suspect (or
	 *   reload when no broker hook is wired) and block it, then drop matching
	 *   sticky state.
	 *
	 * Returns whether another usable credential of the same type remains.
	 */
	async rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: { error?: unknown; modelId?: string; apiKey?: string; credentialId?: number; signal?: AbortSignal },
	): Promise<boolean> {
		const error = options?.error;
		const status = AIError.status(error);
		const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
		const exactCursorModelPolicy = AIError.isCursorPlanAccountPolicyError(error, provider);
		const accountPolicy = exactCursorModelPolicy || AIError.isAccountPolicyError(error);
		if (!accountPolicy && (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message))) {
			// Thread the provider-specified reset window (e.g. Devin "Your limit
			// will reset in 13 minutes") into the block duration so the credential
			// is not reselected and hammered while the cap remains active.
			const retryAfterMs = extractRetryHint(undefined, message);
			return (
				await this.markUsageLimitReached(provider, sessionId, {
					retryAfterMs,
					modelId: options?.modelId,
					apiKey: options?.apiKey,
					credentialId: options?.credentialId,
					signal: options?.signal,
				})
			).switched;
		}

		const sessionCredential = await this.#resolveCredentialTarget(provider, sessionId, {
			credentialId: options?.credentialId,
			apiKey: options?.apiKey,
		});
		if (!sessionCredential) return false;

		const deniedModel = AIError.codexChatGPTAccountPolicyModel(error);
		const exactCodexModelPolicy =
			deniedModel !== undefined && AIError.isCodexChatGPTAccountPolicyError(error, provider, options?.modelId);
		const exactModelPolicy = exactCodexModelPolicy || exactCursorModelPolicy;
		// The exact sentence is provider-controlled input. A non-Codex provider,
		// absent request model, or mismatched model must not turn it into either a
		// global block or a hard-auth invalidation.
		if (deniedModel !== undefined && !exactCodexModelPolicy) return false;
		if (exactModelPolicy || accountPolicy) {
			const modelPolicyScope = exactModelPolicy
				? modelAccountPolicyBlockScope(provider, options?.modelId)
				: undefined;
			if (exactModelPolicy && modelPolicyScope === undefined) return false;
			const routing = this.#credentialBlockRouting(
				provider,
				sessionCredential.type,
				options?.modelId,
				modelPolicyScope,
			);
			return this.#blockCredentialForRotation(
				provider,
				sessionCredential.type,
				sessionCredential.index,
				Date.now() + AuthStorage.#defaultBackoffMs,
				routing,
			).switched;
		}

		const providerKey = this.#getProviderTypeKey(provider, sessionCredential.type);
		// Snapshot sibling availability before mutating so a soft-deleting
		// suspect hook can't reindex the answer out from under us.
		const hasSibling = this.#getCredentialsForProvider(provider).some(
			(credential, index) =>
				credential.type === sessionCredential.type &&
				index !== sessionCredential.index &&
				!this.#isCredentialBlocked(provider, providerKey, index),
		);
		const target = this.#getStoredCredentials(provider)[sessionCredential.index];
		const sticky = this.#getSessionCredential(provider, sessionId);
		if (
			!sessionCredential.explicit ||
			(sticky?.type === sessionCredential.type && sticky.index === sessionCredential.index)
		) {
			this.#clearSessionCredential(provider, sessionId);
		}
		this.#markCredentialBlocked(
			provider,
			providerKey,
			sessionCredential.index,
			Date.now() + AuthStorage.#defaultBackoffMs,
		);

		if (target && AIError.isInvalidatedOAuthTokenError(error)) {
			const disabledCause = message ?? "upstream reported invalidated OAuth token";
			const deleted = this.#store.deleteAuthCredentialRemote
				? await this.#store.deleteAuthCredentialRemote(target.id, disabledCause)
				: this.disableCredentialById(target.id, disabledCause);
			if (deleted) {
				const latestRows = this.#store.listAuthCredentials(provider);
				this.#setStoredCredentials(
					provider,
					latestRows.map(row => ({ id: row.id, credential: row.credential })),
				);
			}
			return deleted && hasSibling;
		}

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
	 * - step (c) `lastChance` → rotate to a sibling and re-resolve, unless quota exhaustion has no sibling.
	 *
	 * Used by web-search providers and other consumers that hold an AuthStorage
	 * directly (no ModelRegistry in scope).
	 */
	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver {
		const { sessionId, baseUrl, modelId } = options ?? {};
		return async ({ lastChance, error, signal, previousKey }) => {
			if (error === undefined) {
				return this.getApiKey(provider, sessionId, { baseUrl, modelId, signal });
			}
			if (lastChance) {
				const switched = await this.rotateSessionCredential(provider, sessionId, {
					error,
					modelId,
					signal,
					apiKey: previousKey,
				});
				if (!switched) {
					const status = AIError.status(error);
					const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
					// Preserve no-sibling quota backoff instead of re-resolving an
					// already-blocked fallback. Hard-auth declines still re-resolve
					// because a peer may have refreshed the failed bearer.
					if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) return undefined;
				}
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
	 * Disabled credential tombstones for display surfaces (`omp usage`,
	 * broker `GET /v1/credentials/disabled`). Empty when the backing store
	 * keeps no tombstones or the remote broker predates the endpoint.
	 */
	async listDisabledCredentials(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]> {
		if (!this.#store.listDisabledCredentials) return [];
		return this.#store.listDisabledCredentials(provider, signal);
	}

	/**
	 * Force the backing store to revalidate its credential snapshot, then
	 * reload. Remote broker stores re-fetch the snapshot; local stores are
	 * always current, so only the reload runs. Callers that pair live
	 * per-credential data with stored identities (`omp usage`) use this so a
	 * disk-cached snapshot cannot misattribute fresh reports.
	 */
	async revalidateCredentials(): Promise<void> {
		if (this.#store.refreshSnapshot) await this.#store.refreshSnapshot();
		await this.reload();
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
				orgId: refreshed.orgId ?? attempted.orgId,
				orgName: refreshed.orgName ?? attempted.orgName,
				authorizedAt: refreshed.authorizedAt ?? attempted.authorizedAt,
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
	 * Broker-server seam: list non-expired persisted blocks for snapshot entries.
	 */
	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		if (this.#persistedBlockStoreDamaged) return [];
		const listCredentialBlocks = this.#store.listCredentialBlocks?.bind(this.#store);
		if (!listCredentialBlocks) return [];
		try {
			return listCredentialBlocks(credentialIds);
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) return [];
			throw err;
		}
	}

	/**
	 * Broker-server seam: persist one credential block and notify snapshot waiters.
	 */
	upsertCredentialBlock(block: StoredCredentialBlock): void {
		this.#assertPersistedBlockStoreWritable();
		const upsertCredentialBlock = this.#store.upsertCredentialBlock?.bind(this.#store);
		if (!upsertCredentialBlock) return;
		try {
			upsertCredentialBlock(block);
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) this.#assertPersistedBlockStoreWritable();
			throw err;
		}
		this.#invalidateUsageReportCacheForProviderKey(block.providerKey);
		this.#bumpGeneration("credential-block");
	}

	/**
	 * Broker-server seam: clear all persisted blocks for one credential and notify snapshot waiters.
	 */
	deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
		this.#assertPersistedBlockStoreWritable();
		const deleteCredentialBlock = this.#store.deleteCredentialBlock?.bind(this.#store);
		if (!deleteCredentialBlock) return;
		try {
			deleteCredentialBlock(credentialId, providerKey, blockScope);
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) this.#assertPersistedBlockStoreWritable();
			throw err;
		}
		this.#invalidateUsageReportCacheForProviderKey(providerKey);
		this.#bumpGeneration("credential-block");
	}

	deleteCredentialBlocks(credentialId: number): void {
		this.#assertPersistedBlockStoreWritable();
		const deleteCredentialBlocks = this.#store.deleteCredentialBlocks?.bind(this.#store);
		if (!deleteCredentialBlocks) return;
		try {
			deleteCredentialBlocks(credentialId);
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) this.#assertPersistedBlockStoreWritable();
			throw err;
		}
		this.#bumpGeneration("credential-block");
	}

	/**
	 * Describe where the active credential for a provider came from.
	 *
	 * Mirrors {@link AuthStorage.getApiKey} precedence, highest first:
	 *   1. Runtime override (`--api-key`).
	 *   2. Config override (`models.yml` `providers.<name>.apiKey`).
	 *   3. Stored OAuth credential.
	 *   4. API key persisted by a successful `/login`.
	 *   5. Env var — overrides a stored static api_key (e.g. a stale broker copy).
	 *   6. Stored api_key credential.
	 *   7. Fallback resolver.
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
		const session = sessionId ? this.#sessionLastCredential.get(provider)?.get(sessionId) : undefined;
		const describeStored = (
			type: AuthCredential["type"],
			filter?: (credential: AuthCredential) => boolean,
		): string | undefined => {
			const typed = stored
				.map((entry, index) => ({ entry, index }))
				.filter(({ entry }) => entry.credential.type === type && (filter?.(entry.credential) ?? true));
			if (typed.length === 0) return undefined;
			const sticky = session?.type === type ? typed.find(entry => entry.index === session.index) : undefined;
			const chosen = sticky?.entry ?? typed[0].entry;
			const credential = chosen.credential;
			const identity =
				credential.type === "oauth"
					? (credential.email ?? credential.accountId ?? credential.projectId ?? `cred ${chosen.id}`)
					: `cred ${chosen.id}`;
			return `${baseLabel} · ${type} #${chosen.id} (${identity})`;
		};

		// Deliberate login credentials win; then an explicit env var; then a stored static api_key.
		const oauthSource = describeStored("oauth");
		if (oauthSource) return oauthSource;
		const loginApiKeySource = describeStored(
			"api_key",
			credential => credential.type === "api_key" && credential.source === "login",
		);
		if (loginApiKeySource) return loginApiKeySource;
		if (getEnvApiKey(provider)) return `env (over ${baseLabel})`;
		const apiKeySource = describeStored(
			"api_key",
			credential => credential.type !== "api_key" || credential.source !== "login",
		);
		if (apiKeySource) return apiKeySource;
		if (this.#fallbackResolver?.(provider) !== undefined) return "fallback resolver";
		return undefined;
	}
}
