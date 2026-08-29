import { describe, expect, it } from "bun:test";
import modelsJson from "../src/models.json";

interface BundledModel {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number | null;
	maxTokens: number | null;
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

	it("bundles current GLM-5.3 coding-plan models", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const expectedModels = {
			"glm-5.2-highspeed": { name: "GLM-5.2 Highspeed", input: ["text"] },
			"glm-5.3": { name: "GLM-5.3", input: ["text"] },
			"glm-5.3-flash": { name: "GLM-5.3-Flash", input: ["text", "image"] },
			"glm-5.3-highspeed": { name: "GLM-5.3 Highspeed", input: ["text"] },
		};

		for (const [id, expected] of Object.entries(expectedModels)) {
			const model = zaiModels[id];
			expect(model).toBeDefined();
			expect(model.id).toBe(id);
			expect(model.name).toBe(expected.name);
			expect(model.provider).toBe("zai");
			expect(model.api).toBe("anthropic-messages");
			expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
			expect(model.reasoning).toBe(true);
			expect(model.input).toEqual(expected.input);
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(131_072);
		}
	});
});
