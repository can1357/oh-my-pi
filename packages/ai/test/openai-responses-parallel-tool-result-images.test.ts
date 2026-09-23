import { describe, expect, it } from "bun:test";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const genericModel = buildModel({
	id: "moonshotai/kimi-k3",
	name: "Kimi K3",
	api: "openai-responses",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
});

const codexModel = buildModel({
	id: "gpt-5.5",
	name: "Codex Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex/responses",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 100_000,
	compat: { supportsImageDetailOriginal: true },
});

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeContext(model: Model): Context {
	return {
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_read_36", name: "read", arguments: { path: "a.png" } },
					{ type: "toolCall", id: "call_read_37", name: "read", arguments: { path: "b.png" } },
					{ type: "toolCall", id: "call_bash_38", name: "bash", arguments: { command: "true" } },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call_read_36",
				toolName: "read",
				content: [
					{ type: "text", text: "first" },
					{ type: "image", mimeType: "image/png", data: "AAAA" },
				],
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_read_37",
				toolName: "read",
				content: [
					{ type: "text", text: "second" },
					{ type: "image", mimeType: "image/png", data: "BBBB" },
				],
				isError: false,
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "call_bash_38",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 4,
			},
			{ role: "user", content: "continue", timestamp: 5 },
		],
	};
}

function expectOrderedToolResults(items: ResponseInput): void {
	expect(items.slice(0, 3).map(item => ("call_id" in item ? item.call_id : undefined))).toEqual([
		"call_read_36",
		"call_read_37",
		"call_bash_38",
	]);
	expect(items.slice(3)).toEqual([
		{
			type: "function_call_output",
			call_id: "call_read_36",
			output: [
				{ type: "input_text", text: "first" },
				{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
			],
		},
		{
			type: "function_call_output",
			call_id: "call_read_37",
			output: [
				{ type: "input_text", text: "second" },
				{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,BBBB" },
			],
		},
		{ type: "function_call_output", call_id: "call_bash_38", output: "done" },
		{ role: "user", content: [{ type: "input_text", text: "continue" }] },
	]);
}

describe("parallel Responses tool-result images", () => {
	it("encodes generic Responses images inside their tool outputs", () => {
		const items = buildResponsesInput({
			model: genericModel,
			context: makeContext(genericModel),
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
		});

		expectOrderedToolResults(items);
	});

	it("encodes Codex Responses images inside their tool outputs", () => {
		const items = convertCodexResponsesMessages(codexModel, makeContext(codexModel));

		expectOrderedToolResults(items);
	});
});
