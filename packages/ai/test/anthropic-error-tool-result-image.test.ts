import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Model, ModelSpec, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Anthropic rejects images inside error tool results:
//   "messages.N.content.0.tool_result: all content must be type `text` if `is_error` is true"
// The converter must keep error tool_result content text-only and re-attach the
// images after the tool_result run in the same user message.

const baseModel: Omit<ModelSpec<"anthropic-messages">, "provider" | "baseUrl"> = {
	api: "anthropic-messages",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8192,
	contextWindow: 200000,
	reasoning: false,
};

const visionModel: Model<"anthropic-messages"> = buildModel({
	...baseModel,
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
});

const user: UserMessage = {
	role: "user",
	content: "run the tool",
	timestamp: Date.now(),
};

function assistantWithCalls(ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({
			type: "toolCall",
			id,
			name: "browser",
			arguments: {},
		})),
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
}

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUg==";

function toolResult(id: string, opts: { isError: boolean; text?: string; image?: boolean }): ToolResultMessage {
	const content: ToolResultMessage["content"] = [];
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	if (opts.image) content.push({ type: "image", data: PNG_DATA, mimeType: "image/png" });
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "browser",
		content,
		isError: opts.isError,
		timestamp: Date.now(),
	};
}

function lastUserBlocks(messages: Parameters<typeof convertAnthropicMessages>[0]): Array<Record<string, unknown>> {
	const params = convertAnthropicMessages(messages, visionModel, false);
	const last = params.at(-1);
	expect(last?.role).toBe("user");
	const blocks = last?.content as unknown as Array<Record<string, unknown>>;
	expect(Array.isArray(blocks)).toBe(true);
	return blocks;
}

describe("anthropic error tool_result image hoisting", () => {
	it("keeps error tool_result content text-only and hoists the image after it", () => {
		const blocks = lastUserBlocks([
			user,
			assistantWithCalls(["toolu_err"]),
			toolResult("toolu_err", { isError: true, text: "assertion failed", image: true }),
		]);

		const result = blocks.find(b => b.type === "tool_result");
		expect(result?.is_error).toBe(true);
		const content = result?.content as Array<Record<string, unknown>>;
		expect(content.every(b => b.type === "text")).toBe(true);
		expect(content.some(b => (b.text as string).includes("assertion failed"))).toBe(true);

		// Image re-attached in the same user message, after the tool_result.
		const imageIndex = blocks.findIndex(b => b.type === "image");
		expect(imageIndex).toBeGreaterThan(blocks.findIndex(b => b.type === "tool_result"));
		const source = blocks[imageIndex]?.source as Record<string, unknown>;
		expect(source.data).toBe(PNG_DATA);
	});

	it("keeps a non-empty text body when the error result was image-only", () => {
		const blocks = lastUserBlocks([
			user,
			assistantWithCalls(["toolu_err"]),
			toolResult("toolu_err", { isError: true, image: true }),
		]);

		const result = blocks.find(b => b.type === "tool_result");
		expect(result?.is_error).toBe(true);
		const content = result?.content as Array<Record<string, unknown>>;
		expect(content.length).toBeGreaterThan(0);
		expect(content.every(b => b.type === "text")).toBe(true);
		expect(blocks.some(b => b.type === "image")).toBe(true);
	});

	it("hoists images after the whole tool_result run for consecutive results", () => {
		const blocks = lastUserBlocks([
			user,
			assistantWithCalls(["toolu_a", "toolu_b"]),
			toolResult("toolu_a", { isError: true, text: "boom", image: true }),
			toolResult("toolu_b", { isError: false, text: "ok" }),
		]);

		// All tool_result blocks come first — Anthropic requires the run at the
		// beginning of the message — then the hoisted image content.
		const types = blocks.map(b => b.type);
		const lastResult = types.lastIndexOf("tool_result");
		expect(types.slice(0, lastResult + 1).every(t => t === "tool_result")).toBe(true);
		expect(types.indexOf("image")).toBeGreaterThan(lastResult);
	});

	it("leaves images inside successful tool_results untouched", () => {
		const blocks = lastUserBlocks([
			user,
			assistantWithCalls(["toolu_ok"]),
			toolResult("toolu_ok", { isError: false, text: "screenshot", image: true }),
		]);

		const result = blocks.find(b => b.type === "tool_result");
		const content = result?.content as Array<Record<string, unknown>>;
		expect(content.some(b => b.type === "image")).toBe(true);
		expect(blocks.filter(b => b.type === "image").length).toBe(0);
	});
});
