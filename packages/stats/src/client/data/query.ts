/**
 * `useQuery`: cached, live-revalidating data fetching for dashboard pages.
 *
 * - Results are cached per key for the page session, so revisiting a page or
 *   a range renders instantly from memory.
 * - A key change keeps the previous key's data on screen (`stale: true`) until
 *   the new data lands, so charts morph instead of flashing skeletons.
 * - Every cached entry remembers the live data version it was fetched at
 *   (see `useLive`); when the version advances, enabled queries refetch in the
 *   background, throttled so a burst of ingest batches costs one request.
 * - Identical keys share one in-flight request.
 */

import { startTransition, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useLive } from "./live";

interface CacheEntry {
	data: unknown;
	updatedAt: number;
	version: number;
}

const CACHE_LIMIT = 128;
/** Minimum spacing between live-driven refetches of one query. */
const LIVE_REFETCH_THROTTLE_MS = 1500;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

export interface QueryOptions {
	/** Only enabled queries fetch; hidden (kept-alive) pages pass `false`. Default true. */
	enabled?: boolean;
	/** Additionally refetch on this interval while enabled and the tab is visible. */
	pollMs?: number;
}

export interface QueryResult<T> {
	/** Data for the current key, or the previous key's data while it loads. */
	data: T | null;
	error: Error | null;
	/** Nothing to show yet (first load of this query). */
	loading: boolean;
	/** `data` belongs to a previous key; the current key is still loading. */
	stale: boolean;
	/** A background request is in flight. */
	refreshing: boolean;
	/** When the shown data was fetched. */
	updatedAt: number | null;
	refetch: () => void;
}

function remember(key: string, entry: CacheEntry): void {
	cache.delete(key);
	cache.set(key, entry);
	if (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
}

/** Fetch into the cache, sharing one request among concurrent callers of the same key. */
function load<T>(key: string, fetcher: () => Promise<T>, version: number): Promise<T> {
	const pending = inflight.get(key);
	if (pending) return pending as Promise<T>;
	const promise = fetcher()
		.then(data => {
			remember(key, { data, updatedAt: Date.now(), version });
			return data;
		})
		.finally(() => {
			inflight.delete(key);
		});
	inflight.set(key, promise);
	return promise;
}

/** Warm the cache for a key the user is likely to open next. No-op if cached for this version. */
export function prefetchQuery<T>(key: readonly unknown[], fetcher: () => Promise<T>, version: number): void {
	const keyString = JSON.stringify(key);
	const entry = cache.get(keyString);
	if (entry && entry.version >= version) return;
	load(keyString, fetcher, version).catch(() => {});
}

export function useQuery<T>(
	key: readonly unknown[],
	fetcher: () => Promise<T>,
	options?: QueryOptions,
): QueryResult<T> {
	const keyString = JSON.stringify(key);
	const enabled = options?.enabled ?? true;
	const pollMs = options?.pollMs;
	const { version } = useLive();

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const [error, setError] = useState<{ key: string; error: Error } | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;
	const keyRef = useRef(keyString);
	keyRef.current = keyString;
	const versionRef = useRef(version);
	versionRef.current = version;
	const lastShown = useRef<{ key: string; data: unknown; updatedAt: number } | null>(null);
	const lastFetchAt = useRef(0);

	const run = useCallback((targetKey: string) => {
		lastFetchAt.current = Date.now();
		setRefreshing(true);
		load(targetKey, () => fetcherRef.current(), versionRef.current)
			.then(() => {
				if (keyRef.current !== targetKey) return;
				startTransition(() => {
					setError(null);
					rerender();
				});
			})
			.catch((err: unknown) => {
				if (keyRef.current !== targetKey) return;
				setError({ key: targetKey, error: err instanceof Error ? err : new Error(String(err)) });
			})
			.finally(() => {
				if (keyRef.current === targetKey) setRefreshing(false);
			});
	}, []);

	// Fetch on key change / enable / data-version bump when the cache is behind.
	useEffect(() => {
		if (!enabled) return;
		const entry = cache.get(keyString);
		if (entry && entry.version >= version) return;
		const wait = entry ? lastFetchAt.current + LIVE_REFETCH_THROTTLE_MS - Date.now() : 0;
		if (wait <= 0) {
			run(keyString);
			return;
		}
		const timer = setTimeout(() => run(keyString), wait);
		return () => clearTimeout(timer);
	}, [keyString, enabled, version, run]);

	useEffect(() => {
		if (!enabled || !pollMs) return;
		const interval = setInterval(() => {
			if (!document.hidden) run(keyRef.current);
		}, pollMs);
		return () => clearInterval(interval);
	}, [enabled, pollMs, run]);

	const refetch = useCallback(() => run(keyRef.current), [run]);

	const entry = cache.get(keyString);
	if (entry) lastShown.current = { key: keyString, data: entry.data, updatedAt: entry.updatedAt };
	const shown = lastShown.current;
	const currentError = error?.key === keyString ? error.error : null;

	return {
		data: (shown?.data as T | undefined) ?? null,
		error: currentError,
		loading: !shown && !currentError,
		stale: !!shown && shown.key !== keyString,
		refreshing,
		updatedAt: shown?.updatedAt ?? null,
		refetch,
	};
}
