import { describe, expect, it } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function createOllamaModel() {
	return buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "What is 17*23?", timestamp: 0 }],
};

describe("Ollama chat usage accounting", () => {
	it("maps prompt_eval_cached_count to cacheRead and subtracts it from input", async () => {
		const fetchMock = async (): Promise<Response> => {
			return new Response(
				'{"message":{"content":"391"},"done":true,"done_reason":"stop","prompt_eval_count":1000,"prompt_eval_cached_count":800,"eval_count":50}\n',
				{ status: 200 },
			);
		};

		const result = await streamOllama(createOllamaModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.usage.cacheRead).toBe(800);
		expect(result.usage.input).toBe(200);
		expect(result.usage.output).toBe(50);
		expect(result.usage.totalTokens).toBe(1050);
	});

	it("keeps local behavior when prompt_eval_cached_count is absent", async () => {
		const fetchMock = async (): Promise<Response> => {
			return new Response(
				'{"message":{"content":"391"},"done":true,"done_reason":"stop","prompt_eval_count":1000,"eval_count":50}\n',
				{ status: 200 },
			);
		};

		const result = await streamOllama(createOllamaModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.usage.cacheRead).toBe(0);
		expect(result.usage.input).toBe(1000);
		expect(result.usage.output).toBe(50);
		expect(result.usage.totalTokens).toBe(1050);
	});
});
