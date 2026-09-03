/**
 * Tests for the new usage-cache contracts introduced after the broker
 * migration surfaced Anthropic per-IP rate limits:
 *
 *   1. Per-credential cache stores the last successful report; failures
 *      DON'T overwrite a stale-but-good entry with null.
 *   2. With a stale-but-good entry, a failure serves the previous value
 *      (cached for a short cool-down) instead of dropping the credential
 *      from the report.
 *   3. Without a previous value (a cold failure), a failure caches `null` for
 *      the failure backoff window — a repeat poll within the window is served
 *      from cache (no refetch); the entry expires and the next poll retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { alibabaTokenPlanUsageProvider } from "@oh-my-pi/pi-ai/usage/alibaba-token-plan";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";
import { serializeAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";

function anthropicReports(reports: UsageReport[] | null): UsageReport[] {
	return (reports ?? []).filter(r => r.provider === "anthropic");
}

function requireAnthropicReport(reports: UsageReport[] | null): UsageReport {
	const report = anthropicReports(reports)[0];
	if (!report) throw new Error("expected anthropic usage report");
	return report;
}

function requireLimit(report: UsageReport, id: string): UsageLimit {
	const limit = report.limits.find(candidate => candidate.id === id);
	if (!limit) throw new Error(`expected ${id} limit`);
	return limit;
}

/**
 * Force every cache entry to look stale to AuthStorage WITHOUT dropping the
 * value. The cache layer is two-tier: the store-level `expiresAtSec` controls
 * whether `getCache` returns anything at all, and the JSON payload's own
 * `expiresAt` is what AuthStorage compares against `Date.now()` to decide if
 * the entry is fresh. Mutating only the inner expiresAt simulates time
 * passing while keeping the last-good value reachable for the failure path.
 */
function expireCachePayloads(store: ObservableStore): void {
	for (const [key, entry] of store.cache) {
		try {
			const parsed = JSON.parse(entry.value);
			parsed.expiresAt = 1; // positive but already in the past (epoch ms)
			store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
		} catch {
			// Non-JSON entries — leave alone.
		}
	}
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, CacheEntry>;
}

/**
 * Minimal in-memory `AuthCredentialStore` exposing the cache so we can
 * assert what AuthStorage writes to it during usage fetches.
 */
function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, CacheEntry>();
	return {
		cache,
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return rows;
		},
		upsertAuthCredentialForProvider() {
			return rows;
		},
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(id: number, email: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

function makeReport(account: string): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "anthropic:5h",
				label: "5 Hour",
				scope: { provider: "anthropic", windowId: "5h" },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 42, limit: 100, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email: account, accountId: `account-${account}` },
	};
}

function makeTieredReport(account: string): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now() - 10_000,
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 42, limit: 100, usedFraction: 0.42, unit: "percent" },
				status: "ok",
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", windowId: "7d", shared: true },
				window: { id: "7d", label: "7 Day" },
				amount: { used: 84, limit: 100, usedFraction: 0.84, unit: "percent" },
				status: "ok",
			},
			{
				id: "anthropic:7d:opus",
				label: "Claude 7 Day (Opus)",
				scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
				window: { id: "7d", label: "7 Day" },
				amount: { used: 12, limit: 100, usedFraction: 0.12, unit: "percent" },
				status: "ok",
			},
		],
		metadata: {
			email: account,
			accountId: `account-${account}`,
			endpoint: "https://api.anthropic.com/api/oauth/usage",
		},
	};
}

function usageHeaders(fiveHour: string, sevenDay: string, sevenDayModelScoped?: string): Record<string, string> {
	return {
		"anthropic-ratelimit-unified-5h-utilization": fiveHour,
		"anthropic-ratelimit-unified-5h-reset": "1780405800",
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": sevenDay,
		"anthropic-ratelimit-unified-7d-reset": "1780531200",
		"anthropic-ratelimit-unified-7d-status": "allowed",
		...(sevenDayModelScoped === undefined
			? {}
			: {
					"anthropic-ratelimit-unified-7d_oi-utilization": sevenDayModelScoped,
					"anthropic-ratelimit-unified-7d_oi-reset": "1780617600",
					"anthropic-ratelimit-unified-7d_oi-status": "allowed",
				}),
	};
}

describe("AuthStorage usage cache: last-good failure fallback", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com")]);
		// Restrict the resolver to anthropic. Without this, AuthStorage enumerates
		// every default provider and — for any provider whose `supports()` accepts
		// the matching `*_API_KEY` env var present on the test host — fans out a
		// real network fetch per poll. 3 polls × N real fetches blows past the 5s
		// test budget intermittently.
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("caches a successful report and replays it on a second poll", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return goldReport;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		const second = anthropicReports(await storage.fetchUsageReports());
		expect(second).toHaveLength(1);
		// Cache hit — provider was NOT called a second time.
		expect(calls).toBe(1);
	});

	it("cold-fetches instead of replaying a report stored under the previous Anthropic cache version", async () => {
		const previousVersionKey = "usage_cache:report:2:anthropic:default:oauth|account:account-1|email:a@example.com";
		store.cache.set(previousVersionKey, {
			value: JSON.stringify({ value: makeReport("a@example.com"), expiresAt: Date.now() + 60_000 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});
		const base = makeReport("a@example.com");
		const freshReport = { ...base, metadata: { ...base.metadata, source: "fresh-v3-fetch" } };
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(freshReport);

		const reports = anthropicReports(await storage.fetchUsageReports());

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(reports[0]?.metadata?.source).toBe("fresh-v3-fetch");
	});

	it("caches null on a cold failure for the backoff window, then retries after it expires", async () => {
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});

		// First poll: cold fetch fails → caches null for the backoff window.
		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(0);
		expect(calls).toBe(1);

		// Second poll within the window: served from the cold-null cache — no refetch.
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(1);
		expect(second).toHaveLength(0);

		// Expire the backoff entry → the next poll refetches (and fails again).
		expireCachePayloads(store);
		const third = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(2);
		expect(third).toHaveLength(0);
	});

	it("serves last-good value through a failure cycle", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			if (calls === 1) return goldReport;
			return null;
		});

		// First poll: real fetch → cached.
		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Force every cached entry to expire so the next poll refetches.
		// Bun's `bun:test` doesn't ship setSystemTime, so we manipulate the
		// observable store cache directly — equivalent to advancing time past
		// the success TTL.
		expireCachePayloads(store);

		// Second poll: cache expired → refetch → provider returns null →
		// AuthStorage falls back to last-good and the report stays populated.
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(2);
		expect(second).toHaveLength(1);
		// The fallback value must be the SAME report (not a synthetic empty one).
		expect(second?.[0]?.limits[0]?.amount.used).toBe(42);
	});

	it("re-attempts the failing credential after the cool-down expires", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			// Succeed on attempt 1, fail on 2, succeed on 3.
			if (calls === 2) return null;
			return goldReport;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Expire success cache → poll 2 fetches and 429s → cool-down written.
		expireCachePayloads(store);
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(second).toHaveLength(1); // last-good fallback
		expect(calls).toBe(2);

		// Expire the cool-down → poll 3 refetches → success.
		expireCachePayloads(store);
		const third = anthropicReports(await storage.fetchUsageReports());
		expect(third).toHaveLength(1);
		expect(calls).toBe(3);
	});

	it("does not replay last-good quota after an explicit invalidation", async () => {
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return calls === 1 ? makeReport("a@example.com") : null;
		});

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);
		await storage.invalidateUsageCache();

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);
		expect(calls).toBe(2);
	});
});

describe("AuthStorage usage cache: explicit invalidation", () => {
	it("clears cached API-key reports before the next usage read", async () => {
		const store = makeStore([
			{
				id: 1,
				provider: "zai",
				credential: { type: "api_key", key: "zai-key" },
				disabledCause: null,
			},
		]);
		let calls = 0;
		const usageProvider: UsageProvider = {
			id: "zai",
			supports: params => params.provider === "zai" && params.credential.type === "api_key",
			async fetchUsage() {
				calls += 1;
				return {
					provider: "zai",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "zai:requests:5h",
							label: "Z.AI Request Quota",
							scope: { provider: "zai", windowId: "5h" },
							amount: { used: calls === 1 ? 80 : 20, limit: 100, unit: "requests" },
							status: "ok",
						},
					],
				};
			},
		};
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "zai" ? usageProvider : undefined),
		});
		await storage.reload();
		try {
			const initial = await storage.fetchUsageReports();
			expect(initial?.[0]?.limits[0]?.amount.used).toBe(80);

			await storage.invalidateUsageCache();

			const refreshed = await storage.fetchUsageReports();
			expect(refreshed?.[0]?.limits[0]?.amount.used).toBe(20);
			expect(calls).toBe(2);
		} finally {
			storage.close();
		}
	});

	it("serializes a persisted Codex refresh and returns an upgraded plan", async () => {
		const store = makeStore([
			{
				id: 1,
				provider: "openai-codex",
				credential: {
					type: "oauth",
					access: "access-free",
					refresh: "refresh-free",
					expires: Date.now() + 3_600_000,
					accountId: "account-free",
					email: "free@example.com",
				},
				disabledCause: null,
			},
			{
				id: 2,
				provider: "openai-codex",
				credential: {
					type: "oauth",
					access: "access-upgraded",
					refresh: "refresh-upgraded",
					expires: Date.now() + 3_600_000,
					accountId: "account-upgraded",
					email: "upgraded@example.com",
				},
				disabledCause: null,
			},
			{
				id: 3,
				provider: "openai-codex",
				credential: {
					type: "oauth",
					access: "access-other",
					refresh: "refresh-other",
					expires: Date.now() + 3_600_000,
					accountId: "account-other",
					email: "other@example.com",
				},
				disabledCause: null,
			},
		]);
		let upgraded = false;
		const refreshStarted = new Map<string, PromiseWithResolvers<void>>();
		const refreshReleases = new Map<string, PromiseWithResolvers<void>>();
		for (const accountId of ["account-free", "account-upgraded", "account-other"]) {
			refreshStarted.set(accountId, Promise.withResolvers<void>());
			refreshReleases.set(accountId, Promise.withResolvers<void>());
		}
		const startedAccounts: string[] = [];
		const usageProvider: UsageProvider = {
			id: "openai-codex",
			supports: params => params.provider === "openai-codex" && params.credential.type === "oauth",
			async fetchUsage(params) {
				const accountId = params.credential.accountId;
				if (!accountId) return null;
				if (upgraded) {
					const started = refreshStarted.get(accountId);
					const release = refreshReleases.get(accountId);
					if (!started || !release) throw new Error(`unexpected account ${accountId}`);
					startedAccounts.push(accountId);
					started.resolve();
					await release.promise;
				}
				return {
					provider: "openai-codex",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "openai-codex:7d",
							label: "7 days",
							scope: { provider: "openai-codex", windowId: "7d" },
							amount: { used: 0, limit: 100, unit: "percent" },
							status: "ok",
						},
					],
					metadata: {
						accountId,
						email: params.credential.email,
						planType: upgraded && accountId === "account-upgraded" ? "pro" : "free",
					},
				};
			},
		};
		const initialStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});
		await initialStorage.reload();
		try {
			expect(await initialStorage.fetchUsageReports()).toHaveLength(3);
			await initialStorage.invalidateUsageCache();
		} finally {
			initialStorage.close();
		}

		upgraded = true;
		const refreshedStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});
		await refreshedStorage.reload();
		try {
			const refresh = refreshedStorage.fetchUsageReports();
			const freeStarted = refreshStarted.get("account-free");
			const freeRelease = refreshReleases.get("account-free");
			if (!freeStarted || !freeRelease) throw new Error("missing free-account refresh gates");
			await freeStarted.promise;
			expect(startedAccounts).toEqual(["account-free"]);
			freeRelease.resolve();

			const upgradedStarted = refreshStarted.get("account-upgraded");
			const upgradedRelease = refreshReleases.get("account-upgraded");
			if (!upgradedStarted || !upgradedRelease) throw new Error("missing upgraded-account refresh gates");
			await upgradedStarted.promise;
			expect(startedAccounts).toEqual(["account-free", "account-upgraded"]);
			upgradedRelease.resolve();

			const otherStarted = refreshStarted.get("account-other");
			const otherRelease = refreshReleases.get("account-other");
			if (!otherStarted || !otherRelease) throw new Error("missing other-account refresh gates");
			await otherStarted.promise;
			expect(startedAccounts).toEqual(["account-free", "account-upgraded", "account-other"]);
			otherRelease.resolve();

			const reports = await refresh;
			expect(reports?.find(report => report.metadata?.accountId === "account-upgraded")?.metadata?.planType).toBe(
				"pro",
			);
		} finally {
			refreshedStorage.close();
		}
	});
});
describe("AuthStorage usage cache: provider failure policy", () => {
	it("drops stale QwenCloud quota after the optional console session expires", async () => {
		const store = makeStore([
			{
				id: 1,
				provider: "alibaba-token-plan",
				credential: {
					type: "api_key",
					key: serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=test"),
				},
				disabledCause: null,
			},
		]);
		let usageCalls = 0;
		const usageFetch = Object.assign(
			(input: string | URL | Request) => {
				if (String(input).endsWith("/tool/user/info.json")) {
					return Promise.resolve(Response.json({ code: "200", data: { secToken: "sec-token" } }));
				}
				usageCalls++;
				return Promise.resolve(
					usageCalls === 1
						? Response.json({
								data: {
									DataV2: {
										data: {
											data: {
												per5HourPercentage: 0.25,
												per5HourResetTime: 1_800_000_000_000,
												per1WeekPercentage: 0.5,
												per1WeekResetTime: 1_800_100_000_000,
											},
										},
									},
								},
							})
						: Response.json({
								code: "ConsoleNeedLogin",
								message: "You need to log in.",
								successResponse: false,
							}),
				);
			},
			{ preconnect: fetch.preconnect },
		);
		const storage = new AuthStorage(store, {
			usageFetch,
			usageProviderResolver: provider =>
				provider === "alibaba-token-plan" ? alibabaTokenPlanUsageProvider : undefined,
		});
		await storage.reload();
		try {
			const first = (await storage.fetchUsageReports()) ?? [];
			expect(first.filter(report => report.provider === "alibaba-token-plan")).toHaveLength(1);
			expect(usageCalls).toBe(1);

			expireCachePayloads(store);
			const second = (await storage.fetchUsageReports()) ?? [];
			expect(second.filter(report => report.provider === "alibaba-token-plan")).toHaveLength(0);
			expect(usageCalls).toBe(2);
		} finally {
			storage.close();
		}
	});
});

describe("AuthStorage usage cache: jitter", () => {
	it("writes per-credential cache TTLs with ±25% jitter so refreshes decorrelate", async () => {
		const store = makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		try {
			const goldA = makeReport("a@example.com");
			const goldB = makeReport("b@example.com");
			vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
				return params.credential.email === "a@example.com" ? goldA : goldB;
			});

			await storage.fetchUsageReports();

			// The store-level TTL is bumped to the 24h durable-retention floor so
			// `getStale` can recover last-good values; the freshness TTL we actually
			// jitter lives in the JSON payload. Read that, not the store TTL.
			const freshExpiries: number[] = [];
			for (const entry of store.cache.values()) {
				if (entry.value.length === 0) continue;
				const parsed = JSON.parse(entry.value);
				if (typeof parsed?.expiresAt === "number") freshExpiries.push(parsed.expiresAt);
			}
			expect(freshExpiries.length).toBeGreaterThanOrEqual(2);
			const now = Date.now();
			for (const expiry of freshExpiries) {
				const delta = expiry - now;
				expect(delta).toBeGreaterThan(3.5 * 60_000);
				expect(delta).toBeLessThan(6.5 * 60_000);
			}
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AuthStorage usage cache: header ingestion", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com")]);
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("does not let repeated cold header ingestion suppress the first full fetch", async () => {
		const start = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(start);
		const baseReport = makeTieredReport("a@example.com");
		const fullReport: UsageReport = {
			...baseReport,
			limits: [
				...baseReport.limits,
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: { used: 12.34, limit: 100, usedFraction: 0.1234, unit: "usd" },
					status: "ok",
				},
			],
			raw: { extra_usage: { used: 1_234, limit: 10_000 } },
		};
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return fullReport;
		});

		await storage.getApiKey("anthropic", "s");
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.02", "0.3"), { sessionId: "s" })).toBe(true);
		now.mockReturnValue(start + 60_001);
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.6"), { sessionId: "s" })).toBe(true);

		const report = requireAnthropicReport(await storage.fetchUsageReports());
		expect(calls).toBe(1);
		expect(report.metadata?.source).toBeUndefined();
		expect(report.metadata?.email).toBe("a@example.com");
		expect(report.metadata?.accountId).toBe("account-a@example.com");
		expect(requireLimit(report, "anthropic:7d:opus").amount.used).toBe(12);
		expect(requireLimit(report, "anthropic:extra").amount.used).toBe(12.34);
	});

	it("merges active credential metadata into existing header cache entries", async () => {
		const start = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(start);
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);
		await storage.getApiKey("anthropic", "legacy-session");
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.02", "0.3"), { sessionId: "legacy-session" }),
		).toBe(true);

		for (const [key, entry] of store.cache) {
			const payload = JSON.parse(entry.value) as { value?: UsageReport | null };
			if (payload.value?.metadata?.source !== "ratelimit-headers") continue;
			payload.value.metadata = { source: "ratelimit-headers" };
			store.cache.set(key, { value: JSON.stringify(payload), expiresAtSec: entry.expiresAtSec });
		}

		now.mockReturnValue(start + 60_001);
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.6"), { sessionId: "legacy-session" }),
		).toBe(true);

		const report = requireAnthropicReport(await storage.fetchUsageReports());
		const cachedReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(requireLimit(cachedReport, "anthropic:5h").amount.used).toBe(5);
		expect(report.metadata?.source).toBe("ratelimit-headers");
		expect(report.metadata?.email).toBe("a@example.com");
		expect(report.metadata?.accountId).toBe("account-1");
		expect(requireLimit(report, "anthropic:5h").amount.used).toBe(5);
	});

	it("throttles repeated header ingestion for the same credential cache key", async () => {
		await storage.getApiKey("anthropic", "s");
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.02", "0.3"), { sessionId: "s" })).toBe(true);
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.6"), { sessionId: "s" })).toBe(false);
	});

	it("preserves a failed fetch cooldown across exhausted header ingestion, then retries after expiry", async () => {
		const start = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(start);
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});

		await storage.getApiKey("anthropic", "cooldown-session");
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.02", "0.3"), {
				sessionId: "cooldown-session",
			}),
		).toBe(true);
		expect(await storage.fetchUsageReports()).toHaveLength(1);
		expect(calls).toBe(1);

		now.mockReturnValue(start + 1_000);
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("1", "0.3"), {
				sessionId: "cooldown-session",
			}),
		).toBe(true);
		expect(await storage.fetchUsageReports()).toHaveLength(1);
		expect(calls).toBe(1);

		now.mockReturnValue(start + 12_501);
		expect(await storage.fetchUsageReports()).toHaveLength(1);
		expect(calls).toBe(2);
	});

	it("does not let header ingestion slide the full-report refresh deadline", async () => {
		const start = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(start);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const makeFullReport = (extraUsed: number): UsageReport => {
			const baseReport = makeTieredReport("a@example.com");
			return {
				...baseReport,
				limits: [
					...baseReport.limits,
					{
						id: "anthropic:extra",
						label: "Claude Extra Usage",
						scope: { provider: "anthropic", windowId: "extra" },
						amount: {
							used: extraUsed,
							limit: 100,
							usedFraction: extraUsed / 100,
							unit: "usd",
						},
						status: "ok",
					},
				],
				raw: { extra_usage: { used: extraUsed * 100, limit: 10_000 } },
			};
		};
		const firstFullReport = makeFullReport(12.34);
		const secondFullReport = makeFullReport(56.78);
		const fetchSpy = vi
			.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage")
			.mockResolvedValueOnce(firstFullReport)
			.mockResolvedValue(secondFullReport);

		const initialReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(requireLimit(initialReport, "anthropic:extra").amount.used).toBe(12.34);
		await storage.getApiKey("anthropic", "sliding-session");

		now.mockReturnValue(start + 60_000);
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.6"), {
				sessionId: "sliding-session",
			}),
		).toBe(true);
		now.mockReturnValue(start + 120_000);
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.06", "0.61"), {
				sessionId: "sliding-session",
			}),
		).toBe(true);
		now.mockReturnValue(start + 240_000);
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.07", "0.62"), {
				sessionId: "sliding-session",
			}),
		).toBe(true);

		now.mockReturnValue(start + 299_999);
		const beforeDeadline = requireAnthropicReport(await storage.fetchUsageReports());
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(requireLimit(beforeDeadline, "anthropic:extra").amount.used).toBe(12.34);

		now.mockReturnValue(start + 376_000);
		const refreshed = requireAnthropicReport(await storage.fetchUsageReports());
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(requireLimit(refreshed, "anthropic:extra").amount.used).toBe(56.78);
	});

	it("merges header umbrella windows onto the last real report and preserves tier limits", async () => {
		const realReport = makeTieredReport("a@example.com");
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return realReport;
		});

		const initialReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(requireLimit(initialReport, "anthropic:7d:opus").amount.used).toBe(12);
		expect(calls).toBe(1);

		await storage.getApiKey("anthropic", "merge-session");
		const beforeIngest = Date.now();
		expect(storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.9"), { sessionId: "merge-session" })).toBe(
			true,
		);

		const mergedReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(calls).toBe(1);
		expect(mergedReport.fetchedAt).toBeGreaterThan(realReport.fetchedAt);
		expect(mergedReport.metadata?.email).toBe("a@example.com");
		expect(mergedReport.metadata?.accountId).toBe("account-a@example.com");
		expect(mergedReport.metadata?.headersUpdatedAt).toBeGreaterThanOrEqual(beforeIngest);
		expect(mergedReport.metadata?.source).toBeUndefined();
		expect(requireLimit(mergedReport, "anthropic:5h").amount.used).toBe(5);
		expect(requireLimit(mergedReport, "anthropic:7d").amount.used).toBe(90);
		expect(requireLimit(mergedReport, "anthropic:7d:opus").amount.used).toBe(12);
	});
	it("replaces the cached Fable weekly row by id when broker headers carry the weekly overage bucket", async () => {
		const realReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now() - 10_000,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: 42, limit: 100, usedFraction: 0.42, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d",
					label: "Claude 7 Day",
					scope: { provider: "anthropic", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 84, limit: 100, usedFraction: 0.84, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 11, limit: 100, usedFraction: 0.11, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:opus",
					label: "Claude 7 Day (Opus)",
					scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 12, limit: 100, usedFraction: 0.12, unit: "percent" },
					status: "ok",
				},
			],
			metadata: {
				email: "a@example.com",
				accountId: "account-a@example.com",
				endpoint: "https://api.anthropic.com/api/oauth/usage",
			},
		};
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return realReport;
		});

		const initialReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(requireLimit(initialReport, "anthropic:7d:fable").amount.used).toBe(11);
		expect(calls).toBe(1);

		await storage.getApiKey("anthropic", "fable-session");
		expect(
			storage.ingestUsageHeaders("anthropic", usageHeaders("0.05", "0.9", "0.61"), {
				sessionId: "fable-session",
			}),
		).toBe(true);

		const mergedReport = requireAnthropicReport(await storage.fetchUsageReports());
		expect(calls).toBe(1);
		expect(mergedReport.limits.filter(limit => limit.id === "anthropic:7d:fable")).toHaveLength(1);
		expect(requireLimit(mergedReport, "anthropic:5h").amount.used).toBe(5);
		expect(requireLimit(mergedReport, "anthropic:7d").amount.used).toBe(90);
		expect(requireLimit(mergedReport, "anthropic:7d:opus").amount.used).toBe(12);

		const fable = requireLimit(mergedReport, "anthropic:7d:fable");
		expect(fable.label).toBe("Claude 7 Day (Fable)");
		expect(fable.scope.provider).toBe("anthropic");
		expect(fable.scope.windowId).toBe("7d");
		expect(fable.scope.tier).toBe("fable");
		expect(fable.scope.shared).toBeUndefined();
		expect(fable.window?.resetsAt).toBe(1780617600 * 1000);
		expect(fable.amount.used).toBeCloseTo(61);
		expect(fable.amount.usedFraction).toBeCloseTo(0.61);
		expect(fable.amount.remainingFraction).toBeCloseTo(0.39);
	});
});

describe("AuthStorage usage cache: terminal refresh failure", () => {
	// Usage polling is non-critical: refresh failure must not disable a
	// credential whose current access token can still satisfy the probe.
	it("keeps credential and probes with current access after a definitive refresh failure", async () => {
		const row = oauthRow(1, "a@example.com");
		if (row.credential.type !== "oauth") throw new Error("expected OAuth test credential");
		row.credential.expires = Date.now() + 30_000;
		const rows = [row];
		const cache = new Map<string, CacheEntry>();
		let disableCalls = 0;
		const store: ObservableStore = {
			cache,
			close() {},
			listAuthCredentials: () => rows.filter(candidate => !candidate.disabledCause),
			updateAuthCredential() {},
			deleteAuthCredential() {},
			tryDisableAuthCredentialIfMatches() {
				disableCalls += 1;
				return true;
			},
			replaceAuthCredentialsForProvider: () => rows,
			upsertAuthCredentialForProvider: () => rows,
			deleteAuthCredentialsForProvider() {},
			getCache(key: string, options?: { includeExpired?: boolean }) {
				const entry = cache.get(key);
				if (!entry) return null;
				if (!options?.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) return null;
				return entry.value;
			},
			setCache(key: string, value: string, expiresAtSec: number) {
				cache.set(key, { value, expiresAtSec });
			},
			cleanExpiredCache() {},
		};

		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("OAuth refresh failed: 400 invalid_grant: refresh token revoked");
			},
		});
		await storage.reload();

		const fetchSpy = vi
			.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage")
			.mockResolvedValue(makeReport("a@example.com"));
		try {
			const reports = anthropicReports(await storage.fetchUsageReports());

			expect(reports).toHaveLength(1);
			expect(reports[0]?.metadata?.email).toBe("a@example.com");
			expect(disableCalls).toBe(0);
			expect(rows[0]?.disabledCause).toBeNull();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(fetchSpy.mock.calls[0]?.[0].credential.accessToken).toBe("oat-1");
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});

	it("suppresses last-good fallback when an expired OAuth access token has a definitive refresh failure", async () => {
		const row = oauthRow(3, "expired@example.com");
		if (row.credential.type !== "oauth") throw new Error("expected OAuth test credential");
		row.credential.expires = Date.now() - 1000;
		const store = makeStore([row]);
		const cacheKey = "usage_cache:report:3:anthropic:default:oauth|account:account-3|email:expired@example.com";
		store.cache.set(cacheKey, {
			value: JSON.stringify({ value: makeReport("expired@example.com"), expiresAt: 1 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("OAuth refresh failed: 400 invalid_grant: refresh token revoked");
			},
		});
		await storage.reload();
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);
		try {
			expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(row.disabledCause).toBeNull();
			const cached = JSON.parse(store.cache.get(cacheKey)!.value);
			expect(cached.value).toBeNull();
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});

	it("preserves last-good fallback for transient (non-definitive) refresh failures", async () => {
		// Mirror image: a 502 from the token endpoint is transient — we keep the
		// row, fall back to the prior good report, and try again next poll.
		const row = oauthRow(2, "b@example.com");
		(row.credential as { expires: number }).expires = Date.now() - 1000;
		const rows = [row];

		const cache = new Map<string, CacheEntry>();
		const store: ObservableStore = {
			cache,
			close() {},
			listAuthCredentials: () => rows.filter(r => !r.disabledCause),
			updateAuthCredential() {},
			deleteAuthCredential() {},
			tryDisableAuthCredentialIfMatches() {
				return true;
			},
			replaceAuthCredentialsForProvider: () => rows,
			upsertAuthCredentialForProvider: () => rows,
			deleteAuthCredentialsForProvider() {},
			getCache(key: string, options?: { includeExpired?: boolean }) {
				const entry = cache.get(key);
				if (!entry) return null;
				if (!options?.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) return null;
				return entry.value;
			},
			setCache(key: string, value: string, expiresAtSec: number) {
				cache.set(key, { value, expiresAtSec });
			},
			cleanExpiredCache() {},
		};

		const lastGood = makeReport("b@example.com");
		const cacheKey = "usage_cache:report:3:anthropic:default:oauth|account:account-2|email:b@example.com";
		cache.set(cacheKey, {
			value: JSON.stringify({ value: lastGood, expiresAt: 1 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});

		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("fetch failed: connect ECONNREFUSED 1.2.3.4:443");
			},
		});
		await storage.reload();

		// The provider probe runs with the stale credential and fails — we don't
		// need a real upstream response, just a deterministic null so the lastGood
		// path is the one being tested.
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);

		try {
			const reports = anthropicReports(await storage.fetchUsageReports());
			expect(reports).toHaveLength(1);
			expect(reports[0]?.metadata?.email).toBe("b@example.com");
			expect(rows[0].disabledCause).toBeNull();
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AuthStorage usage cache: org-only identity stability", () => {
	it("keeps the cache entry across a token rotation for an org-only credential", async () => {
		// Identity recovery failed at login: the credential carries neither
		// accountId nor email — only the org. The usage-cache identity must key
		// off the org instead of a token hash, or every OAuth refresh would
		// churn the cache key and fragment the usage history.
		const credential: AuthCredential = {
			type: "oauth",
			access: "oat-initial",
			refresh: "refresh-initial",
			expires: Date.now() + 3_600_000,
			orgId: "org-team-1111",
		};
		const row: StoredAuthCredential = { id: 1, provider: "anthropic", credential, disabledCause: null };
		const store = makeStore([row]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		try {
			let calls = 0;
			vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
				calls += 1;
				return makeReport("org-only");
			});

			const first = anthropicReports(await storage.fetchUsageReports());
			expect(first).toHaveLength(1);
			expect(calls).toBe(1);
			const reportKeysBefore = [...store.cache.keys()].filter(key => key.startsWith("usage_cache:report:")).sort();
			expect(reportKeysBefore).toHaveLength(1);

			// An OAuth refresh rotates both tokens. The rotated credential must
			// resolve to the SAME cache entry — served from cache, no refetch.
			row.credential = { ...credential, access: "oat-rotated", refresh: "refresh-rotated" };
			await storage.reload();

			const second = anthropicReports(await storage.fetchUsageReports());
			expect(second).toHaveLength(1);
			expect(calls).toBe(1);
			const reportKeysAfter = [...store.cache.keys()].filter(key => key.startsWith("usage_cache:report:")).sort();
			expect(reportKeysAfter).toEqual(reportKeysBefore);
			for (const key of reportKeysAfter) {
				expect(key).toContain("org:org-team-1111");
				expect(key).not.toContain("secret:");
			}
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});
