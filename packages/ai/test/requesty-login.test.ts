import { afterEach, describe, expect, test, vi } from "bun:test";
import { getEnvApiKey } from "../src/env-api-key";
import type { OAuthController } from "../src/registry/oauth/types";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

const ORIGINAL_REQUESTY_API_KEY = Bun.env.REQUESTY_API_KEY;

afterEach(() => {
	if (ORIGINAL_REQUESTY_API_KEY === undefined) delete Bun.env.REQUESTY_API_KEY;
	else Bun.env.REQUESTY_API_KEY = ORIGINAL_REQUESTY_API_KEY;
	vi.restoreAllMocks();
});

function loginRequesty(callbacks: OAuthController) {
	const login = getProviderDefinition("requesty")?.login;
	if (!login) throw new Error("requesty login is not registered");
	return login(callbacks);
}

describe("Requesty login", () => {
	test("resolves REQUESTY_API_KEY from the environment", () => {
		delete Bun.env.REQUESTY_API_KEY;
		expect(getEnvApiKey("requesty")).toBeUndefined();
		Bun.env.REQUESTY_API_KEY = "rqsty-sk-env";
		expect(getEnvApiKey("requesty")).toBe("rqsty-sk-env");
	});

	test("validates the pasted key against the management self apikey endpoint", async () => {
		const authUrls: string[] = [];
		const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: String(input),
				method: init?.method,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return Response.json({ id: "123e4567-e89b-12d3-a456-426614174000", name: "test-key" });
		});

		const apiKey = await loginRequesty({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async () => "  requesty-test-key  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("requesty-test-key");
		expect(authUrls).toEqual(["https://app.requesty.ai/api-keys"]);
		expect(requests).toEqual([
			{
				url: "https://api-v2.requesty.ai/v1/manage/apikey/self",
				method: "GET",
				authorization: "Bearer requesty-test-key",
			},
		]);
	});

	test("rejects a key rejected by Requesty", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
		);

		await expect(
			loginRequesty({
				onPrompt: async () => "invalid-requesty-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Requesty API key validation failed (401)");
	});
});
