import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";

describe("buildModel discovered identities", () => {
	test("does not abort startup on an openai-compatible-chat UUID + cohere class tie", () => {
		const model = buildModel({
			id: "openai-compatible-chat-b524a192-5149-4722-ba4c-aec8d52dbaef/cohere/north-mini-code:free",
			name: "cohere/north-mini-code:free",
			api: "openai-completions",
			provider: "omni",
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		expect(model.id).toBe("openai-compatible-chat-b524a192-5149-4722-ba4c-aec8d52dbaef/cohere/north-mini-code:free");
		expect(model.identity.class).toBe("unknown");
	});
});
