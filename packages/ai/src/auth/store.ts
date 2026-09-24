import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type {
	ClientUsageIdentity,
	ClientUsageReport,
	ClientUsageSummary,
	ObservedUsageEntry,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageReport,
} from "../usage";
import type {
	AuthCredential,
	ConditionalAuthCredentialInsertResult,
	DisabledCredentialSummary,
	OAuthCredential,
	StoredAuthCredential,
	StoredCredentialBlock,
} from "./types";

/** Owner and timestamp that fence a durable credential refresh lease. */
export interface CredentialRefreshLeaseFence {
	owner: string;
	nowMs: number;
}

/** Persisted credential rows and their transactional writes. */
export interface CredentialRowStore {
	close(): void;
	/**
	 * Stateful probe for commits made by another process to the backing store.
	 * Returns true once per observed change.
	 */
	pollExternalChanges?(): boolean;
	/** Record the current auth revision after a local mutation already notified consumers. */
	acknowledgeLocalChanges?(): void;
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
	/**
	 * Disable one active row; return false if it was already absent or disabled.
	 * Remote stores await broker persistence before updating their snapshot.
	 */
	deleteAuthCredential(id: number, disabledCause: string): Promise<boolean>;
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
	/**
	 * Replace all active rows for a provider (e.g. API-key login replacing an
	 * older key). Remote stores forward the writes to the broker rather than
	 * mutating broker state locally. Update the local snapshot before returning.
	 */
	replaceAuthCredentials(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]>;
	/**
	 * Upsert a credential through the authoritative writer and return the
	 * provider's active rows. Remote stores send `POST /v1/credential` to the
	 * broker. Implementations MUST update their local snapshot before returning
	 * so subsequent reads see the persisted result.
	 */
	upsertAuthCredential(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]>;
	/** Atomically insert only if no active credential exists; remote stores forward this condition to the broker. */
	insertAuthCredentialIfProviderAbsent?(
		provider: string,
		credential: AuthCredential,
		signal?: AbortSignal,
	): Promise<ConditionalAuthCredentialInsertResult>;
	/** Disable all active rows for a provider (logout), forwarding remote writes to the broker before returning. */
	deleteAuthCredentials(provider: string, disabledCause: string): Promise<void>;
}

/** Persistent key/value cache shared by credential services. */
export interface CredentialCacheStore {
	getCache(key: string, options?: { includeExpired?: boolean }): string | null;
	setCache(key: string, value: string, expiresAtSec: number): void;
	/** Drop all cache rows whose keys start with the supplied prefix. */
	deleteCachePrefix?(prefix: string): void;
	cleanExpiredCache(): void;
}

/** Durable rate-limit blocks, present together when supported by the store. */
export interface CredentialBlockStore {
	/** Non-expired block for one (credential, providerKey, scope) key, or undefined. */
	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	/** Earliest time a shared-store block should be eligible for live-usage reconciliation. */
	getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	/** Upsert with MAX semantics: keep the later blockedUntilMs on conflict. */
	upsertCredentialBlock(block: StoredCredentialBlock): void;
	/** Drop one block row for a credential/provider/scope key. */
	deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void;
	/** Drop every block row for a credential (all providerKeys/scopes). */
	deleteCredentialBlocks(credentialId: number): void;
	/** Prune rows with blocked_until_ms <= nowMs. */
	cleanExpiredCredentialBlocks(nowMs: number): void;
	/** List non-expired blocks for broker snapshots. */
	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[];
}

/** Durable fencing for a single OAuth refresh owner. */
export interface CredentialRefreshLeaseStore {
	tryAcquireCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean;
	getCredentialRefreshLeaseExpiresAt(credentialId: number): number | undefined;
	releaseCredentialRefreshLease(credentialId: number, owner: string): void;
	renewCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean;
}

/** Usage history and client-observed request accounting. */
export interface UsageLedgerStore {
	/**
	 * Append usage-limit snapshots for trend history. Optional: stores without
	 * durable storage (e.g. the broker remote store) omit it and recording is
	 * skipped — the broker host records into its own database instead.
	 */
	recordUsageSnapshots(entries: UsageHistoryEntry[]): void;
	/** Read recorded usage-limit snapshots, oldest first. */
	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[];
	/**
	 * Client hook: forward locally observed request usage. Remote broker stores
	 * batch these to the broker so it can attribute token burn per install;
	 * local stores omit it and observation is skipped.
	 * `client` overrides the reporting identity (gateway requests attribute to
	 * the originating client, not the gateway host).
	 */
	recordObservedUsage(entries: ObservedUsageEntry[], client?: ClientUsageIdentity): void;
	/** Broker host: persist one client's observed-usage report. */
	recordClientUsage(report: ClientUsageReport): void;
	/** Broker host: aggregate recorded per-client usage since a timestamp. */
	getClientUsageSummary(sinceMs: number): ClientUsageSummary;
}

/** Broker-delegated OAuth refresh and usage-report operations. */
export interface CredentialUpstream {
	/** Optional hook to notify the underlying store that usage report cache is stale. */
	invalidateUsageCache(signal?: AbortSignal): Promise<void>;
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
	refreshOAuthCredential(
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
	prepareForRequest(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean | undefined>;
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
	fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null>;
	/**
	 * Optional store-supplied per-credential usage report lookup. When present,
	 * `AuthStorage` consults this before its own per-credential upstream fetch
	 * (`UsageService.report`). `RemoteAuthCredentialStore` implements this against
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
	getUsageReport(provider: Provider, credential: OAuthCredential, signal?: AbortSignal): Promise<UsageReport | null>;
	/**
	 * Optional store hook to ingest a parsed provider usage report for one OAuth
	 * credential. Remote broker stores use this to overlay header-derived limits
	 * onto their cached aggregate `/v1/usage` response without mutating broker
	 * state.
	 */
	ingestUsageReport(provider: Provider, credential: OAuthCredential, report: UsageReport): boolean;
	/**
	 * Optional store hook to invalidate a specific credential after the upstream
	 * provider returned 401 on a supposedly-fresh key. Remote stores force the
	 * broker to re-issue the row; local stores can leave it undefined and let
	 * {@link AuthStorage.limits.invalidateMatching} fall back to `reload()`.
	 */
	markCredentialSuspect(credentialId: number, opts?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * Persistence abstraction consumed by {@link AuthStorage}. Core credential rows
 * and cache are always available; each other concern is supported independently.
 * Concrete implementations are {@link SqliteAuthCredentialStore} and the broker's
 * `RemoteAuthCredentialStore`.
 */
export interface AuthCredentialStore
	extends
		CredentialRowStore,
		CredentialCacheStore,
		Partial<CredentialBlockStore>,
		Partial<CredentialRefreshLeaseStore>,
		Partial<UsageLedgerStore>,
		Partial<CredentialUpstream> {}

/** Narrow stores that implement the complete durable refresh-lease concern. */
export function hasRefreshLeases(
	store: AuthCredentialStore,
): store is AuthCredentialStore & CredentialRefreshLeaseStore {
	return (
		typeof store.tryAcquireCredentialRefreshLease === "function" &&
		typeof store.getCredentialRefreshLeaseExpiresAt === "function" &&
		typeof store.releaseCredentialRefreshLease === "function" &&
		typeof store.renewCredentialRefreshLease === "function"
	);
}
