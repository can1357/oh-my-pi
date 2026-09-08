import { describe, expect, it } from "bun:test";
import { ValidationError } from "@oh-my-pi/pi-ai/error";
import { parseRequest as parseAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import { parseRequest as parseGeminiV1beta } from "@oh-my-pi/pi-ai/providers/gemini-v1beta-server";
import { parseRequest as parseOpenAIChat } from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import { parseRequest as parseOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses-server";

describe("auth-gateway SDK parseRequest contract", () => {
	it("openai-chat parses a minimal chat body into modelId + a user message", () => {
		const parsed = parseOpenAIChat({
			model: "gpt-4o-mini",
			messages: [{ role: "user", content: "hello" }],
		});
		expect(parsed.modelId).toBe("gpt-4o-mini");
		expect(parsed.context.messages.some(message => message.role === "user")).toBe(true);
	});

	it("anthropic-messages parses a minimal messages body into modelId + a user message", () => {
		const parsed = parseAnthropicMessages({
			model: "claude-sonnet-4-5",
			max_tokens: 16,
			messages: [{ role: "user", content: "hello" }],
		});
		expect(parsed.modelId).toBe("claude-sonnet-4-5");
		expect(parsed.context.messages.some(message => message.role === "user")).toBe(true);
	});

	it("openai-responses parses a minimal responses body into modelId + a user message", () => {
		const parsed = parseOpenAIResponses({
			model: "gpt-5.4",
			input: "hello",
		});
		expect(parsed.modelId).toBe("gpt-5.4");
		expect(parsed.context.messages.some(message => message.role === "user")).toBe(true);
	});

	it("gemini-v1beta parses a minimal generateContent body into modelId + a user message", () => {
		const parsed = parseGeminiV1beta({
			model: "gemini-2.0-flash",
			contents: [{ role: "user", parts: [{ text: "hello" }] }],
		});
		expect(parsed.modelId).toBe("gemini-2.0-flash");
		expect(parsed.context.messages.some(message => message.role === "user")).toBe(true);
	});

	it("openai-chat rejects {}", () => {
		expect(() => parseOpenAIChat({})).toThrow(ValidationError);
	});

	it("anthropic-messages rejects {}", () => {
		expect(() => parseAnthropicMessages({})).toThrow(ValidationError);
	});

	it("openai-responses rejects {}", () => {
		expect(() => parseOpenAIResponses({})).toThrow(ValidationError);
	});

	it("gemini-v1beta rejects {}", () => {
		expect(() => parseGeminiV1beta({})).toThrow(ValidationError);
	});
});
