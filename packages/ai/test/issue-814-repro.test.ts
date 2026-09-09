import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Model, ModelSpec, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Issue #814: Z.AI returns 500
 * "'ClaudeContentBlockToolResult' object has no attribute 'id'" on every
 * request that contains a tool_result block.
 *
 * Z.AI's Python proxy at api.z.ai/api/anthropic deserializes tool_result
 * blocks into a class that accesses `.id`, even though Anthropic's API only
 * carries `tool_use_id`. As a workaround, OMP must include `id` (aliased to
 * `tool_use_id`) on tool_result blocks targeted at z.ai. Standard Anthropic
 * endpoints must remain unchanged (no `id` field).
 */

const baseModel: Omit<ModelSpec<"anthropic-messages">, "provider" | "baseUrl"> = {
	api: "anthropic-messages",
	id: "glm-4.6",
	name: "GLM-4.6",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8192,
	contextWindow: 200000,
	reasoning: false,
};

const zaiModel: Model<"anthropic-messages"> = buildModel({
	...baseModel,
	provider: "zai",
	baseUrl: "https://api.z.ai/api/anthropic",
});

const anthropicModel: Model<"anthropic-messages"> = buildModel({
	...baseModel,
	id: "claude-3-5-sonnet-20241022",
	name: "Claude 3.5 Sonnet",
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
			id: "toolu_abc123",
			name: "bash",
			arguments: { command: "ls" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "glm-4.6",
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

const toolResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "toolu_abc123",
	toolName: "bash",
	content: [{ type: "text", text: "file1\nfile2" }],
	isError: false,
	timestamp: Date.now(),
};

function getToolResultBlock(model: Model<"anthropic-messages">): Record<string, unknown> {
	const params = convertAnthropicMessages([user, assistant, toolResult], model, false);
	const last = params.at(-1);
	expect(last?.role).toBe("user");
	const blocks = last?.content as unknown as Array<Record<string, unknown>>;
	expect(Array.isArray(blocks)).toBe(true);
	const block = blocks.find(b => b.type === "tool_result");
	expect(block).toBeDefined();
	return block as Record<string, unknown>;
}

describe("issue #814: z.ai tool_result id workaround", () => {
	it("includes `id` aliased to `tool_use_id` on tool_result blocks for z.ai", () => {
		const block = getToolResultBlock(zaiModel);
		expect(block.tool_use_id).toBe("toolu_abc123");
		expect(block.id).toBe("toolu_abc123");
	});

	it("does not include `id` on tool_result blocks for api.anthropic.com", () => {
		const block = getToolResultBlock(anthropicModel);
		expect(block.tool_use_id).toBe("toolu_abc123");
		expect("id" in block).toBe(false);
	});
});
