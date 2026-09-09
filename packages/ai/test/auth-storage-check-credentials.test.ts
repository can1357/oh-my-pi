/**
 * Tests for `AuthStorage.checkCredentials()` — the per-credential auth probe
 * that powers `omp auth-gateway check`. Contract under test:
 *
 *   1. A working credential reports `ok: true` and surfaces the probe's
 *      `email`/`accountId` (so the user can identify the row).
 *   2. A throwing provider probe reports `ok: false` with the error message
 *      in `reason` (so a 401 from upstream propagates as the diagnosis).
 *   3. A null probe (provider deliberately declined) reports `ok: null` with
 *      a "no data" reason — distinct from a failure.
 *   4. Expired OAuth credentials get refreshed before the probe; a failing
 *      refresh short-circuits to `ok: false` with `oauth refresh failed: …`
 *      WITHOUT calling the usage provider (the access token can't be valid
 *      when refresh is broken).
 *   5. Providers with no registered `UsageProvider` report `ok: null` with
 *      "no usage probe configured" — the credential's status is unknown,
 *      not failed.
 *   6. Local-only usage providers opt out of health validation and leave
 *      `ok: null` unless a separate completion probe is supplied.
 *   7. When a `completionProbe` is supplied, it receives the post-refresh
 *      bearer for every row, runs independently of the usage probe (i.e. it
 *      still runs for providers without a validating `UsageProvider`), but is
 *      skipped when OAuth refresh fails.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type CompletionProbe,
	type CompletionProbeInput,
	REMOTE_REFRESH_SENTINEL,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";
import { ollamaCloudUsageProvider } from "@oh-my-pi/pi-ai/usage/ollama";

function oauthRow(id: number, email: string, opts?: { expired?: boolean }): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: opts?.expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

function makeStore(
	rows: StoredAuthCredential[],
	refresh?: AuthCredentialStore["refreshOAuthCredential"],
): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
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
		cleanExpiredCache() {},
		...(refresh ? { refreshOAuthCredential: refresh } : {}),
	};
}

describe("AuthStorage.checkCredentials", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports ok=true and surfaces probe identity for a healthy credential", async () => {
		const store = makeStore([oauthRow(1, "alice@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue({
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "alice@example.com", accountId: "account-1" },
		});

		try {
			const [result] = await storage.checkCredentials();
			expect(result).toMatchObject({
				id: 1,
				provider: "anthropic",
				type: "oauth",
				email: "alice@example.com",
				accountId: "account-1",
				ok: true,
			});
			expect(result.reason).toBeUndefined();
			expect(result.report).toBeDefined();
		} finally {
			storage.close();
		}
	});

	it("reports ok=false with the upstream error when the probe throws", async () => {
		const store = makeStore([oauthRow(7, "bob@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockRejectedValue(
			new Error("401 Invalid authentication credentials"),
		);

		try {
			const [result] = await storage.checkCredentials();
			expect(result.id).toBe(7);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("401");
			expect(result.reason).toContain("Invalid authentication");
			// Identity from the stored credential still surfaces so the user
			// can locate the broken row.
			expect(result.email).toBe("bob@example.com");
			expect(result.accountId).toBe("account-7");
		} finally {
			storage.close();
		}
	});

	it("reports ok=null with a no-data reason when the probe returns null", async () => {
		const store = makeStore([oauthRow(2, "carol@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);

		try {
			const [result] = await storage.checkCredentials();
			expect(result.ok).toBeNull();
			expect(result.reason).toMatch(/no data/);
		} finally {
			storage.close();
		}
	});

	it("short-circuits to ok=false when OAuth refresh fails on an expired credential", async () => {
		const refreshSpy = vi
			.fn<NonNullable<AuthCredentialStore["refreshOAuthCredential"]>>()
			.mockRejectedValue(new Error("invalid_grant: refresh token revoked"));
		const store = makeStore([oauthRow(3, "dave@example.com", { expired: true })], refreshSpy);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		const probe = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage");

		try {
			const [result] = await storage.checkCredentials();
			expect(result.ok).toBe(false);
			expect(result.reason).toMatch(/oauth refresh failed/);
			expect(result.reason).toContain("invalid_grant");
			// Probe MUST NOT run when refresh is broken — the access token
			// can't be valid in that state and we'd be calling the upstream
			// with a stale credential for no reason.
			expect(probe).not.toHaveBeenCalled();
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		} finally {
			storage.close();
		}
	});

	it("reports ok=null when no usage probe is configured for the provider", async () => {
		const apiKeyRow: StoredAuthCredential = {
			id: 9,
			provider: "made-up-provider",
			credential: { type: "api_key", key: "secret-key" },
			disabledCause: null,
		};
		const store = makeStore([apiKeyRow]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
		});
		await storage.reload();

		try {
			const [result] = await storage.checkCredentials();
			expect(result).toMatchObject({
				id: 9,
				provider: "made-up-provider",
				type: "api_key",
				ok: null,
			});
			expect(result.reason).toMatch(/no usage probe configured/);
		} finally {
			storage.close();
		}
	});

	it("returns per-credential results preserving order and identity across a mixed batch", async () => {
		const store = makeStore([
			oauthRow(1, "alpha@example.com"),
			oauthRow(2, "beta@example.com"),
			oauthRow(3, "gamma@example.com"),
		]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const token = params.credential.accessToken;
			if (token === "oat-1") {
				return {
					provider: "anthropic",
					fetchedAt: Date.now(),
					limits: [],
					metadata: { email: "alpha@example.com", accountId: "account-1" },
				};
			}
			if (token === "oat-2") {
				throw new Error("401 Invalid authentication credentials");
			}
			return null;
		});

		try {
			const results = await storage.checkCredentials();
			expect(results.map(r => ({ id: r.id, ok: r.ok }))).toEqual([
				{ id: 1, ok: true },
				{ id: 2, ok: false },
				{ id: 3, ok: null },
			]);
			expect(results[1].reason).toContain("Invalid authentication");
			// Every row keeps its stored-credential identity even when the probe
			// failed (the second one) or returned no data (the third one).
			expect(results[1].email).toBe("beta@example.com");
			expect(results[2].email).toBe("gamma@example.com");
		} finally {
			storage.close();
		}
	});

	it("invokes the completionProbe with the post-refresh OAuth bearer", async () => {
		const refreshed = {
			access: "oat-refreshed",
			refresh: "refresh-refreshed",
			expires: Date.now() + 3_600_000,
			accountId: "account-3-refreshed",
			email: "dave@example.com",
		};
		const refreshSpy = vi
			.fn<NonNullable<AuthCredentialStore["refreshOAuthCredential"]>>()
			.mockResolvedValue(refreshed);
		const store = makeStore([oauthRow(3, "dave@example.com", { expired: true })], refreshSpy);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue({
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [],
			metadata: {},
		});

		const seen: CompletionProbeInput[] = [];
		const probe: CompletionProbe = async input => {
			seen.push(input);
			return { ok: true, modelId: "test-probe-model", latencyMs: 42 };
		};

		try {
			const [result] = await storage.checkCredentials({ completionProbe: probe });
			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(seen).toHaveLength(1);
			const input = seen[0];
			expect(input.provider).toBe("anthropic");
			expect(input.credentialId).toBe(3);
			// Probe MUST see the refreshed access token, not the stale one stored
			// on the row — otherwise downstream chat calls send a dead bearer.
			expect(input.credential.type).toBe("oauth");
			if (input.credential.type === "oauth") {
				expect(input.credential.accessToken).toBe("oat-refreshed");
				expect(input.credential.email).toBe("dave@example.com");
			}
			expect(result.completion).toEqual({ ok: true, modelId: "test-probe-model", latencyMs: 42 });
			expect(result.ok).toBe(true); // usage probe independently succeeded
		} finally {
			storage.close();
		}
	});

	it("persists Copilot API endpoint after usage refresh", async () => {
		const apiEndpoint = "https://api.business.githubcopilot.com";
		const row: StoredAuthCredential = {
			id: 8,
			provider: "github-copilot",
			credential: {
				type: "oauth",
				access: "oat-business",
				refresh: "refresh-business",
				expires: Date.now() - 60_000,
				accountId: "account-business",
				email: "business@example.com",
				apiEndpoint,
			},
			disabledCause: null,
		};
		const refreshSpy = vi.fn<NonNullable<AuthCredentialStore["refreshOAuthCredential"]>>().mockResolvedValue({
			access: "oat-business-refreshed",
			refresh: "refresh-business-refreshed",
			expires: Date.now() + 3_600_000,
			accountId: "account-business",
			email: "business@example.com",
		});
		const store = makeStore([row], refreshSpy);
		const updatedCredentials: AuthCredential[] = [];
		vi.spyOn(store, "updateAuthCredential").mockImplementation((_id, credential) => {
			updatedCredentials.push(credential);
		});
		const usageProvider: UsageProvider = {
			id: "github-copilot",
			async fetchUsage(params) {
				expect(params.credential.apiEndpoint).toBe(apiEndpoint);
				return {
					provider: "github-copilot",
					fetchedAt: Date.now(),
					limits: [],
					metadata: {},
				};
			},
		};
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? usageProvider : undefined),
		});
		await storage.reload();

		try {
			const [result] = await storage.checkCredentials();
			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(result.ok).toBe(true);
			expect(updatedCredentials).toHaveLength(1);
			const updated = updatedCredentials[0];
			expect(updated?.type).toBe("oauth");
			if (updated?.type !== "oauth") throw new Error("expected OAuth credential update");
			expect(updated.apiEndpoint).toBe(apiEndpoint);
		} finally {
			storage.close();
		}
	});

	it("runs the completionProbe even when no usage probe is configured for the provider", async () => {
		const apiKeyRow: StoredAuthCredential = {
			id: 11,
			provider: "made-up-provider",
			credential: { type: "api_key", key: "sk-test-key" },
			disabledCause: null,
		};
		const store = makeStore([apiKeyRow]);
		const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.reload();

		const probe = vi.fn<CompletionProbe>().mockResolvedValue({ ok: false, reason: "401 invalid_api_key" });

		try {
			const [result] = await storage.checkCredentials({ completionProbe: probe });
			expect(probe).toHaveBeenCalledTimes(1);
			const [input] = probe.mock.calls[0];
			expect(input.credential).toEqual({ type: "api_key", apiKey: "sk-test-key" });
			// Usage `ok` stays null (no usage probe configured) but the completion
			// probe surfaces the real failure.
			expect(result.ok).toBeNull();
			expect(result.reason).toMatch(/no usage probe configured/);
			expect(result.completion).toEqual({ ok: false, reason: "401 invalid_api_key" });
		} finally {
			storage.close();
		}
	});

	it("does not mark local-only usage providers healthy without upstream validation", async () => {
		const apiKeyRow: StoredAuthCredential = {
			id: 12,
			provider: "ollama-cloud",
			credential: { type: "api_key", key: "sk-ollama-cloud" },
			disabledCause: null,
		};
		const store = makeStore([apiKeyRow]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "ollama-cloud" ? ollamaCloudUsageProvider : undefined),
		});
		await storage.reload();

		const probe = vi.fn<CompletionProbe>().mockResolvedValue({ ok: false, reason: "401 invalid_api_key" });

		try {
			const [result] = await storage.checkCredentials({ completionProbe: probe });
			expect(result.ok).toBeNull();
			expect(result.reason).toMatch(/does not validate credentials/);
			expect(result.report).toBeUndefined();
			expect(probe).toHaveBeenCalledTimes(1);
			expect(result.completion).toEqual({ ok: false, reason: "401 invalid_api_key" });
		} finally {
			storage.close();
		}
	});

	it("skips the completionProbe when OAuth refresh fails", async () => {
		const refreshSpy = vi
			.fn<NonNullable<AuthCredentialStore["refreshOAuthCredential"]>>()
			.mockRejectedValue(new Error("invalid_grant: refresh token revoked"));
		const store = makeStore([oauthRow(5, "eve@example.com", { expired: true })], refreshSpy);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		const probe = vi.fn<CompletionProbe>().mockResolvedValue({ ok: true });

		try {
			const [result] = await storage.checkCredentials({ completionProbe: probe });
			expect(result.ok).toBe(false);
			expect(result.reason).toMatch(/oauth refresh failed/);
			// A dead refresh means the stored access token is unusable, so the
			// strict probe MUST NOT be called with stale bytes — that would
			// either spuriously fail or, worse, succeed against a revoked
			// credential and mask the upstream failure.
			expect(probe).not.toHaveBeenCalled();
			expect(result.completion).toBeUndefined();
		} finally {
			storage.close();
		}
	});

	it("captures exceptions thrown by the completionProbe into completion.reason", async () => {
		const store = makeStore([oauthRow(7, "frank@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue({
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [],
			metadata: {},
		});

		const probe: CompletionProbe = async () => {
			throw new Error("network ECONNRESET");
		};

		try {
			const [result] = await storage.checkCredentials({ completionProbe: probe });
			expect(result.ok).toBe(true); // usage probe independently succeeded
			expect(result.completion?.ok).toBe(false);
			expect(result.completion?.reason).toContain("ECONNRESET");
		} finally {
			storage.close();
		}
	});

	it("surfaces REMOTE_REFRESH_SENTINEL on credentials whose refresh token lives behind a broker", async () => {
		const remoteRow: StoredAuthCredential = {
			id: 13,
			provider: "anthropic",
			credential: {
				type: "oauth",
				access: "oat-13",
				refresh: REMOTE_REFRESH_SENTINEL,
				expires: Date.now() + 3_600_000,
				accountId: "account-13",
				email: "remote@example.com",
			},
			disabledCause: null,
		};
		const store = makeStore([remoteRow]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue({
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [],
			metadata: {},
		});

		const probe = vi.fn<CompletionProbe>().mockResolvedValue({ ok: true });
		try {
			const [result] = await storage.checkCredentials({ completionProbe: probe });
			expect(result.remoteRefresh).toBe(true);
			const [input] = probe.mock.calls[0];
			expect(input.credential.type).toBe("oauth");
			if (input.credential.type === "oauth") {
				// Sentinel forwards verbatim so callers composing structured
				// apiKeys (Copilot, Gemini CLI) don't have to special-case it.
				expect(input.credential.refreshToken).toBe(REMOTE_REFRESH_SENTINEL);
				expect(input.credential.accessToken).toBe("oat-13");
			}
		} finally {
			storage.close();
		}
	});

	it("probes reference-stored API keys with the resolved secret", async () => {
		// Keys stored as references (env var name, "!command") must reach the
		// usage probe as the resolved secret — probing with the literal
		// reference string would 401 and flag a working credential as bad.
		const apiKeyRow: StoredAuthCredential = {
			id: 21,
			provider: "opencode-go",
			credential: { type: "api_key", key: "ref:opencode" },
			disabledCause: null,
		};
		const seenKeys: Array<string | undefined> = [];
		const probeProvider: UsageProvider = {
			id: "opencode-go",
			validatesCredentials: true,
			async fetchUsage(params) {
				seenKeys.push(params.credential.type === "api_key" ? params.credential.apiKey : undefined);
				return { provider: "opencode-go", fetchedAt: Date.now(), limits: [] };
			},
		};
		const storage = new AuthStorage(makeStore([apiKeyRow]), {
			usageProviderResolver: provider => (provider === "opencode-go" ? probeProvider : undefined),
			configValueResolver: async config => (config === "ref:opencode" ? "sk-resolved-secret" : config),
		});
		await storage.reload();

		try {
			const [result] = await storage.checkCredentials();
			expect(seenKeys).toEqual(["sk-resolved-secret"]);
			expect(result.ok).toBe(true);
		} finally {
			storage.close();
		}
	});
});
