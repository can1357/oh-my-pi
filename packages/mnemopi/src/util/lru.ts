export class LruCache<K, V> {
	readonly maxSize: number;
	readonly #items = new Map<K, V>();

	constructor(maxSize: number) {
		this.maxSize = Math.max(0, Math.trunc(maxSize));
	}

	get size(): number {
		return this.#items.size;
	}

	has(key: K): boolean {
		return this.#items.has(key);
	}

	get(key: K): V | undefined {
		const value = this.#items.get(key);
		if (value !== undefined || this.#items.has(key)) {
			this.#items.delete(key);
			this.#items.set(key, value as V);
		}
		return value;
	}

	set(key: K, value: V): this {
		if (this.maxSize === 0) return this;
		if (this.#items.has(key)) this.#items.delete(key);
		this.#items.set(key, value);
		if (this.#items.size > this.maxSize) {
			const oldest = this.#items.keys().next();
			if (!oldest.done) this.#items.delete(oldest.value);
		}
		return this;
	}

	delete(key: K): boolean {
		return this.#items.delete(key);
	}

	clear(): void {
		this.#items.clear();
	}

	entries(): IterableIterator<[K, V]> {
		return this.#items.entries();
	}
}
