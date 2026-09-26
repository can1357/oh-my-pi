import { afterEach, describe, expect, it } from "bun:test";
import { type AuthCredentialStore, AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { zaiRankingStrategy } from "@oh-my-pi/pi-ai/usage/zai";

function creditLimit(windowId: string, fraction: number): UsageLimit {
	return {
		id: `zai:credits:${windowId}`,
		label: `${windowId} credits`,
		scope: { provider: "zai", shared: true, windowId },
		window: { id: windowId, label: windowId, resetsAt: Date.now() + 4 * 24 * 60 * 60_000 },
		amount: { usedFraction: fraction, unit: "credits" },
		status: fraction >= 1 ? "exhausted" : "ok",
	};
}

function report(weeklyFraction: number, fetchedAt = Date.now()): UsageReport {
	return {
		provider: "zai",
		fetchedAt,
		limits: [creditLimit("5h", 0.032), creditLimit("1w", weeklyFraction)],
		metadata: { accountId: "account-1" },
	};
}

function makeStorage(usage: UsageReport, scope = ""): { storage: AuthStorage; blocks: Map<string, number> } {
	const row: StoredAuthCredential = {
		id: 1,
		provider: "zai",
		credential: {
			type: "oauth",
			access: "zai-access",
			refresh: "zai-refresh",
			expires: Date.now() + 60 * 60_000,
			accountId: "account-1",
		},
		disabledCause: null,
	};
	const blocks = new Map([[scope, Date.now() + 4 * 24 * 60 * 60_000]]);
	const store: AuthCredentialStore = {
		close() {},
		listAuthCredentials: provider => (provider === undefined || provider === "zai" ? [row] : []),
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentials: async () => [row],
		upsertAuthCredential: async () => [row],
		async deleteAuthCredentials() {},
		getCredentialBlock: (_id, _providerKey, blockScope) => blocks.get(blockScope),
		upsertCredentialBlock: block => {
			blocks.set(block.blockScope, block.blockedUntilMs);
		},
		deleteCredentialBlock: (_id, _providerKey, blockScope) => {
			blocks.delete(blockScope);
		},
		getCache: () => null,
		setCache() {},
		cleanExpiredCache() {},
	};
	const usageProvider: UsageProvider = { id: "zai", fetchUsage: async () => usage };
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "zai" ? usageProvider : undefined),
		rankingStrategyResolver: provider => (provider === "zai" ? zaiRankingStrategy : undefined),
		configValueResolver: async value => value,
	});
	return { storage, blocks };
}

describe("ZAI usage-block healing", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	it("recovers a previously unscoped weekly block after a healthy live usage fetch", async () => {
		const { storage, blocks } = makeStorage(report(0.013));
		storages.push(storage);
		await storage.credentials.reload();

		await storage.usage.reports();

		expect(blocks.has("")).toBe(false);
		expect(await storage.keys.get("zai", "recovered", { modelId: "glm-5.3" })).toBe("zai-access");
	});

	it("selects a previously blocked account after a healthy scoped quota probe", async () => {
		const { storage, blocks } = makeStorage(report(0.013), "credits");
		storages.push(storage);
		await storage.credentials.reload();

		await storage.health.model("zai", { modelId: "glm-5.3", reserveFraction: 0.1 });

		expect(await storage.keys.get("zai", "recovered-scoped", { modelId: "glm-5.3" })).toBe("zai-access");
		expect(blocks.has("credits")).toBe(false);
	});

	it("keeps the block when the weekly credits are still exhausted", async () => {
		const { storage, blocks } = makeStorage(report(1));
		storages.push(storage);
		await storage.credentials.reload();

		await storage.usage.reports();

		expect(blocks.has("")).toBe(true);
		expect((await storage.health.model("zai", { modelId: "glm-5.3", reserveFraction: 0.1 })).accounts[0]?.state).toBe(
			"depleted",
		);
	});

	it("does not heal a credit block from an unrelated feature-only report", async () => {
		const featureReport = report(0.013);
		featureReport.limits = [
			{
				...creditLimit("1w", 0.013),
				id: "zai:features:zread:1w",
				scope: { provider: "zai", windowId: "1w", tier: "zread", shared: false },
			},
		];
		const { storage, blocks } = makeStorage(featureReport);
		storages.push(storage);
		await storage.credentials.reload();

		await storage.usage.reports();

		expect(blocks.has("")).toBe(true);
		expect((await storage.health.model("zai", { modelId: "glm-5.3", reserveFraction: 0.1 })).accounts[0]?.state).toBe(
			"depleted",
		);
	});

	it("does not heal a block from a retained report older than the block", async () => {
		const { storage, blocks } = makeStorage(report(0.013, Date.now() - 60 * 60_000));
		storages.push(storage);
		await storage.credentials.reload();

		await storage.usage.reports();

		expect(blocks.has("")).toBe(true);
		expect((await storage.health.model("zai", { modelId: "glm-5.3", reserveFraction: 0.1 })).accounts[0]?.state).toBe(
			"depleted",
		);
	});
});
