import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Regression: a caller disabling reasoning (titles, tiny roles) sent Ollama the
// lowest ladder effort "low", which Gemma 4 still thinks at (12-19 s per title).
// Ollama honors effort "none".
describe("local Ollama reasoning disable", () => {
	it("disables thinking with effort none on the responses route", () => {
		const spec: ModelSpec<"openai-responses"> = {
			id: "gemma4:e4b",
			name: "gemma4:e4b",
			api: "openai-responses",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 32_768,
		};
		expect(buildModel(spec).compat.reasoningDisableMode).toBe("none-effort");
	});
});
