import { describe, expect, it } from "bun:test";
import {
	buildTransformedCodexRequestBody,
	convertCodexResponsesMessages,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
					{ type: "image", mimeType: "image/png", data: PNG_B64 },
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
					{ type: "image", mimeType: "image/png", data: PNG_B64 },
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
				{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${PNG_B64}` },
			],
		},
		{
			type: "function_call_output",
			call_id: "call_read_37",
			output: [
				{ type: "input_text", text: "second" },
				{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${PNG_B64}` },
			],
		},
		{ type: "function_call_output", call_id: "call_bash_38", output: "done" },
		{ role: "user", content: [{ type: "input_text", text: "continue" }] },
	]);
}

function makeInterleavedOrphanContext(model: Model): Context {
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a" } }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call_b",
				toolName: "read",
				content: [
					{ type: "text", text: "orphan" },
					{ type: "image", mimeType: "image/png", data: PNG_B64, detail: "high" },
				],
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_a",
				toolName: "read",
				content: [{ type: "text", text: "paired" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

type ReplayItem = {
	type?: string | null;
	call_id?: string | null;
	role?: string;
	content?: unknown;
};

function expectInterleavedOrphanFallback(items: ReadonlyArray<ReplayItem>): void {
	const callIndex = items.findIndex(item => item.type === "function_call" && item.call_id === "call_a");
	expect(callIndex).toBeGreaterThanOrEqual(0);
	expect(items[callIndex + 1]).toMatchObject({ type: "function_call_output", call_id: "call_a" });
	expect(items.some(item => item.type === "function_call_output" && item.call_id === "call_b")).toBe(false);

	const imageFallback = items.find(
		item =>
			item.type === "message" &&
			item.role === "user" &&
			Array.isArray(item.content) &&
			item.content.some(
				part => part !== null && typeof part === "object" && "type" in part && part.type === "input_image",
			),
	);
	expect(imageFallback).toMatchObject({
		type: "message",
		role: "user",
		content: [{ type: "input_image", detail: "high", image_url: `data:image/png;base64,${PNG_B64}` }],
	});
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

	it("keeps an interleaved orphan image after the paired Responses batch", () => {
		const items = buildResponsesInput({
			model: genericModel,
			context: makeInterleavedOrphanContext(genericModel),
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
		});

		expectInterleavedOrphanFallback(items);
	});

	it("keeps an interleaved orphan image after the paired Codex batch", async () => {
		const body = await buildTransformedCodexRequestBody(
			codexModel,
			makeInterleavedOrphanContext(codexModel),
			undefined,
		);

		expectInterleavedOrphanFallback(body.input ?? []);
	});
});
