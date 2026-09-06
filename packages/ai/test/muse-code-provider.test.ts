import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { MUSE_CODE_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const encodedMuseCredential = JSON.stringify({
	oauthAccessToken: "meta-account-access",
	apiKey: "LLM|subscription-key",
});

describe("Muse Code provider", () => {
	test("unwraps only the subscription Model API key for inference and discovery", () => {
		const provider = getProviderDefinition("muse-code");
		if (!provider?.prepareRequest || !provider.prepareModelDiscovery) {
			throw new Error("Muse Code transport is not registered");
		}
		const model = buildModel(MUSE_CODE_STATIC_MODELS[0]!);
		const request = provider.prepareRequest(model, { apiKey: encodedMuseCredential });
		const discovery = provider.prepareModelDiscovery({ apiKey: encodedMuseCredential });

		expect(request.options.apiKey).toBe("LLM|subscription-key");
		expect(request.options.headers).toMatchObject({ "x-api-version": "1.0.0" });
		expect(discovery).toMatchObject({ apiKey: "LLM|subscription-key", authenticated: true });
	});

	test("keeps Meta PAYG and Muse subscription credentials in separate provider pools", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
		});
		try {
			await storage.reload();
			await storage.set("meta", [{ type: "api_key", key: "LLM|payg-key", source: "login" }]);
			await storage.set("muse-code", [
				{
					type: "oauth",
					access: encodedMuseCredential,
					refresh: "meta-refresh",
					expires: Date.now() + 3_600_000,
					accountId: "meta-account-1",
				},
			]);

			expect(await storage.getApiKey("meta", "payg-session")).toBe("LLM|payg-key");
			expect(await storage.getApiKey("muse-code", "muse-session")).toBe(encodedMuseCredential);
			expect(
				await storage.markUsageLimitReached("muse-code", "muse-session", {
					apiKey: encodedMuseCredential,
					retryAfterMs: 60_000,
				}),
			).toMatchObject({ switched: false });
			expect(await storage.getApiKey("muse-code", "muse-session")).toBe(encodedMuseCredential);
			expect(await storage.getApiKey("meta", "payg-session")).toBe("LLM|payg-key");
		} finally {
			storage.close();
		}
	});

	test("accepts stale stored expiry for Muse device credentials without refresh", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
		});
		try {
			await storage.reload();
			await storage.set("muse-code", [
				{
					type: "oauth",
					access: encodedMuseCredential,
					refresh: "",
					expires: Date.now() - 60_000,
					accountId: "meta-account-1",
				},
			]);

			expect(await storage.getApiKey("muse-code", "stale-expiry-session")).toBe(encodedMuseCredential);
		} finally {
			storage.close();
		}
	});

	test("keeps the existing Meta Model API login distinct", () => {
		expect(getProviderDefinition("meta")).toMatchObject({ id: "meta", name: "Meta Model API" });
		expect(getProviderDefinition("muse-code")).toMatchObject({
			id: "muse-code",
			name: "Muse Code (Subscription)",
		});
	});
});
