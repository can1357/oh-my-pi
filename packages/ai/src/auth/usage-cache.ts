import type { AuthCredentialStore } from "./store";
import type { AuthCredential, OAuthCredential } from "./types";
import type { CredentialPool } from "./pool";
import type { Provider } from "../types";
import type { UsageCredential, UsageProvider, UsageReport } from "../usage";

const USAGE_CACHE_PREFIX = "usage_cache:";
const USAGE_FORCE_REFRESH_CACHE_PREFIX = "force-refresh:";
/** Minimum interval between non-exhausted header snapshots; used by UsageService. */
export const USAGE_HEADER_INGEST_INTERVAL_MS = 60_000;
const USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000;
/**
 * Per-credential cool-down after a usage fetch fails. While this window is
 * active we serve the last successful value to avoid dropping the credential
 * from the report; without a previous value we just return null and retry
 * on the next poll. Used by UsageService.
 */
export const USAGE_FAILURE_BACKOFF_MS = 10_000;
/**
 * A manual invalidation persists across the next CLI process and serializes
 * same-provider probes, avoiding a cold-account burst against IP-limited
 * upstream usage endpoints.
 */
const USAGE_FORCE_REFRESH_TTL_MS = 5 * 60_000;
// Bumped from 3s — Claude usage retries up to 3 times with exponential backoff
// (~3.5s total worst case); a tight per-request budget aborts retries mid-cycle.
/** Default usage fetch timeout; used by the AuthStorage facade. */
export const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 10_000;

/** A single usage fetch target; used by usage probes and the cache. */
export type UsageRequestDescriptor = { provider: Provider; credential: UsageCredential; baseUrl?: string };
/** Forced-refresh markers active for one reports pass; used by UsageService. */
export type ForcedUsageRefresh = { all: boolean; providers: Set<Provider> };
/** Cached value and its logical expiry; used by UsageService. */
export type UsageCacheEntry<T> = { value: T; expiresAt: number };

function parseUsageCacheEntry<T>(raw: string): UsageCacheEntry<T> | undefined {
	try {
		const parsed = JSON.parse(raw) as { value?: T; expiresAt?: unknown };
		const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined;
		if (!expiresAt || !Number.isFinite(expiresAt)) return undefined;
		return { value: parsed.value as T, expiresAt };
	} catch {
		return undefined;
	}
}

/** Convert a stored credential for usage providers; used by usage and health services. */
export function buildUsageCredential(credential: AuthCredential): UsageCredential {
	if (credential.type === "api_key") {
		return {
			type: "api_key",
			apiKey: credential.key,
		};
	}
	return {
		type: "oauth",
		accessToken: credential.access,
		refreshToken: credential.refresh,
		expiresAt: credential.expires,
		accountId: credential.accountId,
		projectId: credential.projectId,
		email: credential.email,
		orgId: credential.orgId,
		orgName: credential.orgName,
		enterpriseUrl: credential.enterpriseUrl,
		apiEndpoint: credential.apiEndpoint,
		region: credential.region,
	};
}

/** Build a stable usage account key; used by cache and usage probes. */
export function usageCacheIdentity(credential: UsageCredential): string {
	const parts: string[] = [credential.type];
	const accountId = credential.accountId?.trim();
	if (accountId) parts.push(`account:${accountId}`);
	const email = credential.email?.trim().toLowerCase();
	if (email) parts.push(`email:${email}`);
	const orgId = credential.orgId?.trim();
	if (orgId) parts.push(`org:${orgId}`);
	const projectId = credential.projectId?.trim();
	if (projectId) parts.push(`project:${projectId}`);
	const enterpriseUrl = credential.enterpriseUrl?.trim().toLowerCase();
	if (enterpriseUrl) parts.push(`enterprise:${enterpriseUrl}`);
	// Only fall back to a secret-derived key when a stable account identifier is
	// unavailable. Including the token hash when accountId/email/orgId are present
	// causes cache misses on every OAuth refresh — usage data is per-account (or
	// per-org for org-only OAuth rows), not per-token.
	const hasStableIdentifier = Boolean(accountId || email || orgId);
	if (!hasStableIdentifier) {
		const secret = credential.apiKey?.trim() || credential.refreshToken?.trim() || credential.accessToken?.trim();
		if (secret) {
			parts.push(`secret:${Bun.hash(secret).toString(16)}`);
		} else {
			parts.push("anonymous");
		}
	}
	return parts.join("|");
}

/** Build one provider usage request; used by usage and health services. */
export function usageRequest(
	provider: Provider,
	credential: UsageCredential,
	baseUrl?: string,
): UsageRequestDescriptor {
	return { provider, credential, baseUrl };
}

/** Build an OAuth usage request; used by cache and usage services. */
export function oauthUsageRequest(
	provider: Provider,
	credential: OAuthCredential,
	baseUrl?: string,
): UsageRequestDescriptor {
	return usageRequest(provider, buildUsageCredential(credential), baseUrl);
}

/** Store-backed usage report cache: keys, epoch, force-refresh markers, invalidation; used by AuthStorage. */
export class UsageCache {
	#epoch = 0;
	#usageReportCacheKeysByProvider: Map<Provider, Set<string>> = new Map();
	#store: AuthCredentialStore;
	#pool: CredentialPool;
	#usageProviders: (provider: Provider) => UsageProvider | undefined;
	constructor(
		store: AuthCredentialStore,
		pool: CredentialPool,
		usageProviders: (provider: Provider) => UsageProvider | undefined,
	) {
		this.#store = store;
		this.#pool = pool;
		this.#usageProviders = usageProviders;
		// Opportunistic hygiene, once per AuthStorage lifetime: drop expired
		// cache rows (24h last-good retention). A cheap indexed DELETE;
		// failures must never block construction.
		try {
			this.#store.cleanExpiredCache();
		} catch {
			// Best-effort.
		}
	}

	get epoch(): number {
		return this.#epoch;
	}

	bumpEpoch(): void {
		this.#epoch += 1;
	}

	get<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.#store.getCache(`${USAGE_CACHE_PREFIX}${key}`);
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	getStale<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.#store.getCache(`${USAGE_CACHE_PREFIX}${key}`, {
			includeExpired: true,
		});
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	set<T>(key: string, entry: UsageCacheEntry<T>): void {
		const payload = JSON.stringify({
			value: entry.value,
			expiresAt: entry.expiresAt,
		});
		const durableExpiresAt =
			entry.value === null ? entry.expiresAt : Math.max(entry.expiresAt, Date.now() + USAGE_LAST_GOOD_RETENTION_MS);
		this.#store.setCache(`${USAGE_CACHE_PREFIX}${key}`, payload, Math.floor(durableExpiresAt / 1000));
	}

	deletePrefix(prefix: string): boolean {
		if (!this.#store.deleteCachePrefix) return false;
		this.#store.deleteCachePrefix(`${USAGE_CACHE_PREFIX}${prefix}`);
		return true;
	}

	#normalizeUsageBaseUrl(baseUrl?: string): string {
		return baseUrl?.trim().replace(/\/+$/, "") ?? "";
	}

	#usageCacheProviderKey(provider: Provider): string {
		const cacheVersion = this.#usageProviders(provider)?.cacheVersion;
		return cacheVersion === undefined ? provider : `${cacheVersion}:${provider}`;
	}

	#usageForceRefreshCacheKey(provider?: Provider): string {
		return provider
			? `${USAGE_FORCE_REFRESH_CACHE_PREFIX}provider:${provider}`
			: `${USAGE_FORCE_REFRESH_CACHE_PREFIX}all`;
	}

	markForceRefresh(provider?: Provider): void {
		this.set(this.#usageForceRefreshCacheKey(provider), {
			value: true,
			expiresAt: Date.now() + USAGE_FORCE_REFRESH_TTL_MS,
		});
	}

	#hasUsageForceRefresh(provider?: Provider): boolean {
		const key = this.#usageForceRefreshCacheKey(provider);
		const entry = this.get<boolean>(key);
		if (entry?.value !== true) return false;
		if (entry.expiresAt > Date.now()) return true;
		this.set(key, { value: null, expiresAt: 0 });
		return false;
	}

	forcedRefresh(requests: readonly UsageRequestDescriptor[]): ForcedUsageRefresh {
		const all = this.#hasUsageForceRefresh();
		const providers = new Set<Provider>();
		for (const request of requests) providers.add(request.provider);
		if (!all) {
			for (const provider of providers) {
				if (!this.#hasUsageForceRefresh(provider)) providers.delete(provider);
			}
		}
		return { all, providers };
	}

	clearForceRefresh(refresh: ForcedUsageRefresh): void {
		if (refresh.all)
			this.set(this.#usageForceRefreshCacheKey(), {
				value: null,
				expiresAt: 0,
			});
		for (const provider of refresh.providers) {
			this.set(this.#usageForceRefreshCacheKey(provider), {
				value: null,
				expiresAt: 0,
			});
		}
	}

	reportKey(request: UsageRequestDescriptor): string {
		const baseUrl = this.#normalizeUsageBaseUrl(request.baseUrl) || "default";
		const identity = usageCacheIdentity(request.credential);
		const providerKey = this.#usageCacheProviderKey(request.provider);
		const cacheKey = `report:${providerKey}:${baseUrl}:${identity}`;
		const cacheKeys = this.#usageReportCacheKeysByProvider.get(request.provider) ?? new Set<string>();
		cacheKeys.add(cacheKey);
		this.#usageReportCacheKeysByProvider.set(request.provider, cacheKeys);
		return cacheKey;
	}

	reportsKey(requests: readonly UsageRequestDescriptor[]): string {
		const snapshot = requests
			.map(request => {
				const providerKey = this.#usageCacheProviderKey(request.provider);
				return `${providerKey}:${this.#normalizeUsageBaseUrl(request.baseUrl) || "default"}:${usageCacheIdentity(request.credential)}`;
			})
			.sort()
			.join("\n");
		return `reports:${Bun.hash(snapshot).toString(16)}`;
	}

	/**
	 * Force the next usage fetch for `provider` to bypass the 5-min cache, so
	 * `/usage` reflects a freshly-redeemed reset instead of stale numbers.
	 */
	invalidate(provider: string, baseUrl?: string): void {
		this.#epoch += 1;
		const expired = Date.now() - 1;
		for (const entry of this.#pool.entries(provider)) {
			if (entry.credential.type !== "oauth") continue;
			const cacheKey = this.reportKey(oauthUsageRequest(provider, entry.credential, baseUrl));
			const existing = this.getStale<UsageReport | null>(cacheKey);
			this.set(cacheKey, {
				value: existing?.value ?? null,
				expiresAt: expired,
			});
		}
	}

	/**
	 * Expire cached reports for a provider after its runtime usage implementation changes.
	 * This keeps a newly installed extension provider from serving a built-in snapshot.
	 */
	invalidateForProvider(provider: Provider): void {
		this.#epoch += 1;
		const expired = Date.now() - 1;
		const prefix = `report:${this.#usageCacheProviderKey(provider)}:`;
		if (this.deletePrefix(prefix)) return;
		const cacheKeys = new Set(this.#usageReportCacheKeysByProvider.get(provider));
		for (const entry of this.#pool.entries(provider)) {
			cacheKeys.add(
				this.reportKey({
					provider,
					credential: buildUsageCredential(entry.credential),
				}),
			);
		}
		for (const cacheKey of cacheKeys) {
			this.set(cacheKey, { value: null, expiresAt: expired });
		}
	}

	/**
	 * Drop report snapshots for a user-requested refresh so a failed probe
	 * cannot replay the pre-invalidation last-good value. The persisted marker
	 * makes the next same-provider refresh serial rather than a cold fan-out.
	 */
	async clearReports(
		provider: string | undefined,
		collectRequests: () => Promise<UsageRequestDescriptor[]>,
	): Promise<void> {
		this.#epoch += 1;
		const prefix = provider ? `report:${this.#usageCacheProviderKey(provider)}:` : "report:";
		if (!this.deletePrefix(prefix)) {
			// Third-party stores may not support prefix deletion. Clear every active
			// request key instead, including API-key and environment credentials.
			const requests = await collectRequests();
			for (const request of requests) {
				if (provider && request.provider !== provider) continue;
				this.set(this.reportKey(request), {
					value: null,
					expiresAt: 0,
				});
			}
		}
		if (!this.#store.fetchUsageReports) this.markForceRefresh(provider);
	}

	invalidateProviderKey(providerKey: string): void {
		const oauthSuffix = ":oauth";
		if (!providerKey.endsWith(oauthSuffix)) return;
		this.invalidate(providerKey.slice(0, -oauthSuffix.length));
	}
}
