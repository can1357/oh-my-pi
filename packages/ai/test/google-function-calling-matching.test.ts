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
	provider: "google" | "google-antigravity" | "google-vertex" = api === "google-vertex" ? "google-vertex" : "google",
): Model<typeof api> {
	return buildModel({
		id,
		name: id,
		api,
		provider: provider,
		baseUrl: provider === "google-antigravity" ? "https://daily-cloudcode-pa.googleapis.com" : "https://example.com",
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

function createCloudCodeAssistModel(provider: "google-antigravity" | "google-gemini-cli"): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-3.5-flash",
		name: "gemini-3.5-flash",
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
		const model = createGoogleModel("claude-sonnet-4-5", "google-generative-ai", "google-antigravity");
		const { functionCall, functionResponse } = functionCallAndResponse(
			model,
			contextWithToolResult("actual_tool_name"),
		);

		expect(functionCall?.id).toBe("call_12345_abc");
		expect(functionResponse?.id).toBe("call_12345_abc");
		expect(functionResponse?.name).toBe(functionCall?.name);
	});
});

describe("Google GenerateContent parallel function response order", () => {
	function contextWithResultsStoredOutOfOrder(): Context {
		return {
			messages: [
				{ role: "user", content: "Read both files", timestamp: 1000 },
				{
					role: "assistant",
					provider: "google",
					api: "google-generative-ai",
					model: "gemini-2.5-flash",
					content: [
						{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "/a" } },
						{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "/b" } },
					],
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 2000,
				},
				{
					role: "toolResult",
					toolCallId: "call_b",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "b body" }],
					timestamp: 3000,
				},
				{
					role: "toolResult",
					toolCallId: "call_a",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "a body" }],
					timestamp: 3001,
				},
			],
		};
	}

	it.each([
		{ route: "Gemini API, Gemini 2.5", model: createGoogleModel("gemini-2.5-flash") },
		{ route: "Vertex", model: createGoogleModel("gemini-3.5-flash", "google-vertex") },
		{ route: "Antigravity", model: createCloudCodeAssistModel("google-antigravity") },
		{ route: "Gemini CLI", model: createCloudCodeAssistModel("google-gemini-cli") },
		{ route: "Gemini API, Gemini 3.5", model: createGoogleModel("gemini-3.5-flash") },
	])("sends same-name results in call order: $route", ({ model }) => {
		const contents = convertMessages(model, contextWithResultsStoredOutOfOrder());
		const responseTurns = contents.filter(c => c.parts?.some(part => part.functionResponse));
		expect(responseTurns).toHaveLength(1);
		expect(responseTurns[0].parts?.map(part => part.functionResponse?.response)).toEqual([
			{ output: "a body" },
			{ output: "b body" },
		]);
	});
});

describe("Google GenerateContent Gemini < 3 tool-result image order", () => {
	it("sends buffered tool-result images in call order", () => {
		const image = (data: string) => ({ type: "image" as const, mimeType: "image/png", data });
		const context: Context = {
			messages: [
				{ role: "user", content: "Screenshot both", timestamp: 1000 },
				{
					role: "assistant",
					provider: "google",
					api: "google-generative-ai",
					model: "gemini-2.5-flash",
					content: [
						{ type: "toolCall", id: "call_a", name: "shot", arguments: { target: "a" } },
						{ type: "toolCall", id: "call_b", name: "shot", arguments: { target: "b" } },
					],
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 2000,
				},
				{
					role: "toolResult",
					toolCallId: "call_b",
					toolName: "shot",
					isError: false,
					content: [image("image-b")],
					timestamp: 3000,
				},
				{
					role: "toolResult",
					toolCallId: "call_a",
					toolName: "shot",
					isError: false,
					content: [image("image-a")],
					timestamp: 3001,
				},
			],
		};
		const contents = convertMessages(createGoogleModel("gemini-2.5-flash"), context);
		const images = contents
			.flatMap(c => c.parts ?? [])
			.flatMap(part => (part.inlineData ? [part.inlineData.data] : []));
		expect(images).toEqual(["image-a", "image-b"]);
	});
});
