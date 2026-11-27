import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type AuthStorageOptions,
	type ModelUsageAccountHealth,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { CredentialRankingStrategy, UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeRankingStrategy } from "@oh-my-pi/pi-ai/usage/claude";
import { logger } from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

function makeStore(rows: StoredAuthCredential[], blocked = new Map<number, number>()): AuthCredentialStore {
	const cache = new Map<string, CacheEntry>();
	return {
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
		getCredentialBlock: credentialId => blocked.get(credentialId),
		getCache(key) {
			const entry = cache.get(key);
			return entry && entry.expiresAtSec * 1000 > Date.now() ? entry.value : null;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
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

function apiKeyRow(id: number, source?: ApiKeyCredential["source"]): StoredAuthCredential {
	return {
		id,
		provider: "anthropic",
		credential: { type: "api_key", key: `key-${id}`, source },
		disabledCause: null,
	};
}

function limit(id: string, usedFraction: number, modelId?: string): UsageLimit {
	return {
		id,
		label: id,
		scope: { provider: "anthropic", modelId },
		window: { id, label: id, resetsAt: Date.now() + 60_000 },
		amount: { usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function report(accountId: string, limits: UsageLimit[]): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits,
		metadata: { accountId },
	};
}

const strategy: CredentialRankingStrategy = {
	findWindowLimits: usage => ({ primary: usage.limits[0], secondary: usage.limits[1] }),
	scopeLimits: (usage, context) =>
		usage.limits.filter(entry => entry.scope.modelId === undefined || entry.scope.modelId === context?.modelId),
	blockScope: context => (context?.modelId ? `model:${context.modelId}` : undefined),
	blockScopes: context => [context?.modelId ? `model:${context.modelId}` : "model", "shared"],
	windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
};

function makeUsageProvider(reports: Record<string, UsageReport | null>): UsageProvider {
	return {
		id: "anthropic",
		fetchUsage: async params => {
			const account = params.credential.accountId ?? params.credential.apiKey;
			return account ? (reports[account] ?? null) : null;
		},
	};
}

describe("AuthStorage model usage health", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	async function createStorage(
		rows: StoredAuthCredential[],
		reports: Record<string, UsageReport | null>,
		blocked?: Map<number, number>,
	): Promise<AuthStorage> {
		const storage = new AuthStorage(makeStore(rows, blocked), {
			usageProviderResolver: provider => (provider === "anthropic" ? makeUsageProvider(reports) : undefined),
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		storages.push(storage);
		return storage;
	}

	it("prefetches selection usage without pinning, and an aborted warmup does not cancel foreground resolution", async () => {
		const release = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		let calls = 0;
		const usageProvider: UsageProvider = {
			id: "anthropic",
			async fetchUsage(params) {
				calls += 1;
				if (calls === 2) started.resolve();
				await release.promise;
				return report(params.credential.accountId!, [limit("short", 0.2)]);
			},
		};
		const storage = new AuthStorage(makeStore([oauthRow(1), oauthRow(2)]), {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
		});
		await storage.credentials.reload();
		storages.push(storage);
		const controller = new AbortController();
		const warm = storage.keys.prefetchUsage("anthropic", "prefetch-session", { signal: controller.signal });
		await started.promise;
		expect(storage.oauth.accounts("anthropic", "prefetch-session").some(account => account.active)).toBe(false);
		const foreground = storage.keys.get("anthropic", "prefetch-session");
		controller.abort();
		await expect(warm).rejects.toThrow();
		release.resolve();
		expect(await foreground).toMatch(/^access-[12]$/);
		expect(calls).toBe(2);
		// Prefetching never advances the non-session round-robin cursor.
		expect(await storage.keys.get("anthropic")).toBe("access-1");
	});

	it.each(["runtime", "config", "pinned", "single", "restricted", "unranked"] as const)(
		"does not prefetch usage for a %s selection",
		async mode => {
			const fetchUsage = vi.fn(async () => null);
			const storage = new AuthStorage(makeStore(mode === "single" ? [oauthRow(1)] : [oauthRow(1), oauthRow(2)]), {
				usageProviderResolver: provider => (provider === "anthropic" ? { id: "anthropic", fetchUsage } : undefined),
				rankingStrategyResolver: () => (mode === "unranked" ? undefined : strategy),
			});
			await storage.credentials.reload();
			storages.push(storage);
			if (mode === "runtime") storage.keys.setRuntime("anthropic", "override");
			if (mode === "config") storage.keys.setConfig("anthropic", "override");
			if (mode === "pinned") storage.sessions.pin("anthropic", "session", 1);
			if (mode === "restricted") storage.sessions.restrict("anthropic", "session", ["account:account-1"]);

			await storage.keys.prefetchUsage("anthropic", "session");
			expect(fetchUsage).not.toHaveBeenCalled();
		},
	);

	it("prefetches a model-gated single account when selection needs plan evidence", async () => {
		const fetchUsage = vi.fn(async () => report("account-1", [limit("short", 0.2)]));
		const storage = new AuthStorage(makeStore([oauthRow(1)]), {
			usageProviderResolver: provider => (provider === "anthropic" ? { id: "anthropic", fetchUsage } : undefined),
			rankingStrategyResolver: () => ({ ...strategy, planGate: () => () => true }),
		});
		await storage.credentials.reload();
		storages.push(storage);
		await storage.keys.prefetchUsage("anthropic", "session", { modelId: "plan-gated" });
		expect(fetchUsage).toHaveBeenCalledTimes(1);
		expect(storage.oauth.accounts("anthropic", "session").some(account => account.active)).toBe(false);
	});

	it.each([
		{ rejected: false, state: "healthy" },
		{ rejected: true, state: "depleted" },
	])("restores model health across processes after OAuth refresh ($state)", async ({ rejected, state }) => {
		await using dir = await TempDir.create();
		const dbPath = dir.join("agent.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		let offline = true;
		const reports = { "account-1": report("account-1", [limit("short", 0.2)]) };
		const options: AuthStorageOptions = {
			async refreshOAuthCredential() {
				if (offline) throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
				return { access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 3_600_000 };
			},
			usageProviderResolver: () => makeUsageProvider(reports),
			rankingStrategyResolver: () => strategy,
		};
		const auth = new AuthStorage(store, options);
		const model = { modelId: "claude", reserveFraction: 0.1 };
		try {
			const { credential } = oauthRow(1);
			if (credential.type !== "oauth") throw new Error("expected OAuth credential");
			await auth.credentials.set("anthropic", [{ ...credential, expires: Date.now() - 60_000 }]);
			expect(await auth.keys.get("anthropic", "offline", model)).toBeUndefined();
			expect((await auth.health.model("anthropic", model)).state).toBe("depleted");

			if (rejected) {
				const [row] = store.listAuthCredentials("anthropic");
				if (!row) throw new Error("expected stored OAuth credential");
				auth.blocks.upsert({
					credentialId: row.id,
					providerKey: "anthropic:oauth",
					blockScope: "auth",
					blockedUntilMs: Date.now() + 60_000,
				});
			}
			offline = false;
			expect(await auth.keys.get("anthropic", "online", model)).toBe("fresh-access");

			const peer = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath), options);
			try {
				await peer.credentials.reload();
				expect((await peer.health.model("anthropic", model)).state).toBe(state);
				expect((await auth.health.model("anthropic", model)).state).toBe(state);
			} finally {
				peer.close();
			}
		} finally {
			auth.close();
		}
	});

	it("honours every request scope when checking persisted health blocks", async () => {
		const rows = [oauthRow(1)];
		const store = makeStore(rows);
		store.getCredentialBlock = (credentialId, _providerKey, blockScope) =>
			credentialId === 1 && blockScope === "shared" ? Date.now() + 60_000 : undefined;
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "anthropic"
					? makeUsageProvider({ "account-1": report("account-1", [limit("short", 0.2)]) })
					: undefined,
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		storages.push(storage);

		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("depleted");
		expect(health.accounts[0]?.state).toBe("depleted");
	});

	it("keeps the model healthy while any OAuth sibling has headroom", async () => {
		const storage = await createStorage([oauthRow(1), oauthRow(2)], {
			"account-1": report("account-1", [limit("short", 1)]),
			"account-2": report("account-2", [limit("short", 0.4)]),
		});
		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts.map(account => account.state)).toEqual(["depleted", "healthy"]);
	});

	it("does not declare depletion while any pooled sibling is unknown", async () => {
		const storage = await createStorage([oauthRow(1), oauthRow(2)], {
			"account-1": report("account-1", [limit("short", 1)]),
			"account-2": null,
		});
		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("unknown");
		expect(health.accounts.map(account => account.state)).toEqual(["depleted", "unknown"]);
	});

	it("reports reserve only after every sibling is reserve or depleted", async () => {
		const storage = await createStorage([oauthRow(1), oauthRow(2)], {
			"account-1": report("account-1", [limit("short", 0.95)]),
			"account-2": report("account-2", [limit("short", 1)]),
		});
		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("reserve");
	});

	it.each([
		["5-hour", 0.95, 0.2],
		["7-day", 0.2, 0.95],
	])("uses the most consumed active window when the %s limit reaches reserve", async (_window, short, long) => {
		const storage = await createStorage([oauthRow(1)], {
			"account-1": report("account-1", [limit("5-hour", short), limit("7-day", long)]),
		});

		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});

		expect(health.state).toBe("reserve");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.05);
	});

	it("expires short and long usage windows independently", async () => {
		const now = Date.now();
		const usageReport = report("account-1", [limit("5-hour", 1), limit("7-day", 0.95)]);
		usageReport.fetchedAt = now - 120_000;
		usageReport.limits[0].window = {
			id: "5-hour",
			label: "5-hour",
			resetsAt: now - 60_000,
		};
		usageReport.limits[1].window = {
			id: "7-day",
			label: "7-day",
			resetsAt: now + 60_000,
		};
		const storage = await createStorage([oauthRow(1)], { "account-1": usageReport });

		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});

		expect(health.state).toBe("reserve");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.05);
	});

	it("ignores reserve samples after their usage window has reset", async () => {
		const now = Date.now();
		const staleReport = report("account-1", [limit("short", 0.95)]);
		staleReport.fetchedAt = now - 120_000;
		staleReport.limits[0].window = { id: "short", label: "short", resetsAt: now - 60_000 };
		const storage = await createStorage([oauthRow(1)], { "account-1": staleReport });

		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});

		expect(health.state).toBe("unknown");
		expect(health.accounts[0]?.state).toBe("unknown");
	});

	it("uses provider model scoping before aggregating account health", async () => {
		const usageReport = report("account-1", [limit("claude", 1, "claude"), limit("haiku", 0.2, "haiku")]);
		const storage = await createStorage([oauthRow(1)], {
			"account-1": usageReport,
		});
		const health = await storage.health.model("anthropic", {
			modelId: "haiku",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.8);
		expect(storage.usage.reportingModelIds("anthropic", ["claude", "haiku", "unmapped"], [usageReport])).toEqual([
			"claude",
			"haiku",
		]);
	});

	it("lists account-wide usage models even without a provider ranking strategy", async () => {
		const storage = new AuthStorage(makeStore([]), {
			rankingStrategyResolver: () => undefined,
		});
		storages.push(storage);
		const sharedReport: UsageReport = {
			provider: "cursor",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "monthly",
					label: "Monthly",
					scope: { provider: "cursor", shared: true },
					amount: { usedFraction: 0.4, unit: "percent" },
				},
			],
		};
		expect(storage.usage.reportingModelIds("cursor", ["composer-1", "composer-2"], [sharedReport])).toEqual([
			"composer-1",
			"composer-2",
		]);
	});

	it("honors persisted scoped blocks without probing blocked accounts", async () => {
		const resetAt = Date.now() + 60_000;
		const storage = await createStorage(
			[oauthRow(1), oauthRow(2)],
			{ "account-1": report("account-1", [limit("short", 0.1)]), "account-2": null },
			new Map([[1, resetAt]]),
		);
		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.accounts[0]).toMatchObject({ state: "depleted", resetsAt: resetAt });
		expect(health.state).toBe("unknown");
	});

	it("inspects only login API keys when that higher-precedence pool exists", async () => {
		const storage = await createStorage([apiKeyRow(1, "login"), apiKeyRow(2)], {
			"key-1": report("key-1", [limit("short", 1)]),
			"key-2": report("key-2", [limit("short", 0.1)]),
		});
		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("depleted");
		expect(health.accounts.map(account => account.credentialId)).toEqual([1]);
	});

	it("ignores ordinary configured API keys even when a usage endpoint exists", async () => {
		const storage = await createStorage([apiKeyRow(1)], {
			"key-1": report("key-1", [limit("short", 1)]),
		});
		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health).toEqual({ state: "unknown", accounts: [] });
	});

	it("releases a reserve account so native ranking selects a healthy sibling", async () => {
		const store = makeStore([apiKeyRow(1, "login"), apiKeyRow(2, "login")]);
		store.setCache(
			"session:sticky:anthropic:session-1",
			JSON.stringify({ type: "api_key", index: 0, credentialId: 1, lastUsedAtMs: Date.now() }),
			Math.floor(Date.now() / 1000) + 3600,
		);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "anthropic"
					? makeUsageProvider({
							"key-1": report("key-1", [limit("short", 0.95)]),
							"key-2": report("key-2", [limit("short", 0.2)]),
						})
					: undefined,
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		storages.push(storage);
		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			sessionId: "session-1",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts.find(account => account.selected)).toMatchObject({
			credentialId: 1,
			state: "reserve",
		});
		expect(storage.sessions.release("anthropic", "session-1")).toBe(true);
		expect(await storage.keys.get("anthropic", "session-1", { modelId: "claude" })).toBe("key-2");
	});

	it("does not consume the native API-key round-robin cursor", async () => {
		const storage = await createStorage([apiKeyRow(1, "login"), apiKeyRow(2, "login")], {
			"key-1": report("key-1", [limit("short", 0.2)]),
			"key-2": report("key-2", [limit("short", 0.2)]),
		});
		await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(await storage.keys.get("anthropic", undefined, { modelId: "claude" })).toBe("key-1");
	});

	it("returns unknown for static overrides that bypass the native pool", async () => {
		const storage = await createStorage([oauthRow(1)], {
			"account-1": report("account-1", [limit("short", 1)]),
		});
		storage.keys.setRuntime("anthropic", "override-key");
		const health = await storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health).toEqual({ state: "unknown", accounts: [] });
	});

	it("cancels the caller without cancelling the shared local usage fetch", async () => {
		const pending = Promise.withResolvers<UsageReport | null>();
		const storage = new AuthStorage(makeStore([apiKeyRow(1, "login")]), {
			usageProviderResolver: provider =>
				provider === "anthropic" ? { id: "anthropic", fetchUsage: () => pending.promise } : undefined,
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		storages.push(storage);
		const controller = new AbortController();
		const health = storage.health.model("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort();
		await expect(health).rejects.toThrow("usage fetch aborted");
		pending.resolve(report("key-1", [limit("short", 0.2)]));
	});
});

function sqliteCorruptError(): Error & { code: string } {
	const err = new Error("database disk image is malformed (11) (Rowid 77291 out of order)") as Error & {
		code: string;
	};
	err.code = "SQLITE_CORRUPT";
	return err;
}

describe("AuthStorage corrupt persisted block store", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
		vi.restoreAllMocks();
	});

	it("latches a corrupt block read, reports once, and stops re-querying the store", async () => {
		const rows = [oauthRow(1)];
		const store = makeStore(rows);
		let getBlockCalls = 0;
		store.getCredentialBlock = () => {
			getBlockCalls += 1;
			throw sqliteCorruptError();
		};
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "anthropic"
					? makeUsageProvider({ "account-1": report("account-1", [limit("short", 0.2)]) })
					: undefined,
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		storages.push(storage);

		const first = await storage.health.model("anthropic", { modelId: "claude", reserveFraction: 0.1 });
		const second = await storage.health.model("anthropic", { modelId: "claude", reserveFraction: 0.1 });

		// Availability is preserved: a corrupt persisted read fails open to the
		// in-memory backoff (no block) instead of spuriously forcing depletion.
		expect(first.state).toBe("healthy");
		expect(second.state).toBe("healthy");
		// Latched on the first unrecoverable error: the broken store is queried
		// exactly once despite three block-scope reads per health check across two calls.
		expect(getBlockCalls).toBe(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("latches a corrupt block write and stops attempting persistence", async () => {
		const rows = [apiKeyRow(1)];
		const store = makeStore(rows);
		let upsertCalls = 0;
		store.upsertCredentialBlock = () => {
			upsertCalls += 1;
			throw sqliteCorruptError();
		};
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		storages.push(storage);

		await storage.limits.markReached("anthropic", undefined, { apiKey: "key-1" });
		await storage.limits.markReached("anthropic", undefined, { apiKey: "key-1" });

		// First upsert throws SQLITE_CORRUPT and latches; the second mark skips
		// the store entirely rather than retrying a broken write on every 429.
		expect(upsertCalls).toBe(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("skips reconcile-after reads after a corrupt Codex block write latches the store", async () => {
		const credential: AuthCredential = {
			type: "oauth",
			access: "access-1",
			refresh: "refresh-1",
			expires: Date.now() + 60 * 60_000,
			accountId: "account-1",
		};
		const rows: StoredAuthCredential[] = [{ id: 1, provider: "openai-codex", credential, disabledCause: null }];
		const healthyReport: UsageReport = {
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [limit("short", 0.2)],
			metadata: { accountId: "account-1", allowed: true, limitReached: false },
		};
		const usageProvider: UsageProvider = {
			id: "openai-codex",
			fetchUsage: async () => healthyReport,
		};
		const store = makeStore(rows);
		let upsertCalls = 0;
		let reconcileAfterCalls = 0;
		store.upsertCredentialBlock = () => {
			upsertCalls += 1;
			throw sqliteCorruptError();
		};
		store.getCredentialBlockReconcileAfter = () => {
			reconcileAfterCalls += 1;
			throw sqliteCorruptError();
		};
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === "openai-codex" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		storages.push(storage);

		await storage.limits.markReached("openai-codex", undefined, {
			credentialId: 1,
			modelId: "claude",
		});
		const health = await storage.health.model("openai-codex", {
			modelId: "claude",
			reserveFraction: 0.1,
		});

		expect(upsertCalls).toBe(1);
		expect(reconcileAfterCalls).toBe(0);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(health.state).toBe("depleted");
	});
	it("latches every broker-facing block operation independently", async () => {
		const block = {
			credentialId: 1,
			providerKey: "anthropic:api_key",
			blockScope: "",
			blockedUntilMs: Date.now() + 60_000,
		};
		const scenarios: Array<{
			name: string;
			install: (store: AuthCredentialStore, recordCall: () => void) => void;
			invoke: (storage: AuthStorage) => unknown;
			fallback: unknown;
			failsWhenLatched: boolean;
		}> = [
			{
				name: "listCredentialBlocks",
				install: (store, recordCall) => {
					store.listCredentialBlocks = () => {
						recordCall();
						throw sqliteCorruptError();
					};
				},
				invoke: storage => storage.blocks.list([1]),
				fallback: [],
				failsWhenLatched: false,
			},
			{
				name: "upsertCredentialBlock",
				install: (store, recordCall) => {
					store.upsertCredentialBlock = () => {
						recordCall();
						throw sqliteCorruptError();
					};
				},
				invoke: storage => storage.blocks.upsert(block),
				fallback: undefined,
				failsWhenLatched: true,
			},
			{
				name: "deleteCredentialBlock",
				install: (store, recordCall) => {
					store.deleteCredentialBlock = () => {
						recordCall();
						throw sqliteCorruptError();
					};
				},
				invoke: storage => storage.blocks.delete(1, block.providerKey, block.blockScope),
				fallback: undefined,
				failsWhenLatched: true,
			},
			{
				name: "deleteCredentialBlocks",
				install: (store, recordCall) => {
					store.deleteCredentialBlocks = () => {
						recordCall();
						throw sqliteCorruptError();
					};
				},
				invoke: storage => storage.blocks.deleteAll(1),
				fallback: undefined,
				failsWhenLatched: true,
			},
		];
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		for (const scenario of scenarios) {
			const store = makeStore([]);
			let calls = 0;
			scenario.install(store, () => {
				calls += 1;
			});
			const storage = new AuthStorage(store);
			await storage.credentials.reload();
			storages.push(storage);

			if (scenario.failsWhenLatched) {
				expect(() => scenario.invoke(storage), scenario.name).toThrow("unavailable after SQLite corruption");
				expect(() => scenario.invoke(storage), scenario.name).toThrow("unavailable after SQLite corruption");
			} else {
				expect(scenario.invoke(storage), scenario.name).toEqual(scenario.fallback);
				expect(scenario.invoke(storage), scenario.name).toEqual(scenario.fallback);
			}
			expect(calls, scenario.name).toBe(1);
		}
		expect(errorSpy).toHaveBeenCalledTimes(scenarios.length);
	});
});

describe("AuthStorage Claude tier reserve health", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
	const HOUR_MS = 60 * 60 * 1000;

	function claudeLimit(opts: {
		id: string;
		windowId: "5h" | "7d";
		usedFraction: number;
		shared?: boolean;
		tier?: string;
		exhausted?: boolean;
	}): UsageLimit {
		const resetsAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
		return {
			id: opts.id,
			label: opts.id,
			scope: {
				provider: "anthropic",
				windowId: opts.windowId,
				...(opts.tier !== undefined ? { tier: opts.tier } : {}),
				...(opts.shared !== undefined ? { shared: opts.shared } : {}),
			},
			window: {
				id: opts.windowId,
				label: opts.windowId,
				durationMs: opts.windowId === "5h" ? 5 * HOUR_MS : WEEK_MS,
				resetsAt,
			},
			amount: { usedFraction: opts.usedFraction, unit: "percent" },
			status: opts.exhausted ? "exhausted" : "ok",
		};
	}

	async function createClaudeStorage(reports: Record<string, UsageReport | null>): Promise<AuthStorage> {
		const storage = new AuthStorage(makeStore([oauthRow(1)]), {
			usageProviderResolver: provider => (provider === "anthropic" ? makeUsageProvider(reports) : undefined),
			rankingStrategyResolver: provider => (provider === "anthropic" ? claudeRankingStrategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		storages.push(storage);
		return storage;
	}

	function tieredReport(fableUsedFraction: number, exhausted = false): UsageReport {
		return report("account-1", [
			claudeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.1, shared: true }),
			claudeLimit({ id: "anthropic:7d", windowId: "7d", usedFraction: 0.72, shared: true }),
			claudeLimit({
				id: "anthropic:7d:fable",
				windowId: "7d",
				usedFraction: fableUsedFraction,
				tier: "fable",
				exhausted,
			}),
		]);
	}

	it("reports reserve when the mapped Fable tier row is inside the reserve margin", async () => {
		const storage = await createClaudeStorage({ "account-1": tieredReport(0.96) });
		const health = await storage.health.model("anthropic", {
			modelId: "claude-fable-5",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("reserve");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.04);
	});

	it("keeps a Fable model healthy while its tier row stays outside the reserve margin", async () => {
		const storage = await createClaudeStorage({ "account-1": tieredReport(0.85) });
		const health = await storage.health.model("anthropic", {
			modelId: "claude-fable-5",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.15);
	});

	it("does not let a Fable-only tier row pull unrelated Opus traffic into reserve", async () => {
		const storage = await createClaudeStorage({ "account-1": tieredReport(0.96) });
		const health = await storage.health.model("anthropic", {
			modelId: "claude-opus-4-8",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.28);
	});

	it("still depletes a Fable model on a confirmed 100% tier row", async () => {
		const storage = await createClaudeStorage({ "account-1": tieredReport(1, true) });
		const health = await storage.health.model("anthropic", {
			modelId: "claude-fable-5",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("depleted");
		expect(health.accounts[0]?.resetsAt).toBeGreaterThan(Date.now());
	});
});

describe("AuthStorage model usage health depletion cause", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	const CODEX_DENIED_MODEL = "gpt-daybreak-blue-latest";

	async function createStorage(
		rows: StoredAuthCredential[],
		reports: Record<string, UsageReport | null>,
		rankingStrategy: CredentialRankingStrategy = strategy,
	): Promise<AuthStorage> {
		const storage = new AuthStorage(makeStore(rows), {
			usageProviderResolver: provider => (provider === "anthropic" ? makeUsageProvider(reports) : undefined),
			rankingStrategyResolver: () => rankingStrategy,
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		storages.push(storage);
		return storage;
	}

	/** An account-wide policy denial: rotation blocks the account under the `account-policy` scope. */
	async function denyAccountPolicy(storage: AuthStorage): Promise<void> {
		await storage.limits.rotate("anthropic", undefined, {
			credentialId: 1,
			error: new Error(
				"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
			),
		});
	}

	/** A 401: rotation blocks the account under the `auth` scope. */
	async function rejectAuth(storage: AuthStorage): Promise<void> {
		await storage.limits.rotate("anthropic", undefined, {
			credentialId: 1,
			error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
		});
	}

	/** A usage-limit answer: the account is blocked under the request's `model:claude` usage scope. */
	async function reachUsageLimit(storage: AuthStorage, retryAfterMs?: number): Promise<void> {
		await storage.limits.markReached("anthropic", undefined, { credentialId: 1, modelId: "claude", retryAfterMs });
	}

	async function claudeAccount(storage: AuthStorage): Promise<ModelUsageAccountHealth | undefined> {
		const health = await storage.health.model("anthropic", { modelId: "claude", reserveFraction: 0.1 });
		return health.accounts[0];
	}

	it("reads an account held only by an account-policy block as depleted by account-policy", async () => {
		const storage = await createStorage([oauthRow(1)], { "account-1": null });
		await denyAccountPolicy(storage);
		expect(await claudeAccount(storage)).toMatchObject({ state: "depleted", depletedBy: "account-policy" });
	});

	it("reads an account held only by a model-policy block as depleted by account-policy", async () => {
		const storage = await createStorage([{ ...oauthRow(1), provider: "openai-codex" }], {});
		await storage.limits.rotate("openai-codex", undefined, {
			credentialId: 1,
			modelId: CODEX_DENIED_MODEL,
			error: new ProviderHttpError(
				`The '${CODEX_DENIED_MODEL}' model is not supported when using Codex with a ChatGPT account. (code=invalid_request_error)`,
				400,
				{ code: "invalid_request_error" },
			),
		});
		const health = await storage.health.model("openai-codex", {
			modelId: CODEX_DENIED_MODEL,
			reserveFraction: 0.1,
		});
		expect(health.accounts[0]).toMatchObject({ state: "depleted", depletedBy: "account-policy" });
	});

	it("reads an account held only by an auth block as depleted by auth", async () => {
		const storage = await createStorage([oauthRow(1)], { "account-1": null });
		await rejectAuth(storage);
		expect(await claudeAccount(storage)).toMatchObject({ state: "depleted", depletedBy: "auth" });
	});

	it("reads an account held only by an OAuth refresh-failure block as depleted by auth", async () => {
		const { credential } = oauthRow(1);
		if (credential.type !== "oauth") throw new Error("expected OAuth credential");
		const expired = { ...oauthRow(1), credential: { ...credential, expires: Date.now() - 60_000 } };
		const storage = new AuthStorage(makeStore([expired]), {
			async refreshOAuthCredential() {
				throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
			},
			usageProviderResolver: () => makeUsageProvider({ "account-1": null }),
			rankingStrategyResolver: () => strategy,
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		storages.push(storage);
		// The failed refresh blocks the account under the `oauth-refresh-failure` scope.
		expect(await storage.keys.get("anthropic", "session-1", { modelId: "claude" })).toBeUndefined();
		expect(await claudeAccount(storage)).toMatchObject({ state: "depleted", depletedBy: "auth" });
	});

	it("reads an account held only by an OAuth organization denial as depleted by account-policy", async () => {
		const storage = await createStorage([oauthRow(1)], { "account-1": null });
		// The denial blocks the account under the `oauth-org-policy` scope.
		await storage.limits.rotate("anthropic", undefined, {
			credentialId: 1,
			error: new ProviderHttpError("OAuth authentication is currently not allowed for this organization.", 403, {
				code: "oauth_not_allowed_for_organization",
			}),
		});
		expect(await claudeAccount(storage)).toMatchObject({ state: "depleted", depletedBy: "account-policy" });
	});

	it("reads account-policy over auth when no usage block holds the account", async () => {
		const storage = await createStorage([oauthRow(1)], { "account-1": null });
		await denyAccountPolicy(storage);
		await rejectAuth(storage);
		expect(await claudeAccount(storage)).toMatchObject({ state: "depleted", depletedBy: "account-policy" });
	});

	it("reads a usage-limit block as depleted by usage", async () => {
		const storage = await createStorage([oauthRow(1)], { "account-1": null });
		await reachUsageLimit(storage);
		expect(await claudeAccount(storage)).toMatchObject({ state: "depleted", depletedBy: "usage" });
	});

	it("reads a usage block that a fresh report does not clear as depleted by usage", async () => {
		const storage = await createStorage(
			[oauthRow(1)],
			{ "account-1": report("account-1", [limit("short", 0.2)]) },
			{ ...strategy, healableBlockScopes: () => [] },
		);
		await reachUsageLimit(storage);
		expect(await claudeAccount(storage)).toMatchObject({ state: "depleted", depletedBy: "usage" });
	});

	it("reads an exhausted usage window with no block as depleted by usage", async () => {
		const storage = await createStorage([oauthRow(1)], { "account-1": report("account-1", [limit("short", 1)]) });
		expect(await claudeAccount(storage)).toMatchObject({ state: "depleted", depletedBy: "usage" });
	});

	it("reads usage over account-policy and keeps the later deadline of the two", async () => {
		const storage = await createStorage([oauthRow(1)], { "account-1": null });
		await reachUsageLimit(storage, 20_000);
		await denyAccountPolicy(storage);
		const account = await claudeAccount(storage);
		expect(account).toMatchObject({ state: "depleted", depletedBy: "usage" });
		// The 60 s account-policy block outlasts the 20 s usage block, so it sets resetsAt.
		expect(account?.resetsAt).toBeGreaterThan(Date.now() + 30_000);
	});

	it("leaves healthy, reserve and unknown accounts without a cause", async () => {
		const storage = await createStorage([oauthRow(1), oauthRow(2), oauthRow(3)], {
			"account-1": report("account-1", [limit("short", 0.2)]),
			"account-2": report("account-2", [limit("short", 0.95)]),
			"account-3": null,
		});
		const health = await storage.health.model("anthropic", { modelId: "claude", reserveFraction: 0.1 });
		expect(health.accounts.map(account => account.state)).toEqual(["healthy", "reserve", "unknown"]);
		for (const account of health.accounts) expect(account.depletedBy).toBeUndefined();
	});
});
