// Custom same-model endpoints own opaque tool-call IDs; cross-model replay must
// normalize them for the Anthropic target.
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ModelSpec, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ANTHROPIC_TOOL_CALL_ID = /^[a-zA-Z0-9_-]{1,64}$/;

// Invalid under Anthropic's 64-character alphanumeric ID contract.
const GEMINI_ID = `call_abc123/thoughtSignature=CiQBxY9z${"a".repeat(80)}==`;

function makeModel(): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "custom-gemini",
		id: "gemini-3-pro",
		name: "Gemini via anthropic-messages proxy",
		baseUrl: "https://proxy.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 1_000_000,
		reasoning: true,
	} satisfies ModelSpec<"anthropic-messages">);
}

function assistantWithCall(id: string, source: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "get_weather", arguments: { location: "Paris" } }],
		api: "anthropic-messages",
		provider: "custom-gemini",
		model: "gemini-3-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
		...source,
	};
}

function toolResult(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "get_weather",
		content: [{ type: "text", text: "15C" }],
		isError: false,
		timestamp: 0,
	};
}

function emittedIds(
	messages: Message[],
	model: Model<"anthropic-messages">,
): { callId: string | undefined; resultId: string | undefined } {
	const transformed = transformMessages(messages, model);
	const assistant = transformed.find(message => message.role === "assistant");
	const callId =
		assistant?.role === "assistant" ? assistant.content.find(block => block.type === "toolCall")?.id : undefined;
	const result = transformed.find(message => message.role === "toolResult");
	const resultId = result?.role === "toolResult" ? result.toolCallId : undefined;
	return { callId, resultId };
}

describe("anthropic-messages tool-call id normalization", () => {
	it("round-trips a same-model opaque id verbatim, keeping call/result paired", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "weather?", timestamp: 0 },
			assistantWithCall(GEMINI_ID, { provider: "custom-gemini", model: "gemini-3-pro" }),
			toolResult(GEMINI_ID),
		];

		const { callId, resultId } = emittedIds(messages, model);

		expect(callId).toBe(GEMINI_ID);
		expect(resultId).toBe(GEMINI_ID);
	});

	it("sanitizes a foreign-origin id to a valid Anthropic id on cross-model replay", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "weather?", timestamp: 0 },
			// Foreign IDs must satisfy the target's wire contract.
			assistantWithCall(GEMINI_ID, { provider: "openai", model: "gpt-4", api: "anthropic-messages" }),
			toolResult(GEMINI_ID),
		];

		const { callId, resultId } = emittedIds(messages, model);

		expect(callId).not.toBe(GEMINI_ID);
		expect(callId).toMatch(ANTHROPIC_TOOL_CALL_ID);
		expect(resultId).toBe(callId);
	});
});
