import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { requestyModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resolveProviderApiKey } from "../scripts/generate-models";

function requestyCatalog(rows: Record<string, unknown>[]) {
	return requestyModelManagerOptions({ fetch: async () => Response.json({ data: rows }) });
}

async function discover(rows: Record<string, unknown>[]) {
	const models = await requestyCatalog(rows).fetchDynamicModels?.();
	if (!models) throw new Error("Expected Requesty discovery to return models");
	return models;
}

describe("Requesty built-in provider", () => {
	test("maps Requesty model catalog metadata from the public endpoint", async () => {
		const requests: string[] = [];
		const fetchMock = async (input: string | URL | Request): Promise<Response> => {
			requests.push(input.toString());
			return Response.json({
				data: [
					{
						id: "anthropic/claude-3-7-sonnet",
						name: "Claude 3.7 Sonnet",
						supports_reasoning: true,
						supports_vision: true,
						input_price: 0.000003,
						output_price: 0.000015,
						cached_price: 0.0000003,
						caching_price: 0.00000375,
						context_window: 200000,
						max_output_tokens: 64000,
					},
					{
						id: "openai/gpt-4o-mini",
						name: "GPT-4o mini",
						supports_reasoning: false,
						supports_vision: true,
						input_price: 0.00000015,
						output_price: 0.0000006,
						cached_price: 0.000000075,
						caching_price: 0,
						context_window: 128000,
						max_output_tokens: 16384,
					},
					{
						id: "bedrock/claude-sonnet-4-6@us-east-1",
						name: "Claude Sonnet 4.6 Bedrock",
						supports_reasoning: true,
						supports_vision: true,
						context_window: 200000,
						max_output_tokens: 64000,
					},
				],
			});
		};

		const options = requestyModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const claude = models?.find(item => item.id === "anthropic/claude-3-7-sonnet");
		const gpt = models?.find(item => item.id === "openai/gpt-4o-mini");

		expect(requests).toEqual(["https://router.requesty.ai/v1/models"]);
		expect(models?.map(item => item.id)).toEqual([
			"anthropic/claude-3-7-sonnet",
			"bedrock/claude-sonnet-4-6@us-east-1",
			"openai/gpt-4o-mini",
		]);

		expect(claude?.provider).toBe("requesty");
		expect(claude?.baseUrl).toBe("https://router.requesty.ai/v1");
		expect(claude?.api).toBe("anthropic-messages");
		expect(claude?.name).toBe("Claude 3.7 Sonnet");
		expect(claude?.reasoning).toBe(true);
		expect(claude?.input).toEqual(["text", "image"]);
		expect(claude?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		expect(claude?.contextWindow).toBe(200000);
		expect(claude?.maxTokens).toBe(64000);

		expect(gpt?.reasoning).toBe(false);
		expect(gpt?.api).toBe("openai-completions");
		expect(gpt?.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 });
		const bedrockClaude = models?.find(item => item.id === "bedrock/claude-sonnet-4-6@us-east-1");
		expect(bedrockClaude?.api).toBe("anthropic-messages");
	});

	test("maps prompt-size pricing tiers to the base rate card and long-context rates", async () => {
		const tiers = [
			{
				prompt_tokens_threshold: 0,
				input_price: 3e-6,
				output_price: 15e-6,
				cached_price: 3e-7,
				caching_price: 3.75e-6,
			},
			{
				prompt_tokens_threshold: 200000,
				input_price: 6e-6,
				output_price: 22.5e-6,
				cached_price: 6e-7,
				caching_price: 7.5e-6,
			},
		];
		const models = await discover([
			{ id: "vertex/claude-sonnet-4-6@review", input_price: 3e-6, output_price: 15e-6, pricing: tiers },
			// Requesty's documented List Models example carries only the tier array.
			{ id: "vertex/claude-sonnet-4-6@tier-only", pricing: tiers },
		]);
		const expected = {
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
			longContext: { inputThreshold: 200000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 },
		};
		expect(models.find(model => model.id === "vertex/claude-sonnet-4-6@review")?.cost).toEqual(expected);
		expect(models.find(model => model.id === "vertex/claude-sonnet-4-6@tier-only")?.cost).toEqual(expected);
	});

	test("maps reported tool support in both directions, overriding the bundled row", async () => {
		// `azure/decision-1` is bundled tool-less; a live `true` must win.
		const models = await discover([
			{ id: "azure/decision-1", supports_tool_calling: true },
			{ id: "review/no-tools", supports_tool_calling: false },
		]);
		expect(models.find(model => model.id === "azure/decision-1")?.supportsTools).toBe(true);
		expect(models.find(model => model.id === "review/no-tools")?.supportsTools).toBe(false);
	});

	test("repairs reasoning Requesty under-reports through the provider rules, not discovery", async () => {
		const models = await discover([
			{ id: "vertex/claude-haiku-4-5@us-east5", model_lab: "anthropic", supports_reasoning: false },
			{ id: "openai/gpt-4o-mini", model_lab: "openai", supports_reasoning: false },
		]);
		const claude = models.find(model => model.id === "vertex/claude-haiku-4-5@us-east5");
		const gpt = models.find(model => model.id === "openai/gpt-4o-mini");
		if (!claude || !gpt) throw new Error("Expected both discovered rows");
		expect(claude.reasoning).toBe(false);
		const built = buildModel(claude);
		expect(built.reasoning).toBe(true);
		expect(built.thinking?.efforts.length).toBeGreaterThan(0);
		expect(buildModel(gpt).reasoning).toBe(false);
	});

	test("treats a live free rate card as authoritative, including the absent long-context tier", async () => {
		await using temp = await TempDir.create("@requesty-cost-");
		const zero = { input_price: 0, output_price: 0, cached_price: 0, caching_price: 0 };
		const options = {
			...requestyCatalog([
				// `openai/gpt-5.5` is bundled with a paid tier above 272k input tokens.
				{ id: "openai/gpt-5.5", ...zero, pricing: [{ prompt_tokens_threshold: 0, ...zero }] },
				// No tier array at all: missing metadata keeps the bundled tier.
				{ id: "openai/gpt-5.5:flex", input_price: 1e-6, output_price: 2e-6 },
			]),
			cacheDbPath: temp.join("models.db"),
		};
		const { models } = await resolveProviderModels(options, "online");
		const free = models.find(model => model.id === "openai/gpt-5.5");
		if (!free) throw new Error("Expected the free route");
		expect(free.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const longPrompt = { input: 300_000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 301_000 };
		expect(
			calculateCost(free, { ...longPrompt, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
				.total,
		).toBe(0);
		expect(models.find(model => model.id === "openai/gpt-5.5:flex")?.cost.longContext?.inputThreshold).toBe(272000);
	});

	test("catalog generation never uses a local Requesty key", async () => {
		const discovery = PROVIDER_DESCRIPTORS.find(item => item.providerId === "requesty")?.catalogDiscovery;
		if (!discovery) throw new Error("Expected Requesty catalog discovery");
		const original = Bun.env.REQUESTY_API_KEY;
		Bun.env.REQUESTY_API_KEY = "rqsty-sk-local-account";
		try {
			expect(await resolveProviderApiKey("requesty", discovery)).toBeUndefined();
			expect(await resolveProviderApiKey("requesty", { ...discovery, ignoreApiKey: false })).toBe(
				"rqsty-sk-local-account",
			);
		} finally {
			if (original === undefined) delete Bun.env.REQUESTY_API_KEY;
			else Bun.env.REQUESTY_API_KEY = original;
		}
	});
});
