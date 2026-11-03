import { expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"bedrock-converse-stream"> = buildModel({
	id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
	name: "Haiku",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

function toolResult(id: string, name: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: `Tool ${name} not found` }],
		isError: true,
		timestamp: 3,
	};
}

it("replays only Bedrock-valid tool names and their paired results", async () => {
	const assistant: AssistantMessage = {
		role: "assistant",
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-2.5-pro",
		content: [
			{ type: "toolCall", id: "call_colon", name: "ns.tool:v1", arguments: {} },
			{ type: "toolCall", id: "call_url", name: "proc://*", arguments: {} },
			{ type: "toolCall", id: "call_long", name: "t".repeat(65), arguments: {} },
			{ type: "toolCall", id: "call_limit", name: "t".repeat(64), arguments: {} },
			{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "a.txt" } },
		],
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 2,
	};
	const context: Context = {
		messages: [
			{ role: "user", content: "Read a.txt", timestamp: 1 },
			assistant,
			toolResult("call_colon", "ns.tool:v1"),
			toolResult("call_url", "proc://*"),
			toolResult("call_long", "t".repeat(65)),
			{ ...toolResult("call_limit", "t".repeat(64)), isError: false },
			{ ...toolResult("call_read", "read"), isError: false, content: [{ type: "text", text: "file contents" }] },
			{ role: "user", content: "Continue", timestamp: 4 },
		],
	};
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<unknown>();
	void streamBedrock(model, context, {
		bearerToken: "test-token",
		signal: controller.signal,
		onPayload: payload => resolve(payload),
	});

	const payload = await promise;
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("messages" in payload) ||
		!Array.isArray(payload.messages)
	) {
		throw new Error("Missing Bedrock messages");
	}
	expect(payload.messages.slice(0, 3)).toMatchObject([
		{ role: "user", content: [{ text: "Read a.txt" }] },
		{
			role: "assistant",
			content: [
				{ toolUse: { name: "t".repeat(64), toolUseId: "call_limit" } },
				{ toolUse: { name: "read", toolUseId: "call_read" } },
			],
		},
		{
			role: "user",
			content: [
				{ toolResult: { toolUseId: "call_limit", status: "success" } },
				{ toolResult: { toolUseId: "call_read", status: "success" } },
			],
		},
	]);
});
