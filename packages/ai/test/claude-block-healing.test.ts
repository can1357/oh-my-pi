import { afterEach, describe, expect, it } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { CredentialRankingStrategy, UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeRankingStrategy } from "@oh-my-pi/pi-ai/usage/claude";
import { claudeResetClearedBlockScopes } from "../src/usage/claude-reset";

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
function extraLimit(used: number, limit: number): UsageLimit {
	const usedFraction = used / limit;
	return {
		id: "anthropic:extra",
		label: "Claude Extra Usage",
		scope: { provider: "anthropic", windowId: "extra" },
		amount: { used, limit, usedFraction, unit: "usd" },
		status: used >= limit ? "exhausted" : "ok",
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
	/** Reconcile-after timestamps, keyed `credentialId:blockScope`. */
	reconcileAfter: Map<string, number>;
}

function makeHarness(
	report: UsageReport,
	blockScope = "tier:fable",
	strategy: CredentialRankingStrategy = claudeRankingStrategy,
): HealHarness {
	const rows = [oauthRow(1), oauthRow(2)];
	const reconcileAfter = new Map<string, number>();
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	const blocks = new Map<string, number>();
	blocks.set(`1:${blockScope}`, Date.now() + 3 * 24 * 60 * 60_000);
	const clearedScopes: string[] = [];
	let probes = 0;
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
		getCredentialBlockReconcileAfter: (credentialId: number, _providerKey: string, scope: string) =>
			reconcileAfter.get(`${credentialId}:${scope}`),
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
		rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
	});
	return { storage, clearedScopes, probeCount: () => probes, blocks, reconcileAfter };
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
		await storage.credentials.reload();

		await storage.health.model("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).toContain("tier:fable");
		// The user-visible contract: the recovered account is selectable again,
		// not merely reported healthy.
		expect(await storage.keys.get("anthropic", "s-heal", { modelId: "claude-fable-5-1" })).toBe("access-1");
	});

	it("lifts a stale tier:fable block during credential selection without a prior health check", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.credentials.reload();

		expect(await storage.keys.get("anthropic", "s-direct-heal", { modelId: "claude-fable-5-1" })).toBe("access-1");
		expect(clearedScopes).toContain("tier:fable");
	});

	it("keeps the block while the shared 5-hour window is spent", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.credentials.reload();

		await storage.health.model("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).not.toContain("tier:fable");
		expect(await storage.keys.get("anthropic", "s-5h", { modelId: "claude-fable-5-1" })).toBe("access-2");
	});

	it("keeps the block when the report omits a shared gate", async () => {
		// The endpoint answers with whatever parsed, so a healthy tier row can
		// arrive without the 5-hour window that may be what blocked the request.
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.credentials.reload();

		await storage.health.model("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).not.toContain("tier:fable");
		expect(await storage.keys.get("anthropic", "s-partial", { modelId: "claude-fable-5-1" })).toBe("access-2");
	});

	it("spends no usage request on a block its scopes cannot heal", async () => {
		// When a strategy does not vouch for unscoped blocks, a live unscoped
		// block is outside every scope it vouches for, so probing cannot change it.
		const unvouchedStrategy: CredentialRankingStrategy = {
			...claudeRankingStrategy,
			healsUnscopedBlock: false,
		};
		const { storage, clearedScopes, probeCount } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
			"",
			unvouchedStrategy,
		);
		storages.push(storage);
		await storage.credentials.reload();

		const health = await storage.health.model("anthropic", {
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
		await storage.credentials.reload();

		await storage.health.model("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).not.toContain("tier:fable");
		expect(await storage.keys.get("anthropic", "s-stale", { modelId: "claude-fable-5-1" })).toBe("access-2");
	});

	it("spends no probe while an unscoped block also holds the credential", async () => {
		// A tier block written after a global one carries the later deadline, but
		// for strategies that do not vouch for unscoped healing, the global block
		// still makes the credential unusable, so clearing the tier early buys
		// nothing and the request must not be spent.
		const unvouchedStrategy: CredentialRankingStrategy = {
			...claudeRankingStrategy,
			healsUnscopedBlock: false,
		};
		const { storage, probeCount, blocks } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
			"tier:fable",
			unvouchedStrategy,
		);
		storages.push(storage);
		blocks.set("1:", Date.now() + 60 * 60_000);
		await storage.credentials.reload();

		const health = await storage.health.model("anthropic", {
			modelId: "claude-fable-5-1",
			reserveFraction: 0.1,
		});

		expect(probeCount()).toBe(0);
		expect(health.accounts.find(account => account.credentialId === 1)?.state).toBe("depleted");
	});

	it("lifts a stale unscoped block when a live report has headroom for Opus/Sonnet requests", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.02), sharedLimit("7d", "7d", 0.05)]),
			"",
		);
		storages.push(storage);
		await storage.credentials.reload();

		const selected = await storage.keys.get("anthropic", "s-opus-heal", { modelId: "claude-opus-5-5" });
		expect(clearedScopes).toContain("");
		expect(selected).toBe("access-1");
	});

	it("keeps an unscoped block when the 7d limit is exhausted", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.02), sharedLimit("7d", "7d", 1.0)]),
			"",
		);
		storages.push(storage);
		await storage.credentials.reload();

		const selected = await storage.keys.get("anthropic", "s-opus-exhausted", { modelId: "claude-opus-5-5" });
		expect(clearedScopes).not.toContain("");
		expect(selected).toBe("access-2");
	});
	it("keeps an unscoped block when Extra Usage is exhausted even with plan headroom", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.02), sharedLimit("7d", "7d", 0.05), extraLimit(52, 50)]),
			"",
		);
		storages.push(storage);
		await storage.credentials.reload();

		const selected = await storage.keys.get("anthropic", "s-opus-extra-exhausted", { modelId: "claude-opus-5-5" });
		expect(clearedScopes).not.toContain("");
		expect(selected).toBe("access-2");
	});

	it("does not report a tier heal for an unscoped block it leaves in place", async () => {
		// Extra Usage keeps the unscoped block; the healthy Fable row may only
		// clear a block stored under `tier:fable`. Reporting the unscoped
		// deadline as a cleared tier block made a still-blocked account look
		// recovered in the logs on every usage refresh.
		const { storage, clearedScopes, blocks } = makeHarness(
			claudeReport([
				sharedLimit("5h", "5h", 0.02),
				sharedLimit("7d", "7d", 0.05),
				tierLimit("fable", 0),
				extraLimit(52, 50),
			]),
			"",
		);
		storages.push(storage);
		await storage.credentials.reload();

		const selected = await storage.keys.get("anthropic", "s-fable-under-unscoped", { modelId: "claude-fable-5-1" });

		expect(clearedScopes).toEqual([]);
		expect(blocks.has("1:")).toBe(true);
		expect(selected).toBe("access-2");
	});

	it("lifts an unscoped block when Extra Usage is present and has headroom", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.02), sharedLimit("7d", "7d", 0.05), extraLimit(10, 50)]),
			"",
		);
		storages.push(storage);
		await storage.credentials.reload();

		const selected = await storage.keys.get("anthropic", "s-opus-extra-healthy", { modelId: "claude-opus-5-5" });
		expect(clearedScopes).toContain("");
		expect(selected).toBe("access-1");
	});

	it("does not clear unscoped block scope via reset credit when Extra Usage is exhausted", () => {
		const report = claudeReport([sharedLimit("5h", "5h", 1.0), sharedLimit("7d", "7d", 0.05), extraLimit(52, 50)]);
		const cleared = claudeResetClearedBlockScopes(["anthropic:5h"], report);
		expect(cleared).not.toContain(undefined);
	});

	it("keeps an unscoped block when the report omits the 7d shared gate", async () => {
		const { storage, clearedScopes } = makeHarness(claudeReport([sharedLimit("5h", "5h", 0.02)]), "");
		storages.push(storage);
		await storage.credentials.reload();

		const selected = await storage.keys.get("anthropic", "s-opus-missing-7d", { modelId: "claude-opus-5-5" });
		expect(clearedScopes).not.toContain("");
		expect(selected).toBe("access-2");
	});

	it("keeps an unscoped block when inside the fresh-block guard window", async () => {
		const { storage, clearedScopes, blocks, reconcileAfter } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.02), sharedLimit("7d", "7d", 0.05)]),
			"",
		);
		storages.push(storage);
		// Place the unscoped block inside the fresh-block guard window
		reconcileAfter.set("1:", Date.now() + 60_000);
		await storage.credentials.reload();

		const selected = await storage.keys.get("anthropic", "s-opus-guarded", { modelId: "claude-opus-5-5" });

		expect(clearedScopes).not.toContain("");
		expect(blocks.has("1:")).toBe(true);
		expect(selected).toBe("access-2");
	});
	it("reports healthy at the health layer when an unscoped block is healed and sibling is exhausted", async () => {
		const rows = [oauthRow(1), oauthRow(2)];
		const blocks = new Map<string, number>();
		blocks.set("1:", Date.now() + 3 * 24 * 60 * 60_000);
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
				blocks.delete(`${credentialId}:${scope}`);
			},
			getCache: () => null,
			setCache: () => {},
			cleanExpiredCache() {},
		};
		const usageProvider: UsageProvider = {
			id: "anthropic",
			fetchUsage: async params => {
				const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
				if (access === "access-2") {
					return {
						provider: "anthropic",
						fetchedAt: Date.now(),
						limits: [sharedLimit("5h", "5h", 0.02), sharedLimit("7d", "7d", 1.0)],
						metadata: { accountId: "account-2" },
					};
				}
				return claudeReport([sharedLimit("5h", "5h", 0.02), sharedLimit("7d", "7d", 0.05)]);
			},
		};
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === "anthropic" ? claudeRankingStrategy : undefined),
			configValueResolver: async value => value,
		});
		storages.push(storage);
		await storage.credentials.reload();

		const health = await storage.health.model("anthropic", {
			modelId: "claude-opus-5-5",
			reserveFraction: 0.1,
		});

		expect(health.state).toBe("healthy");
		expect(health.accounts.find(a => a.credentialId === 1)?.state).toBe("healthy");
		expect(health.accounts.find(a => a.credentialId === 2)?.state).toBe("depleted");
	});

	it("reconciles reports to matching credentials by orgId when email and accountId are identical", async () => {
		const row1 = oauthRow(1);
		if (row1.credential.type === "oauth") row1.credential.orgId = "org-1";
		const row2 = oauthRow(2);
		if (row2.credential.type === "oauth") {
			row2.credential.orgId = "org-2";
			row2.credential.accountId = row1.credential.type === "oauth" ? row1.credential.accountId : undefined;
		}
		const rows = [row1, row2];

		const blocks = new Map<string, number>();
		blocks.set("1:", Date.now() + 3 * 24 * 60 * 60_000);
		blocks.set("2:", Date.now() + 3 * 24 * 60 * 60_000);
		const clearedScopes: string[] = [];

		const org1Report: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [sharedLimit("5h", "5h", 0.02), sharedLimit("7d", "7d", 1.0)],
			metadata: { accountId: "account-1", orgId: "org-1" },
		};
		const org2Report: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [sharedLimit("5h", "5h", 0.02), sharedLimit("7d", "7d", 0.05)],
			metadata: { accountId: "account-1", orgId: "org-2" },
		};

		const store: AuthCredentialStore = {
			close() {},
			listAuthCredentials: () => rows,
			updateAuthCredential() {},
			async deleteAuthCredential() {
				return false;
			},
			tryDisableAuthCredentialIfMatches: () => false,
			replaceAuthCredentials: async () => rows,
			upsertAuthCredential: async () => rows,
			async deleteAuthCredentials() {},
			getCredentialBlock: (credentialId, _key, scope) => blocks.get(`${credentialId}:${scope}`),
			getCredentialBlockReconcileAfter: () => undefined,
			upsertCredentialBlock: () => {},
			deleteCredentialBlock: (credentialId, _key, scope) => {
				clearedScopes.push(`${credentialId}:${scope}`);
				blocks.delete(`${credentialId}:${scope}`);
			},
			getCache: () => null,
			setCache: () => {},
			cleanExpiredCache() {},
			fetchUsageReports: async () => [org1Report, org2Report],
		};

		const storage = new AuthStorage(store, {
			rankingStrategyResolver: provider => (provider === "anthropic" ? claudeRankingStrategy : undefined),
			configValueResolver: async value => value,
		});
		storages.push(storage);
		await storage.credentials.reload();

		await storage.usage.reports();

		expect(clearedScopes).toContain("2:");
		expect(clearedScopes).not.toContain("1:");
		expect(blocks.has("1:")).toBe(true);
		expect(blocks.has("2:")).toBe(false);
	});
});
