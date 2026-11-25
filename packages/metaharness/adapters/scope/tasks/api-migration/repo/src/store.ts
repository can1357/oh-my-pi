/** Error-first callback of the deprecated API. */
export type Callback<T> = (error: Error | null, value?: T) => void;

/**
 * In-memory document store. Documents are copied in and out. The callback methods
 * (`get`, `set`, `list`, `del`) are deprecated wrappers over `read`, `write`, `scan`, `remove`.
 */
export class Store {
	#docs = new Map<string, unknown>();
	#failure: Error | null = null;

	/** Makes the next operation fail with `error`; tests use it to reach error paths. */
	failNext(error: Error): void {
		this.#failure = error;
	}

	async read(key: string): Promise<unknown> {
		this.#check();
		return structuredClone(this.#docs.get(key));
	}

	async write(key: string, doc: unknown): Promise<void> {
		this.#check();
		this.#docs.set(key, structuredClone(doc));
	}

	/** Entries whose key starts with `prefix`, in key order. */
	async scan(prefix: string): Promise<Array<[key: string, doc: unknown]>> {
		this.#check();
		return [...this.#docs]
			.filter(([key]) => key.startsWith(prefix))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, doc]) => [key, structuredClone(doc)]);
	}

	/** Resolves `true` when `key` existed. */
	async remove(key: string): Promise<boolean> {
		this.#check();
		return this.#docs.delete(key);
	}

	/** @deprecated Use {@link Store.read}. */
	get(key: string, callback: Callback<unknown>): void {
		this.read(key).then(doc => callback(null, doc), callback);
	}

	/** @deprecated Use {@link Store.write}. */
	set(key: string, doc: unknown, callback: Callback<void>): void {
		this.write(key, doc).then(() => callback(null), callback);
	}

	/** @deprecated Use {@link Store.scan}. */
	list(prefix: string, callback: Callback<Array<[key: string, doc: unknown]>>): void {
		this.scan(prefix).then(entries => callback(null, entries), callback);
	}

	/** @deprecated Use {@link Store.remove}. */
	del(key: string, callback: Callback<boolean>): void {
		this.remove(key).then(removed => callback(null, removed), callback);
	}

	#check(): void {
		const failure = this.#failure;
		this.#failure = null;
		if (failure) throw failure;
	}
}
