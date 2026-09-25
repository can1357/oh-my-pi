import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const originalOpenRouterApiKey = Bun.env.OPENROUTER_API_KEY;

afterEach(() => {
	if (originalOpenRouterApiKey === undefined) {
		delete Bun.env.OPENROUTER_API_KEY;
	} else {
		Bun.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
	}
	vi.restoreAllMocks();
});

describe("openrouter login wiring", () => {
	test("resolves OPENROUTER_API_KEY from environment", () => {
		Bun.env.OPENROUTER_API_KEY = "or-test-key";
		expect(getEnvApiKey("openrouter")).toBe("or-test-key");
	});

	test("AuthStorage.oauth.login('openrouter') validates against /auth/key and stores the pasted key", async () => {
		const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			fetchCalls.push({ url, init });
			if (url === "https://openrouter.ai/api/v1/auth/key") {
				return new Response(JSON.stringify({ data: { label: "test" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();

		await storage.oauth.login("openrouter", {
			onAuth: () => {},
			onPrompt: async () => "sk-or-validated",
			fetch: fetchMock,
		});

		const credential = await storage.credentials.get("openrouter");
		expect(credential).toEqual({ type: "api_key", key: "sk-or-validated", source: "login" });

		const authCall = fetchCalls.find(call => call.url.includes("/api/v1/auth/key"));
		expect(authCall).toBeDefined();
		const headers = new Headers(authCall?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer sk-or-validated");

		store.close();
	});

	test("AuthStorage.oauth.login('openrouter') rejects keys that fail /auth/key validation", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response("Unauthorized", {
					status: 401,
					headers: { "Content-Type": "text/plain" },
				}),
		);

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();

		await expect(
			storage.oauth.login("openrouter", {
				onAuth: () => {},
				onPrompt: async () => "sk-or-bogus",
				fetch: fetchMock,
			}),
		).rejects.toThrow(/OpenRouter API key validation failed \(401\)/);

		expect(await storage.credentials.get("openrouter")).toBeUndefined();
		store.close();
	});
});
