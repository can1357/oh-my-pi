import { afterEach, describe, expect, it } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeRankingStrategy, parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { claudeResetClearedBlockScopes } from "@oh-my-pi/pi-ai/usage/claude-reset";

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
 * The live `/usage` shape of an account with no running 5-hour window:
 * `five_hour: null` and no `session` row in `limits[]`.
 */
function noSessionPayload(weeklyPercent: number): Record<string, unknown> {
	// Same reset horizon as the harness sibling, so ranking prefers this account whenever it is unblocked.
	const weeklyReset = new Date(Date.now() + 60 * 60_000).toISOString();
	return {
		five_hour: null,
		seven_day: { utilization: weeklyPercent, resets_at: weeklyReset },
		seven_day_opus: null,
		seven_day_sonnet: null,
		limits: [
			{ kind: "weekly_all", percent: weeklyPercent, resets_at: weeklyReset, scope: null, is_active: false },
			{
				kind: "weekly_scoped",
				percent: 81,
				resets_at: weeklyReset,
				scope: { model: { id: null, display_name: "Fable" }, surface: null },
				is_active: true,
			},
		],
	};
}

function parsedReport(payload: Record<string, unknown>): UsageReport {
	const report = parseClaudeUsagePayload(payload, { accountId: "account-1" });
	if (!report) throw new Error("payload did not parse");
	return report;
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

	it("heals a stale account-wide block without claiming to clear an absent tier row", async () => {
		const { storage, clearedScopes, probeCount } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
			"",
		);
		storages.push(storage);
		await storage.credentials.reload();

		const health = await storage.health.model("anthropic", {
			modelId: "claude-fable-5-1",
			reserveFraction: 0.1,
		});

		expect(probeCount()).toBe(1);
		expect(clearedScopes).toEqual([""]);
		expect(health.accounts[0]?.state).toBe("healthy");
		expect(await storage.keys.get("anthropic", "global-heal", { modelId: "claude-fable-5-1" })).toBe("access-1");
	});

	for (const scope of ["auth", "account-policy"]) {
		it(`does not heal an independent ${scope} block`, async () => {
			const { storage, probeCount, blocks } = makeHarness(
				claudeReport([sharedLimit("5h", "5h", 0), sharedLimit("7d", "7d", 0), tierLimit("fable", 0)]),
				scope,
			);
			storages.push(storage);
			await storage.credentials.reload();
			expect(await storage.keys.get("anthropic", "protected", { modelId: "claude-fable-5-1" })).toBe("access-2");
			expect(blocks.has(`1:${scope}`)).toBe(true);
			expect(probeCount()).toBe(0);
		});
	}

	for (const limits of [
		[sharedLimit("5h", "5h", 0), sharedLimit("7d", "7d", 1), tierLimit("fable", 0)],
		[sharedLimit("5h", "5h", 0), tierLimit("fable", 0)],
		[sharedLimit("5h", "5h", 0), sharedLimit("7d", "7d", 0), tierLimit("fable", 1)],
	]) {
		it("retains an account-wide block without complete healthy quota evidence", async () => {
			const { storage, blocks, clearedScopes } = makeHarness(claudeReport(limits), "");
			storages.push(storage);
			await storage.credentials.reload();
			await storage.health.model("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });
			expect(blocks.has("1:")).toBe(true);
			expect(clearedScopes).toEqual([]);
		});
	}

	it("keeps a newly written block while live usage may lag the quota rejection", async () => {
		const { storage, blocks } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0), sharedLimit("7d", "7d", 0), tierLimit("fable", 0)]),
			"",
		);
		storages.push(storage);
		await storage.credentials.reload();
		await storage.limits.markReached("anthropic", "fresh", {
			credentialId: 1,
			modelId: "claude-opus-5-5",
			retryAfterMs: 3_600_000,
			providerTimed: true,
		});
		await storage.health.model("anthropic", { modelId: "claude-opus-5-5", reserveFraction: 0.1 });
		expect(blocks.has("1:")).toBe(true);
	});

	it("adopts external reset deletion before selecting or merging another quota failure", async () => {
		const { storage, blocks } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0), sharedLimit("7d", "7d", 0), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.credentials.reload();
		await storage.limits.markReached("anthropic", "external", {
			credentialId: 1,
			modelId: "claude-fable-5-1",
			retryAfterMs: 3_600_000,
			providerTimed: true,
		});
		blocks.delete("1:tier:fable");
		expect(await storage.keys.get("anthropic", "external", { modelId: "claude-fable-5-1" })).toBe("access-1");
		await storage.limits.markReached("anthropic", "external", {
			credentialId: 1,
			modelId: "claude-fable-5-1",
			retryAfterMs: 60_000,
			providerTimed: true,
		});
		expect(blocks.get("1:tier:fable")).toBeLessThan(Date.now() + 120_000);
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

	it("heals both stale account-wide and tier blocks", async () => {
		const { storage, probeCount, blocks } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		blocks.set("1:", Date.now() + 60 * 60_000);
		await storage.credentials.reload();

		const health = await storage.health.model("anthropic", {
			modelId: "claude-fable-5-1",
			reserveFraction: 0.1,
		});

		expect(probeCount()).toBe(1);
		expect(health.accounts.find(account => account.credentialId === 1)?.state).toBe("healthy");
		expect(blocks.has("1:")).toBe(false);
		expect(blocks.has("1:tier:fable")).toBe(false);
	});

	it("rotates a usage-limited session onto a sibling whose stale block live usage lifts", async () => {
		// Every sibling looked blocked, so rotation reported no switch and the turn
		// waited out the provider's multi-day retry-after, though the next resolve
		// would have served the recovered account.
		const { storage } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
			"",
		);
		storages.push(storage);
		await storage.credentials.reload();
		storage.sessions.pin("anthropic", "s-rotate", 2);

		const mark = await storage.limits.markReached("anthropic", "s-rotate", {
			modelId: "claude-sonnet-5-5",
			retryAfterMs: 38 * 60 * 60_000,
			providerTimed: true,
		});

		expect(mark.switched).toBe(true);
		expect(await storage.keys.get("anthropic", "s-rotate", { modelId: "claude-sonnet-5-5" })).toBe("access-1");
	});

	describe("an account with no running 5-hour window", () => {
		it("heals a stale account-wide block", async () => {
			const { storage, blocks } = makeHarness(parsedReport(noSessionPayload(55)), "");
			storages.push(storage);
			await storage.credentials.reload();

			expect(await storage.keys.get("anthropic", "no-session", { modelId: "claude-opus-5-5" })).toBe("access-1");
			expect(blocks.has("1:")).toBe(false);
		});

		it("keeps the block while the weekly window is spent", async () => {
			const { storage, blocks } = makeHarness(parsedReport(noSessionPayload(100)), "");
			storages.push(storage);
			await storage.credentials.reload();

			expect(await storage.keys.get("anthropic", "no-session-spent", { modelId: "claude-opus-5-5" })).toBe(
				"access-2",
			);
			expect(blocks.has("1:")).toBe(true);
		});

		it("keeps the block when the 5-hour field is missing rather than null", async () => {
			const { five_hour: _omitted, ...payload } = noSessionPayload(55);
			const { storage, blocks } = makeHarness(parsedReport(payload), "");
			storages.push(storage);
			await storage.credentials.reload();

			expect(await storage.keys.get("anthropic", "no-field", { modelId: "claude-opus-5-5" })).toBe("access-2");
			expect(blocks.has("1:")).toBe(true);
		});

		it("clears the account-wide block after a weekly reset", () => {
			expect(claudeResetClearedBlockScopes(["anthropic:7d"], parsedReport(noSessionPayload(55)))).toContain(
				undefined,
			);
		});
	});
});
