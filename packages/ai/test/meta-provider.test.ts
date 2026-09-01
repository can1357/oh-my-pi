import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { describe, expect, test, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { loginMeta, metaProvider } from "@oh-my-pi/pi-ai/registry/meta";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
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

	test("uses one provider for Muse subscriptions and Model API keys", () => {
		expect(metaProvider.name).toBe("Meta");
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
			expect(storage.getCredentialOrigin("meta")).toEqual({ kind: "oauth" });
			expect(storage.describeCredentialSource("meta")).toContain("oauth");
			storage.close();

			storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)), {
				usageProviderResolver: () => undefined,
			});
			await storage.reload();
			expect(await storage.getApiKey("meta", "after-restart")).toBe("LLM|subscription-key");
			await storage.logout("meta");
			expect(storage.has("meta")).toBe(false);

			now = Date.parse("2030-01-01T00:00:02.000Z");
			await login("muse");
			now = Date.parse("2030-01-01T00:00:03.000Z");
			await login("api-key", "LLM|new-payg-key");
			expect(
				storage
					.listStoredCredentials("meta")
					.map(row => row.credential.type)
					.sort(),
			).toEqual(["api_key", "oauth"]);
			expect(storage.getCredentialOrigin("meta")).toEqual({ kind: "api_key" });
			expect(storage.describeCredentialSource("meta")).toContain("api_key");
			expect(storage.getOAuthAccountIdentity("meta")).toBeUndefined();
			expect(await storage.getApiKey("meta", "payg-latest")).toBe("LLM|new-payg-key");
		} finally {
			nowSpy.mockRestore();
			storage.close();
		}
	});
});
