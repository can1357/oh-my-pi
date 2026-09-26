import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getOAuthProvider, normalizeOAuthCredentialExpiry, refreshOAuthToken } from "../registry/oauth";
import type { OAuthCredentials, OAuthProvider } from "../registry/oauth/types";
import type { Provider } from "../types";
import { raceSignal } from "./abort";
import { authCredentialEquals, type CredentialPool, credentialDisabledEvent } from "./pool";
import type { AccountPolicies } from "./policy";
import { resolveCredentialIdentityKey, serializeCredential } from "./sqlite-credential-store";
import { hasRefreshLeases, type AuthCredentialStore } from "./store";
import {
	REMOTE_REFRESH_SENTINEL,
	type AuthCredentialSnapshotEntry,
	type AuthStorageOptions,
	type OAuthCredential,
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
const OAUTH_REFRESH_LEASE_TTL_MS = 15_000;
const OAUTH_REFRESH_LEASE_POLL_MS = 50;
const OAUTH_REFRESH_LEASE_RENEW_MS = 5_000;
const OAUTH_REFRESH_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;

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
		orgId: refreshed.orgId ?? current.orgId,
		region: refreshed.region ?? current.region,
		orgName: refreshed.orgName ?? current.orgName,
		authorizedAt: refreshed.authorizedAt ?? current.authorizedAt,
	};
}

/** Dependencies for lease-guarded OAuth refresh. */
export interface OAuthRefresherDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	policies: AccountPolicies;
	override?: AuthStorageOptions["refreshOAuthCredential"];
}

/** Single-flighted, lease-guarded OAuth refresh with compare-and-set persistence. */
export class OAuthRefresher {
	readonly #deps: OAuthRefresherDeps;
	#oauthRefreshInFlight: Map<number, Promise<AuthCredentialSnapshotEntry>> = new Map();
	#oauthCredentialRefreshInFlight: Map<number, Promise<OAuthCredentials>> = new Map();

	constructor(deps: OAuthRefresherDeps) {
		this.#deps = deps;
	}

	/**
	 * Refresh one stored OAuth credential under durable row ownership.
	 */
	async refreshStored<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>> {
		const refreshSkewMs = options.refreshSkewMs ?? OAUTH_REFRESH_SKEW_MS;
		const leaseStore = hasRefreshLeases(this.#deps.store) ? this.#deps.store : undefined;
		const owner = crypto.randomUUID();
		let leasedCredentialId: number | undefined;

		while (leaseStore) {
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
			if (leaseStore.tryAcquireCredentialRefreshLease(row.id, owner, Date.now() + OAUTH_REFRESH_LEASE_TTL_MS)) {
				leasedCredentialId = row.id;
				break;
			}
			const leaseExpiresAt = leaseStore.getCredentialRefreshLeaseExpiresAt(row.id);
			const waitMs =
				leaseExpiresAt === undefined
					? OAUTH_REFRESH_LEASE_POLL_MS
					: Math.min(Math.max(leaseExpiresAt - Date.now(), OAUTH_REFRESH_LEASE_POLL_MS), 250);
			await raceSignal(Bun.sleep(waitMs), options.signal, "OAuth refresh ownership wait aborted by caller");
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
				leasedCredentialId !== undefined && leaseStore
					? (async () => {
							while (!stopLeaseRenewal) {
								await Promise.race([Bun.sleep(OAUTH_REFRESH_LEASE_RENEW_MS), leaseRenewalStopped.promise]);
								if (stopLeaseRenewal) return;
								const renewed = leaseStore.renewCredentialRefreshLease(
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
						const disabled = this.#deps.store.tryDisableAuthCredentialIfMatches(
							row.id,
							serialized.data,
							disabledCause,
							leasedCredentialId !== undefined ? { owner, nowMs: Date.now() } : undefined,
						);
						if (disabled) {
							this.#deps.pool.replace(
								provider,
								rows
									.filter(entry => entry.id !== row.id)
									.map(entry => ({
										id: entry.id,
										credential: entry.credential,
									})),
							);
							this.#deps.pool.reset(provider);
							this.#deps.pool.emitDisabled(credentialDisabledEvent(provider, row, disabledCause));
							return { credential: undefined, refreshed: false, removed: true };
						}
						await this.#deps.pool.reload();
						const latest = this.#deps.pool.entries(provider).find(entry => entry.id === row.id)?.credential;
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
				: mergeRefreshedCredential(current, refreshed);
			if (this.#deps.store.tryUpdateAuthCredentialIfMatches) {
				if (
					!this.#deps.store.tryUpdateAuthCredentialIfMatches(
						row.id,
						serialized.data,
						merged,
						leasedCredentialId !== undefined ? { owner, nowMs: Date.now() } : undefined,
					)
				) {
					await this.#deps.pool.reload();
					const latest = this.#deps.pool.entries(provider).find(entry => entry.id === row.id)?.credential;
					return {
						credential: latest?.type === "oauth" ? options.credentialFromRow(latest) : undefined,
						refreshed: false,
						removed: false,
					};
				}
			} else {
				this.#deps.store.updateAuthCredential(row.id, merged);
			}
			this.#deps.pool.replace(
				provider,
				rows.map(entry => ({
					id: entry.id,
					credential: entry.id === row.id ? merged : entry.credential,
				})),
			);
			return { credential: merged, refreshed: true, removed: false };
		} finally {
			if (leasedCredentialId !== undefined && leaseStore) {
				leaseStore.releaseCredentialRefreshLease(leasedCredentialId, owner);
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
		this.#deps.policies.validateFor(provider, this.#deps.pool.credentials(provider));
		return "disabled";
	}

	async refresh(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		credential = normalizeOAuthCredentialExpiry(provider, credential);
		if (credentialId !== undefined) {
			const existing = this.#oauthCredentialRefreshInFlight.get(credentialId);
			if (existing) return raceSignal(existing, signal, "credential refresh aborted");
		}
		if (Date.now() + OAUTH_REFRESH_SKEW_MS < credential.expires) return credential;
		if (credentialId === undefined) {
			return this.#refreshOAuthCredentialUnshared(provider, credential, undefined, signal);
		}
		const promise = this.#refreshOAuthCredentialUnshared(provider, credential, credentialId).finally(() => {
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
	): Promise<OAuthCredentials> {
		if (credentialId !== undefined && hasRefreshLeases(this.#deps.store)) {
			const forceRefresh = credential.expires === 0;
			const result = await this.refreshStored(provider, {
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
		const storeRefresh = this.#deps.store.refreshOAuthCredential?.bind(this.#deps.store);
		const overrideRefresh = this.#deps.override ?? storeRefresh;
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

	/**
	 * Refresh the OAuth credential with the given id through a per-credential
	 * single-flight. Concurrent callers for the same row await the same upstream
	 * refresh attempt, which is required for providers that rotate refresh tokens
	 * on every successful refresh.
	 */
	async refreshById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		const existing = this.#oauthRefreshInFlight.get(id);
		if (existing) return raceSignal(existing, signal, "credential refresh aborted");

		const promise = (async () => {
			this.#deps.pool.bump("credential-refresh-start");
			try {
				return await this.#forceRefreshCredentialByIdUnshared(id, signal);
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

	async #forceRefreshCredentialByIdUnshared(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
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
			// Pass a clone with expires=0 so the cached not-yet-expired short-circuit
			// in refresh doesn't suppress the requested refresh.
			const stale: OAuthCredential = { ...attempted, expires: 0 };
			let refreshed: OAuthCredentials;
			try {
				refreshed = await this.refresh(provider as Provider, stale, id, signal);
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
			return {
				id,
				provider,
				credential: { ...updated, refresh: REMOTE_REFRESH_SENTINEL },
				identityKey: resolveCredentialIdentityKey(provider, updated),
			};
		}
		throw new AIError.ValidationError(`No credential with id=${id}`);
	}
}
