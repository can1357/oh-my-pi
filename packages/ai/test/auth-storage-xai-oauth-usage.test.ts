import { describe, expect, it } from "bun:test";
import { type AuthCredentialStore, AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageFetchParams, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { defaultRankingStrategy } from "../src/usage/registry";
import { withEnv } from "./helpers";

function makeStore(credentials: StoredAuthCredential[] = []): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials() {
			return credentials;
		},
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		async replaceAuthCredentials() {
			return [];
		},
		async upsertAuthCredential() {
			return [];
		},
		async deleteAuthCredentials() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry || entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function captureUsageProvider(calls: UsageFetchParams[]): UsageProvider {
	return {
		id: "xai-oauth",
		supports: params => params.credential.type === "oauth" && !!params.credential.accessToken,
		async fetchUsage(params) {
			calls.push(params);
			return {
				provider: "xai-oauth",
				fetchedAt: Date.now(),
				limits: [],
			};
		},
	};
}

describe("xAI OAuth environment usage", () => {
	it("treats dedicated XAI_OAUTH_TOKEN as an OAuth bearer for SuperGrok usage", async () => {
		const calls: UsageFetchParams[] = [];
		await withEnv({ XAI_OAUTH_TOKEN: "oauth-bearer", XAI_API_KEY: undefined }, async () => {
			const storage = new AuthStorage(makeStore(), {
				usageProviderResolver: provider => (provider === "xai-oauth" ? captureUsageProvider(calls) : undefined),
			});
			await storage.credentials.reload();

			await storage.usage.reports();
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.credential).toEqual({ type: "oauth", accessToken: "oauth-bearer" });
	});

	it("prefers stored OAuth credentials to XAI_OAUTH_TOKEN", async () => {
		const calls: UsageFetchParams[] = [];
		await withEnv({ XAI_OAUTH_TOKEN: "env-oauth-bearer" }, async () => {
			const storage = new AuthStorage(
				makeStore([
					{
						id: 1,
						provider: "xai-oauth",
						credential: {
							type: "oauth",
							access: "stored-oauth-bearer",
							refresh: "stored-refresh-token",
							expires: Date.now() + 3_600_000,
						},
						disabledCause: null,
					},
				]),
				{
					usageProviderResolver: provider => (provider === "xai-oauth" ? captureUsageProvider(calls) : undefined),
				},
			);
			await storage.credentials.reload();

			await storage.usage.reports();
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.credential).toEqual({
			type: "oauth",
			accessToken: "stored-oauth-bearer",
			refreshToken: "stored-refresh-token",
			expiresAt: expect.any(Number),
		});
	});

	it("uses XAI_OAUTH_TOKEN when stored xAI credentials contain only an API key", async () => {
		const calls: UsageFetchParams[] = [];
		await withEnv({ XAI_OAUTH_TOKEN: "env-oauth-bearer" }, async () => {
			const storage = new AuthStorage(
				makeStore([
					{
						id: 1,
						provider: "xai-oauth",
						credential: {
							type: "api_key",
							key: "stored-api-key",
						},
						disabledCause: null,
					},
				]),
				{
					usageProviderResolver: provider => (provider === "xai-oauth" ? captureUsageProvider(calls) : undefined),
				},
			);
			await storage.credentials.reload();

			await storage.usage.reports();
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.credential).toEqual({ type: "oauth", accessToken: "env-oauth-bearer" });
	});

	it("does not send shared XAI_API_KEY to the SuperGrok usage endpoint", async () => {
		const calls: UsageFetchParams[] = [];
		await withEnv({ XAI_OAUTH_TOKEN: undefined, XAI_API_KEY: "paid-api-key" }, async () => {
			const storage = new AuthStorage(makeStore(), {
				usageProviderResolver: provider => (provider === "xai-oauth" ? captureUsageProvider(calls) : undefined),
			});
			await storage.credentials.reload();

			await storage.usage.reports();
		});

		expect(calls).toEqual([]);
	});

	it("ranks xai-oauth accounts by weekly drain rate", async () => {
		const now = Date.now();
		const hourMs = 60 * 60 * 1000;
		const strategy = defaultRankingStrategy("xai-oauth");
		expect(strategy).toBeDefined();

		const urgentReport: UsageReport = {
			provider: "xai-oauth",
			fetchedAt: now,
			limits: [
				{
					id: "xai-oauth:credits:1w",
					label: "SuperGrok Weekly Credits",
					scope: { provider: "xai-oauth", windowId: "1w", shared: true },
					window: { id: "1w", label: "Weekly", durationMs: 7 * 24 * hourMs, resetsAt: now + 12 * hourMs },
					amount: { usedFraction: 0.2, unit: "percent" },
					status: "ok",
				},
			],
		};

		const relaxedReport: UsageReport = {
			provider: "xai-oauth",
			fetchedAt: now,
			limits: [
				{
					id: "xai-oauth:credits:1w",
					label: "SuperGrok Weekly Credits",
					scope: { provider: "xai-oauth", windowId: "1w", shared: true },
					window: { id: "1w", label: "Weekly", durationMs: 7 * 24 * hourMs, resetsAt: now + 4 * 24 * hourMs },
					amount: { usedFraction: 0.2, unit: "percent" },
					status: "ok",
				},
			],
		};

		const urgentWindows = strategy!.findWindowLimits(urgentReport);
		const relaxedWindows = strategy!.findWindowLimits(relaxedReport);
		expect(urgentWindows.secondary?.id).toBe("xai-oauth:credits:1w");
		expect(relaxedWindows.secondary?.id).toBe("xai-oauth:credits:1w");

		const storage = new AuthStorage(
			makeStore([
				{
					id: 1,
					provider: "xai-oauth",
					credential: {
						type: "oauth",
						access: "token-relaxed",
						refresh: "r2",
						expires: now + 3600000,
						accountId: "acct-relaxed",
					},
					disabledCause: null,
				},
				{
					id: 2,
					provider: "xai-oauth",
					credential: {
						type: "oauth",
						access: "token-urgent",
						refresh: "r1",
						expires: now + 3600000,
						accountId: "acct-urgent",
					},
					disabledCause: null,
				},
			]),
			{
				usageProviderResolver: () => ({
					id: "xai-oauth",
					supports: () => true,
					async fetchUsage(params) {
						if (params.credential.type === "oauth" && params.credential.accessToken === "token-urgent") {
							return urgentReport;
						}
						return relaxedReport;
					},
				}),
			},
		);
		await storage.credentials.reload();

		const selectedKey = await storage.keys.get("xai-oauth", "test-new-session");
		expect(selectedKey).toBe("token-urgent");
	});

	it("isolates gating meters in scopeLimits and falls back to monthly included credits", () => {
		const strategy = defaultRankingStrategy("xai-oauth");
		expect(strategy).toBeDefined();
		expect(strategy!.scopeLimits).toBeDefined();

		const mixedReport: UsageReport = {
			provider: "xai-oauth",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "xai-oauth:credits:1w",
					label: "Weekly Credits",
					scope: { provider: "xai-oauth" },
					amount: { usedFraction: 0.1, unit: "percent" },
				},
				{
					id: "xai-oauth:product:grokbuild:1w",
					label: "Grok Build (Weekly)",
					scope: { provider: "xai-oauth" },
					amount: { usedFraction: 1.0, unit: "percent" },
					status: "exhausted",
				},
				{
					id: "xai-oauth:on-demand:1mo",
					label: "On-Demand Cap",
					scope: { provider: "xai-oauth" },
					amount: { usedFraction: 1.0, unit: "usd" },
					status: "exhausted",
				},
			],
		};

		const scoped = strategy!.scopeLimits!(mixedReport);
		expect(scoped).toHaveLength(1);
		expect(scoped[0]?.id).toBe("xai-oauth:credits:1w");

		const monthlyReport: UsageReport = {
			provider: "xai-oauth",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "xai-oauth:included:1mo",
					label: "Monthly Included",
					scope: { provider: "xai-oauth", windowId: "1mo" },
					amount: { usedFraction: 0.5, unit: "unknown" },
				},
			],
		};
		const windows = strategy!.findWindowLimits(monthlyReport);
		expect(windows.secondary?.id).toBe("xai-oauth:included:1mo");
	});
});
