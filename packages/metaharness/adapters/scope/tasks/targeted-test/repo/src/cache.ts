/** Map whose entries expire `ttlMs` after they are set. */
export class TtlCache<V> {
	#entries = new Map<string, { value: V; expires: number }>();

	constructor(readonly ttlMs: number) {}

	set(key: string, value: V): void {
		this.#entries.set(key, { value, expires: Date.now() + this.ttlMs });
	}

	get(key: string): V | undefined {
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		if (Date.now() >= entry.expires) {
			this.#entries.delete(key);
			return undefined;
		}
		return entry.value;
	}
}
