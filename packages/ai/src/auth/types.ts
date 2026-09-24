import type { ApiKeyResolver, ResolvedApiKey } from "../auth-retry";
import type {
	OAuthAuthInfo,
	OAuthController,
	OAuthCredentials,
	OAuthPrompt,
	OAuthProviderId,
} from "../registry/oauth/types";
import type { Provider } from "../types";
import type {
	ClientUsageIdentity,
	ClientUsageReport,
	ClientUsageSummary,
	CredentialRankingStrategy,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLogger,
	UsageProvider,
	UsageReport,
	UsageResetCredit,
	UsageResetCredits,
} from "../usage";

/** Default remaining quota protected for accounts without an explicit policy override. */
export const DEFAULT_USAGE_RESERVE_PCT = 10;
/** Default short-window usage threshold above which an account is demoted as hot during ranking. */
export const DEFAULT_HOT_WINDOW_FRACTION = 0.85;

/** Stored API key used by credential selection. */
export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	source?: "login";
};

/** Stored OAuth token and provider account identity. */
export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

/** Stored API-key or OAuth credential in the provider pool. */
export type AuthCredential = ApiKeyCredential | OAuthCredential;

/** One or more credentials configured for a provider. */
export type AuthCredentialEntry = AuthCredential | AuthCredential[];

/** Provider-to-credential snapshot returned by the storage facade. */
export type AuthStorageData = Record<string, AuthCredentialEntry>;

/** Identity fields matched by an account routing policy. */
export interface AuthAccountSelector {
	readonly email?: string;
	readonly accountId?: string;
	readonly projectId?: string;
	/** Optional organization/workspace qualifier; not a base identity by itself. */
	readonly orgId?: string;
}

/** Priority and reserve policy for a provider account. */
export interface AuthAccountPolicy {
	readonly provider: string;
	readonly account: AuthAccountSelector;
	/** Higher values win after hard, plan, reserve, hot-window, and measured-usage safety checks. */
	readonly priority?: number;
	/** Protected remaining quota percentage for this account. */
	readonly reservePct?: number;
	/** Short-window usage fraction threshold (0..1) above which this account is demoted as hot during ranking. */
	readonly hotWindowFraction?: number;
}

/** Read-only set of per-account routing policies. */
export type AuthAccountPolicies = readonly AuthAccountPolicy[];

/**
 * Cascade leg that supplies a provider's active credential, highest precedence
 * first — mirrors {@link AuthStorage.keys.get}'s resolution order.
 */
export type CredentialOriginKind = "runtime" | "config" | "oauth" | "api_key" | "env";

/**
 * Structured provenance for a provider's auth, for UI that needs a machine
 * tag (the `/login` provider list) rather than the prose of
 * {@link AuthStorage.keys.describe}.
 */
export interface CredentialOrigin {
	kind: CredentialOriginKind;
	/** Env var name when `kind === "env"` and a single named variable backs it. */
	envVar?: string;
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
 * Per-credential health record returned by {@link AuthStorage.health.check}.
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

/** Caller-supplied completion check for one credential. */
export type CompletionProbe = (input: CompletionProbeInput) => Promise<CredentialCompletionResult>;

/** Control usage and completion probes for credential health. */
export interface CheckCredentialsOptions {
	signal?: AbortSignal;
	/** Per-credential probe timeout (ms). Defaults to the configured usage request timeout. */
	timeoutMs?: number;
	/** Provider → base URL override, same shape as {@link AuthStorage.usage.reports}. */
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
 * via {@link AuthStorage.credentials.snapshot}. Refresh tokens never leave the broker;
 * clients must call back to refresh.
 */
export const REMOTE_REFRESH_SENTINEL = "__remote__" as const;
/** Opaque marker for OAuth refresh tokens retained by a broker. */
export type RemoteRefreshSentinel = typeof REMOTE_REFRESH_SENTINEL;

/** OAuth credential with refresh token replaced by the broker sentinel. */
export type RemoteOAuthCredential = Omit<OAuthCredential, "refresh"> & {
	refresh: RemoteRefreshSentinel;
};

/** Discriminated credential payload as published by the broker. */
export type SnapshotCredential = ApiKeyCredential | RemoteOAuthCredential;

/** Broker snapshot row with identity and durable ID. */
export interface AuthCredentialSnapshotEntry {
	id: number;
	provider: string;
	credential: SnapshotCredential;
	identityKey: string | null;
}

/**
 * Wire-shaped snapshot exported by {@link AuthStorage.credentials.snapshot} and
 * served by the auth-broker server on `GET /v1/snapshot`.
 */
export interface AuthCredentialSnapshot {
	generation: number;
	generatedAt: number;
	credentials: AuthCredentialSnapshotEntry[];
}

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

/** Configuration supplied when constructing credential storage. */
export type AuthStorageOptions = {
	usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	accountPolicies?: AuthAccountPolicies;
	/** Global reserve fallback for accounts without a matching reservePct policy. */
	defaultReservePct?: number;
	/** Global short-window hot fraction threshold (0..1) above which accounts are demoted during ranking. Default: 0.85. */
	hotWindowFraction?: number;
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
	 * AuthStorage instance. Surfaced through {@link AuthStorage.keys.describe}
	 * so the TUI can show where a token came from (broker URL or local SQLite path).
	 *
	 * Examples:
	 * - `"local ~/.omp/agent/agent.db"`
	 * - `"broker http://omp.internal:8765"`
	 */
	sourceLabel?: string;
};

/**
 * Outcome of {@link AuthStorage.limits.markReached}.
 *
 * `switched` is `true` when an unblocked same-type sibling credential is
 * available right now, so the caller can retry immediately and the next
 * `getApiKey` will hand it out. When `false`, `retryAtMs` (epoch ms) carries
 * the earliest moment any same-type sibling's temporary block expires —
 * callers should prefer waiting until then over the provider's (often
 * multi-hour) retry-after when it is sooner. `retryAtMs` is `undefined` when
 * no sibling credentials exist at all, or when the session has no tracked
 * credential to rotate away from.
 *
 * `blockedUntilMs` (epoch ms) is the just-blocked credential's own unblock
 * deadline — the later of the caller's retry-after and any exhausted window
 * the usage report reveals. Callers that wait the account out (instead of
 * rotating) must sleep until this, not the error-text hint alone.
 *
 * `requestedBlockedUntilMs` (epoch ms) is this mark call's initial deadline,
 * before usage-report correction and longest-wins merging. Callers use it to
 * distinguish the call's replaceable heuristic from a longer merged block
 * that credential selection will continue enforcing.
 *
 * `priorBlockedUntilMs` (epoch ms) is the live block deadline the map already
 * stored for this credential before this call. The merged `blockedUntilMs`
 * masks a pre-existing block shorter than this call's own heuristic
 * fallback (`Math.max` in the mark), so callers that replace that heuristic
 * with an authoritative report window must consult the prior deadline to
 * keep honoring the earlier response's provider-stated block.
 *
 * `priorBlockedUntilTimed` is `true` when that prior deadline came from
 * provider-stated timing (a parsed hint or usage-report reset) rather than
 * another session's heuristic guess — only timed priors may extend a wait
 * past an authoritative report window. Persisted blocks carry no provenance
 * and count as untimed: a stale persisted heuristic must not outrank a
 * fresh complete report (longer persisted deadlines still win through the
 * merged `blockedUntilMs`).
 *
 * `reportResetAtMs` (epoch ms) is present only when the usage report is a
 * complete authority for the wait: every exhausted window carries a future
 * reset, so sleeping until the latest one can actually clear the account. A
 * permanent cap alongside a timed window (or no report at all) leaves it
 * unset, and the heuristic fallback alone must never authorize a wait.
 */
export interface UsageLimitMarkResult {
	switched: boolean;
	retryAtMs?: number;
	blockedUntilMs?: number;
	/** This mark call's initial deadline, before report correction and merging. */
	requestedBlockedUntilMs?: number;
	priorBlockedUntilMs?: number;
	priorBlockedUntilTimed?: boolean;
	reportResetAtMs?: number;
}

/** Combined model availability state across stored accounts. */
export type ModelUsageHealthState = "healthy" | "reserve" | "depleted" | "unknown";

/** Usage health of one stored credential for a model. */
export interface ModelUsageAccountHealth {
	credentialId: number;
	credentialType: AuthCredential["type"];
	/** True when this credential is currently sticky for options.sessionId. */
	selected?: true;
	state: ModelUsageHealthState;
	remainingFraction?: number;
	resetsAt?: number;
}

/** Aggregate model usage health and account detail. */
export interface ModelUsageHealth {
	state: ModelUsageHealthState;
	accounts: ModelUsageAccountHealth[];
}

/** Requested model, session, and reserve threshold for usage health. */
export interface ModelUsageHealthOptions {
	modelId?: string;
	sessionId?: string;
	baseUrl?: string;
	reserveFraction: number;
	signal?: AbortSignal;
}

/** Options controlling model, base URL, cancellation, and forced OAuth refresh in KeysApi.get. */
export type AuthApiKeyOptions = {
	baseUrl?: string;
	modelId?: string;
	/** Provider account ids known to serve `modelId` from multi-account discovery; OAuth selection prefers them and tries other accounts only as a last resort. */
	accountIds?: readonly string[];
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

/**
 * Refreshed OAuth access plus identity metadata returned by
 * {@link AuthStorage.oauth.access}. Callers that authenticate via a bearer
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
 * Identity slice of the credential a successful {@link AuthStorage.oauth.login}
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

/** Failure while resolving access to one OAuth account. */
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

/** Successful OAuth access or account-specific failure. */
export type OAuthAccessResolution = ({ ok: true } & OAuthAccess) | ({ ok: false } & OAuthAccessFailure);

/**
 * Read-only identity of one stored OAuth account, in stable storage order.
 * Returned by {@link AuthStorage.oauth.accounts}; `position` (0-based) is the
 * selector accepted by {@link AuthStorage.oauth.accessById}.
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
/** Scope a matching-key invalidation to a session or signal. */
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

/** A saved-reset option bound to one provider and durable stored credential. */
export interface ResetCreditTarget {
	provider: string;
	credentialId: number;
	/** Grant selected by the caller; a changed offer must be confirmed again. */
	creditId?: string;
	accountId?: string;
	email?: string;
	orgId?: string;
}

/** Outcome of {@link AuthStorage.resets.redeem}. */
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
	code: string;
	provider?: string;
	accountId?: string;
	email?: string;
	orgId?: string;
	/** Provider explanation for an unavailable or refused reset. */
	reason?: string;
	/** Normalized usage limit IDs the provider confirmed it cleared. */
	cleared?: string[];
	/** The credit that was spent (when one was). */
	creditId?: string;
}

/** One stored account's live saved-reset status, from {@link AuthStorage.resets.list}. */
export interface ResetCreditAccountStatus extends UsageResetCredits {
	provider: string;
	credentialId: number;
	accountId?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
	credits: UsageResetCredit[];
	/** Whether this is the given session's active account. */
	active: boolean;
	/** Set when the account's token refresh or list call failed. */
	error?: string;
}

/** Env-var leg handling for {@link KeysApi.source}. */
export interface AuthSourceOptions {
	/**
	 * `"dedicated"` (default): only the provider's own env var counts (xai-oauth: XAI_OAUTH_TOKEN only).
	 * `"aliases"`: also accept cross-provider aliases (`getEnvApiKey(provider)`, e.g. xai-oauth borrowing XAI_API_KEY).
	 * `"none"`: ignore env vars entirely.
	 */
	env?: "dedicated" | "aliases" | "none";
}

/** Where a provider's auth comes from ({@link CredentialOrigin}) plus whether any leg holds a concrete key. */
export interface AuthSource extends CredentialOrigin {
	/** False when the only auth is an ambient AUTHENTICATED_SENTINEL source (AWS profile, ADC). */
	concrete: boolean;
}

/** Completed request usage supplied to {@link UsageApi.observe}. */
export type ObservedUsageInput = {
	provider: Provider;
	model: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	costUsd?: number;
	at?: number;
	/** Attribution override; defaults to this process's install identity. */
	client?: ClientUsageIdentity;
};

/** Mark a session credential blocked with caller and provider timing. */
export type MarkUsageLimitOptions = {
	retryAfterMs?: number;
	/**
	 * Whether `retryAfterMs` came from provider-stated timing (a parsed
	 * retry hint) rather than a heuristic/default guess. A report reset
	 * extending the block counts as provider timing regardless.
	 */
	providerTimed?: boolean;
	baseUrl?: string;
	modelId?: string;
	apiKey?: string;
	credentialId?: number;
	signal?: AbortSignal;
};

/** Resolve a failed request to its credential and rotate if possible. */
export type RotateCredentialOptions = {
	error?: unknown;
	modelId?: string;
	apiKey?: string;
	credentialId?: number;
	signal?: AbortSignal;
};

/** Filter saved reset credits by provider and session. */
export type ListResetCreditsOptions = {
	provider?: string;
	sessionId?: string;
	baseUrlResolver?: (provider: string) => string | undefined;
	signal?: AbortSignal;
};

/** Select a saved reset credit and optional provider endpoint. */
export type RedeemResetCreditOptions = {
	target: ResetCreditTarget;
	baseUrlResolver?: (provider: string) => string | undefined;
	signal?: AbortSignal;
};

/** Controller accepted by {@link OAuthApi.login}; onAuth/onPrompt are required. */
export type OAuthLoginController = OAuthController & {
	/** onAuth is required by auth-storage but optional in OAuthController */
	onAuth: (info: OAuthAuthInfo) => void;
	/** onPrompt is required for some providers (github-copilot, openai-codex) */
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
};

/** Stored credential pool operations used by the AuthStorage facade. */
export interface CredentialsApi {
	/** Read the current credential snapshot generation. */
	readonly generation: number;
	/** Subscribe to credential snapshot generation changes. */
	onGeneration(listener: (generation: number) => void): () => void;
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
	onDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void;
	/**
	 * Reload credentials from storage.
	 */
	reload(): Promise<void>;
	/**
	 * Reload state after another process commits to the backing store, then
	 * notify snapshot consumers even when only credential blocks changed.
	 */
	poll(): Promise<boolean>;
	/**
	 * Force the backing store to revalidate its credential snapshot, then
	 * reload. Remote broker stores re-fetch the snapshot; local stores are
	 * always current, so only the reload runs. Callers that pair live
	 * per-credential data with stored identities (`omp usage`) use this so a
	 * disk-cached snapshot cannot misattribute fresh reports.
	 */
	revalidate(): Promise<void>;
	/**
	 * Get credential for a provider (first entry if multiple).
	 */
	get(provider: string): AuthCredential | undefined;
	/**
	 * Get all credentials.
	 */
	all(): AuthStorageData;
	/**
	 * List stored credential rows, optionally filtered by provider.
	 */
	list(provider?: string): StoredAuthCredential[];
	/**
	 * Check if credentials exist for a provider in storage.
	 */
	has(provider: string): boolean;
	/**
	 * Check if OAuth credentials are configured for a provider.
	 */
	hasOAuth(provider: string): boolean;
	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuth(provider: string): OAuthCredential | undefined;
	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredentialEntry): Promise<void>;
	/**
	 * Upsert a credential into the underlying store, refresh the in-memory
	 * snapshot, and return the redacted snapshot entries for the provider.
	 *
	 * Used by the auth-broker server to honour `POST /v1/credential`. The
	 * persistence layer (`SqliteAuthCredentialStore.upsertAuthCredential`)
	 * does identity-key matching, so re-uploading the same email/account replaces
	 * the existing row instead of inserting a duplicate. Resolves after
	 * persistence and the in-memory snapshot update.
	 */
	upsert(provider: string, credential: AuthCredential): Promise<AuthCredentialSnapshotEntry[]>;
	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): Promise<void>;
	/**
	 * Remove one stored credential for a provider.
	 */
	removeById(provider: string, credentialId: number): Promise<boolean>;
	/**
	 * Disable the credential with the given id and emit a
	 * {@link CredentialDisabledEvent}. Used by the auth-broker server to honour
	 * `POST /v1/credential/:id/disable`. Resolves after persistence; returns
	 * `false` when no active row with this ID exists.
	 */
	disable(id: number, disabledCause: string): Promise<boolean>;
	/**
	 * Disabled credential tombstones for display surfaces (`omp usage`,
	 * broker `GET /v1/credentials/disabled`). Empty when the backing store
	 * keeps no tombstones or the remote broker predates the endpoint.
	 */
	listDisabled(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]>;
	/**
	 * Build a redacted snapshot of all loaded credentials for the auth-broker
	 * wire. OAuth refresh tokens are replaced with {@link REMOTE_REFRESH_SENTINEL}
	 * so clients never see the actual refresh token.
	 *
	 * Callers must {@link AuthStorage.credentials.reload} first when serving a stale snapshot
	 * (the broker server's HTTP handler does this).
	 */
	snapshot(): AuthCredentialSnapshot;
}

/** Provider API-key resolution and runtime/configuration overrides. */
export interface KeysApi {
	/**
	 * Get API key for a provider.
	 * Priority (first match wins):
	 * 1. Runtime override (CLI --api-key)
	 * 2. Config override (models.yml `providers.<name>.apiKey`)
	 * 3. OAuth token from storage (auto-refreshed)
	 * 4. API key persisted by a successful `/login`
	 * 5. Environment variable
	 * 6. Stored API key (e.g. a broker-migrated copy) — last resort, so an explicit env var wins
	 */
	get(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined>;
	/** Resolve a bearer together with its durable stored credential row id, when known. */
	getWithCredential(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined>;
	/**
	 * Peek at API key for a provider without refreshing OAuth tokens.
	 * Used for model discovery where we only need to know if credentials exist
	 * and get a best-effort token. For GitHub Copilot we preserve enterprise
	 * routing metadata so discovery can hit the correct host.
	 */
	peek(provider: string): Promise<string | undefined>;
	/** Resolve the first active auth source by precedence without refreshing credentials. */
	source(provider: string, options?: AuthSourceOptions): AuthSource | undefined;
	/**
	 * True when the provider has stored credentials but none of them carries
	 * auth — i.e. its only credential is the KDL `empty-fallback` keyless-mode
	 * marker (an empty paste at an optional-key login prompt). Such a provider
	 * is configured-but-keyless: model availability treats it like an
	 * `auth: none` endpoint instead of locking it out (issue #12281).
	 */
	keyless(provider: string): boolean;
	/**
	 * Describe where the active credential for a provider came from.
	 *
	 * Mirrors {@link AuthStorage.keys.get} precedence, highest first:
	 *   1. Runtime override (`--api-key`).
	 *   2. Config override (`models.yml` `providers.<name>.apiKey`).
	 *   3. Stored OAuth credential.
	 *   4. API key persisted by a successful `/login`.
	 *   5. Env var — overrides a stored static api_key (e.g. a stale broker copy).
	 *   6. Stored api_key credential.
	 *
	 * The string is purely informational; consumers must not parse it.
	 */
	describe(provider: string, sessionId?: string): string | undefined;
	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntime(provider: string, apiKey: string): void;
	/**
	 * Remove a runtime API key override.
	 */
	removeRuntime(provider: string): void;
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
	setConfig(provider: string, apiKeyConfig: string): void;
	/**
	 * Remove a single config-sourced API key override.
	 */
	removeConfig(provider: string): void;
	/**
	 * Drop every config-sourced API key. Called by `ModelRegistry` before
	 * re-parsing `models.yml` so removed entries actually disappear.
	 */
	clearConfig(): void;
	/**
	 * Install the host's async config-value resolver. Coding-agent uses this so
	 * every stored/config credential reference shares command caching,
	 * failure backoff, and process hardening even when AuthStorage was created
	 * independently and later attached to a registry.
	 */
	setResolver(resolver: (config: string) => Promise<string | undefined>): void;
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
	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver;
}

/** OAuth login, access, account identity, and refresh operations. */
export interface OAuthApi {
	/**
	 * Login to an OAuth provider. Resolves with the stored credential's
	 * identity slice (or `undefined` when nothing was stored) so callers can
	 * surface which account — and for Anthropic, which organization — the
	 * login registered.
	 */
	login(provider: OAuthProviderId, ctrl: OAuthLoginController): Promise<OAuthLoginIdentity | undefined>;
	/**
	 * Resolve the OAuth credential for `provider`, refreshing through the same
	 * pipeline as {@link AuthStorage.keys.get} but returning the refreshed
	 * {@link OAuthAccess} (raw access token + identity metadata) instead of
	 * the API-key bytes.
	 *
	 * Use this when the caller needs to inject identity headers alongside the
	 * bearer (Codex `chatgpt-account-id`, Google `project`, GitHub
	 * `enterpriseUrl`). For pure "give me the bytes for `Authorization`"
	 * scenarios, prefer {@link AuthStorage.keys.get}.
	 *
	 * Returns `undefined` when no OAuth credential is available, the
	 * credential fails to refresh, or runtime/config overrides have replaced
	 * OAuth with an explicit API key.
	 */
	access(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<OAuthAccess | undefined>;
	/**
	 * Resolve every stored OAuth credential for `provider` independently.
	 *
	 * Refreshes credentials through the same broker/local path as
	 * {@link AuthStorage.oauth.access}, but does not rank, round-robin, or
	 * stop after the first usable account. Intended for diagnostics that must
	 * exercise each stored account exactly once.
	 */
	accessAll(provider: string, options?: AuthApiKeyOptions): Promise<OAuthAccessResolution[]>;
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
	accessById(
		provider: string,
		credentialId: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined>;
	/**
	 * Read-only list of stored OAuth accounts for `provider` in stable storage
	 * order, WITHOUT refreshing any token. The array position (0-based) is the
	 * selector accepted by {@link AuthStorage.oauth.accessById}; a "pick the Nth
	 * account" UI should render `position + 1`.
	 *
	 * When `sessionId` is supplied, the session-sticky OAuth credential is marked
	 * `active`. No account is active before that session has resolved or pinned a
	 * credential.
	 */
	accounts(provider: string, sessionId?: string): OAuthAccountSummary[];
	/**
	 * Get the OAuth account identity for a provider, preferring the credential that
	 * is session-sticky for `sessionId`. This is a read-only lookup for display and
	 * metadata paths; it does not refresh tokens, rank usage, or advance selection.
	 */
	identity(provider: string, sessionId?: string): OAuthAccountIdentity | undefined;
	/**
	 * Return the configured account policy matching an OAuth identity.
	 *
	 * This is a read-only diagnostics surface: it performs the same conjunctive
	 * selector match as routing and never refreshes, ranks, or mutates credentials.
	 */
	policy(provider: string, identity: OAuthAccountIdentity): AuthAccountPolicy | undefined;
	/**
	 * Refresh the OAuth credential with the given id through a per-credential
	 * single-flight. Concurrent callers for the same row await the same upstream
	 * refresh attempt, which is required for providers that rotate refresh tokens
	 * on every successful refresh.
	 */
	refresh(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry>;
	/**
	 * Refresh one stored OAuth credential under durable row ownership.
	 */
	refreshStored<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>>;
}

/** Session credential affinity operations. */
export interface SessionsApi {
	/**
	 * Pin one stored OAuth account as this session's preferred credential.
	 *
	 * The durable credential id keeps the pin stable across credential refreshes,
	 * storage reordering, and process restarts. By default this is an explicit
	 * user pin: ranking and account reserve never evict it; hard unavailability
	 * and auth retry may still route around it.
	 *
	 * `options.restoredAtMs` instead restores an automatic affinity recorded by a
	 * persisted session, backdated to its last use, so it keeps the provider's
	 * warm-window semantics: a resume inside the prompt-cache TTL reuses the
	 * account, a stale resume re-ranks.
	 */
	pin(provider: string, sessionId: string, credentialId: number, options?: { restoredAtMs?: number }): boolean;
	/**
	 * Copy every stored credential affinity from one live session to another.
	 *
	 * The target receives its own sticky entries, so request resolution, usage
	 * blocking, credential rotation, metadata, and persisted pins all continue
	 * through the target session id without retaining a live dependency on the
	 * source session.
	 */
	inherit(sourceSessionId: string, targetSessionId: string): number;
	/**
	 * Release a session's sticky credential so its next {@link getApiKey} call
	 * re-runs native pool ranking. This never blocks or penalizes the released
	 * account; usage-aware routing uses it when another sibling has more
	 * headroom, before considering a model/provider fallback.
	 */
	release(provider: string, sessionId: string): boolean;
}

/** Usage reporting, observation, and provider configuration. */
export interface UsageApi {
	/** Fetch aggregate usage reports for configured providers. */
	reports(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
		signal?: AbortSignal;
	}): Promise<UsageReport[] | null>;
	/** Ingest provider usage limits from response headers. */
	ingestHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string; responseStatus?: number },
	): boolean;
	/**
	 * Discard cached usage reports before a user-requested refresh. The next
	 * read probes upstream serially per provider; a failure reports no fresh
	 * usage instead of replaying an invalidated last-good snapshot.
	 */
	invalidate(provider?: string, signal?: AbortSignal): Promise<void>;
	/**
	 * Recorded usage-limit snapshots, oldest first. Empty when the underlying
	 * store has no durable history (e.g. a broker-backed remote store).
	 */
	history(query?: UsageHistoryQuery): UsageHistoryEntry[];
	/**
	 * Forward one completed request's usage to the store's observer hook.
	 * Broker-backed stores batch these into per-install reports so the broker
	 * can track actual token burn per client; local stores have no hook and
	 * the call is a no-op.
	 */
	observe(entry: ObservedUsageInput): void;
	/** Record one client’s observed usage report. */
	recordClient(report: ClientUsageReport): boolean;
	/** Aggregate client-observed usage since a timestamp. */
	clientSummary(sinceMs: number): ClientUsageSummary;
	/**
	 * The {@link UsageProvider} registered for `provider`, or undefined when the
	 * provider has no usage endpoint at all. Lets callers tell "a credential we
	 * could have fetched usage for but didn't" apart from "a provider with no
	 * usage concept" (web-search keys, local/keyless servers, inference
	 * providers without a usage API) — the latter never warrants a usage row.
	 */
	providerFor(provider: Provider): UsageProvider | undefined;
	/**
	 * Return model ids whose live reports map to a quantitative usage scope.
	 * Provider strategies supply model/tier mapping when available; otherwise
	 * only explicitly matching model ids and account-wide shared limits count.
	 * Label-only or ambiguous tier limits are excluded rather than guessed.
	 */
	reportingModelIds(provider: Provider, modelIds: readonly string[], reports: readonly UsageReport[]): string[];
	/**
	 * Install a runtime usage provider override (not persisted to disk).
	 *
	 * Runtime overrides are checked before the configured resolver, including its
	 * built-in fallback. Removing the override restores that resolver unchanged.
	 */
	setProvider(provider: Provider, usageProvider: UsageProvider, apiKey?: string): void;
	/** Remove a runtime usage provider override and restore configured/default resolution. */
	removeProvider(provider: Provider): void;
}

/** Credential and model-level health probes. */
export interface HealthApi {
	/**
	 * Inspect the credential pool that {@link getApiKey} would use for one model
	 * without advancing round-robin state or changing session stickiness.
	 *
	 * Pool aggregation is deliberately conservative: one healthy sibling makes
	 * the model healthy, while any unknown sibling prevents a depleted/reserve
	 * conclusion. Static runtime/config/env credentials return unknown because
	 * they bypass the managed account pool.
	 */
	model(provider: Provider, options: ModelUsageHealthOptions): Promise<ModelUsageHealth>;
	/**
	 * Probe each stored credential against its provider's auth-verifying usage
	 * endpoint and report per-credential auth health.
	 *
	 * Surfaces the identity of failing credentials so callers running a
	 * multi-account pool (e.g. a broker-backed auth-gateway) can tell which
	 * row is producing 401s. The probe mirrors the per-credential fan-out
	 * inside {@link AuthStorage.usage.reports} (OAuth refresh-on-expiry,
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
	check(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]>;
}

/** Usage-limit blocking and credential rotation operations. */
export interface LimitsApi {
	/**
	 * Marks the current session's credential as temporarily blocked due to usage limits.
	 * Uses usage reports to determine accurate reset time when available.
	 * Returns whether a sibling credential is available now; when none is, also
	 * reports the earliest time a blocked sibling becomes available again so
	 * callers can wait for the sibling instead of the provider's full window.
	 */
	markReached(
		provider: string,
		sessionId: string | undefined,
		options?: MarkUsageLimitOptions,
	): Promise<UsageLimitMarkResult>;
	/**
	 * Rotate away from the credential that failed after a retryable auth error —
	 * step (c) of the auth-retry policy. Prefer the failed stored row id supplied
	 * in `options.credentialId`, then the failed bearer supplied in
	 * `options.apiKey`, so overlapping requests cannot redirect rotation through
	 * stale session stickiness. Fall back to the session-sticky credential only
	 * when neither explicit target is available. For hard-auth errors, an explicit
	 * target that no longer matches storage returns `false` without mutation.
	 * Delayed usage-limit and account-policy errors may instead recover the durable
	 * OAuth row from the bearer fingerprint recorded when the request resolved.
	 *
	 * - usage-limit / account-rate-limit error → {@link AuthStorage.limits.markReached}
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
	rotate(provider: string, sessionId: string | undefined, options?: RotateCredentialOptions): Promise<boolean>;
	/** Invalidate a credential matching an API key after authentication failure. */
	invalidateMatching(
		provider: string,
		apiKey: string,
		options?: InvalidateCredentialMatchingOptions,
	): Promise<boolean>;
}

/** Saved reset-credit listing and redemption. */
export interface ResetsApi {
	/** List live saved-reset balances and eligibility for stored OAuth accounts. */
	list(options?: ListResetCreditsOptions): Promise<ResetCreditAccountStatus[]>;
	/**
	 * Redeem a stored account's saved reset after checking its live offer.
	 * Business refusals return a code; transport errors may throw without losing Claude's request ID.
	 */
	redeem(options: RedeemResetCreditOptions): Promise<ResetCreditRedeemOutcome>;
}

/** Persisted credential rate-limit block operations. */
export interface BlocksApi {
	/**
	 * Broker-server seam: list non-expired persisted blocks for snapshot entries.
	 */
	list(credentialIds: readonly number[]): StoredCredentialBlock[];
	/**
	 * Broker-server seam: persist one credential block and notify snapshot waiters.
	 */
	upsert(block: StoredCredentialBlock): void;
	/**
	 * Broker-server seam: clear all persisted blocks for one credential and notify snapshot waiters.
	 */
	delete(credentialId: number, providerKey: string, blockScope: string): void;
	/** Delete all persisted blocks for a credential. */
	deleteAll(credentialId: number): void;
}
