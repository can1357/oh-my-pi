/**
 * `useQuery`: cached, live-revalidating data fetching for dashboard pages.
 *
 * - Results are cached per key for the page session, so revisiting a page or
 *   a range renders instantly from memory. Multi-MB detail payloads (traces,
 *   request details) live in their own small LRUs so they don't pile up.
 * - A key change keeps the previous key's data on screen (`stale: true`) until
 *   the new data lands, so charts morph instead of flashing skeletons.
 * - Every cached entry remembers the live data version it was fetched at
 *   (see `useLiveVersion`); when the version advances, enabled queries refetch
 *   in the background, throttled so a burst of ingest batches costs one request.
 * - Identical keys share one in-flight request; it is aborted once no query
 *   waits for it any more.
 * - Fetchers receive the cached data for their key, so conditional requests
 *   can resolve to that same object; an unchanged reference does not re-render.
 */

import { startTransition, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { currentLiveVersion, useLiveVersion } from "./live";
import {
	cachedEntry,
	type Inflight,
	inflightRequest,
	loadQuery,
	type QueryFetcher,
	releaseQuery,
} from "./query-store";

/** Minimum spacing between live-driven refetches of one query. */
const LIVE_REFETCH_THROTTLE_MS = 1500;

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

/** Warm the cache for a key the user is likely to open next. No-op if cached for this version. */
export function prefetchQuery<T>(key: readonly unknown[], fetcher: () => Promise<T>, version: number): void {
	const keyString = JSON.stringify(key);
	const entry = cachedEntry(keyString);
	if (entry && entry.version >= version) return;
	// Never released: a prefetch runs to completion.
	loadQuery(keyString, currentLiveVersion(), fetcher).promise.catch(() => {});
}

export function useQuery<T>(
	key: readonly unknown[],
	fetcher: QueryFetcher<T>,
	options?: QueryOptions,
): QueryResult<T> {
	const keyString = JSON.stringify(key);
	const enabled = options?.enabled ?? true;
	const pollMs = options?.pollMs;
	const version = useLiveVersion(enabled);

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const [error, setError] = useState<{ key: string; error: Error } | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;
	const keyRef = useRef(keyString);
	keyRef.current = keyString;
	const lastShown = useRef<{ key: string; data: unknown; updatedAt: number } | null>(null);
	const lastFetchAt = useRef(0);
	/** The request this query currently waits on. */
	const waiting = useRef<{ key: string; request: Inflight } | null>(null);

	const run = useCallback((targetKey: string) => {
		lastFetchAt.current = Date.now();
		const current = waiting.current;
		if (current?.key === targetKey && inflightRequest(targetKey) === current.request) return;
		const shownBefore = cachedEntry(targetKey)?.data;
		setRefreshing(true);
		const request = loadQuery(targetKey, currentLiveVersion(), fetcherRef.current);
		waiting.current = { key: targetKey, request };
		// Join the new request before leaving the old one, so a shared request isn't aborted in between.
		if (current) releaseQuery(current.key, current.request);
		request.promise
			.then(data => {
				if (keyRef.current !== targetKey) return;
				// Revalidated to the very same object: nothing on screen changes.
				if (data === shownBefore) {
					setError(prev => (prev === null ? prev : null));
					return;
				}
				startTransition(() => {
					setError(null);
					rerender();
				});
			})
			.catch((err: unknown) => {
				if (keyRef.current !== targetKey || request.controller.signal.aborted) return;
				setError({ key: targetKey, error: err instanceof Error ? err : new Error(String(err)) });
			})
			.finally(() => {
				if (waiting.current?.request === request) waiting.current = null;
				if (keyRef.current === targetKey) setRefreshing(false);
			});
	}, []);

	/** Stop waiting so an abandoned multi-MB fetch can be aborted. */
	const leave = useCallback(() => {
		const current = waiting.current;
		waiting.current = null;
		if (current) releaseQuery(current.key, current.request);
	}, []);

	// Unmounting, disabling, or switching keys abandons the current request.
	useEffect(() => leave, [leave]);

	// Fetch on key change / enable / data-version bump when the cache is behind.
	useEffect(() => {
		if (!enabled || (waiting.current && waiting.current.key !== keyString)) leave();
		if (!enabled) return;
		const entry = cachedEntry(keyString);
		if (entry && entry.version >= version) return;
		const wait = entry ? lastFetchAt.current + LIVE_REFETCH_THROTTLE_MS - Date.now() : 0;
		if (wait <= 0) {
			run(keyString);
			return;
		}
		const timer = setTimeout(() => run(keyString), wait);
		return () => clearTimeout(timer);
	}, [keyString, enabled, version, run, leave]);

	useEffect(() => {
		if (!enabled || !pollMs) return;
		const interval = setInterval(() => {
			if (!document.hidden) run(keyRef.current);
		}, pollMs);
		return () => clearInterval(interval);
	}, [enabled, pollMs, run]);

	const refetch = useCallback(() => run(keyRef.current), [run]);

	const entry = cachedEntry(keyString);
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
