import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { describe, expect, test, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { loginMeta, metaProvider, museCodeProvider } from "@oh-my-pi/pi-ai/registry/meta";
import { resolveProviderCredentialId } from "@oh-my-pi/pi-ai/registry";
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

describe("Meta Model API login", () => {
	test("validates pasted keys against the models endpoint without running inference", async () => {
		let requestedUrl = "";
		let authorization = "";
		const apiKey = await loginMeta({
			onAuth: () => {},
			onPrompt: async () => " meta-test-key ",
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

	test("keeps PAYG API-key login separate from Muse subscription login", () => {
		expect(museCodeProvider.storeCredentialsAs).toBe("meta");
		expect(resolveProviderCredentialId("muse-code")).toBe("meta");
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
		const login = async (provider: "meta" | "muse-code", key: string): Promise<void> => {
			await storage.login(provider, {
				onAuth: () => {},
				onPrompt: async () => key,
				fetch: museFetch,
			});
		};

		let now = Date.parse("2030-01-01T00:00:00.000Z");
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			await storage.reload();
			now = Date.parse("2030-01-01T00:00:00.000Z");
			await login("meta", "LLM|payg-key");
			expect(storage.hasAuth("muse-code")).toBe(false);
			expect(storage.getCredentialOrigin("muse-code")).toBeUndefined();
			expect(storage.describeCredentialSource("muse-code")).toBeUndefined();
			now = Date.parse("2030-01-01T00:00:01.000Z");
			await login("muse-code", "");
			expect(
				storage
					.listStoredCredentials("meta")
					.map(row => row.credential.type)
					.sort(),
			).toEqual(["api_key", "oauth"]);
			expect(await storage.getApiKey("meta", "muse-latest")).toBe("LLM|subscription-key");
			expect(storage.hasAuth("muse-code")).toBe(true);
			expect(storage.has("muse-code")).toBe(true);
			storage.close();

			storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)), {
				usageProviderResolver: () => undefined,
			});
			await storage.reload();
			expect(await storage.getApiKey("meta", "after-restart")).toBe("LLM|subscription-key");
			await storage.logout("muse-code");
			expect(storage.has("meta")).toBe(true);
			expect(storage.has("muse-code")).toBe(false);
			expect(await storage.getApiKey("meta", "payg-after-muse-logout")).toBe("LLM|payg-key");
			expect(storage.listStoredCredentials("meta").map(row => row.credential.type)).toEqual(["api_key"]);
			await storage.logout("meta");
			expect(storage.has("meta")).toBe(false);

			now = Date.parse("2030-01-01T00:00:02.000Z");
			await login("muse-code", "");
			now = Date.parse("2030-01-01T00:00:03.000Z");
			await login("meta", "LLM|new-payg-key");
			expect(
				storage
					.listStoredCredentials("meta")
					.map(row => row.credential.type)
					.sort(),
			).toEqual(["api_key", "oauth"]);
			expect(await storage.getApiKey("meta", "payg-latest")).toBe("LLM|new-payg-key");
			expect(storage.getCredentialOrigin("meta")).toEqual({ kind: "api_key" });
			expect(storage.describeCredentialSource("meta")).toContain("api_key");
			expect(storage.getCredentialOrigin("muse-code")).toEqual({ kind: "oauth" });
			expect(storage.describeCredentialSource("muse-code")).toContain("oauth");
			expect(storage.getOAuthAccountIdentity("muse-code")?.accountId).toBe("meta-account");
			const museRows = storage.listStoredCredentials("muse-code");
			expect(museRows.map(row => row.credential.type)).toEqual(["oauth"]);
			const paygRow = storage.listStoredCredentials("meta").find(row => row.credential.type === "api_key");
			expect(await storage.removeCredential("muse-code", paygRow!.id)).toBe(false);
			expect(await storage.removeCredential("muse-code", museRows[0]!.id)).toBe(true);
			expect(storage.hasAuth("muse-code")).toBe(false);
			expect(storage.hasAuth("meta")).toBe(true);
			expect(await storage.getApiKey("meta", "payg-after-row-logout")).toBe("LLM|new-payg-key");
		} finally {
			nowSpy.mockRestore();
			storage.close();
		}
	});
});
