import { afterEach, describe, expect, it } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { zaiRankingStrategy } from "@oh-my-pi/pi-ai/usage/zai";

/**
 * A ZAI 429 blocks the credential until the reset that error reported. The
 * 5-hour credit pool refills on its own cadence and a plan change can raise
 * weekly credits mid-window, and the block then idles a usable account for
 * days — observed as an unscoped `zai:oauth` block written at a weekly 100%
 * peak pinning sessions for ~3.5 days while the live report read 1.3% weekly.
 * A healthy live report must lift it, but only when every pool gate has
 * headroom: a spent 5-hour pool must keep the block alive.
 */
function poolLimit(id: string, windowId: string, usedFraction: number): UsageLimit {
	return {
		id: `zai:${id}`,
		label: id,
		scope: { provider: "zai", shared: true, windowId },
		window: { id: windowId, label: windowId, resetsAt: Date.now() + 60 * 60_000 },
		amount: { usedFraction, unit: "credits" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function requestLimit(modelId: string, usedFraction: number): UsageLimit {
	return {
		id: `zai:requests:${modelId}`,
		label: `requests ${modelId}`,
		scope: { provider: "zai", shared: false, modelId },
		window: { id: "1w", label: "Weekly", resetsAt: Date.now() + 24 * 60 * 60_000 },
		amount: { usedFraction, unit: "requests" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function zaiReport(limits: UsageLimit[], fetchedAt = Date.now()): UsageReport {
	return {
		provider: "zai",
		fetchedAt,
		limits,
		metadata: { email: "user@example.com" },
	};
}

/**
 * A sibling that can serve but has nearly nothing left, so credential ranking
 * prefers the blocked-then-healed account whenever the block actually lifts.
 * That makes `getApiKey` a direct read of the healing outcome.
 */
function nearlySpentSiblingReport(): UsageReport {
	return zaiReport([poolLimit("credits:5h", "5h", 0.9), poolLimit("credits:1w", "1w", 0.97)]);
}

function oauthRow(id: number): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 60 * 60_000,
		email: id === 1 ? "user@example.com" : "sibling@example.com",
	};
	return { id, provider: "zai", credential, disabledCause: null };
}

interface HealHarness {
	storage: AuthStorage;
	clearedScopes: string[];
	/** Persisted blocks, keyed `credentialId:blockScope`, so a test can add one. */
	blocks: Map<string, number>;
}

function makeHarness(report: UsageReport, blockScope = ""): HealHarness {
	const rows = [oauthRow(1), oauthRow(2)];
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	const blocks = new Map<string, number>();
	blocks.set(`1:${blockScope}`, Date.now() + 3 * 24 * 60 * 60_000);
	const clearedScopes: string[] = [];
	const store: AuthCredentialStore = {
		close() {},
		listAuthCredentials: provider => rows.filter(row => provider === undefined || row.provider === provider),
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentials: async () => rows,
		upsertAuthCredential: async () => rows,
		async deleteAuthCredentials() {},
		getCredentialBlock: (credentialId: number, _providerKey: string, scope: string) =>
			blocks.get(`${credentialId}:${scope}`),
		upsertCredentialBlock: block => {
			blocks.set(`${block.credentialId}:${block.blockScope}`, block.blockedUntilMs);
		},
		deleteCredentialBlock: (credentialId: number, _providerKey: string, scope: string) => {
			clearedScopes.push(scope);
			blocks.delete(`${credentialId}:${scope}`);
		},
		getCache(key) {
			const entry = cache.get(key);
			return entry && entry.expiresAtSec * 1000 > Date.now() ? entry.value : null;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
	const usageProvider: UsageProvider = {
		id: "zai",
		fetchUsage: async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (access === "access-2") return nearlySpentSiblingReport();
			return report;
		},
	};
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "zai" ? usageProvider : undefined),
		rankingStrategyResolver: provider => (provider === "zai" ? zaiRankingStrategy : undefined),
		configValueResolver: async value => value,
	});
	return { storage, clearedScopes, blocks };
}

describe("zai usage-block healing", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	it("pairs the pool scope with every credential-pool limit", () => {
		const report = zaiReport([poolLimit("credits:5h", "5h", 0.2), poolLimit("credits:1w", "1w", 0.3)]);
		const scopes = zaiRankingStrategy.healableBlockScopes?.(report) ?? [];
		const scoped = scopes.find(scope => scope.blockScope === "credits");

		expect(scoped).toBeDefined();
		// The 5-hour and weekly pools both gate a request, so both must judge
		// the scope — else a spent 5h pool heals a block it still holds.
		const ids = (scoped?.limits ?? []).map(entry => entry.id);
		expect(ids).toContain("zai:credits:5h");
		expect(ids).toContain("zai:credits:1w");
		// The pre-scoping catch-all bucket heals against the same limits.
		expect(scopes.some(scope => scope.blockScope === "")).toBe(true);
	});

	it("lifts a stale unscoped block when the periodic usage report is healthy", async () => {
		// The reported incident: an unscoped block written at a weekly 100%
		// peak, sessions refusing the source model while live usage read low.
		const { storage, clearedScopes } = makeHarness(
			zaiReport([poolLimit("credits:5h", "5h", 0.03), poolLimit("credits:1w", "1w", 0.01)]),
		);
		storages.push(storage);
		await storage.reload();

		await storage.usage.reports();

		expect(clearedScopes).toContain("");
		// The user-visible contract: the recovered account is selectable again.
		expect(await storage.getApiKey("zai", "s-heal")).toBe("access-1");
	});

	it("lifts a stale credits-scoped block during credential selection", async () => {
		const { storage, clearedScopes } = makeHarness(
			zaiReport([poolLimit("credits:5h", "5h", 0.03), poolLimit("credits:1w", "1w", 0.01)]),
			"credits",
		);
		storages.push(storage);
		await storage.reload();

		expect(await storage.getApiKey("zai", "s-direct-heal")).toBe("access-1");
		expect(clearedScopes).toContain("credits");
	});

	it("keeps the block while the 5-hour pool is spent", async () => {
		const { storage, clearedScopes } = makeHarness(
			zaiReport([poolLimit("credits:5h", "5h", 1), poolLimit("credits:1w", "1w", 0.01)]),
		);
		storages.push(storage);
		await storage.reload();

		await storage.usage.reports();

		expect(clearedScopes).toEqual([]);
		expect(await storage.getApiKey("zai", "s-5h")).toBe("access-2");
	});

	it("keeps the block when the report omits every pool gate", async () => {
		// The endpoint answers with whatever parsed, so a per-model request
		// row can arrive without the credit pool that blocked the request.
		const { storage, clearedScopes } = makeHarness(zaiReport([requestLimit("glm-4.7-flash", 0.1)]));
		storages.push(storage);
		await storage.reload();

		await storage.usage.reports();

		expect(clearedScopes).toEqual([]);
		expect(await storage.getApiKey("zai", "s-no-gate")).toBe("access-2");
	});

	it("keeps the block when the report predates it", async () => {
		// A broker serves its retained last-good report for hours after /usage
		// starts failing; those healthy limits describe the account before the
		// 429 that blocked it.
		const stale = zaiReport(
			[poolLimit("credits:5h", "5h", 0.03), poolLimit("credits:1w", "1w", 0.01)],
			Date.now() - 60 * 60_000,
		);
		const { storage, clearedScopes } = makeHarness(stale);
		storages.push(storage);
		await storage.reload();

		await storage.usage.reports();

		expect(clearedScopes).toEqual([]);
		expect(await storage.getApiKey("zai", "s-stale")).toBe("access-2");
	});
});
