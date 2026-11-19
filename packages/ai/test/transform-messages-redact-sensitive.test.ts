import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { configureCredentialRedaction, transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT Test",
		id: "gpt-test",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

beforeAll(() => configureCredentialRedaction(true));
afterAll(() => configureCredentialRedaction(false));

describe("transformMessages credential redaction disabled", () => {
	it("passes real tokens through untouched when redaction is off", () => {
		configureCredentialRedaction(false);
		try {
			const token = "ghp_AbCd1234EfGh5678IjKl9012MnOp3456QrSt";
			const transformed = transformMessages(
				[{ role: "user", content: `Token: ${token}`, timestamp: Date.now() }],
				makeModel(),
			);
			expect(transformed[0]).toMatchObject({ role: "user", content: `Token: ${token}` });
		} finally {
			configureCredentialRedaction(true);
		}
	});
});

describe("transformMessages redact sensitive credentials", () => {
	it("redacts already-masked and real tokens from outbound messages", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: "Token: gho_************************************",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "I found this key: sk-proj-************************************",
					},
					{
						type: "toolCall",
						id: "call_x",
						name: "bash",
						arguments: {
							command: "echo gho_************************************",
						},
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
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
			},
			{
				role: "toolResult",
				toolCallId: "call_x",
				toolName: "bash",
				content: [{ type: "text", text: "Token is ghp_************************************ inside output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const transformed = transformMessages(messages, makeModel());

		// 1. Verify user message is redacted
		const userMsg = transformed[0];
		expect(userMsg.role).toBe("user");
		expect(userMsg.content).toBe("Token: [github_token_redacted]");

		// 2. Verify assistant message text and toolCall arguments are redacted
		const assistantMsg = transformed[1];
		expect(assistantMsg.role).toBe("assistant");
		const castAssistantMsg = assistantMsg as AssistantMessage;
		const assistantContent = castAssistantMsg.content;
		const textBlock = assistantContent[0];
		expect(textBlock.type).toBe("text");
		if (textBlock.type === "text") {
			expect(textBlock.text).toBe("I found this key: [openai_token_redacted]");
		}

		const toolCallBlock = assistantContent[1];
		expect(toolCallBlock.type).toBe("toolCall");

		// 3. Verify toolResult message is redacted
		const resultMsg = transformed[2];
		expect(resultMsg.role).toBe("toolResult");
		const toolResultMsg = resultMsg as ToolResultMessage;
		const toolResultBlock = toolResultMsg.content[0];
		expect(toolResultBlock.type).toBe("text");
		if (toolResultBlock.type === "text") {
			expect(toolResultBlock.text).toBe("Token is [github_token_redacted] inside output");
		}
		if (toolCallBlock.type === "toolCall") {
			const toolCall = toolCallBlock as ToolCall;
			const commandArg = toolCall.arguments?.command;
			expect(commandArg).toBe("echo [github_token_redacted]");
		}
	});

	it("drops an Anthropic thinking signature when redacting its signed content", () => {
		const model = buildModel({
			api: "anthropic-messages",
			name: "Claude Test",
			id: "claude-test",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			contextWindow: 8192,
			maxTokens: 2048,
			input: ["text"],
			reasoning: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Use sk-ABCdef1234567890ABCdef1234567890ABCdef1234567890ABCdef123456.",
						thinkingSignature: "signed-thinking-bytes",
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-test",
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
			},
		];

		const transformed = transformMessages(messages, model);

		expect(transformed[0]).toMatchObject({ role: "assistant", content: [] });
	});

	it("drops a tool thought signature after redacting its arguments", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_signed",
						name: "run",
						arguments: { token: "sk-ABCdef1234567890ABCdef1234567890ABCdef1234567890ABCdef123456" },
						thoughtSignature: "signed-tool-arguments",
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
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
			},
		];

		const transformed = transformMessages(messages, makeModel());
		const block = (transformed[0] as AssistantMessage).content[0];

		expect(block).toMatchObject({
			type: "toolCall",
			arguments: { token: "[openai_token_redacted]" },
		});
		if (block.type === "toolCall") {
			expect(block.thoughtSignature).toBeUndefined();
		}
	});

	it("preserves credential-shaped prose that is not a plausible live token", () => {
		const lookalike = "sk-abcdefghijklmnopqrstuvwxyz";
		const transformed = transformMessages(
			[{ role: "user", content: `The example key is ${lookalike}.`, timestamp: Date.now() }],
			makeModel(),
		);

		expect(transformed[0]).toMatchObject({ role: "user", content: `The example key is ${lookalike}.` });
	});
});
