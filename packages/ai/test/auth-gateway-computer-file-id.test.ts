import { describe, expect, it } from "bun:test";
import { validateAndNormalizeImageReferences } from "@oh-my-pi/pi-ai/auth-gateway/server";
import type { Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function buildResponsesModel(supportsComputerUse: boolean): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		supportsComputerUse,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	} satisfies ModelSpec<"openai-responses">);
}

function buildAnthropicModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	} satisfies ModelSpec<"anthropic-messages">);
}

function computerScreenshotContext(): Context {
	return {
		messages: [
			{
				role: "toolResult",
				toolCallId: "call_computer",
				toolName: "computer",
				content: [],
				providerMetadata: {
					type: "computer",
					screenshot: { type: "computer_screenshot", file_id: "file_image_123" },
				},
				isError: false,
				timestamp: 0,
			} as never,
		],
	};
}

describe("auth gateway computer screenshot file ids", () => {
	it("demotes a supported OpenAI file id to an ordinary image instead of rejecting it", () => {
		const context = computerScreenshotContext();

		expect(validateAndNormalizeImageReferences(context, buildResponsesModel(false))).toBeUndefined();

		const message = context.messages[0] as unknown as Record<string, unknown>;
		expect(message.providerMetadata).toEqual({});
		expect(message.content).toEqual([
			{
				type: "image",
				data: "",
				mimeType: "image/png",
				providerFile: { provider: "openai", id: "file_image_123" },
			},
		]);
	});

	it("keeps the native computer screenshot reference when the target supports computer use", () => {
		const context = computerScreenshotContext();

		expect(validateAndNormalizeImageReferences(context, buildResponsesModel(true))).toBeUndefined();

		const message = context.messages[0] as unknown as Record<string, unknown>;
		expect(message.providerMetadata).toMatchObject({
			type: "computer",
			screenshot: { type: "computer_screenshot", file_id: "file_image_123" },
		});
		expect(message.content).toEqual([]);
	});

	it("still rejects the file id before dispatch to a non-Responses target", () => {
		const context = computerScreenshotContext();

		expect(validateAndNormalizeImageReferences(context, buildAnthropicModel())).toBe(
			"input_image.file_id cannot be forwarded to anthropic-messages; target an OpenAI Responses model or use an inline data URL",
		);
		expect((context.messages[0] as unknown as Record<string, unknown>).content).toEqual([]);
	});
});
