import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
});

describe("Anthropic thinking replay immutability", () => {
	it("preserves signed-thinking blocks while normalizing non-thinking content", () => {
		const malformed = String.fromCharCode(0xd800);
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `analysis ${malformed}`, thinkingSignature: "sig_thinking" },
				{ type: "redactedThinking", data: "" },
				{ type: "text", text: `text ${malformed}` },
				{
					type: "toolCall",
					id: "toolu_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, assistant], model, false);
		const assistantParam = params.find(message => message.role === "assistant");
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.content).toEqual([
			{ type: "thinking", thinking: `analysis ${malformed}`, signature: "sig_thinking" },
			{ type: "text", text: `text ${malformed.toWellFormed()}` },
			{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md" } },
		]);
	});
});
