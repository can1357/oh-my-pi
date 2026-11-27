import { describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

const loginStraitly = getProviderDefinition("straitly")?.login;
if (!loginStraitly) throw new Error("Straitly login is not registered");

describe("Straitly login", () => {
	test("strips Bearer prefix and validates the key against /v1/key", async () => {
		const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({ url: String(input), method: init?.method, authorization: headers.get("authorization") });
			return Response.json({ data: { label: "test" } });
		});

		const apiKey = await loginStraitly({
			onPrompt: async () => "  Bearer sk-straitly-test  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-straitly-test");
		expect(requests).toEqual([
			{
				url: "https://api.straitly.ai/v1/key",
				method: "GET",
				authorization: "Bearer sk-straitly-test",
			},
		]);
	});

	test("rejects an invalid key when /v1/key returns 401", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json(
				{ error: { message: "Invalid API key.", type: "invalid_request_error", code: 401 } },
				{ status: 401 },
			),
		);

		await expect(
			loginStraitly({
				onPrompt: async () => "sk-invalid-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Straitly API key validation failed (401)");
	});
});
