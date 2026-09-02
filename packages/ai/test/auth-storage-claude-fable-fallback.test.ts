import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
	type StoredCredentialBlock,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";

const ANTHROPIC_PROVIDER_KEY = "anthropic:oauth";

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, { value: string; expiresAtSec: number }>;
	blocks: Map<string, StoredCredentialBlock>;
}

function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	const blocks = new Map<string, StoredCredentialBlock>();
	const blockKey = (credentialId: number, providerKey: string, blockScope: string) =>
		`${credentialId}\0${providerKey}\0${blockScope}`;
	return {
		cache,
		blocks,
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
		getCredentialBlock(credentialId, providerKey, blockScope) {
			const block = blocks.get(blockKey(credentialId, providerKey, blockScope));
			if (!block || block.blockedUntilMs <= Date.now()) return undefined;
			return block.blockedUntilMs;
		},
		upsertCredentialBlock(block) {
			blocks.set(blockKey(block.credentialId, block.providerKey, block.blockScope), block);
		},
		deleteCredentialBlock(credentialId, providerKey, blockScope) {
			blocks.delete(blockKey(credentialId, providerKey, blockScope));
		},
		deleteCredentialBlocks(credentialId) {
			for (const [key, block] of blocks) {
				if (block.credentialId === credentialId) blocks.delete(key);
			}
		},
		listCredentialBlocks(credentialIds) {
			return [...blocks.values()].filter(block => credentialIds.includes(block.credentialId));
		},
	};
}

function oauthRow(id: number, email: string, provider = "anthropic"): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider, credential, disabledCause: null };
}

function baseReport(email: string): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 10, limit: 100, usedFraction: 0.1, unit: "percent" },
				status: "ok",
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", windowId: "7d", shared: true },
				window: { id: "7d", label: "7 Day" },
				amount: { used: 20, limit: 100, usedFraction: 0.2, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email, accountId: email },
	};
}

function withFable(
	report: UsageReport,
	usedFraction: number,
	options: { resetsAt?: number; status?: UsageLimit["status"] } = {},
): UsageReport {
	return {
		...report,
		limits: [
			...report.limits,
			{
				id: "anthropic:7d:fable",
				label: "Claude 7 Day (Fable)",
				scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
				window: {
					id: "7d",
					label: "7 Day",
					...(options.resetsAt === undefined ? {} : { resetsAt: options.resetsAt }),
				},
				amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
				status: options.status ?? (usedFraction >= 1 ? "exhausted" : "ok"),
			},
		],
	};
}

function withSharedUsage(report: UsageReport, windowId: "5h" | "7d", usedFraction: number): UsageReport {
	return {
		...report,
		limits: report.limits.map(limit =>
			limit.scope.shared === true && limit.scope.windowId === windowId
				? {
						...limit,
						amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
						status: usedFraction >= 1 ? "exhausted" : "ok",
					}
				: limit,
		),
	};
}

describe("AuthStorage Claude Fable tier fallback", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com"), oauthRow(3, "c@example.com")]);
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("does not block OAuth credentials just because the Fable tier is not reported", async () => {
		// All three credentials lack a Fable-specific bucket. Unknown headroom is
		// not treated as exhausted; the selector still picks the first credential
		// in hashed order and lets the live request decide if the account can
		// serve Fable.
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": baseReport("a@example.com"),
			"oat-2": baseReport("b@example.com"),
			"oat-3": baseReport("c@example.com"),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		// Unknown Fable headroom is not a proactive hard block.
		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-1");
	});

	it("skips a Fable credential only when the exhausted tier row has a future reset", async () => {
		const now = Date.now();
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1.0, { resetsAt: now + 3_600_000 }),
			"oat-2": withFable(baseReport("b@example.com"), 0.4, { resetsAt: now + 3_600_000 }),
			"oat-3": withFable(baseReport("c@example.com"), 0.4, { resetsAt: now + 3_600_000 }),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-2");
	});

	it("keeps a full Fable tier row eligible when the reset timestamp is missing", async () => {
		const now = Date.now();
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1.0),
			"oat-2": withFable(baseReport("b@example.com"), 1.0, { resetsAt: now + 3_600_000 }),
			"oat-3": withFable(baseReport("c@example.com"), 1.0, { resetsAt: now + 3_600_000 }),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-1");
	});

	it("keeps a full Fable tier row eligible when the reset timestamp is already elapsed", async () => {
		const now = Date.now();
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1.0, { resetsAt: now - 1 }),
			"oat-2": withFable(baseReport("b@example.com"), 1.0, { resetsAt: now + 3_600_000 }),
			"oat-3": withFable(baseReport("c@example.com"), 1.0, { resetsAt: now + 3_600_000 }),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-1");
	});

	it("keeps a near-cap Fable tier row eligible even with a future reset timestamp", async () => {
		const now = Date.now();
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 0.97, { resetsAt: now + 3_600_000 }),
			"oat-2": withFable(baseReport("b@example.com"), 1.0, { resetsAt: now + 3_600_000 }),
			"oat-3": withFable(baseReport("c@example.com"), 1.0, { resetsAt: now + 3_600_000 }),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-1");
	});

	it("treats exhausted status plus a future reset as a confirmed Fable hard block", async () => {
		const now = Date.now();
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 0.97, { resetsAt: now + 3_600_000, status: "exhausted" }),
			"oat-2": withFable(baseReport("b@example.com"), 0.4, { resetsAt: now + 3_600_000 }),
			"oat-3": withFable(baseReport("c@example.com"), 0.4, { resetsAt: now + 3_600_000 }),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-2");
	});

	it("uses unconfirmed exhausted Fable tier rows as ranking hints instead of hard blockers", async () => {
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1.0),
			"oat-2": withFable(baseReport("b@example.com"), 1.0),
			"oat-3": withFable(baseReport("c@example.com"), 0.5),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-3");
	});

	it("rotates after a live Fable 429 when sibling Fable tier rows are unconfirmed", async () => {
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1.0),
			"oat-2": withFable(baseReport("b@example.com"), 1.0),
			"oat-3": withFable(baseReport("c@example.com"), 1.0),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const firstKey = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });
		expect(firstKey).toBe("oat-1");

		const result = await storage.markUsageLimitReached("anthropic", "session-3", { modelId: "claude-fable-5" });
		expect(result.switched).toBe(true);

		const retryKey = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });
		expect(retryKey).not.toBe(firstKey);
		expect(["oat-2", "oat-3"]).toContain(retryKey as string);
	});

	it("aborts a local usage lookup before marking the credential blocked", async () => {
		let blockUsage = false;
		const usageStarted = Promise.withResolvers<void>();
		const releaseUsage = Promise.withResolvers<UsageReport>();
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			if (!blockUsage) return baseReport("a@example.com");
			usageStarted.resolve();
			return releaseUsage.promise;
		});

		const firstKey = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });
		store.cache.clear();
		blockUsage = true;
		const controller = new AbortController();
		const marking = storage.markUsageLimitReached("anthropic", "session-3", {
			modelId: "claude-fable-5",
			signal: controller.signal,
		});
		await usageStarted.promise;
		controller.abort();
		let rejection: unknown;
		const rejectedQuickly = await Promise.race([
			marking.then(
				() => false,
				error => {
					rejection = error;
					return true;
				},
			),
			Bun.sleep(50).then(() => false),
		]);
		releaseUsage.resolve(baseReport("a@example.com"));
		await marking.catch(() => {});

		expect(rejectedQuickly).toBe(true);
		expect(String(rejection)).toContain("usage fetch aborted");
		expect(await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" })).toBe(firstKey);
	});

	it("does not mark a credential when aborted during target resolution", async () => {
		storage.close();
		const provider = "no-usage-provider";
		store = makeStore([oauthRow(1, "a@example.com", provider)]);
		storage = new AuthStorage(store);
		await storage.reload();
		const firstKey = await storage.getApiKey(provider, "session-3");
		const controller = new AbortController();

		const marking = storage.markUsageLimitReached(provider, "session-3", {
			signal: controller.signal,
		});
		controller.abort();

		await expect(marking).rejects.toThrow();
		expect(await storage.getApiKey(provider, "session-3")).toBe(firstKey);
	});

	it("extends a live Fable rate-limit block to the confirmed Fable reset", async () => {
		const startNow = Date.now();
		let now = startNow;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fableReset = startNow + 10 * 60_000;
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1.0, { resetsAt: fableReset }),
			"oat-2": withFable(baseReport("b@example.com"), 0.2, { resetsAt: fableReset }),
			"oat-3": withFable(baseReport("c@example.com"), 0.2, { resetsAt: fableReset }),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const firstKey = await storage.getApiKey("anthropic", "session-3");
		expect(firstKey).toBe("oat-1");

		const result = await storage.markUsageLimitReached("anthropic", "session-3", {
			modelId: "claude-fable-5",
			retryAfterMs: 1_000,
		});
		expect(result.switched).toBe(true);

		reportsByAccess["oat-1"] = withFable(baseReport("a@example.com"), 0.2, { resetsAt: fableReset });
		store.cache.clear();
		now = startNow + 60_001;

		const retryKey = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });
		expect(retryKey).toBe("oat-2");
	});

	it("still blocks OAuth credentials with exhausted shared Anthropic limits", async () => {
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withSharedUsage(withFable(baseReport("a@example.com"), 0.1), "7d", 1.0),
			"oat-2": withSharedUsage(withFable(baseReport("b@example.com"), 0.1), "7d", 1.0),
			"oat-3": withFable(baseReport("c@example.com"), 1.0),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-3");
	});

	// Anthropic answers a Fable 429 with a `retry-after` that can point at the
	// account's weekly reset (~37h observed) even when only a short window is
	// spent. The reactive block persists under `tier:fable`, so without healing
	// every later Fable turn skips a recovered account and falls off-provider.
	it("clears a persisted Fable block when a usage poll shows the account recovered", async () => {
		const blockedUntilMs = Date.now() + 36 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 0),
			"oat-2": withSharedUsage(baseReport("b@example.com"), "5h", 1.0),
			"oat-3": withSharedUsage(baseReport("c@example.com"), "5h", 1.0),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(1, ANTHROPIC_PROVIDER_KEY, "tier:fable")).toBeUndefined();
		expect(await storage.getApiKey("anthropic", "session-heal", { modelId: "claude-fable-5" })).toBe("oat-1");
	});

	// Only the TUI polls usage on its own. Print mode, subagents, and the gateway
	// reach healing exclusively through selection, so a blocked credential has to
	// be re-probed there or those callers stay pinned until the block expires.
	it("clears a persisted Fable block during selection without a separate usage poll", async () => {
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs: Date.now() + 36 * 60 * 60_000,
		});
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 0),
			"oat-2": withSharedUsage(baseReport("b@example.com"), "5h", 1.0),
			"oat-3": withSharedUsage(baseReport("c@example.com"), "5h", 1.0),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		expect(await storage.getApiKey("anthropic", "session-select", { modelId: "claude-fable-5" })).toBe("oat-1");
		expect(store.getCredentialBlock?.(1, ANTHROPIC_PROVIDER_KEY, "tier:fable")).toBeUndefined();
	});

	// Usage reports are cached per credential for five minutes and the cache is
	// shared across processes, so a short run's every read is typically a hit. A
	// block written by another process is never accompanied by a local refetch,
	// so healing has to accept cached evidence or it never runs at all here.
	it("clears a persisted Fable block from a cached usage report when refetching fails", async () => {
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 0),
			"oat-2": withSharedUsage(baseReport("b@example.com"), "5h", 1.0),
			"oat-3": withSharedUsage(baseReport("c@example.com"), "5h", 1.0),
		};
		const fetchUsage = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		await storage.fetchUsageReports();
		expect(fetchUsage.mock.calls.length).toBeGreaterThan(0);

		// Another process 429s and persists the block; this process only has the
		// report it already cached, and Anthropic rate-limits `/usage` for exactly
		// the account that just hit its cap, so a refetch yields nothing.
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs: Date.now() + 36 * 60 * 60_000,
		});
		fetchUsage.mockResolvedValue(null);

		expect(await storage.getApiKey("anthropic", "session-cached", { modelId: "claude-fable-5" })).toBe("oat-1");
		expect(store.getCredentialBlock?.(1, ANTHROPIC_PROVIDER_KEY, "tier:fable")).toBeUndefined();
	});

	it("keeps a persisted Fable block while the shared window the tier spends is exhausted", async () => {
		const blockedUntilMs = Date.now() + 36 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withSharedUsage(withFable(baseReport("a@example.com"), 0), "5h", 1.0),
			"oat-2": withFable(baseReport("b@example.com"), 0),
			"oat-3": withFable(baseReport("c@example.com"), 0),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(1, ANTHROPIC_PROVIDER_KEY, "tier:fable")).toBe(blockedUntilMs);
	});

	// Gating deliberately ignores a tier row at 100% with no live reset, because
	// the counter is unreliable below the cap and must not hard-block on its own.
	// Healing must not inherit that: reusing the gating scope would hide the row,
	// leave only the healthy shared windows, and clear the block the row justifies.
	it("keeps a persisted Fable block when the tier row reads exhausted without a reset", async () => {
		const blockedUntilMs = Date.now() + 36 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1.0),
			"oat-2": withFable(baseReport("b@example.com"), 0),
			"oat-3": withFable(baseReport("c@example.com"), 0),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(1, ANTHROPIC_PROVIDER_KEY, "tier:fable")).toBe(blockedUntilMs);
	});

	// A row that reports `used` with no cap (Kimi's parser emits these) proves
	// nothing about remaining quota. Counting it as evidence would clear the block
	// and hand the turn straight back to a still-exhausted credential.
	it("keeps a persisted Fable block when the report quantifies no limit", async () => {
		const blockedUntilMs = Date.now() + 36 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const unquantified: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: 5, unit: "requests" },
					status: "unknown",
				},
			],
			metadata: { email: "a@example.com", accountId: "a@example.com" },
		};
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": unquantified,
			"oat-2": withFable(baseReport("b@example.com"), 0),
			"oat-3": withFable(baseReport("c@example.com"), 0),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(1, ANTHROPIC_PROVIDER_KEY, "tier:fable")).toBe(blockedUntilMs);
	});

	// One readable row is not enough: an unreadable sibling still gates the same
	// scope, so healing on the readable one alone releases a credential whose
	// other window may be spent.
	it("keeps a persisted Fable block when only some gated limits are quantified", async () => {
		const blockedUntilMs = Date.now() + 36 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const partiallyQuantified: UsageReport = {
			...withFable(baseReport("a@example.com"), 0),
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: 5, unit: "requests" },
					status: "unknown",
				},
				{
					id: "anthropic:7d",
					label: "Claude 7 Day",
					scope: { provider: "anthropic", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 20, limit: 100, usedFraction: 0.2, unit: "percent" },
					status: "ok",
				},
			],
		};
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": partiallyQuantified,
			"oat-2": withFable(baseReport("b@example.com"), 0),
			"oat-3": withFable(baseReport("c@example.com"), 0),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(1, ANTHROPIC_PROVIDER_KEY, "tier:fable")).toBe(blockedUntilMs);
	});

	// Opus/Sonnet errors use the credential-wide bucket, but their usage reports
	// can carry tier rows. Healthy shared windows cannot prove recovery while one
	// of those tier counters remains exhausted.
	it("keeps a credential-wide block while a Claude tier remains exhausted", async () => {
		const blockedUntilMs = Date.now() + 36 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "",
			blockedUntilMs,
		});
		const withExhaustedOpusMeter: UsageReport = {
			...baseReport("a@example.com"),
			limits: [
				...baseReport("a@example.com").limits,
				{
					id: "anthropic:7d:opus",
					label: "Claude 7 Day (Opus)",
					scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
					window: { id: "7d", label: "7 Day", resetsAt: Date.now() + 36 * 60 * 60_000 },
					amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
					status: "exhausted",
				},
			],
		};
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withExhaustedOpusMeter,
			"oat-2": withSharedUsage(baseReport("b@example.com"), "5h", 1.0),
			"oat-3": withSharedUsage(baseReport("c@example.com"), "5h", 1.0),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(1, ANTHROPIC_PROVIDER_KEY, "")).toBe(blockedUntilMs);
	});

	it("does not heal an org-less sibling from an org-attributed broker report", async () => {
		storage.close();
		const email = "shared@example.com";
		const legacyRow = oauthRow(1, email);
		const orgRow = oauthRow(2, email);
		if (orgRow.credential.type !== "oauth") throw new Error("expected OAuth fixture");
		orgRow.credential.orgId = "org-team";
		store = makeStore([legacyRow, orgRow]);
		const report = baseReport(email);
		report.metadata = { email, orgId: "org-team" };
		store.fetchUsageReports = async () => [report];
		const blockedUntilMs = Date.now() + 36 * 60 * 60_000;
		for (const credentialId of [legacyRow.id, orgRow.id]) {
			store.upsertCredentialBlock?.({
				credentialId,
				providerKey: ANTHROPIC_PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs,
			});
		}
		storage = new AuthStorage(store);
		await storage.reload();

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(legacyRow.id, ANTHROPIC_PROVIDER_KEY, "")).toBe(blockedUntilMs);
		expect(store.getCredentialBlock?.(orgRow.id, ANTHROPIC_PROVIDER_KEY, "")).toBeUndefined();
	});

	it("heals an org-only credential from the matching org-attributed broker report", async () => {
		storage.close();
		const orgOnly = oauthRow(1, "unused@example.com");
		if (orgOnly.credential.type !== "oauth") throw new Error("expected OAuth fixture");
		orgOnly.credential.orgId = "org-only";
		delete orgOnly.credential.email;
		delete orgOnly.credential.accountId;
		store = makeStore([orgOnly]);
		const report = baseReport("unused@example.com");
		report.metadata = { orgId: "org-only" };
		store.fetchUsageReports = async () => [report];
		store.upsertCredentialBlock?.({
			credentialId: orgOnly.id,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "",
			blockedUntilMs: Date.now() + 36 * 60 * 60_000,
		});
		storage = new AuthStorage(store);
		await storage.reload();

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(orgOnly.id, ANTHROPIC_PROVIDER_KEY, "")).toBeUndefined();
	});

	it("keeps an org-only block when several broker reports share that organization", async () => {
		storage.close();
		const orgOnly = oauthRow(1, "unused@example.com");
		if (orgOnly.credential.type !== "oauth") throw new Error("expected OAuth fixture");
		orgOnly.credential.orgId = "org-team";
		delete orgOnly.credential.email;
		delete orgOnly.credential.accountId;
		store = makeStore([orgOnly]);
		const aliceReport = baseReport("alice@example.com");
		aliceReport.metadata = { email: "alice@example.com", orgId: "org-team" };
		const bobReport = baseReport("bob@example.com");
		bobReport.metadata = { email: "bob@example.com", orgId: "org-team" };
		store.fetchUsageReports = async () => [aliceReport, bobReport];
		const blockedUntilMs = Date.now() + 36 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: orgOnly.id,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "",
			blockedUntilMs,
		});
		storage = new AuthStorage(store);
		await storage.reload();

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(orgOnly.id, ANTHROPIC_PROVIDER_KEY, "")).toBe(blockedUntilMs);
	});

	it("keeps a base-identified credential blocked when the broker report identifies only its organization", async () => {
		storage.close();
		const identified = oauthRow(1, "alice@example.com");
		if (identified.credential.type !== "oauth") throw new Error("expected OAuth fixture");
		identified.credential.orgId = "org-team";
		store = makeStore([identified]);
		const report = baseReport("unused@example.com");
		report.metadata = { orgId: "org-team" };
		store.fetchUsageReports = async () => [report];
		const blockedUntilMs = Date.now() + 36 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: identified.id,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "",
			blockedUntilMs,
		});
		storage = new AuthStorage(store);
		await storage.reload();

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(identified.id, ANTHROPIC_PROVIDER_KEY, "")).toBe(blockedUntilMs);
	});

	it("reconciles every successful report in a parallel fetch after the first block clears", async () => {
		for (const credentialId of [1, 2]) {
			store.upsertCredentialBlock?.({
				credentialId,
				providerKey: ANTHROPIC_PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: Date.now() + 36 * 60 * 60_000,
			});
		}
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return withFable(baseReport(`${access}@example.com`), 0);
		});

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(1, ANTHROPIC_PROVIDER_KEY, "tier:fable")).toBeUndefined();
		expect(store.getCredentialBlock?.(2, ANTHROPIC_PROVIDER_KEY, "tier:fable")).toBeUndefined();
	});

	it("preserves a blocked credential when its healing probe outlives selection", async () => {
		storage.close();
		store = makeStore([oauthRow(1, "blocked@example.com"), oauthRow(2, "healthy@example.com")]);
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: ANTHROPIC_PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs: Date.now() + 36 * 60 * 60_000,
		});
		const stalled = Promise.withResolvers<UsageReport | null>();
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (access === "oat-1") return stalled.promise;
			return baseReport("healthy@example.com");
		});
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			usageRequestTimeoutMs: 10,
		});
		await storage.reload();
		vi.useFakeTimers();
		try {
			const selecting = storage.getApiKey("anthropic", "session-probe-timeout", { modelId: "claude-fable-5" });
			await Promise.resolve();
			await Promise.resolve();
			vi.advanceTimersByTime(5_001);
			expect(await selecting).toBe("oat-2");
		} finally {
			stalled.resolve(null);
			vi.useRealTimers();
		}
	});
});
