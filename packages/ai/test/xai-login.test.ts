import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const originalXaiApiKey = Bun.env.XAI_API_KEY;

afterEach(() => {
	if (originalXaiApiKey === undefined) {
		delete Bun.env.XAI_API_KEY;
	} else {
		Bun.env.XAI_API_KEY = originalXaiApiKey;
	}
	vi.restoreAllMocks();
});

describe("xAI API login wiring", () => {
	test("registers xAI API in the OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "xai");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("xAI API");
		expect(provider?.available).toBe(true);
	});

	test("resolves XAI_API_KEY from environment", () => {
		Bun.env.XAI_API_KEY = "xai-env-key";
		expect(getEnvApiKey("xai")).toBe("xai-env-key");
	});

	test("XAI_API_KEY alone does not mark SuperGrok as available", async () => {
		const originalOauthToken = Bun.env.XAI_OAUTH_TOKEN;
		Bun.env.XAI_API_KEY = "xai-env-key";
		delete Bun.env.XAI_OAUTH_TOKEN;
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			expect(storage.hasAuth("xai")).toBe(true);
			expect(storage.hasAuth("xai-oauth")).toBe(false);
			expect(storage.hasResolvableAuth("xai")).toBe(true);
			expect(storage.hasResolvableAuth("xai-oauth")).toBe(true);
			expect(getEnvApiKey("xai-oauth")).toBe("xai-env-key");
			expect(storage.getCredentialOrigin("xai")).toEqual({ kind: "env", envVar: "XAI_API_KEY" });
			expect(storage.getCredentialOrigin("xai-oauth")).toBeUndefined();
		} finally {
			if (originalOauthToken === undefined) {
				delete Bun.env.XAI_OAUTH_TOKEN;
			} else {
				Bun.env.XAI_OAUTH_TOKEN = originalOauthToken;
			}
			store.close();
		}
	});

	test("XAI_OAUTH_TOKEN marks SuperGrok available without a paid API key", async () => {
		const originalOauthToken = Bun.env.XAI_OAUTH_TOKEN;
		delete Bun.env.XAI_API_KEY;
		Bun.env.XAI_OAUTH_TOKEN = "xai-oauth-env";
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			expect(storage.hasAuth("xai")).toBe(false);
			expect(storage.hasAuth("xai-oauth")).toBe(true);
			expect(storage.getCredentialOrigin("xai-oauth")).toEqual({ kind: "env" });
		} finally {
			if (originalOauthToken === undefined) {
				delete Bun.env.XAI_OAUTH_TOKEN;
			} else {
				Bun.env.XAI_OAUTH_TOKEN = originalOauthToken;
			}
			store.close();
		}
	});

	test("AuthStorage.login('xai') validates against /models and stores the pasted key", async () => {
		const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			let url: string;
			if (typeof input === "string") {
				url = input;
			} else if (input instanceof URL) {
				url = input.toString();
			} else {
				url = input.url;
			}
			fetchCalls.push({ url, init });
			if (url === "https://api.x.ai/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "grok-4" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("xai", {
			onAuth: () => {},
			onPrompt: async () => "xai-validated",
			fetch: fetchMock,
		});

		const credential = await storage.get("xai");
		expect(credential).toEqual({ type: "api_key", key: "xai-validated", source: "login" });

		const modelsCall = fetchCalls.find(call => call.url.endsWith("/v1/models"));
		expect(modelsCall).toBeDefined();
		const headers = new Headers(modelsCall?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer xai-validated");

		store.close();
	});

	test("AuthStorage.login('xai') rejects keys that fail /models validation", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response("Unauthorized", {
					status: 401,
					headers: { "Content-Type": "text/plain" },
				}),
		);

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await expect(
			storage.login("xai", {
				onAuth: () => {},
				onPrompt: async () => "xai-bogus",
				fetch: fetchMock,
			}),
		).rejects.toThrow(/xAI API key validation failed \(401\)/);

		expect(await storage.get("xai")).toBeUndefined();
		store.close();
	});
});
