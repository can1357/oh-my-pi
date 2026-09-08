import { describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginNanoGPT = getProviderDefinition("nanogpt")!.login!;

describe("nanogpt login", () => {
	it("validates API key without requiring a specific model entitlement", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://nano-gpt.com/api/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-nano-test" });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await loginNanoGPT({
			onPrompt: async () => "sk-nano-test",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-nano-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces validation errors from models endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response('{"code":"invalid_api_key"}', {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		await expect(
			loginNanoGPT({
				onPrompt: async () => "sk-nano-test",
				fetch: fetchMock,
			}),
		).rejects.toThrow("NanoGPT API key validation failed (401)");
	});
});
