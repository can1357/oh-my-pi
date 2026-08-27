/**
 * Background replication loop between the local databases and the state broker.
 *
 * One {@link StateSyncEngine} drives every {@link ReplicatedDomain}: it pushes
 * local deltas up and pulls remote deltas down on a per-domain cycle, tracking
 * progress through {@link StateSyncStore} cursors. It mirrors the resilience
 * shape of `RemoteAuthCredentialStore`: failures degrade to local-only
 * operation (logged, never thrown at a caller), timers are `unref()`d so a
 * leaked engine never pins the process, and an idle client long-polls instead
 * of spinning on a fixed interval.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { HTTP_CLIENT_CLOSED, type StateBrokerClient, StateBrokerError } from "./client";
import type { ReplicatedDomain, StateSyncStore, SyncCursor } from "./replica";
import { STATE_MAX_WAIT_MS, STATE_PAGE_LIMIT, type StateDomainId } from "./wire";

const DEFAULT_INTERVAL_MS = 30_000;

export interface StateSyncEngineOptions {
	client: StateBrokerClient;
	domains: readonly ReplicatedDomain[];
	store: StateSyncStore;
	/** Delay between active sync cycles. Default 30s. */
	intervalMs?: number;
}

export class StateSyncEngine {
	readonly #client: StateBrokerClient;
	readonly #domains: readonly ReplicatedDomain[];
	readonly #store: StateSyncStore;
	readonly #intervalMs: number;
	/** Long-poll wait applied to pulls once the client has gone idle. */
	readonly #pullWaitMs: number;

	#abort = new AbortController();
	#loop: Promise<void> | undefined;
	/**
	 * `true` after a cycle that observed no local pushes and no remote pulls —
	 * the next cycle then long-polls instead of spinning. Starts `false` so the
	 * first cycle drains any backlog eagerly.
	 */
	#idle = false;
	/** Domains currently in a failure state; used to warn once per transition. */
	readonly #failing = new Set<StateDomainId>();

	constructor(opts: StateSyncEngineOptions) {
		this.#client = opts.client;
		this.#domains = opts.domains;
		this.#store = opts.store;
		this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
		// An idle pull waits the full ceiling so a quiet client blocks on one long
		// request instead of spinning; the broker returns early on any change.
		this.#pullWaitMs = STATE_MAX_WAIT_MS;
	}

	/** Begin the background loop. Idempotent while already running. */
	start(): void {
		if (this.#loop) return;
		this.#abort = new AbortController();
		this.#loop = this.#run();
	}

	/** Signal the loop to stop and release its timers. */
	stop(): void {
		this.#abort.abort();
		this.#loop = undefined;
	}

	async #run(): Promise<void> {
		while (!this.#abort.signal.aborted) {
			await this.syncOnce(this.#abort.signal);
			if (this.#abort.signal.aborted) break;
			// When idle, `syncOnce` already blocked on a long-poll (up to
			// STATE_MAX_WAIT_MS) so the cycle was cheap; sleep the fixed interval
			// only while actively draining changes.
			if (!this.#idle) await this.#sleep(this.#intervalMs);
		}
	}

	/**
	 * Run one push-then-pull cycle over every domain. Never throws: each domain
	 * is isolated so one broken store cannot stall the others, and a dead broker
	 * degrades to local-only operation with a single warn line per failure.
	 *
	 * Domains run concurrently, which is load-bearing rather than an
	 * optimization: an idle pull long-polls for up to
	 * {@link STATE_MAX_WAIT_MS}, so a sequential loop would make one idle cycle
	 * cost `domains × 30s` and delay noticing a change in the last domain by
	 * minutes. Concurrency is safe because domains touch disjoint stores and
	 * cursor rows, and every {@link StateSyncStore} access is an individually
	 * atomic synchronous statement.
	 */
	async syncOnce(signal?: AbortSignal): Promise<void> {
		const longPoll = this.#idle;
		const outcomes = await Promise.all(
			this.#domains.map(async domain => {
				if (signal?.aborted) return false;
				try {
					const cursor = this.#store.get(domain.id);
					// PUSH before PULL: flushing local edits first means a stale
					// remote row pulled in the same cycle cannot clobber a change we
					// just made.
					let changed = await this.#pushDomain(cursor, domain, signal);
					changed = (await this.#pullDomain(cursor, domain, longPoll, signal)) || changed;
					this.#clearFailure(domain.id);
					return changed;
				} catch (error) {
					// A caller-driven abort is a clean shutdown, not a broker failure.
					if (!signal?.aborted) this.#noteFailure(domain.id, error);
					return false;
				}
			}),
		);
		this.#idle = !outcomes.some(Boolean);
	}

	/**
	 * Push local pages until a short page proves the backlog is drained. On
	 * success `outboundRev` advances to the last entry's `rev` and is persisted;
	 * because `changedSince` is ascending-`rev`, a mid-loop failure simply leaves
	 * the cursor where it was and the same page retries next cycle.
	 */
	async #pushDomain(cursor: SyncCursor, domain: ReplicatedDomain, signal?: AbortSignal): Promise<boolean> {
		let pushed = false;
		for (;;) {
			if (signal?.aborted) break;
			const page = domain.changedSince(cursor.outboundRev, STATE_PAGE_LIMIT);
			if (page.length === 0) break;
			await this.#client.push(domain.id, page, signal);
			cursor.outboundRev = page[page.length - 1].rev;
			this.#store.set(domain.id, cursor);
			pushed = true;
			if (page.length < STATE_PAGE_LIMIT) break;
		}
		return pushed;
	}

	/**
	 * Pull remote deltas and merge them, advancing `inboundSeq` as we go and
	 * repeating while the broker reports `more`. Only the first request may
	 * long-poll; once entries arrive we drain the rest with `waitMs=0`.
	 */
	async #pullDomain(
		cursor: SyncCursor,
		domain: ReplicatedDomain,
		longPoll: boolean,
		signal?: AbortSignal,
	): Promise<boolean> {
		let pulled = false;
		let first = true;
		for (;;) {
			if (signal?.aborted) break;
			const waitMs = longPoll && first ? this.#pullWaitMs : 0;
			first = false;
			const delta = await this.#client.delta(domain.id, cursor.inboundSeq, {
				waitMs,
				limit: STATE_PAGE_LIMIT,
				signal,
			});
			if (delta.entries.length > 0) {
				domain.applyRemote(delta.entries);
				pulled = true;
				// ECHO-STORM SUPPRESSION: applyRemote writes these rows into our own
				// local store, so they would reappear in the next changedSince() and
				// be pushed straight back to the broker — an endless echo between
				// peers. Advance outboundRev past every rev we just applied so those
				// rows are treated as already-pushed and never bounce back.
				let maxRev = cursor.outboundRev;
				for (const entry of delta.entries) {
					if (entry.rev > maxRev) maxRev = entry.rev;
				}
				cursor.outboundRev = maxRev;
			}
			cursor.inboundSeq = delta.seq;
			this.#store.set(domain.id, cursor);
			if (!delta.more) break;
		}
		return pulled;
	}

	/**
	 * Flush deferred domain writes then run one final push-only pass, so rows
	 * merged or queued right before shutdown still reach the broker. Pull is
	 * skipped: inbound data is worthless to a process that is exiting.
	 */
	async drain(): Promise<void> {
		for (const domain of this.#domains) {
			try {
				await domain.drain?.();
			} catch (error) {
				this.#noteFailure(domain.id, error);
			}
		}
		for (const domain of this.#domains) {
			try {
				const cursor = this.#store.get(domain.id);
				await this.#pushDomain(cursor, domain);
				this.#clearFailure(domain.id);
			} catch (error) {
				this.#noteFailure(domain.id, error);
			}
		}
	}

	/** Sleep on an unref'd timer that resolves early on `stop()`. */
	#sleep(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (this.#abort.signal.aborted) {
			resolve();
			return promise;
		}
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		this.#abort.signal.addEventListener("abort", onAbort, { once: true });
		return promise.finally(() => this.#abort.signal.removeEventListener("abort", onAbort));
	}

	/**
	 * Warn on the transition into failure, then drop to debug while a domain is
	 * still failing so an unreachable broker does not spam a warn line every
	 * cycle.
	 *
	 * A 4xx is treated differently: the broker rejected the *content* of our
	 * request, so retrying is futile and the cause is a client/schema bug rather
	 * than an outage. Those are reported at `error` with the response body every
	 * time, because latching one to `debug` is how a domain silently stops
	 * replicating for the rest of the process's life.
	 */
	#noteFailure(id: StateDomainId, error: unknown): void {
		const status = error instanceof StateBrokerError ? error.status : undefined;
		if (status !== undefined && status >= 400 && status < 500 && status !== HTTP_CLIENT_CLOSED) {
			logger.error("state sync domain rejected by broker", {
				domain: id,
				status,
				body: error instanceof StateBrokerError ? error.body : undefined,
			});
			this.#failing.add(id);
			return;
		}
		if (this.#failing.has(id)) {
			logger.debug("state sync domain still failing", { domain: id, error: String(error) });
			return;
		}
		this.#failing.add(id);
		logger.warn("state sync domain failed", { domain: id, error: String(error) });
	}

	/** Reset the failure latch once a domain syncs cleanly again. */
	#clearFailure(id: StateDomainId): void {
		if (this.#failing.delete(id)) {
			logger.debug("state sync domain recovered", { domain: id });
		}
	}
}
