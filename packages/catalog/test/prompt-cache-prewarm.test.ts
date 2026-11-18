import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isPromptCachePrewarmSupported } from "@oh-my-pi/pi-catalog/compat/prompt-cache-prewarm";

const base = {
	reasoning: true,
	input: ["text"] as "text"[],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

describe("prompt-cache-prewarm", () => {
	test("only the first-party Anthropic endpoint accepts a max_tokens 0 pre-warm", () => {
		const anthropic = buildModel({
			...base,
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
		});
		const proxied = { ...anthropic, baseUrl: "https://claude-proxy.example" };
		const bedrock = buildModel({
			...base,
			id: "us.anthropic.claude-opus-5-5",
			name: "Claude Opus 5.5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		});

		expect(isPromptCachePrewarmSupported(anthropic)).toBe(true);
		expect(isPromptCachePrewarmSupported(proxied)).toBe(false);
		expect(isPromptCachePrewarmSupported(bedrock)).toBe(false);
	});
});
