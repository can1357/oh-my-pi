import { describe, expect, it } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

describe("issue #10966: Responses synthetic reasoning suppression when allowsSyntheticReasoningContentForToolCalls is false", () => {
	const museOpenRouterModel = buildModel({
		id: "meta/muse-spark-1.3",
		name: "Muse Spark 1.3",
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 64_000,
	});

	it("does not synthesize placeholder reasoning items on tool-call continuations when synthetic reasoning is disabled", () => {
		expect(museOpenRouterModel.compat.filterReasoningHistory).toBe(true);
		expect(museOpenRouterModel.compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(museOpenRouterModel.compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		const userMessage: UserMessage = {
			role: "user",
			content: "Run echo 1",
			timestamp: Date.now(),
		};

		// Prior assistant turn containing thinking + tool call
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "need to run echo 1" },
				{
					type: "toolCall",
					id: "call_12345",
					name: "bash",
					arguments: { command: "echo 1" },
				},
			],
			api: "openrouter",
			provider: "openrouter",
			model: "meta/muse-spark-1.3",
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_12345",
			toolName: "bash",
			content: [{ type: "text", text: "1\n" }],
			isError: false,
			timestamp: Date.now(),
		};

		const followUpUserMessage: UserMessage = {
			role: "user",
			content: "Now run echo 2",
			timestamp: Date.now(),
		};

		const context: Context = {
			messages: [userMessage, assistantMessage, toolResultMessage, followUpUserMessage],
		};

		const { params } = buildParams(
			museOpenRouterModel as unknown as Model<"openai-responses">,
			context,
			{ reasoning: "medium" },
			undefined,
		);

		const reasoningItems = (params.input as Array<{ type?: string; id?: string }>).filter(
			item => item.type === "reasoning",
		);

		// With filterReasoningHistory: true, neither native reasoning items nor synthetic
		// placeholder reasoning items (`rs_*` with "reasoning unavailable") must be sent.
		expect(reasoningItems).toHaveLength(0);

		// Function call and output must remain intact
		const functionCall = (params.input as Array<{ type?: string; call_id?: string }>).find(
			item => item.type === "function_call",
		);
		expect(functionCall).toBeDefined();
		expect(functionCall?.call_id).toBe("call_12345");
	});

	it("preserves synthetic reasoning items for models with allowsSyntheticReasoningContentForToolCalls: true", () => {
		const claudeOpenRouterModel = buildModel({
			id: "anthropic/claude-sonnet-4",
			name: "Claude Sonnet 4",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200_000,
			maxTokens: 8_192,
		});

		expect(claudeOpenRouterModel.compat.filterReasoningHistory).toBe(true);
		expect(claudeOpenRouterModel.compat.allowsSyntheticReasoningContentForToolCalls).toBe(true);

		const userMessage: UserMessage = {
			role: "user",
			content: "Run echo test",
			timestamp: Date.now(),
		};

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "running command" },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "bash",
					arguments: { command: "echo test" },
				},
			],
			api: "openrouter",
			provider: "openrouter",
			model: "anthropic/claude-sonnet-4",
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_abc123",
			toolName: "bash",
			content: [{ type: "text", text: "test\n" }],
			isError: false,
			timestamp: Date.now(),
		};

		const followUpUserMessage: UserMessage = {
			role: "user",
			content: "Next step",
			timestamp: Date.now(),
		};

		const context: Context = {
			messages: [userMessage, assistantMessage, toolResultMessage, followUpUserMessage],
		};

		const { params } = buildParams(
			claudeOpenRouterModel as unknown as Model<"openai-responses">,
			context,
			{ reasoning: "medium" },
			undefined,
		);

		// Anthropic on OpenRouter preserves synthetic reasoning replay when required
		expect(reasoningItems.length).toBeGreaterThanOrEqual(1);
		expect(reasoningItems[0].content?.[0]?.text).toBe("running command");

		const functionCall = (params.input as Array<{ type?: string; call_id?: string }>).find(
			item => item.type === "function_call",
		);
		expect(functionCall).toBeDefined();
		expect(functionCall?.call_id).toBe("call_abc123");
	});

	it("preserves required reasoning item replay for OpenRouter DeepSeek with real thinking", () => {
		const deepseekOpenRouterModel = buildModel({
			id: "deepseek/deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_048_576,
			maxTokens: 384_000,
		});

		expect(deepseekOpenRouterModel.compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(deepseekOpenRouterModel.compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "deepseek thinking trace" },
				{
					type: "toolCall",
					id: "call_ds123",
					name: "bash",
					arguments: { command: "echo ds" },
				},
			],
			api: "openrouter",
			provider: "openrouter",
			model: "deepseek/deepseek-v4-pro",
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Run ds", timestamp: Date.now() },
				assistantMessage,
				{ role: "toolResult", toolCallId: "call_ds123", toolName: "bash", content: [{ type: "text", text: "ds\n" }], isError: false, timestamp: Date.now() },
				{ role: "user", content: "Next ds", timestamp: Date.now() },
			],
		};

		const { params } = buildParams(
			deepseekOpenRouterModel as unknown as Model<"openai-responses">,
			context,
			{ reasoning: "high" },
			undefined,
		);

		const reasoningItems = (params.input as Array<{ type?: string; content?: Array<{ text?: string }> }>).filter(
			item => item.type === "reasoning",
		);

		// With surviving reasoning text, DeepSeek gets the required reasoning item with real thinking text
		expect(reasoningItems).toHaveLength(1);
		expect(reasoningItems[0].content?.[0]?.text).toBe("deepseek thinking trace");
	});
});
