import { describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "../src/registry/oauth";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

const loginNovita = getProviderDefinition("novita")!.login!;

describe("Novita login", () => {
	test("registers Novita as an available API-key provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "novita");
		expect(provider).toMatchObject({ id: "novita", name: "Novita", available: true });
	});

	test("validates the pasted key against the OpenAI-compatible chat completions endpoint", async () => {
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const prompts: Array<{ message: string; placeholder?: string }> = [];
		const progress: string[] = [];
		const requests: Array<{
			url: string;
			method: string | undefined;
			authorization: string | null;
			contentType: string | null;
			body: unknown;
		}> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				method: init?.method,
				authorization: headers.get("authorization"),
				contentType: headers.get("content-type"),
				body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
			});
			return Response.json({ choices: [{ message: { role: "assistant", content: "" } }] });
		});

		const apiKey = await loginNovita({
			onAuth: info => authEvents.push(info),
			onPrompt: async prompt => {
				prompts.push(prompt);
				return "  novita-test-key  ";
			},
			onProgress: message => progress.push(message),
			fetch: fetchMock,
		});

		expect(apiKey).toBe("novita-test-key");
		expect(authEvents).toEqual([
			{
				url: "https://novita.ai/settings/key-management",
				instructions: "Create or copy your API key from the Novita dashboard",
			},
		]);
		expect(prompts).toEqual([{ message: "Paste your Novita API key", placeholder: "sk_..." }]);
		expect(progress).toEqual(["Validating API key..."]);
		expect(requests).toEqual([
			{
				url: "https://api.novita.ai/openai/v1/chat/completions",
				method: "POST",
				authorization: "Bearer novita-test-key",
				contentType: "application/json",
				body: {
					model: "moonshotai/kimi-k2.7-code",
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
					temperature: 0,
				},
			},
		]);
	});

	test("accepts an inference key whose team role cannot read the account balance", async () => {
		// Novita's Developer/Basic team roles hold no Balance permission, so their
		// otherwise-valid inference keys are rejected by the billing endpoint.
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			if (String(input).includes("/openapi/v1/billing/")) {
				return Response.json(
					{ code: 401, reason: "UNAUTHORIZED", message: "key not found", metadata: {} },
					{ status: 401 },
				);
			}
			return Response.json({ choices: [{ message: { role: "assistant", content: "" } }] });
		});

		await expect(
			loginNovita({
				onPrompt: async () => "developer-role-key",
				fetch: fetchMock,
			}),
		).resolves.toBe("developer-role-key");
	});

	test("rejects a key rejected by Novita", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json(
				{ code: 401, reason: "FAILED_TO_AUTH", message: "failed to authenticate API key", metadata: {} },
				{ status: 401 },
			),
		);

		await expect(
			loginNovita({
				onPrompt: async () => "invalid-novita-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Novita API key validation failed (401)");
	});
});
