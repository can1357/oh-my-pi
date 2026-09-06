import { describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
import { fetchCodexModels } from "../src/discovery/codex";
import { Effort } from "../src/effort";
import { openaiModelManagerOptions } from "../src/provider-models/openai-compat";

const astraEfforts = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max, Effort.Ultra];

async function discoverCodex(overrides: Record<string, unknown> = {}) {
	return fetchCodexModels({
		accessToken: "test-token",
		clientVersion: "1.0.0",
		fetchFn: Object.assign(
			async () =>
				Response.json({
					models: [
						{
							slug: "gpt-6-astra",
							context_window: 272_000,
							default_reasoning_level: "low",
							supported_reasoning_levels: astraEfforts.map(effort => ({ effort })),
							multi_agent_reasoning_effort: "xhigh",
							input_modalities: ["text", "image"],
							prefer_websockets: true,
							...overrides,
						},
					],
				}),
			{ preconnect: fetch.preconnect },
		),
	});
}

describe("Astra discovery capabilities", () => {
	it("preserves the Codex ladder, Ultra mapping, default and transport through model build", async () => {
		const result = await discoverCodex();
		const spec = result?.models[0];
		if (!spec) throw new Error("Astra was not discovered");
		const model = buildModel(spec);
		expect(model.thinking?.efforts).toEqual(astraEfforts);
		expect(model.thinking?.defaultLevel).toBe(Effort.Low);
		expect(model.thinking?.effortMap?.[Effort.Ultra]).toBe("xhigh");
		expect(model.preferWebsockets).toBe(true);
		expect(model.contextWindow).toBe(272_000);
		expect(model.input).toEqual(["text", "image"]);
	});

	it("uses supported max rather than an invalid multi-agent override", async () => {
		const result = await discoverCodex({ multi_agent_reasoning_effort: "unsupported" });
		expect(result?.models[0]?.thinking?.effortMap?.[Effort.Ultra]).toBe("max");
	});

	it("deduplicates and orders recognized levels without inventing unsupported capabilities", async () => {
		const result = await discoverCodex({
			supported_reasoning_levels: [
				{ effort: "high" },
				null,
				{ effort: "low" },
				{ effort: "high" },
				{ effort: "future" },
			],
			default_reasoning_level: "max",
		});
		const spec = result?.models[0];
		if (!spec) throw new Error("Astra was not discovered");
		expect(buildModel(spec).thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		expect(spec.thinking?.defaultLevel).toBeUndefined();
		expect(spec.thinking?.effortMap).toBeUndefined();
	});

	it("retains legacy inference when the backend omits the effort list", async () => {
		const result = await discoverCodex({ supported_reasoning_levels: undefined });
		const spec = result?.models[0];
		if (!spec) throw new Error("Astra was not discovered");
		expect(spec.thinking).toBeUndefined();
		expect(buildModel(spec).thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
	});

	it("enriches the direct API model without copying Codex limits or inventing other GPT-6 variants", async () => {
		const options = openaiModelManagerOptions({
			apiKey: "test-token",
			fetch: async () => Response.json({ data: [{ id: "gpt-6-astra" }, { id: "gpt-6-unknown" }] }),
		});
		const specs = await options.fetchDynamicModels?.();
		const spec = specs?.find(model => model.id === "gpt-6-astra");
		if (!spec) throw new Error("Astra was not discovered");
		const model = buildModel(spec);
		expect(model.api).toBe("openai-responses");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1_050_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.thinking?.efforts).toEqual(astraEfforts.filter(effort => effort !== Effort.Ultra));
		expect(model.thinking?.requiresEffort).toBe(true);
		expect(specs?.find(model => model.id === "gpt-6-unknown")?.reasoning).toBe(false);
	});
});
