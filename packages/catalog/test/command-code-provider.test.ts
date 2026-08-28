import { describe, expect, test } from "bun:test";
import {
	commandCodeModelManagerOptions,
	resolveCommandCodeApi,
	resolveCommandCodeBaseUrl,
} from "@oh-my-pi/pi-catalog/provider-models/command-code";

describe("Command Code provider", () => {
	test("routes only Anthropic model identities to messages", () => {
		expect(resolveCommandCodeApi("claude-opus-4-8")).toBe("anthropic-messages");
		expect(resolveCommandCodeApi("anthropic/claude-sonnet-4-6")).toBe("anthropic-messages");
		expect(resolveCommandCodeApi("gpt-5.5")).toBe("openai-completions");
		expect(resolveCommandCodeApi("openai/gpt-5.5")).toBe("openai-completions");
		expect(resolveCommandCodeApi("google/gemini-3.1-pro")).toBe("openai-completions");
		expect(resolveCommandCodeApi("deepseek/deepseek-v4-flash")).toBe("openai-completions");
	});

	test("normalizes provider overrides per wire", () => {
		expect(resolveCommandCodeBaseUrl("anthropic-messages", "https://proxy.example/provider/v1")).toBe(
			"https://proxy.example/provider",
		);
		expect(resolveCommandCodeBaseUrl("openai-completions", "https://proxy.example/provider/v1")).toBe(
			"https://proxy.example/provider/v1",
		);
		expect(resolveCommandCodeBaseUrl("anthropic-messages", "https://proxy.example/provider")).toBe(
			"https://proxy.example/provider",
		);
		expect(resolveCommandCodeBaseUrl("openai-completions", "https://proxy.example/provider")).toBe(
			"https://proxy.example/provider/v1",
		);
	});

	test("discovers mixed-wire models without inheriting foreign effort routing", async () => {
		const fetch = (async (input: unknown) => {
			expect(String(input)).toBe("https://api.commandcode.ai/provider/v1/models");
			return new Response(
				JSON.stringify({
					data: [
						{ id: "claude-opus-4-8", object: "model" },
						{ id: "gpt-5.5", object: "model" },
						{ id: "kimi-k2", object: "model" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof globalThis.fetch;

		const options = commandCodeModelManagerOptions({ apiKey: "test-key", fetch });
		expect(options.cacheProviderId).not.toBe(
			commandCodeModelManagerOptions({
				apiKey: "test-key",
				baseUrl: "https://proxy.example/provider",
			}).cacheProviderId,
		);
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const byId = new Map(models.map(model => [model.id, model]));

		expect(byId.get("claude-opus-4-8")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.commandcode.ai/provider",
			provider: "command-code",
		});
		expect(byId.get("gpt-5.5")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			provider: "command-code",
			reasoning: true,
		});
		expect(byId.get("kimi-k2")?.thinking).toBeUndefined();
	});
});
