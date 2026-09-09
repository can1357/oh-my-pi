import { describe, expect, test } from "bun:test";
import { NO_AUTH_SENTINEL, resolveOpenAIRequestSetup } from "../../src/providers/openai-shared";

describe("resolveOpenAIRequestSetup keyless auth", () => {
	test("omits Authorization for the keyless (auth: none) sentinel, keeping custom headers", () => {
		const setup = resolveOpenAIRequestSetup(
			{
				provider: "qwen",
				id: "Qwen3.6-35B-A3B",
				baseUrl: "http://localhost:8788",
				headers: { "x-api-key": "real-key" },
			},
			{ apiKey: NO_AUTH_SENTINEL, messages: [] },
		);
		expect(setup.headers.Authorization).toBeUndefined();
		expect(setup.headers["x-api-key"]).toBe("real-key");
	});

	test("still injects Bearer for a real key", () => {
		const setup = resolveOpenAIRequestSetup(
			{ provider: "custom", id: "m", baseUrl: "http://localhost:8788" },
			{ apiKey: "sk-real", messages: [] },
		);
		expect(setup.headers.Authorization).toBe("Bearer sk-real");
	});

	test("caller-supplied Authorization in model.headers is preserved even when keyless", () => {
		const setup = resolveOpenAIRequestSetup(
			{
				provider: "qwen",
				id: "m",
				baseUrl: "http://localhost:8788",
				headers: { Authorization: "Bearer custom-token" },
			},
			{ apiKey: NO_AUTH_SENTINEL, messages: [] },
		);
		expect(setup.headers.Authorization).toBe("Bearer custom-token");
	});
});
