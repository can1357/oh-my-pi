import { logger } from "@oh-my-pi/pi-utils";
import { resolveCredentialIdentityKey, serializeCredential } from "./sqlite-credential-store";
import type { BlockStoreHealth } from "./blocks";
import type { AccountPolicies } from "./policy";
import type { AuthCredentialStore } from "./store";
import { REMOTE_REFRESH_SENTINEL } from "./types";
import type {
	ApiKeyCredential,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialSnapshot,
	AuthCredentialSnapshotEntry,
	AuthStorageData,
	CredentialDisabledEvent,
	CredentialsApi,
	DisabledCredentialSummary,
	OAuthCredential,
	SnapshotCredential,
	StoredAuthCredential,
} from "./types";
import type { UsageCredential } from "../usage";

const OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT = 8;
const MAX_PENDING_DISABLED_EVENTS = 32;

/** SHA-256 bearer fingerprint, so superseded OAuth token bytes never enter the identity cache. */
function fingerprintOAuthBearer(bearer: string): string {
	return Bun.SHA256.hash(bearer, "base64url");
}

/** One stored credential row as cached in memory. */
export type StoredCredential = { id: number; credential: AuthCredential };

/** {@link CredentialDisabledEvent} for a torn-down row, carrying the account identity it was signed in as. */
export function credentialDisabledEvent(
	provider: string,
	row: StoredCredential,
	disabledCause: string,
): CredentialDisabledEvent {
	const event: CredentialDisabledEvent = { provider, disabledCause, credentialId: row.id };
	const { credential } = row;
	if (credential.type === "oauth") {
		if (credential.email) event.email = credential.email;
		if (credential.accountId) event.accountId = credential.accountId;
		if (credential.orgId) event.orgId = credential.orgId;
		if (credential.orgName) event.orgName = credential.orgName;
	}
	return event;
}

/** Credential equality used for snapshot change detection. */
export function authCredentialEquals(left: AuthCredential, right: AuthCredential): boolean {
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

/** Dependencies for credential validation, corruption handling, and assignment reset. */
export interface CredentialPoolOptions {
	policies: AccountPolicies;
	blockHealth: BlockStoreHealth;
	/** Called whenever a provider's credential set changed locally. */
	onReset: (provider: string) => void;
}

/** In-memory credential snapshot over an AuthCredentialStore: CRUD, change detection, events. */
export class CredentialPool implements CredentialsApi {
	/** Provider -> credentials cache, populated from store on reload(). */
	#data: Map<string, StoredCredential[]> = new Map();
	/** Recent bearer fingerprints resolved for each durable OAuth row; used only for delayed usage-limit attribution. */
	#oauthBearerFingerprints: Map<string, Map<number, string[]>> = new Map();
	#credentialDisabledListeners: Set<(event: CredentialDisabledEvent) => void | Promise<void>> = new Set();
	/**
	 * Buffer for credential_disabled events fired while no listener is subscribed.
	 * Drained (in insertion order) to the first listener that triggers the empty→non-empty
	 * transition via {@link CredentialPool.onDisabled}. Bounded at
	 * {@link MAX_PENDING_DISABLED_EVENTS}; oldest entries are dropped to keep memory predictable
	 * if a long-lived AuthStorage somehow accumulates a backlog (provider count is naturally small,
	 * but a process that runs without subscribers for a long time shouldn't grow this unboundedly).
	 */
	#pendingDisabledEvents: CredentialDisabledEvent[] = [];
	#generation = 1;
	#generationListeners: Set<(generation: number) => void> = new Set();
	#closed = false;

	#store: AuthCredentialStore;
	#options: CredentialPoolOptions;

	constructor(store: AuthCredentialStore, options: CredentialPoolOptions) {
		this.#store = store;
		this.#options = options;
	}

	get closed(): boolean {
		return this.#closed;
	}

	get generation(): number {
		return this.#generation;
	}

	providers(): IterableIterator<string> {
		return this.#data.keys();
	}

	/** Reset session affinity and round-robin state after a local credential change. */
	reset(provider: string): void {
		this.#options.onReset(provider);
	}

	/** Re-list one provider and adopt its persisted rows in memory. */
	reloadProvider(provider: string): StoredAuthCredential[] {
		const rows = this.#store.listAuthCredentials(provider);
		this.replace(
			provider,
			rows.map(row => ({ id: row.id, credential: row.credential })),
		);
		return rows;
	}

	/** Persist a login-entered API key. */
	async storeLoginApiKey(provider: string, key: string): Promise<void> {
		const credential: ApiKeyCredential = { type: "api_key", key, source: "login" };
		const stored = await this.#store.upsertAuthCredential(provider, credential);
		this.replace(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential })),
		);
		this.reset(provider);
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

	/**
	 * Reload state after another process commits to the backing store, then
	 * notify snapshot consumers even when only credential blocks changed.
	 */
	async poll(): Promise<boolean> {
		const pollExternalChanges = this.#store.pollExternalChanges?.bind(this.#store);
		if (!pollExternalChanges?.()) return false;
		const previousGeneration = this.#generation;
		await this.reload();
		if (this.#generation === previousGeneration) this.bump("external-store");
		return true;
	}

	/**
	 * Adopt credentials another process committed before selecting or rotating.
	 *
	 * The store is shared across every omp process, but the pool is an
	 * in-process cache refreshed only by this process's own writes. Without
	 * this a long-running session ranks a stale pool for its whole lifetime:
	 * `omp auth` in another terminal is invisible, rotation reports no usable
	 * sibling while a freshly added account sits unblocked in SQLite, and the
	 * turn degrades to the fallback chain. The auth-broker path already polls;
	 * direct-store sessions had no equivalent.
	 *
	 * A poll is two cheap reads (`PRAGMA data_version` plus the auth revision)
	 * and re-lists credentials only when another connection committed, so it
	 * runs on every resolution rather than on a timer that would make recovery
	 * depend on wall-clock spacing. It sits on the paths that read the pool —
	 * OAuth selection, and the two public usage-limit entry points — and is
	 * idempotent, so a rotation reached through `markUsageLimitReached` costs
	 * one extra `data_version` read and no second reload.
	 */
	async adoptExternalChanges(): Promise<void> {
		if (this.#closed || this.#store.pollExternalChanges === undefined) return;
		try {
			await this.poll();
		} catch (error) {
			// A failed poll must not fail credential resolution: the in-memory
			// pool is still serviceable, just possibly stale.
			logger.debug("External credential poll failed", { error: String(error) });
		}
	}

	onGeneration(listener: (generation: number) => void): () => void {
		this.#generationListeners.add(listener);
		return () => {
			this.#generationListeners.delete(listener);
		};
	}

	bump(reason: string): void {
		this.#generation += 1;
		this.#store.acknowledgeLocalChanges?.();
		for (const listener of Array.from(this.#generationListeners)) {
			try {
				listener(this.#generation);
			} catch (error) {
				logger.debug("AuthStorage generation listener failed", {
					reason,
					error: String(error),
				});
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
	onDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
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
			this.#options.blockHealth.handle(err);
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
			const deduped = await this.pruneDuplicates(provider, entries);
			this.#options.policies.validateFor(
				provider,
				deduped.map(entry => entry.credential),
			);
			if (deduped.length > 0) {
				dedupedGrouped.set(provider, deduped);
			}
		}

		const removedProviders = new Set(this.#data.keys());
		for (const [provider, entries] of dedupedGrouped) {
			this.replace(provider, entries);
			removedProviders.delete(provider);
		}
		for (const provider of removedProviders) {
			this.replace(provider, []);
		}
	}

	/**
	 * Gets cached credentials for a provider.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @returns Array of stored credentials, empty if none exist
	 */
	entries(provider: string): StoredCredential[] {
		return this.#data.get(provider) ?? [];
	}

	/**
	 * Updates in-memory credential cache for a provider.
	 * Removes the provider entry entirely if credentials array is empty.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @param credentials - Array of stored credentials to cache
	 */
	replace(provider: string, credentials: StoredCredential[]): void {
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
		this.bump("credentials");
	}

	noteBearer(provider: string, bearer: string, credentialId: number | undefined): void {
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

	idForBearer(provider: string, bearer: string): number | undefined {
		const fingerprint = fingerprintOAuthBearer(bearer);
		for (const [credentialId, history] of this.#oauthBearerFingerprints.get(provider) ?? []) {
			if (history.includes(fingerprint)) return credentialId;
		}
		return undefined;
	}

	#resolveOAuthDedupeIdentityKey(provider: string, credential: OAuthCredential): string | null {
		return resolveCredentialIdentityKey(provider, credential);
	}

	dedupe(provider: string, credentials: AuthCredential[]): AuthCredential[] {
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

	async pruneDuplicates(provider: string, entries: StoredCredential[]): Promise<StoredCredential[]> {
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
				await this.#store.deleteAuthCredential(entry.id, "deduplicated duplicate credential");
			}
			this.reset(provider);
		}
		return kept.reverse();
	}

	/** Returns all credentials for a provider as an array. */
	credentials(provider: string): AuthCredential[] {
		return this.entries(provider).map(entry => entry.credential);
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
		const entries = this.entries(provider);
		if (index < 0 || index >= entries.length) return false;
		const target = entries[index];
		const serialized = serializeCredential(provider, expectedCredential);
		if (!serialized) return false;
		const disabled = this.#store.tryDisableAuthCredentialIfMatches(target.id, serialized.data, disabledCause);
		if (!disabled) return false;
		const updated = entries.filter((_value, idx) => idx !== index);
		this.replace(provider, updated);
		this.reset(provider);
		this.emitDisabled(credentialDisabledEvent(provider, target, disabledCause));
		return true;
	}

	/**
	 * Persist a refreshed credential by id only while the row still matches this
	 * process's snapshot. A peer rotation wins the CAS and is reloaded instead of
	 * being overwritten after this process releases its refresh lease.
	 *
	 * Returns the row's current index, or -1 when it was disabled or removed.
	 */
	replaceById(provider: string, id: number, credential: AuthCredential): number {
		const entries = this.entries(provider);
		const index = entries.findIndex(entry => entry.id === id);
		if (index === -1) return -1;
		const expected = serializeCredential(provider, entries[index]!.credential);
		if (
			expected &&
			this.#store.tryUpdateAuthCredentialIfMatches &&
			!this.#store.tryUpdateAuthCredentialIfMatches(id, expected.data, credential)
		) {
			const latest = this.#store.listAuthCredentials(provider);
			this.replace(
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
		this.replace(provider, updated);
		return index;
	}

	/**
	 * CAS-disable the row with `id`, but only if its persisted credential still
	 * matches `expected` — i.e. no peer/login rotated it while we refreshed.
	 * Addresses the row by id (re-resolved here, then matched on `data` in the
	 * store) so a concurrent reorder can't tear down the wrong credential.
	 */
	disableIfMatches(provider: string, id: number, expected: AuthCredential, disabledCause: string): boolean {
		const entries = this.entries(provider);
		const index = entries.findIndex(entry => entry.id === id);
		if (index === -1) return false;
		return this.#tryDisableCredentialAtIfMatches(provider, index, expected, disabledCause);
	}

	emitDisabled(event: CredentialDisabledEvent): void {
		// Every automatic disable leaves a log line, with or without subscribers: the event
		// alone left nothing on disk once a session had moved on to a sibling account.
		logger.warn("Auth credential disabled", { ...event });
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
			logger.warn("onCredentialDisabled listener threw", {
				provider: event.provider,
				error: String(error),
			});
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
		return this.credentials(provider)[0];
	}

	/**
	 * Set credential for a provider.
	 */
	async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		const normalized = Array.isArray(credential) ? credential : [credential];
		const deduped = this.dedupe(provider, normalized);
		this.#options.policies.validateFor(provider, deduped);
		const stored = await this.#store.replaceAuthCredentials(provider, deduped);
		this.replace(
			provider,
			stored.map(record => ({
				id: record.id,
				credential: record.credential,
			})),
		);
		this.reset(provider);
	}

	/**
	 * List stored credential rows, optionally filtered by provider.
	 */
	list(provider?: string): StoredAuthCredential[] {
		if (provider !== undefined) {
			return this.entries(provider).map(entry => ({
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

	async upsertOAuth(provider: string, credential: OAuthCredential): Promise<void> {
		const prospectiveCredentials = this.dedupe(provider, [
			...this.#store.listAuthCredentials(provider).map(entry => entry.credential),
			credential,
		]);
		this.#options.policies.validateFor(provider, prospectiveCredentials);
		const stored = await this.#store.upsertAuthCredential(provider, credential);
		this.#options.policies.validateFor(
			provider,
			stored.map(entry => entry.credential),
		);
		this.replace(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential })),
		);
		this.reset(provider);
	}

	/**
	 * Remove credential for a provider.
	 */
	async remove(provider: string): Promise<void> {
		await this.#store.deleteAuthCredentials(provider, "deleted by user");
		this.replace(provider, []);
		this.reset(provider);
	}

	/**
	 * Remove one stored credential for a provider.
	 */
	async removeById(provider: string, credentialId: number): Promise<boolean> {
		const entries = this.entries(provider);
		const index = entries.findIndex(entry => entry.id === credentialId);
		if (index === -1) return false;
		const remainingEntries = entries.filter((_entry, entryIndex) => entryIndex !== index);
		this.#options.policies.validateFor(
			provider,
			remainingEntries.map(entry => entry.credential),
		);

		const deleted = await this.#store.deleteAuthCredential(credentialId, "deleted by user");
		if (!deleted) return false;
		this.replace(provider, remainingEntries);
		this.reset(provider);
		return true;
	}

	/**
	 * Check if credentials exist for a provider in storage.
	 */
	has(provider: string): boolean {
		return this.credentials(provider).length > 0;
	}

	/**
	 * Check if OAuth credentials are configured for a provider.
	 */
	hasOAuth(provider: string): boolean {
		return this.credentials(provider).some(credential => credential.type === "oauth");
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuth(provider: string): OAuthCredential | undefined {
		return this.credentials(provider).find(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
	}

	/**
	 * Get all credentials.
	 */
	all(): AuthStorageData {
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
	 * Build a redacted snapshot of all loaded credentials for the auth-broker
	 * wire. OAuth refresh tokens are replaced with {@link REMOTE_REFRESH_SENTINEL}
	 * so clients never see the actual refresh token.
	 *
	 * Callers must {@link CredentialPool.reload} first when serving a stale snapshot
	 * (the broker server's HTTP handler does this).
	 */
	snapshot(): AuthCredentialSnapshot {
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
		return {
			generation: this.#generation,
			generatedAt: Date.now(),
			credentials: entries,
		};
	}

	/**
	 * Disabled credential tombstones for display surfaces (`omp usage`,
	 * broker `GET /v1/credentials/disabled`). Empty when the backing store
	 * keeps no tombstones or the remote broker predates the endpoint.
	 */
	async listDisabled(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]> {
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
	async revalidate(): Promise<void> {
		if (this.#store.refreshSnapshot) await this.#store.refreshSnapshot();
		await this.reload();
	}

	/**
	 * Disable the credential with the given id and emit a
	 * {@link CredentialDisabledEvent}. Used by the auth-broker server to honour
	 * `POST /v1/credential/:id/disable`. Returns `false` when no such row exists.
	 */
	async disable(id: number, disabledCause: string): Promise<boolean> {
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			if (!(await this.#store.deleteAuthCredential(id, disabledCause))) return false;
			const next = entries.filter((_value, idx) => idx !== index);
			this.replace(provider, next);
			this.reset(provider);
			this.emitDisabled(credentialDisabledEvent(provider, entries[index]!, disabledCause));
			return true;
		}
		return false;
	}

	/**
	 * Upsert a credential into the underlying store, refresh the in-memory
	 * snapshot, and return the redacted snapshot entries for the provider.
	 *
	 * Used by the auth-broker server to honour `POST /v1/credential`. The
	 * persistence layer (`SqliteAuthCredentialStore.upsertAuthCredential`)
	 * does identity-key matching, so re-uploading the same email/account replaces
	 * the existing row instead of inserting a duplicate.
	 */
	async upsert(provider: string, credential: AuthCredential): Promise<AuthCredentialSnapshotEntry[]> {
		const stored = await this.#store.upsertAuthCredential(provider, credential);
		this.replace(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential })),
		);
		this.reset(provider);
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
	 * Find the stored credential id matching a {@link UsageCredential} so the
	 * refresh override can address the row. Mirrors the matching logic in
	 * `UsageService.persistRefreshedCredential`.
	 */
	findIdForUsageCredential(provider: string, previous: UsageCredential): number | undefined {
		const entries = this.entries(provider);
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
}
