import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	VOLCENGINE_AGENT_PLAN_STATIC_MODELS,
	volcengineAgentPlanModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { VOLCENGINE_AGENT_PLAN_BASE_URL } from "@oh-my-pi/pi-catalog/wire/volcengine-agent-plan";

describe("Volcengine Ark Agent Plan catalog", () => {
	test("ships its stable direct default and documented aliases without model discovery", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "volcengine-agent-plan");
		expect(descriptor).toMatchObject({
			defaultModel: "doubao-seed-2.1-turbo",
			envVars: ["VOLCENGINE_AGENT_PLAN_API_KEY"],
		});
		const ids = VOLCENGINE_AGENT_PLAN_STATIC_MODELS.map(model => model.id);
		expect(ids).toContain("doubao-seed-2.1-turbo");
		expect(ids).toContain("glm-latest");
		const manager = volcengineAgentPlanModelManagerOptions();
		expect(manager.staticModels).toBe(VOLCENGINE_AGENT_PLAN_STATIC_MODELS);
		expect(manager.fetchDynamicModels).toBeUndefined();
	});

	test("pins official limits, modalities, protocols, and PAYG reference rates", () => {
		const models = new Map(VOLCENGINE_AGENT_PLAN_STATIC_MODELS.map(model => [model.id, buildModel(model)]));
		expect(models.size).toBe(15);
		expect(models.get("doubao-seed-2.1-turbo")).toMatchObject({
			api: "openai-responses",
			baseUrl: VOLCENGINE_AGENT_PLAN_BASE_URL,
			input: ["text", "image"],
			contextWindow: 256_000,
			maxTokens: 256_000,
			cost: { input: 0.442, output: 2.21, cacheRead: 0.0884, cacheWrite: 0 },
		});
		expect(models.get("deepseek-v4-pro")).toMatchObject({
			input: ["text"],
			contextWindow: 1_024_000,
			maxTokens: 384_000,
			cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
		});
		expect(models.get("minimax-m3")).toMatchObject({
			input: ["text", "image"],
			contextWindow: 1_024_000,
			maxTokens: 128_000,
			cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		});
		expect(models.get("glm-latest")).toMatchObject({
			api: "openai-responses",
			contextWindow: 1_024_000,
			maxTokens: 128_000,
			cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		});
		expect(models.get("kimi-k2.7-code")).toMatchObject({
			api: "openai-completions",
			input: ["text", "image"],
			contextWindow: 256_000,
			maxTokens: 32_000,
			cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
		});
	});
});
