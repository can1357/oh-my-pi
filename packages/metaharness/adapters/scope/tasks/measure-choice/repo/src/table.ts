import { DEFAULT_HASH, HASHES } from "./config";

/** Fixed-size chained hash table keyed by string. */
export class KeyTable<T> {
	#buckets: Array<Array<[string, T]>>;
	#hash = HASHES[DEFAULT_HASH];

	constructor(bucketCount = 1024) {
		this.#buckets = Array.from({ length: bucketCount }, () => []);
	}

	#bucket(key: string): Array<[string, T]> {
		return this.#buckets[this.#hash(key) % this.#buckets.length];
	}

	set(key: string, value: T): void {
		const bucket = this.#bucket(key);
		const entry = bucket.find(([existing]) => existing === key);
		if (entry) entry[1] = value;
		else bucket.push([key, value]);
	}

	get(key: string): T | undefined {
		return this.#bucket(key).find(([existing]) => existing === key)?.[1];
	}
}
