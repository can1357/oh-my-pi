import { afterEach, describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

const loginTrustedRouter = getProviderDefinition("trustedrouter")?.login;
if (!loginTrustedRouter) throw new Error("TrustedRouter login is not registered");

const originalBaseUrl = Bun.env.TRUSTEDROUTER_BASE_URL;

afterEach(() => {
	if (originalBaseUrl === undefined) delete Bun.env.TRUSTEDROUTER_BASE_URL;
	else Bun.env.TRUSTEDROUTER_BASE_URL = originalBaseUrl;
});

describe("TrustedRouter login", () => {
	test("validates the pasted key against /v1/key and strips an optional Bearer prefix", async () => {
		const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({ url: String(input), method: init?.method, authorization: headers.get("authorization") });
			return Response.json({ data: { label: "test-key" } });
		});

		const apiKey = await loginTrustedRouter({
			onPrompt: async () => "  Bearer sk-tr-test-key  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-tr-test-key");
		expect(requests).toEqual([
			{
				url: "https://api.trustedrouter.com/v1/key",
				method: "GET",
				authorization: "Bearer sk-tr-test-key",
			},
		]);
	});

	test("targets TRUSTEDROUTER_BASE_URL/v1/key when configured", async () => {
		Bun.env.TRUSTEDROUTER_BASE_URL = "https://api-europe-west4.quillrouter.com";
		const urls: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			urls.push(String(input));
			return Response.json({ data: { label: "eu-key" } });
		});

		await expect(
			loginTrustedRouter({
				onPrompt: async () => "sk-tr-eu-key",
				fetch: fetchMock,
			}),
		).resolves.toBe("sk-tr-eu-key");
		expect(urls).toEqual(["https://api-europe-west4.quillrouter.com/v1/key"]);
	});

	test("rejects a key TrustedRouter rejects on /v1/key", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json(
				{ error: { code: 401, message: "Invalid API key", type: "invalid_api_key", source: "router" } },
				{ status: 401 },
			),
		);

		await expect(
			loginTrustedRouter({
				onPrompt: async () => "sk-tr-invalid-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("TrustedRouter API key validation failed (401)");
	});
});
