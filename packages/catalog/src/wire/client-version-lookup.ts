import type { FetchImpl } from "@oh-my-pi/pi-utils";

/**
 * Fetches the current upstream client version. `signal` carries the lookup's
 * own timeout. Returns null (or throws) when no usable version is available.
 */
export type VersionResolver = (fetcher: FetchImpl, signal: AbortSignal) => Promise<string | null>;

/** Options for {@link createVersionLookup}; every tuning field has a production default. */
export interface VersionLookupOptions {
	resolve: VersionResolver;
	/** A resolved version is re-checked in the background after this long. Default: 1 hour. */
	ttlMs?: number;
	/** A failed lookup is not retried before this delay. Default: 10 minutes. */
	retryMs?: number;
	/** Bound on a single lookup. Default: 5 seconds. */
	timeoutMs?: number;
}

/** Process-wide tracker for one upstream client version. */
export interface VersionLookup {
	/**
	 * Makes a version available when possible. Never rejects.
	 *
	 * With no version yet (cold cache), waits for the lookup, which is bounded
	 * by its timeout; concurrent callers share one lookup, and `signal` ends this
	 * caller's wait without cancelling it. Once a version is known, a stale one
	 * is refreshed in the background and the call returns at once. Failures keep
	 * the last good version (or none) and suppress lookups for the retry window.
	 * An already-aborted `signal` starts no lookup.
	 */
	ensure(fetcher?: FetchImpl, signal?: AbortSignal): Promise<void>;
	/** Last version resolved, if any. */
	current(): string | undefined;
	/** Drops the cached version and back-off; tests only. */
	resetForTest(): void;
}

const DEFAULT_TTL_MS = 60 * 60_000;
const DEFAULT_RETRY_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Tracks an upstream client version for spoofed client headers, whose backend
 * gates features on the reported version: a pinned version drifts behind every
 * release until bumped by hand.
 */
export function createVersionLookup(options: VersionLookupOptions): VersionLookup {
	const { resolve } = options;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let version: string | undefined;
	let resolvedAt = 0;
	let failedAt: number | undefined;
	let inflight: Promise<void> | null = null;

	const lookup = async (fetcher: FetchImpl): Promise<void> => {
		let resolved: string | null = null;
		try {
			resolved = await resolve(fetcher, AbortSignal.timeout(timeoutMs));
		} catch {
			// Silent: the last good (or pinned) version stays valid when the source is unreachable.
		} finally {
			inflight = null;
			if (resolved) {
				version = resolved;
				resolvedAt = Date.now();
				failedAt = undefined;
			} else {
				failedAt = Date.now();
			}
		}
	};

	const start = (fetcher: FetchImpl, now: number): Promise<void> | null => {
		if (inflight) return inflight;
		if (failedAt !== undefined && now - failedAt < retryMs) return null;
		inflight = lookup(fetcher);
		return inflight;
	};

	return {
		ensure(fetcher: FetchImpl = fetch, signal?: AbortSignal): Promise<void> {
			if (signal?.aborted) return Promise.resolve();
			const now = Date.now();
			if (version !== undefined) {
				// Stale-while-revalidate: the known version is good enough to send.
				if (now - resolvedAt >= ttlMs) start(fetcher, now);
				return Promise.resolve();
			}
			const pending = start(fetcher, now);
			if (!pending) return Promise.resolve();
			if (!signal) return pending;
			const { promise: aborted, resolve: release } = Promise.withResolvers<void>();
			const onAbort = () => release();
			signal.addEventListener("abort", onAbort, { once: true });
			return Promise.race([pending, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
		},
		current: () => version,
		resetForTest() {
			version = undefined;
			resolvedAt = 0;
			failedAt = undefined;
			inflight = null;
		},
	};
}

/**
 * Resolves the `latest` npm dist-tag of `pkg`. Only plain `MAJOR.MINOR.PATCH`
 * values count; prereleases and malformed tags resolve to null.
 */
export function npmLatestVersion(pkg: string): VersionResolver {
	const url = `https://registry.npmjs.org/-/package/${pkg}/dist-tags`;
	return async (fetcher, signal) => {
		const response = await fetcher(url, { headers: { Accept: "application/json" }, signal });
		if (!response.ok) return null;
		const tags: unknown = await response.json();
		const latest = typeof tags === "object" && tags !== null && "latest" in tags ? tags.latest : undefined;
		return typeof latest === "string" && RELEASE_VERSION.test(latest) ? latest : null;
	};
}
