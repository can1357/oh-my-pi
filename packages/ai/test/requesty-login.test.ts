import { describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "../src/registry/oauth";
import type { OAuthController } from "../src/registry/oauth/types";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

function loginRequesty(callbacks: OAuthController) {
	const login = getProviderDefinition("requesty")?.login;
	if (!login) throw new Error("requesty login is not registered");
	return login(callbacks);
}

describe("Requesty login", () => {
	test("registers Requesty as an available API-key provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "requesty");
		expect(provider).toMatchObject({ id: "requesty", name: "Requesty", available: true });
	});

	test("validates the pasted key against the management self apikey endpoint", async () => {
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const prompts: Array<{ message: string; placeholder?: string }> = [];
		const progress: string[] = [];
		const requests: Array<{
			url: string;
			method: string | undefined;
			authorization: string | null;
			contentType: string | null;
		}> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				method: init?.method,
				authorization: headers.get("authorization"),
				contentType: headers.get("content-type"),
			});
			return Response.json({
				id: "123e4567-e89b-12d3-a456-426614174000",
				name: "test-key",
				monthly_spend: 0,
				monthly_limit: 0,
				permissions: { manage: "read", completions: "write" },
			});
		});

		const apiKey = await loginRequesty({
			onAuth: info => authEvents.push(info),
			onPrompt: async prompt => {
				prompts.push(prompt);
				return "  requesty-test-key  ";
			},
			onProgress: message => progress.push(message),
			fetch: fetchMock,
		});

		expect(apiKey).toBe("requesty-test-key");
		expect(authEvents).toEqual([
			{
				url: "https://app.requesty.ai/api-keys",
				instructions: "Create or copy your API key from the Requesty dashboard",
			},
		]);
		expect(prompts).toEqual([{ message: "Paste your Requesty API key", placeholder: "rqsty-sk..." }]);
		expect(progress).toEqual(["Validating API key..."]);
		expect(requests).toEqual([
			{
				url: "https://api-v2.requesty.ai/v1/manage/apikey/self",
				method: "GET",
				authorization: "Bearer requesty-test-key",
				contentType: null,
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
