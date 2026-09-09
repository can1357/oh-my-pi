/**
 * Usage history contracts:
 *
 *   1. The SQLite store downsamples history to at most one row per hour per
 *      account window — a snapshot landing in the same hour bucket as the
 *      series' latest row overwrites it in place (latest value wins).
 *   2. Series are independent per (provider, account, limit window).
 *   3. `listUsageHistory` filters by provider / sinceMs and returns rows
 *      oldest-first.
 *   4. `cleanExpiredCache` purges expired cache rows but NEVER usage history
 *      (the hourly cap is the only storage bound; nothing else is pruned).
 *   5. AuthStorage appends one history row per limit, attributed to the
 *      fetched credential, whenever a fresh usage report lands.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageHistoryEntry, UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";
import * as opencodeGoUsage from "@oh-my-pi/pi-ai/usage/opencode-go";

const HOUR = 3_600_000;
// Hour-aligned base so bucket boundaries in the tests are explicit.
const T0 = Math.floor(Date.parse("2026-06-12T10:00:00Z") / HOUR) * HOUR;

function entry(overrides: Partial<UsageHistoryEntry>): UsageHistoryEntry {
	return {
		recordedAt: T0,
		provider: "anthropic",
		accountKey: "oauth|account:account-1|email:a@example.com",
		email: "a@example.com",
		accountId: "account-1",
		limitId: "anthropic:5h",
		label: "5 Hour",
		windowLabel: "5 Hour",
		usedFraction: 0.1,
		status: "ok",
		resetsAt: T0 + 5 * HOUR,
		...overrides,
	};
}

describe("SqliteAuthCredentialStore usage history", () => {
	let store: SqliteAuthCredentialStore;

	beforeEach(() => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
	});

	afterEach(() => {
		store.close();
	});

	it("downsamples to one row per hour per series: same-bucket snapshots overwrite in place", () => {
		store.recordUsageSnapshots([entry({ recordedAt: T0, usedFraction: 0.1 })]);
		store.recordUsageSnapshots([entry({ recordedAt: T0 + 10 * 60_000, usedFraction: 0.5, status: "warning" })]);

		const sameBucket = store.listUsageHistory();
		expect(sameBucket).toHaveLength(1);
		expect(sameBucket[0]?.recordedAt).toBe(T0 + 10 * 60_000);
		expect(sameBucket[0]?.usedFraction).toBe(0.5);
		expect(sameBucket[0]?.status).toBe("warning");

		store.recordUsageSnapshots([entry({ recordedAt: T0 + HOUR + 60_000, usedFraction: 0.7 })]);
		const nextBucket = store.listUsageHistory();
		expect(nextBucket).toHaveLength(2);
		expect(nextBucket.map(row => row.usedFraction)).toEqual([0.5, 0.7]);
	});

	it("keeps independent series per account and per limit window", () => {
		store.recordUsageSnapshots([
			entry({ usedFraction: 0.2 }),
			entry({ limitId: "anthropic:7d", label: "7 Day", windowLabel: "7 Day", usedFraction: 0.4 }),
			entry({
				accountKey: "oauth|account:account-2|email:b@example.com",
				email: "b@example.com",
				usedFraction: 0.9,
			}),
		]);

		const rows = store.listUsageHistory();
		expect(rows).toHaveLength(3);
		expect(new Set(rows.map(row => `${row.accountKey}:${row.limitId}`)).size).toBe(3);
	});

	it("filters by provider and sinceMs, oldest first", () => {
		store.recordUsageSnapshots([
			entry({ recordedAt: T0 + 2 * HOUR, usedFraction: 0.6 }),
			entry({ provider: "openai-codex", limitId: "codex:5h", recordedAt: T0 }),
			entry({ recordedAt: T0, usedFraction: 0.2 }),
		]);

		expect(store.listUsageHistory({ provider: "openai-codex" })).toHaveLength(1);

		const anthropic = store.listUsageHistory({ provider: "anthropic" });
		expect(anthropic.map(row => row.recordedAt)).toEqual([T0, T0 + 2 * HOUR]);

		const recent = store.listUsageHistory({ sinceMs: T0 + HOUR });
		expect(recent).toHaveLength(1);
		expect(recent[0]?.usedFraction).toBe(0.6);
	});

	it("cleanExpiredCache purges expired cache rows but never usage history", () => {
		store.setCache("usage_cache:report:test", "{}", Math.floor(Date.now() / 1000) - 60);
		// Ancient row — must survive cleanup; there is no retention pruning.
		store.recordUsageSnapshots([entry({ recordedAt: T0 - 365 * 24 * HOUR })]);

		store.cleanExpiredCache();

		expect(store.getCache("usage_cache:report:test", { includeExpired: true })).toBeNull();
		expect(store.listUsageHistory()).toHaveLength(1);
	});
});

describe("AuthStorage usage history recording", () => {
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		store.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			access: "oat-1",
			refresh: "refresh-1",
			expires: Date.now() + HOUR,
			accountId: "account-1",
			email: "a@example.com",
		});
		// Restrict the resolver to anthropic so AuthStorage doesn't fan out real
		// network fetches for providers with *_API_KEY env vars on the test host.
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("appends one row per limit on a fresh fetch, attributed to the credential", async () => {
		const fetchedAt = Date.now();
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt,
			limits: [
				{
					id: "anthropic:5h",
					label: "5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", resetsAt: fetchedAt + 5 * HOUR },
					amount: { usedFraction: 0.42, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d",
					label: "7 Day",
					scope: { provider: "anthropic", windowId: "7d" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 84, limit: 100, unit: "percent" },
					status: "warning",
				},
			],
			metadata: { email: "a@example.com" },
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => report);

		await storage.fetchUsageReports();

		const rows = storage.listUsageHistory();
		expect(rows).toHaveLength(2);

		const fiveHour = rows.find(row => row.limitId === "anthropic:5h");
		expect(fiveHour?.provider).toBe("anthropic");
		expect(fiveHour?.usedFraction).toBe(0.42);
		expect(fiveHour?.email).toBe("a@example.com");
		expect(fiveHour?.windowLabel).toBe("5 Hour");
		expect(fiveHour?.resetsAt).toBe(fetchedAt + 5 * HOUR);
		expect(fiveHour?.recordedAt).toBe(fetchedAt);
		// Stable identity key derived from the credential, not the report.
		expect(fiveHour?.accountKey).toContain("email:a@example.com");

		// used/limit fallback resolves a fraction even without usedFraction.
		const sevenDay = rows.find(row => row.limitId === "anthropic:7d");
		expect(sevenDay?.usedFraction).toBeCloseTo(0.84);
		expect(sevenDay?.status).toBe("warning");
	});
});

describe("OpenCode Go usage via the upstream endpoint", () => {
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let fetchCalls: Array<{ url: string; headers: Record<string, string> }>;

	beforeEach(async () => {
		fetchCalls = [];
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		storage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "opencode-go" ? opencodeGoUsage.opencodeGoUsageProvider : undefined,
			usageFetch: (async (input: string | URL | Request, init?: RequestInit) => {
				fetchCalls.push({
					url: String(input),
					headers: (init?.headers as Record<string, string>) ?? {},
				});
				return new Response(
					JSON.stringify({
						usage: {
							rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T15:09:04.847Z" },
							weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.847Z" },
							monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-08-19T00:31:53.847Z" },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as unknown as typeof fetch,
		});
		await storage.reload();
		await storage.set("opencode-go", { type: "api_key", key: "opencode-go-key" });
	});

	afterEach(() => {
		setSystemTime();
		storage.close();
		vi.restoreAllMocks();
	});

	it("fetches percent-based limits for a stored API key and records history rows", async () => {
		const reports = await storage.fetchUsageReports();

		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("https://opencode.ai/zen/go/v1/usage");
		expect(fetchCalls[0]?.headers.authorization).toBe("Bearer opencode-go-key");

		const report = reports?.find(candidate => candidate.provider === "opencode-go");
		expect(report?.limits.map(limit => [limit.id, limit.amount.used, limit.status])).toEqual([
			["rolling-5h", 12, "ok"],
			["weekly", 8, "ok"],
			["monthly", 100, "exhausted"],
		]);
		expect(report?.limits.map(limit => limit.scope.windowId)).toEqual(["5h", "7d", "monthly"]);
		expect(report?.limits.find(limit => limit.id === "monthly")?.window?.resetsAt).toBe(
			Date.parse("2026-08-19T00:31:53.847Z"),
		);

		// Fresh reports append durable usage-history rows per limit window.
		const rows = store.listUsageHistory({ provider: "opencode-go" });
		expect(rows.map(row => [row.limitId, row.usedFraction])).toEqual([
			["rolling-5h", 0.12],
			["weekly", 0.08],
			["monthly", 1],
		]);
	});

	it("resolves reference-stored API keys before the Authorization header", async () => {
		// Keys stored as references (env var name, "!command") must reach the
		// endpoint as the resolved secret, not the reference string (#8337 review).
		const referenceStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: provider =>
				provider === "opencode-go" ? opencodeGoUsage.opencodeGoUsageProvider : undefined,
			configValueResolver: async config => (config === "ref:opencode" ? "sk-resolved-secret" : config),
			usageFetch: (async (input: string | URL | Request, init?: RequestInit) => {
				fetchCalls.push({
					url: String(input),
					headers: (init?.headers as Record<string, string>) ?? {},
				});
				return new Response(
					JSON.stringify({
						usage: {
							rolling: { status: "ok", percent: 5, resetsAt: "2026-08-12T15:09:04.847Z" },
							weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.847Z" },
							monthly: { status: "ok", percent: 10, resetsAt: "2026-08-19T00:31:53.847Z" },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as unknown as typeof fetch,
		});
		try {
			await referenceStorage.reload();
			await referenceStorage.set("opencode-go", { type: "api_key", key: "ref:opencode" });

			const reports = await referenceStorage.fetchUsageReports();

			expect(fetchCalls).toHaveLength(1);
			expect(fetchCalls[0]?.headers.authorization).toBe("Bearer sk-resolved-secret");
			expect(reports?.some(candidate => candidate.provider === "opencode-go")).toBe(true);
		} finally {
			referenceStorage.close();
		}
	});

	it("drops the last-good report when the key turns definitively unauthorized", async () => {
		// Transient failures serve the cached report; a 401/403 must not — a
		// revoked key or lapsed subscription would otherwise keep rendering and
		// ranking from stale quota until the process restarts.
		let respondWith: "success" | "unauthorized" = "success";
		const transitionStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: provider =>
				provider === "opencode-go" ? opencodeGoUsage.opencodeGoUsageProvider : undefined,
			usageFetch: (async () =>
				respondWith === "success"
					? new Response(
							JSON.stringify({
								usage: {
									rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T15:09:04.847Z" },
									weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.847Z" },
									monthly: { status: "ok", percent: 10, resetsAt: "2026-08-19T00:31:53.847Z" },
								},
							}),
							{ status: 200, headers: { "content-type": "application/json" } },
						)
					: new Response(
							JSON.stringify({ type: "error", error: { type: "AuthError", message: "Unauthorized" } }),
							{
								status: 401,
								headers: { "content-type": "application/json" },
							},
						)) as unknown as typeof fetch,
		});
		try {
			await transitionStorage.reload();
			await transitionStorage.set("opencode-go", { type: "api_key", key: "opencode-go-key" });

			const nowMs = Date.now();
			setSystemTime(new Date(nowMs));
			const fresh = await transitionStorage.fetchUsageReports();
			expect(fresh?.some(candidate => candidate.provider === "opencode-go")).toBe(true);

			// Past the report TTL the next poll re-hits the endpoint and gets 401.
			respondWith = "unauthorized";
			setSystemTime(new Date(nowMs + 10 * 60_000));
			const afterRevocation = await transitionStorage.fetchUsageReports();
			expect(afterRevocation?.some(candidate => candidate.provider === "opencode-go")).toBe(false);
		} finally {
			transitionStorage.close();
		}
	});

	it("retains the last-good report through a partial payload", async () => {
		// One malformed window fails the whole decode, which must fall back to
		// the cached complete report instead of replacing it with fewer windows.
		let respondWith: "success" | "partial" = "success";
		const partialStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: provider =>
				provider === "opencode-go" ? opencodeGoUsage.opencodeGoUsageProvider : undefined,
			usageFetch: (async () =>
				new Response(
					JSON.stringify({
						usage: {
							rolling:
								respondWith === "success"
									? { status: "ok", percent: 12, resetsAt: "2026-08-12T15:09:04.847Z" }
									: { status: "ok", percent: "abc" },
							weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.847Z" },
							monthly: { status: "ok", percent: 10, resetsAt: "2026-08-19T00:31:53.847Z" },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				)) as unknown as typeof fetch,
		});
		try {
			await partialStorage.reload();
			await partialStorage.set("opencode-go", { type: "api_key", key: "opencode-go-key" });

			const nowMs = Date.now();
			setSystemTime(new Date(nowMs));
			const fresh = await partialStorage.fetchUsageReports();
			expect(fresh?.find(candidate => candidate.provider === "opencode-go")?.limits).toHaveLength(3);

			respondWith = "partial";
			setSystemTime(new Date(nowMs + 10 * 60_000));
			const afterPartial = await partialStorage.fetchUsageReports();
			const retained = afterPartial?.find(candidate => candidate.provider === "opencode-go");
			expect(retained?.limits.map(limit => limit.id)).toEqual(["rolling-5h", "weekly", "monthly"]);
		} finally {
			partialStorage.close();
		}
	});
});
