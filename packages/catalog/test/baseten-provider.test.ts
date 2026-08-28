import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { basetenModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Baseten provider discovery", () => {
	test("discovers Baseten models with custom metadata", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				authorization: headers.get("authorization"),
			});
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "moonshotai/Kimi-K2.7-Code",
							object: "model",
							name: "Kimi K2.7 Code",
							context_length: 262000,
							max_completion_tokens: 262000,
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
							input_modalities: ["text", "image"],
							pricing: {
								prompt: "0.00000095",
								completion: "0.000004",
								input_cache_read: "0.00000016",
							},
						},
						{
							id: "moonshotai/Kimi-K3",
							object: "model",
							name: "Kimi K3",
							context_length: 1048576,
							max_completion_tokens: 262144,
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning_effort"],
							input_modalities: ["text", "image"],
							pricing: {
								prompt: "0.000003",
								completion: "0.000015",
								input_cache_read: "0.0000003",
							},
						},
						{
							id: "deepseek-ai/DeepSeek-V4-Pro",
							object: "model",
							name: "DeepSeek V4 Pro",
							context_length: 262144,
							max_completion_tokens: 262144,
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
							input_modalities: ["text"],
							pricing: {
								prompt: "0.00000174",
								completion: "0.00000348",
								input_cache_read: "0.000000145",
							},
						},
						{
							id: "zai-org/GLM-5.2-Fast",
							object: "model",
							name: "GLM 5.2 Fast",
							context_length: 524288,
							max_completion_tokens: 262144,
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
							input_modalities: ["text"],
							pricing: {
								prompt: "0.0000021",
								completion: "0.0000066",
								input_cache_read: "0.00000021",
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = basetenModelManagerOptions({ apiKey: "baseten-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://inference.baseten.co/v1/models",
				authorization: "Bearer baseten-test-key",
			},
		]);

		const kimi = models?.find(model => model.id === "moonshotai/Kimi-K2.7-Code");
		expect(kimi).toBeDefined();
		expect(kimi).toMatchObject({
			provider: "baseten",
			api: "openai-completions",
			name: "Kimi K2.7 Code",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: 262000,
			maxTokens: 262000,
			cost: {
				input: 0.95,
				output: 4,
				cacheRead: 0.16,
				cacheWrite: 0,
			},
		});

		const kimiK3 = models?.find(model => model.id === "moonshotai/Kimi-K3");
		if (!kimiK3) throw new Error("Baseten Kimi K3 was not discovered");
		expect(kimiK3.reasoning).toBe(true);
		expect(buildModel(kimiK3).thinking).toMatchObject({
			mode: "effort",
			efforts: ["low", "high", "max"],
			defaultLevel: "max",
		});

		const deepseek = models?.find(model => model.id === "deepseek-ai/DeepSeek-V4-Pro");
		expect(deepseek).toBeDefined();
		expect(deepseek).toMatchObject({
			provider: "baseten",
			api: "openai-completions",
			name: "DeepSeek V4 Pro",
			reasoning: true,
			input: ["text"],
			contextWindow: 262144,
			maxTokens: 262144,
			cost: {
				input: 1.74,
				output: 3.48,
				cacheRead: 0.145,
				cacheWrite: 0,
			},
		});

		const glmFast = models?.find(model => model.id === "zai-org/GLM-5.2-Fast");
		expect(glmFast).toBeDefined();
		if (!glmFast) throw new Error("Baseten GLM-5.2 Fast was not discovered");
		expect(buildModel(glmFast).thinking).toMatchObject({
			mode: "effort",
			efforts: ["high", "max"],
		});
	});
});
