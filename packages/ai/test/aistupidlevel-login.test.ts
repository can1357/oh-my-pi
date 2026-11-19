import { describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

const loginAiStupidLevel = getProviderDefinition("aistupidlevel")?.login;
if (!loginAiStupidLevel) throw new Error("AI Stupid Level login is not registered");

describe("AI Stupid Level login", () => {
	test("validates the pasted router key against the key-protected /v1/models endpoint", async () => {
		const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({ url: String(input), method: init?.method, authorization: headers.get("authorization") });
			return Response.json({ object: "list", data: [] });
		});

		const apiKey = await loginAiStupidLevel({
			onPrompt: async () => "  aism_test_key  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("aism_test_key");
		// `/v1/models` answers 401 without a valid router key, so the probe
		// validates the key without sending a chat request.
		expect(requests).toEqual([
			{
				url: "https://aistupidlevel.info/v1/models",
				method: "GET",
				authorization: "Bearer aism_test_key",
			},
		]);
	});

	test("rejects a key the router rejects", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json(
				{ error: { message: "Invalid API key", type: "authentication_error", code: "invalid_api_key" } },
				{ status: 401 },
			),
		);

		await expect(
			loginAiStupidLevel({
				onPrompt: async () => "aism_invalid_key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("AI Stupid Level API key validation failed (401)");
	});
});
