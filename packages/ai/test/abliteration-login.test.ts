import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const ORIGINAL_ENV = {
	ABLITERATION_API_KEY: Bun.env.ABLITERATION_API_KEY,
	ABLIT_KEY: Bun.env.ABLIT_KEY,
} as const;

afterEach(() => {
	for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete Bun.env[name];
		else Bun.env[name] = value;
	}
	vi.restoreAllMocks();
});

describe("Abliteration login wiring", () => {
	test("registers Abliteration in the login provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "abliteration");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("Abliteration");
		expect(provider?.available).toBe(true);
	});

	test("resolves ABLITERATION_API_KEY and ABLIT_KEY from environment", () => {
		delete Bun.env.ABLITERATION_API_KEY;
		Bun.env.ABLIT_KEY = "abliteration-alias-key";
		expect(getEnvApiKey("abliteration")).toBe("abliteration-alias-key");

		Bun.env.ABLITERATION_API_KEY = "abliteration-env-key";
		expect(getEnvApiKey("abliteration")).toBe("abliteration-env-key");
	});

	test("AuthStorage.login('abliteration') validates against /v1/models and stores the pasted key", async () => {
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
			if (url === "https://api.abliteration.ai/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "abliterated-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("abliteration", {
			onAuth: () => {},
			onPrompt: async () => "ak_validated",
			fetch: fetchMock,
		});

		const credential = await storage.get("abliteration");
		expect(credential).toEqual({ type: "api_key", key: "ak_validated", source: "login" });

		const modelsCall = fetchCalls.find(call => call.url.endsWith("/v1/models"));
		expect(modelsCall).toBeDefined();
		const headers = new Headers(modelsCall?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer ak_validated");

		store.close();
	});

	test("AuthStorage.login('abliteration') rejects keys that fail /models validation", async () => {
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
			storage.login("abliteration", {
				onAuth: () => {},
				onPrompt: async () => "ak_bogus",
				fetch: fetchMock,
			}),
		).rejects.toThrow(/Abliteration API key validation failed \(401\)/);

		expect(await storage.get("abliteration")).toBeUndefined();
		store.close();
	});
});
