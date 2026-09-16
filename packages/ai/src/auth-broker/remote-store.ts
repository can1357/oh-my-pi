/**
 * Client-side {@link AuthCredentialStore} that mirrors a remote broker's
 * snapshot. Refresh tokens never leave the broker; mutating methods (`replace*`,
 * `upsert*`, `delete*ForProvider`) throw because login flows are server-side.
 *
 * Cache (`getCache`/`setCache`/`cleanExpiredCache`) is in-memory and ephemeral —
 * usage reports cache TTL is 5 minutes per credential, so durability across
 * runs isn't required.
 */
import * as os from "node:os";
import { getAppName, getInstallId, logger } from "@oh-my-pi/pi-utils";
import {
	copyOAuthCredentialIdentity,
	isAutomaticDisableCause,
	isOAuthCredentialIdentityRecovered,
	isDeliberateRemovalCause,
	normalizeDisabledCause,
	resolveOAuthCredentialIdentity,
} from "../auth/sqlite-credential-store";
import {
	providerIdForDisplay,
	type AuthCredential,
	authCredentialEquals,
	type AuthCredentialSnapshotEntry,
	type AuthCredentialStore,
	type CredentialAccountIdentity,
	type CredentialDisabledEvent,
	type DisabledCredentialSummary,
	isActionableCredentialDisable,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type StoredAuthCredential,
	type StoredCredentialBlock,
} from "../auth-storage";
import * as AIError from "../error";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type { ClientUsageIdentity, ObservedUsageEntry, UsageReport } from "../usage";
import { type AuthBrokerClient, AuthBrokerError, AuthBrokerStreamUnsupportedError } from "./client";
import type {
	CredentialBlockSnapshot,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEvent,
} from "./types";

/**
 * Per-provider OAuth identities visible to this trusted broker client.
 * Missing providers are unrestricted; an empty set excludes that provider's
 * OAuth credentials. API keys are never filtered.
 */
export type AuthBrokerAccountPool = ReadonlyMap<string, ReadonlySet<string>>;

function isCredentialInAccountPool(
	entry: Pick<SnapshotEntry, "provider" | "identityKey"> & { credential: Pick<SnapshotEntry["credential"], "type"> },
	accountPool: AuthBrokerAccountPool | undefined,
): boolean {
	if (entry.credential.type !== "oauth") return true;
	const identities = accountPool?.get(entry.provider);
	if (identities === undefined) return true;
	return entry.identityKey !== null && identities.has(entry.identityKey);
}

/**
 * Client-side TTL for the aggregate `/v1/usage` response. The broker dedups
 * upstream `/usage` hits via AuthStorage's 5-minute per-credential cache plus
 * single-flight, so this short client TTL mainly folds the parallel fan-out
 * from `#rankOAuthSelections` into a single round-trip — a ranking pass issues
 * one broker call instead of N.
 */
/**
 * Passes the legacy whole-provider logout makes over a broker without the
 * dedicated route. Each pass re-reads before enumerating; the cap stops a peer
 * that re-logs in faster than rows are retired from spinning the loop.
 */
/**
 * How long a locally disabled row stays filtered out of incoming snapshots.
 * Covers a snapshot request already in flight when the disable landed; past
 * that the broker's own view wins, so a reused id is never suppressed for good.
 */
const LOCAL_DISABLE_GUARD_TTL_MS = 60_000;

const LEGACY_LOGOUT_MAX_PASSES = 3;

const USAGE_CACHE_TTL_MS = 15_000;
const CREDENTIAL_BLOCK_RECONCILE_DELAY_MS = 5 * 60_000;
const WAIT_THRESHOLD_MS = 1_000;
const MAX_WAIT_MS = 5_000;
const BACKGROUND_WAIT_MS = 30_000;
const BACKGROUND_BACKOFF_INITIAL_MS = 500;
const BACKGROUND_BACKOFF_MAX_MS = 30_000;
/** Idle window after the last foreground store use before background sync parks. */
const BACKGROUND_IDLE_MS = 20_000;
/**
 * How many departed credential ids stay eligible for an idempotent logout. A
 * retry that has fallen this far behind the snapshot is no longer the request
 * the caller is holding open.
 */
const VANISHED_CREDENTIAL_MEMORY = 128;

function compareCredentialBlockSnapshots(a: CredentialBlockSnapshot, b: CredentialBlockSnapshot): number {
	const provider = a.providerKey.localeCompare(b.providerKey);
	if (provider !== 0) return provider;
	const scope = a.blockScope.localeCompare(b.blockScope);
	if (scope !== 0) return scope;
	const blockedUntil = a.blockedUntilMs - b.blockedUntilMs;
	if (blockedUntil !== 0) return blockedUntil;
	return (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0);
}

function toCredentialBlockSnapshot(block: StoredCredentialBlock): CredentialBlockSnapshot {
	return {
		providerKey: block.providerKey,
		blockScope: block.blockScope,
		blockedUntilMs: block.blockedUntilMs,
		...(block.updatedAtMs !== undefined ? { updatedAtMs: block.updatedAtMs } : {}),
	};
}

function credentialBlockSnapshotsEqual(
	left: readonly CredentialBlockSnapshot[] | undefined,
	right: readonly CredentialBlockSnapshot[] | undefined,
): boolean {
	const leftBlocks = left ?? [];
	const rightBlocks = right ?? [];
	if (leftBlocks.length !== rightBlocks.length) return false;
	for (let index = 0; index < leftBlocks.length; index += 1) {
		const leftBlock = leftBlocks[index]!;
		const rightBlock = rightBlocks[index]!;
		if (
			leftBlock.providerKey !== rightBlock.providerKey ||
			leftBlock.blockScope !== rightBlock.blockScope ||
			leftBlock.blockedUntilMs !== rightBlock.blockedUntilMs ||
			leftBlock.updatedAtMs !== rightBlock.updatedAtMs
		) {
			return false;
		}
	}
	return true;
}

function snapshotBlocksChanged(previous: readonly SnapshotEntry[], next: readonly SnapshotEntry[]): boolean {
	const previousBlocksById = new Map<number, readonly CredentialBlockSnapshot[] | undefined>();
	for (const entry of previous) previousBlocksById.set(entry.id, entry.blocks);
	for (const entry of next) {
		const previousBlocks = previousBlocksById.get(entry.id);
		if (!credentialBlockSnapshotsEqual(previousBlocks, entry.blocks)) return true;
		previousBlocksById.delete(entry.id);
	}
	for (const previousBlocks of previousBlocksById.values()) {
		if (previousBlocks && previousBlocks.length > 0) return true;
	}
	return false;
}

function credentialEntryWithBlocks(
	entry: AuthCredentialSnapshotEntry,
	blocks: readonly CredentialBlockSnapshot[] | undefined,
): SnapshotEntry {
	const incoming: SnapshotEntry = { ...entry, rotatesInMs: null };
	if (blocks && blocks.length > 0) incoming.blocks = [...blocks].sort(compareCredentialBlockSnapshots);
	return incoming;
}

function emptySnapshot(): SnapshotResponse {
	return {
		generation: 0,
		generatedAt: 0,
		serverNowMs: 0,
		refresher: {
			enabled: false,
			intervalMs: 0,
			skewMs: 0,
			nextSweepInMs: Number.MAX_SAFE_INTEGER,
		},
		credentials: [],
	};
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface UsageCacheEntry {
	/**
	 * `null` means the last aggregate `/v1/usage` fetch failed. Callers treat
	 * this the same as a successful empty-report response ("no usage signal
	 * for this cycle"), and the same 15s TTL applies so transient broker
	 * outages don't turn every ranking pass into a broker retry storm.
	 */
	reports: UsageReport[] | null;
	fetchedAt: number;
}

function usageOverlayKey(
	provider: Provider,
	ids: { accountId?: string; email?: string; projectId?: string; orgId?: string },
): string | undefined {
	// Org first: one account email can hold several organizations (Anthropic
	// Team seat + personal Max), each with its own limit pools. Keying the
	// overlay by account/email would merge the two pools' header ingests.
	// But the org alone is not enough either: two Team members share the org
	// id while drawing on per-user pools, so the key stays qualified by the
	// member's own base identity whenever one is known.
	let base: string | undefined;
	const accountId = ids.accountId?.trim().toLowerCase();
	const email = ids.email?.trim().toLowerCase();
	const projectId = ids.projectId?.trim().toLowerCase();
	if (accountId) base = `account:${accountId}`;
	else if (email) base = `email:${email}`;
	else if (projectId) base = `project:${projectId}`;
	const orgId = ids.orgId?.trim().toLowerCase();
	if (orgId) return base ? `${provider}\0org:${orgId}|${base}` : `${provider}\0org:${orgId}`;
	if (base) return `${provider}\0${base}`;
	return undefined;
}

function mergeUsageReports(base: UsageReport, overlay: UsageReport): UsageReport {
	const overlayLimitsById = new Map(overlay.limits.map(limit => [limit.id, limit]));
	const limits = [];
	for (const limit of base.limits) {
		const replacement = overlayLimitsById.get(limit.id);
		if (replacement) {
			limits.push(replacement);
			overlayLimitsById.delete(limit.id);
		} else {
			limits.push(limit);
		}
	}
	for (const limit of overlayLimitsById.values()) limits.push(limit);
	const overlayMetadata = (overlay.metadata ?? {}) as Record<string, unknown>;
	return {
		...base,
		fetchedAt: Math.max(base.fetchedAt, overlay.fetchedAt),
		limits,
		metadata: {
			...overlayMetadata,
			...base.metadata,
			...(overlayMetadata.headersUpdatedAt !== undefined
				? { headersUpdatedAt: overlayMetadata.headersUpdatedAt }
				: {}),
		},
	};
}

export interface RemoteAuthCredentialStoreOptions {
	client: AuthBrokerClient;
	/**
	 * Initial snapshot. When omitted, callers must call
	 * {@link RemoteAuthCredentialStore.refreshSnapshot} before the first read.
	 */
	initialSnapshot?: SnapshotResponse;
	/**
	 * Subscribe to the broker's SSE snapshot stream when available. Falls back
	 * to long-poll permanently when the broker returns 404. Default `true`.
	 */
	streamSnapshots?: boolean;
	/**
	 * Called with each broker-sourced raw full snapshot after the filtered
	 * public view is applied. The constructor's initial snapshot intentionally
	 * does not trigger this hook.
	 */
	onSnapshot?: (snapshot: SnapshotResponse, generation: number) => void;
	/**
	 * OAuth identities visible through this store. This is a trusted-client
	 * routing policy, not broker authorization.
	 */
	accountPool?: AuthBrokerAccountPool;
	/** Flush cadence for batched observed-usage reports. Default 10s. */
	observedUsageFlushMs?: number;
	/**
	 * Idle window after the last foreground store use before background
	 * snapshot sync (SSE stream / long-poll) disconnects and parks. A parked
	 * store holds no timers or sockets, so an unclosed store never keeps the
	 * process alive longer than one idle window. Sync resumes transparently on
	 * the next use. Default 20s.
	 */
	backgroundIdleMs?: number;
}

interface PendingCredentialRemoval extends CredentialAccountIdentity {
	id: number;
	retryAfterMs: number;
	backoffMs: number;
	inFlight: boolean;
	/**
	 * API-key rows of this provider that were already live when the removal was
	 * observed. An API key carries no identity, so only a row absent from this
	 * set proves a replacement rather than an untouched sibling.
	 */
	siblingApiKeyIds?: ReadonlySet<number>;
}

export class RemoteAuthCredentialStore implements AuthCredentialStore {
	readonly #client: AuthBrokerClient;
	readonly #streamSnapshots: boolean;
	readonly #onSnapshot?: (snapshot: SnapshotResponse, generation: number) => void;
	readonly #accountPool?: AuthBrokerAccountPool;
	#snapshot: SnapshotResponse = emptySnapshot();
	#snapshotReceivedAt = Date.now();
	#generation = 0;
	/**
	 * Content fingerprint of the credential set in {@link #snapshot} (id +
	 * provider + credential material), recomputed after every snapshot mutation.
	 * Drives {@link #credentialRevision} independently of the broker's numeric
	 * generation, which is an in-memory counter that resets when the broker
	 * process restarts and so cannot be trusted for change detection.
	 */
	#credentialFingerprint = "";
	/** Monotonic local counter bumped whenever {@link #credentialFingerprint} changes. */
	#credentialRevision = 0;
	/** Revision last reported as "seen" by {@link pollExternalChanges}; seeded from the initial snapshot. */
	#acknowledgedRevision = 0;
	#usageOverlays: Map<string, UsageReport> = new Map();
	#backgroundAbort = new AbortController();
	readonly #backgroundIdleMs: number;
	/** Last foreground store use; background sync parks `#backgroundIdleMs` after this. */
	#lastActivityMs = Date.now();
	/** Present while the background loop is parked; resolved by `#noteActivity` or `close()`. */
	#activityWakeup: PromiseWithResolvers<void> | null = null;
	#cache: Map<string, CacheEntry> = new Map();
	#usageCache?: UsageCacheEntry;
	#usageInflight?: Promise<UsageReport[] | null>;
	#credentialBlockReconcileAfter: Map<string, number> = new Map();
	#usageCacheEpoch = 0;
	/** Raw broker credentials retained to size aggregate usage requests before account-pool filtering. */
	#brokerUsageProviderByCredentialId = new Map<number, Provider>();
	#brokerUsageAccountCounts = new Map<Provider, number>();
	/** Per-snapshot lookup of oauth credentials by provider; rebuilt when `#snapshot` is replaced. */
	#usageFilterLookup?: { snapshot: SnapshotResponse; byProvider: Map<Provider, OAuthCredential[]> };
	/** Memoized `#filterUsageReports` output, keyed on (input identity, lookup identity). */
	#usageFilterResult?: { input: UsageReport[]; byProvider: Map<Provider, OAuthCredential[]>; output: UsageReport[] };
	#closed = false;
	#credentialDisabledListeners = new Set<(event: CredentialDisabledEvent) => void | Promise<void>>();
	/** Token-free removal work; a single unref'd timer also covers quiet live streams. */
	#pendingCredentialRemovals = new Map<number, PendingCredentialRemoval>();
	#credentialRemovalRetryTimer: Timer | undefined;
	#credentialRemovalRetryAtMs = Infinity;
	/**
	 * Credential ids this client held in its own snapshot and then lost. A
	 * deliberate removal of one of these is already complete, so it reports
	 * success instead of a skipped logout; an id this client never held stays
	 * refused, so an account pool cannot be used to reach outside itself.
	 */
	#vanishedCredentialIds = new Set<number>();
	/** AuthStorage already announces successful disables initiated by this client. */
	#localDisables = new Map<
		number,
		{ pending: number; succeeded: boolean; promise: Promise<void>; resolve: () => void }
	>();
	/**
	 * `true` once the SSE consumer received its first frame and hasn't dropped
	 * since. Writes consult this to suppress the otherwise-mandatory
	 * `refreshSnapshot()` follow-up — the stream will deliver the new
	 * generation without an extra GET.
	 */
	#streamingActive = false;
	/** Latched once the broker has answered 404 — never try the stream again. */
	#streamingUnsupported = false;
	/** Pending observed usage keyed by `installId\u0000app\u0000provider\u0000model`, merged until flush. */
	#observedUsage = new Map<string, { client: ClientUsageIdentity; entry: ObservedUsageEntry }>();
	#observedUsageTimer: Timer | undefined;
	readonly #observedUsageFlushMs: number;
	/** Latched once the broker answered 404 — old broker, never report again. */
	#observedUsageUnsupported = false;

	constructor(opts: RemoteAuthCredentialStoreOptions) {
		this.#client = opts.client;
		this.#streamSnapshots = opts.streamSnapshots ?? true;
		this.#observedUsageFlushMs = opts.observedUsageFlushMs ?? 10_000;
		this.#backgroundIdleMs = opts.backgroundIdleMs ?? BACKGROUND_IDLE_MS;
		this.#accountPool = opts.accountPool
			? new Map([...opts.accountPool].map(([provider, identities]) => [provider, new Set(identities)]))
			: undefined;
		this.#applySnapshot(opts.initialSnapshot ?? emptySnapshot(), opts.initialSnapshot?.generation ?? 0);
		this.#acknowledgedRevision = this.#credentialRevision;
		this.#onSnapshot = opts.onSnapshot;
		void this.#runBackground();
	}

	get client(): AuthBrokerClient {
		return this.#client;
	}

	get snapshot(): SnapshotResponse {
		this.#noteActivity();
		return this.#snapshot;
	}

	#applySnapshot(snapshot: SnapshotResponse, generation: number, resetFromGeneration?: number): void {
		// Broker generations restart with the process. A pull or stream bootstrap
		// may resync backwards only if nothing advanced while it was in flight.
		// A generation that ran backwards is the broker's restart signature; a
		// polling client sees the new incarnation only here.
		if (generation < this.#generation) this.#client.resetDisabledHistoryProbe();
		if (generation < this.#generation && resetFromGeneration !== this.#generation) {
			logger.debug("auth-broker snapshot older than local; ignoring", {
				local: this.#generation,
				incoming: generation,
			});
			return;
		}
		// Additions are keyed by the generation that streamed them, and broker
		// generations restart with the process. A snapshot that does not advance the
		// local generation is a restart or a resync, so entries recorded under the
		// previous incarnation collide with this one's numbers — drop them before the
		// removal diff below reads them, not after.
		if (generation <= this.#generation) this.#streamAdditions.clear();
		const nowMs = Date.now();
		// Release the guard only when an authoritative snapshot actually omits the
		// row. A numerically newer generation proves nothing on its own: an
		// unrelated broker mutation can advance it without having observed this
		// client's disable, and dropping the guard then lets a pre-disable
		// snapshot restore the dead bearer.
		const snapshotIds = new Set(snapshot.credentials.map(entry => entry.id));
		for (const disabledId of this.#locallyDisabledAt.keys()) {
			if (!snapshotIds.has(disabledId)) this.#locallyDisabledAt.delete(disabledId);
		}
		this.#replaceBrokerUsageAccounts(snapshot.credentials);
		const previousCredentials = this.#snapshot.credentials;
		const credentials = snapshot.credentials
			.filter(entry => !this.#isLocallyDisabled(entry.id))
			.filter(entry => isCredentialInAccountPool(entry, this.#accountPool))
			.map(entry => this.#normalizeSnapshotEntryBlocks(entry, nowMs));
		if (snapshotBlocksChanged(previousCredentials, credentials)) this.#invalidateUsageCache();
		this.#protectNewSnapshotBlocks(previousCredentials, credentials, nowMs);
		this.#snapshot = { ...snapshot, credentials };
		this.#generation = generation;
		this.#snapshotReceivedAt = nowMs;
		this.#refreshCredentialRevision();
		if (previousCredentials.length > 0) {
			const activeIds = new Set(snapshot.credentials.map(entry => entry.id));
			const announcing = this.#credentialDisabledListeners.size > 0;
			for (const entry of previousCredentials) {
				if (activeIds.has(entry.id)) continue;
				this.#noteCredentialVanished(entry.id);
				if (announcing)
					this.#notifyCredentialRemoved(entry, this.#siblingApiKeyIds(entry, previousCredentials, generation));
			}
		}
		// A full snapshot re-bases everything; per-generation additions no longer apply.
		this.#streamAdditions.clear();
		this.#retryCredentialRemovalNotifications();
		const onSnapshot = this.#onSnapshot;
		if (!onSnapshot) return;
		try {
			// This snapshot is persisted to the on-disk broker cache, so a row this
			// client just disabled must not travel with it: a restart before the
			// removal generation arrives would otherwise accept the cached row and
			// issue a request with the dead bearer. Account-pool filtering stays
			// out of it — hidden rows still belong in the cache.
			onSnapshot(this.#withoutLocallyDisabled(snapshot), generation);
		} catch (error) {
			logger.debug("auth-broker snapshot callback failed", { error: String(error) });
		}
	}

	/**
	 * A row this client just disabled must not travel into the on-disk cache: a
	 * restart before the removal generation arrives would accept the cached row
	 * and issue a request with the dead bearer. Account-pool filtering stays out
	 * of it — hidden rows still belong in the cache.
	 */
	#withoutLocallyDisabled<T extends { credentials: readonly SnapshotEntry[] }>(snapshot: T): T {
		if (this.#locallyDisabledAt.size === 0) return snapshot;
		return { ...snapshot, credentials: snapshot.credentials.filter(entry => !this.#isLocallyDisabled(entry.id)) };
	}

	/**
	 * Write the current snapshot to the cache after a local mutation that will
	 * not be followed by a refresh. An active stream suppresses that refresh, so
	 * without this the cache keeps the disabled bearer until the broker's own
	 * frame lands — a window a crash turns into a dead credential on restart.
	 */
	#persistCurrentSnapshot(): void {
		const onSnapshot = this.#onSnapshot;
		if (!onSnapshot) return;
		try {
			onSnapshot(this.#withoutLocallyDisabled(this.#snapshot), this.#generation);
		} catch (error) {
			logger.debug("auth-broker snapshot callback failed", { error: String(error) });
		}
	}

	/**
	 * Recompute the credential-content fingerprint and bump
	 * {@link #credentialRevision} when it changes. Called after every snapshot
	 * mutation so {@link pollExternalChanges} detects add/remove/replace even
	 * when the broker's numeric generation repeats (e.g. after a broker
	 * restart resets its in-memory counter).
	 */
	#refreshCredentialRevision(): void {
		const fingerprint = this.#computeCredentialFingerprint();
		if (fingerprint === this.#credentialFingerprint) return;
		this.#credentialFingerprint = fingerprint;
		this.#credentialRevision += 1;
	}

	/**
	 * Order-independent digest of the routable credential material — exactly the
	 * fields {@link listAuthCredentials} exposes (id, provider, credential). A
	 * token rotation or an add/remove changes it; credential blocks and usage
	 * overlays do not.
	 */
	#computeCredentialFingerprint(): string {
		// `identityKey` is part of what `listAuthCredentials()` exposes and what
		// account recovery matches on, so a snapshot that changes only the identity
		// must count as a change — otherwise `pollExternalChanges()` reports none
		// and the wrapping `AuthStorage` keeps matching notices to the old account.
		const parts = this.#snapshot.credentials.map(
			entry =>
				`${entry.id}\u0000${entry.provider}\u0000${entry.identityKey ?? ""}\u0000${JSON.stringify(entry.credential)}`,
		);
		parts.sort();
		return parts.join("\u0001");
	}
	#protectNewSnapshotBlocks(previous: readonly SnapshotEntry[], next: readonly SnapshotEntry[], nowMs: number): void {
		const previousBlocksByKey = new Map<string, string>();
		for (const entry of previous) {
			for (const block of entry.blocks ?? []) {
				previousBlocksByKey.set(
					`${entry.id}\0${block.providerKey}\0${block.blockScope}`,
					`${block.blockedUntilMs}\0${block.updatedAtMs ?? ""}`,
				);
			}
		}
		const activeKeys = new Set<string>();
		for (const entry of next) {
			for (const block of entry.blocks ?? []) {
				const key = `${entry.id}\0${block.providerKey}\0${block.blockScope}`;
				activeKeys.add(key);
				const signature = `${block.blockedUntilMs}\0${block.updatedAtMs ?? ""}`;
				if (previousBlocksByKey.get(key) === signature) continue;
				const updatedAtMs = block.updatedAtMs ?? nowMs;
				this.#credentialBlockReconcileAfter.set(
					key,
					Math.min(block.blockedUntilMs, updatedAtMs + CREDENTIAL_BLOCK_RECONCILE_DELAY_MS),
				);
			}
		}
		for (const key of this.#credentialBlockReconcileAfter.keys()) {
			if (!activeKeys.has(key)) this.#credentialBlockReconcileAfter.delete(key);
		}
	}

	/**
	 * Background snapshot sync. Invariant: this loop never keeps the process
	 * alive on its own. While the store is in active foreground use it holds a
	 * live broker request (SSE stream or long-poll); once the store has been
	 * idle for `#backgroundIdleMs` an unref'd watchdog aborts that request and
	 * the loop parks on a bare promise — zero timers or sockets — until the
	 * next foreground call. Backoff sleeps use unref'd timers for the same
	 * reason. A leaked (never-closed) store therefore stops pinning the event
	 * loop at most one idle window after its last use.
	 */
	async #runBackground(): Promise<void> {
		let backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
		while (!this.#closed && !this.#backgroundAbort.signal.aborted) {
			if (this.#idleRemainingMs() <= 0) {
				this.#activityWakeup ??= Promise.withResolvers<void>();
				await this.#activityWakeup.promise;
				continue;
			}
			const watchdog = this.#startIdleWatchdog();
			this.#retryCredentialRemovalNotifications();
			try {
				if (this.#streamSnapshots && !this.#streamingUnsupported) {
					try {
						await this.#consumeSnapshotStream(watchdog.signal);
						backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
					} catch (error) {
						if (this.#closed || this.#backgroundAbort.signal.aborted) break;
						if (watchdog.idled()) continue;
						if (error instanceof AuthBrokerStreamUnsupportedError) {
							this.#streamingUnsupported = true;
							logger.debug("auth-broker snapshot stream unsupported; falling back to long-poll");
							continue;
						}
						logger.debug("auth-broker snapshot stream failed; backing off", {
							error: String(error),
						});
						await this.#backoffWait(backoffMs);
						backoffMs = Math.min(BACKGROUND_BACKOFF_MAX_MS, backoffMs * 2);
					}
					continue;
				}
				try {
					const previousGeneration = this.#generation;
					const result = await this.#client.fetchSnapshot({
						ifGenerationGt: this.#generation,
						waitMs: BACKGROUND_WAIT_MS,
						signal: watchdog.signal,
					});
					if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation, previousGeneration);
					backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
				} catch (error) {
					if (this.#closed || this.#backgroundAbort.signal.aborted) break;
					if (watchdog.idled()) continue;
					logger.debug("auth-broker background snapshot sync failed", { error: String(error) });
					await this.#backoffWait(backoffMs);
					backoffMs = Math.min(BACKGROUND_BACKOFF_MAX_MS, backoffMs * 2);
				}
			} finally {
				watchdog.stop();
			}
		}
	}

	/** Record a foreground store use; wakes the parked background sync. */
	#noteActivity(): void {
		this.#lastActivityMs = Date.now();
		this.#retryCredentialRemovalNotifications();
		if (this.#activityWakeup) {
			this.#activityWakeup.resolve();
			this.#activityWakeup = null;
		}
	}

	#idleRemainingMs(): number {
		return this.#lastActivityMs + this.#backgroundIdleMs - Date.now();
	}

	/**
	 * Abort signal for one background iteration that trips once the store has
	 * been idle for `#backgroundIdleMs`. The timer is unref'd: it can only fire
	 * while something else keeps the event loop alive — typically our own
	 * in-flight broker request, which is exactly what it exists to end.
	 */
	#startIdleWatchdog(): { signal: AbortSignal; idled: () => boolean; stop: () => void } {
		const controller = new AbortController();
		let idled = false;
		let timer: Timer | undefined;
		const arm = (): void => {
			const remainingMs = this.#idleRemainingMs();
			if (remainingMs > 0) {
				timer = setTimeout(arm, remainingMs);
				timer.unref?.();
				return;
			}
			idled = true;
			controller.abort(new AIError.AbortError("auth-broker background sync idle"));
		};
		arm();
		return {
			signal: AbortSignal.any([this.#backgroundAbort.signal, controller.signal]),
			idled: () => idled,
			stop: () => clearTimeout(timer),
		};
	}

	/**
	 * Backoff sleep on an unref'd timer so retry waits never pin the process;
	 * in an otherwise-exiting process the timer simply never fires and the
	 * suspended loop holds no handles. Wakes early on `close()`.
	 */
	async #backoffWait(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		this.#backgroundAbort.signal.addEventListener("abort", onAbort, { once: true });
		try {
			await promise;
		} finally {
			this.#backgroundAbort.signal.removeEventListener("abort", onAbort);
		}
	}

	async #consumeSnapshotStream(signal: AbortSignal): Promise<void> {
		let initialGeneration: number | undefined = this.#generation;
		const iterator = this.#client.openSnapshotStream({ signal });
		try {
			for await (const event of iterator) {
				if (this.#closed || signal.aborted) break;
				this.#streamingActive = true;
				this.#applyStreamEvent(event, initialGeneration);
				initialGeneration = undefined;
			}
		} finally {
			this.#streamingActive = false;
		}
	}

	#applyStreamEvent(event: SnapshotStreamEvent, initialGeneration?: number): void {
		switch (event.kind) {
			case "snapshot": {
				// The first frame of every SSE connection is a full authoritative
				// snapshot. Always adopt it as the new generation baseline: the
				// broker's in-memory generation counter resets on restart and may
				// therefore be lower than the previous stream's last value.
				// Subsequent entry/removal frames remain guarded against reordering
				// relative to this new baseline below.
				// A fresh connection may be to a restarted or reconfigured broker, so
				// re-probe capabilities this client latched off against the previous
				// incarnation, and drop the local-disable guards with it. This frame
				// is an authoritative snapshot taken after those disables committed:
				// a row it still lists is either one the broker never retired or a
				// different credential that inherited the id from a rebuilt database,
				// and in both cases suppressing it is wrong.
				this.#client.resetDisabledHistoryProbe();
				const { kind: _kind, ...snapshot } = event;
				this.#applySnapshot(snapshot, snapshot.generation, initialGeneration);
				return;
			}
			case "entry": {
				if (event.generation < this.#generation) return;
				this.#applyStreamEntry(event.entry, event.refresher, event.generation, event.serverNowMs);
				return;
			}
			case "removed": {
				if (event.generation < this.#generation) return;
				this.#removeStreamCredential(event.id, event.refresher, event.generation, event.serverNowMs);
				return;
			}
		}
	}

	/**
	 * Credential ids inserted by a stream `entry`, with the generation that
	 * delivered them. A coalesced generation streams the replacement before the
	 * `removed` frame, so a row added by the same generation as a removal is
	 * part of that transition and is never one of its pre-existing siblings.
	 */
	#streamAdditions = new Map<number, number>();
	/**
	 * Rows this client successfully disabled, keyed to the generation in effect
	 * when the removal landed. A full-snapshot request that was already in flight
	 * carries an older-or-equal generation and would otherwise resurrect the row;
	 * the later stream removal then announces the same teardown a second time.
	 */
	#locallyDisabledAt = new Map<number, { generation: number; expiresAtMs: number }>();

	/**
	 * API-key rows of `provider` that were already live before this teardown,
	 * computed from the list being diffed rather than from any retained base, so
	 * a concurrent pull or a broker restart cannot make it stale.
	 *
	 * The stream adds a replacement before it removes the row it replaces, so a
	 * pull that observes the next generation while the removal is still pending
	 * counts that replacement as pre-existing. Deciding this exactly needs the
	 * broker to order removals first or mark the replacement; until then the
	 * residual keeps a teardown notice until the next full snapshot, which is
	 * the same direction the rest of this feature biases toward — a stale
	 * reminder over a silent sign-out.
	 */
	#siblingApiKeyIds(
		entry: SnapshotEntry,
		before: readonly SnapshotEntry[],
		generation: number,
	): ReadonlySet<number> | undefined {
		if (entry.credential.type !== "api_key") return undefined;
		const ids = new Set<number>();
		for (const row of before) {
			if (row.id === entry.id || row.provider !== entry.provider) continue;
			if (row.credential.type !== "api_key") continue;
			if (this.#streamAdditions.get(row.id) === generation) continue;
			ids.add(row.id);
		}
		return ids;
	}

	#applyStreamEntry(
		entry: SnapshotEntry,
		refresher: RefresherSchedule,
		generation: number,
		serverNowMs: number,
	): void {
		this.#upsertBrokerUsageAccount(entry);
		if (!isCredentialInAccountPool(entry, this.#accountPool)) {
			this.#removeStreamCredential(entry.id, refresher, generation, serverNowMs, { retainBrokerUsageAccount: true });
			return;
		}
		// Same guard the snapshot path applies: an `entry` frame still in transit
		// when this client's disable landed would otherwise re-add the dead bearer,
		// and the broker sends `removed` only after entries. The row returns when a
		// newer generation observes it.
		// The guard is released by a snapshot that omits the row, not by a newer
		// generation, so an in-transit `entry` frame cannot re-add a dead bearer.
		if (this.#isLocallyDisabled(entry.id)) return;
		const incoming = this.#normalizeSnapshotEntryBlocks(entry, Date.now());
		const index = this.#snapshot.credentials.findIndex(candidate => candidate.id === incoming.id);
		const previousBlocks = index === -1 ? undefined : this.#snapshot.credentials[index]?.blocks;
		const blocksChanged = !credentialBlockSnapshotsEqual(previousBlocks, incoming.blocks);
		if (blocksChanged) this.#invalidateUsageCache();
		if (index === -1) this.#streamAdditions.set(incoming.id, generation);
		const credentials =
			index === -1
				? [...this.#snapshot.credentials, incoming]
				: this.#snapshot.credentials.map((candidate, i) => (i === index ? incoming : candidate));
		if (blocksChanged) this.#protectNewSnapshotBlocks(this.#snapshot.credentials, credentials, Date.now());
		this.#snapshot = { ...this.#snapshot, generation, serverNowMs, refresher, credentials };
		this.#generation = generation;
		this.#snapshotReceivedAt = Date.now();
		this.#refreshCredentialRevision();
		this.#retryCredentialRemovalNotifications();
	}

	onCredentialDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
		this.#credentialDisabledListeners.add(listener);
		return () => {
			this.#credentialDisabledListeners.delete(listener);
			if (this.#credentialDisabledListeners.size === 0) {
				this.#pendingCredentialRemovals.clear();
				this.#scheduleCredentialRemovalRetry();
			}
		};
	}

	/** Bounded: only the most recent departures can still be retried as logouts. */
	#noteCredentialVanished(id: number): void {
		this.#vanishedCredentialIds.delete(id);
		this.#vanishedCredentialIds.add(id);
		if (this.#vanishedCredentialIds.size > VANISHED_CREDENTIAL_MEMORY) {
			const oldest = this.#vanishedCredentialIds.values().next().value;
			if (oldest !== undefined) this.#vanishedCredentialIds.delete(oldest);
		}
	}

	/** `siblingApiKeyIds` is resolved by the caller against the list it diffed. */
	#notifyCredentialRemoved(entry: SnapshotEntry, siblingApiKeyIds: ReadonlySet<number> | undefined): void {
		if (this.#closed || this.#credentialDisabledListeners.size === 0) return;
		if (this.#pendingCredentialRemovals.has(entry.id)) return;
		const identity =
			entry.credential.type === "oauth"
				? resolveOAuthCredentialIdentity(entry.provider, entry.credential)
				: undefined;
		if (identity) identity.key = entry.identityKey;
		this.#pendingCredentialRemovals.set(entry.id, {
			id: entry.id,
			provider: entry.provider,
			type: entry.credential.type,
			identity,
			retryAfterMs: 0,
			backoffMs: BACKGROUND_BACKOFF_INITIAL_MS,
			inFlight: false,
			siblingApiKeyIds,
		});
		this.#retryCredentialRemovalNotifications();
	}

	/**
	 * Whether a provider gained an API key after a teardown. An API key carries
	 * no identity, so a row that was already live when the removal was observed
	 * proves nothing: the pool simply lost one key. Both the fast snapshot check
	 * and the final post-tombstone classification use this one rule.
	 */
	#apiKeyReplaced(provider: string, siblingApiKeyIds: ReadonlySet<number> | undefined): boolean {
		return this.#snapshot.credentials.some(
			row =>
				row.provider === provider && row.credential.type === "api_key" && siblingApiKeyIds?.has(row.id) !== true,
		);
	}

	#retryCredentialRemovalNotifications(): void {
		if (this.#closed || this.#credentialDisabledListeners.size === 0 || this.#pendingCredentialRemovals.size === 0)
			return;
		const nowMs = Date.now();
		for (const entry of this.#pendingCredentialRemovals.values()) {
			// Retire recovery as soon as it is observed, even if another removal
			// arrives before the failed tombstone lookup can be retried.
			const recovered = this.#snapshot.credentials.some(active => {
				if (active.id === entry.id) return true;
				if (active.provider !== entry.provider) return false;
				if (entry.type === "api_key") return this.#apiKeyReplaced(entry.provider, entry.siblingApiKeyIds);
				if (active.credential.type !== "oauth" || !entry.identity) return false;
				const identity = resolveOAuthCredentialIdentity(active.provider, active.credential);
				identity.key = active.identityKey;
				return isOAuthCredentialIdentityRecovered(entry.identity, identity);
			});
			if (recovered) {
				this.#pendingCredentialRemovals.delete(entry.id);
				continue;
			}
			if (entry.inFlight || entry.retryAfterMs > nowMs) continue;
			entry.inFlight = true;
			void this.#lookupCredentialRemoval(entry);
		}
		this.#scheduleCredentialRemovalRetry();
	}

	#scheduleCredentialRemovalRetry(): void {
		let retryAfterMs = Infinity;
		if (!this.#closed && this.#credentialDisabledListeners.size > 0) {
			for (const entry of this.#pendingCredentialRemovals.values()) {
				if (!entry.inFlight) retryAfterMs = Math.min(retryAfterMs, entry.retryAfterMs);
			}
		}
		const delayMs = Math.max(0, retryAfterMs - Date.now());
		// Like snapshot sync, park after foreground activity expires. A later
		// foreground use re-arms retained work without keeping idle stores alive.
		if (delayMs >= this.#idleRemainingMs()) retryAfterMs = Infinity;
		if (this.#credentialRemovalRetryAtMs === retryAfterMs) return;
		clearTimeout(this.#credentialRemovalRetryTimer);
		this.#credentialRemovalRetryTimer = undefined;
		this.#credentialRemovalRetryAtMs = retryAfterMs;
		if (retryAfterMs === Infinity) return;
		this.#credentialRemovalRetryTimer = setTimeout(() => {
			this.#credentialRemovalRetryTimer = undefined;
			this.#credentialRemovalRetryAtMs = Infinity;
			this.#retryCredentialRemovalNotifications();
		}, delayMs);
		this.#credentialRemovalRetryTimer.unref?.();
	}

	async #lookupCredentialRemoval(entry: PendingCredentialRemoval): Promise<void> {
		const localDisable = this.#localDisables.get(entry.id);
		if (localDisable) {
			// A failed local write may have lost to a peer disable; only suppress a
			// notice when any overlapping local operation successfully disabled it.
			await localDisable.promise;
			if (localDisable.succeeded) {
				this.#pendingCredentialRemovals.delete(entry.id);
				this.#scheduleCredentialRemovalRetry();
			}
		}
		if (this.#pendingCredentialRemovals.get(entry.id) !== entry) return;
		// Removal alone also means logout, replacement, or pool exclusion. Replay
		// only this row's automatic tombstone through the existing redacted endpoint.
		try {
			// Bound by the same idle window as background sync: `#backgroundAbort`
			// alone only fires on close, so a lookup started just before the
			// watchdog parks the loop would keep pinning the process through the
			// client's timeout and retry.
			const watchdog = this.#startIdleWatchdog();
			let disabled: DisabledCredentialSummary[];
			try {
				disabled = await this.#fetchDisabledCredentials(
					entry.provider,
					AbortSignal.any([this.#backgroundAbort.signal, watchdog.signal]),
				);
			} finally {
				watchdog.stop();
			}
			if (this.#pendingCredentialRemovals.get(entry.id) !== entry) return;
			// Classification is final, including deliberate removals and missing
			// tombstones. Listener failures must not replay the event.
			this.#pendingCredentialRemovals.delete(entry.id);
			this.#scheduleCredentialRemovalRetry();
			const summary = disabled.find(candidate => candidate.id === entry.id);
			if (!summary || !isAutomaticDisableCause(summary.cause)) return;
			// Entries can arrive before removals or while the tombstone request is
			// pending. Only the latest pool-visible snapshot can prove recovery.
			if (summary.type === "api_key") {
				if (this.#apiKeyReplaced(summary.provider, entry.siblingApiKeyIds)) return;
			} else {
				const activeAccounts: CredentialAccountIdentity[] = [];
				for (const { provider, credential, identityKey } of this.#snapshot.credentials) {
					if (provider !== summary.provider || credential.type !== "oauth") continue;
					const identity = resolveOAuthCredentialIdentity(provider, credential);
					identity.key = identityKey;
					const account: CredentialAccountIdentity = { provider, type: "oauth", identity };
					copyOAuthCredentialIdentity(account, credential, identity);
					activeAccounts.push(account);
				}
				if (!isActionableCredentialDisable(summary, activeAccounts)) return;
			}
			const { id, type, cause, disabledAtMs: _disabledAtMs, ...identity } = summary;
			// Raw, like the local emitter: in-process consumers correlate on the
			// stored provider id. Projection happens at each external boundary.
			const event: CredentialDisabledEvent = {
				...identity,
				credentialId: id,
				credentialType: type,
				disabledCause: cause,
			};
			// Attribution computed against this removal's broker generation; a
			// consumer re-deriving it from a later snapshot would miss siblings.
			if (type === "api_key" && entry.siblingApiKeyIds) event.siblingApiKeyIds = entry.siblingApiKeyIds;
			const listeners = new Set(this.#credentialDisabledListeners);
			for (const listener of listeners) {
				// A listener may be async: its rejection has to be isolated here or
				// Bun reports it unhandled and can take the process down. The thrown
				// text is not recorded — it routinely echoes the event it was given.
				const failed = (): void => {
					if (!this.#closed) {
						logger.debug("auth-broker credential-disabled listener failed", {
							id: entry.id,
							error: "credential-disabled listener rejected",
						});
					}
				};
				try {
					const result = listener(event);
					if (result && typeof (result as PromiseLike<void>).then === "function") {
						(result as Promise<void>).catch(failed);
					}
				} catch {
					failed();
				}
			}
		} catch (error) {
			entry.inFlight = false;
			entry.retryAfterMs = Date.now() + entry.backoffMs;
			entry.backoffMs = Math.min(BACKGROUND_BACKOFF_MAX_MS, entry.backoffMs * 2);
			this.#scheduleCredentialRemovalRetry();
			if (!this.#closed) {
				logger.debug("auth-broker disable notification failed", {
					id: entry.id,
					error: String(error),
				});
			}
		}
	}

	/**
	 * Whether a snapshot entry is a row this client disabled and the broker has
	 * not yet confirmed gone.
	 *
	 * The guard exists for one narrow window: a snapshot request already in
	 * flight when the disable landed still lists the row and would resurrect it.
	 * That window is a round trip, so the guard is bounded by one. Holding it
	 * until some event proves the broker's identity is what went wrong twice
	 * here — a restarted broker can resume at the same or a higher generation
	 * (`auth-broker-remote-store.test.ts` models exactly that, and the codebase
	 * detects it by content revision, not by generation), so no generation test
	 * can decide it, and a guard held on a reused id suppresses a live
	 * credential forever. Expiring covers every incarnation shape without
	 * needing to recognise any of them.
	 */
	#isLocallyDisabled(id: number): boolean {
		const guard = this.#locallyDisabledAt.get(id);
		if (guard === undefined) return false;
		if (guard.expiresAtMs > Date.now()) return true;
		this.#locallyDisabledAt.delete(id);
		return false;
	}

	#removeStreamCredential(
		id: number,
		refresher: RefresherSchedule,
		generation: number,
		serverNowMs: number,
		options?: { retainBrokerUsageAccount?: boolean },
	): void {
		if (!options?.retainBrokerUsageAccount) this.#removeBrokerUsageAccount(id);
		const removed = this.#snapshot.credentials.find(entry => entry.id === id);
		const siblingApiKeyIds = removed
			? this.#siblingApiKeyIds(removed, this.#snapshot.credentials, generation)
			: undefined;
		if (removed?.blocks && removed.blocks.length > 0) this.#invalidateUsageCache();
		const credentials = this.#snapshot.credentials.filter(entry => entry.id !== id);
		this.#snapshot = { ...this.#snapshot, generation, serverNowMs, refresher, credentials };
		this.#generation = generation;
		this.#streamAdditions.delete(id);
		// The guard exists to stop an in-transit `entry` frame or an older
		// snapshot from resurrecting a row this client disabled; this frame is the
		// broker's own confirmation that the row is gone, so nothing is left to
		// resurrect. Releasing it here is what bounds the map on a healthy stream,
		// which skips the full snapshot that would otherwise clear it — and stops
		// a rebuilt broker reusing the id from being suppressed.
		this.#locallyDisabledAt.delete(id);
		this.#snapshotReceivedAt = Date.now();
		this.#refreshCredentialRevision();
		if (removed && !options?.retainBrokerUsageAccount) {
			// A streamed removal is a departure this client witnessed, exactly like
			// one found by diffing a full snapshot. Record it whether or not anyone
			// is listening for the announcement.
			this.#noteCredentialVanished(id);
			this.#notifyCredentialRemoved(removed, siblingApiKeyIds);
		}
		this.#retryCredentialRemovalNotifications();
	}

	/** Re-hydrate the in-memory snapshot from the broker; `signal` bounds the fetch. */
	async refreshSnapshot(signal?: AbortSignal): Promise<SnapshotResponse> {
		this.#noteActivity();
		const previousGeneration = this.#generation;
		const result = await this.#client.fetchSnapshot({ signal });
		if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation, previousGeneration);
		return this.#snapshot;
	}

	/**
	 * Stateful probe for broker-side credential changes, mirroring
	 * {@link SqliteAuthCredentialStore.pollExternalChanges} so long-lived broker
	 * clients (notably `auth-gateway serve`) pick up logins/logouts made by
	 * another process without a restart.
	 *
	 * Compares a local content revision, not the broker's numeric generation:
	 * generation is an in-memory counter that resets when the broker process
	 * restarts, so a reconnecting stream can deliver a different credential set
	 * under a repeated (or lower) generation. {@link #refreshCredentialRevision}
	 * bumps the revision whenever the applied credential material actually
	 * changes, catching those cases too. Records foreground activity first: a
	 * low-traffic client's background sync parks after `#backgroundIdleMs`, and
	 * without this wakeup it would never fetch the new snapshot to report in the
	 * first place.
	 */
	pollExternalChanges(): boolean {
		this.#noteActivity();
		if (this.#credentialRevision === this.#acknowledgedRevision) return false;
		this.#acknowledgedRevision = this.#credentialRevision;
		return true;
	}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		this.#noteActivity();
		const out: StoredAuthCredential[] = [];
		for (const entry of this.#snapshot.credentials) {
			if (provider !== undefined && entry.provider !== provider) continue;
			out.push({
				id: entry.id,
				provider: entry.provider,
				credential: entry.credential as AuthCredential,
				identityKey: entry.identityKey,
				disabledCause: null,
			});
		}
		return out;
	}

	/**
	 * Tombstones follow the active view pool using their canonical projected identity.
	 * Missing identities are excluded by explicit pools just like live entries;
	 * unconfigured providers and API keys remain unrestricted. Older brokers return no history.
	 */
	async listDisabledCredentials(
		provider?: string,
		signal?: AbortSignal,
		options: { requireSupported?: boolean } = {},
	): Promise<DisabledCredentialSummary[]> {
		this.#noteActivity();
		return this.#fetchDisabledCredentials(provider, signal, options);
	}

	async #fetchDisabledCredentials(
		provider?: string,
		signal?: AbortSignal,
		options: { requireSupported?: boolean } = {},
	): Promise<DisabledCredentialSummary[]> {
		const disabled = await this.#client.listDisabledCredentials(provider, signal, options);
		if (!this.#accountPool) return disabled;
		return disabled.filter(summary => {
			if (summary.type !== "oauth" || !this.#accountPool?.has(summary.provider)) return true;
			return isCredentialInAccountPool(
				{
					provider: summary.provider,
					credential: summary,
					identityKey: resolveOAuthCredentialIdentity(summary.provider, summary).key,
				},
				this.#accountPool,
			);
		});
	}

	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		this.#noteActivity();
		const nowMs = Date.now();
		this.cleanExpiredCredentialBlocks(nowMs);
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (!entry?.blocks) return undefined;
		const block = entry.blocks.find(
			candidate => candidate.providerKey === providerKey && candidate.blockScope === blockScope,
		);
		if (!block || block.blockedUntilMs <= nowMs) return undefined;
		return block.blockedUntilMs;
	}

	getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		if (this.getCredentialBlock(credentialId, providerKey, blockScope) === undefined) return undefined;
		return this.#credentialBlockReconcileAfter.get(`${credentialId}\0${providerKey}\0${blockScope}`);
	}

	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		this.#noteActivity();
		const nowMs = Date.now();
		this.cleanExpiredCredentialBlocks(nowMs);
		const ids = new Set(credentialIds);
		const blocks: StoredCredentialBlock[] = [];
		for (const entry of this.#snapshot.credentials) {
			if (!ids.has(entry.id) || !entry.blocks) continue;
			for (const block of entry.blocks) {
				if (block.blockedUntilMs <= nowMs) continue;
				blocks.push({
					credentialId: entry.id,
					providerKey: block.providerKey,
					blockScope: block.blockScope,
					blockedUntilMs: block.blockedUntilMs,
					updatedAtMs: block.updatedAtMs,
				});
			}
		}
		blocks.sort((a, b) => a.credentialId - b.credentialId || compareCredentialBlockSnapshots(a, b));
		return blocks;
	}

	upsertCredentialBlock(block: StoredCredentialBlock): void {
		this.#noteActivity();
		this.#upsertSnapshotBlock(block);
		this.#invalidateUsageCache();
		this.#credentialBlockReconcileAfter.set(
			`${block.credentialId}\0${block.providerKey}\0${block.blockScope}`,
			Math.min(block.blockedUntilMs, Date.now() + CREDENTIAL_BLOCK_RECONCILE_DELAY_MS),
		);
		const body = toCredentialBlockSnapshot(block);
		void this.#client
			.upsertCredentialBlock(block.credentialId, body)
			.then(() => {
				this.#maybeRefreshSnapshot("credential block");
			})
			.catch(error => {
				logger.warn("auth-broker credential block propagation failed", {
					id: block.credentialId,
					providerKey: block.providerKey,
					blockScope: block.blockScope,
					error: String(error),
				});
			});
	}

	deleteCredentialBlock(_credentialId: number, _providerKey: string, _blockScope: string): void {
		// The broker protocol only supports deleting every block for a credential.
		// Keep scoped blocks until expiry rather than risk deleting unrelated or
		// newer broker state through that broader operation.
	}

	deleteCredentialBlocks(credentialId: number): void {
		this.#noteActivity();
		this.#deleteSnapshotBlocks(credentialId);
		for (const key of this.#credentialBlockReconcileAfter.keys()) {
			if (key.startsWith(`${credentialId}\0`)) this.#credentialBlockReconcileAfter.delete(key);
		}
		this.#invalidateUsageCache();
		void this.#client
			.deleteCredentialBlocks(credentialId)
			.then(() => {
				this.#maybeRefreshSnapshot("credential blocks delete");
			})
			.catch(error => {
				logger.warn("auth-broker credential blocks delete propagation failed", {
					id: credentialId,
					error: String(error),
				});
			});
	}

	cleanExpiredCredentialBlocks(nowMs: number): void {
		this.#pruneExpiredCredentialBlocks(nowMs);
		for (const [key, reconcileAfterMs] of this.#credentialBlockReconcileAfter) {
			if (reconcileAfterMs <= nowMs) this.#credentialBlockReconcileAfter.delete(key);
		}
	}

	/**
	 * In-memory update from a successful refresh through the broker. AuthStorage
	 * calls this after `#replaceCredentialAt`; the broker already persisted the
	 * authoritative row, so we just mirror it.
	 */
	updateAuthCredential(id: number, credential: AuthCredential): void {
		this.#noteActivity();
		for (const entry of this.#snapshot.credentials) {
			if (entry.id !== id) continue;
			if (!authCredentialEquals(entry.credential as AuthCredential, credential)) {
				entry.identityKey =
					credential.type === "oauth" ? resolveOAuthCredentialIdentity(entry.provider, credential).key : null;
			}
			entry.credential = credential as typeof entry.credential;
			return;
		}
	}

	/**
	 * Optimistic local disable. Reports whether this client's snapshot still
	 * held the row: a peer that already disabled it owns the persisted cause,
	 * and the broker resolves the authoritative outcome asynchronously.
	 */
	deleteAuthCredential(id: number, disabledCause: string): boolean {
		this.#noteActivity();
		const held = this.#snapshot.credentials.some(entry => entry.id === id);
		this.#removeCredentialById(id);
		// Fire-and-forget: tell the broker to persist the disable.
		this.#client.disableCredential(id, disabledCause).catch(error => {
			logger.warn("auth-broker disable propagation failed", { id, error: String(error) });
		});
		return held;
	}

	/**
	 * Await the broker disable, conditional on the access/key when a fingerprint
	 * from `fingerprintCredentialForDisable` is supplied. A lost CAS — a peer
	 * replaced the credential (412) or removed the row
	 * before the broker handled this request (404) — returns false without
	 * removing the local entry, after re-fetching the snapshot so the caller's
	 * follow-up `reload()` already sees the peer's outcome instead of the
	 * stale row it attempted.
	 */
	async deleteAuthCredentialRemote(
		id: number,
		disabledCause: string,
		expectedAccessFingerprint?: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		this.#noteActivity();
		const cause = normalizeDisabledCause(disabledCause);
		const found = this.#snapshot.credentials.some(entry => entry.id === id);
		if (!found) {
			if (!isDeliberateRemovalCause(cause)) return false;
			// A refresh can remove a peer-disabled row before a failed logout is retried.
			// Only tombstones visible through this client account pool may be removed.
			const disabled = await this.listDisabledCredentials(undefined, signal);
			// A row this client held and then lost is already removed: report the
			// logout complete rather than telling the caller it was skipped.
			if (!disabled.some(entry => entry.id === id)) return this.#vanishedCredentialIds.has(id);
		}
		const disabling = this.#client.disableCredential(id, cause, { expectedAccessFingerprint, signal });
		let localDisable = this.#localDisables.get(id);
		if (!localDisable) {
			const { promise, resolve } = Promise.withResolvers<void>();
			localDisable = { pending: 0, succeeded: false, promise, resolve };
			this.#localDisables.set(id, localDisable);
		}
		localDisable.pending++;
		try {
			await disabling;
			localDisable.succeeded = true;
			// Only guard a row the stream has not already retired. When its `removed`
			// frame beats this response the guard would be re-added right after the
			// only thing that clears it, and an active stream never revisits it —
			// the map would grow per disable and suppress a reused id for good.
			if (this.#snapshot.credentials.some(entry => entry.id === id)) {
				this.#locallyDisabledAt.set(id, {
					generation: this.#generation,
					expiresAtMs: Date.now() + LOCAL_DISABLE_GUARD_TTL_MS,
				});
			}
			this.#removeCredentialById(id);
			// A streaming connection suppresses the refresh below, so persist the
			// filtered snapshot here instead of leaving the dead bearer in the cache
			// until the broker's `removed` frame lands.
			if (this.#streamingActive) this.#persistCurrentSnapshot();
			this.#maybeRefreshSnapshot("delete credential");
			return true;
		} catch (error) {
			// Two requests can exhaust the same bearer and both pass the `found`
			// check above; the broker answers the loser with 404, and 412 is the
			// conditional-disable equivalent. Either is a lost race, not a failure:
			// report no transition and reconcile authoritatively so the caller
			// judges retryability on the real pool. Anything else propagates — a
			// caller must not drop a row on an unknown error.
			if (error instanceof AuthBrokerError && (error.status === 412 || error.status === 404)) {
				logger.debug("auth-broker disable lost to a peer", { id, status: error.status });
				// 404 means the row is gone server-side: announce the departure, then
				// drop it. This call reports no transition, so `AuthStorage` emits
				// nothing, and removing the row silently would also deprive the later
				// snapshot diff of the previous entry — the sign-out would vanish.
				// Leaving it instead would let a failed refresh strand the retired
				// bearer in the pool `#adoptPoolAfterDisable` falls back to.
				// 412 is the opposite: the row is still there under a peer's rotated
				// bearer, so its cached copy must survive and nothing departed.
				if (error.status === 404) {
					const departed = this.#snapshot.credentials.find(entry => entry.id === id);
					if (departed) {
						this.#notifyCredentialRemoved(
							departed,
							this.#siblingApiKeyIds(departed, this.#snapshot.credentials, this.#generation),
						);
					}
					this.#removeCredentialById(id);
				}
				// This hook takes the caller's signal, so the re-read is awaited and
				// cancellable: a conditional disable must not report a CAS loss from
				// a snapshot it has not refreshed.
				await this.#reconcileAfterRejectedDisable(signal);
				return false;
			}
			throw error;
		} finally {
			if (--localDisable.pending === 0) {
				this.#localDisables.delete(id);
				localDisable.resolve();
			}
		}
	}

	/**
	 * The broker refused to disable because its row moved on; nothing changed
	 * server-side, so no stream push is coming — fetch the current snapshot
	 * explicitly. Failure must propagate: returning a clean CAS loss would let
	 * callers reload and select the rejected bearer from the stale snapshot.
	 */
	async #reconcileAfterRejectedDisable(signal?: AbortSignal): Promise<void> {
		try {
			await this.refreshSnapshot(signal);
		} catch (error) {
			logger.debug("auth-broker snapshot refresh after rejected disable failed", {
				error: String(error),
			});
			throw error;
		}
	}

	/** Remote CAS must await the broker's decision; synchronous success cannot represent it. */
	tryDisableAuthCredentialIfMatches(_id: number, _expectedData: string, _disabledCause: string): boolean {
		throw new AIError.AuthBrokerError(
			"RemoteAuthCredentialStore does not support synchronous conditional disables. Await deleteAuthCredentialRemote instead.",
		);
	}

	async waitForFreshSnapshot(maxWaitMs: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
		this.#noteActivity();
		const previousGeneration = this.#generation;
		const result = await this.#client.fetchSnapshot({
			ifGenerationGt: this.#generation,
			waitMs: maxWaitMs,
			signal: opts.signal,
		});
		if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation, previousGeneration);
		return this.#generation !== previousGeneration;
	}

	async prepareForRequest(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
		this.#noteActivity();
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (entry?.credential.type !== "oauth" || entry.rotatesInMs === null) return false;
		const remainingMs = this.#snapshotReceivedAt + entry.rotatesInMs - Date.now();
		if (remainingMs > WAIT_THRESHOLD_MS) return false;
		return this.waitForFreshSnapshot(MAX_WAIT_MS, opts);
	}

	async markCredentialSuspect(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
		this.#noteActivity();
		const { entry } = await this.#client.refreshCredential(credentialId, opts.signal);
		if (entry.credential.type !== "oauth") {
			throw new AIError.AuthBrokerError(`Broker returned non-OAuth credential for id=${credentialId}`);
		}
		if (!this.#applyCredentialEntry(entry)) {
			throw new AIError.AuthBrokerError(
				`Broker refreshed credential id=${credentialId} outside the configured account pool`,
			);
		}
		this.#maybeRefreshSnapshot("suspect credential refresh");
	}

	replaceAuthCredentialsForProvider(_provider: string, _credentials: AuthCredential[]): StoredAuthCredential[] {
		throw new AIError.AuthBrokerError(
			"RemoteAuthCredentialStore is read-only on the client. Use `omp auth-broker login <provider>` to mutate credentials.",
		);
	}

	upsertAuthCredentialForProvider(_provider: string, _credential: AuthCredential): StoredAuthCredential[] {
		throw new AIError.AuthBrokerError(
			"RemoteAuthCredentialStore is read-only on the client. Use `omp auth-broker login <provider>` to mutate credentials.",
		);
	}

	deleteAuthCredentialsForProvider(_provider: string, _disabledCause: string): void {
		throw new AIError.AuthBrokerError(
			"RemoteAuthCredentialStore is read-only on the client. Use `omp auth-broker logout <provider>` to mutate credentials.",
		);
	}

	/**
	 * Upsert a single credential through the broker. The broker server is the
	 * canonical writer — see `POST /v1/credential`. The redacted snapshot
	 * entries returned by the server replace the provider's rows in our local
	 * snapshot, and the global snapshot is then refreshed in the background so
	 * any concurrent peer (refresh, generation bump) stays in sync.
	 */
	async upsertAuthCredentialRemote(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
		this.#noteActivity();
		const { entries } = await this.#client.uploadCredential(provider, credential);
		this.#applyProviderEntries(provider, entries);
		this.#maybeRefreshSnapshot("upload");
		return this.listAuthCredentials(provider);
	}

	/**
	 * Replace-all semantics: disable every active credential for the provider,
	 * then upload each of the new credentials. Used by API-key login so a new
	 * key clobbers any previously stored key for the same provider.
	 */
	async replaceAuthCredentialsRemote(
		provider: string,
		credentials: AuthCredential[],
	): Promise<StoredAuthCredential[]> {
		const existing = this.listAuthCredentials(provider);
		for (const entry of existing) {
			try {
				await this.#client.disableCredential(entry.id, "replaced by newer credential");
			} catch (error) {
				logger.warn("auth-broker disable during replace failed", {
					provider,
					id: entry.id,
					error: String(error),
				});
			}
		}
		// Snapshot reflects the disables before we add the new rows so a concurrent
		// reader cannot momentarily see old + new together for the same provider.
		this.#removeProviderEntries(provider);
		for (const credential of credentials) {
			const { entries } = await this.#client.uploadCredential(provider, credential);
			this.#applyProviderEntries(provider, entries);
		}
		this.#maybeRefreshSnapshot("replace");
		return this.listAuthCredentials(provider);
	}

	/**
	 * Whole-provider logout also clears prior tombstones, including unidentified
	 * rows and history with no remaining active credentials. Reject providers
	 * restricted by an account pool so hidden accounts and history are preserved.
	 * Only drop the local snapshot after the broker persists the operation successfully.
	 */
	async deleteAuthCredentialsRemote(provider: string, disabledCause: string): Promise<void> {
		if (this.#accountPool?.has(provider)) {
			throw new AIError.ConfigurationError(
				`Cannot log out all ${provider} accounts while its broker account pool is restricted; remove individual accounts instead`,
			);
		}
		this.#noteActivity();
		// Act on an authoritative read, not the cached snapshot. A client that just
		// started from the persisted cache, or has not seen the latest stream
		// frame, otherwise misses a row the broker still holds: the legacy fallback
		// would skip disabling it, and the guard recorded below could not cover it,
		// letting a queued `entry` frame make a logged-out account selectable
		// again. A failure here propagates — logging out from a view known to be
		// stale is worse than not starting.
		await this.refreshSnapshot();
		try {
			await this.#client.logoutProvider(provider);
		} catch (error) {
			// A broker predating this route answers 404 from its catch-all; the
			// handler itself never does. Rather than failing whole-provider logout
			// in a mixed-version deployment — which also breaks managed MCP
			// credential removal during `/mcp reauth` — fall back to the
			// per-credential disable route every broker has always supported. Old
			// broker, old semantics: the rows go, their tombstones stay.
			if (!(error instanceof AuthBrokerError && error.status === 404)) throw error;
			// Re-read and re-enumerate until a pass finds nothing left: the
			// unsupported-route round trip and each disable are windows in which a
			// peer can upload another row, and a row missed here stays signed in on
			// the broker while this method reports a complete logout. Bounded — a
			// peer re-logging in faster than we retire must not spin this forever;
			// the barrier recorded by the caller covers whatever arrives after.
			let firstFailure: unknown;
			for (let pass = 0; pass < LEGACY_LOGOUT_MAX_PASSES; pass++) {
				await this.refreshSnapshot();
				const rows = this.listAuthCredentials(provider);
				if (rows.length === 0) break;
				// Attempt every row before reporting, so one unreachable credential
				// does not strand the rest — but a failure must still surface:
				// clearing the local snapshot on a broker that kept the credential
				// would report a logout that did not happen.
				for (const entry of rows) {
					try {
						await this.#client.disableCredential(entry.id, disabledCause);
					} catch (disableError) {
						// A peer logging the same provider out removes the row first and
						// this request gets a 404. The row is gone, which is the outcome
						// asked for — recording it as a failure would report a failed
						// logout for a provider that is empty. The confirming re-read
						// below decides, not this attempt.
						if (disableError instanceof AuthBrokerError && disableError.status === 404) continue;
						firstFailure ??= disableError;
						logger.warn("auth-broker disable during provider logout fallback failed", {
							provider: providerIdForDisplay(provider),
							id: entry.id,
							error: String(disableError),
						});
					}
				}
				if (firstFailure !== undefined) break;
			}
			if (firstFailure !== undefined) throw firstFailure;
			// A pass can enumerate rows, disable them, and still leave a newer
			// upload behind. Confirm rather than assume: clearing the provider
			// locally while the broker still holds a live row would report a logout
			// that did not happen and let a later refresh restore it.
			await this.refreshSnapshot();
			const stillActive = this.listAuthCredentials(provider);
			if (stillActive.length > 0) {
				throw new AIError.ConfigurationError(
					`Logging out of ${provider} did not complete: ${stillActive.length} credential(s) were added while it ran. Retry the logout.`,
				);
			}
		}
		// Deliberately no local barrier for the rows this logout removed. Any
		// barrier has to name the generation the logout committed at, which this
		// client cannot observe without another read — and a read wide enough to
		// catch a peer's upload is also wide enough to catch a peer's re-login,
		// where suppressing a valid credential is the worse error. A stale
		// `entry` frame can briefly re-add a row until the broker's own
		// `removed` frame lands; that is self-correcting and is what the
		// per-row path relies on too.
		this.#removeProviderEntries(provider);
		if (this.#streamingActive) this.#persistCurrentSnapshot();
		this.#maybeRefreshSnapshot("delete");
	}

	#applyProviderEntries(provider: string, entries: AuthCredentialSnapshotEntry[]): void {
		// `entries` is the broker's authoritative post-upsert list of rows for
		// `provider`. Drop our existing rows for the same provider and splice in
		// the fresh set — preserving every other provider's rows in place.
		const existingBlocks = new Map(
			this.#snapshot.credentials
				.filter(entry => entry.provider === provider && entry.blocks !== undefined)
				.map(entry => [entry.id, entry.blocks] as const),
		);
		const others = this.#snapshot.credentials.filter(entry => entry.provider !== provider);
		const incoming = entries
			.filter(entry => isCredentialInAccountPool(entry, this.#accountPool))
			.map(entry => credentialEntryWithBlocks(entry, existingBlocks.get(entry.id)));
		this.#snapshot = { ...this.#snapshot, credentials: [...others, ...incoming] };
	}
	#applyCredentialEntry(entry: AuthCredentialSnapshotEntry): boolean {
		if (!isCredentialInAccountPool(entry, this.#accountPool)) {
			this.#removeCredentialById(entry.id);
			return false;
		}
		const index = this.#snapshot.credentials.findIndex(candidate => candidate.id === entry.id);
		const existingBlocks = index === -1 ? undefined : this.#snapshot.credentials[index]?.blocks;
		const incoming = credentialEntryWithBlocks(entry, existingBlocks);
		if (index === -1) {
			this.#snapshot = { ...this.#snapshot, credentials: [...this.#snapshot.credentials, incoming] };
			return true;
		}
		const credentials = [...this.#snapshot.credentials];
		credentials[index] = incoming;
		this.#snapshot = { ...this.#snapshot, credentials };
		return true;
	}

	#removeProviderEntries(provider: string): void {
		const next = this.#snapshot.credentials.filter(entry => entry.provider !== provider);
		this.#snapshot = { ...this.#snapshot, credentials: next };
	}

	#removeCredentialById(id: number): void {
		const next = this.#snapshot.credentials.filter(entry => entry.id !== id);
		this.#snapshot = { ...this.#snapshot, credentials: next };
	}

	#normalizeSnapshotEntryBlocks(entry: SnapshotEntry, nowMs: number): SnapshotEntry {
		if (!entry.blocks || entry.blocks.length === 0) return entry;
		const blocks = entry.blocks
			.filter(block => block.blockedUntilMs > nowMs)
			.map(block => ({
				providerKey: block.providerKey,
				blockScope: block.blockScope,
				blockedUntilMs: block.blockedUntilMs,
				...(block.updatedAtMs !== undefined ? { updatedAtMs: block.updatedAtMs } : {}),
			}))
			.sort(compareCredentialBlockSnapshots);
		if (blocks.length > 0) return { ...entry, blocks };
		const next: SnapshotEntry = { ...entry };
		delete next.blocks;
		return next;
	}

	#upsertSnapshotBlock(block: StoredCredentialBlock): void {
		const index = this.#snapshot.credentials.findIndex(entry => entry.id === block.credentialId);
		if (index === -1) return;
		const entry = this.#snapshot.credentials[index]!;
		const incoming = toCredentialBlockSnapshot(block);
		const blocks = entry.blocks ? [...entry.blocks] : [];
		const blockIndex = blocks.findIndex(
			candidate => candidate.providerKey === incoming.providerKey && candidate.blockScope === incoming.blockScope,
		);
		if (blockIndex === -1) {
			blocks.push(incoming);
		} else {
			const existing = blocks[blockIndex]!;
			blocks[blockIndex] = {
				...existing,
				blockedUntilMs: Math.max(existing.blockedUntilMs, incoming.blockedUntilMs),
			};
		}
		blocks.sort(compareCredentialBlockSnapshots);
		const credentials = [...this.#snapshot.credentials];
		credentials[index] = { ...entry, blocks };
		this.#snapshot = { ...this.#snapshot, credentials };
	}

	#deleteSnapshotBlocks(credentialId: number): void {
		const index = this.#snapshot.credentials.findIndex(entry => entry.id === credentialId);
		if (index === -1) return;
		const entry = this.#snapshot.credentials[index]!;
		if (!entry.blocks || entry.blocks.length === 0) return;
		const next: SnapshotEntry = { ...entry };
		delete next.blocks;
		const credentials = [...this.#snapshot.credentials];
		credentials[index] = next;
		this.#snapshot = { ...this.#snapshot, credentials };
	}

	#pruneExpiredCredentialBlocks(nowMs: number): void {
		let changed = false;
		const credentials = this.#snapshot.credentials.map(entry => {
			if (!entry.blocks || entry.blocks.length === 0) return entry;
			const blocks = entry.blocks.filter(block => block.blockedUntilMs > nowMs);
			if (blocks.length === entry.blocks.length) return entry;
			changed = true;
			if (blocks.length > 0) return { ...entry, blocks };
			const next: SnapshotEntry = { ...entry };
			delete next.blocks;
			return next;
		});
		if (changed) this.#snapshot = { ...this.#snapshot, credentials };
	}

	/**
	 * Fire-and-forget `refreshSnapshot()` after a write. When the SSE stream is
	 * active the broker will deliver the new generation push, so the extra GET
	 * is wasted bandwidth and we skip it.
	 */
	#maybeRefreshSnapshot(reason: string): void {
		if (this.#streamingActive) return;
		void this.refreshSnapshot().catch(error => {
			logger.debug("auth-broker snapshot refresh after write failed", {
				reason: reason,
				error: String(error),
			});
		});
	}

	getCache(key: string): string | null {
		this.#noteActivity();
		const entry = this.#cache.get(key);
		if (!entry) return null;
		if (entry.expiresAtSec * 1000 <= Date.now()) {
			this.#cache.delete(key);
			return null;
		}
		return entry.value;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#noteActivity();
		this.#cache.set(key, { value, expiresAtSec });
	}

	/** Drop all cache rows whose keys start with the supplied prefix. */
	deleteCachePrefix(prefix: string): void {
		for (const key of this.#cache.keys()) {
			if (key.startsWith(prefix)) this.#cache.delete(key);
		}
	}

	cleanExpiredCache(): void {
		const nowSec = Math.floor(Date.now() / 1000);
		for (const [key, entry] of this.#cache) {
			if (entry.expiresAtSec <= nowSec) this.#cache.delete(key);
		}
	}

	async invalidateUsageCache(signal?: AbortSignal): Promise<void> {
		this.#noteActivity();
		this.#invalidateUsageCache();
		await this.#client.notifyUsageStale(signal).catch(err => {
			logger.warn("auth-broker notification of stale usage failed", { error: String(err) });
		});
	}

	#invalidateUsageCache(): void {
		this.#usageCache = undefined;
		this.#usageInflight = undefined;
		this.#usageCacheEpoch += 1;
	}

	/**
	 * Store-level hook consumed by `AuthStorage` — routes refresh through the
	 * broker so the actual refresh token never leaves the broker host. Returns
	 * the broker-redacted credential with {@link REMOTE_REFRESH_SENTINEL} in
	 * the `refresh` slot.
	 */
	async refreshOAuthCredential(
		_provider: Provider,
		credentialId: number,
		_credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		this.#noteActivity();
		const { entry } = await this.#client.refreshCredential(credentialId, signal);
		if (entry.credential.type !== "oauth") {
			throw new AIError.AuthBrokerError(`Broker returned non-OAuth credential for id=${credentialId}`);
		}
		if (!this.#applyCredentialEntry(entry)) {
			throw new AIError.AuthBrokerError(
				`Broker refreshed credential id=${credentialId} outside the configured account pool`,
			);
		}
		if (!this.#streamingActive) {
			await this.refreshSnapshot().catch(error => {
				logger.debug("auth-broker snapshot refresh after credential refresh failed", {
					error: String(error),
				});
			});
		}
		return {
			...entry.credential,
			refresh: REMOTE_REFRESH_SENTINEL,
		};
	}

	/**
	 * Store-level hook consumed by `AuthStorage.fetchUsageReports()` — proxies
	 * to the broker's `/v1/usage` endpoint. The broker's egress IP isn't
	 * rate-limited by Anthropic's per-IP `/usage` cap the way a heavy
	 * residential laptop is, so all credentials surface every cycle.
	 */
	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		this.#noteActivity();
		const reports = await this.#raceWithSignal(this.#loadUsageReports(), signal);
		if (!reports) return null;
		return this.#filterUsageReports(this.#applyUsageOverlays(reports));
	}

	/**
	 * Per-credential usage hook consumed by `AuthStorage.#getUsageReport`. Pulls
	 * the aggregate broker `/v1/usage` once and serves all callers from the
	 * same response (coalesced + cached), then overlays any client-observed
	 * header hints for the matching credential.
	 *
	 * The broker already aggregates with its own 30s TTL on the server side; our
	 * 15s client TTL is below that so we usually re-use the broker's cache too.
	 */
	async getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<UsageReport | null> {
		this.#noteActivity();
		const reports = await this.#raceWithSignal(this.#loadUsageReports(), signal);
		const visibleReports = reports ? this.#filterUsageReports(reports) : null;
		const matched = visibleReports ? matchUsageReport(visibleReports, provider, credential) : null;
		const overlay = this.#getActiveUsageOverlay(provider, credential);
		if (matched && overlay) return mergeUsageReports(matched, overlay);
		return overlay ?? matched;
	}

	/**
	 * Hot path — called per `getUsageReport()`/`fetchUsageReports()` (status-line
	 * refresh cadence). The oauth-credential lookup is memoized on `#snapshot`
	 * identity (every update site replaces the reference), and the filtered
	 * output on (reports identity, lookup identity) — `#loadUsageReports`
	 * serves the same array for 15s, so steady-state calls are O(1).
	 */
	#filterUsageReports(reports: UsageReport[]): UsageReport[] {
		const accountPool = this.#accountPool;
		if (!accountPool) return reports;
		let lookup = this.#usageFilterLookup;
		if (!lookup || lookup.snapshot !== this.#snapshot) {
			const byProvider = new Map<Provider, OAuthCredential[]>();
			for (const entry of this.#snapshot.credentials) {
				if (entry.credential.type !== "oauth") continue;
				const list = byProvider.get(entry.provider);
				if (list) list.push(entry.credential);
				else byProvider.set(entry.provider, [entry.credential]);
			}
			lookup = { snapshot: this.#snapshot, byProvider };
			this.#usageFilterLookup = lookup;
		}
		const memo = this.#usageFilterResult;
		if (memo && memo.input === reports && memo.byProvider === lookup.byProvider) return memo.output;
		const byProvider = lookup.byProvider;
		const output = reports.filter(report => {
			if (!accountPool.has(report.provider)) return true;
			const credentials = byProvider.get(report.provider);
			if (!credentials) return false;
			return credentials.some(credential => usageReportMatchesCredential(report, credential));
		});
		this.#usageFilterResult = { input: reports, byProvider, output };
		return output;
	}

	ingestUsageReport(provider: Provider, credential: OAuthCredential, report: UsageReport): boolean {
		this.#noteActivity();
		const key = usageOverlayKey(provider, credential);
		if (!key) return false;
		const activeOverlay = this.#getActiveUsageOverlay(provider, credential);
		this.#usageOverlays.set(key, activeOverlay ? mergeUsageReports(activeOverlay, report) : report);
		return true;
	}

	#getActiveUsageOverlay(provider: Provider, credential: OAuthCredential): UsageReport | undefined {
		const key = usageOverlayKey(provider, credential);
		if (!key) return undefined;
		const overlay = this.#usageOverlays.get(key);
		if (!overlay) return undefined;
		if (Date.now() - overlay.fetchedAt >= USAGE_CACHE_TTL_MS) {
			this.#usageOverlays.delete(key);
			return undefined;
		}
		return overlay;
	}

	#applyUsageOverlays(reports: UsageReport[]): UsageReport[] {
		const overlays = [...this.#usageOverlays.values()].filter(
			overlay => Date.now() - overlay.fetchedAt < USAGE_CACHE_TTL_MS,
		);
		if (overlays.length === 0) return reports;
		const merged = [...reports];
		for (const overlay of overlays) {
			const matchIndex = findMatchingReportIndex(merged, overlay);
			if (matchIndex === -1) {
				merged.push(overlay);
			} else {
				merged[matchIndex] = mergeUsageReports(merged[matchIndex]!, overlay);
			}
		}
		return merged;
	}

	/**
	 * Reject the awaited promise when the caller's signal aborts, without
	 * affecting the shared upstream fetch. Used to give each caller their
	 * own cancel without one caller's abort cascading into a peer's in-flight
	 * request through the single-flight `#usageInflight`.
	 */
	#raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!signal) return promise;
		if (signal.aborted) return Promise.reject(new AIError.AbortError("auth-broker request aborted"));
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => {
				signal.removeEventListener("abort", onAbort);
				reject(new AIError.AbortError("auth-broker request aborted"));
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

	#replaceBrokerUsageAccounts(entries: readonly SnapshotEntry[]): void {
		this.#brokerUsageProviderByCredentialId.clear();
		this.#brokerUsageAccountCounts.clear();
		for (const entry of entries) this.#upsertBrokerUsageAccount(entry);
	}

	#upsertBrokerUsageAccount(entry: Pick<SnapshotEntry, "id" | "provider">): void {
		const previous = this.#brokerUsageProviderByCredentialId.get(entry.id);
		if (previous === entry.provider) return;
		if (previous !== undefined) {
			const count = this.#brokerUsageAccountCounts.get(previous) ?? 0;
			if (count <= 1) this.#brokerUsageAccountCounts.delete(previous);
			else this.#brokerUsageAccountCounts.set(previous, count - 1);
		}
		this.#brokerUsageProviderByCredentialId.set(entry.id, entry.provider);
		this.#brokerUsageAccountCounts.set(entry.provider, (this.#brokerUsageAccountCounts.get(entry.provider) ?? 0) + 1);
	}

	#removeBrokerUsageAccount(id: number): void {
		const provider = this.#brokerUsageProviderByCredentialId.get(id);
		if (provider === undefined) return;
		this.#brokerUsageProviderByCredentialId.delete(id);
		const count = this.#brokerUsageAccountCounts.get(provider) ?? 0;
		if (count <= 1) this.#brokerUsageAccountCounts.delete(provider);
		else this.#brokerUsageAccountCounts.set(provider, count - 1);
	}

	#maxBrokerUsageAccounts(): number {
		let maximum = 1;
		for (const count of this.#brokerUsageAccountCounts.values()) maximum = Math.max(maximum, count);
		return maximum;
	}

	#loadUsageReports(): Promise<UsageReport[] | null> {
		const cached = this.#usageCache;
		if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
			return Promise.resolve(cached.reports);
		}
		if (this.#usageInflight) return this.#usageInflight;
		const epoch = this.#usageCacheEpoch;
		const inflight = this.#client
			.fetchUsage({ maxAccountsPerProvider: this.#maxBrokerUsageAccounts() })
			.then(body => {
				if (epoch !== this.#usageCacheEpoch) return this.#loadUsageReports();
				this.#usageCache = { reports: body.reports, fetchedAt: Date.now() };
				return body.reports;
			})
			.catch(error => {
				logger.warn("auth-broker usage fetch failed", { error: String(error) });
				// Documented 15s TTL fallback: cache the null so sequential callers
				// don't re-hit the broker while it's still down. See
				// docs/auth-broker-gateway.md § "Client-side single-flight".
				if (epoch !== this.#usageCacheEpoch) return this.#loadUsageReports();
				this.#usageCache = { reports: null, fetchedAt: Date.now() };
				return null;
			})
			.finally(() => {
				if (this.#usageInflight === inflight) this.#usageInflight = undefined;
			});
		this.#usageInflight = inflight;
		return inflight;
	}

	/**
	 * Fold locally observed request usage into the pending report and schedule
	 * a flush. One `POST /v1/usage/observed` at most per flush interval; on
	 * failure the batch is retained and retried with the next flush. A 404
	 * (pre-endpoint broker) disables reporting for the life of this store.
	 *
	 * `client` overrides the reporting identity — the auth-gateway attributes
	 * each request to the originating install/app instead of the gateway host.
	 */
	recordObservedUsage(entries: ObservedUsageEntry[], client?: ClientUsageIdentity): void {
		if (this.#closed || this.#observedUsageUnsupported) return;
		const identity = client ?? { installId: getInstallId(), hostname: os.hostname(), app: getAppName() };
		for (const entry of entries) {
			const key = `${identity.installId}\u0000${identity.app ?? ""}\u0000${entry.provider}\u0000${entry.model}`;
			const pending = this.#observedUsage.get(key);
			if (pending) {
				pending.entry.at = Math.max(pending.entry.at, entry.at);
				pending.entry.requests += entry.requests;
				pending.entry.inputTokens += entry.inputTokens;
				pending.entry.outputTokens += entry.outputTokens;
				pending.entry.cacheReadTokens += entry.cacheReadTokens;
				pending.entry.cacheWriteTokens += entry.cacheWriteTokens;
				pending.entry.costUsd += entry.costUsd;
			} else {
				this.#observedUsage.set(key, { client: identity, entry: { ...entry } });
			}
		}
		if (this.#observedUsage.size > 0 && this.#observedUsageTimer === undefined) {
			this.#observedUsageTimer = setTimeout(() => {
				this.#observedUsageTimer = undefined;
				void this.#flushObservedUsage();
			}, this.#observedUsageFlushMs);
			this.#observedUsageTimer.unref?.();
		}
	}

	async #flushObservedUsage(): Promise<void> {
		if (this.#observedUsage.size === 0 || this.#observedUsageUnsupported) return;
		const batch = [...this.#observedUsage.values()];
		this.#observedUsage.clear();
		// One report per distinct client identity — usually one (this install),
		// plus one per attributed gateway caller when running inside the gateway.
		const groups = new Map<string, { client: ClientUsageIdentity; entries: ObservedUsageEntry[] }>();
		for (const { client, entry } of batch) {
			const key = `${client.installId}\u0000${client.app ?? ""}`;
			const group = groups.get(key);
			if (group) group.entries.push(entry);
			else groups.set(key, { client, entries: [entry] });
		}
		for (const { client, entries } of groups.values()) {
			try {
				await this.#client.reportClientUsage({
					installId: client.installId,
					hostname: client.hostname,
					app: client.app,
					entries,
				});
			} catch (error) {
				const status = error instanceof AuthBrokerError ? error.status : undefined;
				if (status === 400 || status === 404 || status === 501) {
					// Broker predates the endpoint or its request schema (or the store
					// can't persist) — stop trying for the life of this process.
					this.#observedUsageUnsupported = true;
					logger.debug("auth-broker does not accept observed usage; reporting disabled", { status });
					return;
				}
				logger.debug("auth-broker observed usage flush failed; retrying next flush", {
					error: String(error),
				});
				// Merge the failed group back under the (possibly refilled) buffer so
				// nothing is lost; bounded because entries are keyed per
				// (identity, provider, model).
				if (!this.#closed) this.recordObservedUsage(entries, client);
			}
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#credentialDisabledListeners.clear();
		this.#pendingCredentialRemovals.clear();
		this.#scheduleCredentialRemovalRetry();
		this.#backgroundAbort.abort();
		this.#activityWakeup?.resolve();
		this.#activityWakeup = null;
		if (this.#observedUsageTimer !== undefined) {
			clearTimeout(this.#observedUsageTimer);
			this.#observedUsageTimer = undefined;
		}
		// Best-effort final flush; failures are dropped (the process is exiting).
		if (this.#observedUsage.size > 0) void this.#flushObservedUsage();
		this.#cache.clear();
		this.#usageOverlays.clear();
	}
}

/**
 * Match a broker-supplied usage report to a specific OAuth credential. The
 * broker returns aggregate reports across all credentials it manages, so we
 * pick the one whose identity (accountId / email / projectId) lines up with
 * the credential the caller is asking about.
 *
 * Falls back to the lone candidate when only one matches the provider; falls
 * through to `null` when nothing matches, which `AuthStorage` treats as "no
 * usage data" (ranking proceeds without a usage signal for this credential).
 */
function matchUsageReport(reports: UsageReport[], provider: Provider, credential: OAuthCredential): UsageReport | null {
	const all = reports.filter(report => report.provider === provider);
	if (all.length === 0) return null;
	// Org precedence, decisive on EITHER side: an org-scoped credential may
	// only take its own org's report, and an org-less (legacy) credential may
	// only take org-less reports — the shared email/account would otherwise
	// hand one subscription the OTHER subscription's pool (e.g. mark healthy
	// Max exhausted via Team's report, or rank a legacy row on a sibling's
	// numbers).
	const orgId = credential.orgId?.trim().toLowerCase();
	const accountId = credential.accountId?.trim().toLowerCase();
	const email = credential.email?.trim().toLowerCase();
	const projectId = credential.projectId?.trim().toLowerCase();
	if (orgId) {
		const sameOrg: UsageReport[] = [];
		let sawReportOrg = false;
		for (const report of all) {
			const metaOrg = readMetadataString((report.metadata ?? {}) as Record<string, unknown>, "orgId");
			if (metaOrg) {
				sawReportOrg = true;
				if (metaOrg.toLowerCase() === orgId) sameOrg.push(report);
			}
		}
		// Org-attributed reports exist: the shared org is a GATE, not a match.
		// Two Team members share the org id while drawing on per-user pools,
		// so the credential's own base identity must still line up inside the
		// same-org subset — a lone sibling report is NOT ours. An org-only
		// credential (no base identifiers) takes the lone same-org report and
		// treats several as ambiguous. None in our org → "no usage data"
		// rather than mis-attributing another org's pool.
		if (sawReportOrg) {
			if (accountId || email || projectId) {
				for (const report of sameOrg) {
					if (reportMatchesIdentity(report, accountId, email, projectId)) return report;
				}
				return null;
			}
			return sameOrg.length === 1 ? sameOrg[0]! : null;
		}
		// No surviving report carries an org at all: presence mismatch is a
		// non-match too — the sole org-less report may be a legacy sibling
		// row's pool, and handing it to a scoped credential would rank/block
		// on the wrong quota. "No usage data" degrades gracefully instead.
		return null;
	}
	const candidates = all.filter(
		report => !readMetadataString((report.metadata ?? {}) as Record<string, unknown>, "orgId"),
	);
	if (candidates.length === 0) return null;
	if (all.length === 1 && candidates.length === 1) return candidates[0];
	for (const report of candidates) {
		if (reportMatchesIdentity(report, accountId, email, projectId)) return report;
	}
	return null;
}

function usageReportMatchesCredential(report: UsageReport, credential: OAuthCredential): boolean {
	const metadata = (report.metadata ?? {}) as Record<string, unknown>;
	const credentialOrg = credential.orgId?.trim().toLowerCase();
	const reportOrg = readMetadataString(metadata, "orgId")?.toLowerCase();
	if (credentialOrg !== reportOrg) return false;

	const accountId = credential.accountId?.trim().toLowerCase();
	const email = credential.email?.trim().toLowerCase();
	const projectId = credential.projectId?.trim().toLowerCase();
	if (accountId || email || projectId) {
		return reportMatchesIdentity(report, accountId, email, projectId);
	}
	return credentialOrg !== undefined;
}

function findMatchingReportIndex(reports: UsageReport[], overlay: UsageReport): number {
	const all = reports
		.map((report, index) => ({ report, index }))
		.filter(candidate => candidate.report.provider === overlay.provider);
	if (all.length === 0) return -1;
	const metadata = (overlay.metadata ?? {}) as Record<string, unknown>;
	// Org precedence — mirror matchUsageReport: an org-attributed overlay may
	// only merge into a report of the SAME org, and an org-less overlay may
	// only merge into an org-less report. Within the same org the overlay's
	// base identity must still match — two Team members' reports share the
	// org id but must not swallow each other's header ingests.
	const overlayOrg = readMetadataString(metadata, "orgId")?.toLowerCase();
	const accountId = readMetadataString(metadata, "accountId")?.toLowerCase();
	const email = readMetadataString(metadata, "email")?.toLowerCase();
	const projectId = readMetadataString(metadata, "projectId")?.toLowerCase();
	if (overlayOrg) {
		const sameOrg: { report: UsageReport; index: number }[] = [];
		let sawReportOrg = false;
		for (const candidate of all) {
			const candidateOrg = readMetadataString((candidate.report.metadata ?? {}) as Record<string, unknown>, "orgId");
			if (candidateOrg) {
				sawReportOrg = true;
				if (candidateOrg.toLowerCase() === overlayOrg) sameOrg.push(candidate);
			}
		}
		if (sawReportOrg) {
			if (accountId || email || projectId) {
				for (const candidate of sameOrg) {
					if (reportMatchesIdentity(candidate.report, accountId, email, projectId)) return candidate.index;
				}
				return -1;
			}
			return sameOrg.length === 1 ? sameOrg[0]!.index : -1;
		}
		// Presence mismatch — mirror matchUsageReport: an org-scoped overlay
		// never merges into an org-less report; it becomes its own report row.
		return -1;
	}
	const candidates = all.filter(
		candidate => !readMetadataString((candidate.report.metadata ?? {}) as Record<string, unknown>, "orgId"),
	);
	if (candidates.length === 0) return -1;
	if (all.length === 1 && candidates.length === 1) return candidates[0]!.index;
	for (const candidate of candidates) {
		if (reportMatchesIdentity(candidate.report, accountId, email, projectId)) return candidate.index;
	}
	return -1;
}

function reportMatchesIdentity(
	report: UsageReport,
	accountId: string | undefined,
	email: string | undefined,
	projectId: string | undefined,
): boolean {
	const metadata = (report.metadata ?? {}) as Record<string, unknown>;
	if (accountId) {
		const metaAccount = readMetadataString(metadata, "accountId") ?? readMetadataString(metadata, "account_id");
		if (metaAccount && metaAccount.toLowerCase() === accountId) return true;
		for (const limit of report.limits) {
			if (limit.scope.accountId?.toLowerCase() === accountId) return true;
		}
	}
	if (email) {
		const metaEmail = readMetadataString(metadata, "email");
		if (metaEmail && metaEmail.toLowerCase() === email) return true;
	}
	if (projectId) {
		const metaProject = readMetadataString(metadata, "projectId") ?? readMetadataString(metadata, "project_id");
		if (metaProject && metaProject.toLowerCase() === projectId) return true;
		for (const limit of report.limits) {
			if (limit.scope.projectId?.toLowerCase() === projectId) return true;
		}
	}
	return false;
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
	const value = metadata[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
