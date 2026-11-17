import { describe, expect, it } from "bun:test";
import type { Api } from "@oh-my-pi/pi-ai";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function spec(provider: string, api: Api, id: string): ModelSpec {
	return {
		provider,
		api,
		id,
		name: id,
		baseUrl: "https://example.invalid",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 32_000,
		contextWindow: 200_000,
		reasoning: true,
	};
}

describe("classifier-cot-extraction", () => {
	it("is set for Claude on every host and unset for GPT", () => {
		const claude = [
			spec("anthropic", "anthropic-messages", "claude-sonnet-4-5"),
			spec("amazon-bedrock", "bedrock-converse-stream", "us.anthropic.claude-opus-4-1-20250805-v1:0"),
			spec("openrouter", "openai-completions", "anthropic/claude-opus-4.5"),
		];
		for (const model of claude) {
			expect(resolveModelPolicy(model).catalog.classifierCotExtraction).toBe(true);
		}
		const gpt = spec("openai", "openai-responses", "gpt-5.5");
		expect(resolveModelPolicy(gpt).catalog.classifierCotExtraction).toBeUndefined();
	});

	it("is set for the GitLab Duo Claude aliases and unset for its GPT ones", () => {
		for (const id of ["duo-chat-opus-4-6", "duo-chat-sonnet-4-5", "duo-chat-haiku-4-5"]) {
			expect(resolveModelPolicy(spec("gitlab-duo", "anthropic-messages", id)).catalog.classifierCotExtraction).toBe(
				true,
			);
		}
		const gpt = spec("gitlab-duo", "openai-responses", "duo-chat-gpt-5-codex");
		expect(resolveModelPolicy(gpt).catalog.classifierCotExtraction).toBeUndefined();
	});
});
