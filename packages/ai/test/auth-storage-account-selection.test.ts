import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withOAuthAccess } from "@oh-my-pi/pi-ai/auth-retry";
import {
	type AuthAccountSelection,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";
import { removeWithRetries } from "../../utils/src/temp";

const OAUTH_PROVIDER = "unit-account-selection";
const HOUR_MS = 60 * 60 * 1000;
const SESSION_SAMPLE_COUNT = 12;

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + HOUR_MS,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function zaiUsage(apiKey: string, remaining: number): UsageReport {
	return {
		provider: "zai",
		fetchedAt: Date.now(),
		limits: [
			{
				id: `zai:requests:5h:${apiKey}`,
				label: "ZAI Request Quota",
				scope: { provider: "zai", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
				amount: {
					unit: "requests",
					used: 100 - remaining,
					limit: 100,
					remaining,
					remainingFraction: remaining / 100,
					usedFraction: (100 - remaining) / 100,
				},
				status: remaining === 0 ? "exhausted" : "ok",
			},
		],
	};
}

const CODEX_PROVIDER = "openai-codex";
/** Any `gpt-5.6-sol` request needs a paid Codex plan, so selection must consult usage reports. */
const PLAN_GATED_CODEX_MODEL = "gpt-5.6-sol";

function codexUsage(accountId: string, primaryUsedFraction: number, planType: string): UsageReport {
	// The Codex ranking strategy recognises windows by `openai-codex:primary` / `:secondary` ids.
	const window = (key: "primary" | "secondary", windowId: string, durationMs: number, usedFraction: number) => ({
		id: `openai-codex:${key}`,
		label: `${key} window`,
		scope: { provider: CODEX_PROVIDER, windowId, shared: true },
		window: { id: windowId, label: `${key} window`, durationMs, resetsAt: Date.now() + durationMs },
		amount: {
			unit: "percent" as const,
			used: usedFraction * 100,
			limit: 100,
			remaining: (1 - usedFraction) * 100,
			usedFraction,
			remainingFraction: 1 - usedFraction,
		},
		status: "ok" as const,
	});
	return {
		provider: CODEX_PROVIDER,
		fetchedAt: Date.now(),
		limits: [
			window("primary", "5h", 5 * HOUR_MS, primaryUsedFraction),
			window("secondary", "7d", 7 * 24 * HOUR_MS, 0.5),
		],
		metadata: { accountId, planType, allowed: true, limitReached: false },
	};
}

describe("AuthStorage account selection policy", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-account-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	function openStorage(accountSelection?: AuthAccountSelection, usageProvider?: UsageProvider): AuthStorage {
		if (!store) throw new Error("test setup failed");
		authStorage = new AuthStorage(store, {
			accountSelection,
			usageProviderResolver: provider => (provider === usageProvider?.id ? usageProvider : undefined),
		});
		return authStorage;
	}

	function mockOAuthRefresh(): void {
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	}

	async function seedThreeOAuthAccounts(storage: AuthStorage): Promise<void> {
		await storage.set(OAUTH_PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
	}

	function resolveEmail(storage: AuthStorage, sessionId: string): Promise<string | undefined> {
		return withOAuthAccess(storage, OAUTH_PROVIDER, access => Promise.resolve(access.email), { sessionId });
	}

	async function resolveEmailsForFreshSessions(
		storage: AuthStorage,
		prefix: string,
	): Promise<Set<string | undefined>> {
		const emails = new Set<string | undefined>();
		for (let index = 0; index < SESSION_SAMPLE_COUNT; index += 1) {
			emails.add(await resolveEmail(storage, `${prefix}-${index}`));
		}
		return emails;
	}

	test("balanced (default) spreads fresh sessions across sibling OAuth accounts", async () => {
		// Negative contract for the tests below: if session-hashed starts ever stop
		// distributing, `fixed` would be indistinguishable from the default.
		mockOAuthRefresh();
		const storage = openStorage();
		await seedThreeOAuthAccounts(storage);

		const emails = await resolveEmailsForFreshSessions(storage, "balanced");

		expect(emails.size).toBeGreaterThan(1);
	});

	test("fixed: every fresh session resolves the first stored OAuth account", async () => {
		// Regression: a backup account starts serving brand-new sessions again.
		mockOAuthRefresh();
		const storage = openStorage("fixed");
		await seedThreeOAuthAccounts(storage);

		const emails = await resolveEmailsForFreshSessions(storage, "fixed");

		expect([...emails]).toEqual(["a@example.com"]);
	});

	test("fixed: session-less lookups do not round-robin across OAuth accounts", async () => {
		// Regression: background lookups (no session id) rotate a→b→c again.
		mockOAuthRefresh();
		const storage = openStorage("fixed");
		await seedThreeOAuthAccounts(storage);

		const keys = [
			await storage.getApiKey(OAUTH_PROVIDER),
			await storage.getApiKey(OAUTH_PROVIDER),
			await storage.getApiKey(OAUTH_PROVIDER),
		];

		expect(keys).toEqual(["access-a", "access-a", "access-a"]);
	});

	test("fixed: a usage-limited first account falls through to the next stored account", async () => {
		// Regression: the pinned-first policy keeps hammering a rate-limited account
		// (or starts spreading to `c` instead of the next sibling `b`).
		mockOAuthRefresh();
		const storage = openStorage("fixed");
		await seedThreeOAuthAccounts(storage);
		expect(await resolveEmail(storage, "limited-session")).toBe("a@example.com");

		await storage.markUsageLimitReached(OAUTH_PROVIDER, "limited-session", { retryAfterMs: HOUR_MS });

		expect(await resolveEmail(storage, "limited-session")).toBe("b@example.com");
		expect(await resolveEmail(storage, "another-session")).toBe("b@example.com");
	});

	test("fixed: stored API keys resolve in stored order without consulting usage reports", async () => {
		// Regression: fixed mode silently ranks API keys by quota again, flipping to
		// the sibling key and probing the usage endpoint on every resolve.
		const fetchUsage = vi.fn(async (params: { credential: { apiKey?: string } }) =>
			params.credential.apiKey === "zai-exhausted" ? zaiUsage("zai-exhausted", 0) : zaiUsage("zai-healthy", 80),
		);
		const usageProvider: UsageProvider = {
			id: "zai",
			fetchUsage: fetchUsage as UsageProvider["fetchUsage"],
			supports: params => params.provider === "zai" && params.credential.type === "api_key",
		};
		const storage = openStorage("fixed", usageProvider);
		await storage.set("zai", [
			{ type: "api_key", key: "zai-exhausted", source: "login" },
			{ type: "api_key", key: "zai-healthy", source: "login" },
		]);

		expect(await storage.getApiKey("zai")).toBe("zai-exhausted");
		expect(fetchUsage).not.toHaveBeenCalled();
	});

	function codexUsageProvider(reports: Map<string, UsageReport>): UsageProvider {
		return {
			id: CODEX_PROVIDER,
			async fetchUsage(params) {
				const accountId = params.credential.accountId;
				return accountId ? (reports.get(accountId) ?? null) : null;
			},
		};
	}

	async function seedTwoCodexAccounts(storage: AuthStorage): Promise<void> {
		await storage.set(CODEX_PROVIDER, [oauthCredential("first"), oauthCredential("second")]);
	}

	test("balanced (default) moves a plan-gated Codex request off a hot first account", async () => {
		// Negative contract for the fixed test below: usage ranking must still
		// prefer the cool sibling, or `fixed` would be indistinguishable from it.
		mockOAuthRefresh();
		const reports = new Map<string, UsageReport>([
			["acc-first", codexUsage("acc-first", 0.9, "plus")],
			["acc-second", codexUsage("acc-second", 0.1, "plus")],
		]);
		const storage = openStorage(undefined, codexUsageProvider(reports));
		await seedTwoCodexAccounts(storage);

		expect(await storage.getApiKey(CODEX_PROVIDER, "codex-balanced", { modelId: PLAN_GATED_CODEX_MODEL })).toBe(
			"access-second",
		);
	});

	test("fixed: a plan-gated Codex request stays on the first eligible account despite a cooler sibling", async () => {
		// Regression: plan verification re-enables headroom ranking, so the
		// backup account silently takes over whenever the primary runs hot.
		mockOAuthRefresh();
		const reports = new Map<string, UsageReport>([
			["acc-first", codexUsage("acc-first", 0.9, "plus")],
			["acc-second", codexUsage("acc-second", 0.1, "plus")],
		]);
		const storage = openStorage("fixed", codexUsageProvider(reports));
		await seedTwoCodexAccounts(storage);

		expect(await storage.getApiKey(CODEX_PROVIDER, "codex-fixed", { modelId: PLAN_GATED_CODEX_MODEL })).toBe(
			"access-first",
		);
	});

	test("fixed: a plan-gated Codex request skips a first account whose plan is ineligible", async () => {
		// Regression: fixed selection stops consulting plan tiers and sends a
		// paid-only model to a free account, which the provider rejects.
		mockOAuthRefresh();
		const reports = new Map<string, UsageReport>([
			["acc-first", codexUsage("acc-first", 0.1, "free")],
			["acc-second", codexUsage("acc-second", 0.1, "plus")],
		]);
		const storage = openStorage("fixed", codexUsageProvider(reports));
		await seedTwoCodexAccounts(storage);

		expect(await storage.getApiKey(CODEX_PROVIDER, "codex-fixed-plan", { modelId: PLAN_GATED_CODEX_MODEL })).toBe(
			"access-second",
		);
	});

	const SHORT_BLOCK_MS = 20;

	test("balanced (default) keeps a session on the sibling it fell through to after the primary unblocks", async () => {
		// Negative contract for the fixed test below: warm-cache stickiness is the
		// documented balanced behaviour and must not silently change.
		mockOAuthRefresh();
		const storage = openStorage();
		await seedThreeOAuthAccounts(storage);
		expect(await resolveEmail(storage, "sticky-session")).toBe("a@example.com");
		await storage.markUsageLimitReached(OAUTH_PROVIDER, "sticky-session", { retryAfterMs: SHORT_BLOCK_MS });
		expect(await resolveEmail(storage, "sticky-session")).toBe("b@example.com");

		await Bun.sleep(SHORT_BLOCK_MS * 3);

		expect(await resolveEmail(storage, "sticky-session")).toBe("b@example.com");
	});

	test("fixed: a session that fell through to a sibling returns to the first account once it unblocks", async () => {
		// Regression: automatic stickiness keeps the session on the backup account
		// forever, so "always use the first account" only holds for new sessions.
		mockOAuthRefresh();
		const storage = openStorage("fixed");
		await seedThreeOAuthAccounts(storage);
		expect(await resolveEmail(storage, "recovering-session")).toBe("a@example.com");
		await storage.markUsageLimitReached(OAUTH_PROVIDER, "recovering-session", { retryAfterMs: SHORT_BLOCK_MS });
		expect(await resolveEmail(storage, "recovering-session")).toBe("b@example.com");

		await Bun.sleep(SHORT_BLOCK_MS * 3);

		expect(await resolveEmail(storage, "recovering-session")).toBe("a@example.com");
	});

	test("fixed: an explicit session pin still wins, survives resolves and restarts, but a restored pin yields", async () => {
		// Regression: `/session pin` becomes a no-op under fixed selection, or a
		// resumed session's replayed sticky keeps it off the first account.
		mockOAuthRefresh();
		const credentialStore = store;
		if (!credentialStore) throw new Error("test setup failed");
		const storage = openStorage("fixed");
		await seedThreeOAuthAccounts(storage);
		const second = storage.listOAuthAccounts(OAUTH_PROVIDER)[1];
		if (!second) throw new Error("expected second OAuth account");

		expect(storage.pinSessionOAuthAccount(OAUTH_PROVIDER, "user-pin", second.credentialId)).toBe(true);
		expect(await resolveEmail(storage, "user-pin")).toBe("b@example.com");
		expect(await resolveEmail(storage, "user-pin")).toBe("b@example.com");

		const restarted = new AuthStorage(credentialStore, { accountSelection: "fixed" });
		await restarted.reload();
		expect(await resolveEmail(restarted, "user-pin")).toBe("b@example.com");

		expect(
			restarted.pinSessionOAuthAccount(OAUTH_PROVIDER, "resumed", second.credentialId, { origin: "restore" }),
		).toBe(true);
		expect(await resolveEmail(restarted, "resumed")).toBe("a@example.com");
	});

	test("fixed: a tier-scoped rate-limit block on the first API key falls through for that tier only", async () => {
		// Regression: fixed API-key selection ignores scoped blocks, so the gateway
		// retry after a Fable 429 receives the same blocked key again.
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);
		const storage = openStorage("fixed");
		await storage.set("anthropic", [
			{ type: "api_key", key: "sk-first", source: "login" },
			{ type: "api_key", key: "sk-second", source: "login" },
		]);
		expect(await storage.getApiKey("anthropic", "fable-session", { modelId: "claude-fable-5" })).toBe("sk-first");

		await storage.markUsageLimitReached("anthropic", "fable-session", { modelId: "claude-fable-5" });

		expect(await storage.getApiKey("anthropic", "fable-retry", { modelId: "claude-fable-5" })).toBe("sk-second");
		expect(await storage.getApiKey("anthropic", "sonnet-session", { modelId: "claude-sonnet-4-5" })).toBe("sk-first");
	});

	test("setAccountSelection switches the policy for subsequent lookups", async () => {
		// Regression: the settings layer (config overlays) can no longer override
		// what discovery read from config.yml.
		mockOAuthRefresh();
		const storage = openStorage();
		await seedThreeOAuthAccounts(storage);
		expect([await storage.getApiKey(OAUTH_PROVIDER), await storage.getApiKey(OAUTH_PROVIDER)]).toEqual([
			"access-a",
			"access-b",
		]);

		storage.setAccountSelection("fixed");

		expect(storage.accountSelection).toBe("fixed");
		expect([await storage.getApiKey(OAUTH_PROVIDER), await storage.getApiKey(OAUTH_PROVIDER)]).toEqual([
			"access-a",
			"access-a",
		]);
	});
});
