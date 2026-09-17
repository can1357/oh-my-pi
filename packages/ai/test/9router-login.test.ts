import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai/auth-storage";
import { DEFAULT_9ROUTER_DASHBOARD_URL } from "@pk-nerdsaver-ai/pi-ai/registry/9router";
import { getOAuthProviders } from "@pk-nerdsaver-ai/pi-ai/registry/oauth";
import { getEnvApiKey } from "@pk-nerdsaver-ai/pi-ai/stream";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";

const original9RouterKey = Bun.env["9ROUTER_API_KEY"];
const originalNineRouterKey = Bun.env.NINEROUTER_API_KEY;
const original9RouterBaseUrl = Bun.env["9ROUTER_BASE_URL"];

afterEach(() => {
	if (original9RouterKey === undefined) {
		delete Bun.env["9ROUTER_API_KEY"];
	} else {
		Bun.env["9ROUTER_API_KEY"] = original9RouterKey;
	}
	if (originalNineRouterKey === undefined) {
		delete Bun.env.NINEROUTER_API_KEY;
	} else {
		Bun.env.NINEROUTER_API_KEY = originalNineRouterKey;
	}
	if (original9RouterBaseUrl === undefined) {
		delete Bun.env["9ROUTER_BASE_URL"];
	} else {
		Bun.env["9ROUTER_BASE_URL"] = original9RouterBaseUrl;
	}
	vi.restoreAllMocks();
});

describe("9router login wiring", () => {
	test("registers 9router in the OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "9router");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("9router");
		expect(provider?.available).toBe(true);
	});

	test("resolves 9ROUTER_API_KEY and NINEROUTER_API_KEY from environment", () => {
		delete Bun.env["9ROUTER_API_KEY"];
		delete Bun.env.NINEROUTER_API_KEY;
		expect(getEnvApiKey("9router")).toBeUndefined();

		Bun.env.NINEROUTER_API_KEY = "nine-test-key";
		expect(getEnvApiKey("9router")).toBe("nine-test-key");

		Bun.env["9ROUTER_API_KEY"] = "9r-test-key";
		expect(getEnvApiKey("9router")).toBe("9r-test-key");
	});

	test("AuthStorage.login('9router') validates against /api/auth/verify and stores the pasted key", async () => {
		const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			fetchCalls.push({ url, init });
			if (url === "http://127.0.0.1:20128/api/auth/verify") {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		let authUrlOpened = "";
		await storage.login("9router", {
			onAuth: info => {
				authUrlOpened = info.url;
			},
			onPrompt: async () => "sk-9router-secret",
			fetch: fetchMock,
		});

		expect(authUrlOpened).toBe(DEFAULT_9ROUTER_DASHBOARD_URL);

		const credential = await storage.get("9router");
		expect(credential).toEqual({ type: "api_key", key: "sk-9router-secret" });

		const verifyCall = fetchCalls.find(call => call.url.includes("/api/auth/verify"));
		expect(verifyCall).toBeDefined();
		const headers = new Headers(verifyCall?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer sk-9router-secret");
	});

	test("AuthStorage.login('9router') rejects invalid key on 401 from verify", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await expect(
			storage.login("9router", {
				onAuth: () => {},
				onPrompt: async () => "sk-invalid",
				fetch: fetchMock,
			}),
		).rejects.toThrow("9router API key validation failed (401)");

		expect(await storage.get("9router")).toBeUndefined();
	});

	test("AuthStorage.login('9router') falls back to /v1/models on gateways without verify", async () => {
		const fetchCalls: Array<{ url: string }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			fetchCalls.push({ url });
			if (url === "http://127.0.0.1:20128/api/auth/verify") {
				return new Response("not found", { status: 404 });
			}
			if (url === "http://127.0.0.1:20128/v1/models") {
				return new Response(JSON.stringify({ object: "list", data: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("9router", {
			onAuth: () => {},
			onPrompt: async () => "sk-9router-secret",
			fetch: fetchMock,
		});

		expect(await storage.get("9router")).toEqual({ type: "api_key", key: "sk-9router-secret" });
		expect(fetchCalls.map(call => call.url)).toEqual([
			"http://127.0.0.1:20128/api/auth/verify",
			"http://127.0.0.1:20128/v1/models",
		]);
	});
});
