import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { sambanovaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("SambaNova provider discovery", () => {
	test("discovers models with dynamic pricing", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				authorization: headers.get("authorization"),
			});
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "DeepSeek-V3.1",
							object: "model",
							context_length: 131072,
							max_completion_tokens: 7168,
							pricing: { prompt: "0.00000300", completion: "0.00000450" },
						},
						{
							id: "Meta-Llama-3.3-70B-Instruct",
							object: "model",
							context_length: 131072,
							max_completion_tokens: 3072,
							pricing: { prompt: "0.00000060", completion: "0.00000120" },
						},
						{
							id: "gemma-4-31B-it",
							object: "model",
							context_length: 131072,
							max_completion_tokens: 131072,
							pricing: { prompt: "0.00000038", completion: "0.00000115" },
						},
						{
							id: "gpt-oss-120b",
							object: "model",
							context_length: 131072,
							max_completion_tokens: 131072,
							pricing: { prompt: "0.00000022", completion: "0.00000059" },
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = sambanovaModelManagerOptions({ apiKey: "sambanova-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.sambanova.ai/v1/models",
				authorization: "Bearer sambanova-test-key",
			},
		]);

		const deepseek = models?.find(model => model.id === "DeepSeek-V3.1");
		expect(deepseek).toMatchObject({
			provider: "sambanova",
			api: "openai-completions",
			contextWindow: 131072,
			maxTokens: 7168,
			cost: { input: 3, output: 4.5, cacheRead: 0, cacheWrite: 0 },
		});

		const llama = models?.find(model => model.id === "Meta-Llama-3.3-70B-Instruct");
		expect(llama).toMatchObject({
			provider: "sambanova",
			api: "openai-completions",
			cost: { input: 0.6, output: 1.2, cacheRead: 0, cacheWrite: 0 },
		});

		const gemma = models?.find(model => model.id === "gemma-4-31B-it");
		expect(gemma).toMatchObject({
			provider: "sambanova",
			api: "openai-completions",
			contextWindow: 131072,
			maxTokens: 131072,
			cost: { input: 0.38, output: 1.15, cacheRead: 0, cacheWrite: 0 },
		});

		const gptOss = models?.find(model => model.id === "gpt-oss-120b");
		expect(gptOss).toMatchObject({
			provider: "sambanova",
			api: "openai-completions",
			contextWindow: 131072,
			maxTokens: 131072,
			cost: { input: 0.22, output: 0.59, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("handles cache pricing fields", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "MiniMax-M3",
							object: "model",
							context_length: 1048576,
							max_completion_tokens: 1048576,
							pricing: {
								prompt: "0.00000060",
								completion: "0.00000240",
								input_cache_read: "0.00000006",
								input_cache_write: "0.00000000",
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const options = sambanovaModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "MiniMax-M3");
		expect(model).toMatchObject({
			provider: "sambanova",
			api: "openai-completions",
			contextWindow: 1048576,
			maxTokens: 1048576,
			cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0 },
		});
	});

	test("malformed prices are treated as unpriced, not free", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "gpt-oss-120b",
							object: "model",
							context_length: 131072,
							max_completion_tokens: 131072,
							pricing: { prompt: "abc", completion: "-1" },
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const options = sambanovaModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "gpt-oss-120b");
		expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("filters non-chat SKUs from discovery", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "DeepSeek-V3.1",
							object: "model",
							context_length: 131072,
							max_completion_tokens: 7168,
						},
						{
							id: "E5-Mistral-7B-Instruct",
							object: "model",
							context_length: 32768,
							max_completion_tokens: 4096,
						},
						{
							id: "Whisper-large-v3",
							object: "model",
							context_length: 0,
							max_completion_tokens: 0,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const options = sambanovaModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		const ids = models?.map(m => m.id) ?? [];
		expect(ids).toContain("DeepSeek-V3.1");
		expect(ids).not.toContain("E5-Mistral-7B-Instruct");
		expect(ids).not.toContain("Whisper-large-v3");
	});

	test("cascade resolves reasoning and vision from KDL", () => {
		// DeepSeek-V3.x variants — all reasoning-capable via class selector
		for (const id of ["DeepSeek-V3.1", "DeepSeek-V3.2", "DeepSeek-V3.1-Terminus", "deepseek-v3.1"]) {
			const model = buildModel({
				id,
				name: id,
				api: "openai-completions",
				provider: "sambanova",
				baseUrl: "https://api.sambanova.ai/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 7168,
			});
			expect(model.reasoning).toBe(true);
			expect(model.thinking).toBeDefined();
			expect(model.input).toEqual(["text"]);
		}

		// gpt-oss — reasoning-capable
		const gptOss = buildModel({
			id: "gpt-oss-120b",
			name: "GPT OSS 120B",
			api: "openai-completions",
			provider: "sambanova",
			baseUrl: "https://api.sambanova.ai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 131072,
		});
		expect(gptOss.reasoning).toBe(true);

		// MiniMax-M3 — reasoning-capable (residue rule)
		const minimaxM3 = buildModel({
			id: "MiniMax-M3",
			name: "MiniMax M3",
			api: "openai-completions",
			provider: "sambanova",
			baseUrl: "https://api.sambanova.ai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 1048576,
		});
		expect(minimaxM3.reasoning).toBe(true);

		// MiniMax-M3.1 — reasoning-capable (residue rule)
		const minimaxM31 = buildModel({
			id: "MiniMax-M3.1",
			name: "MiniMax M3.1",
			api: "openai-completions",
			provider: "sambanova",
			baseUrl: "https://api.sambanova.ai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 1048576,
		});
		expect(minimaxM31.reasoning).toBe(true);

		// MiniMax-M2 — NOT reasoning-capable
		const minimaxM2 = buildModel({
			id: "MiniMax-M2",
			name: "MiniMax M2",
			api: "openai-completions",
			provider: "sambanova",
			baseUrl: "https://api.sambanova.ai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 131072,
		});
		expect(minimaxM2.reasoning).toBe(false);

		// Gemma 4 variants — reasoning + vision
		for (const id of ["gemma-4-31B-it", "Gemma-4-31B-it", "gemma-4-12B-it"]) {
			const model = buildModel({
				id,
				name: id,
				api: "openai-completions",
				provider: "sambanova",
				baseUrl: "https://api.sambanova.ai/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 131072,
			});
			expect(model.reasoning).toBe(true);
			expect(model.input).toEqual(["text", "image"]);
		}

		// Gemma 3 — NOT reasoning-capable, text-only
		const gemma3 = buildModel({
			id: "gemma-3-27b-it",
			name: "Gemma 3 27B IT",
			api: "openai-completions",
			provider: "sambanova",
			baseUrl: "https://api.sambanova.ai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 131072,
		});
		expect(gemma3.reasoning).toBe(false);
		expect(gemma3.input).toEqual(["text"]);

		// Non-reasoning models stay non-reasoning
		const llama = buildModel({
			id: "Meta-Llama-3.3-70B-Instruct",
			name: "Llama 3.3 70B",
			api: "openai-completions",
			provider: "sambanova",
			baseUrl: "https://api.sambanova.ai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 3072,
		});
		expect(llama.reasoning).toBe(false);
	});

	test("skips fetch when no API key is provided", () => {
		const options = sambanovaModelManagerOptions({});
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});
