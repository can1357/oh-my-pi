import { type AgentMessage, ASIDE_MESSAGE_COMMIT, ASIDE_MESSAGE_DISCARD } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";

export interface YieldDispatcher<P> {
	/** Drop entries already delivered through another path. Called per-entry at flush time. */
	isStale?(entry: P): boolean;
	/** Produce one batched AgentMessage from non-stale entries. Return null to skip. */
	build(survivors: P[]): AgentMessage | null;
	/** If true, entries for this kind are drained only by {@link drainLazy} and never trigger the idle flush. */
	skipIdleFlush?: boolean;
	/**
	 * Budget for model turns this kind may start on its own. At an idle flush
	 * the kind starts a turn only when `tryAcquire()` returns `0`; otherwise
	 * its entries stay queued and the flush is retried after the returned
	 * delay (ms). A budgeted kind rides along for free whenever another kind
	 * (or an already-granted budgeted kind) starts the turn, and still injects
	 * at streaming step boundaries — the budget gates only turns the model
	 * would not otherwise take.
	 */
	idleTurnBudget?: { tryAcquire(): number };
	/** Group key for enqueue-time coalescing; a queued entry with the same key folds via {@link coalesce}. */
	coalesceKey?(entry: P): string;
	/** Fold an incoming entry into the queued entry with the same key; the result replaces the queued entry. */
	coalesce?(queued: P, incoming: P): P;
}

export interface YieldQueueOptions {
	isStreaming: () => boolean;
	injectStreaming?(msg: AgentMessage): void;
	injectIdle(messages: AgentMessage[]): Promise<void>;
	scheduleIdleFlush(run: () => Promise<void>): void;
}

type YieldFlushMode = "streaming" | "idle";

interface StoredDispatcher {
	isStale?: (entry: unknown) => boolean;
	build: (survivors: unknown[]) => AgentMessage | null;
	skipIdleFlush?: boolean;
	idleTurnBudget?: { tryAcquire(): number };
	coalesceKey?: (entry: unknown) => string;
	coalesce?: (queued: unknown, incoming: unknown) => unknown;
}

interface StoredEntry {
	value: unknown;
	resolve?: () => void;
	reject?: (error: Error) => void;
}

interface BuiltMessage {
	kind: string;
	/** {@link YieldQueue.#clearGeneration} at build time; a later clear() forbids restoring these entries. */
	generation: number;
	message: AgentMessage;
	entries: StoredEntry[];
}

/** Delay before an idle flush whose injection was rejected is retried. */
const IDLE_DISCARD_RETRY_MS = 1_000;
/** Consecutive rejected idle injections retried on a timer before restored entries wait for the next enqueue or step boundary. */
const IDLE_DISCARD_RETRY_LIMIT = 3;

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class YieldQueue {
	readonly #options: YieldQueueOptions;
	readonly #dispatchers = new Map<string, StoredDispatcher>();
	readonly #entries = new Map<string, StoredEntry[]>();
	#idleFlushPending = false;
	#idleFlushRunning = false;
	#clearGeneration = 0;
	/** Retry timer for an idle flush a kind's turn budget held back or whose injection was rejected. */
	#deferredIdleFlushTimer: NodeJS.Timeout | undefined;
	#deferredIdleFlushDue = 0;
	/** Consecutive idle injections rejected since the last one that was accepted. */
	#idleDiscardRetries = 0;
	#idleFlushSettledWaiters: Array<() => void> = [];

	constructor(options: YieldQueueOptions) {
		this.#options = options;
	}

	register<P>(kind: string, dispatcher: YieldDispatcher<P>): () => void {
		const stored: StoredDispatcher = {
			...(dispatcher.isStale ? { isStale: entry => dispatcher.isStale?.(entry as P) ?? false } : {}),
			build: survivors => dispatcher.build(survivors as P[]),
			...(dispatcher.skipIdleFlush ? { skipIdleFlush: true } : {}),
			...(dispatcher.idleTurnBudget ? { idleTurnBudget: dispatcher.idleTurnBudget } : {}),
			...(dispatcher.coalesceKey && dispatcher.coalesce
				? {
						coalesceKey: (entry: unknown) => dispatcher.coalesceKey!(entry as P),
						coalesce: (queued: unknown, incoming: unknown) => dispatcher.coalesce!(queued as P, incoming as P),
					}
				: {}),
		};
		this.#dispatchers.set(kind, stored);
		return () => {
			if (this.#dispatchers.get(kind) !== stored) return;
			this.#dispatchers.delete(kind);
			this.#rejectEntries(this.#entries.get(kind) ?? [], new Error(`Yield queue dispatcher removed: ${kind}`));
			this.#entries.delete(kind);
			this.#settleDeferredIdleFlush();
		};
	}

	enqueue<P>(kind: string, entry: P): void {
		this.#enqueue(kind, { value: entry });
	}

	enqueueWithReceipt<P>(kind: string, entry: P): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		if (!this.#enqueue(kind, { value: entry, resolve, reject })) {
			reject(new Error(`Yield queue entry ignored for unregistered kind: ${kind}`));
		}
		return promise;
	}

	#enqueue(kind: string, entry: StoredEntry): boolean {
		const dispatcher = this.#dispatchers.get(kind);
		if (!dispatcher) {
			logger.warn("Yield queue entry ignored for unregistered kind", { kind });
			return false;
		}
		let entries = this.#entries.get(kind);
		if (!entries) {
			entries = [];
			this.#entries.set(kind, entries);
		}
		if (!this.#coalesce(dispatcher, entries, entry)) {
			entries.push(entry);
		}
		if (!this.#options.isStreaming() && !dispatcher.skipIdleFlush) {
			this.#scheduleIdleFlush();
		}
		return true;
	}

	/**
	 * Fold `entry` into an already-queued entry with the same coalesce key so a
	 * sustained producer (e.g. ambient job progress while the owner is idle)
	 * keeps ONE bounded entry per key instead of growing the queue without
	 * limit. Entries carrying a settlement receipt are never folded — their
	 * resolve/reject must observe their own dispatch.
	 */
	#coalesce(dispatcher: StoredDispatcher, entries: StoredEntry[], entry: StoredEntry): boolean {
		if (!dispatcher.coalesceKey || !dispatcher.coalesce) return false;
		if (entry.resolve || entry.reject) return false;
		const key = dispatcher.coalesceKey(entry.value);
		for (let index = entries.length - 1; index >= 0; index--) {
			const queued = entries[index];
			if (queued.resolve || queued.reject) continue;
			if (dispatcher.coalesceKey(queued.value) !== key) continue;
			queued.value = dispatcher.coalesce(queued.value, entry.value);
			return true;
		}
		return false;
	}

	has(kind?: string): boolean {
		if (kind !== undefined) return (this.#entries.get(kind)?.length ?? 0) > 0;
		for (const entries of this.#entries.values()) {
			if (entries.length > 0) return true;
		}
		return false;
	}

	/**
	 * Remove and return queued entries matching `predicate`, e.g. to promote
	 * them to a kind that participates in the idle flush. Entries carrying a
	 * settlement receipt stay queued — their resolve/reject must observe their
	 * own dispatch.
	 */
	take<P>(kind: string, predicate: (entry: P) => boolean): P[] {
		const entries = this.#entries.get(kind);
		if (!entries || entries.length === 0) return [];
		const taken: P[] = [];
		const kept: StoredEntry[] = [];
		for (const entry of entries) {
			if (entry.resolve === undefined && entry.reject === undefined && predicate(entry.value as P)) {
				taken.push(entry.value as P);
			} else {
				kept.push(entry);
			}
		}
		if (taken.length === 0) return taken;
		if (kept.length === 0) this.#entries.delete(kind);
		else this.#entries.set(kind, kept);
		return taken;
	}

	/** Arrange an idle flush for entries queued near the end of a streaming run. */
	requestIdleFlush(): void {
		for (const [kind, dispatcher] of this.#dispatchers) {
			if (!dispatcher.skipIdleFlush && this.has(kind)) {
				this.#scheduleIdleFlush();
				return;
			}
		}
	}

	async flush(mode: YieldFlushMode): Promise<void> {
		if (mode === "streaming") {
			this.#flushStreaming();
			return;
		}
		this.#idleFlushPending = false;
		this.#idleFlushRunning = true;
		try {
			await this.#flushIdle();
		} finally {
			this.#idleFlushRunning = false;
			// A turn started by another kind drains budgeted entries for free;
			// the retry their budget armed has nothing left to carry.
			this.#settleDeferredIdleFlush();
			this.#settleIdleFlushWaiters();
		}
	}

	#flushStreaming(): void {
		for (const [kind, dispatcher] of this.#dispatchers) {
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			const built = this.#build(kind, dispatcher, entries);
			if (!built) continue;
			try {
				if (!this.#options.injectStreaming) throw new Error("Streaming injection is unavailable");
				this.#options.injectStreaming(built.message);
				this.#resolveEntries(built.entries);
			} catch (error) {
				const dispatchError = error instanceof Error ? error : new Error(String(error));
				this.#rejectEntries(built.entries, dispatchError);
				logger.warn("Yield queue streaming dispatch failed", { kind, error: formatError(error) });
			}
		}
		this.#settleDeferredIdleFlush();
	}

	async #flushIdle(): Promise<void> {
		// Build every eligible kind first (registration order is delivery
		// order), then decide which may start the turn: any unbudgeted kind
		// grants it outright, and once granted every budgeted kind rides along
		// without spending a permit.
		const candidates: Array<{ built: BuiltMessage; budget: StoredDispatcher["idleTurnBudget"] }> = [];
		let turnGranted = false;
		for (const [kind, dispatcher] of this.#dispatchers) {
			if (dispatcher.skipIdleFlush) continue;
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			const built = this.#build(kind, dispatcher, entries);
			if (!built) continue;
			candidates.push({ built, budget: dispatcher.idleTurnBudget });
			if (!dispatcher.idleTurnBudget) turnGranted = true;
		}
		const idleMessages: BuiltMessage[] = [];
		let deferMs = 0;
		for (const { built, budget } of candidates) {
			if (budget && !turnGranted) {
				const delay = budget.tryAcquire();
				if (delay > 0) {
					this.#restoreEntries(built, "deferred");
					deferMs = deferMs === 0 ? delay : Math.min(deferMs, delay);
					continue;
				}
			}
			turnGranted = true;
			idleMessages.push(built);
		}
		if (deferMs > 0) this.#deferIdleFlush(deferMs);
		if (idleMessages.length === 0) return;
		for (const item of idleMessages) this.#attachEntrySettlement(item);
		try {
			await this.#options.injectIdle(idleMessages.map(item => item.message));
			this.#idleDiscardRetries = 0;
			for (const item of idleMessages) {
				(item.message as AgentMessage & { [ASIDE_MESSAGE_COMMIT]?: () => void })[ASIDE_MESSAGE_COMMIT]?.();
			}
		} catch (error) {
			const dispatchError = error instanceof Error ? error : new Error(String(error));
			for (const item of idleMessages) {
				(item.message as AgentMessage & { [ASIDE_MESSAGE_DISCARD]?: (error: Error) => void })[
					ASIDE_MESSAGE_DISCARD
				]?.(dispatchError);
			}
			logger.warn("Yield queue idle dispatch failed", { error: formatError(error) });
		}
	}

	/**
	 * Resolves once no idle flush is scheduled, running, or held back by a
	 * turn budget — i.e. once every entry that could start a turn on its own
	 * has either been injected or must wait for a streaming step boundary.
	 */
	idleFlushSettled(): Promise<void> {
		if (!this.#idleFlushPending && !this.#idleFlushRunning && !this.#deferredIdleFlushTimer) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#idleFlushSettledWaiters.push(resolve);
		return promise;
	}

	/**
	 * Snapshot and remove all queued entries, returning one lazy thunk per kind.
	 * Each thunk applies the dispatcher's staleness filter and builds the batched
	 * message only when called — so the consumer (the agent loop) decides, at the
	 * moment it injects, whether the message is still worth delivering (a thunk may
	 * return null to skip). Background-job completions and late diagnostics reach
	 * the model between requests without the agent having to stop.
	 */
	drainLazy(): Array<() => AgentMessage | null> {
		const thunks: Array<() => AgentMessage | null> = [];
		for (const [kind, dispatcher] of this.#dispatchers) {
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			thunks.push(() => {
				const built = this.#build(kind, dispatcher, entries);
				if (!built) return null;
				this.#attachEntrySettlement(built);
				return built.message;
			});
		}
		this.#settleDeferredIdleFlush();
		return thunks;
	}

	/** Drop queued entries. With `kind`, drop only that kind's entries (leaving
	 *  any pending idle-flush for other kinds intact); otherwise drop everything.
	 *  Entries drained before the clear are never restored by a later discard. */
	clear(kind?: string): void {
		const error = new Error("Yield queue entry cleared before dispatch");
		this.#clearGeneration += 1;
		if (kind !== undefined) {
			this.#rejectEntries(this.#entries.get(kind) ?? [], error);
			this.#entries.delete(kind);
			this.#settleDeferredIdleFlush();
			return;
		}
		for (const entries of this.#entries.values()) this.#rejectEntries(entries, error);
		this.#entries.clear();
		this.#idleFlushPending = false;
		this.#idleDiscardRetries = 0;
		this.#clearDeferredIdleFlush();
		this.#settleIdleFlushWaiters();
	}

	/** Clear a scheduled-flush latch when its host task is cancelled before running. */
	cancelIdleFlushScheduling(): void {
		this.#idleFlushPending = false;
		this.#settleIdleFlushWaiters();
	}

	#scheduleIdleFlush(): void {
		if (this.#idleFlushPending) return;
		this.#idleFlushPending = true;
		try {
			this.#options.scheduleIdleFlush(async () => {
				this.#idleFlushPending = false;
				if (this.#options.isStreaming()) {
					// Queued entries inject at the next step boundary instead.
					this.#settleIdleFlushWaiters();
					return;
				}
				await this.flush("idle");
			});
		} catch (error) {
			this.#idleFlushPending = false;
			this.#settleIdleFlushWaiters();
			logger.warn("Yield queue idle flush scheduling failed", { error: formatError(error) });
		}
	}

	/** Retry the idle flush later — once a turn budget expects a permit again, or after a rejected injection. One timer; the earliest wins. */
	#deferIdleFlush(delayMs: number): void {
		const due = Date.now() + delayMs;
		if (this.#deferredIdleFlushTimer) {
			if (due >= this.#deferredIdleFlushDue) return;
			clearTimeout(this.#deferredIdleFlushTimer);
		}
		this.#deferredIdleFlushDue = due;
		this.#deferredIdleFlushTimer = setTimeout(() => {
			this.#deferredIdleFlushTimer = undefined;
			if (this.#options.isStreaming()) {
				this.#settleIdleFlushWaiters();
				return;
			}
			this.#scheduleIdleFlush();
		}, delayMs);
		this.#deferredIdleFlushTimer.unref();
	}

	#clearDeferredIdleFlush(): void {
		if (!this.#deferredIdleFlushTimer) return;
		clearTimeout(this.#deferredIdleFlushTimer);
		this.#deferredIdleFlushTimer = undefined;
	}

	/** Drop the deferred retry once no kind that takes part in the idle flush has anything left to carry. */
	#settleDeferredIdleFlush(): void {
		if (!this.#deferredIdleFlushTimer) return;
		for (const [kind, dispatcher] of this.#dispatchers) {
			if (!dispatcher.skipIdleFlush && this.has(kind)) return;
		}
		this.#clearDeferredIdleFlush();
		this.#settleIdleFlushWaiters();
	}

	#settleIdleFlushWaiters(): void {
		if (this.#idleFlushPending || this.#idleFlushRunning || this.#deferredIdleFlushTimer) return;
		const waiters = this.#idleFlushSettledWaiters;
		if (waiters.length === 0) return;
		this.#idleFlushSettledWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/**
	 * Put built-but-undelivered entries back at the head of their kind so the
	 * next flush carries them again. A turn budget holding the batch keeps
	 * every entry (nothing failed, delivery is merely later); a failed dispatch
	 * keeps only receipt-less ones — a receipted entry's owner observes the
	 * rejection and retries itself. Nothing else re-arms an idle flush for
	 * restored receipt-less entries, so a discard while idle schedules a bounded
	 * timed retry; while streaming the next step boundary carries them.
	 */
	#restoreEntries(built: BuiltMessage, mode: "deferred" | "discarded"): void {
		if (!this.#dispatchers.has(built.kind)) return;
		const retained =
			mode === "deferred"
				? built.entries
				: built.entries.filter(entry => entry.resolve === undefined && entry.reject === undefined);
		if (retained.length === 0) return;
		const queued = this.#entries.get(built.kind);
		this.#entries.set(built.kind, queued ? retained.concat(queued) : retained);
		if (mode !== "discarded" || this.#options.isStreaming()) return;
		if (this.#idleDiscardRetries >= IDLE_DISCARD_RETRY_LIMIT) {
			logger.warn("Yield queue idle retry limit reached; restored entries wait for the next flush", {
				kind: built.kind,
				retained: retained.length,
			});
			return;
		}
		this.#idleDiscardRetries += 1;
		this.#deferIdleFlush(IDLE_DISCARD_RETRY_MS);
	}

	#drain(kind: string): StoredEntry[] {
		const entries = this.#entries.get(kind);
		if (!entries || entries.length === 0) return [];
		this.#entries.delete(kind);
		return entries;
	}

	#build(kind: string, dispatcher: StoredDispatcher, entries: StoredEntry[]): BuiltMessage | null {
		const survivors: StoredEntry[] = [];
		for (const entry of entries) {
			if (dispatcher.isStale) {
				let stale: boolean;
				try {
					stale = dispatcher.isStale(entry.value);
				} catch (error) {
					const staleError = error instanceof Error ? error : new Error(String(error));
					entry.reject?.(staleError);
					logger.warn("Yield queue stale check failed", { kind, error: formatError(error) });
					continue;
				}
				if (stale) {
					// Staleness is an intentional context-boundary discard, not a
					// delivery failure. Resolve receipts so upstream durable queues
					// acknowledge the entry instead of replaying it into new context.
					entry.resolve?.();
					continue;
				}
			}
			survivors.push(entry);
		}
		if (survivors.length === 0) return null;
		try {
			const message = dispatcher.build(survivors.map(entry => entry.value));
			if (!message) {
				this.#rejectEntries(survivors, new Error(`Yield queue dispatcher skipped entry: ${kind}`));
				return null;
			}
			return { kind, generation: this.#clearGeneration, message, entries: survivors };
		} catch (error) {
			const buildError = error instanceof Error ? error : new Error(String(error));
			this.#rejectEntries(survivors, buildError);
			logger.warn("Yield queue build failed", { kind, error: formatError(error) });
			return null;
		}
	}

	/**
	 * Settle the built message's entries with the aside's fate. A discard
	 * means the model never saw the message: receipted entries are rejected so
	 * their owner retries, receipt-less entries return to the queue (unless a
	 * clear() intervened) so the next flush still carries them.
	 */
	#attachEntrySettlement(built: BuiltMessage): void {
		let settled = false;
		Object.defineProperties(built.message, {
			[ASIDE_MESSAGE_COMMIT]: {
				configurable: true,
				value: () => {
					if (settled) return;
					settled = true;
					this.#resolveEntries(built.entries);
				},
			},
			[ASIDE_MESSAGE_DISCARD]: {
				configurable: true,
				value: (error: Error) => {
					if (settled) return;
					settled = true;
					if (built.generation === this.#clearGeneration) this.#restoreEntries(built, "discarded");
					this.#rejectEntries(built.entries, error);
				},
			},
		});
	}

	#resolveEntries(entries: StoredEntry[]): void {
		for (const entry of entries) entry.resolve?.();
	}

	#rejectEntries(entries: StoredEntry[], error: Error): void {
		for (const entry of entries) entry.reject?.(error);
	}
}
