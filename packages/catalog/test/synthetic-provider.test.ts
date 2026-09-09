import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { syntheticModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Entries mirror live `https://api.synthetic.new/openai/v1/models` payloads:
 * capabilities in `supported_features`, modalities in `input_modalities`, the
 * output cap in `max_output_length`, the accepted `reasoning_effort` values in
 * `reasoning_parameters.efforts`, and `$`-prefixed per-token prices.
 */
type SyntheticPayloadEntry = Record<string, unknown>;

function syntheticModelsFetch(extraEntries: SyntheticPayloadEntry[] = []): {
	calls: string[];
	authorizations: (string | null)[];
	fetch: FetchImpl;
} {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				data: [
					{
						id: "syn:large:text",
						object: "model",
						name: "syn:large:text",
						hugging_face_id: "zai-org/GLM-5.2",
						reasoning_parameters: { efforts: ["none", "high", "max"] },
						input_modalities: ["text"],
						context_length: 524288,
						max_output_length: 65536,
						supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
						pricing: {
							prompt: "$0.000001",
							completion: "$0.000003",
							input_cache_reads: "$0.00000016",
							input_cache_writes: "0",
						},
					},
					{
						id: "hf:moonshotai/Kimi-K3",
						object: "model",
						name: "moonshotai/Kimi-K3",
						reasoning_parameters: { efforts: ["low", "high", "max"] },
						input_modalities: ["text", "image"],
						context_length: 524288,
						max_output_length: 65536,
						supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
						pricing: {
							prompt: "$0.000003",
							completion: "$0.000015",
							input_cache_reads: "$0.00000045",
							input_cache_writes: "0",
						},
					},
					{
						id: "hf:example/plain-completions",
						object: "model",
						name: "example/plain-completions",
						input_modalities: ["text"],
						context_length: 131072,
						supported_features: ["json_mode"],
					},
					...extraEntries,
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

describe("Synthetic provider discovery", () => {
	test("reads capabilities from Synthetic's own schema instead of the bundled reference", async () => {
		const { calls, authorizations, fetch } = syntheticModelsFetch();
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		expect(calls).toEqual(["https://api.synthetic.new/openai/v1/models"]);
		expect(authorizations).toEqual(["Bearer syn-test-key"]);

		// `syn:*` router aliases ship a bundled reference baked from the era when
		// this mapper read field names Synthetic never sends: `reasoning: false`,
		// no thinking, `maxTokens: 8192`, zero cost. The advertised metadata wins.
		const large = models?.find(model => model.id === "syn:large:text");
		expect(large).toMatchObject({
			provider: "synthetic",
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			contextWindow: 524288,
			maxTokens: 65536,
			cost: { input: 1, output: 3, cacheRead: 0.16, cacheWrite: 0 },
		});
		// `none` is the router's thinking-off state, so it backs `minimal`
		// through the wire map rather than becoming a tier of its own.
		expect(large?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.High, Effort.Max],
			effortMap: { minimal: "none" },
		});
		expect(large?.supportsTools).toBeUndefined();
	});

	test("derives reasoning, vision, and output cap for routes with no bundled reference", async () => {
		const { fetch } = syntheticModelsFetch();
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		const kimi = models?.find(model => model.id === "hf:moonshotai/Kimi-K3");
		expect(kimi).toMatchObject({
			provider: "synthetic",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 524288,
			maxTokens: 65536,
			cost: { input: 3, output: 15, cacheRead: 0.45, cacheWrite: 0 },
		});
		// No `none` tier on this route: the ladder is the advertised one verbatim.
		expect(kimi?.thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] });
	});

	test("keeps non-reasoning routes non-reasoning and marks missing tool support", async () => {
		const { fetch } = syntheticModelsFetch();
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		const plain = models?.find(model => model.id === "hf:example/plain-completions");
		expect(plain).toMatchObject({
			provider: "synthetic",
			reasoning: false,
			input: ["text"],
			contextWindow: 131072,
			supportsTools: false,
			// No `max_output_length` and no bundled reference: placeholder cap.
			maxTokens: 8192,
			// No `pricing` block: the reference/default cost survives.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(plain?.thinking).toBeUndefined();
	});

	test("maps a none-only effort vocabulary onto minimal instead of inferring a phantom ladder", async () => {
		const { fetch } = syntheticModelsFetch([
			{
				id: "hf:example/off-switch-only",
				object: "model",
				name: "example/off-switch-only",
				reasoning_parameters: { efforts: ["none"] },
				input_modalities: ["text"],
				context_length: 131072,
				max_output_length: 32768,
				supported_features: ["tools", "reasoning"],
			},
		]);
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		// `none` alone is the router's off state, not a reasoning dial: reporting
		// `reasoning: true` here would let identity inference fabricate an
		// unadvertised low/medium/high ladder for the request layer.
		const offOnly = models?.find(model => model.id === "hf:example/off-switch-only");
		expect(offOnly?.reasoning).toBe(false);
		expect(offOnly?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal],
			effortMap: { minimal: "none" },
		});
	});

	test("overrides a stale bundled reference with the wire's effort vocabulary", async () => {
		// `hf:zai-org/GLM-5.2` ships a bundled reference that is `reasoning: true`
		// with a baked multi-tier ladder. The wire saying the route only accepts
		// `none` must win all the way through `buildModel` — identity tables would
		// otherwise re-expand the off-state into an unadvertised ladder.
		const { fetch } = syntheticModelsFetch([
			{
				id: "hf:zai-org/GLM-5.2",
				object: "model",
				name: "zai-org/GLM-5.2",
				reasoning_parameters: { efforts: ["none"] },
				input_modalities: ["text"],
				context_length: 202752,
				max_output_length: 32768,
				supported_features: ["tools"],
			},
		]);
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		const glmSpec = models?.find(model => model.id === "hf:zai-org/GLM-5.2");
		expect(glmSpec?.reasoning).toBe(false);
		expect(glmSpec?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal],
			effortMap: { minimal: "none" },
		});

		// Production consumes models through `buildModel`; a non-reasoning model
		// must surface no thinking metadata there either.
		const built = buildModel(glmSpec!);
		expect(built.reasoning).toBe(false);
		expect(built.thinking).toBeUndefined();
	});

	test("treats a single advertised tier as reasoning, unlike the none-only off-switch", async () => {
		// `high` alone is a real wire-accepted effort, not an off-switch: the
		// model must stay reasoning so `reasoning_effort: "high"` reaches it.
		const { fetch } = syntheticModelsFetch([
			{
				id: "hf:example/single-tier",
				object: "model",
				name: "example/single-tier",
				reasoning_parameters: { efforts: ["high"] },
				input_modalities: ["text"],
				context_length: 131072,
				max_output_length: 32768,
				supported_features: ["tools", "reasoning"],
			},
		]);
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		const single = models?.find(model => model.id === "hf:example/single-tier");
		expect(single?.reasoning).toBe(true);
		expect(single?.thinking).toEqual({ mode: "effort", efforts: [Effort.High] });
		expect(buildModel(single!).thinking).toEqual({ mode: "effort", efforts: [Effort.High] });
	});

	test("treats an explicitly empty supported_features list as authoritative no-tools", async () => {
		// A present-but-empty array is the route advertising zero features, not a
		// missing field: the model must come out tool-less so the request layer
		// does not offer tools to a route that rejects them.
		const { fetch } = syntheticModelsFetch([
			{
				id: "hf:example/no-features",
				object: "model",
				name: "example/no-features",
				input_modalities: ["text"],
				context_length: 131072,
				supported_features: [],
			},
		]);
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		const bare = models?.find(model => model.id === "hf:example/no-features");
		expect(bare?.supportsTools).toBe(false);
		expect(bare?.reasoning).toBe(false);
	});

	test("keeps the wire-off state authoritative through the production manager merge", async () => {
		// The CLI resolves models through `createModelManager`, which merges the
		// dynamic row over the bundled reference. `hf:zai-org/GLM-5.2` has a baked
		// `reasoning: true` reference; without the wire-vocabulary override the
		// merge would OR that flag back and `buildModel` would fabricate a ladder
		// for a route that advertised only `none`.
		const { fetch } = syntheticModelsFetch([
			{
				id: "hf:zai-org/GLM-5.2",
				object: "model",
				name: "zai-org/GLM-5.2",
				reasoning_parameters: { efforts: ["none"] },
				input_modalities: ["text"],
				context_length: 202752,
				max_output_length: 32768,
				supported_features: ["tools"],
			},
		]);
		const manager = createModelManager(syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }));
		const { models } = await manager.refresh("online");

		const glm = models.find(model => model.id === "hf:zai-org/GLM-5.2");
		expect(glm?.reasoning).toBe(false);
		expect(glm?.thinking).toBeUndefined();
	});

	test("serves no dynamic models without an API key", () => {
		expect(syntheticModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});
});
