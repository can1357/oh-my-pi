import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const MODELS_URL = "https://console.arkanecloud.com/api/v2/models";

const originalArkaneCloudApiKey = Bun.env.ARKANECLOUD_API_KEY;

afterEach(() => {
	if (originalArkaneCloudApiKey === undefined) {
		delete Bun.env.ARKANECLOUD_API_KEY;
	} else {
		Bun.env.ARKANECLOUD_API_KEY = originalArkaneCloudApiKey;
	}
	vi.restoreAllMocks();
});

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

describe("ArkaneCloud login wiring", () => {
	test("registers ArkaneCloud in the login provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "arkanecloud");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("ArkaneCloud");
		expect(provider?.available).toBe(true);
	});

	test("resolves ARKANECLOUD_API_KEY from environment", () => {
		Bun.env.ARKANECLOUD_API_KEY = "ak_env_key";
		expect(getEnvApiKey("arkanecloud")).toBe("ak_env_key");
	});

	test("AuthStorage.login('arkanecloud') validates against /api/v2/models and stores the pasted key", async () => {
		const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = requestUrl(input);
			fetchCalls.push({ url, init });
			if (url === MODELS_URL) {
				return new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-ai/DeepSeek-V4-Flash" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("arkanecloud", {
			onAuth: () => {},
			onPrompt: async () => "  ak_validated  ",
			fetch: fetchMock,
		});

		// Credentials land under the `arkanecloud` provider id, trimmed.
		const credential = await storage.get("arkanecloud");
		expect(credential).toEqual({ type: "api_key", key: "ak_validated", source: "login" });

		const modelsCall = fetchCalls.find(call => call.url === MODELS_URL);
		expect(modelsCall).toBeDefined();
		expect(new Headers(modelsCall?.init?.headers).get("Authorization")).toBe("Bearer ak_validated");

		store.close();
	});

	test("AuthStorage.login('arkanecloud') rejects keys that fail /api/v2/models validation", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: "unauthorized", message: "invalid" } }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await expect(
			storage.login("arkanecloud", {
				onAuth: () => {},
				onPrompt: async () => "ak_bogus",
				fetch: fetchMock,
			}),
		).rejects.toThrow(/ArkaneCloud API key validation failed \(401\)/);

		expect(await storage.get("arkanecloud")).toBeUndefined();
		store.close();
	});
});
