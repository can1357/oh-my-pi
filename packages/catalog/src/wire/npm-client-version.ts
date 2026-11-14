import type { FetchImpl } from "@oh-my-pi/pi-utils";

/** Tuning for {@link createNpmVersionLookup}; every field has a production default. */
export interface NpmVersionLookupOptions {
	/** A resolved version is re-checked after this long. Default: 1 hour. */
	ttlMs?: number;
	/** A failed lookup is not retried before this delay. Default: 10 minutes. */
	retryMs?: number;
	/** Bound on a single registry request. Default: 5 seconds. */
	timeoutMs?: number;
}

/** Process-wide `latest` dist-tag tracker for one npm package. */
export interface NpmVersionLookup {
	/**
	 * Resolves the package's `latest` dist-tag when no fresh value is cached.
	 * Never rejects: failures keep the last good version (or none) and suppress
	 * further lookups for the retry window. Concurrent callers share one lookup,
	 * so it is bounded only by its own timeout; `signal` ends this caller's wait
	 * without cancelling the lookup.
	 */
	ensure(fetcher?: FetchImpl, signal?: AbortSignal): Promise<void>;
	/** Last version resolved from the registry, if any. */
	current(): string | undefined;
	/** Drops every cached result and back-off; tests only. */
	resetForTest(): void;
}

const DEFAULT_TTL_MS = 60 * 60_000;
const DEFAULT_RETRY_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Tracks the `latest` npm dist-tag of `pkg`, for clients whose backend reads
 * the caller's version from a spoofed User-Agent: a pinned version drifts
 * behind every release until bumped by hand. Only plain `MAJOR.MINOR.PATCH`
 * values are adopted; prereleases and malformed tags count as failures.
 */
export function createNpmVersionLookup(pkg: string, options: NpmVersionLookupOptions = {}): NpmVersionLookup {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const url = `https://registry.npmjs.org/-/package/${pkg}/dist-tags`;

	let version: string | undefined;
	let resolvedAt = 0;
	let failedAt: number | undefined;
	let inflight: Promise<void> | null = null;

	const lookup = async (fetcher: FetchImpl): Promise<void> => {
		let latest: string | undefined;
		try {
			const response = await fetcher(url, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.ok) {
				const tags = (await response.json()) as unknown;
				const tag = tags && typeof tags === "object" ? (tags as Record<string, unknown>).latest : undefined;
				if (typeof tag === "string" && RELEASE_VERSION.test(tag)) latest = tag;
			}
		} catch {
			// Silent: the last good (or pinned) version stays valid when the registry is unreachable.
		} finally {
			inflight = null;
			if (latest) {
				version = latest;
				resolvedAt = Date.now();
				failedAt = undefined;
			} else {
				failedAt = Date.now();
			}
		}
	};

	return {
		ensure(fetcher: FetchImpl = fetch, signal?: AbortSignal): Promise<void> {
			if (!inflight) {
				const now = Date.now();
				if (failedAt !== undefined && now - failedAt < retryMs) return Promise.resolve();
				if (version !== undefined && now - resolvedAt < ttlMs) return Promise.resolve();
				inflight = lookup(fetcher);
			}
			const pending = inflight;
			if (!signal) return pending;
			if (signal.aborted) return Promise.resolve();
			const { promise: aborted, resolve } = Promise.withResolvers<void>();
			const onAbort = () => resolve();
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
