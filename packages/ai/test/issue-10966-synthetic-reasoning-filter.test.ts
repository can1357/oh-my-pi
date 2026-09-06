import { describe, expect, it } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

describe("issue #10966: Responses synthetic reasoning suppression when filterReasoningHistory is true", () => {
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

	it("does not synthesize placeholder reasoning items on tool-call continuations when filterReasoningHistory is enabled", () => {
		expect(museOpenRouterModel.compat.filterReasoningHistory).toBe(true);
		expect(museOpenRouterModel.compat.requiresReasoningContentForToolCalls).toBe(true);

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
});
