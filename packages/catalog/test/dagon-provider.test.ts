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
							supported_parameters: ["tools"],
							reasoning: true,
							supported_reasoning_levels: ["low", "high", "max"],
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

	test("maps advertised reasoning levels and treats a listed none as the off-switch", async () => {
		const options = dagonModelManagerOptions({
			fetch: async () =>
				Response.json({
					object: "list",
					data: [
						{
							id: "dagon-with-none",
							reasoning: true,
							supported_reasoning_levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
							input_modalities: ["text"],
						},
						{
							id: "dagon-without-none",
							reasoning: true,
							supported_reasoning_levels: ["low", "high", "max"],
							input_modalities: ["text"],
						},
						{ id: "dagon-silent", input_modalities: ["text"] },
						{
							// Bundled with a none-effort ladder; the live row now says it does not reason.
							id: "hy4",
							reasoning: false,
							input_modalities: ["text"],
						},
					],
				}),
		});
		const specs = await options.fetchDynamicModels?.();
		const byId = new Map(specs!.map(spec => [spec.id, buildModel(spec)]));

		const withNone = byId.get("dagon-with-none")!;
		expect(withNone.reasoning).toBe(true);
		expect(withNone.thinking).toMatchObject({ mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] });
		expect(withNone.compat.reasoningDisableMode).toBe("none-effort");

		const withoutNone = byId.get("dagon-without-none")!;
		expect(withoutNone.reasoning).toBe(true);
		expect(withoutNone.thinking).toMatchObject({ mode: "effort", efforts: ["low", "high", "max"] });
		expect(withoutNone.compat.reasoningDisableMode).toBe("lowest-effort");

		const silent = byId.get("dagon-silent")!;
		expect(silent.reasoning).toBe(false);
		expect(silent.thinking).toBeUndefined();

		const hy4 = byId.get("hy4")!;
		expect(hy4.reasoning).toBe(false);
		expect(hy4.thinking).toBeUndefined();
	});

	test("a live ladder outranks the bundled one for a seeded id", async () => {
		const options = dagonModelManagerOptions({
			fetch: async () =>
				Response.json({
					object: "list",
					data: [
						{
							// Bundled as low/high/max without an off-switch.
							id: "glm-5.3-abliterated",
							reasoning: true,
							supported_reasoning_levels: ["none", "medium"],
							input_modalities: ["text"],
						},
						{
							// Bundled with the `none` off-switch; the live row drops it.
							id: "kimi-k3.1-pro-abliterated",
							reasoning: true,
							supported_reasoning_levels: ["low", "high"],
							input_modalities: ["text"],
						},
					],
				}),
		});
		const specs = await options.fetchDynamicModels?.();
		const [glm, kimi] = specs!.map(spec => buildModel(spec));
		expect(glm.thinking).toMatchObject({ efforts: ["medium"] });
		expect(glm.compat.reasoningDisableMode).toBe("none-effort");
		expect(kimi.thinking).toMatchObject({ efforts: ["low", "high"] });
		expect(kimi.compat.reasoningDisableMode).toBe("lowest-effort");
	});

	test("bundles the verified reasoning ladders", () => {
		const expected: Record<string, { efforts: string[]; offSwitch: boolean }> = {
			"abliterated-model": { efforts: ["low", "medium", "high", "xhigh", "max"], offSwitch: true },
			"abliterated-model-large-flash": { efforts: ["low", "high", "max"], offSwitch: true },
			"abliterated-model-large-v2": { efforts: ["low", "high", "max"], offSwitch: false },
			"glm-5.3-abliterated": { efforts: ["low", "high", "max"], offSwitch: false },
			"glm-5.3-flash-abliterated": { efforts: ["low", "high", "max"], offSwitch: false },
			"deepseek-v4.1-flash-abliterated": { efforts: ["low", "high", "max"], offSwitch: false },
			"kimi-k3.1-pro-abliterated": { efforts: ["low", "high", "max"], offSwitch: true },
			hy4: { efforts: ["high"], offSwitch: true },
		};
		for (const model of getBundledModels("dagon")) {
			const want = expected[model.id];
			expect(model.reasoning).toBe(true);
			expect(model.thinking).toMatchObject({ mode: "effort", efforts: want.efforts });
			const compat = model.compat ?? {};
			expect("reasoningDisableMode" in compat && compat.reasoningDisableMode === "none-effort").toBe(want.offSwitch);
		}
	});

	test("bundles the default model", () => {
		const ids = getBundledModels("dagon").map(model => model.id);
		expect(ids).toContain("deepseek-v4.1-flash-abliterated");
	});
});
