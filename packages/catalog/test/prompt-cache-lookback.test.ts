import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolvePromptCacheLookback } from "@oh-my-pi/pi-catalog/compat/prompt-cache-lookback";

const base = {
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

describe("prompt-cache-lookback", () => {
	test("Claude carries its 20-position lookback on every host; other lines have no bound", () => {
		const firstParty = buildModel({
			...base,
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
		});
		const bedrock = buildModel({
			...base,
			id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			name: "Claude Sonnet 4.5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		});
		const gpt = buildModel({
			...base,
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		});

		expect(resolvePromptCacheLookback(firstParty)).toBe(20);
		expect(resolvePromptCacheLookback(bedrock)).toBe(20);
		expect(resolvePromptCacheLookback(gpt)).toBeUndefined();
	});
});
