/** Behavior-compatible reimplementation of lru-cache's used surface. */

/** Why an entry left the cache. */
export type DisposeReason = "evict" | "set" | "delete" | "expire";

/** Options supported by {@link LRUCache}. */
export interface LRUCacheOptions<K, V> {
	/** Maximum number of retained entries. */
	max?: number;
	/** Maximum aggregate calculated size. */
	maxSize?: number;
	/** Maximum calculated size of one entry. */
	maxEntrySize?: number;
	/** Calculates an entry's size. */
	sizeCalculation?: (value: V, key: K) => number;
	/** Entry lifetime in milliseconds; zero disables expiry. */
	ttl?: number;
	/** Refreshes an entry's lifetime when it is read. */
	updateAgeOnGet?: boolean;
	/** Called synchronously before an entry is removed. */
	dispose?: (value: V, key: K, reason: DisposeReason) => void;
}

interface Entry<V> {
	value: V;
	size: number;
	start: number;
}

function positiveInteger(value: number | undefined, name: string): number {
	if (value === undefined) return 0;
	if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
	return value;
}

/** A bounded least-recently-used cache with optional size and lifetime limits. */
export class LRUCache<K, V> {
	readonly #entries = new Map<K, Entry<V>>();
	readonly #max: number;
	readonly #maxSize: number;
	readonly #maxEntrySize: number;
	readonly #sizeCalculation: ((value: V, key: K) => number) | undefined;
	readonly #ttl: number;
	readonly #updateAgeOnGet: boolean;
	readonly #dispose: ((value: V, key: K, reason: DisposeReason) => void) | undefined;
	#calculatedSize = 0;

	/** Creates an empty cache. */
	constructor(options: LRUCacheOptions<K, V>) {
		this.#max = positiveInteger(options.max, "max");
		this.#maxSize = positiveInteger(options.maxSize, "maxSize");
		const explicitMaxEntrySize = positiveInteger(options.maxEntrySize, "maxEntrySize");
		this.#maxEntrySize = explicitMaxEntrySize || this.#maxSize;
		this.#ttl = positiveInteger(options.ttl, "ttl");
		if (this.#max === 0 && this.#maxSize === 0 && this.#ttl === 0) {
			throw new TypeError("At least one of max, maxSize, or ttl is required");
		}
		if ((this.#maxSize !== 0 || this.#maxEntrySize !== 0) && options.sizeCalculation === undefined) {
			throw new TypeError("sizeCalculation is required when a size limit is set");
		}
		this.#sizeCalculation = options.sizeCalculation;
		this.#updateAgeOnGet = options.updateAgeOnGet === true;
		this.#dispose = options.dispose;
	}

	/** Number of entries, including stale entries not yet removed by `get`. */
	get size(): number {
		return this.#entries.size;
	}

	/** Aggregate calculated size of retained entries. */
	get calculatedSize(): number {
		return this.#calculatedSize;
	}

	/** Stores a value and makes it most recently used. */
	set(key: K, value: V | undefined): this {
		if (value === undefined) {
			this.delete(key);
			return this;
		}

		const size = this.#entrySize(value, key);
		const previous = this.#entries.get(key);
		if (this.#maxEntrySize !== 0 && size > this.#maxEntrySize) {
			if (previous !== undefined) this.#remove(key, previous, "set");
			return this;
		}

		if (previous !== undefined) {
			if (previous.value !== value) this.#dispose?.(previous.value, key, "set");
			this.#calculatedSize -= previous.size;
			this.#entries.delete(key);
		}

		while (
			(this.#max !== 0 && this.#entries.size >= this.#max) ||
			(this.#maxSize !== 0 && this.#calculatedSize + size > this.#maxSize)
		) {
			const oldest = this.#entries.entries().next().value as [K, Entry<V>] | undefined;
			if (oldest === undefined) break;
			this.#remove(oldest[0], oldest[1], "evict");
		}
		this.#entries.set(key, { value, size, start: this.#ttl === 0 ? 0 : performance.now() });
		this.#calculatedSize += size;
		return this;
	}

	/** Returns a value and makes a fresh entry most recently used. */
	get(key: K): V | undefined {
		const entry = this.#entries.get(key);
		if (entry === undefined) return undefined;
		if (this.#isStale(entry)) {
			this.#remove(key, entry, "expire");
			return undefined;
		}
		if (this.#updateAgeOnGet && this.#ttl !== 0) entry.start = performance.now();
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return entry.value;
	}

	/** Reports whether a fresh value is present without changing recency. */
	has(key: K): boolean {
		const entry = this.#entries.get(key);
		return entry !== undefined && !this.#isStale(entry);
	}

	/** Returns a fresh value without changing recency or removing stale data. */
	peek(key: K): V | undefined {
		const entry = this.#entries.get(key);
		return entry === undefined || this.#isStale(entry) ? undefined : entry.value;
	}

	/** Removes a value, returning whether one was present. */
	delete(key: K): boolean {
		const entry = this.#entries.get(key);
		if (entry === undefined) return false;
		this.#remove(key, entry, "delete");
		return true;
	}

	/** Removes every value from least to most recently used. */
	clear(): void {
		for (const [key, entry] of this.#entries) this.#dispose?.(entry.value, key, "delete");
		this.#entries.clear();
		this.#calculatedSize = 0;
	}

	/** Iterates fresh keys from most to least recently used. */
	*keys(): Generator<K, void, unknown> {
		const entries = [...this.#entries.entries()];
		for (let index = entries.length - 1; index >= 0; index--) {
			const [key, entry] = entries[index]!;
			if (!this.#isStale(entry)) yield key;
		}
	}

	/** Iterates fresh values from most to least recently used. */
	*values(): Generator<V, void, unknown> {
		const entries = [...this.#entries.values()];
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			if (!this.#isStale(entry)) yield entry.value;
		}
	}

	#entrySize(value: V, key: K): number {
		if (this.#sizeCalculation === undefined) return 0;
		const size = this.#sizeCalculation(value, key);
		if (!Number.isInteger(size) || size <= 0)
			throw new TypeError("sizeCalculation return invalid (expect positive integer)");
		return size;
	}

	#isStale(entry: Entry<V>): boolean {
		return this.#ttl !== 0 && performance.now() - entry.start > this.#ttl;
	}

	#remove(key: K, entry: Entry<V>, reason: DisposeReason): void {
		this.#dispose?.(entry.value, key, reason);
		this.#entries.delete(key);
		this.#calculatedSize -= entry.size;
	}
}
