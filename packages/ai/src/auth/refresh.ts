import { scheduler } from "node:timers/promises";
import { isSqliteBusyError, logger, postmortem } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getOAuthProvider, normalizeOAuthCredentialExpiry, refreshOAuthToken } from "../registry/oauth";
import type { OAuthCredentials, OAuthProvider } from "../registry/oauth/types";
import type { Provider } from "../types";
import { raceSignal } from "./abort";
import { authCredentialEquals, type CredentialPool, credentialDisabledEvent } from "./pool";
import { resolveCredentialIdentityKey, serializeCredential } from "./sqlite-credential-store";
import {
	type AuthCredentialStore,
	type CredentialRefreshLeaseHolder,
	type CredentialRefreshLeaseStore,
	hasRefreshLeases,
} from "./store";
import {
	REMOTE_REFRESH_SENTINEL,
	type AuthCredentialSnapshotEntry,
	type AuthStorageOptions,
	type OAuthCredential,
	type OAuthRefreshByIdOptions,
	type OAuthRefreshReason,
	type StoredAuthCredential,
	type StoredOAuthRefreshOptions,
	type StoredOAuthRefreshResult,
} from "./types";

/**
 * Refresh OAuth access tokens this many ms before their stated expiry. The
 * skew exists so callers downstream of {@link OAuthRefresher} (stream providers,
 * usage probes, web_search) never observe a credential that is expired or
 * about to expire mid-request — there's a single rotation point and everyone
 * downstream trusts the token they receive.
 *
 * Set to 60s: comfortably absorbs request RTT + a clock-skew window without
 * triggering a refresh on every request. Provider token endpoints typically
 * mint access tokens with 30-60min lifetimes, so refreshing 60s early changes
 * the rotation cadence by <4%.
 */
export const OAUTH_REFRESH_SKEW_MS = 60_000;
/**
 * How long auth recovery may reuse a token minted moments ago — by this
 * refresher or, through the shared store, by another process.
 * Re-minting a token that a provider rejected moments ago only rotates the
 * refresh token, revokes the access token every peer holds, and churns broker
 * snapshots during provider-wide outages.
 */
const OAUTH_REMINT_COOLDOWN_MS = 5 * 60_000;
const OAUTH_REFRESH_LEASE_TTL_MS = 15_000;
const OAUTH_REFRESH_LEASE_POLL_MS = 50;
const OAUTH_REFRESH_LEASE_WAIT_MAX_MS = 250;
const OAUTH_REFRESH_LEASE_RENEW_MS = 5_000;
/** How long a caller waits for an OAuth token exchange before giving up. */
const OAUTH_REFRESH_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;
/**
 * Hard ceiling on one leased token exchange. Callers stop waiting after the
 * refresh budget, but the exchange itself runs on so a refresh token the
 * provider already rotated server-side is still persisted; this bounds how
 * long a hung exchange can hold the row lease. One minute covers a slow grant
 * plus post-exchange hooks (whoami/org lookups) several times over, while
 * peers waiting on the lease still recover within a minute.
 */
const OAUTH_REFRESH_EXCHANGE_BACKSTOP_MS = 60_000;
/**
 * How long a refresher keeps retrying a busy store to save a token it already
 * exchanged. The provider has consumed the old refresh token by then, so
 * giving up loses the login for every process sharing the store.
 */
const OAUTH_REFRESH_PERSIST_TIMEOUT_MS = 60_000;
const OAUTH_REFRESH_PERSIST_RETRY_MAX_MS = 1_000;
/**
 * How long after another refresher's lease lapsed that refresher may still be
 * saving a token it exchanged: its exchange backstop plus its save window.
 */
const OAUTH_REFRESH_STALLED_OWNER_MS = OAUTH_REFRESH_EXCHANGE_BACKSTOP_MS + OAUTH_REFRESH_PERSIST_TIMEOUT_MS;
/**
 * How long process exit waits for refreshes still in flight: an exchange up to
 * its backstop, then the save window, plus slack for the last save attempt. A
 * shorter wait drops a token the provider already rotated, which leaves the
 * shared store with a spent refresh token.
 */
const OAUTH_REFRESH_SHUTDOWN_WAIT_MS = OAUTH_REFRESH_STALLED_OWNER_MS + 5_000;

/** Short non-secret fingerprint so logs can tell which process minted which token. */
function tokenFingerprint(token: unknown): string {
	if (typeof token !== "string" || token.length === 0) return "none";
	return new Bun.CryptoHasher("sha256").update(token).digest("hex").slice(0, 8);
}

type LeasedExchangeOutcome<T extends OAuthCredential> = { result: StoredOAuthRefreshResult<T> } | { failure: unknown };

type OrganizationScope = Pick<
	OAuthCredentials,
	"orgId" | "region" | "inferenceRegion" | "activeOrganizationId" | "orgName"
>;

/**
 * Organization-scoped identity after a refresh: refreshed values win; stored
 * org/residency/inference scope carries over only while the organization is
 * unchanged. The WorkOS selection always falls back to the stored one.
 */
export function mergeRefreshedOrganizationScope(
	current: OrganizationScope,
	refreshed: OrganizationScope,
): OrganizationScope {
	const sameOrg =
		(refreshed.orgId === undefined || refreshed.orgId === current.orgId) &&
		(refreshed.activeOrganizationId === undefined || refreshed.activeOrganizationId === current.activeOrganizationId);
	return {
		orgId: refreshed.orgId ?? (sameOrg ? current.orgId : undefined),
		region: refreshed.region ?? (sameOrg ? current.region : undefined),
		inferenceRegion: refreshed.inferenceRegion ?? (sameOrg ? current.inferenceRegion : undefined),
		activeOrganizationId: refreshed.activeOrganizationId ?? current.activeOrganizationId,
		orgName: refreshed.orgName ?? (sameOrg ? current.orgName : undefined),
	};
}

/** Merge provider refresh bytes with the stored OAuth row, preserving subtype metadata for every refresh path. */
export function mergeRefreshedCredential<T extends OAuthCredential>(current: T, refreshed: OAuthCredentials): T {
	return {
		...current,
		access: refreshed.access,
		refresh: refreshed.refresh,
		expires: refreshed.expires,
		accountId: refreshed.accountId ?? current.accountId,
		email: refreshed.email ?? current.email,
		projectId: refreshed.projectId ?? current.projectId,
		enterpriseUrl: refreshed.enterpriseUrl ?? current.enterpriseUrl,
		apiEndpoint: refreshed.apiEndpoint ?? current.apiEndpoint,
		...mergeRefreshedOrganizationScope(current, refreshed),
		authorizedAt: refreshed.authorizedAt ?? current.authorizedAt,
	};
}

/** Dependencies for lease-guarded OAuth refresh. */
export interface OAuthRefresherDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	override?: AuthStorageOptions["refreshOAuthCredential"];
	overrideMints?: AuthStorageOptions["refreshOAuthCredentialMints"];
}

/** Single-flighted, lease-guarded OAuth refresh with compare-and-set persistence. */
export class OAuthRefresher {
	readonly #deps: OAuthRefresherDeps;
	#oauthRefreshInFlight: Map<number, Promise<AuthCredentialSnapshotEntry>> = new Map();
	#oauthCredentialRefreshInFlight: Map<number, Promise<OAuthCredentials>> = new Map();
	/** Access token this process last minted per credential id. */
	#recentMints = new Map<number, { provider: string; access: string; at: number }>();
	/**
	 * Refresh tokens rejected after taking over a stalled refresher's lease, per
	 * credential id: that refresher may still save their successor until `until`.
	 */
	#stalledRefreshes = new Map<number, { refresh: string; until: number }>();
	#pendingRefreshes = new Set<Promise<unknown>>();
	#cancelRefreshCleanup?: () => void;
	#shuttingDown = false;

	constructor(deps: OAuthRefresherDeps) {
		this.#deps = deps;
	}

	/**
	 * Return the stored row while it still holds a usable token this refresher
	 * minted within {@link OAUTH_REMINT_COOLDOWN_MS}.
	 */
	#recentMint(id: number): { provider: string; credential: OAuthCredential } | undefined {
		const mint = this.#recentMints.get(id);
		if (!mint) return undefined;
		const now = Date.now();
		if (now - mint.at >= OAUTH_REMINT_COOLDOWN_MS) {
			this.#recentMints.delete(id);
			return undefined;
		}
		const credential = this.#deps.pool.entries(mint.provider).find(entry => entry.id === id)?.credential;
		if (
			credential?.type !== "oauth" ||
			credential.access !== mint.access ||
			credential.expires <= now + OAUTH_REFRESH_SKEW_MS
		) {
			this.#recentMints.delete(id);
			return undefined;
		}
		return { provider: mint.provider, credential };
	}

	#rememberMint(provider: string, id: number, credential: OAuthCredentials): void {
		const now = Date.now();
		for (const [cachedId, mint] of this.#recentMints) {
			if (now - mint.at >= OAUTH_REMINT_COOLDOWN_MS) this.#recentMints.delete(cachedId);
		}
		this.#recentMints.set(id, { provider, access: credential.access, at: now });
	}

	/** Whether refreshes run the provider token exchange in this process rather than delegating it. */
	#mintsLocally(): boolean {
		return this.#deps.override
			? this.#deps.overrideMints === true
			: this.#deps.store.refreshOAuthCredential === undefined;
	}

	/**
	 * Whether the stored row holds a token the caller has not seen rejected, so
	 * it adopts that token instead of exchanging again. A forced refresh
	 * compares tokens only (callers pass an `expires: 0` copy), and compares
	 * against the access token a provider 401 rejected when the caller names
	 * it: this process may already hold the row a peer rotated, while the token
	 * that got the 401 is the one before it. Callers name the credential's own
	 * access token, never the API key built from it, which a provider with a
	 * structured key format makes a different string.
	 */
	#storedIsNewer<T extends OAuthCredential>(current: T, options: StoredOAuthRefreshOptions<T>): boolean {
		if (options.rejectedAccess !== undefined) return current.access !== options.rejectedAccess;
		const observed = options.observedCredential;
		if (!observed) return false;
		return options.forceRefresh
			? current.access !== observed.access || current.refresh !== observed.refresh
			: !authCredentialEquals(current, observed);
	}

	/**
	 * Hand a taken-over lease back to the refresher that stalled holding it. A busy
	 * store is retried within the save window: if this process released the lease
	 * instead, the next refresher would find no owner and disable a login that
	 * owner may still save. Returns false when the hand-back never landed; the
	 * caller then keeps its own lease to expire, which still names a recent owner.
	 */
	async #handBackLease(
		leaseStore: CredentialRefreshLeaseStore,
		credentialId: number,
		owner: string,
		holder: CredentialRefreshLeaseHolder,
	): Promise<boolean> {
		const deadline = Date.now() + OAUTH_REFRESH_PERSIST_TIMEOUT_MS;
		for (let attempt = 0; ; attempt++) {
			try {
				return leaseStore.handBackCredentialRefreshLease?.(credentialId, owner, holder) ?? false;
			} catch (error) {
				if (!isSqliteBusyError(error)) throw error;
				if (Date.now() >= deadline) return false;
			}
			await Bun.sleep(Math.min(OAUTH_REFRESH_PERSIST_RETRY_MAX_MS, OAUTH_REFRESH_LEASE_POLL_MS * 2 ** attempt));
		}
	}

	/**
	 * Give up a lease this refresher holds without having saved a token. A lease
	 * taken over from a stalled refresher goes back to it, because that refresher
	 * may still be saving: releasing it would leave the next refresher no owner,
	 * and it would disable a login that may live. Any other lease is released.
	 */
	async #leaveLease(
		leaseStore: CredentialRefreshLeaseStore,
		credentialId: number,
		owner: string,
		takenOverFrom: CredentialRefreshLeaseHolder | undefined,
	): Promise<void> {
		if (!takenOverFrom) {
			leaseStore.releaseCredentialRefreshLease(credentialId, owner);
			return;
		}
		try {
			await this.#handBackLease(leaseStore, credentialId, owner, takenOverFrom);
		} catch (error) {
			// The lease then expires still naming this refresher, a recent holder.
			logger.warn("OAuth refresh could not hand a taken-over lease back", { credentialId, error: String(error) });
		}
	}

	/**
	 * Save a token this process already exchanged. The provider consumed the old
	 * refresh token, so a busy store is retried (re-arming the lease each time:
	 * a blocked event loop can outlive its TTL, and an expired lease no peer
	 * took is still ours) instead of dropping the only valid token. A refused
	 * save is retried too, within the same 60 s window, while the row still
	 * holds the spent token: a peer that took over the lapsed lease hands it
	 * back once the provider rejects that token, but the next peer can hold it
	 * at the moment this save lands.
	 */
	async #persistExchangedCredential(
		provider: string,
		credentialId: number,
		expectedData: string,
		credential: OAuthCredential,
		lease: { store: CredentialRefreshLeaseStore; owner: string } | undefined,
		fingerprints: Record<string, unknown>,
	): Promise<boolean> {
		const deadline = Date.now() + OAUTH_REFRESH_PERSIST_TIMEOUT_MS;
		let refused = false;
		for (let attempt = 0; ; attempt++) {
			if (attempt > 0 && Date.now() >= deadline) {
				if (refused) {
					logger.warn("OAuth exchanged token not saved before the save deadline", fingerprints);
					return false;
				}
				throw new AIError.ConfigurationError("OAuth exchanged token could not be saved: store stayed busy");
			}
			let renewed = true;
			try {
				if (lease) {
					renewed = lease.store.renewCredentialRefreshLease(
						credentialId,
						lease.owner,
						Date.now() + OAUTH_REFRESH_LEASE_TTL_MS,
					);
					// An expired lease no peer took is still ours: re-acquire it rather
					// than fail the fence and drop a token the provider already minted.
					if (!renewed) {
						renewed = lease.store.tryAcquireCredentialRefreshLease(
							credentialId,
							lease.owner,
							Date.now() + OAUTH_REFRESH_LEASE_TTL_MS,
						);
					}
				}
				const saved =
					this.#deps.store.tryUpdateAuthCredentialIfMatches?.(
						credentialId,
						expectedData,
						credential,
						lease ? { owner: lease.owner, nowMs: Date.now() } : undefined,
					) ?? false;
				if (saved) return true;
				// A peer that saved first changed the row; otherwise no peer can hold a
				// usable successor of the spent token, so wait for the lease instead.
				const stored = this.#deps.store.listAuthCredentials(provider).find(entry => entry.id === credentialId);
				if (!stored || serializeCredential(provider, stored.credential)?.data !== expectedData) {
					logger.warn("OAuth exchanged token not saved", { ...fingerprints, leaseHeld: renewed });
					return false;
				}
				if (!refused) {
					logger.warn("OAuth exchanged token save refused while a peer holds the lease; retrying", {
						...fingerprints,
						leaseHeld: renewed,
					});
				}
				refused = true;
			} catch (error) {
				if (!isSqliteBusyError(error)) {
					logger.error("OAuth exchanged token could not be saved", { ...fingerprints, error: String(error) });
					throw error;
				}
				refused = false;
				logger.warn("OAuth exchanged token save hit a busy store; retrying", { ...fingerprints, attempt });
			}
			await Bun.sleep(Math.min(OAUTH_REFRESH_PERSIST_RETRY_MAX_MS, OAUTH_REFRESH_LEASE_POLL_MS * 2 ** attempt));
		}
	}

	/**
	 * Refresh one stored OAuth credential under durable row ownership.
	 */
	refreshStored<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>> {
		if (this.#shuttingDown) return Promise.reject(new AIError.AbortError("OAuth refresh stopped during shutdown"));
		return this.#track(this.#refreshStored(provider, options));
	}

	/** Keeps shutdown waiting until `pending` settles, so rotated tokens are persisted before exit. */
	#track<R>(pending: Promise<R>): Promise<R> {
		// Add before registering: a registration made while exit cleanup runs drains at
		// once, and must find this work pending or the process exits without it.
		this.#pendingRefreshes.add(pending);
		this.#armShutdownDrain();
		const settled = () => {
			this.#pendingRefreshes.delete(pending);
			if (this.#pendingRefreshes.size === 0 && !this.#shuttingDown) {
				this.#cancelRefreshCleanup?.();
				this.#cancelRefreshCleanup = undefined;
			}
		};
		void pending.then(settled, settled);
		return pending;
	}

	/**
	 * Registers the shutdown drain if it is not registered yet. A registration made
	 * once exit has begun drains at once, which sets `#shuttingDown`.
	 */
	#armShutdownDrain(): void {
		this.#cancelRefreshCleanup ??= postmortem.register("oauth-refresh", () => this.#drainRefreshes(), {
			exitOnly: true,
			deadlineMs: OAUTH_REFRESH_SHUTDOWN_WAIT_MS,
			// A quit that waits in silence looks hung, and killing it loses the token anyway.
			waitMessage: "Waiting for the login refresh to finish saving",
		});
	}

	async #drainRefreshes(): Promise<void> {
		this.#shuttingDown = true;
		// Work tracked while draining (a lease hand-back a returning caller left behind) is waited for too.
		while (this.#pendingRefreshes.size > 0) await Promise.allSettled(this.#pendingRefreshes);
	}

	async #refreshStored<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>> {
		const refreshSkewMs = options.refreshSkewMs ?? OAUTH_REFRESH_SKEW_MS;
		const leaseStore = hasRefreshLeases(this.#deps.store) ? this.#deps.store : undefined;
		const owner = crypto.randomUUID();
		let leasedCredentialId: number | undefined;
		let takenOverFrom: CredentialRefreshLeaseHolder | undefined;
		const budgetMs = options.refreshTimeoutMs ?? OAUTH_REFRESH_OPERATION_TIMEOUT_MS;
		// Waiting on a peer's lease counts against the same budget as the exchange.
		const waitDeadline = Date.now() + budgetMs;

		while (leaseStore) {
			if (this.#shuttingDown) throw new AIError.AbortError("OAuth refresh stopped during shutdown");
			if (options.signal?.aborted) throw new AIError.AbortError("OAuth refresh ownership aborted by caller");
			const rows = this.#deps.store.listAuthCredentials(provider);
			this.#deps.pool.replace(
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
			if (currentIsFresh && this.#storedIsNewer(current, options)) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (!options.forceRefresh && currentIsFresh) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (options.canRefresh && !options.canRefresh(current)) {
				return { credential: current, refreshed: false, removed: false };
			}
			// A caller whose budget ran out must not start an exchange it will not wait for.
			if (Date.now() >= waitDeadline) return this.#budgetExceeded(provider, options, current);
			// This process already had this refresh token rejected after taking over
			// a stalled refresher, which may still save its successor: wait for that
			// save instead of replaying the token at the provider.
			const stalled = this.#stalledRefreshes.get(row.id);
			if (stalled) {
				const stalledMs = stalled.until - Date.now();
				if (stalled.refresh === current.refresh && stalledMs > 0) {
					await raceSignal(
						Bun.sleep(Math.min(stalledMs, waitDeadline - Date.now(), OAUTH_REFRESH_LEASE_WAIT_MAX_MS)),
						options.signal,
						"OAuth refresh wait for a stalled refresher aborted by caller",
					);
					continue;
				}
				this.#stalledRefreshes.delete(row.id);
			}
			// A lease row still naming another owner means that owner stalled or died
			// holding it. It may have spent the stored refresh token already and still
			// be retrying the save of its successor, so remember it: a rejection of
			// that token is then not proof the login is dead.
			const priorHolder = leaseStore.getCredentialRefreshLeaseHolder?.(row.id);
			if (leaseStore.tryAcquireCredentialRefreshLease(row.id, owner, Date.now() + OAUTH_REFRESH_LEASE_TTL_MS)) {
				leasedCredentialId = row.id;
				if (
					priorHolder &&
					priorHolder.owner !== owner &&
					Date.now() - priorHolder.expiresAtMs < OAUTH_REFRESH_STALLED_OWNER_MS
				) {
					takenOverFrom = priorHolder;
				}
				break;
			}
			const leaseExpiresAt = leaseStore.getCredentialRefreshLeaseExpiresAt(row.id);
			const waitMs =
				leaseExpiresAt === undefined
					? OAUTH_REFRESH_LEASE_POLL_MS
					: Math.min(
							Math.max(leaseExpiresAt - Date.now(), OAUTH_REFRESH_LEASE_POLL_MS),
							OAUTH_REFRESH_LEASE_WAIT_MAX_MS,
						);
			const remainingMs = waitDeadline - Date.now();
			if (remainingMs <= 0) return this.#budgetExceeded(provider, options, current);
			await raceSignal(
				Bun.sleep(Math.min(waitMs, remainingMs)),
				options.signal,
				"OAuth refresh ownership wait aborted by caller",
			);
		}

		try {
			const rows = this.#deps.store.listAuthCredentials(provider);
			this.#deps.pool.replace(
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
			// Re-check after acquiring the lease: a peer that held it may have just
			// rotated the row, mirroring the pre-lease guard.
			if (currentIsFresh && this.#storedIsNewer(current, options)) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (!options.forceRefresh && currentIsFresh) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (options.canRefresh && !options.canRefresh(current)) {
				return { credential: current, refreshed: false, removed: false };
			}
			// Arm the drain first: once exit has begun, arming it sets `#shuttingDown`, so a
			// refresh that starts then stops here instead of spending a token nobody saves.
			this.#armShutdownDrain();
			if (this.#shuttingDown || options.signal?.aborted) {
				throw new AIError.AbortError("OAuth refresh stopped before token exchange");
			}
			const serialized = serializeCredential(provider, current);
			if (!serialized) return { credential: current, refreshed: false, removed: false };
			// Acquiring the lease can block on SQLite past the deadline; do not start an exchange nobody waits for.
			if (Date.now() >= waitDeadline) return this.#budgetExceeded(provider, options, current);

			// The budget only stops this caller waiting. The exchange keeps the lease
			// and persists whatever the provider returns: a provider that rotates the
			// refresh token on every grant has already invalidated the stored one.
			const exchange = this.#track(
				this.#exchangeLeased(
					provider,
					options,
					row,
					current,
					serialized.data,
					leaseStore,
					leasedCredentialId,
					owner,
					takenOverFrom,
				),
			);
			// Lease release now belongs to the exchange.
			leasedCredentialId = undefined;
			const budget = Promise.withResolvers<"timeout">();
			const budgetTimer = setTimeout(() => budget.resolve("timeout"), Math.max(waitDeadline - Date.now(), 0));
			let outcome: LeasedExchangeOutcome<T> | "timeout";
			try {
				outcome = await Promise.race([exchange, budget.promise]);
			} finally {
				clearTimeout(budgetTimer);
			}
			if (outcome === "timeout") return this.#budgetExceeded(provider, options, current);
			if ("result" in outcome) return outcome.result;
			return this.#refreshFailed(options, current, outcome.failure);
		} finally {
			if (leasedCredentialId !== undefined && leaseStore) {
				// A hand-back retries a busy store for the save window; the caller, which is
				// leaving with its budget spent or its signal aborted, does not wait for it.
				void this.#track(this.#leaveLease(leaseStore, leasedCredentialId, owner, takenOverFrom));
			}
		}
	}

	/** The caller's budget ran out: report the timeout through the caller's failure policy. */
	#budgetExceeded<T extends OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
		current: T,
	): StoredOAuthRefreshResult<T> {
		const error = new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
			kind: "timeout",
			provider,
		});
		return this.#refreshFailed(options, current, error);
	}

	#refreshFailed<T extends OAuthCredential>(
		options: StoredOAuthRefreshOptions<T>,
		current: T,
		error: unknown,
	): StoredOAuthRefreshResult<T> {
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

	/**
	 * Runs one token exchange under the row lease and persists the rotated
	 * credential by CAS, then releases the lease. An exchange error that does not
	 * disable the login resolves as `failure` so the waiting caller applies its
	 * failure policy.
	 */
	async #exchangeLeased<T extends OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
		row: StoredAuthCredential,
		current: T,
		serializedData: string,
		leaseStore: CredentialRefreshLeaseStore | undefined,
		leasedCredentialId: number | undefined,
		owner: string,
		takenOverFrom: CredentialRefreshLeaseHolder | undefined,
	): Promise<LeasedExchangeOutcome<T>> {
		let keepLease = false;
		let saved = false;
		try {
			const leaseRenewalStop = new AbortController();
			let leaseRenewalError: unknown;
			const leaseRenewal =
				leasedCredentialId !== undefined && leaseStore
					? (async () => {
							// Renew every interval; after a busy store, retry almost at once,
							// since another full interval would outlive the lease.
							let delayMs = OAUTH_REFRESH_LEASE_RENEW_MS;
							while (!leaseRenewalStop.signal.aborted) {
								// Stopping cancels the wait, so a finished exchange leaves no renewal
								// timer behind to hold the process open for up to an interval.
								await scheduler.wait(delayMs, { signal: leaseRenewalStop.signal }).catch(() => undefined);
								if (leaseRenewalStop.signal.aborted) return;
								let renewed: boolean;
								try {
									renewed = leaseStore.renewCredentialRefreshLease(
										leasedCredentialId,
										owner,
										Date.now() + OAUTH_REFRESH_LEASE_TTL_MS,
									);
									// An expired lease no peer took is still ours.
									if (!renewed) {
										renewed = leaseStore.tryAcquireCredentialRefreshLease(
											leasedCredentialId,
											owner,
											Date.now() + OAUTH_REFRESH_LEASE_TTL_MS,
										);
									}
								} catch (error) {
									// A busy store only delays this renewal; ownership is lost
									// only once another owner holds the lease row.
									if (!isSqliteBusyError(error)) throw error;
									delayMs = OAUTH_REFRESH_LEASE_POLL_MS;
									continue;
								}
								delayMs = OAUTH_REFRESH_LEASE_RENEW_MS;
								if (!renewed) {
									throw new AIError.ConfigurationError("OAuth refresh ownership was lost before persistence");
								}
							}
						})().catch(error => {
							leaseRenewalError = error;
						})
					: undefined;
			const refreshAbort = new AbortController();
			const backstopReached = Promise.withResolvers<never>();
			const backstop = setTimeout(
				() => {
					const error = new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					});
					refreshAbort.abort(error);
					// Stop waiting even when the refresh ignores its signal, so the lease is released.
					backstopReached.reject(error);
				},
				// A fixed ceiling, whatever the caller's budget: a peer that takes over a
				// lapsed lease, and shutdown, both assume no exchange runs longer.
				OAUTH_REFRESH_EXCHANGE_BACKSTOP_MS,
			);

			let refreshed: OAuthCredentials;
			try {
				refreshed = await Promise.race([options.refresh(current, refreshAbort.signal), backstopReached.promise]);
			} catch (error) {
				if (!options.isDefinitiveFailure?.(error)) return { failure: error };
				if (takenOverFrom && leaseStore && leasedCredentialId !== undefined) {
					// The owner whose lease lapsed may have spent this token and still be
					// saving its successor. Give the lease back so it can, and fail this
					// refresh as transient instead of disabling a login that may live.
					this.#stalledRefreshes.set(row.id, {
						refresh: current.refresh,
						until: takenOverFrom.expiresAtMs + OAUTH_REFRESH_STALLED_OWNER_MS,
					});
					// Stop renewing first: a renewal after the hand-back would take it back.
					leaseRenewalStop.abort();
					await leaseRenewal;
					// Never release this lease afterwards: a hand-back that landed left
					// nothing to release, and one that did not must leave a recent owner.
					keepLease = true;
					const handedBack = await this.#handBackLease(leaseStore, leasedCredentialId, owner, takenOverFrom).catch(
						(error: unknown) => {
							// The lease then expires still naming this refresher, a recent holder.
							logger.warn("OAuth refresh could not hand a taken-over lease back", {
								credentialId: row.id,
								error: String(error),
							});
							return false;
						},
					);
					logger.warn("OAuth refresh token rejected after taking over a stalled refresher; not disabling", {
						provider,
						credentialId: row.id,
						spentRefresh: tokenFingerprint(current.refresh),
						handedBack,
					});
					// A transient failure, so the caller's failure policy applies to it.
					return {
						failure: new AIError.OAuthError(
							`OAuth refresh for ${provider} waits for a stalled refresher that may still save its token`,
							{ kind: "token-refresh", provider },
						),
					};
				}
				const disabledCause = options.disabledCause?.(error) ?? `oauth refresh failed: ${String(error)}`;
				const disabled = this.#deps.store.tryDisableAuthCredentialIfMatches(
					row.id,
					serializedData,
					disabledCause,
					leasedCredentialId !== undefined ? { owner, nowMs: Date.now() } : undefined,
				);
				if (disabled) {
					// Re-read: siblings may have been removed while the exchange ran.
					this.#deps.pool.replace(
						provider,
						this.#deps.store
							.listAuthCredentials(provider)
							.filter(entry => entry.id !== row.id)
							.map(entry => ({ id: entry.id, credential: entry.credential })),
					);
					this.#deps.pool.reset(provider);
					this.#deps.pool.emitDisabled(credentialDisabledEvent(provider, row, disabledCause));
					return { result: { credential: undefined, refreshed: false, removed: true } };
				}
				await this.#deps.pool.reload();
				const latest = this.#deps.pool.entries(provider).find(entry => entry.id === row.id)?.credential;
				return {
					result: {
						credential: latest?.type === "oauth" ? options.credentialFromRow(latest) : undefined,
						refreshed: false,
						removed: false,
					},
				};
			} finally {
				leaseRenewalStop.abort();
				await leaseRenewal;
				clearTimeout(backstop);
			}
			const merged: T = options.mergeRefreshedCredential
				? options.mergeRefreshedCredential(current, refreshed)
				: mergeRefreshedCredential(current, refreshed);
			const fingerprints = {
				provider,
				credentialId: row.id,
				spentRefresh: tokenFingerprint(current.refresh),
				access: tokenFingerprint(merged.access),
				refresh: tokenFingerprint(merged.refresh),
				expires: merged.expires,
			};
			logger.info("OAuth token exchange succeeded", fingerprints);
			if (leaseRenewalError) {
				logger.warn("OAuth refresh lost its lease before saving the exchanged token", fingerprints);
				// The provider already consumed the old refresh token. The fenced save
				// below writes only once the lease is ours again and the row is unchanged.
				if (!this.#deps.store.tryUpdateAuthCredentialIfMatches) throw leaseRenewalError;
			}
			if (this.#deps.store.tryUpdateAuthCredentialIfMatches) {
				if (
					!(await this.#persistExchangedCredential(
						provider,
						row.id,
						serializedData,
						merged,
						leasedCredentialId !== undefined && leaseStore ? { store: leaseStore, owner } : undefined,
						fingerprints,
					))
				) {
					logger.warn("OAuth refresh lost its compare-and-set; exchanged token not saved", fingerprints);
					await this.#deps.pool.reload();
					const latest = this.#deps.pool.entries(provider).find(entry => entry.id === row.id)?.credential;
					return {
						result: {
							credential: latest?.type === "oauth" ? options.credentialFromRow(latest) : undefined,
							refreshed: false,
							removed: false,
						},
					};
				}
			} else {
				this.#deps.store.updateAuthCredential(row.id, merged);
			}
			saved = true;
			if (this.#mintsLocally()) {
				this.#rememberMint(provider, row.id, merged);
			}
			// Re-read rather than reuse `rows`: siblings may have been removed while the exchange ran.
			this.#deps.pool.replace(
				provider,
				this.#deps.store
					.listAuthCredentials(provider)
					.map(entry => ({ id: entry.id, credential: entry.credential })),
			);
			return { result: { credential: merged, refreshed: true, removed: false } };
		} finally {
			if (leasedCredentialId !== undefined && leaseStore && !keepLease) {
				if (saved) leaseStore.releaseCredentialRefreshLease(leasedCredentialId, owner);
				else await this.#leaveLease(leaseStore, leasedCredentialId, owner, takenOverFrom);
			}
		}
	}

	/**
	 * Handles a definitively-dead OAuth grant discovered during refresh (`invalid_grant`,
	 * `revoked`, …): checks for a peer rotation that raced the failure, then CAS-disables
	 * the row and emits `credential_disabled`. Shared by the eager preflight refresh
	 * and the final-candidate refresh so both actually disable the credential — not
	 * just temporarily block it — on a definitive failure.
	 *
	 * Returns `"disabled"` once the row is torn down, `"peer-rotated"` when a concurrent
	 * process refreshed the same row first (the persisted refresh token no longer matches
	 * what we attempted — the caller should reload and retry with the new credential), or
	 * `"cas-lost"` when the disable itself lost a race and the caller should reload before
	 * continuing.
	 */
	async disableDefinitiveFailure(
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
			const latestRow = this.#deps.store.listAuthCredentials(provider).find(row => row.id === credentialId);
			const latestCredential = latestRow?.credential;
			if (latestCredential?.type === "oauth" && latestCredential.refresh !== attemptedCredential.refresh) {
				logger.debug("OAuth refresh race detected; another process rotated token first", {
					provider,
					index,
					credentialId,
				});
				await this.#deps.pool.reload();
				return "peer-rotated";
			}
		}
		// Permanently disable invalid credentials with an explicit cause for inspection/debugging.
		// Use a CAS-style disable conditioned on the row still containing the stale credential
		// we tried to refresh, so a peer rotation that lands between the pre-check above and
		// this disable doesn't soft-delete the freshly-rotated row.
		if (credentialId === undefined) {
			await this.#deps.pool.reload();
			return "cas-lost";
		}
		const disabled = this.#deps.pool.disableIfMatches(
			provider,
			credentialId,
			attemptedCredential,
			`oauth refresh failed: ${errorMsg}`,
		);
		if (!disabled) {
			logger.debug("OAuth refresh disable lost CAS; reloading after peer rotation", { provider, index });
			await this.#deps.pool.reload();
			return "cas-lost";
		}
		return "disabled";
	}

	async refresh(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
		reason?: OAuthRefreshReason,
		rejectedAccess?: string,
	): Promise<OAuthCredentials> {
		const authRecovery = reason === "auth-recovery";
		if (authRecovery && credentialId !== undefined && !this.#oauthCredentialRefreshInFlight.has(credentialId)) {
			const recent = this.#recentMint(credentialId);
			// A token the provider has just rejected is not a usable recent mint.
			if (recent && recent.credential.access !== rejectedAccess) return recent.credential;
		}
		return this.#refreshSingleFlight(provider, credential, credentialId, signal, reason, rejectedAccess);
	}

	/** Refresh without recent-mint reuse; still shares the per-credential in-flight request. */
	async #refreshSingleFlight(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
		reason?: OAuthRefreshReason,
		rejectedAccess?: string,
	): Promise<OAuthCredentials> {
		credential = normalizeOAuthCredentialExpiry(provider, credential);
		if (credentialId !== undefined) {
			const existing = this.#oauthCredentialRefreshInFlight.get(credentialId);
			if (existing) {
				const joined = await raceSignal(existing, signal, "credential refresh aborted");
				// A refresh started for another request may adopt the very token this
				// request was refused with; refresh again instead of returning it.
				if (rejectedAccess === undefined || joined.access !== rejectedAccess) return joined;
				return this.#refreshSingleFlight(provider, credential, credentialId, signal, reason, rejectedAccess);
			}
		}
		if (Date.now() + OAUTH_REFRESH_SKEW_MS < credential.expires) return credential;
		// A caller that already left must not own a refresh that later callers join:
		// they would inherit its cancellation instead of a credential.
		if (signal?.aborted) throw new AIError.AbortError("credential refresh aborted");
		if (credentialId === undefined) {
			return this.#refreshOAuthCredentialUnshared(provider, credential, undefined, signal, reason, rejectedAccess);
		}
		const promise = this.#refreshOAuthCredentialUnshared(
			provider,
			credential,
			credentialId,
			signal,
			reason,
			rejectedAccess,
		)
			.then(refreshed => {
				// A delegated refresh may have returned a broker-cached token rather
				// than minting one. Only direct local requests can establish mint time.
				if (!hasRefreshLeases(this.#deps.store) && this.#mintsLocally()) {
					this.#rememberMint(provider, credentialId, refreshed);
				}
				return refreshed;
			})
			.finally(() => {
				this.#oauthCredentialRefreshInFlight.delete(credentialId);
			});
		this.#oauthCredentialRefreshInFlight.set(credentialId, promise);
		return raceSignal(promise, signal, "credential refresh aborted");
	}

	async #refreshOAuthCredentialUnshared(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
		reason?: OAuthRefreshReason,
		rejectedAccess?: string,
	): Promise<OAuthCredentials> {
		if (credentialId !== undefined && hasRefreshLeases(this.#deps.store)) {
			const forceRefresh = credential.expires === 0;
			const result = await this.refreshStored(provider, {
				credentialId,
				// A forced refresh still names the tokens it wants replaced: when the
				// row already holds newer ones, another process refreshed first.
				observedCredential: credential,
				credentialFromRow: row => row,
				forceRefresh,
				rejectedAccess: reason === "auth-recovery" ? rejectedAccess : undefined,
				signal,
				// `refreshStored` owns the caller budget and the exchange backstop.
				refresh: (current, refreshSignal) =>
					this.#requestOAuthCredentialRefresh(provider, current, credentialId, refreshSignal, reason, undefined),
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
					// Reloaded (not refreshed by us) credential — match refresh's
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
		return this.#requestOAuthCredentialRefresh(
			provider,
			credential,
			credentialId,
			signal,
			reason,
			DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
		);
	}

	async #requestOAuthCredentialRefresh(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal: AbortSignal | undefined,
		reason: OAuthRefreshReason | undefined,
		timeoutMs: number | undefined,
	): Promise<OAuthCredentials> {
		let refreshPromise: Promise<OAuthCredentials>;
		// Caller override > store-level hook > local per-provider refresh.
		// `RemoteAuthCredentialStore` exposes the hook so a broker-backed gateway
		// routes refresh through the broker without explicit wiring.
		const storeRefresh = this.#deps.store.refreshOAuthCredential?.bind(this.#deps.store);
		const overrideRefresh = this.#deps.override ?? storeRefresh;
		if (overrideRefresh && credentialId !== undefined) {
			refreshPromise = overrideRefresh(provider, credentialId, credential, signal, reason);
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
		// Stop awaiting after `timeoutMs` or on `signal`. Leased exchanges pass no
		// timeout: `refreshStored` stops its caller waiting without dropping the
		// result, and only its backstop signal ends the exchange itself.
		const cancellation = Promise.withResolvers<never>();
		let onAbort: (() => void) | undefined;
		const timeout =
			timeoutMs === undefined
				? undefined
				: setTimeout(
						() =>
							cancellation.reject(
								new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
									kind: "timeout",
									provider,
								}),
							),
						timeoutMs,
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

	/**
	 * Refresh the OAuth credential with the given id through a per-credential
	 * single-flight. Concurrent callers for the same row await the same upstream
	 * refresh attempt, which is required for providers that rotate refresh tokens
	 * on every successful refresh.
	 */
	async refreshById(
		id: number,
		signal?: AbortSignal,
		options?: OAuthRefreshByIdOptions,
	): Promise<AuthCredentialSnapshotEntry> {
		const existing = this.#oauthRefreshInFlight.get(id);
		if (existing) {
			const joined = await raceSignal(existing, signal, "credential refresh aborted");
			// A refresh that started earlier can land on the very token this caller's
			// request was refused with; that is no recovery, so refresh again.
			if (
				options?.rejectedAccess === undefined ||
				joined.credential.type !== "oauth" ||
				joined.credential.access !== options.rejectedAccess
			) {
				return joined;
			}
			// Whatever refresh runs now is checked against the rejected token the same way.
			return this.refreshById(id, signal, options);
		}
		const recent = options?.reuseRecentMint ? this.#recentMint(id) : undefined;
		// A token the provider has just rejected is not a usable recent mint.
		if (recent && recent.credential.access !== options?.rejectedAccess) {
			return snapshotEntry(id, recent.provider, recent.credential);
		}
		// A caller that already left must not own a refresh that later callers join.
		if (signal?.aborted) throw new AIError.AbortError("credential refresh aborted");

		const promise = (async () => {
			this.#deps.pool.bump("credential-refresh-start");
			try {
				return await this.#forceRefreshCredentialByIdUnshared(id, signal, options?.reason, options?.rejectedAccess);
			} catch (error) {
				this.#deps.pool.bump("credential-refresh-failure");
				throw error;
			} finally {
				this.#oauthRefreshInFlight.delete(id);
			}
		})();
		this.#oauthRefreshInFlight.set(id, promise);
		return raceSignal(promise, signal, "credential refresh aborted");
	}

	async #forceRefreshCredentialByIdUnshared(
		id: number,
		signal?: AbortSignal,
		reason?: OAuthRefreshReason,
		rejectedAccess?: string,
	): Promise<AuthCredentialSnapshotEntry> {
		for (const provider of this.#deps.pool.providers()) {
			const entries = this.#deps.pool.entries(provider);
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
			// Pass a clone with expires=0 and bypass recent-mint reuse so scheduled
			// refreshes and direct force-refresh callers mint, unless the stored row
			// already holds a token the provider has not rejected.
			const stale: OAuthCredential = { ...attempted, expires: 0 };
			let refreshed: OAuthCredentials;
			try {
				refreshed = await this.#refreshSingleFlight(
					provider as Provider,
					stale,
					id,
					signal,
					reason,
					rejectedAccess,
				);
			} catch (error) {
				// A definitively-dead grant tears the row down here, where the
				// attempted credential is known. CAS on the persisted credential so a
				// peer/login rotation in flight leaves the freshly-rotated row intact.
				if (AIError.isDefinitiveOAuthFailure(String(error))) {
					// CAS-loss (false) means a peer/login rotated the row mid-refresh, so
					// our #data copy is stale — reload so the next caller serves the
					// freshly-rotated credential rather than the dead token we attempted.
					if (
						!this.#deps.pool.disableIfMatches(provider, id, attempted, `oauth refresh failed: ${String(error)}`)
					) {
						await this.#deps.pool.reload();
					}
				}
				throw error;
			}
			// Preserve credential-subtype metadata, such as MCP token endpoints,
			// that the provider's bare OAuth response cannot reproduce.
			const updated = mergeRefreshedCredential(attempted, refreshed);
			// Persist by id: the array may have been reordered/shrunk while the
			// refresh was in flight, so the pre-await positional index is unsafe. A
			// -1 means the row was disabled/removed mid-refresh — surface that as a
			// miss rather than implying a live row the snapshot won't contain.
			if (this.#deps.pool.replaceById(provider, id, updated) === -1) {
				throw new AIError.ValidationError(`No credential with id=${id}`);
			}
			return snapshotEntry(id, provider, updated);
		}
		throw new AIError.ValidationError(`No credential with id=${id}`);
	}
}

/** Broker-facing snapshot entry for a refreshed row; the real refresh token never leaves the store. */
function snapshotEntry(id: number, provider: string, credential: OAuthCredential): AuthCredentialSnapshotEntry {
	return {
		id,
		provider,
		credential: { ...credential, refresh: REMOTE_REFRESH_SENTINEL },
		identityKey: resolveCredentialIdentityKey(provider, credential),
	};
}
