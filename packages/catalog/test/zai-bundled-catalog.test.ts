import { describe, expect, it } from "bun:test";
import modelsJson from "../src/models.json";

interface BundledModel {
	api: string;
	provider: string;
	baseUrl: string;
	contextWindow: number | null;
	maxTokens: number | null;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	input?: readonly string[];
	reasoning?: boolean;
	thinking?: { efforts?: readonly string[]; defaultLevel?: string; requiresEffort?: boolean };
}

describe("zai bundled catalog", () => {
	it("pins glm-5.2 base entry to 1M context", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.2"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("zai");
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(Object.keys(zaiModels)).not.toContain("glm-5.2[1m]");
	});

	it("bundles glm-5.3-flash with the 1M tier, native image input, and the GLM-5.3 ladder", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.3-flash"];

		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		// Keep the permanent catalog on list price; the 50%-off launch
		// promotion expires on 2026-09-09.
		expect(model.cost).toEqual({ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
		// Natively multimodal: the id carries no `v` marker, but the Anthropic
		// endpoint accepts image blocks.
		expect(model.input).toEqual(["text", "image"]);
		expect(model.reasoning).toBe(true);
		// Thinking cannot be disabled and defaults to `max`.
		expect(model.thinking?.efforts).toEqual(["low", "high", "max"]);
		expect(model.thinking?.requiresEffort).toBe(true);
		expect(model.thinking?.defaultLevel).toBe("max");
	});
});
