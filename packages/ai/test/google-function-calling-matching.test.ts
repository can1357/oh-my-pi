import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { Context, Model, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createGoogleModel(
	id: string,
	api: "google-generative-ai" | "google-vertex" = "google-generative-ai",
): Model<typeof api> {
	return buildModel({
		id,
		name: id,
		api,
		provider: api === "google-vertex" ? "google-vertex" : "google",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

function contextWithToolResult(toolName = "stale_tool_name"): Context {
	return {
		messages: [
			{
				role: "user",
				content: "Call the tool",
				timestamp: 1000,
			},
			{
				role: "assistant",
				provider: "google-generative-ai",
				api: "google-generative-ai",
				model: "gemini-2.5-flash",
				content: [
					{
						type: "toolCall",
						id: "call_12345_abc",
						name: "actual_tool_name",
						arguments: { query: "pi" },
					},
				],
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 2000,
			},
			{
				role: "toolResult",
				toolCallId: "call_12345_abc",
				toolName,
				isError: false,
				content: [
					{
						type: "text",
						text: "Tool result text",
					},
				],
				timestamp: 3000,
			},
		],
	};
}

function functionCallAndResponse(model: Model<"google-generative-ai" | "google-vertex">, context: Context) {
	const contents = convertMessages(model, context);
	const functionCall = contents.find(c => c.role === "model")?.parts?.find(part => part.functionCall)?.functionCall;
	const functionResponse = contents
		.find(c => c.role === "user" && c.parts?.some(part => part.functionResponse))
		?.parts?.find(part => part.functionResponse)?.functionResponse;

	return { functionCall, functionResponse };
}

describe("Google GenerateContent function response matching", () => {
	it("uses emitted functionCall IDs and names for direct Gemini 3 functionResponse parts", () => {
		const model = createGoogleModel("gemini-3.5-flash");
		const { functionCall, functionResponse } = functionCallAndResponse(model, contextWithToolResult());

		expect(functionCall?.id).toBe("call_12345_abc");
		expect(functionResponse?.id).toBe("call_12345_abc");
		expect(functionCall?.name).toBe("actual_tool_name");
		expect(functionResponse?.name).toBe("actual_tool_name");
		expect(functionResponse?.name).toBe(functionCall?.name);
	});

	it("omits unsupported Part IDs for Vertex Gemini 3.5 GenerateContent", () => {
		const model = createGoogleModel("gemini-3.5-flash", "google-vertex");
		const { functionCall, functionResponse } = functionCallAndResponse(model, contextWithToolResult());

		expect(functionCall?.id).toBeUndefined();
		expect(functionResponse?.id).toBeUndefined();
		expect(functionResponse?.name).toBe(functionCall?.name);
	});

	it("keeps multimodal tool output inside Gemini 3 functionResponse parts", () => {
		const context = contextWithToolResult("actual_tool_name");
		const toolResult = context.messages[2];
		if (toolResult.role !== "toolResult") throw new Error("expected tool result fixture");
		toolResult.content.push({
			type: "image",
			mimeType: "image/png",
			data: "base64-image-data",
		});

		const model = createGoogleModel("gemini-3.5-flash");
		const { functionResponse } = functionCallAndResponse(model, context);

		expect(functionResponse?.parts).toEqual([
			{
				inlineData: {
					mimeType: "image/png",
					data: "base64-image-data",
				},
			},
		]);
	});

	it("keeps Claude call IDs on non-Vertex Google-compatible endpoints", () => {
		const model = createGoogleModel("claude-sonnet-4-5");
		const { functionCall, functionResponse } = functionCallAndResponse(
			model,
			contextWithToolResult("actual_tool_name"),
		);

		expect(functionCall?.id).toBe("call_12345_abc");
		expect(functionResponse?.id).toBe("call_12345_abc");
		expect(functionResponse?.name).toBe(functionCall?.name);
	});
});
