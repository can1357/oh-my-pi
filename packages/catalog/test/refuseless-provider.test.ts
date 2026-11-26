import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { carriesReasoning } from "@oh-my-pi/pi-catalog/compat/reasoning-carry";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { refuselessModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/** Rows mirror keyed `GET https://api.refuseless.com/v1/models` (2026-11-25). */
const GLM_ROW = {
	id: "glm-5.3-abliterated",
	object: "model",
	owned_by: "refuseless",
	abliterated: true,
	vision: false,
	context_length: 1048576,
	reasoning_efforts: ["low", "high", "max"],
	reasoning_default: "low",
	pricing: { currency: "USD", input_per_m: 0.9, cached_input_per_m: 0.12, output_per_m: 1.8 },
};

const DEEPSEEK_ROW = {
	id: "deepseek-v4.1-flash-abliterated",
	object: "model",
	owned_by: "refuseless",
	abliterated: true,
	vision: true,
	context_length: 1048576,
	reasoning_efforts: ["off", "low", "high", "max"],
	reasoning_default: "low",
	pricing: { currency: "USD", input_per_m: 0.12, cached_input_per_m: 0.019, output_per_m: 0.45 },
};

async function discover(data: Record<string, unknown>[]) {
	const requests: { url: string; authorization: string | null }[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return Response.json({ object: "list", data });
	};
	const specs = await refuselessModelManagerOptions({ apiKey: "abl_test", fetch }).fetchDynamicModels?.();
	return { requests, models: (specs ?? []).map(spec => buildModel(spec)) };
}

describe("Refuseless discovery", () => {
	test("maps each row's effort ladder, vision flag, and billed rates", async () => {
		const { requests, models } = await discover([GLM_ROW, DEEPSEEK_ROW]);

		expect(requests).toEqual([{ url: "https://api.refuseless.com/v1/models", authorization: "Bearer abl_test" }]);
		expect(models.find(model => model.id === GLM_ROW.id)).toMatchObject({
			name: "GLM 5.3 Abliterated",
			input: ["text"],
			contextWindow: 1048576,
			maxTokens: 131072,
			cost: { input: 0.9, output: 1.8, cacheRead: 0.12, cacheWrite: 0 },
			thinking: { efforts: [Effort.Low, Effort.High, Effort.Max], requiresEffort: true },
		});
		const deepseek = models.find(model => model.id === DEEPSEEK_ROW.id);
		expect(deepseek?.input).toEqual(["text", "image"]);
		expect(deepseek?.thinking?.requiresEffort).toBe(false);
		expect(deepseek?.compat).toMatchObject({ reasoningDisableMode: "none-effort" });
	});

	test("a row without optional fields keeps its seed values", async () => {
		const { models } = await discover([{ id: "glm-5.3-flash-abliterated", object: "model" }]);

		expect(models[0]).toMatchObject({
			name: "GLM 5.3 Flash Abliterated",
			input: ["text", "image"],
			cost: { input: 0.12, output: 0.5, cacheRead: 0.025, cacheWrite: 0 },
			thinking: { efforts: [Effort.Low, Effort.High, Effort.Max], requiresEffort: true },
		});
	});

	test("a row offering no effort levels does not reason", async () => {
		const { models } = await discover([{ ...DEEPSEEK_ROW, id: "refuseless-test/plain", reasoning_efforts: ["off"] }]);

		expect(models[0].reasoning).toBe(false);
		expect(models[0].thinking).toBeUndefined();
	});

	test("unserved medium and xhigh step up to high and max", async () => {
		const { models } = await discover([GLM_ROW]);

		expect(clampThinkingLevelForModel(models[0], Effort.Minimal)).toBe(Effort.Low);
		expect(clampThinkingLevelForModel(models[0], Effort.Medium)).toBe(Effort.High);
		expect(clampThinkingLevelForModel(models[0], Effort.XHigh)).toBe(Effort.Max);
	});

	test("abliterated reasoning is not carried to the base model's host", () => {
		const target = { provider: "deepseek", api: "openai-completions", id: "deepseek-v4.1-flash" };
		const source = (model: string) => ({ provider: "refuseless", api: "openai-completions", model });

		expect(carriesReasoning(source("deepseek-v4.1-flash-fast"), target)).toBe(true);
		expect(carriesReasoning(source("deepseek-v4.1-flash-abliterated"), target)).toBe(false);
	});
});
