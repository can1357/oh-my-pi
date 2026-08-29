import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const originalYoloAutoApiKey = Bun.env.YOLO_AUTO_API_KEY;

afterEach(() => {
	if (originalYoloAutoApiKey === undefined) {
		delete Bun.env.YOLO_AUTO_API_KEY;
	} else {
		Bun.env.YOLO_AUTO_API_KEY = originalYoloAutoApiKey;
	}
	vi.restoreAllMocks();
});

describe("Yolo-Auto login wiring", () => {
	test("registers Yolo-Auto in the login provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "yolo-auto");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("Yolo-Auto");
		expect(provider?.available).toBe(true);
	});

	test("resolves YOLO_AUTO_API_KEY from environment", () => {
		Bun.env.YOLO_AUTO_API_KEY = "yolo-env-key";
		expect(getEnvApiKey("yolo-auto")).toBe("yolo-env-key");
	});

	test("AuthStorage.login('yolo-auto') validates against /v1/models and stores the pasted key", async () => {
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
			if (url === "https://yolo-auto.com/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "deepseek-flash-v4" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("yolo-auto", {
			onAuth: () => {},
			onPrompt: async () => "yolo-validated",
			fetch: fetchMock,
		});

		const credential = await storage.get("yolo-auto");
		expect(credential).toEqual({ type: "api_key", key: "yolo-validated", source: "login" });

		const modelsCall = fetchCalls.find(call => call.url.endsWith("/v1/models"));
		expect(modelsCall).toBeDefined();
		const headers = new Headers(modelsCall?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer yolo-validated");

		store.close();
	});

	test("AuthStorage.login('yolo-auto') rejects keys that fail /models validation", async () => {
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
			storage.login("yolo-auto", {
				onAuth: () => {},
				onPrompt: async () => "yolo-bogus",
				fetch: fetchMock,
			}),
		).rejects.toThrow(/Yolo-Auto API key validation failed \(401\)/);

		expect(await storage.get("yolo-auto")).toBeUndefined();
		store.close();
	});
});
