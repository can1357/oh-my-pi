import { describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

const loginArkaneCloud = getProviderDefinition("arkanecloud")?.login;
if (!loginArkaneCloud) throw new Error("ArkaneCloud login is not registered");

describe("ArkaneCloud login", () => {
	test("validates the pasted key against the key-protected /api/v2/models endpoint", async () => {
		const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({ url: String(input), method: init?.method, authorization: headers.get("authorization") });
			return Response.json({ object: "list", data: [] });
		});

		const apiKey = await loginArkaneCloud({
			onPrompt: async () => "  ak_test-key  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("ak_test-key");
		expect(requests).toEqual([
			{
				url: "https://console.arkanecloud.com/api/v2/models",
				method: "GET",
				authorization: "Bearer ak_test-key",
			},
		]);
	});

	test("rejects a key ArkaneCloud rejects", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json(
				{ error: { message: "invalid_api_key", type: "invalid_request_error", code: "invalid_api_key" } },
				{ status: 401 },
			),
		);

		await expect(
			loginArkaneCloud({
				onPrompt: async () => "ak_invalid-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("ArkaneCloud API key validation failed (401)");
	});
});
