import { describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

const loginCoralbricks = getProviderDefinition("coralbricks")?.login;
if (!loginCoralbricks) throw new Error("CoralBricks login is not registered");

describe("CoralBricks login", () => {
	test("validates the pasted key against the key-protected /v1/models endpoint", async () => {
		const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({ url: String(input), method: init?.method, authorization: headers.get("authorization") });
			return Response.json({ object: "list", data: [] });
		});

		const apiKey = await loginCoralbricks({
			onPrompt: async () => "  cb-test-key  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("cb-test-key");
		// Coral's `/v1/models` is key-protected (401 without a bearer key), so
		// the probe validates the key and bills nothing, unlike a
		// chat-completions ping against a prepaid balance.
		expect(requests).toEqual([
			{
				url: "https://inference.coralbricks.ai/v1/models",
				method: "GET",
				authorization: "Bearer cb-test-key",
			},
		]);
	});

	test("rejects a key Coral rejects", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json(
				{ error: { message: "invalid_api_key", type: "invalid_request_error", code: "invalid_api_key" } },
				{ status: 401 },
			),
		);

		await expect(
			loginCoralbricks({
				onPrompt: async () => "cb-invalid-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("CoralBricks API key validation failed (401)");
	});
});
