/**
 * Version of a {@link SecretObfuscator}'s registry: every collection redaction
 * reads is a tracked collection bound to one revision, and each effective
 * write bumps it. Results reused across calls are keyed by `value`, so a write
 * can never leave a stale result in place — there is no separate invalidation
 * step to forget.
 */
export class RegistryRevision {
	value = 0;

	bump(): void {
		this.value++;
	}
}

// Both wrap a plain collection instead of subclassing it: reads are the hot
// path of redaction and stay on the engine's builtin Map/Set fast paths.

/** Map whose effective writes bump a {@link RegistryRevision}. */
export class TrackedMap<K, V> implements ReadonlyMap<K, V> {
	readonly #map = new Map<K, V>();
	readonly #revision: RegistryRevision;
	#version = 0;

	constructor(revision: RegistryRevision) {
		this.#revision = revision;
	}

	/** Number of effective writes to this map alone; lets derived data follow just this map. */
	get version(): number {
		return this.#version;
	}

	get size(): number {
		return this.#map.size;
	}

	get(key: K): V | undefined {
		return this.#map.get(key);
	}

	has(key: K): boolean {
		return this.#map.has(key);
	}

	set(key: K, value: V): this {
		if (this.#map.has(key) && this.#map.get(key) === value) return this;
		this.#map.set(key, value);
		this.#version++;
		this.#revision.bump();
		return this;
	}

	keys(): MapIterator<K> {
		return this.#map.keys();
	}

	values(): MapIterator<V> {
		return this.#map.values();
	}

	entries(): MapIterator<[K, V]> {
		return this.#map.entries();
	}

	forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		for (const [key, value] of this.#map) callback.call(thisArg, value, key, this);
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.#map[Symbol.iterator]();
	}
}

/** Set whose effective writes bump a {@link RegistryRevision}. */
export class TrackedSet<T> {
	readonly #set = new Set<T>();
	readonly #revision: RegistryRevision;

	constructor(revision: RegistryRevision) {
		this.#revision = revision;
	}

	get size(): number {
		return this.#set.size;
	}

	has(value: T): boolean {
		return this.#set.has(value);
	}

	add(value: T): this {
		if (this.#set.has(value)) return this;
		this.#set.add(value);
		this.#revision.bump();
		return this;
	}

	[Symbol.iterator](): SetIterator<T> {
		return this.#set[Symbol.iterator]();
	}
}
