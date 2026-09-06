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
	type AuthCredential,
	type AuthCredentialSnapshotEntry,
	type AuthCredentialStore,
	type DisabledCredentialSummary,
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
	entry: Pick<SnapshotEntry, "provider" | "credential" | "identityKey">,
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
const USAGE_CACHE_TTL_MS = 15_000;
const CREDENTIAL_BLOCK_RECONCILE_DELAY_MS = 5 * 60_000;
const WAIT_THRESHOLD_MS = 1_000;
const MAX_WAIT_MS = 5_000;
const BACKGROUND_WAIT_MS = 30_000;
const BACKGROUND_BACKOFF_INITIAL_MS = 500;
const BACKGROUND_BACKOFF_MAX_MS = 30_000;
/** Idle window after the last foreground store use before background sync parks. */
const BACKGROUND_IDLE_MS = 20_000;

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
			...(base.metadata ?? {}),
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

export class RemoteAuthCredentialStore implements AuthCredentialStore {
	readonly #client: AuthBrokerClient;
	readonly #streamSnapshots: boolean;
	readonly #onSnapshot?: (snapshot: SnapshotResponse, generation: number) => void;
	readonly #accountPool?: AuthBrokerAccountPool;
	#snapshot: SnapshotResponse = emptySnapshot();
	#snapshotReceivedAt = Date.now();
	#generation = 0;
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

	#applySnapshot(snapshot: SnapshotResponse, generation: number, protectNewBlocks = true): void {
		const nowMs = Date.now();
		this.#replaceBrokerUsageAccounts(snapshot.credentials);
		const previousCredentials = this.#snapshot.credentials;
		const credentials = snapshot.credentials
			.filter(entry => isCredentialInAccountPool(entry, this.#accountPool))
			.map(entry => this.#normalizeSnapshotEntryBlocks(entry, nowMs));
		if (snapshotBlocksChanged(previousCredentials, credentials)) this.#invalidateUsageCache();
		if (protectNewBlocks) this.#protectNewSnapshotBlocks(previousCredentials, credentials, nowMs);
		this.#snapshot = { ...snapshot, credentials };
		this.#generation = generation;
		this.#snapshotReceivedAt = nowMs;
		const onSnapshot = this.#onSnapshot;
		if (!onSnapshot) return;
		try {
			onSnapshot(snapshot, generation);
		} catch (error) {
			logger.debug("auth-broker snapshot callback failed", { error: String(error) });
		}
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
						logger.debug("auth-broker snapshot stream failed; backing off", { error: String(error) });
						await this.#backoffWait(backoffMs);
						backoffMs = Math.min(BACKGROUND_BACKOFF_MAX_MS, backoffMs * 2);
					}
					continue;
				}
				try {
					const result = await this.#client.fetchSnapshot({
						ifGenerationGt: this.#generation,
						waitMs: BACKGROUND_WAIT_MS,
						signal: watchdog.signal,
					});
					if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation);
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
		const iterator = this.#client.openSnapshotStream({ signal });
		try {
			for await (const event of iterator) {
				if (this.#closed || signal.aborted) break;
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
		this.#upsertBrokerUsageAccount(entry);
		if (!isCredentialInAccountPool(entry, this.#accountPool)) {
			this.#removeStreamCredential(entry.id, refresher, generation, serverNowMs, { retainBrokerUsageAccount: true });
			return;
		}
		const incoming = this.#normalizeSnapshotEntryBlocks(entry, Date.now());
		const index = this.#snapshot.credentials.findIndex(candidate => candidate.id === incoming.id);
		const previousBlocks = index === -1 ? undefined : this.#snapshot.credentials[index]?.blocks;
		const blocksChanged = !credentialBlockSnapshotsEqual(previousBlocks, incoming.blocks);
		if (blocksChanged) this.#invalidateUsageCache();
		const credentials =
			index === -1
				? [...this.#snapshot.credentials, incoming]
				: this.#snapshot.credentials.map((candidate, i) => (i === index ? incoming : candidate));
		if (blocksChanged) this.#protectNewSnapshotBlocks(this.#snapshot.credentials, credentials, Date.now());
		this.#snapshot = { ...this.#snapshot, generation, serverNowMs, refresher, credentials };
		this.#generation = generation;
		this.#snapshotReceivedAt = Date.now();
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
		if (removed?.blocks && removed.blocks.length > 0) this.#invalidateUsageCache();
		const credentials = this.#snapshot.credentials.filter(entry => entry.id !== id);
		this.#snapshot = { ...this.#snapshot, generation, serverNowMs, refresher, credentials };
		this.#generation = generation;
		this.#snapshotReceivedAt = Date.now();
	}

	/** Re-hydrate the in-memory snapshot from the broker. */
	async refreshSnapshot(): Promise<SnapshotResponse> {
		this.#noteActivity();
		const result = await this.#client.fetchSnapshot();
		if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation);
		return this.#snapshot;
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
				disabledCause: null,
			});
		}
		return out;
	}

	/** Broker-backed disabled tombstones; empty against brokers predating the endpoint. */
	listDisabledCredentials(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]> {
		this.#noteActivity();
		return this.#client.listDisabledCredentials(provider, signal);
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
			entry.credential = credential as typeof entry.credential;
			return;
		}
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		this.#noteActivity();
		this.#removeCredentialById(id);
		// Fire-and-forget: tell the broker to persist the disable.
		this.#client.disableCredential(id, disabledCause).catch(error => {
			logger.warn("auth-broker disable propagation failed", { id, error: String(error) });
		});
	}

	async deleteAuthCredentialRemote(id: number, disabledCause: string): Promise<boolean> {
		this.#noteActivity();
		const found = this.#snapshot.credentials.some(entry => entry.id === id);
		if (!found) return false;
		await this.#client.disableCredential(id, disabledCause);
		this.#removeCredentialById(id);
		this.#maybeRefreshSnapshot("delete credential");
		return true;
	}

	tryDisableAuthCredentialIfMatches(id: number, _expectedData: string, disabledCause: string): boolean {
		this.#noteActivity();
		const found = this.#snapshot.credentials.find(entry => entry.id === id);
		if (!found) return false;
		this.deleteAuthCredential(id, disabledCause);
		return true;
	}

	async waitForFreshSnapshot(maxWaitMs: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
		this.#noteActivity();
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
			logger.debug("auth-broker snapshot refresh after write failed", { reason, error: String(error) });
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
				logger.debug("auth-broker snapshot refresh after credential refresh failed", { error: String(error) });
			});
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
				logger.debug("auth-broker observed usage flush failed; retrying next flush", { error: String(error) });
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
