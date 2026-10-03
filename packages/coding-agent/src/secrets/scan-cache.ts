/** Content-keyed LRU. Budgets count UTF-16 characters in keys and all retained values. */
export class SecretTextCache<T> {
	#entries = new Map<string, { value: T; weight: number }>();
	#weight = 0;

	constructor(
		readonly maxCharacters = 4 * 1024 * 1024,
		readonly maxEntries = 4096,
	) {}

	get(text: string): T | undefined {
		const entry = this.#entries.get(text);
		if (entry === undefined) return undefined;
		this.#entries.delete(text);
		this.#entries.set(text, entry);
		return entry.value;
	}

	set(text: string, value: T, valueCharacters: number): void {
		const weight = text.length + valueCharacters;
		const previous = this.#entries.get(text);
		if (previous !== undefined) {
			this.#weight -= previous.weight;
			this.#entries.delete(text);
		}
		if (weight > this.maxCharacters || this.maxEntries === 0) return;
		while (this.#entries.size >= this.maxEntries || this.#weight + weight > this.maxCharacters) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#weight -= this.#entries.get(oldest)!.weight;
			this.#entries.delete(oldest);
		}
		this.#entries.set(text, { value, weight });
		this.#weight += weight;
	}

	clear(): void {
		this.#entries.clear();
		this.#weight = 0;
	}
}

/** Keep a few collision-state results for text shared by the two SDK boundaries. */
export class SecretTextResultCache {
	#cache: SecretTextCache<readonly { collisionId: number; text: string }[]>;

	constructor(maxCharacters = 4 * 1024 * 1024) {
		this.#cache = new SecretTextCache(maxCharacters);
	}

	get(text: string, collisionId: number): string | undefined {
		return this.#cache.get(text)?.find(result => result.collisionId === collisionId)?.text;
	}

	set(text: string, collisionId: number, result: string): void {
		const retained = (this.#cache.get(text) ?? []).filter(value => value.collisionId !== collisionId).slice(-3);
		retained.push({ collisionId, text: result });
		this.#cache.set(
			text,
			retained,
			retained.reduce((length, value) => length + value.text.length, 0),
		);
	}

	clear(): void {
		this.#cache.clear();
	}
}

/** A runtime-immutable collision set: Object.freeze(new Set()) would still allow add/delete. */
class CollisionSnapshot implements ReadonlySet<string> {
	#values: Set<string>;
	readonly characters: number;
	/** False for one-shot snapshots whose results must not displace reusable cache entries. */
	readonly cacheable: boolean;
	readonly [Symbol.toStringTag] = "Set";

	constructor(
		readonly owner: SecretCollisionSnapshots,
		readonly id: number,
		values: ReadonlySet<string>,
	) {
		this.#values = new Set(values);
		let characters = 0;
		for (const value of values) characters += value.length;
		this.characters = characters;
		this.cacheable = this.characters <= owner.maxCharacters && this.size <= owner.maxMembers && owner.maxEntries > 0;
		Object.freeze(this);
	}

	get size(): number {
		return this.#values.size;
	}

	has(value: string): boolean {
		return this.#values.has(value);
	}

	matches(values: ReadonlySet<string>): boolean {
		if (values.size !== this.size) return false;
		for (const value of values) if (!this.has(value)) return false;
		return true;
	}

	entries(): SetIterator<[string, string]> {
		return this.#values.entries();
	}

	keys(): SetIterator<string> {
		return this.#values.keys();
	}

	values(): SetIterator<string> {
		return this.#values.values();
	}

	[Symbol.iterator](): SetIterator<string> {
		return this.#values[Symbol.iterator]();
	}

	forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
		for (const value of this.#values) callback.call(thisArg, value, value, this);
	}
}

/** Intern collision contents, not mutable Set identity, once per outbound batch. */
export class SecretCollisionSnapshots {
	#snapshots: CollisionSnapshot[] = [];
	#characters = 0;
	#nextId = 0;
	#empty = new Set<string>();

	constructor(
		readonly maxCharacters = 512 * 1024,
		readonly maxEntries = 16,
		readonly maxMembers = 4096,
	) {}

	prepare(values: ReadonlySet<string> = this.#empty): CollisionSnapshot {
		if (values instanceof CollisionSnapshot && values.owner === this) return values;
		const index = this.#snapshots.findIndex(snapshot => snapshot.matches(values));
		if (index !== -1) {
			const snapshot = this.#snapshots.splice(index, 1)[0]!;
			this.#snapshots.push(snapshot);
			return snapshot;
		}
		const snapshot = new CollisionSnapshot(this, this.#nextId++, values);
		// Even zero-length values consume entries; cap both characters and members.
		if (!snapshot.cacheable) return snapshot;
		while (this.#snapshots.length >= this.maxEntries || this.#characters + snapshot.characters > this.maxCharacters) {
			this.#characters -= this.#snapshots.shift()!.characters;
		}
		this.#snapshots.push(snapshot);
		this.#characters += snapshot.characters;
		return snapshot;
	}
}
