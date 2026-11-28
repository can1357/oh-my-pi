import { describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
import { getBundledModels } from "../src/models";

function kindOf(id: string) {
	return buildModel({
		id,
		name: id,
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	}).kind;
}

describe("OpenRouter TypeSafe kinds", () => {
	it("keeps Jev Router (chat/completions) as a chat model", () => {
		expect(kindOf("typesafe/jev-router")).toBe("chat");
		expect(getBundledModels("openrouter").find(model => model.id === "typesafe/jev-router")).toMatchObject({
			api: "openrouter",
			kind: "chat",
		});
	});

	it("keeps Jev Decisions models as judges", () => {
		expect(kindOf("typesafe/jev-1.13")).toBe("judge");
	});
});
