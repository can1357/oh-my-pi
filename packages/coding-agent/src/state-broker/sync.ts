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
import {
	STATE_MAX_WAIT_MS,
	STATE_PAGE_LIMIT,
	type StateDeltaResponse,
	type StateDomainId,
	type StateEntry,
} from "./wire";

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Coarsest granularity of any domain's `rev` clock, in millis.
 *
 * Most domains use epoch millis, but `history` derives its rev from a column
 * stored in epoch SECONDS (`created_at * 1000`), so a prompt written at
 * `now = 1800` still gets `rev = 1000`. The outbound watermark must therefore
 * never reach into the current second, or a write landing later in that second
 * would come back with a rev at or below the watermark and be skipped forever.
 */
const REV_CLOCK_GRANULARITY_MS = 1000;

/**
 * Cap on remembered (key -> rev) pairs per domain. The ledger only needs to
 * cover rows sitting ABOVE the outbound watermark, which is bounded by clock
 * skew plus one sync interval; the cap is a safety valve, and an eviction costs
 * one redundant push that the broker rejects, never a lost row.
 */
const MAX_LEDGER_ENTRIES = 4096;

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
	/**
	 * Per-domain `key -> rev` ledger of rows this process must not push: rows it
	 * already pushed, and rows it just merged FROM the broker.
	 *
	 * Purely an echo suppressor, never a correctness mechanism. Losing it (fresh
	 * process, eviction) costs one redundant push per row, which the broker
	 * rejects because the rev is not newer. Correctness comes from the watermark
	 * rules in {@link #pushDomain} alone.
	 */
	readonly #ledgers = new Map<StateDomainId, Map<string, number>>();
	/**
	 * Settles after the first {@link syncOnce} returns, so a caller that is about
	 * to read replicated state can wait for the initial exchange instead of
	 * racing it. Never rejects: `syncOnce` isolates every domain, so a broker
	 * that is down simply settles this with nothing merged.
	 */
	readonly #firstCycle = Promise.withResolvers<void>();

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

	/**
	 * Resolve once the first push/pull cycle has completed, or after `timeoutMs`,
	 * whichever comes first. Never rejects and never throws on timeout.
	 *
	 * Startup needs this because {@link start} is deliberately fire-and-forget:
	 * the first cycle is what populates the remote session index, and the launch
	 * path lists and opens sessions within milliseconds of starting sync. Without
	 * the wait, a machine that just joined a project resolves `--resume` against
	 * an index that has not arrived yet and reports no match. The bound is what
	 * keeps an unreachable broker from turning into a hung startup.
	 */
	async waitForFirstCycle(timeoutMs: number): Promise<void> {
		if (timeoutMs <= 0) return;
		const timer = Promise.withResolvers<void>();
		const handle = setTimeout(() => timer.resolve(), timeoutMs);
		// `unref` so a pending bound never by itself keeps the process alive.
		handle.unref?.();
		try {
			await Promise.race([this.#firstCycle.promise, timer.promise]);
		} finally {
			clearTimeout(handle);
		}
	}

	/** Signal the loop to stop and release its timers. */
	stop(): void {
		this.#abort.abort();
		this.#loop = undefined;
		// A shutdown before the first cycle finished must not leave a startup
		// waiter blocked for the rest of its bound.
		this.#firstCycle.resolve();
	}

	async #run(): Promise<void> {
		while (!this.#abort.signal.aborted) {
			try {
				await this.syncOnce(this.#abort.signal);
			} finally {
				// Release startup even if the cycle threw, so a bug here degrades to
				// local-only rather than stalling the launch path for the full bound.
				this.#firstCycle.resolve();
			}
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
	 * Largest value the outbound watermark may take right now.
	 *
	 * The watermark's whole job is "every local row above this has been dealt
	 * with", so it must never pass a rev that a FUTURE local write could still
	 * be assigned. Local revs come from the local clock, so the bound is the
	 * current clock floored to the coarsest domain granularity, minus one.
	 *
	 * This is what stops a clock-skewed peer from silently disabling our own
	 * writes. Remote rows carry the ORIGINATING machine's clock, and merging one
	 * lands it in our local store; if the watermark were allowed to follow a rev
	 * from a peer whose clock is ahead of ours, every local write below that rev
	 * would fail the `rev > outboundRev` scan and never be pushed until our
	 * clock caught up.
	 */
	#watermarkCeiling(): number {
		return Math.floor(Date.now() / REV_CLOCK_GRANULARITY_MS) * REV_CLOCK_GRANULARITY_MS - 1;
	}

	#ledgerFor(id: StateDomainId): Map<string, number> {
		let ledger = this.#ledgers.get(id);
		if (!ledger) {
			ledger = new Map<string, number>();
			this.#ledgers.set(id, ledger);
		}
		return ledger;
	}

	/**
	 * Forget rows the watermark now covers — the `rev > outboundRev` scan already
	 * excludes them, so remembering them buys nothing. Also enforces the cap, in
	 * ledger iteration order (oldest insertion first), because those are the
	 * rows the watermark reaches soonest.
	 */
	#pruneLedger(ledger: Map<string, number>, outboundRev: number): void {
		for (const [key, rev] of ledger) {
			if (rev <= outboundRev) ledger.delete(key);
		}
		if (ledger.size <= MAX_LEDGER_ENTRIES) return;
		const excess = ledger.size - MAX_LEDGER_ENTRIES;
		let dropped = 0;
		for (const key of ledger.keys()) {
			ledger.delete(key);
			if (++dropped >= excess) break;
		}
	}

	/**
	 * Push local pages until a short page proves the backlog is drained.
	 *
	 * Three rules keep this convergent, and each one is load-bearing:
	 *
	 * 1. The watermark advances to the last SCANNED rev, not the last pushed
	 *    one, so a page consisting entirely of suppressed echoes still makes
	 *    progress instead of being rescanned forever.
	 * 2. It is clamped to {@link #watermarkCeiling}, so it can never move past a
	 *    rev that a later local write could still be assigned.
	 * 3. If those two leave the watermark where it was, we stop. Without this
	 *    the loop would spin on a full page of future-dated rows that the clamp
	 *    refuses to skip. Retrying next cycle is correct and eventually
	 *    succeeds, since the ceiling rises with the clock.
	 *
	 * Because `changedSince` is ascending-`rev`, a mid-loop failure simply
	 * leaves the cursor where it was and the same page retries next cycle.
	 */
	async #pushDomain(cursor: SyncCursor, domain: ReplicatedDomain, signal?: AbortSignal): Promise<boolean> {
		let pushed = false;
		const ledger = this.#ledgerFor(domain.id);
		for (;;) {
			if (signal?.aborted) break;
			const page = domain.changedSince(cursor.outboundRev, STATE_PAGE_LIMIT);
			if (page.length === 0) break;
			// A saturated page can cut a group of rows sharing one `rev` in half.
			// Since every scan filters `rev > outboundRev` STRICTLY, advancing onto
			// that shared rev would permanently skip the rest of the group. So stop
			// at the last rev the page covers completely.
			//
			// Ties are not exotic: `history`, `titles`, `model-usage` and
			// `command-usage` derive their rev from a whole-second column, and a
			// bulk copy or archive extraction can stamp thousands of config files
			// with one mtime (a filesystem with 1s mtime granularity guarantees it).
			const batch = this.#completeRevPrefix(page);
			if (batch.length === 0) {
				// One rev fills the whole page, so there is no complete rev to stop
				// at and no way to page within a single rev through a rev-only
				// cursor. Push what we have, then STALL this domain rather than
				// advance and lose the remainder. Recoverable: any later write to
				// one of these rows gives it a new rev.
				await this.#pushBatch(domain.id, page, ledger, signal);
				logger.warn(
					`[state:${domain.id}] ${page.length} rows share rev ${page[0].rev}; replication of this domain is paused until one of them changes`,
				);
				return true;
			}
			const scannedRev = batch[batch.length - 1].rev;
			if (await this.#pushBatch(domain.id, batch, ledger, signal)) pushed = true;
			const nextRev = Math.min(scannedRev, this.#watermarkCeiling());
			if (nextRev <= cursor.outboundRev) break;
			cursor.outboundRev = nextRev;
			this.#store.set(domain.id, cursor);
			this.#pruneLedger(ledger, cursor.outboundRev);
			// Saturation is a property of the PAGE, not of the trimmed batch: a
			// trailing tie shortens the batch while more rows plainly remain, so
			// testing the batch here would stop the drain one page in.
			if (page.length < STATE_PAGE_LIMIT) break;
		}
		return pushed;
	}

	/**
	 * The leading run of `page` that covers only revs the page holds in FULL.
	 *
	 * A page is only known to be complete for a rev if the page ends after that
	 * rev's last row. When the page is saturated its final rev may continue past
	 * the limit, so those trailing rows are excluded and re-read next iteration.
	 * An unsaturated page is complete by definition: the scan had nothing more
	 * to give.
	 *
	 * Returns `[]` only when a saturated page is entirely one rev, which no
	 * rev-only cursor can page through.
	 */
	#completeRevPrefix(page: readonly StateEntry[]): readonly StateEntry[] {
		if (page.length < STATE_PAGE_LIMIT) return page;
		const lastRev = page[page.length - 1].rev;
		let end = page.length;
		while (end > 0 && page[end - 1].rev === lastRev) end--;
		return end === 0 ? [] : page.slice(0, end);
	}

	/**
	 * Push the rows of `batch` the ledger does not already account for, and
	 * record what was sent. Returns whether anything went out.
	 */
	async #pushBatch(
		id: StateDomainId,
		batch: readonly StateEntry[],
		ledger: Map<string, number>,
		signal?: AbortSignal,
	): Promise<boolean> {
		// Drop rows we already sent at this exact rev, and rows we merged from
		// the broker at this exact rev — pushing either back is pure noise.
		const sendable = batch.filter(entry => ledger.get(entry.key) !== entry.rev);
		if (sendable.length === 0) return false;
		await this.#client.push(id, sendable, signal);
		for (const entry of sendable) ledger.set(entry.key, entry.rev);
		return true;
	}

	/**
	 * Pull remote deltas and merge them, advancing `inboundSeq` as we go and
	 * repeating while the broker reports `more`. Only the first request may
	 * long-poll; once entries arrive we drain the rest with `waitMs=0`.
	 *
	 * Note what this does NOT touch: `outboundRev`. Merged rows land in our own
	 * local store and so would reappear in the next `changedSince`, and the
	 * tempting fix is to jump the outbound watermark past every rev just
	 * applied. That silently drops local writes whenever a peer's clock runs
	 * ahead of ours — see {@link #watermarkCeiling}. Echo suppression is the
	 * ledger's job, and only the ledger's.
	 */
	async #pullDomain(
		cursor: SyncCursor,
		domain: ReplicatedDomain,
		longPoll: boolean,
		signal?: AbortSignal,
	): Promise<boolean> {
		let pulled = false;
		let first = true;
		let recovered = false;
		for (;;) {
			if (signal?.aborted) break;
			const waitMs = longPoll && first ? this.#pullWaitMs : 0;
			first = false;
			const delta = await this.#client.delta(domain.id, cursor.inboundSeq, {
				waitMs,
				limit: STATE_PAGE_LIMIT,
				signal,
			});

			// Is our cursor even meaningful against the database that answered? A
			// `seq` is only monotonic within one broker database, so a recreated or
			// restored `state.db` can leave us holding a cursor it will not reach
			// for a long time. The delta would then keep echoing that cursor back
			// in an empty page while we ignored every entry the broker accepted.
			// Recover at most once per pass, so a broker that reports nonsense
			// cannot spin us.
			if (!recovered && this.#rollbackDetected(delta, cursor.inboundSeq)) {
				recovered = true;
				const stale = cursor.inboundSeq;
				if (delta.epoch) this.#store.adoptBrokerEpoch(delta.epoch);
				cursor.inboundSeq = 0;
				this.#store.set(domain.id, cursor);
				logger.warn("state sync broker sequence rolled back; replaying inbound from zero", {
					domain: domain.id,
					staleCursor: stale,
					head: delta.head,
				});
				continue;
			}
			if (delta.entries.length > 0) {
				domain.applyRemote(delta.entries);
				pulled = true;
				// Remember what we merged, at the rev we merged it at, so the next
				// push does not bounce it straight back. Domains that write a real
				// file pin its mtime to the remote rev for exactly this reason, so
				// the rev a later scan reports matches what we record here.
				const ledger = this.#ledgerFor(domain.id);
				for (const entry of delta.entries) ledger.set(entry.key, entry.rev);
				this.#pruneLedger(ledger, cursor.outboundRev);
			}
			cursor.inboundSeq = delta.seq;
			this.#store.set(domain.id, cursor);
			if (!delta.more) break;
		}
		return pulled;
	}

	/**
	 * Whether `delta` proves our persisted inbound cursor cannot be honoured.
	 *
	 * Two independent signals, because neither covers the other:
	 *
	 * - **Identity changed.** The broker database was recreated, so its `seq`
	 *   restarted from zero. Detected even when the new database has already
	 *   allocated PAST our cursor, which no sequence comparison can see.
	 * - **Head went backwards.** Same database, restored from an older backup,
	 *   so the epoch is unchanged but entries we were told about are gone.
	 *
	 * A broker predating these fields sends neither, and this returns false, so
	 * behaviour against an older broker is exactly what it was before.
	 */
	#rollbackDetected(delta: StateDeltaResponse, inboundSeq: number): boolean {
		if (delta.epoch) {
			const known = this.#store.brokerEpoch();
			// First sight is not a rollback: an existing replica upgrading from a
			// broker that did not report an epoch has perfectly good cursors, so
			// record the identity WITHOUT resetting them.
			if (known === undefined) this.#store.rememberBrokerEpoch(delta.epoch);
			else if (known !== delta.epoch) return true;
		}
		return delta.head !== undefined && delta.head < inboundSeq;
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
