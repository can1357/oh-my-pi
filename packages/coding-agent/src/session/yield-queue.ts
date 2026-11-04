import {
	type AgentMessage,
	ASIDE_MESSAGE_CLAIM,
	ASIDE_MESSAGE_COMMIT,
	ASIDE_MESSAGE_DISCARD,
	ASIDE_MESSAGE_RELEASE,
	type CommittableAsideMessage,
} from "@oh-my-pi/pi-agent-core";
import { markAsideProvenance } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { logger, toError } from "@oh-my-pi/pi-utils";

export interface YieldDispatcher<P> {
	/** Drop entries already delivered through another path. Called per-entry at flush time. */
	isStale?(entry: P): boolean;
	/**
	 * Hold an entry back rather than drop or deliver it: the host is in a state
	 * where neither is right yet, such as a session transition that has still to
	 * settle on a transcript. Checked before {@link isStale}, so a passing state
	 * can never make an entry stale; a deferred entry stays queued and is offered
	 * again at the next flush, which the host requests when that state ends.
	 */
	isDeferred?(entry: P): boolean;
	/** Produce one batched AgentMessage from non-stale entries. Return null to skip. */
	build(survivors: P[]): AgentMessage | null;
	/** If true, entries for this kind are drained only by {@link drainLazy} and never trigger the idle flush. */
	skipIdleFlush?: boolean;
	/**
	 * Entries are delivered only by a model request that carries them while
	 * they are still live. The built message carries `ASIDE_MESSAGE_CLAIM`:
	 * {@link isDeferred} and {@link isStale} are asked again at the moment the
	 * agent loop hands that request to the provider, and each entry settles
	 * then: resolved when the request is sent, rejected when it went stale,
	 * queued again when it is deferred. Inserting the message into context, or
	 * an idle injection that ran no request carrying it, never resolves one.
	 */
	claimAtRequest?: boolean;
	/**
	 * For a {@link claimAtRequest} kind: at the claim, after every entry of the
	 * message proved live, reserve this entry with its producer, so nothing but
	 * this claim can end it until {@link commit} or {@link release}. False when
	 * the producer ended it first; the message is then withdrawn like a stale
	 * one. The liveness checks must not reserve: a peek runs them too.
	 */
	reserve?(entry: P): boolean;
	/** A reserved entry's request was not sent after all; it is claimed again later. */
	release?(entry: P): void;
	/** A reserved entry's request is being handed to the provider now. */
	commit?(entry: P): void;
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
	isDeferred?: (entry: unknown) => boolean;
	build: (survivors: unknown[]) => AgentMessage | null;
	skipIdleFlush?: boolean;
	claimAtRequest?: boolean;
	reserve?: (entry: unknown) => boolean;
	release?: (entry: unknown) => void;
	commit?: (entry: unknown) => void;
}

interface StoredEntry {
	value: unknown;
	resolve?: () => void;
	reject?: (error: Error) => void;
}

interface BuiltMessage {
	kind: string;
	dispatcher: StoredDispatcher;
	message: AgentMessage;
	entries: StoredEntry[];
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class YieldQueue {
	readonly #options: YieldQueueOptions;
	readonly #dispatchers = new Map<string, StoredDispatcher>();
	readonly #entries = new Map<string, StoredEntry[]>();
	#idleFlushPending = false;

	constructor(options: YieldQueueOptions) {
		this.#options = options;
	}

	register<P>(kind: string, dispatcher: YieldDispatcher<P>): () => void {
		const stored: StoredDispatcher = {
			...(dispatcher.isStale ? { isStale: entry => dispatcher.isStale?.(entry as P) ?? false } : {}),
			...(dispatcher.isDeferred ? { isDeferred: entry => dispatcher.isDeferred?.(entry as P) ?? false } : {}),
			build: survivors => dispatcher.build(survivors as P[]),
			...(dispatcher.skipIdleFlush ? { skipIdleFlush: true } : {}),
			...(dispatcher.claimAtRequest ? { claimAtRequest: true } : {}),
			...(dispatcher.reserve ? { reserve: entry => dispatcher.reserve?.(entry as P) ?? true } : {}),
			...(dispatcher.release ? { release: entry => dispatcher.release?.(entry as P) } : {}),
			...(dispatcher.commit ? { commit: entry => dispatcher.commit?.(entry as P) } : {}),
		};
		this.#dispatchers.set(kind, stored);
		return () => {
			if (this.#dispatchers.get(kind) !== stored) return;
			this.#dispatchers.delete(kind);
			this.#rejectEntries(this.#entries.get(kind) ?? [], new Error(`Yield queue dispatcher removed: ${kind}`));
			this.#entries.delete(kind);
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
		if (!this.#dispatchers.has(kind)) {
			logger.warn("Yield queue entry ignored for unregistered kind", { kind });
			return false;
		}
		let entries = this.#entries.get(kind);
		if (!entries) {
			entries = [];
			this.#entries.set(kind, entries);
		}
		entries.push(entry);
		if (!this.#options.isStreaming() && !this.#dispatchers.get(kind)!.skipIdleFlush) {
			this.#scheduleIdleFlush();
		}
		return true;
	}

	has(kind?: string): boolean {
		if (kind !== undefined) return (this.#entries.get(kind)?.length ?? 0) > 0;
		for (const entries of this.#entries.values()) {
			if (entries.length > 0) return true;
		}
		return false;
	}

	/**
	 * Non-consuming check for an entry of `kind` that the drain would deliver.
	 * Unlike {@link has}, it skips entries the dispatcher reports stale or
	 * deferred, since the drain drops the first without a message and leaves the
	 * second queued.
	 */
	hasDeliverable(kind: string): boolean {
		const entries = this.#entries.get(kind);
		if (!entries || entries.length === 0) return false;
		const dispatcher = this.#dispatchers.get(kind);
		const isStale = dispatcher?.isStale;
		const isDeferred = dispatcher?.isDeferred;
		if (!isStale && !isDeferred) return true;
		return entries.some(entry => {
			try {
				return !isDeferred?.(entry.value) && !isStale?.(entry.value);
			} catch {
				// The drain rejects an entry whose stale check throws.
				return false;
			}
		});
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
		if (mode === "idle") {
			this.#idleFlushPending = false;
		}
		const idleMessages: BuiltMessage[] = [];
		for (const [kind, dispatcher] of this.#dispatchers) {
			if (mode === "idle" && dispatcher.skipIdleFlush) continue;
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			const built = this.#build(kind, dispatcher, entries);
			if (!built) continue;
			if (mode === "streaming") {
				try {
					if (!this.#options.injectStreaming) throw new Error("Streaming injection is unavailable");
					// A claimed kind settles when a request carrying it is sent, not on insertion.
					if (dispatcher.claimAtRequest) this.#attachEntrySettlement(built);
					this.#options.injectStreaming(built.message);
					if (!dispatcher.claimAtRequest) this.#resolveEntries(built.entries);
				} catch (error) {
					const dispatchError = toError(error);
					this.#rejectEntries(built.entries, dispatchError);
					logger.warn("Yield queue streaming dispatch failed", { kind, error: formatError(error) });
				}
			} else {
				idleMessages.push(built);
			}
		}
		if (mode === "idle" && idleMessages.length > 0) {
			for (const item of idleMessages) this.#attachEntrySettlement(item);
			try {
				await this.#options.injectIdle(idleMessages.map(item => item.message));
				for (const item of idleMessages) {
					const message = item.message as CommittableAsideMessage;
					// A claimed kind that the turn's request carried settled at the
					// hand-off; one it never carried (the turn stopped or failed, or the
					// host folded the message into context without a request) was not
					// delivered.
					if (item.dispatcher.claimAtRequest) {
						message[ASIDE_MESSAGE_DISCARD]?.(new Error(`No model request carried the entry: ${item.kind}`));
					} else {
						message[ASIDE_MESSAGE_COMMIT]?.();
					}
				}
			} catch (error) {
				const dispatchError = toError(error);
				for (const item of idleMessages) {
					(item.message as CommittableAsideMessage)[ASIDE_MESSAGE_DISCARD]?.(dispatchError);
				}
				logger.warn("Yield queue idle dispatch failed", { error: formatError(error) });
			}
		}
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
		return thunks;
	}

	/** Drop queued entries. With `kind`, drop only that kind's entries (leaving
	 *  any pending idle-flush for other kinds intact); otherwise drop everything. */
	clear(kind?: string): void {
		const error = new Error("Yield queue entry cleared before dispatch");
		if (kind !== undefined) {
			this.#rejectEntries(this.#entries.get(kind) ?? [], error);
			this.#entries.delete(kind);
			return;
		}
		for (const entries of this.#entries.values()) this.#rejectEntries(entries, error);
		this.#entries.clear();
		this.#idleFlushPending = false;
	}

	/** Clear a scheduled-flush latch when its host task is cancelled before running. */
	cancelIdleFlushScheduling(): void {
		this.#idleFlushPending = false;
	}

	#scheduleIdleFlush(): void {
		if (this.#idleFlushPending) return;
		this.#idleFlushPending = true;
		try {
			this.#options.scheduleIdleFlush(async () => {
				this.#idleFlushPending = false;
				if (this.#options.isStreaming()) return;
				await this.flush("idle");
			});
		} catch (error) {
			this.#idleFlushPending = false;
			logger.warn("Yield queue idle flush scheduling failed", { error: formatError(error) });
		}
	}

	#drain(kind: string): StoredEntry[] {
		const entries = this.#entries.get(kind);
		if (!entries || entries.length === 0) return [];
		this.#entries.delete(kind);
		return entries;
	}

	#build(kind: string, dispatcher: StoredDispatcher, entries: StoredEntry[]): BuiltMessage | null {
		const survivors: StoredEntry[] = [];
		const deferred: StoredEntry[] = [];
		for (const entry of entries) {
			if (dispatcher.isDeferred) {
				let hold: boolean;
				try {
					hold = dispatcher.isDeferred(entry.value);
				} catch (error) {
					const deferError = toError(error);
					entry.reject?.(deferError);
					logger.warn("Yield queue defer check failed", { kind, error: formatError(error) });
					continue;
				}
				if (hold) {
					deferred.push(entry);
					continue;
				}
			}
			if (dispatcher.isStale) {
				let stale: boolean;
				try {
					stale = dispatcher.isStale(entry.value);
				} catch (error) {
					const staleError = toError(error);
					entry.reject?.(staleError);
					logger.warn("Yield queue stale check failed", { kind, error: formatError(error) });
					continue;
				}
				if (stale) {
					entry.reject?.(new Error(`Yield queue entry became stale: ${kind}`));
					continue;
				}
			}
			survivors.push(entry);
		}
		// Held entries go back at the head, in order: the host requests another
		// flush when the state that deferred them ends.
		if (deferred.length > 0) {
			const pending = this.#entries.get(kind);
			if (pending) pending.unshift(...deferred);
			else this.#entries.set(kind, deferred);
		}
		if (survivors.length === 0) return null;
		try {
			const message = dispatcher.build(survivors.map(entry => entry.value));
			if (!message) {
				this.#rejectEntries(survivors, new Error(`Yield queue dispatcher skipped entry: ${kind}`));
				return null;
			}
			return { kind, dispatcher, message, entries: survivors };
		} catch (error) {
			const buildError = toError(error);
			this.#rejectEntries(survivors, buildError);
			logger.warn("Yield queue build failed", { kind, error: formatError(error) });
			return null;
		}
	}

	#attachEntrySettlement(built: BuiltMessage): void {
		let settled = false;
		// Entries this message reserved at its claim and has not yet committed or released.
		let reserved: StoredEntry[] = [];
		const release = (): void => {
			const held = reserved;
			reserved = [];
			for (const entry of held) this.#call(built.kind, () => built.dispatcher.release?.(entry.value));
		};
		Object.defineProperties(built.message, {
			[ASIDE_MESSAGE_COMMIT]: {
				configurable: true,
				value: () => {
					if (settled) return;
					settled = true;
					// The producer learns of the hand-off in this same step, before the
					// request goes out; the receipt then resolves too.
					const held = reserved;
					reserved = [];
					for (const entry of held) this.#call(built.kind, () => built.dispatcher.commit?.(entry.value));
					this.#resolveEntries(built.entries);
				},
			},
			[ASIDE_MESSAGE_DISCARD]: {
				configurable: true,
				value: (error: Error) => {
					if (settled) return;
					settled = true;
					release();
					this.#rejectEntries(built.entries, error);
				},
			},
			[ASIDE_MESSAGE_RELEASE]: { configurable: true, value: release },
		});
		if (!built.dispatcher.claimAtRequest) return;
		// Its identity from the moment it exists, so no conversion or cache can
		// hand out a copy of it that lacks one.
		markAsideProvenance(built.message);
		const { kind, dispatcher } = built;
		Object.defineProperty(built.message, ASIDE_MESSAGE_CLAIM, {
			configurable: true,
			// Asked at the request hand-off; the loop commits or releases right after, in the same step.
			value: (): AgentMessage | null => {
				if (settled) return null;
				release();
				if (this.#dispatchers.get(kind) !== dispatcher) {
					settled = true;
					this.#rejectEntries(built.entries, new Error(`Yield queue dispatcher removed: ${kind}`));
					return null;
				}
				if (built.entries.every(entry => this.#isLive(dispatcher, entry)) && this.#reserveAll(kind, built)) {
					reserved = built.entries;
					return built.message;
				}
				// This message is withdrawn: stale entries are rejected, deferred ones
				// queued again, and the rest rebuilt into a message of their own.
				settled = true;
				const rebuilt = this.#build(kind, dispatcher, built.entries);
				if (!rebuilt) return null;
				this.#attachEntrySettlement(rebuilt);
				return rebuilt.message;
			},
		});
	}

	/**
	 * Reserve every entry of `built` with its producer; all or none. An entry
	 * its producer already ended leaves the others released and the message to
	 * be withdrawn.
	 */
	#reserveAll(kind: string, built: BuiltMessage): boolean {
		const { dispatcher } = built;
		if (!dispatcher.reserve) return true;
		const held: StoredEntry[] = [];
		for (const entry of built.entries) {
			let ok = false;
			try {
				ok = dispatcher.reserve(entry.value);
			} catch (error) {
				logger.warn("Yield queue reserve failed", { kind, error: formatError(error) });
			}
			if (!ok) {
				for (const taken of held) this.#call(kind, () => dispatcher.release?.(taken.value));
				return false;
			}
			held.push(entry);
		}
		return true;
	}

	/** Run a producer hook; a throwing hook is logged and never stops the hand-off. */
	#call(kind: string, hook: () => void): void {
		try {
			hook();
		} catch (error) {
			logger.warn("Yield queue entry hook failed", { kind, error: formatError(error) });
		}
	}

	/** Whether `entry` would survive a build now: neither deferred nor stale, and neither check throws. */
	#isLive(dispatcher: StoredDispatcher, entry: StoredEntry): boolean {
		try {
			return !dispatcher.isDeferred?.(entry.value) && !dispatcher.isStale?.(entry.value);
		} catch {
			return false;
		}
	}

	#resolveEntries(entries: StoredEntry[]): void {
		for (const entry of entries) entry.resolve?.();
	}

	#rejectEntries(entries: StoredEntry[], error: Error): void {
		for (const entry of entries) entry.reject?.(error);
	}
}
