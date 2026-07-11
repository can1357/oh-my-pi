/**
 * Client-side {@link AuthCredentialStore} that mirrors a remote broker's
 * snapshot. Refresh tokens never leave the broker; mutating methods (`replace*`,
 * `upsert*`, `delete*ForProvider`) throw because login flows are server-side.
 *
 * Cache (`getCache`/`setCache`/`cleanExpiredCache`) is in-memory and ephemeral —
 * usage reports cache TTL is 5 minutes per credential, so durability across
 * runs isn't required.
 */
import { scheduler } from "node:timers/promises";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import {
	type AuthCredential,
	type AuthCredentialSnapshotEntry,
	type AuthCredentialStore,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type StoredAuthCredential,
} from "../auth-storage";
import * as AIError from "../error";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type { UsageReport } from "../usage";
import { type AuthBrokerClient, AuthBrokerStreamUnsupportedError } from "./client";
import type { RefresherSchedule, SnapshotEntry, SnapshotResponse, SnapshotStreamEvent } from "./types";

/**
 * Client-side TTL for the aggregate `/v1/usage` response. Set below the
 * broker server's own 30s usage cache so we typically pick up the broker's
 * cached value instead of re-walking the network — but high enough to absorb
 * the parallel fan-out from `#rankOAuthSelections` into a single round-trip.
 */
const USAGE_CACHE_TTL_MS = 15_000;
const WAIT_THRESHOLD_MS = 1_000;
const MAX_WAIT_MS = 5_000;
const BACKGROUND_WAIT_MS = 30_000;
const BACKGROUND_BACKOFF_INITIAL_MS = 500;
const BACKGROUND_BACKOFF_MAX_MS = 30_000;

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
	reports: UsageReport[];
	fetchedAt: number;
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
	 * Called after broker-sourced full snapshots are applied. The constructor's
	 * initial snapshot intentionally does not trigger this hook.
	 */
	onSnapshot?: (snapshot: SnapshotResponse, generation: number) => void;
}

export class RemoteAuthCredentialStore implements AuthCredentialStore {
	readonly #client: AuthBrokerClient;
	readonly #streamSnapshots: boolean;
	readonly #onSnapshot?: (snapshot: SnapshotResponse, generation: number) => void;
	#snapshot: SnapshotResponse = emptySnapshot();
	#snapshotReceivedAt = Date.now();
	#generation = 0;
	#backgroundAbort = new AbortController();
	#cache: Map<string, CacheEntry> = new Map();
	#usageCache?: UsageCacheEntry;
	#usageInflight?: Promise<UsageReport[] | null>;
	#closed = false;
	/**
	 * `true` once the SSE consumer received its first frame and hasn't dropped
	 * since. Writes consult this to suppress the otherwise-mandatory
	 * `refreshSnapshot()` follow-up — the stream will deliver the new
	 * generation without an extra GET.
	 */
	#streamingActive = false;
	/** Latched once the broker has answered 404 — never try the stream again. */
	#streamingUnsupported = false;

	constructor(opts: RemoteAuthCredentialStoreOptions) {
		this.#client = opts.client;
		this.#streamSnapshots = opts.streamSnapshots ?? true;
		this.#applySnapshot(opts.initialSnapshot ?? emptySnapshot(), opts.initialSnapshot?.generation ?? 0);
		this.#onSnapshot = opts.onSnapshot;
		void this.#runBackground();
	}

	get client(): AuthBrokerClient {
		return this.#client;
	}

	get snapshot(): SnapshotResponse {
		return this.#snapshot;
	}

	#applySnapshot(snapshot: SnapshotResponse, generation: number): void {
		this.#snapshot = snapshot;
		this.#generation = generation;
		this.#snapshotReceivedAt = Date.now();
		const onSnapshot = this.#onSnapshot;
		if (!onSnapshot) return;
		try {
			onSnapshot(snapshot, generation);
		} catch (error) {
			logger.debug("auth-broker snapshot callback failed", { error: String(error) });
		}
	}

	async #runBackground(): Promise<void> {
		let backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
		while (!this.#closed && !this.#backgroundAbort.signal.aborted) {
			if (this.#streamSnapshots && !this.#streamingUnsupported) {
				try {
					await this.#consumeSnapshotStream();
					backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
					continue;
				} catch (error) {
					if (this.#closed || this.#backgroundAbort.signal.aborted) break;
					if (error instanceof AuthBrokerStreamUnsupportedError) {
						this.#streamingUnsupported = true;
						logger.debug("auth-broker snapshot stream unsupported; falling back to long-poll");
						continue;
					}
					logger.debug("auth-broker snapshot stream failed; backing off", { error: String(error) });
					await scheduler.wait(backoffMs, { signal: this.#backgroundAbort.signal }).catch(() => {});
					backoffMs = Math.min(BACKGROUND_BACKOFF_MAX_MS, backoffMs * 2);
					continue;
				}
			}
			try {
				const result = await this.#client.fetchSnapshot({
					ifGenerationGt: this.#generation,
					waitMs: BACKGROUND_WAIT_MS,
					signal: this.#backgroundAbort.signal,
				});
				if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation);
				backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
			} catch (error) {
				if (this.#closed || this.#backgroundAbort.signal.aborted) break;
				logger.debug("auth-broker background snapshot sync failed", { error: String(error) });
				await scheduler.wait(backoffMs, { signal: this.#backgroundAbort.signal }).catch(() => {});
				backoffMs = Math.min(BACKGROUND_BACKOFF_MAX_MS, backoffMs * 2);
			}
		}
	}

	async #consumeSnapshotStream(): Promise<void> {
		const iterator = this.#client.openSnapshotStream({ signal: this.#backgroundAbort.signal });
		try {
			for await (const event of iterator) {
				if (this.#closed || this.#backgroundAbort.signal.aborted) break;
				this.#streamingActive = true;
				this.#applyStreamEvent(event);
			}
		} finally {
			this.#streamingActive = false;
		}
	}

	#applyStreamEvent(event: SnapshotStreamEvent): void {
		switch (event.kind) {
			case "snapshot": {
				// Strip the discriminator so we store the wire-shape SnapshotResponse.
				const { kind: _kind, ...snapshot } = event;
				if (snapshot.generation < this.#generation) {
					logger.debug("auth-broker stream snapshot older than local; ignoring", {
						local: this.#generation,
						incoming: snapshot.generation,
					});
					return;
				}
				this.#applySnapshot(snapshot, snapshot.generation);
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

	#applyStreamEntry(
		entry: SnapshotEntry,
		refresher: RefresherSchedule,
		generation: number,
		serverNowMs: number,
	): void {
		const index = this.#snapshot.credentials.findIndex(candidate => candidate.id === entry.id);
		const credentials =
			index === -1
				? [...this.#snapshot.credentials, entry]
				: this.#snapshot.credentials.map((candidate, i) => (i === index ? entry : candidate));
		this.#snapshot = { ...this.#snapshot, generation, serverNowMs, refresher, credentials };
		this.#generation = generation;
		this.#snapshotReceivedAt = Date.now();
	}

	#removeStreamCredential(id: number, refresher: RefresherSchedule, generation: number, serverNowMs: number): void {
		const credentials = this.#snapshot.credentials.filter(entry => entry.id !== id);
		this.#snapshot = { ...this.#snapshot, generation, serverNowMs, refresher, credentials };
		this.#generation = generation;
		this.#snapshotReceivedAt = Date.now();
	}

	/** Re-hydrate the in-memory snapshot from the broker. */
	async refreshSnapshot(): Promise<SnapshotResponse> {
		const result = await this.#client.fetchSnapshot();
		if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation);
		return this.#snapshot;
	}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const out: StoredAuthCredential[] = [];
		for (const entry of this.#snapshot.credentials) {
			if (provider !== undefined && entry.provider !== provider) continue;
			out.push({
				id: entry.id,
				provider: entry.provider,
				credential: entry.credential as AuthCredential,
				disabledCause: null,
			});
		}
		return out;
	}

	/**
	 * In-memory update from a successful refresh through the broker. AuthStorage
	 * calls this after `#replaceCredentialAt`; the broker already persisted the
	 * authoritative row, so we just mirror it.
	 */
	updateAuthCredential(id: number, credential: AuthCredential): void {
		for (const entry of this.#snapshot.credentials) {
			if (entry.id !== id) continue;
			entry.credential = credential as typeof entry.credential;
			return;
		}
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		this.#removeCredentialById(id);
		// Fire-and-forget: tell the broker to persist the disable.
		this.#client.disableCredential(id, disabledCause).catch(error => {
			logger.warn("auth-broker disable propagation failed", { id, error: String(error) });
		});
	}

	async deleteAuthCredentialRemote(id: number, disabledCause: string): Promise<boolean> {
		const found = this.#snapshot.credentials.some(entry => entry.id === id);
		if (!found) return false;
		await this.#client.disableCredential(id, disabledCause);
		this.#removeCredentialById(id);
		this.#maybeRefreshSnapshot("delete credential");
		return true;
	}

	tryDisableAuthCredentialIfMatches(id: number, _expectedData: string, disabledCause: string): boolean {
		const found = this.#snapshot.credentials.find(entry => entry.id === id);
		if (!found) return false;
		this.deleteAuthCredential(id, disabledCause);
		return true;
	}

	async waitForFreshSnapshot(maxWaitMs: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
		const previousGeneration = this.#generation;
		const result = await this.#client.fetchSnapshot({
			ifGenerationGt: this.#generation,
			waitMs: maxWaitMs,
			signal: opts.signal,
		});
		if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation);
		return this.#generation !== previousGeneration;
	}

	async prepareForRequest(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (entry?.credential.type !== "oauth" || entry.rotatesInMs === null) return false;
		const remainingMs = this.#snapshotReceivedAt + entry.rotatesInMs - Date.now();
		if (remainingMs > WAIT_THRESHOLD_MS) return false;
		return this.waitForFreshSnapshot(MAX_WAIT_MS, opts);
	}

	async markCredentialSuspect(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
		const { entry } = await this.#client.refreshCredential(credentialId, opts.signal);
		if (entry.credential.type !== "oauth") {
			throw new AIError.AuthBrokerError(`Broker returned non-OAuth credential for id=${credentialId}`);
		}
		this.#applyCredentialEntry(entry);
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
	 * Logout: disable every active credential for the provider on the broker,
	 * then drop them from the local snapshot. Refresh fetches the authoritative
	 * post-state in the background.
	 */
	async deleteAuthCredentialsRemote(provider: string, disabledCause: string): Promise<void> {
		const existing = this.listAuthCredentials(provider);
		for (const entry of existing) {
			try {
				await this.#client.disableCredential(entry.id, disabledCause);
			} catch (error) {
				logger.warn("auth-broker disable during delete failed", {
					provider,
					id: entry.id,
					error: String(error),
				});
			}
		}
		this.#removeProviderEntries(provider);
		this.#maybeRefreshSnapshot("delete");
	}

	#applyProviderEntries(provider: string, entries: AuthCredentialSnapshotEntry[]): void {
		// `entries` is the broker's authoritative post-upsert list of rows for
		// `provider`. Drop our existing rows for the same provider and splice in
		// the fresh set — preserving every other provider's rows in place.
		const others = this.#snapshot.credentials.filter(entry => entry.provider !== provider);
		const incoming = entries.map(entry => ({ ...entry, rotatesInMs: null }));
		this.#snapshot = { ...this.#snapshot, credentials: [...others, ...incoming] };
	}
	#applyCredentialEntry(entry: AuthCredentialSnapshotEntry): void {
		const incoming = { ...entry, rotatesInMs: null };
		const index = this.#snapshot.credentials.findIndex(candidate => candidate.id === entry.id);
		if (index === -1) {
			this.#snapshot = { ...this.#snapshot, credentials: [...this.#snapshot.credentials, incoming] };
			return;
		}
		const credentials = [...this.#snapshot.credentials];
		credentials[index] = incoming;
		this.#snapshot = { ...this.#snapshot, credentials };
	}

	#removeProviderEntries(provider: string): void {
		const next = this.#snapshot.credentials.filter(entry => entry.provider !== provider);
		this.#snapshot = { ...this.#snapshot, credentials: next };
	}

	#removeCredentialById(id: number): void {
		const next = this.#snapshot.credentials.filter(entry => entry.id !== id);
		this.#snapshot = { ...this.#snapshot, credentials: next };
	}

	/**
	 * Fire-and-forget `refreshSnapshot()` after a write. When the SSE stream is
	 * active the broker will deliver the new generation push, so the extra GET
	 * is wasted bandwidth and we skip it.
	 */
	#maybeRefreshSnapshot(reason: string): void {
		if (this.#streamingActive) return;
		void this.refreshSnapshot().catch(error => {
			logger.debug("auth-broker snapshot refresh after write failed", { reason, error: String(error) });
		});
	}

	getCache(key: string): string | null {
		const entry = this.#cache.get(key);
		if (!entry) return null;
		if (entry.expiresAtSec * 1000 <= Date.now()) {
			this.#cache.delete(key);
			return null;
		}
		return entry.value;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#cache.set(key, { value, expiresAtSec });
	}

	cleanExpiredCache(): void {
		const nowSec = Math.floor(Date.now() / 1000);
		for (const [key, entry] of this.#cache) {
			if (entry.expiresAtSec <= nowSec) this.#cache.delete(key);
		}
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
		const { entry } = await this.#client.refreshCredential(credentialId, signal);
		if (!this.#streamingActive) {
			await this.refreshSnapshot().catch(error => {
				logger.debug("auth-broker snapshot refresh after credential refresh failed", { error: String(error) });
			});
		}
		if (entry.credential.type !== "oauth") {
			throw new AIError.AuthBrokerError(`Broker returned non-OAuth credential for id=${credentialId}`);
		}
		const refreshed = entry.credential;
		return {
			access: refreshed.access,
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: refreshed.expires,
			accountId: refreshed.accountId,
			email: refreshed.email,
			projectId: refreshed.projectId,
			enterpriseUrl: refreshed.enterpriseUrl,
		};
	}

	/**
	 * Store-level hook consumed by `AuthStorage.fetchUsageReports()` — proxies
	 * to the broker's `/v1/usage` endpoint. The broker's egress IP isn't
	 * rate-limited by Anthropic's per-IP `/usage` cap the way a heavy
	 * residential laptop is, so all credentials surface every cycle.
	 */
	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		return this.#raceWithSignal(this.#loadUsageReports(), signal);
	}

	/**
	 * Per-credential usage hook consumed by `AuthStorage.#getUsageReport`. Pulls
	 * the aggregate broker `/v1/usage` once and serves all callers from the
	 * same response (coalesced + cached), then matches the credential to a
	 * report by provider + identity (accountId / email / projectId).
	 *
	 * The broker already aggregates with its own 30s TTL on the server side; our
	 * 15s client TTL is below that so we usually re-use the broker's cache too.
	 */
	async getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<UsageReport | null> {
		const reports = await this.#raceWithSignal(this.#loadUsageReports(), signal);
		if (!reports) return null;
		return matchUsageReport(reports, provider, credential);
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

	#loadUsageReports(): Promise<UsageReport[] | null> {
		const cached = this.#usageCache;
		if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
			return Promise.resolve(cached.reports);
		}
		if (this.#usageInflight) return this.#usageInflight;
		const inflight = this.#client
			.fetchUsage()
			.then(body => {
				this.#usageCache = { reports: body.reports, fetchedAt: Date.now() };
				return body.reports;
			})
			.catch(error => {
				logger.warn("auth-broker usage fetch failed", { error: String(error) });
				return null;
			})
			.finally(() => {
				this.#usageInflight = undefined;
			});
		this.#usageInflight = inflight;
		return inflight;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#backgroundAbort.abort();
		this.#cache.clear();
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
	const candidates = reports.filter(report => report.provider === provider);
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0];
	const accountId = credential.accountId?.trim().toLowerCase();
	const email = credential.email?.trim().toLowerCase();
	const projectId = credential.projectId?.trim().toLowerCase();
	for (const report of candidates) {
		if (reportMatchesIdentity(report, accountId, email, projectId)) return report;
	}
	return null;
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
