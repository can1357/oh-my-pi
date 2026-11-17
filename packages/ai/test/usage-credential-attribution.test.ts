/**
 * Usage report credential attribution (#19456): every report probed from a
 * stored credential row must carry that row's durable id in
 * `metadata.credentialId`, including API-key rows, so account-scoped consumers
 * (the status-line usage segment) can attribute quota to the account the
 * session router actually serves from instead of merging sibling accounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

/** Minimal in-memory AuthCredentialStore (same shape as the usage-cache tests). */
function makeStore(rows: StoredAuthCredential[]): AuthCredentialStore & { cache: Map<string, CacheEntry> } {
	const cache = new Map<string, CacheEntry>();
	return {
		cache,
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		async replaceAuthCredentials() {
			return rows;
		},
		async upsertAuthCredential() {
			return rows;
		},
		async deleteAuthCredentials() {},
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
	};
}

function apiKeyRow(id: number, key: string, provider = "anthropic"): StoredAuthCredential {
	const credential: AuthCredential = { type: "api_key", key };
	return { id, provider, credential, disabledCause: null };
}

function oauthRow(id: number, provider: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
	};
	return { id, provider, credential, disabledCause: null };
}

function apiReport(account: string, provider: UsageReport["provider"] = "anthropic"): UsageReport {
	const limit: UsageLimit = {
		id: `${provider}:5h:${account}`,
		label: "5 Hour",
		scope: { provider, windowId: "5h", accountId: account },
		window: { id: "5h", label: "5 Hour" },
		amount: { usedFraction: 0.42, unit: "percent" },
		status: "ok",
	};
	return {
		provider,
		fetchedAt: Date.now(),
		limits: [limit],
		metadata: { accountId: account },
	};
}

describe("usage reports carry the probing credential's row id", () => {
	let storage: AuthStorage;

	beforeEach(async () => {
		const store = makeStore([apiKeyRow(2, "sk-account-two"), apiKeyRow(4, "sk-account-four")]);
		// A permissive usage provider that answers each probe with the account
		// named by the probing key; keeps the pass off the network.
		const provider: UsageProvider = {
			...claudeUsage.claudeUsageProvider,
			supports: () => true,
			async fetchUsage(request) {
				const apiKey = request.credential.type === "api_key" ? request.credential.apiKey : undefined;
				return apiReport(apiKey?.slice(3) ?? "unknown");
			},
		};
		storage = new AuthStorage(store, {
			usageProviderResolver: candidate => (candidate === "anthropic" ? provider : undefined),
		});
		await storage.credentials.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("tags each stored-row report with metadata.credentialId", async () => {
		const reports = (await storage.usage.reports()) ?? [];
		const anthropic = reports.filter(report => report.provider === "anthropic");
		expect(anthropic).toHaveLength(2);

		const byAccount = new Map(anthropic.map(report => [report.metadata?.accountId, report.metadata?.credentialId]));
		// The report probed with row 2's key is row 2's report, and likewise
		// for row 4 — the row id is what ties an API-key report to the account
		// the session router serves from.
		expect(byAccount.get("account-two")).toBe(2);
		expect(byAccount.get("account-four")).toBe(4);
	});
});

describe("usage reports carry every row id across same-account deduplication", () => {
	let storage: AuthStorage;

	beforeEach(async () => {
		// Same-account duplicates are a supported pool shape (API-key rows are
		// not pruned): two stored keys for one account merge into one report,
		// which must still match a pin on either row.
		const store = makeStore([apiKeyRow(2, "sk-shared"), apiKeyRow(4, "sk-also-shared")]);
		const provider: UsageProvider = {
			...claudeUsage.claudeUsageProvider,
			supports: () => true,
			async fetchUsage(request) {
				const apiKey = request.credential.type === "api_key" ? request.credential.apiKey : undefined;
				return apiReport(apiKey === "sk-shared" || apiKey === "sk-also-shared" ? "shared" : "unknown");
			},
		};
		storage = new AuthStorage(store, {
			usageProviderResolver: candidate => (candidate === "anthropic" ? provider : undefined),
		});
		await storage.credentials.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("merges same-account rows while keeping every contributing credentialId", async () => {
		const reports = (await storage.usage.reports()) ?? [];
		const anthropic = reports.filter(report => report.provider === "anthropic");
		expect(anthropic).toHaveLength(1);
		expect(anthropic[0]?.metadata?.credentialIds).toEqual([2, 4]);
	});
});

describe("usage reports carry the row id on the oauthTokenEnv path", () => {
	let storage: AuthStorage;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(async () => {
		// The stored-OAuth branch only runs when the provider's OAuth env
		// bearer is absent; xai-oauth declares XAI_OAUTH_TOKEN.
		savedEnv = {};
		for (const name of ["XAI_OAUTH_TOKEN", "XAI_API_KEY", "ANTHROPIC_API_KEY"]) {
			savedEnv[name] = process.env[name];
			delete process.env[name];
		}
		const store = makeStore([oauthRow(2, "xai-oauth"), oauthRow(4, "xai-oauth")]);
		const provider: UsageProvider = {
			...claudeUsage.claudeUsageProvider,
			supports: () => true,
			async fetchUsage(request) {
				return apiReport(`oauth-${request.credential.accountId ?? "x"}`, "xai-oauth");
			},
		};
		storage = new AuthStorage(store, {
			usageProviderResolver: candidate => (candidate === "xai-oauth" ? provider : undefined),
		});
		await storage.credentials.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("tags stored OAuth probes from the oauthTokenEnv branch", async () => {
		const reports = (await storage.usage.reports()) ?? [];
		const tagged = reports
			.filter(report => report.provider === "xai-oauth")
			.map(report => report.metadata?.credentialId)
			.sort((a, b) => ((a as number) ?? 0) - ((b as number) ?? 0));
		expect(tagged).toEqual([2, 4]);
	});
});

describe("sessions.sticky attribution gating", () => {
	let storage: AuthStorage;

	beforeEach(async () => {
		const store = makeStore([apiKeyRow(2, "sk-account-two")]);
		storage = new AuthStorage(store, {});
		await storage.credentials.reload();
	});

	afterEach(() => {
		storage.close();
		delete process.env.ANTHROPIC_API_KEY;
		vi.restoreAllMocks();
	});

	it("reports the stored row the session resolved, and nothing once an env key takes over", async () => {
		const sessionId = "status-line-test-session";
		// Serving the stored API key records the session's affinity to row 2.
		await storage.keys.get("anthropic", sessionId);
		expect(storage.sessions.sticky?.("anthropic", sessionId)?.credentialId).toBe(2);

		// A later env override is served ahead of the pool (or takes over once
		// the stored row is unusable — the env branch forgets only the
		// in-memory pin). The persisted row must not be attributed either way.
		process.env.ANTHROPIC_API_KEY = "sk-env-override";
		expect(storage.sessions.sticky?.("anthropic", sessionId)).toBeUndefined();
	});
});
