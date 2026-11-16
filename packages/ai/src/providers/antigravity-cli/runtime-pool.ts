/**
 * Bounded retention for live provider runtimes keyed by logical session.
 *
 * A runtime that owns a subprocess is expensive to rebuild and unsafe to reuse
 * once torn down, so retention needs one lifecycle instead of one policy per
 * caller: an idle runtime is released without destroying what it persisted, a
 * runtime that still owns work is retried until it is finished, and an explicit
 * disposal is terminal. Entries live in a caller-owned store, which stays the
 * single source of truth — a store cleared elsewhere can never hand back a
 * runtime this pool already retired.
 */

/** Why a runtime left the pool. Idle retirement must preserve persisted state. */
export type SessionRuntimeRetirement = "idle" | "dispose";

/** Keyed store the pool retains entries in; a `Map` satisfies it directly. */
export interface SessionRuntimeStore<T> {
	get(key: string): T | undefined;
	set(key: string, value: T): void;
	delete(key: string): void;
	entries(): IterableIterator<[string, T]>;
}

/** Idle policy; `timeoutMs: 0` retains entries until they are closed explicitly. */
export interface SessionRuntimeIdle<T> {
	timeoutMs: number;
	/** Keep an entry that still owns work: the timer retries instead of retiring it. */
	canDispose?: (entry: T) => boolean;
}

/** One request's claim on a retained runtime. */
export interface SessionRuntimeLease<T> {
	readonly value: T;
	/** Give up this request's claim. Idempotent. */
	release(): void;
}

export class SessionRuntimePool<T> {
	readonly #create: (key: string) => T;
	readonly #dispose: (entry: T, key: string, reason: SessionRuntimeRetirement) => Promise<void>;
	readonly #idle: SessionRuntimeIdle<T>;
	readonly #store: SessionRuntimeStore<T>;
	readonly #leases = new Map<T, number>();
	readonly #timers = new Map<T, NodeJS.Timeout>();
	readonly #disposing = new Set<Promise<void>>();

	constructor(
		create: (key: string) => T,
		dispose: (entry: T, key: string, reason: SessionRuntimeRetirement) => Promise<void>,
		idle: SessionRuntimeIdle<T> = { timeoutMs: 0 },
		store: SessionRuntimeStore<T> = new Map(),
	) {
		this.#create = create;
		this.#dispose = dispose;
		this.#idle = idle;
		this.#store = store;
	}

	get(key: string): T {
		const entry = this.#touch(key);
		this.#schedule(key, entry);
		return entry;
	}

	/** Inspection without instantiating: reporting state must not spawn a runtime. */
	peek(key: string): T | undefined {
		return this.#store.get(key);
	}

	acquire(key: string): SessionRuntimeLease<T> {
		// Lease before anything can retire: a runtime mid-step must never be
		// released just because its idle timer came due.
		const value = this.#touch(key);
		this.#leases.set(value, (this.#leases.get(value) ?? 0) + 1);
		this.#clearTimer(value);
		let released = false;
		return {
			value,
			release: () => {
				if (released) return;
				released = true;
				const count = (this.#leases.get(value) ?? 1) - 1;
				if (count > 0) this.#leases.set(value, count);
				else this.#leases.delete(value);
				if (this.#store.get(key) === value) this.#schedule(key, value);
			},
		};
	}

	values(): T[] {
		return [...this.#store.entries()].map(([, entry]) => entry);
	}

	/** Retire one idle entry, keeping whatever it persisted. */
	async closeIdle(key: string): Promise<boolean> {
		const entry = this.#store.get(key);
		if (!entry || this.#leases.has(entry) || this.#idle.canDispose?.(entry) === false) return false;
		await this.#retire(key, "idle");
		return true;
	}

	/** Retire one entry for good, destroying whatever it owns. */
	async close(key: string): Promise<void> {
		await this.#retire(key, "dispose");
	}

	async closeAll(): Promise<void> {
		const entries = [...this.#store.entries()];
		for (const [key] of entries) this.#store.delete(key);
		for (const [, entry] of entries) {
			this.#clearTimer(entry);
			this.#leases.delete(entry);
		}
		await Promise.allSettled(entries.map(([key, entry]) => this.#disposeEntry(entry, key, "dispose")));
		await Promise.allSettled(this.#disposing);
	}

	#touch(key: string): T {
		let entry = this.#store.get(key);
		if (!entry) {
			entry = this.#create(key);
			this.#store.set(key, entry);
		}
		return entry;
	}

	#clearTimer(entry: T): void {
		clearTimeout(this.#timers.get(entry));
		this.#timers.delete(entry);
	}

	#schedule(key: string, entry: T): void {
		this.#clearTimer(entry);
		if (!this.#idle.timeoutMs || this.#leases.has(entry)) return;
		const timer = setTimeout(() => {
			this.#timers.delete(entry);
			if (this.#store.get(key) !== entry || this.#leases.has(entry)) return;
			// A parked tool call can outlive its step; retry instead of releasing
			// a runtime that is still waiting for its result.
			if (this.#idle.canDispose?.(entry) === false) {
				this.#schedule(key, entry);
				return;
			}
			void this.#retire(key, "idle").catch(() => undefined);
		}, this.#idle.timeoutMs);
		timer.unref();
		this.#timers.set(entry, timer);
	}

	async #retire(key: string, reason: SessionRuntimeRetirement): Promise<void> {
		const entry = this.#store.get(key);
		// Detach before awaiting teardown so a later request cannot reuse a
		// runtime that is already gone.
		this.#store.delete(key);
		if (!entry) return;
		this.#clearTimer(entry);
		this.#leases.delete(entry);
		await this.#disposeEntry(entry, key, reason);
	}

	async #disposeEntry(entry: T, key: string, reason: SessionRuntimeRetirement): Promise<void> {
		const pending = this.#dispose(entry, key, reason);
		this.#disposing.add(pending);
		try {
			await pending;
		} finally {
			this.#disposing.delete(pending);
		}
	}
}

/** Restrict a caller-owned map to the entries a pool of `T` owns. */
export function sessionRuntimeStore<T>(
	source: Map<string, unknown>,
	owns: (value: unknown) => value is T,
): SessionRuntimeStore<T> {
	return {
		get(key) {
			const value = source.get(key);
			return owns(value) ? value : undefined;
		},
		set(key, value) {
			source.set(key, value);
		},
		delete(key) {
			source.delete(key);
		},
		*entries() {
			for (const [key, value] of source) if (owns(value)) yield [key, value];
		},
	};
}
