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

function apiKeyRow(id: number, key: string): StoredAuthCredential {
	const credential: AuthCredential = { type: "api_key", key };
	return { id, provider: "anthropic", credential, disabledCause: null };
}

function apiReport(account: string): UsageReport {
	const limit: UsageLimit = {
		id: `anthropic:5h:${account}`,
		label: "5 Hour",
		scope: { provider: "anthropic", windowId: "5h", accountId: account },
		window: { id: "5h", label: "5 Hour" },
		amount: { usedFraction: 0.42, unit: "percent" },
		status: "ok",
	};
	return {
		provider: "anthropic",
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
