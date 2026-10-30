import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { inceptionModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

// /models publishes per-token decimal strings, but omits reasoning support.
const chatMetadata = {
	input_modalities: ["text"],
	supported_features: ["tools", "structured_outputs"],
	supported_endpoints: ["chat.completions"],
};

describe("Inception model discovery", () => {
	test("removes unavailable models after discovery and preserves that roster during an outage", async () => {
		await using temp = await TempDir.create("@inception-roster-");
		let unavailable = false;
		const options = {
			...inceptionModelManagerOptions({
				apiKey: "inception-test-key",
				fetch: async () =>
					unavailable
						? new Response(null, { status: 503 })
						: Response.json({
								data: [
									{ ...chatMetadata, id: "mercury-3" },
									{ id: "mercury-2", supported_endpoints: ["decisions"] },
								],
							}),
			}),
			cacheDbPath: temp.join("models.db"),
		};
		const online = await resolveProviderModels(options, "online");
		expect(online.models.map(model => model.id)).toEqual(["mercury-3"]);

		unavailable = true;
		const fallback = await resolveProviderModels(options, "online");
		expect(fallback.models.map(model => model.id)).toEqual(["mercury-3"]);
	});

	test("retains context and output limits for newly discovered chat models", async () => {
		const options = inceptionModelManagerOptions({
			apiKey: "inception-test-key",
			fetch: async () =>
				Response.json({
					data: [{ ...chatMetadata, id: "mercury-chat-new", context_length: 750_000, max_output_length: 32_768 }],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(buildModel(models![0])).toMatchObject({ contextWindow: 750_000, maxTokens: 32_768 });
	});

	test("preserves live limits, converts per-token prices, and excludes non-chat endpoints", async () => {
		const options = inceptionModelManagerOptions({
			apiKey: "inception-test-key",
			fetch: async () =>
				Response.json({
					data: [
						{
							...chatMetadata,
							id: "mercury-2",
							context_length: 256_000,
							max_output_length: 40_000,
							pricing: {
								prompt: "0.00000025",
								completion: "0.00000075",
								input_cache_reads: "0.000000025",
								input_cache_writes: "0",
							},
						},
						{ id: "mercury-decide", supported_endpoints: ["decisions"] },
						{ id: "mercury-unadvertised" },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["mercury-2"]);
		const model = buildModel(models![0]);
		expect(model).toMatchObject({
			contextWindow: 256_000,
			maxTokens: 40_000,
			input: ["text"],
			supportsTools: true,
			cost: { input: 0.25, output: 0.75, cacheWrite: 0 },
			reasoning: true,
			thinking: {
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				effortMap: { minimal: "instant" },
			},
		});
		expect(model.cost.cacheRead).toBeCloseTo(0.025);
	});

	test("prices zero-priced Mercury 3 at the launch rate until /models publishes a tariff", async () => {
		const discoverMercury3 = async (pricing: Record<string, string>) => {
			const options = inceptionModelManagerOptions({
				apiKey: "inception-test-key",
				fetch: async () =>
					Response.json({
						data: [
							{
								...chatMetadata,
								id: "mercury-3",
								context_length: 1_000_000,
								max_output_length: 131_072,
								pricing,
							},
						],
					}),
			});
			const models = await options.fetchDynamicModels?.();
			return buildModel(models![0]);
		};

		const zeroPriced = await discoverMercury3({
			prompt: "0",
			completion: "0",
			input_cache_reads: "0",
			input_cache_writes: "0",
		});
		expect(zeroPriced).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			reasoning: true,
			cost: { input: 0.1, output: 0.35, cacheRead: 0.01, cacheWrite: 0 },
			thinking: { efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		});

		const listPriced = await discoverMercury3({
			prompt: "0.0000002",
			completion: "0.0000007",
			input_cache_reads: "0.00000002",
			input_cache_writes: "0",
		});
		expect(listPriced.cost.input).toBeCloseTo(0.2);
		expect(listPriced.cost.output).toBeCloseTo(0.7);
		expect(listPriced.cost.cacheRead).toBeCloseTo(0.02);
	});
});
