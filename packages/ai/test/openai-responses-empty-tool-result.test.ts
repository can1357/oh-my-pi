import { describe, expect, it } from "bun:test";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, ImageContent, ModelSpec, TextContent } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "test-vision",
	name: "Test Vision",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16000,
} satisfies ModelSpec<"openai-responses">);

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeContext(content: (TextContent | ImageContent)[]): Context {
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "empty.txt" } }],
				api: "openai-responses",
				provider: "openai",
				model: "test-vision",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content,
				isError: false,
				timestamp: Date.now(),
			},
		],
	};
}

function findFunctionCallOutput(items: unknown[]): unknown {
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		if (!("type" in item) || item.type !== "function_call_output") continue;
		if ("output" in item) return item.output;
	}
	return undefined;
}

describe("Responses API empty tool result", () => {
	it("keeps a genuinely empty text result empty instead of claiming an attached image", () => {
		// Regression: an empty tool result (e.g. reading an empty file with
		// `:raw`) was serialized as "(see attached image)" with no image
		// anywhere in the turn, sending models chasing a phantom attachment.
		const items = buildResponsesInput({
			model,
			context: makeContext([{ type: "text", text: "" }]),
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
		});

		expect(findFunctionCallOutput(items)).toBe("");
	});

	it("encodes an image-only result as native output content", () => {
		const items = buildResponsesInput({
			model,
			context: makeContext([{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }]),
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
		});

		expect(findFunctionCallOutput(items)).toEqual([
			{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,ZmFrZQ==" },
		]);
	});
});
