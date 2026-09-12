import { afterEach, describe, expect, it } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeRankingStrategy } from "@oh-my-pi/pi-ai/usage/claude";

/**
 * A reactive Fable 429 blocks the credential until the reset that error
 * reported. Anthropic can restore the tier earlier (a plan change or a
 * corrected counter), and the block then idles a usable account for days —
 * observed as `tier:fable` blocks persisting three days past a quota reset
 * while the live report read 0% used. A healthy live report must lift it, but
 * only when every limit gating that scope has headroom: the shared 5-hour wall
 * blocks Fable too, so a spent 5h window must keep the block alive.
 */
function sharedLimit(id: string, windowId: string, usedFraction: number): UsageLimit {
	return {
		id: `anthropic:${id}`,
		label: id,
		scope: { provider: "anthropic", shared: true, windowId },
		window: { id: windowId, label: windowId, resetsAt: Date.now() + 60 * 60_000 },
		amount: { usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function tierLimit(tier: string, usedFraction: number): UsageLimit {
	return {
		id: `anthropic:7d:${tier}`,
		label: `7d ${tier}`,
		scope: { provider: "anthropic", tier, windowId: "7d" },
		window: { id: "7d", label: "7d", resetsAt: Date.now() + 24 * 60 * 60_000 },
		amount: { usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function claudeReport(limits: UsageLimit[], fetchedAt = Date.now()): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt,
		limits,
		metadata: { accountId: "account-1" },
	};
}

/**
 * A sibling that can serve but has nearly nothing left, so credential ranking
 * prefers the blocked-then-healed account whenever the block actually lifts.
 * That makes `getApiKey` a direct read of the healing outcome.
 */
function nearlySpentSiblingReport(): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [sharedLimit("5h", "5h", 0.8), sharedLimit("7d", "7d", 0.97), tierLimit("fable", 0.97)],
		metadata: { accountId: "account-2" },
	};
}

function oauthRow(id: number): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${id}`,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

interface HealHarness {
	storage: AuthStorage;
	clearedScopes: string[];
	/** Usage requests the selection path spent while the credential was blocked. */
	probeCount: () => number;
	/** Persisted blocks, keyed `credentialId:blockScope`, so a test can add one. */
	blocks: Map<string, number>;
}

function makeHarness(report: UsageReport, blockScope = "tier:fable"): HealHarness {
	const rows = [oauthRow(1), oauthRow(2)];
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	const blocks = new Map<string, number>();
	blocks.set(`1:${blockScope}`, Date.now() + 3 * 24 * 60 * 60_000);
	const clearedScopes: string[] = [];
	let probes = 0;
	const store: AuthCredentialStore = {
		close() {},
		listAuthCredentials: provider => rows.filter(row => provider === undefined || row.provider === provider),
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider: () => rows,
		upsertAuthCredentialForProvider: () => rows,
		deleteAuthCredentialsForProvider() {},
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
		id: "anthropic",
		fetchUsage: async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (access === "access-2") return nearlySpentSiblingReport();
			probes += 1;
			return report;
		},
	};
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
		rankingStrategyResolver: provider => (provider === "anthropic" ? claudeRankingStrategy : undefined),
		configValueResolver: async value => value,
	});
	return { storage, clearedScopes, probeCount: () => probes, blocks };
}

describe("claude usage-block healing", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	it("pairs each tier scope with the shared windows that also gate it", () => {
		const report = claudeReport([
			sharedLimit("5h", "5h", 0.2),
			sharedLimit("7d", "7d", 0.3),
			tierLimit("fable", 0.4),
			tierLimit("opus", 0.5),
		]);
		const scopes = claudeRankingStrategy.healableBlockScopes?.(report) ?? [];
		const fable = scopes.find(scope => scope.blockScope === "tier:fable");

		expect(fable).toBeDefined();
		const ids = (fable?.limits ?? []).map(entry => entry.id);
		expect(ids).toContain("anthropic:7d:fable");
		// Shared walls must judge the scope too, else a spent 5h window heals.
		expect(ids).toContain("anthropic:5h");
		expect(ids).toContain("anthropic:7d");
		// Opus/Sonnet requests never take a scoped block, so nothing to heal.
		expect(ids).not.toContain("anthropic:7d:opus");
		expect(scopes.some(scope => scope.blockScope === "tier:opus")).toBe(false);
	});

	it("lifts a stale tier:fable block when the live report has headroom", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.reload();

		await storage.getModelUsageHealth("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).toContain("tier:fable");
		// The user-visible contract: the recovered account is selectable again,
		// not merely reported healthy.
		expect(await storage.getApiKey("anthropic", "s-heal", { modelId: "claude-fable-5-1" })).toBe("access-1");
	});

	it("keeps the block while the shared 5-hour window is spent", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.reload();

		await storage.getModelUsageHealth("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).not.toContain("tier:fable");
		expect(await storage.getApiKey("anthropic", "s-5h", { modelId: "claude-fable-5-1" })).toBe("access-2");
	});

	it("keeps the block when the report omits a shared gate", async () => {
		// The endpoint answers with whatever parsed, so a healthy tier row can
		// arrive without the 5-hour window that may be what blocked the request.
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.reload();

		await storage.getModelUsageHealth("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).not.toContain("tier:fable");
		expect(await storage.getApiKey("anthropic", "s-partial", { modelId: "claude-fable-5-1" })).toBe("access-2");
	});

	it("spends no usage request on a block its scopes cannot heal", async () => {
		// An unscoped block (Opus/Sonnet usage limit, refresh failure) is outside
		// every scope the strategy vouches for, so probing cannot change it.
		const { storage, clearedScopes, probeCount } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
			"",
		);
		storages.push(storage);
		await storage.reload();

		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude-fable-5-1",
			reserveFraction: 0.1,
		});

		expect(probeCount()).toBe(0);
		expect(clearedScopes).toEqual([]);
		expect(health.accounts[0]?.state).toBe("depleted");
	});

	it("keeps the block when the report predates it", async () => {
		// A broker serves its retained last-good report for hours after `/usage`
		// starts failing; those healthy limits describe the account before the
		// 429 that blocked it.
		const stale = claudeReport(
			[sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)],
			Date.now() - 60 * 60_000,
		);
		const { storage, clearedScopes } = makeHarness(stale);
		storages.push(storage);
		await storage.reload();

		await storage.getModelUsageHealth("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).not.toContain("tier:fable");
		expect(await storage.getApiKey("anthropic", "s-stale", { modelId: "claude-fable-5-1" })).toBe("access-2");
	});

	it("spends no probe while an unscoped block also holds the credential", async () => {
		// A tier block written after a global one carries the later deadline, but
		// the global block still makes the credential unusable, so clearing the
		// tier early buys nothing and the request must not be spent.
		const { storage, probeCount, blocks } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		blocks.set("1:", Date.now() + 60 * 60_000);
		await storage.reload();

		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude-fable-5-1",
			reserveFraction: 0.1,
		});

		expect(probeCount()).toBe(0);
		expect(health.accounts.find(account => account.credentialId === 1)?.state).toBe("depleted");
	});
});
