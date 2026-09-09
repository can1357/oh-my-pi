import { describe, expect, it } from "bun:test";
import modelsJson from "../src/models.json";

describe("minimax bundled catalog", () => {
	it("pins MiniMax-M3 long-context entries to 1M context", () => {
		const providers = [
			{ id: "minimax", models: modelsJson.minimax },
			{ id: "minimax-cn", models: modelsJson["minimax-cn"] },
			{ id: "minimax-code", models: modelsJson["minimax-code"] },
			{ id: "minimax-code-cn", models: modelsJson["minimax-code-cn"] },
		];

		for (const provider of providers) {
			const model = provider.models["MiniMax-M3"];

			expect(model).toBeDefined();
			expect(model.provider).toBe(provider.id);
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(128_000);
		}
	});
});
