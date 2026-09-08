import { describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "../src/registry/oauth";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

const loginDeepinfra = getProviderDefinition("deepinfra")?.login;
if (!loginDeepinfra) throw new Error("DeepInfra login is not registered");

describe("DeepInfra login", () => {
	test("registers DeepInfra as an available API-key provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "deepinfra");
		expect(provider).toMatchObject({ id: "deepinfra", name: "DeepInfra", available: true });
	});

	test("validates the pasted key against the OpenAI-compatible chat completions endpoint", async () => {
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const requests: Array<{
			url: string;
			method: string | undefined;
			authorization: string | null;
			body: unknown;
		}> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				method: init?.method,
				authorization: headers.get("authorization"),
				body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
			});
			return Response.json({ choices: [{ message: { role: "assistant", content: "" } }] });
		});

		const apiKey = await loginDeepinfra({
			onAuth: info => authEvents.push(info),
			onPrompt: async () => "  di-test-key  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("di-test-key");
		expect(authEvents).toEqual([
			{
				url: "https://deepinfra.com/dash/api_keys",
				instructions: "Create or copy your API key from the DeepInfra dashboard",
			},
		]);
		// Validation deliberately pings inference: DeepInfra's /models endpoint is
		// public and would accept any string as a key.
		expect(requests).toEqual([
			{
				url: "https://api.deepinfra.com/v1/openai/chat/completions",
				method: "POST",
				authorization: "Bearer di-test-key",
				body: {
					model: "deepseek-ai/DeepSeek-V4-Flash-0731",
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
					temperature: 0,
				},
			},
		]);
	});

	test("rejects a key rejected by DeepInfra", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => Response.json({ detail: "Invalid API key" }, { status: 401 }));

		await expect(
			loginDeepinfra({
				onPrompt: async () => "invalid-deepinfra-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("DeepInfra API key validation failed (401)");
	});
});
