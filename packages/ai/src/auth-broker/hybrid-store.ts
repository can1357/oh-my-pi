/**
 * Broker-backed credential store that keeps logins the broker will not serve on
 * this machine.
 *
 * A broker can accept a login yet never hand it back, e.g. one whose version
 * pauses the provider; the login would vanish on the next snapshot. When an
 * upload comes back unserved, {@link HybridAuthCredentialStore} saves the login
 * in the local SQLite store (`agent.db`) instead and records the provider there,
 * so it keeps resolving locally across restarts. Providers whose logins hinge
 * on a key only this machine holds (`device-bound #true` in their auth rule)
 * always stay local. Every other provider goes to the broker.
 *
 * ```ts
 * const store = new HybridAuthCredentialStore({
 * 	broker: remoteStore,
 * 	local: await SqliteAuthCredentialStore.open(getAgentDbPath()),
 * });
 * ```
 */
import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import { logger } from "@oh-my-pi/pi-utils";
import type { CredentialRefreshLeaseFence, AuthCredentialStore } from "../auth/store";
import type { SqliteAuthCredentialStore } from "../auth/sqlite-credential-store";
import type {
	AuthCredential,
	DisabledCredentialSummary,
	OAuthCredential,
	OAuthRefreshReason,
	StoredAuthCredential,
	StoredCredentialBlock,
} from "../auth/types";
import { refreshProviderOAuthToken } from "../registry/oauth";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type { ClientUsageIdentity, ObservedUsageEntry, UsageReport } from "../usage";
import { AuthBrokerUnservedProviderError, type RemoteAuthCredentialStore } from "./remote-store";

/** Providers whose logins never reach the broker: their refresh token is bound to a key that stays on this machine. */
const DEVICE_BOUND_PROVIDERS: readonly string[] = authProviders()
	.filter(policy => policy.deviceBound)
	.map(policy => policy.id);

/** The two stores {@link HybridAuthCredentialStore} splits providers between. */
export interface HybridAuthCredentialStoreOptions {
	broker: RemoteAuthCredentialStore;
	local: SqliteAuthCredentialStore;
}

/**
 * {@link AuthCredentialStore} over a broker store plus the local SQLite store,
 * split by provider. Local providers (those `local` lists in
 * {@link SqliteAuthCredentialStore.listBrokerLocalProviders}) are read, written,
 * refreshed, and blocked in SQLite; the broker's rows for them are hidden. Every
 * other provider goes to the broker exactly as with
 * {@link RemoteAuthCredentialStore}, until an upload for it comes back unserved
 * ({@link AuthBrokerUnservedProviderError}): then the login is saved locally and
 * the provider becomes local. Logging out of a local provider's last login
 * returns it to the broker for the next login.
 *
 * Row ids share one number space: a local row carries its SQLite id negated, so
 * id-only calls (blocks, disables, refresh) route without a provider.
 *
 * Limits for local providers: tokens refresh in this process without the durable
 * cross-process refresh lease (the broker store has none to share), and usage
 * reports come only from the broker, so local providers report no usage.
 */
export class HybridAuthCredentialStore implements AuthCredentialStore {
	readonly #broker: RemoteAuthCredentialStore;
	readonly #local: SqliteAuthCredentialStore;
	#localProviders: Set<string>;

	constructor(opts: HybridAuthCredentialStoreOptions) {
		this.#broker = opts.broker;
		this.#local = opts.local;
		this.#localProviders = this.#readLocalProviders();
	}

	#readLocalProviders(): Set<string> {
		return new Set([...DEVICE_BOUND_PROVIDERS, ...this.#local.listBrokerLocalProviders()]);
	}

	close(): void {
		this.#broker.close();
		this.#local.close();
	}

	pollExternalChanges(): boolean {
		// Poll both: each probe also consumes the change it reports.
		const broker = this.#broker.pollExternalChanges();
		const local = this.#local.pollExternalChanges();
		// Another process may have kept a login locally; it records the provider before saving the row.
		if (local) this.#localProviders = this.#readLocalProviders();
		return broker || local;
	}

	acknowledgeLocalChanges(): void {
		this.#local.acknowledgeLocalChanges();
	}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		if (provider !== undefined) {
			return this.#localProviders.has(provider)
				? this.#local.listAuthCredentials(provider).map(toHybridRow)
				: this.#broker.listAuthCredentials(provider);
		}
		const rows = this.#broker.listAuthCredentials().filter(row => !this.#localProviders.has(row.provider));
		for (const local of this.#localProviders) {
			for (const row of this.#local.listAuthCredentials(local)) rows.push(toHybridRow(row));
		}
		return rows;
	}

	refreshSnapshot(): Promise<unknown> {
		return this.#broker.refreshSnapshot();
	}

	async listDisabledCredentials(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]> {
		if (provider !== undefined && this.#localProviders.has(provider)) {
			return (await this.#local.listDisabledCredentials(provider)).map(toHybridRow);
		}
		const broker = await this.#broker.listDisabledCredentials(provider, signal);
		if (provider !== undefined) return broker;
		const summaries = broker.filter(summary => !this.#localProviders.has(summary.provider));
		for (const local of this.#localProviders) {
			for (const summary of await this.#local.listDisabledCredentials(local)) summaries.push(toHybridRow(summary));
		}
		return summaries;
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		if (isLocalId(id)) this.#local.updateAuthCredential(-id, credential);
		else this.#broker.updateAuthCredential(id, credential);
	}

	async deleteAuthCredential(id: number, disabledCause: string): Promise<boolean> {
		if (!isLocalId(id)) return this.#broker.deleteAuthCredential(id, disabledCause);
		const provider = this.#local.listAuthCredentials().find(row => row.id === -id)?.provider;
		const deleted = await this.#local.deleteAuthCredential(-id, disabledCause);
		if (deleted && provider !== undefined) this.#returnToBrokerIfEmpty(provider);
		return deleted;
	}

	tryDisableAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		disabledCause: string,
		lease?: CredentialRefreshLeaseFence,
	): boolean {
		return isLocalId(id)
			? this.#local.tryDisableAuthCredentialIfMatches(-id, expectedData, disabledCause, lease)
			: this.#broker.tryDisableAuthCredentialIfMatches(id, expectedData, disabledCause);
	}

	tryUpdateAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		credential: AuthCredential,
		lease?: CredentialRefreshLeaseFence,
	): boolean {
		if (isLocalId(id)) return this.#local.tryUpdateAuthCredentialIfMatches(-id, expectedData, credential, lease);
		// The broker persists its own refreshes; mirror the row as AuthStorage does for a store without CAS.
		this.#broker.updateAuthCredential(id, credential);
		return true;
	}

	replaceAuthCredentials(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]> {
		return this.#saveLogin(provider, store => store.replaceAuthCredentials(provider, credentials));
	}

	upsertAuthCredential(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
		return this.#saveLogin(provider, store => store.upsertAuthCredential(provider, credential));
	}

	/** Run a login write on the store `provider` lives in; a broker that will not serve it moves it to `agent.db`. */
	async #saveLogin(
		provider: string,
		write: (store: AuthCredentialStore) => Promise<StoredAuthCredential[]>,
	): Promise<StoredAuthCredential[]> {
		if (!this.#localProviders.has(provider)) {
			try {
				return await write(this.#broker);
			} catch (error) {
				if (!(error instanceof AuthBrokerUnservedProviderError)) throw error;
				this.#keepLocal(provider);
			}
		}
		return (await write(this.#local)).map(toHybridRow);
	}

	async deleteAuthCredentials(provider: string, disabledCause: string): Promise<void> {
		if (!this.#localProviders.has(provider)) return this.#broker.deleteAuthCredentials(provider, disabledCause);
		await this.#local.deleteAuthCredentials(provider, disabledCause);
		this.#returnToBrokerIfEmpty(provider);
	}

	/** Route `provider` to `agent.db` from now on, in this process and (via the record) every later one. */
	#keepLocal(provider: string): void {
		logger.warn("Auth broker does not serve this provider's logins; keeping them in the local agent.db", {
			provider,
		});
		this.#local.markBrokerLocalProvider(provider);
		this.#localProviders.add(provider);
	}

	/** After a logout, send `provider`'s next login to the broker once no local login is left. */
	#returnToBrokerIfEmpty(provider: string): void {
		if (DEVICE_BOUND_PROVIDERS.includes(provider)) return;
		if (this.#local.listAuthCredentials(provider).length > 0) return;
		this.#local.unmarkBrokerLocalProvider(provider);
		this.#localProviders.delete(provider);
	}

	// Session pins and usage caches stay in the broker store's in-memory cache, as without local providers.
	getCache(key: string): string | null {
		return this.#broker.getCache(key);
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#broker.setCache(key, value, expiresAtSec);
	}

	deleteCachePrefix(prefix: string): void {
		this.#broker.deleteCachePrefix(prefix);
	}

	cleanExpiredCache(): void {
		this.#broker.cleanExpiredCache();
	}

	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		return isLocalId(credentialId)
			? this.#local.getCredentialBlock(-credentialId, providerKey, blockScope)
			: this.#broker.getCredentialBlock(credentialId, providerKey, blockScope);
	}

	getCredentialBlockScopes(credentialId: number, providerKey: string): ReadonlyMap<string, number> {
		return isLocalId(credentialId)
			? this.#local.getCredentialBlockScopes(-credentialId, providerKey)
			: this.#broker.getCredentialBlockScopes(credentialId, providerKey);
	}

	getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		return isLocalId(credentialId)
			? this.#local.getCredentialBlockReconcileAfter(-credentialId, providerKey, blockScope)
			: this.#broker.getCredentialBlockReconcileAfter(credentialId, providerKey, blockScope);
	}

	upsertCredentialBlock(block: StoredCredentialBlock): void {
		if (isLocalId(block.credentialId)) this.#local.upsertCredentialBlock(toHybridBlock(block));
		else this.#broker.upsertCredentialBlock(block);
	}

	deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
		if (isLocalId(credentialId)) this.#local.deleteCredentialBlock(-credentialId, providerKey, blockScope);
		else this.#broker.deleteCredentialBlock(credentialId, providerKey, blockScope);
	}

	deleteCredentialBlocks(credentialId: number): void {
		if (isLocalId(credentialId)) this.#local.deleteCredentialBlocks(-credentialId);
		else this.#broker.deleteCredentialBlocks(credentialId);
	}

	cleanExpiredCredentialBlocks(nowMs: number): void {
		this.#broker.cleanExpiredCredentialBlocks(nowMs);
		this.#local.cleanExpiredCredentialBlocks(nowMs);
	}

	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		const blocks = this.#broker.listCredentialBlocks(credentialIds.filter(id => !isLocalId(id)));
		const localIds = credentialIds.filter(isLocalId).map(id => -id);
		if (localIds.length > 0) {
			for (const block of this.#local.listCredentialBlocks(localIds)) blocks.push(toHybridBlock(block));
		}
		return blocks;
	}

	recordObservedUsage(entries: ObservedUsageEntry[], client?: ClientUsageIdentity): void {
		this.#broker.recordObservedUsage(entries, client);
	}

	invalidateUsageCache(provider?: string, signal?: AbortSignal): Promise<void> {
		return this.#broker.invalidateUsageCache(provider, signal);
	}

	/** Local rows mint in this process with their real refresh token; broker rows refresh on the broker. */
	refreshOAuthCredential(
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
		reason?: OAuthRefreshReason,
	): Promise<OAuthCredentials> {
		return isLocalId(credentialId)
			? refreshProviderOAuthToken(provider, credential, signal, reason)
			: this.#broker.refreshOAuthCredential(provider, credentialId, credential, signal, reason);
	}

	async prepareForRequest(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean> {
		return isLocalId(credentialId) ? false : this.#broker.prepareForRequest(credentialId, opts);
	}

	async fetchUsageReports(signal?: AbortSignal, provider?: Provider): Promise<UsageReport[] | null> {
		if (provider !== undefined && this.#localProviders.has(provider)) return [];
		const reports = await this.#broker.fetchUsageReports(signal, provider);
		return reports && reports.filter(report => !this.#localProviders.has(report.provider));
	}

	async getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<UsageReport | null> {
		return this.#localProviders.has(provider) ? null : this.#broker.getUsageReport(provider, credential, signal);
	}

	ingestUsageReport(provider: Provider, credential: OAuthCredential, report: UsageReport): boolean {
		return !this.#localProviders.has(provider) && this.#broker.ingestUsageReport(provider, credential, report);
	}

	async markCredentialSuspect(credentialId: number, opts?: { signal?: AbortSignal }): Promise<void> {
		// A local row has no broker copy to re-issue; the caller re-reads the store next.
		if (!isLocalId(credentialId)) await this.#broker.markCredentialSuspect(credentialId, opts);
	}
}

/** Local SQLite ids are positive; their hybrid ids are negated. */
function isLocalId(id: number): boolean {
	return id < 0;
}

function toHybridRow<T extends { id: number }>(row: T): T {
	return { ...row, id: -row.id };
}

function toHybridBlock(block: StoredCredentialBlock): StoredCredentialBlock {
	return { ...block, credentialId: -block.credentialId };
}
