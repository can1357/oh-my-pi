import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { dagonModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Dagon Inference model discovery", () => {
	test("discovers without an API key and maps limits, modalities, and micro-USD prices", async () => {
		let authorization: string | null = "unset";
		const options = dagonModelManagerOptions({
			fetch: async (_input, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return Response.json({
					object: "list",
					data: [
						{
							id: "dagon-new-model",
							name: "Dagon New Model",
							deprecated: false,
							context_length: 1_048_576,
							max_output_tokens: 943_718,
							input_modalities: ["text", "image"],
							supported_parameters: ["tools", "reasoning"],
							pricing_per_mtok_micros: {
								inputPerMtok: 88_000,
								cachedInputPerMtok: 17_600,
								outputPerMtok: 352_000,
							},
						},
						{
							id: "dagon-retired",
							deprecated: true,
							context_length: 1_000_000,
							max_output_tokens: 65_536,
							input_modalities: ["text"],
						},
					],
				});
			},
		});
		const models = await options.fetchDynamicModels?.();
		expect(authorization).toBeNull();
		expect(models?.map(model => model.id)).toEqual(["dagon-new-model"]);
		const model = buildModel(models![0]);
		expect(model).toMatchObject({
			name: "Dagon New Model",
			api: "openai-completions",
			baseUrl: "https://inference.dagon.so/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 943_718,
		});
		expect(model.cost.input).toBeCloseTo(0.088);
		expect(model.cost.output).toBeCloseTo(0.352);
		expect(model.cost.cacheRead).toBeCloseTo(0.0176);
		expect(model.cost.cacheWrite).toBe(0);
	});

	test("keeps a live zero price instead of reverting to the bundled seed rate", async () => {
		const options = dagonModelManagerOptions({
			fetch: async () =>
				Response.json({
					object: "list",
					data: [
						{
							// Bundled with a nonzero seed price.
							id: "deepseek-v4.1-flash-abliterated",
							name: "DeepSeek V4.1 Flash Abliterated",
							context_length: 1_048_576,
							max_output_tokens: 65_536,
							input_modalities: ["text"],
							pricing_per_mtok_micros: { inputPerMtok: 0, cachedInputPerMtok: 0, outputPerMtok: 0 },
						},
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["deepseek-v4.1-flash-abliterated"]);
		expect(models![0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("bundles the default model", () => {
		const ids = getBundledModels("dagon").map(model => model.id);
		expect(ids).toContain("deepseek-v4.1-flash-abliterated");
	});
});
