/**
 * Framework-free query cache behind `useQuery`: per-key cached results in
 * size-bounded buckets, and one shared in-flight request per key that is
 * aborted once its last waiter leaves.
 */

export interface CacheEntry {
	data: unknown;
	updatedAt: number;
	version: number;
}

interface CacheBucket {
	entries: Map<string, CacheEntry>;
	limit: number;
}

export interface Inflight {
	promise: Promise<unknown>;
	controller: AbortController;
	/** Queries (and prefetches) waiting on this request. */
	waiters: number;
}

/** Handed to every fetcher. */
export interface QueryFetchContext {
	/** Aborted once no query waits for this request any more. */
	signal: AbortSignal;
}

/**
 * Loads one key's data. `previous` is the cached data for this key, for
 * conditional revalidation; `undefined` on first load. It is a separate
 * parameter so fetchers that ignore it still let `T` be inferred from their
 * return type.
 */
export type QueryFetcher<T> = (context: QueryFetchContext, previous: T | undefined) => Promise<T>;

const defaultBucket: CacheBucket = { entries: new Map(), limit: 128 };
/** Full session traces: MBs each, at most a few worth keeping. */
const traceBucket: CacheBucket = { entries: new Map(), limit: 4 };
/** Request detail payloads (full prompts and responses). */
const requestBucket: CacheBucket = { entries: new Map(), limit: 16 };

const inflight = new Map<string, Inflight>();

function bucketFor(key: string): CacheBucket {
	if (key.startsWith('["trace",')) return traceBucket;
	if (key.startsWith('["request",')) return requestBucket;
	return defaultBucket;
}

export function cachedEntry(key: string): CacheEntry | undefined {
	return bucketFor(key).entries.get(key);
}

/** The shared request currently running for `key`, if any. */
export function inflightRequest(key: string): Inflight | undefined {
	return inflight.get(key);
}

function remember(key: string, entry: CacheEntry): void {
	const { entries, limit } = bucketFor(key);
	entries.delete(key);
	entries.set(key, entry);
	if (entries.size > limit) {
		const oldest = entries.keys().next().value;
		if (oldest !== undefined) entries.delete(oldest);
	}
}

/**
 * Fetch into the cache (tagged with live data `version`), sharing one request
 * among concurrent callers of the same key. The caller holds one waiter on
 * the returned request; pair with {@link releaseQuery}.
 */
export function loadQuery<T>(key: string, version: number, fetcher: QueryFetcher<T>): Inflight {
	const pending = inflight.get(key);
	if (pending) {
		pending.waiters++;
		return pending;
	}
	const controller = new AbortController();
	// Entries for a key are only ever written by fetchers of that key's type.
	const previous = cachedEntry(key)?.data as T | undefined;
	const request: Inflight = {
		promise: fetcher({ signal: controller.signal }, previous)
			.then(data => {
				remember(key, { data, updatedAt: Date.now(), version });
				return data;
			})
			.finally(() => {
				if (inflight.get(key) === request) inflight.delete(key);
			}),
		controller,
		waiters: 1,
	};
	inflight.set(key, request);
	return request;
}

/** Drop one waiter; the last one out aborts the request. */
export function releaseQuery(key: string, request: Inflight): void {
	request.waiters--;
	if (request.waiters > 0) return;
	if (inflight.get(key) === request) inflight.delete(key);
	request.controller.abort();
}
