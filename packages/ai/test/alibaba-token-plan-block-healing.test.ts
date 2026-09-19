import { afterEach, describe, expect, it } from "bun:test";
import { type AuthCredentialStore, AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { alibabaTokenPlanRankingStrategy } from "@oh-my-pi/pi-ai/usage/alibaba-token-plan";
import { serializeAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";

/**
 * A funded add-on must be able to lift a stale usage-limit block.
 *
 * The plan window and the purchased Credit Pack are separate meters, and the
 * add-on list is a second console call. A report read while that call failed
 * blocks the credential on the plan window alone; an API-key block is never
 * re-probed during selection, so without healing the account stays sidelined
 * until the plan resets even though the endpoint keeps serving it.
 */
function planLimit(usedFraction: number): UsageLimit {
	return {
		id: "credits:7d",
		label: "7 Day Credits",
		scope: { provider: "alibaba-token-plan", windowId: "7d" },
		window: { id: "7d", label: "7 Day Credits", durationMs: 604_800_000, resetsAt: Date.now() + 86_400_000 },
		amount: { used: usedFraction * 100, usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function addonLimit(usedFraction: number): UsageLimit {
	return {
		id: "credits:addon",
		label: "Credit Pack",
		scope: { provider: "alibaba-token-plan", windowId: "addon" },
		window: { id: "addon", label: "Credit Pack", durationMs: 604_800_000 },
		amount: { used: usedFraction * 100, usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function tokenPlanReport(limits: UsageLimit[]): UsageReport {
	return { provider: "alibaba-token-plan", fetchedAt: Date.now(), limits, metadata: { source: "qwencloud-console" } };
}

interface HealHarness {
	storage: AuthStorage;
	clearedScopes: string[];
}

function makeHarness(report: UsageReport): HealHarness {
	const key = serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=test");
	const rows: StoredAuthCredential[] = [
		{
			id: 1,
			provider: "alibaba-token-plan",
			credential: { type: "api_key", key, source: "login" },
			disabledCause: null,
		},
	];
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	const blocks = new Map<string, number>();
	// Keyed by provider key as well as scope: a block lives under
	// `<provider>:<credential type>`, so a lookup that assumes the wrong type
	// must miss here exactly as it would against the real store.
	blocks.set("1:alibaba-token-plan:api_key:", Date.now() + 3 * 24 * 60 * 60_000);
	const clearedScopes: string[] = [];
	const store: AuthCredentialStore = {
		close() {},
		listAuthCredentials: provider => rows.filter(row => provider === undefined || row.provider === provider),
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider: () => rows,
		upsertAuthCredentialForProvider: () => rows,
		deleteAuthCredentialsForProvider() {},
		getCredentialBlock: (credentialId: number, providerKey: string, scope: string) =>
			blocks.get(`${credentialId}:${providerKey}:${scope}`),
		upsertCredentialBlock: block => {
			blocks.set(`${block.credentialId}:${block.providerKey}:${block.blockScope}`, block.blockedUntilMs);
		},
		deleteCredentialBlock: (credentialId: number, providerKey: string, scope: string) => {
			clearedScopes.push(scope);
			blocks.delete(`${credentialId}:${providerKey}:${scope}`);
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
		id: "alibaba-token-plan",
		fetchUsage: async () => report,
	};
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "alibaba-token-plan" ? usageProvider : undefined),
		rankingStrategyResolver: provider =>
			provider === "alibaba-token-plan" ? alibabaTokenPlanRankingStrategy : undefined,
		configValueResolver: async value => value,
	});
	return { storage, clearedScopes };
}

describe("QwenCloud Token Plan usage-block healing", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	it("lifts a stale block when the live report shows add-on headroom", async () => {
		const { storage, clearedScopes } = makeHarness(tokenPlanReport([planLimit(1), addonLimit(0.0001)]));
		storages.push(storage);
		await storage.reload();

		await storage.fetchUsageReports();

		expect(clearedScopes).toContain("");
	});

	it("keeps the block while the add-on is spent", async () => {
		const { storage, clearedScopes } = makeHarness(tokenPlanReport([planLimit(1), addonLimit(1)]));
		storages.push(storage);
		await storage.reload();

		await storage.fetchUsageReports();

		expect(clearedScopes).not.toContain("");
	});

	it("keeps the block when no add-on was purchased", async () => {
		const { storage, clearedScopes } = makeHarness(tokenPlanReport([planLimit(1)]));
		storages.push(storage);
		await storage.reload();

		await storage.fetchUsageReports();

		expect(clearedScopes).not.toContain("");
	});
});
