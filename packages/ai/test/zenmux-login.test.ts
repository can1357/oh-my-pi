import { describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginZenMux = getProviderDefinition("zenmux")!.login!;

describe("zenmux login", () => {
	it("opens ZenMux key settings and validates against models endpoint", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			expect(url).toBe("https://zenmux.ai/api/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-zenmux-test" });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await loginZenMux({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "sk-zenmux-test";
			},
			fetch: fetchMock,
		});

		expect(authUrl).toBe("https://zenmux.ai/settings/keys");
		expect(authInstructions).toContain("Create or copy your ZenMux API key");
		expect(promptMessage).toBe("Paste your ZenMux API key");
		expect(promptPlaceholder).toBe("sk-...");
		expect(apiKey).toBe("sk-zenmux-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects empty keys", async () => {
		await expect(
			loginZenMux({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginZenMux({})).rejects.toThrow("ZenMux login requires onPrompt callback");
	});

	it("surfaces models endpoint validation errors", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () => new Response('{"error":"invalid_api_key"}', { status: 401 }),
		) as unknown as typeof fetch;

		await expect(
			loginZenMux({
				onPrompt: async () => "sk-zenmux-test",
				fetch: fetchMock,
			}),
		).rejects.toThrow("ZenMux API key validation failed (401)");
	});
});
