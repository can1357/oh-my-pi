export const PROGRESS_BATCH_INTERVAL_MS = 200;
export const PROGRESS_RATE_LIMIT_BURST = 10;
export const PROGRESS_RATE_LIMIT_REFILL_MS = 2_000;
export const PROGRESS_CHATTY_REMINDER_INTERVAL = 5;
const PROGRESS_RATE_LIMIT_EPSILON = 1e-9;

export type ProgressBatchKind = "progress" | "artifact-only" | "suppression-summary";
export type ProgressReminder = "chatty-monitor";

export interface ProgressBatch<T> {
	kind: ProgressBatchKind;
	values: readonly T[];
	seq: number;
	suppressedEvents: number;
	reminder?: ProgressReminder;
}

export interface ProgressBatcherOptions<T> {
	/** Combine arrivals as they enter a window so the pending representation can remain bounded. */
	merge?: (left: T, right: T) => T;
	/**
	 * Fold metadata from a displaced retained value into the value replacing
	 * it without combining their payloads. Suppressed windows keep their outer
	 * values as separate text while this seam preserves metadata from every
	 * middle value that falls out of the bounded representation.
	 */
	mergeDisplacedMetadata?: (kept: T, displaced: T) => T;
	/** Collection window before delivery. Defaults to {@link PROGRESS_BATCH_INTERVAL_MS}. */
	intervalMs?: number;
}

interface ProgressBatchState<T> {
	pending: T[];
	seq: number;
	tokens: number;
	lastRefillAt: number;
	suppressedEvents: number;
	suppressedValues: T[];
	suppressionReports: number;
	deliveryTail?: Promise<void>;
	timer?: NodeJS.Timeout;
}

/**
 * Ordered per-source delivery: complete events collect in 200 ms windows, then
 * a ten-event token bucket meters model notifications and regains one permit
 * every two seconds. Rate-limited windows retain only their outer values for
 * the next permitted or terminal batch.
 */
export class ProgressBatcher<T> {
	readonly #states = new Map<string, ProgressBatchState<T>>();
	readonly #deliver: (id: string, batch: ProgressBatch<T>) => void | Promise<void>;
	readonly #merge?: (left: T, right: T) => T;
	readonly #mergeDisplacedMetadata?: (kept: T, displaced: T) => T;
	readonly #intervalMs: number;

	constructor(
		deliver: (id: string, batch: ProgressBatch<T>) => void | Promise<void>,
		options: ProgressBatcherOptions<T> = {},
	) {
		this.#deliver = deliver;
		this.#merge = options.merge;
		this.#mergeDisplacedMetadata = options.mergeDisplacedMetadata;
		this.#intervalMs = options.intervalMs ?? PROGRESS_BATCH_INTERVAL_MS;
	}

	push(id: string, value: T): void {
		let state = this.#states.get(id);
		if (!state) {
			state = {
				pending: [],
				seq: 0,
				tokens: PROGRESS_RATE_LIMIT_BURST,
				lastRefillAt: Date.now(),
				suppressedEvents: 0,
				suppressedValues: [],
				suppressionReports: 0,
			};
			this.#states.set(id, state);
		}
		const previous = state.pending.at(-1);
		if (this.#merge && previous !== undefined) state.pending[state.pending.length - 1] = this.#merge(previous, value);
		else state.pending.push(value);
		if (state.timer) return;
		state.timer = setTimeout(() => void this.flush(id), this.#intervalMs);
		state.timer.unref();
	}

	flush(id: string): Promise<void> {
		const state = this.#states.get(id);
		if (!state) return Promise.resolve();
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
		if (state.pending.length === 0) return state.deliveryTail ?? Promise.resolve();
		const values = state.pending;
		state.pending = [];
		state.seq += 1;
		this.#refill(state);
		if (state.tokens < 1 - PROGRESS_RATE_LIMIT_EPSILON) {
			this.#retainSuppressedValues(state, values);
			state.suppressedEvents += 1;
			return this.#enqueueDelivery(id, state, {
				kind: "artifact-only",
				values,
				seq: state.seq,
				suppressedEvents: 0,
			});
		}

		state.tokens = Math.max(0, state.tokens - 1);
		const suppressedEvents = state.suppressedEvents;
		state.suppressedEvents = 0;
		return this.#enqueueDelivery(id, state, {
			kind: "progress",
			values: this.#takeSuppressedValues(state, values),
			seq: state.seq,
			suppressedEvents,
			...this.#suppressionReminder(state, suppressedEvents),
		});
	}

	async finish(id: string): Promise<void> {
		const state = this.#states.get(id);
		if (!state) return;
		let flushError: unknown;
		let summaryError: unknown;
		try {
			await this.flush(id);
		} catch (error) {
			flushError = error;
		}
		try {
			if (state.suppressedEvents > 0) {
				state.seq += 1;
				const suppressedEvents = state.suppressedEvents;
				state.suppressedEvents = 0;
				await this.#enqueueDelivery(id, state, {
					kind: "suppression-summary",
					values: this.#takeSuppressedValues(state, []),
					seq: state.seq,
					suppressedEvents,
					...this.#suppressionReminder(state, suppressedEvents),
				});
			}
		} catch (error) {
			summaryError = error;
		} finally {
			this.clear(id);
		}
		if (flushError !== undefined) throw flushError;
		if (summaryError !== undefined) throw summaryError;
	}

	/**
	 * Drain undelivered content without delivering it: the pending window plus
	 * the bounded values retained from rate-limited windows. An already-enqueued
	 * delivery may still be awaiting its sink; it settles first so its batch
	 * reaches the sink before the terminal remainder is taken — otherwise a
	 * completion could observably outrun progress the sink was still handling.
	 * Used at settlement when the caller folds the remainder into the terminal
	 * delivery instead of racing one final progress batch ahead of it.
	 */
	async takePending(id: string): Promise<{ values: T[]; suppressedEvents: number } | undefined> {
		for (;;) {
			const tail = this.#states.get(id)?.deliveryTail;
			if (!tail) break;
			await tail.then(
				() => {},
				() => {},
			);
			// The settle cleanup normally clears/replaces the tail before this
			// resumes; an unchanged reference means it already settled.
			if (this.#states.get(id)?.deliveryTail === tail) break;
		}
		const state = this.#states.get(id);
		if (!state) return undefined;
		const values = this.#takeSuppressedValues(state, state.pending);
		const suppressedEvents = state.suppressedEvents;
		this.clear(id);
		if (values.length === 0 && suppressedEvents === 0) return undefined;
		return { values, suppressedEvents };
	}

	clear(id: string): void {
		const state = this.#states.get(id);
		if (!state) return;
		if (state.timer) clearTimeout(state.timer);
		this.#states.delete(id);
	}

	dispose(): void {
		for (const state of this.#states.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		this.#states.clear();
	}

	#retainSuppressedValues(state: ProgressBatchState<T>, values: readonly T[]): void {
		const first = values[0];
		if (first === undefined) return;
		const last = values.at(-1)!;
		if (state.suppressedValues.length === 0) {
			state.suppressedValues.push(first);
			if (values.length > 1) state.suppressedValues.push(last);
			return;
		}
		if (state.suppressedValues.length === 1) {
			state.suppressedValues.push(last);
			return;
		}
		// Keep the outer representation bounded. The old tail is displaced by
		// the new tail, but callers with metadata-bearing values can fold its
		// metadata into the replacement without concatenating suppressed text.
		state.suppressedValues[1] = this.#mergeDisplacedMetadata
			? this.#mergeDisplacedMetadata(last, state.suppressedValues[1]!)
			: last;
	}

	#takeSuppressedValues(state: ProgressBatchState<T>, current: readonly T[]): T[] {
		const values = [...state.suppressedValues, ...current];
		state.suppressedValues.length = 0;
		return values;
	}

	#refill(state: ProgressBatchState<T>): void {
		const now = Date.now();
		const elapsedMs = Math.max(0, now - state.lastRefillAt);
		state.lastRefillAt = now;
		state.tokens = Math.min(PROGRESS_RATE_LIMIT_BURST, state.tokens + elapsedMs / PROGRESS_RATE_LIMIT_REFILL_MS);
	}

	#suppressionReminder(state: ProgressBatchState<T>, suppressedEvents: number): { reminder?: ProgressReminder } {
		if (suppressedEvents === 0) return {};
		state.suppressionReports += 1;
		if (state.suppressionReports % PROGRESS_CHATTY_REMINDER_INTERVAL !== 0) return {};
		return { reminder: "chatty-monitor" };
	}

	#enqueueDelivery(id: string, state: ProgressBatchState<T>, batch: ProgressBatch<T>): Promise<void> {
		const deliver = () => this.#deliver(id, batch);
		let tail: Promise<void>;
		if (state.deliveryTail) {
			tail = state.deliveryTail.then(deliver, deliver);
		} else {
			try {
				tail = Promise.resolve(deliver());
			} catch (error) {
				tail = Promise.reject(error);
			}
		}
		state.deliveryTail = tail;
		void tail.then(
			() => {
				if (state.deliveryTail === tail) state.deliveryTail = undefined;
			},
			() => {
				if (state.deliveryTail === tail) state.deliveryTail = undefined;
			},
		);
		return tail;
	}
}
