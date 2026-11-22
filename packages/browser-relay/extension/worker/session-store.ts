/**
 * Worker state mirrored to `chrome.storage.session`, so it survives the service worker being reaped while the
 * browser keeps running.
 */

/**
 * One `chrome.storage.session` key held in memory: loaded once, mutated in place, written back whole. Mutations
 * between `get()` and `save()` are synchronous, so concurrent updates never lose each other.
 */
export class SessionValue<T> {
	readonly #key: string;
	readonly #initial: () => T;
	#value: Promise<T> | null = null;

	/** Only this worker writes `key`, always as a `T`. */
	constructor(key: string, initial: () => T) {
		this.#key = key;
		this.#initial = initial;
	}

	/** The current value, loaded from storage on first use. */
	get(): Promise<T> {
		this.#value ??= chrome.storage.session
			.get<Record<string, T | undefined>>(this.#key)
			.then(stored => stored[this.#key] ?? this.#initial())
			.catch(() => this.#initial());
		return this.#value;
	}

	/** Write the in-memory value back to storage. */
	async save(): Promise<void> {
		const value = await this.get();
		await chrome.storage.session.set({ [this.#key]: value }).catch(() => {});
	}
}
