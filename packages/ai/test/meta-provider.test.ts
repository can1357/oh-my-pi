import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { describe, expect, test, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { refreshMetaMuseToken } from "@oh-my-pi/pi-ai/registry/oauth/meta-muse";
import { loginMeta, metaProvider } from "@oh-my-pi/pi-ai/registry/meta";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { rpcDefaultAuthMethodFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { META_MUSE_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(reasoning: Effort): Promise<Record<string, unknown>> {
	const model = buildModel(META_MUSE_STATIC_MODELS[0]!) as Model<"openai-responses">;
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAIResponses(model, context, {
		apiKey: "meta-test-key",
		reasoning,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("Meta Model API Responses requests", () => {
	test("sends native xhigh reasoning and requests encrypted replay state", async () => {
		const payload = await capturePayload(Effort.XHigh);
		expect(payload.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
		expect(payload.include).toEqual(["reasoning.encrypted_content"]);
	});

	test("preserves native minimal reasoning without clamping it", async () => {
		const payload = await capturePayload(Effort.Minimal);
		expect(payload.reasoning).toEqual({ effort: "minimal", summary: "auto" });
	});
});

describe("Meta login", () => {
	test("validates pasted keys against the models endpoint without running inference", async () => {
		let requestedUrl = "";
		let authorization = "";
		const prompts = ["2", " meta-test-key "];
		const apiKey = await loginMeta({
			onAuth: () => {},
			onPrompt: async () => prompts.shift() ?? "",
			fetch: (input, init) => {
				requestedUrl = String(input);
				authorization = new Headers(init?.headers).get("Authorization") ?? "";
				return Promise.resolve(Response.json({ data: [{ id: "muse-spark-1.1" }] }));
			},
		});

		expect(apiKey).toBe("meta-test-key");
		expect(requestedUrl).toBe("https://api.meta.ai/v1/models");
		expect(authorization).toBe("Bearer meta-test-key");
	});

	test("accepts a non-interactive Meta login method without prompting for the choice", async () => {
		const apiKey = await loginMeta({
			authMethod: "api-key",
			onAuth: () => {},
			onPrompt: async () => " meta-rpc-key ",
			fetch: () => Promise.resolve(Response.json({ data: [{ id: "muse-spark-1.2" }] })),
		});

		expect(apiKey).toBe("meta-rpc-key");
	});

	test("declares the legacy RPC login default in provider policy", () => {
		expect(rpcDefaultAuthMethodFor("meta")).toBe("api-key");
	});

	test("uses one provider for Muse subscriptions and Model API keys", () => {
		expect(
			getOAuthProviders()
				.filter(provider => provider.id === "meta" || provider.id === "muse-code")
				.map(provider => provider.id),
		).toEqual(["meta"]);
		expect(metaProvider.getApiKey?.({ access: "oauth", refresh: "refresh", expires: 1, apiKey: "minted-key" })).toBe(
			"minted-key",
		);
	});

	test("resolves and rotates subscription-minted keys through AuthStorage", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
		});
		try {
			await storage.reload();
			await storage.set("meta", [
				{
					type: "oauth",
					access: "meta-account-access-a",
					refresh: "meta-account-refresh-a",
					expires: Date.now() + 3_600_000,
					apiKey: "LLM|subscription-key-a",
				},
				{
					type: "oauth",
					access: "meta-account-access-b",
					refresh: "meta-account-refresh-b",
					expires: Date.now() + 3_600_000,
					apiKey: "LLM|subscription-key-b",
				},
			]);
			const sessionId = "muse-session";
			expect(await storage.getApiKey("meta", sessionId)).toBe("LLM|subscription-key-a");
			expect(
				await storage.invalidateCredentialMatching("meta", "LLM|subscription-key-a", {
					sessionId,
				}),
			).toBe(true);
			expect(await storage.getApiKey("meta", sessionId)).toBe("LLM|subscription-key-b");
		} finally {
			storage.close();
		}
	});

	test("falls back to a PAYG login after the preferred Muse subscription exhausts its quota", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
		});
		try {
			await storage.reload();
			await storage.set("meta", [
				{
					type: "api_key",
					key: "LLM|payg-key",
					source: "login",
					authorizedAt: 1,
				},
				{
					type: "oauth",
					access: "meta-account-access",
					refresh: "meta-account-refresh",
					expires: Date.now() + 3_600_000,
					apiKey: "LLM|subscription-key",
					authorizedAt: 2,
				},
			]);
			const sessionId = "muse-quota-fallback";
			expect(await storage.getApiKey("meta", sessionId)).toBe("LLM|subscription-key");

			expect(
				await storage.rotateSessionCredential("meta", sessionId, {
					apiKey: "LLM|subscription-key",
					error: Object.assign(
						new Error('{"error":{"code":"usage_limit_exceeded","message":"usage limit exceeded"}}'),
						{ status: 429 },
					),
				}),
			).toBe(true);
			expect(await storage.getApiKey("meta", sessionId)).toBe("LLM|payg-key");
		} finally {
			storage.close();
		}
	});

	test("falls back to Muse after the preferred PAYG login exhausts its quota", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
		});
		try {
			await storage.reload();
			await storage.set("meta", [
				{
					type: "oauth",
					access: "meta-account-access",
					refresh: "meta-account-refresh",
					expires: Date.now() + 3_600_000,
					apiKey: "LLM|subscription-key",
					authorizedAt: 1,
				},
				{
					type: "api_key",
					key: "LLM|payg-key",
					source: "login",
					authorizedAt: 2,
				},
			]);
			const sessionId = "payg-quota-fallback";
			expect(await storage.getApiKey("meta", sessionId)).toBe("LLM|payg-key");

			expect(
				await storage.rotateSessionCredential("meta", sessionId, {
					apiKey: "LLM|payg-key",
					error: Object.assign(
						new Error('{"error":{"code":"usage_limit_exceeded","message":"usage limit exceeded"}}'),
						{ status: 429 },
					),
				}),
			).toBe(true);
			expect(await storage.getApiKey("meta", sessionId)).toBe("LLM|subscription-key");
		} finally {
			storage.close();
		}
	});

	test("reloads OAuth minted-key and login-recency changes with an unchanged token tuple", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		const now = Date.now();

		try {
			await storage.reload();
			await storage.set("meta", [
				{
					type: "api_key",
					key: "LLM|payg-key",
					source: "login",
					authorizedAt: now,
				},
				{
					type: "oauth",
					access: "meta-account-access",
					refresh: "meta-account-refresh",
					expires: now + 3_600_000,
					apiKey: "LLM|subscription-key",
					accountId: "meta-account",
					authorizedAt: now - 1,
				},
			]);
			expect(await storage.getApiKey("meta", "before-recency-update")).toBe("LLM|payg-key");

			const oauthRow = store.listAuthCredentials("meta").find(row => row.credential.type === "oauth");
			if (!oauthRow || oauthRow.credential.type !== "oauth") throw new Error("expected Meta OAuth row");
			store.updateAuthCredential(oauthRow.id, {
				...oauthRow.credential,
				authorizedAt: now + 1,
			});
			await storage.reload();
			expect(await storage.getApiKey("meta", "after-recency-update")).toBe("LLM|subscription-key");

			store.updateAuthCredential(oauthRow.id, {
				...oauthRow.credential,
				apiKey: "LLM|rotated-subscription-key",
				authorizedAt: now + 1,
			});
			await storage.reload();
			expect(await storage.getApiKey("meta", "after-key-update")).toBe("LLM|rotated-subscription-key");
		} finally {
			storage.close();
		}
	});

	test("refreshes a preferred expired Muse login before exposing an older PAYG key", async () => {
		let refreshCalls = 0;
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
			refreshOAuthCredential: (_provider, _credentialId, credential) => {
				refreshCalls++;
				return Promise.resolve({
					...credential,
					access: "fresh-meta-account-access",
					expires: Date.now() + 3_600_000,
					apiKey: "LLM|fresh-subscription-key",
				});
			},
		});
		try {
			await storage.reload();
			const now = Date.now();
			await storage.set("meta", [
				{
					type: "api_key",
					key: "LLM|older-payg-key",
					source: "login",
					authorizedAt: now - 2_000,
				},
				{
					type: "oauth",
					access: "expired-meta-account-access",
					refresh: "meta-account-refresh",
					expires: now - 1,
					apiKey: "LLM|expired-subscription-key",
					authorizedAt: now - 1_000,
				},
			]);

			expect(await storage.peekApiKey("meta")).toBeUndefined();
			expect(await storage.getApiKey("meta", "discovery")).toBe("LLM|fresh-subscription-key");
			expect(refreshCalls).toBe(1);
		} finally {
			storage.close();
		}
	});

	test("disables an inactive Muse subscription after refresh and falls back to PAYG", async () => {
		let fetchCalls = 0;
		const fetchImpl: FetchImpl = () => {
			fetchCalls++;
			if (fetchCalls === 1) {
				return Promise.resolve(
					Response.json({
						access_token: "refreshed-meta-access",
						refresh_token: "refreshed-meta-refresh",
						expires_in: 3_600,
					}),
				);
			}
			return Promise.resolve(
				Response.json({
					api_key: "LLM|inactive-subscription-key",
					user_id: "meta-account",
					is_subs_active: false,
				}),
			);
		};
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
			refreshOAuthCredential: (_provider, _credentialId, credential) => refreshMetaMuseToken(credential, fetchImpl),
		});
		try {
			await storage.reload();
			await storage.set("meta", [
				{
					type: "api_key",
					key: "LLM|payg-key",
					source: "login",
					authorizedAt: 1,
				},
				{
					type: "oauth",
					access: "expired-meta-access",
					refresh: "meta-refresh",
					expires: 0,
					apiKey: "LLM|stale-subscription-key",
					accountId: "meta-account",
					authorizedAt: 2,
				},
			]);
			const oauth = storage.listStoredCredentials("meta").find(entry => entry.credential.type === "oauth");
			if (!oauth) throw new Error("expected Muse OAuth credential");

			expect(await storage.getApiKey("meta", "inactive-subscription-fallback")).toBe("LLM|payg-key");
			expect(storage.listStoredCredentials("meta").map(entry => entry.credential.type)).toEqual(["api_key"]);
			expect((await storage.listDisabledCredentials("meta")).map(entry => entry.id)).toEqual([oauth.id]);
		} finally {
			storage.close();
		}
	});

	test("persists a rotated Muse grant when its caller cancels during key minting", async () => {
		const keyRequestStarted = Promise.withResolvers<void>();
		const keyResponse = Promise.withResolvers<Response>();
		let fetchCalls = 0;
		const fetchImpl: FetchImpl = (_input, init) => {
			fetchCalls++;
			if (fetchCalls === 1) {
				return Promise.resolve(
					Response.json({
						access_token: "refreshed-meta-access",
						refresh_token: "rotated-meta-refresh",
						expires_in: 3_600,
					}),
				);
			}
			keyRequestStarted.resolve();
			const signal = init?.signal;
			if (!signal) return keyResponse.promise;
			if (signal.aborted) return Promise.reject(signal.reason);
			const aborted = Promise.withResolvers<Response>();
			const onAbort = () => aborted.reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			return Promise.race([keyResponse.promise, aborted.promise]).finally(() => {
				signal.removeEventListener("abort", onAbort);
			});
		};
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
			refreshOAuthCredential: (_provider, _credentialId, credential, signal) =>
				refreshMetaMuseToken(credential, fetchImpl, signal),
		});
		try {
			await storage.reload();
			await storage.set("meta", [
				{
					type: "oauth",
					access: "expired-meta-access",
					refresh: "old-meta-refresh",
					expires: 0,
					apiKey: "LLM|stale-subscription-key",
					accountId: "meta-account",
				},
			]);
			const oauth = storage.listStoredCredentials("meta")[0];
			if (!oauth) throw new Error("expected Muse OAuth credential");
			const controller = new AbortController();
			const cancelledRefresh = storage.forceRefreshCredentialById(oauth.id, controller.signal);
			await keyRequestStarted.promise;

			controller.abort();
			await expect(cancelledRefresh).rejects.toThrow("aborted");

			keyResponse.resolve(
				Response.json({
					api_key: "LLM|fresh-subscription-key",
					user_id: "meta-account",
					is_subs_active: true,
				}),
			);
			await storage.forceRefreshCredentialById(oauth.id);
			expect(storage.listStoredCredentials("meta")[0]?.credential).toMatchObject({
				type: "oauth",
				access: "refreshed-meta-access",
				refresh: "rotated-meta-refresh",
				apiKey: "LLM|fresh-subscription-key",
			});
			expect(fetchCalls).toBe(2);
		} finally {
			storage.close();
		}
	});

	test("persists both Meta login sources and prefers the latest login", async () => {
		using tempDir = TempDir.createSync("@omp-meta-login-");
		const dbPath = tempDir.join("auth.db");
		let storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)), {
			usageProviderResolver: () => undefined,
		});
		const museFetch: FetchImpl = input => {
			const url = String(input);
			if (url.endsWith("/oidc/device/authorization/")) {
				return Promise.resolve(
					Response.json({
						device_code: "device-token",
						user_code: "ABCD-EFGH",
						verification_uri: "https://auth.meta.com/oauth/device/",
						expires_in: 600,
					}),
				);
			}
			if (url.endsWith("/oidc/device/token/")) {
				return Promise.resolve(
					Response.json({ access_token: "meta-account-access", refresh_token: "meta-refresh", expires_in: 3600 }),
				);
			}
			if (url.endsWith("/muse-code/key")) {
				return Promise.resolve(Response.json({ api_key: "LLM|subscription-key", user_id: "meta-account" }));
			}
			return Promise.resolve(Response.json({ data: [{ id: "muse-spark-1.2" }] }));
		};
		const login = async (method: "api-key" | "muse", key?: string): Promise<void> => {
			const prompts = method === "muse" ? ["1"] : ["2", key ?? ""];
			await storage.login("meta", {
				onAuth: () => {},
				onPrompt: async () => prompts.shift() ?? "",
				fetch: museFetch,
			});
		};

		let now = Date.parse("2030-01-01T00:00:00.000Z");
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			await storage.reload();
			now = Date.parse("2030-01-01T00:00:00.000Z");
			await login("api-key", "LLM|payg-key");
			now = Date.parse("2030-01-01T00:00:01.000Z");
			await login("muse");
			expect(
				storage
					.listStoredCredentials("meta")
					.map(row => row.credential.type)
					.sort(),
			).toEqual(["api_key", "oauth"]);
			expect(await storage.getApiKey("meta", "muse-latest")).toBe("LLM|subscription-key");
			expect(storage.isUsingOAuth("meta", "muse-latest")).toBe(true);
			expect(storage.getCredentialOrigin("meta")).toEqual({ kind: "oauth" });
			expect(storage.describeCredentialSource("meta")).toContain("oauth");
			storage.close();

			storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)), {
				usageProviderResolver: () => undefined,
			});
			await storage.reload();
			expect(await storage.getApiKey("meta", "after-restart")).toBe("LLM|subscription-key");
			expect(storage.isUsingOAuth("meta", "after-restart")).toBe(true);
			now = Date.parse("2030-01-01T00:00:02.000Z");
			await login("api-key", "LLM|payg-key");
			expect(storage.getCredentialOrigin("meta")).toEqual({ kind: "api_key" });
			expect(await storage.getApiKey("meta", "same-payg-relogin")).toBe("LLM|payg-key");
			await storage.logout("meta");
			expect(storage.has("meta")).toBe(false);

			now = Date.parse("2030-01-01T00:00:03.000Z");
			await login("muse");
			expect(await storage.getApiKey("meta", "muse-session")).toBe("LLM|subscription-key");
			expect(storage.isUsingOAuth("meta")).toBe(true);
			now = Date.parse("2030-01-01T00:00:04.000Z");
			await login("api-key", "LLM|new-payg-key");
			expect(
				storage
					.listStoredCredentials("meta")
					.map(row => row.credential.type)
					.sort(),
			).toEqual(["api_key", "oauth"]);
			expect(storage.getCredentialOrigin("meta")).toEqual({ kind: "api_key" });
			expect(storage.isUsingOAuth("meta")).toBe(false);
			expect(storage.isUsingOAuth("meta", "muse-session")).toBe(false);
			expect(storage.describeCredentialSource("meta")).toContain("api_key");
			expect(storage.getOAuthAccountIdentity("meta")).toBeUndefined();
			expect(await storage.getApiKey("meta", "payg-latest")).toBe("LLM|new-payg-key");
			expect(storage.isUsingOAuth("meta", "payg-latest")).toBe(false);
		} finally {
			nowSpy.mockRestore();
			storage.close();
		}
	});
});
