import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Model, ModelSpec, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const baseModel: Omit<ModelSpec<"anthropic-messages">, "provider" | "baseUrl"> = {
	api: "anthropic-messages",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8192,
	contextWindow: 200000,
	reasoning: false,
};

const anthropicModel: Model<"anthropic-messages"> = buildModel({
	...baseModel,
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
});

const zaiModel: Model<"anthropic-messages"> = buildModel({
	...baseModel,
	id: "glm-4.6",
	name: "GLM-4.6",
	provider: "zai",
	baseUrl: "https://api.z.ai/api/anthropic",
});

const visionModel: Model<"anthropic-messages"> = buildModel({
	...baseModel,
	input: ["text", "image"],
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
});

const user: UserMessage = {
	role: "user",
	content: "run the tool",
	timestamp: Date.now(),
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "toolu_empty_error",
			name: "bash",
			arguments: { command: "true" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-6",
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

function getToolResultBlock(
	model: Model<"anthropic-messages">,
	toolResult: ToolResultMessage,
): Record<string, unknown> {
	const params = convertAnthropicMessages([user, assistant, toolResult], model, false);
	const last = params.at(-1);
	expect(last?.role).toBe("user");
	const blocks = last?.content as unknown as Array<Record<string, unknown>>;
	expect(Array.isArray(blocks)).toBe(true);
	const block = blocks.find(b => b.type === "tool_result");
	expect(block).toBeDefined();
	return block as Record<string, unknown>;
}

describe("anthropic empty error tool_result encoding", () => {
	it("fills whitespace-only error tool results so Anthropic does not 400", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_empty_error",
			toolName: "bash",
			content: [{ type: "text", text: "\n\n\n\n\n" }],
			isError: true,
			timestamp: Date.now(),
		};

		const block = getToolResultBlock(anthropicModel, toolResult);
		expect(block.is_error).toBe(true);
		expect(block.content).toBe("Tool failed with no output.");
	});

	it("leaves successful whitespace-only tool results unchanged", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_empty_error",
			toolName: "bash",
			content: [{ type: "text", text: "   \n\t" }],
			isError: false,
			timestamp: Date.now(),
		};

		const block = getToolResultBlock(anthropicModel, toolResult);
		expect(block.is_error).toBe(false);
		expect(block.content).toBe("");
	});

	it("encodes empty successful tool results as empty string, not empty array, on image-capable models", () => {
		// Regression: vision-capable models serialize whitespace-only successful
		// tool results as `content: []` on the wire. Official Anthropic accepts it,
		// but strict Anthropic-compatible endpoints (Z.AI GLM, api.z.ai/api/anthropic)
		// reject the whole request with 400 code 1213 ("The prompt parameter was
		// not received normally"). `content: ""` is accepted by both.
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_empty_error",
			toolName: "write",
			content: [{ type: "text", text: "" }],
			isError: false,
			timestamp: Date.now(),
		};

		const block = getToolResultBlock(visionModel, toolResult);
		expect(block.is_error).toBe(false);
		expect(block.content).toBe("");
	});
});

// Z.AI's proxy deserializes tool_result blocks into a class that reads `.id`
// (500 "'ClaudeContentBlockToolResult' object has no attribute 'id'"), so its
// tool_result blocks alias `id` to `tool_use_id`; standard Anthropic stays unchanged.
describe("anthropic tool_result id alias", () => {
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "toolu_empty_error",
		toolName: "bash",
		content: [{ type: "text", text: "file1\nfile2" }],
		isError: false,
		timestamp: Date.now(),
	};

	it("includes `id` aliased to `tool_use_id` on tool_result blocks for z.ai", () => {
		const block = getToolResultBlock(zaiModel, toolResult);
		expect(block.tool_use_id).toBe("toolu_empty_error");
		expect(block.id).toBe("toolu_empty_error");
	});

	it("does not include `id` on tool_result blocks for api.anthropic.com", () => {
		const block = getToolResultBlock(anthropicModel, toolResult);
		expect(block.tool_use_id).toBe("toolu_empty_error");
		expect("id" in block).toBe(false);
	});
});
