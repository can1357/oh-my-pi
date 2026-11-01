import { describe, expect, test } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Model, ThinkingContent } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface AssistantWireMessage {
	role: "assistant";
	content?: unknown;
	reasoning?: unknown;
	reasoning_content?: unknown;
}

function sambanovaModel(id = "gpt-oss-120b"): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "sambanova",
		baseUrl: "https://api.sambanova.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: null,
	});
}

function assistantTurn(model: Model<"openai-completions">, thinking: ThinkingContent): AssistantMessage {
	return {
		role: "assistant",
		content: [thinking, { type: "text", text: "The answer is 5." }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function wireAssistant(model: Model<"openai-completions">, thinking: ThinkingContent): AssistantWireMessage {
	const messages = convertMessages(model, { messages: [assistantTurn(model, thinking)] }, model.compat);
	const assistant = messages.find(message => message.role === "assistant");
	if (!assistant) throw new Error("assistant message missing from the encoded request");
	return assistant as AssistantWireMessage;
}

describe("SambaNova reasoning replay wire format", () => {
	// The gateway streams thinking as `reasoning`; replaying it must round-trip
	// that exact field so the rendered turn matches the cached continuation.
	test("replays a streamed `reasoning` block under the same field", () => {
		const model = sambanovaModel();
		const assistant = wireAssistant(model, {
			type: "thinking",
			thinking: "Two plus three is five.",
			thinkingSignature: "reasoning",
		});

		expect(assistant.reasoning).toBe("Two plus three is five.");
		expect(assistant).not.toHaveProperty("reasoning_content");
	});
});
