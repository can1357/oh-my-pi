import { describe, expect, it } from "bun:test";
import { type AuthCredentialStore, AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageFetchParams, UsageProvider } from "@oh-my-pi/pi-ai/usage";
import { withEnv } from "./helpers";

function makeStore(credentials: StoredAuthCredential[] = []): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials() {
			return credentials;
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return [];
		},
		upsertAuthCredentialForProvider() {
			return [];
		},
		deleteAuthCredentialsForProvider() {},
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
			await storage.reload();

			await storage.fetchUsageReports();
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
			await storage.reload();

			await storage.fetchUsageReports();
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
			await storage.reload();

			await storage.fetchUsageReports();
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
			await storage.reload();

			await storage.fetchUsageReports();
		});

		expect(calls).toEqual([]);
	});
});
