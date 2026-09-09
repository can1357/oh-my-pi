import { useCallback, useEffect, useRef, useState } from "react";

export interface ResourceResult<T> {
	data: T | null;
	error: Error | null;
	loading: boolean;
	refreshing: boolean;
	refetch: () => Promise<void>;
	updatedAt: number | null;
}

export interface ResourceOptions {
	pollMs?: number;
	enabled?: boolean;
}

// Session-scoped cache keyed by the resource key. Lets navigation between
// screens (and back to an already-visited range) render instantly from the
// last value and refresh in the background, instead of unmounting to a
// skeleton on every visit. Cleared only on full page reload.
const resourceCache = new Map<string, { data: unknown; updatedAt: number }>();
const RESOURCE_CACHE_LIMIT = 64;

export function useResource<T>(
	key: readonly unknown[],
	fetcher: (signal: AbortSignal) => Promise<T>,
	options?: ResourceOptions,
): ResourceResult<T> {
	const keyString = JSON.stringify(key);

	const [data, setData] = useState<T | null>(() => (resourceCache.get(keyString)?.data as T | undefined) ?? null);
	const [error, setError] = useState<Error | null>(null);
	const [loading, setLoading] = useState(() => !resourceCache.has(keyString));
	const [refreshing, setRefreshing] = useState(false);
	const [updatedAt, setUpdatedAt] = useState<number | null>(() => resourceCache.get(keyString)?.updatedAt ?? null);

	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;
	const keyStringRef = useRef(keyString);
	keyStringRef.current = keyString;

	const enabled = options?.enabled ?? true;
	const pollMs = options?.pollMs;

	const controllerRef = useRef<AbortController | null>(null);

	// Track whether we already hold data so a key change refreshes in the
	// background — keeping the prior view mounted so charts animate to the new
	// data instead of flashing a skeleton.
	const hasDataRef = useRef(false);
	hasDataRef.current = data !== null;

	const executeFetch = useCallback(async (isBackground: boolean) => {
		if (controllerRef.current) {
			controllerRef.current.abort();
		}

		const controller = new AbortController();
		controllerRef.current = controller;

		if (isBackground) {
			setRefreshing(true);
		} else {
			setLoading(true);
			setData(null);
		}
		setError(null);

		try {
			const result = await fetcherRef.current(controller.signal);
			if (controller.signal.aborted) {
				return;
			}
			resourceCache.set(keyStringRef.current, { data: result, updatedAt: Date.now() });
			if (resourceCache.size > RESOURCE_CACHE_LIMIT) {
				const oldestKey = resourceCache.keys().next().value;
				if (oldestKey !== undefined) resourceCache.delete(oldestKey);
			}
			setData(result);
			setUpdatedAt(Date.now());
			setError(null);
		} catch (err) {
			if (controller.signal.aborted) {
				return;
			}
			setError(err instanceof Error ? err : new Error(String(err)));
		} finally {
			if (!controller.signal.aborted) {
				setLoading(false);
				setRefreshing(false);
				if (controllerRef.current === controller) {
					controllerRef.current = null;
				}
			}
		}
	}, []);

	useEffect(() => {
		if (!enabled) {
			setLoading(false);
			setRefreshing(false);
			return;
		}

		const cached = resourceCache.get(keyString);
		if (cached) {
			// Show the cached value immediately, then revalidate in the background.
			setData(cached.data as T);
			setUpdatedAt(cached.updatedAt);
			setLoading(false);
			executeFetch(true);
		} else {
			// No cache: keep any stale data (range morph) or show a skeleton (first load).
			executeFetch(hasDataRef.current);
		}

		return () => {
			if (controllerRef.current) {
				controllerRef.current.abort();
				controllerRef.current = null;
			}
		};
	}, [keyString, enabled, executeFetch]);

	useEffect(() => {
		if (!enabled || !pollMs) {
			return;
		}

		const interval = setInterval(() => {
			if (document.hidden) {
				return;
			}
			void executeFetch(true);
		}, pollMs);

		return () => {
			clearInterval(interval);
		};
	}, [enabled, pollMs, executeFetch]);

	const refetch = useCallback(async () => {
		await executeFetch(true);
	}, [executeFetch]);

	return {
		data,
		error,
		loading,
		refreshing,
		refetch,
		updatedAt,
	};
}
