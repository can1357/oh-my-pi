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

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, { value: string; expiresAtSec: number }>;
	blocks: Map<string, StoredCredentialBlock>;
	reconcileAfter: Map<string, number>;
}

function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	const blocks = new Map<string, StoredCredentialBlock>();
	const reconcileAfter = new Map<string, number>();
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
		getCredentialBlock(credentialId, providerKey, blockScope) {
			const block = blocks.get(`${credentialId}\0${providerKey}\0${blockScope}`);
			return block && block.blockedUntilMs > Date.now() ? block.blockedUntilMs : undefined;
		},
		getCredentialBlockReconcileAfter(credentialId, providerKey, blockScope) {
			return reconcileAfter.get(`${credentialId}\0${providerKey}\0${blockScope}`);
		},
		upsertCredentialBlock(block) {
			blocks.set(`${block.credentialId}\0${block.providerKey}\0${block.blockScope}`, block);
		},
		deleteCredentialBlock(credentialId, providerKey, blockScope) {
			blocks.delete(`${credentialId}\0${providerKey}\0${blockScope}`);
			reconcileAfter.delete(`${credentialId}\0${providerKey}\0${blockScope}`);
		},
		deleteCredentialBlocks(credentialId) {
			for (const key of blocks.keys()) {
				if (key.startsWith(`${credentialId}\0`)) blocks.delete(key);
			}
		},
		cleanExpiredCredentialBlocks(nowMs) {
			for (const [key, block] of blocks) {
				if (block.blockedUntilMs <= nowMs) blocks.delete(key);
			}
		},
		listCredentialBlocks(credentialIds) {
			const ids = new Set(credentialIds);
			return [...blocks.values()].filter(block => ids.has(block.credentialId) && block.blockedUntilMs > Date.now());
		},
		blocks,
		reconcileAfter,
		cleanExpiredCache() {},
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
		orgId: `org-${id}`,
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

	it("rechecks and clears a stale Fable block when live usage is healthy", async () => {
		const startNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(startNow);
		const blockedUntilMs = startNow + 24 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: "anthropic:oauth",
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 0, { resetsAt: blockedUntilMs }),
			"oat-2": withFable(baseReport("b@example.com"), 0.2, { resetsAt: blockedUntilMs }),
			"oat-3": withFable(baseReport("c@example.com"), 0.2, { resetsAt: blockedUntilMs }),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			return access ? (reportsByAccess[access] ?? null) : null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-1");
		expect(store.getCredentialBlock?.(1, "anthropic:oauth", "tier:fable")).toBeUndefined();
	});

	it("does not clear a fresh Fable block from a lagging healthy usage report", async () => {
		const startNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(startNow);
		const blockedUntilMs = startNow + 24 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: "anthropic:oauth",
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		store.reconcileAfter.set(`1\0anthropic:oauth\0tier:fable`, startNow + 5 * 60_000);
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 0, { resetsAt: blockedUntilMs }),
			"oat-2": withFable(baseReport("b@example.com"), 0.2, { resetsAt: blockedUntilMs }),
			"oat-3": withFable(baseReport("c@example.com"), 0.2, { resetsAt: blockedUntilMs }),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			return access ? (reportsByAccess[access] ?? null) : null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-2");
		expect(store.getCredentialBlock?.(1, "anthropic:oauth", "tier:fable")).toBe(blockedUntilMs);
	});

	it("keeps a Fable block while the scoped live meter is exhausted", async () => {
		const startNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(startNow);
		const blockedUntilMs = startNow + 24 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: "anthropic:oauth",
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1, { resetsAt: blockedUntilMs }),
			"oat-2": withFable(baseReport("b@example.com"), 0.2, { resetsAt: blockedUntilMs }),
			"oat-3": withFable(baseReport("c@example.com"), 0.2, { resetsAt: blockedUntilMs }),
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			return access ? (reportsByAccess[access] ?? null) : null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-2");
		expect(store.getCredentialBlock?.(1, "anthropic:oauth", "tier:fable")).toBe(blockedUntilMs);
	});

	it("heals the matching broker-sourced Anthropic grant without crossing organizations", async () => {
		const blockedUntilMs = Date.now() + 24 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: "anthropic:oauth",
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const report = withFable(baseReport("a@example.com"), 0, { resetsAt: blockedUntilMs });
		report.metadata = {
			...report.metadata,
			email: "a@example.com",
			accountId: "account-1",
			orgId: "org-1",
		};
		store.fetchUsageReports = async () => [report];

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(1, "anthropic:oauth", "tier:fable")).toBeUndefined();
	});

	it("does not heal an Anthropic block from another organization's usage report", async () => {
		const blockedUntilMs = Date.now() + 24 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: "anthropic:oauth",
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const report = withFable(baseReport("a@example.com"), 0, { resetsAt: blockedUntilMs });
		report.metadata = {
			...report.metadata,
			email: "a@example.com",
			accountId: "account-1",
			orgId: "other-org",
		};
		store.fetchUsageReports = async () => [report];

		await storage.fetchUsageReports();

		expect(store.getCredentialBlock?.(1, "anthropic:oauth", "tier:fable")).toBe(blockedUntilMs);
	});

	it("does not heal a requested Anthropic credential from a mismatched organization report", async () => {
		const blockedUntilMs = Date.now() + 24 * 60 * 60_000;
		store.upsertCredentialBlock?.({
			credentialId: 1,
			providerKey: "anthropic:oauth",
			blockScope: "tier:fable",
			blockedUntilMs,
		});
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 0, { resetsAt: blockedUntilMs }),
			"oat-2": withFable(baseReport("b@example.com"), 0.2, { resetsAt: blockedUntilMs }),
			"oat-3": withFable(baseReport("c@example.com"), 0.2, { resetsAt: blockedUntilMs }),
		};
		reportsByAccess["oat-1"].metadata = {
			email: "a@example.com",
			accountId: "account-1",
			orgId: "org-2",
		};
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			return access ? (reportsByAccess[access] ?? null) : null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-2");
		expect(store.getCredentialBlock?.(1, "anthropic:oauth", "tier:fable")).toBe(blockedUntilMs);
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
});
