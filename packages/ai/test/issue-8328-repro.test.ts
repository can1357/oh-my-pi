import { describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

const loginTogether = getProviderDefinition("together")!.login!;

// Together's serverless API rejects models that only exist behind a dedicated
// endpoint (e.g. `moonshotai/Kimi-K2.5`) with an HTTP 400 `model_not_available`
// error — even when the pasted key is perfectly valid. Login validation must
// therefore not depend on chat-completing against a specific model; it must
// probe an authenticated, model-agnostic endpoint. Regression guard for #8328.
const NON_SERVERLESS_400 = {
	id: "ovsZQhk-2kFHot",
	error: {
		message:
			"Unable to access non-serverless model moonshotai/Kimi-K2.5. Please visit https://api.together.ai/models/moonshotai/Kimi-K2.5 to create and start a new dedicated endpoint for the model.",
		type: "invalid_request_error",
		param: null,
		code: "model_not_available",
	},
};

describe("Together login (#8328)", () => {
	test("validates a valid key against the models endpoint, not a hardcoded model", async () => {
		const requests: Array<{ url: string; method: string | undefined }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, method: init?.method });
			// Simulate Together: chat-completions with a non-serverless model 400s,
			// while the authenticated models listing succeeds for a valid key.
			if (url.endsWith("/chat/completions")) {
				return Response.json(NON_SERVERLESS_400, { status: 400 });
			}
			if (url.endsWith("/models")) {
				return Response.json({ object: "list", data: [] });
			}
			return Response.json({ error: "unexpected" }, { status: 500 });
		});

		const apiKey = await loginTogether({
			onPrompt: async () => "  together-valid-key  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("together-valid-key");
		// The only validation request must be the authenticated models listing.
		expect(requests).toEqual([{ url: "https://api.together.xyz/v1/models", method: "GET" }]);
	});

	test("still rejects an invalid key", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json({ error: { message: "Invalid API key provided" } }, { status: 401 }),
		);

		await expect(
			loginTogether({
				onPrompt: async () => "bad-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("together API key validation failed (401)");
	});
});
