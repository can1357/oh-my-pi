import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

interface OpenAICompletionAssistantWireMessage {
	role: "assistant";
	content?: unknown;
	reasoning_content?: unknown;
}

function isOpenAICompletionAssistantWireMessage(message: unknown): message is OpenAICompletionAssistantWireMessage {
	if (typeof message !== "object" || message === null) return false;
	return (message as { role?: unknown }).role === "assistant";
}

function findOpenAICompletionAssistantWireMessage(
	messages: readonly unknown[] | undefined,
): OpenAICompletionAssistantWireMessage | undefined {
	return messages?.find(isOpenAICompletionAssistantWireMessage);
}

function deepseekModel(overrides: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		reasoning: true,
		compat: base.compatConfig,
		...overrides,
	} as ModelSpec<"openai-completions">);
}

function assistantWithToolCall(model: Model<"openai-completions">): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Calling a tool." },
			{
				type: "toolCall",
				id: "call_repro_1",
				name: "list_files",
				arguments: { path: "." },
			},
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
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

describe("issue #883 / #810 — DeepSeek V4 reasoning_content tool-call replay", () => {
	it("flags requiresReasoningContentForToolCalls for deepseek-v4-pro on the official endpoint", () => {
		const compat = deepseekModel({
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			id: "deepseek-v4-pro",
		}).compat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("flags requiresReasoningContentForToolCalls for deepseek-v4 served by a non-deepseek host (e.g. Deepinfra)", () => {
		const compat = deepseekModel({
			provider: "deepinfra",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			id: "deepseek-ai/DeepSeek-V4-Flash",
		}).compat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("sets reasoning_content to empty string for deepseek-v4-pro tool-call turn with no thinking blocks", () => {
		const model = deepseekModel({
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			id: "deepseek-v4-pro",
		});
		const compat = model.compat;
		const messages = convertMessages(model, { messages: [assistantWithToolCall(model)] }, compat);
		const assistant = findOpenAICompletionAssistantWireMessage(messages);
		expect(assistant).toBeDefined();
		const reasoningContent = assistant?.reasoning_content;
		expect(reasoningContent).toBeDefined();
		// DeepSeek rejects synthetic "." — when no thinking blocks exist, we emit empty string
		expect(reasoningContent).toBe("");
	});

	it("normalizes assistant content to '' when reasoning_content placeholder is injected (DeepSeek invariant)", () => {
		const model = deepseekModel({
			provider: "deepinfra",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			id: "deepseek-ai/DeepSeek-V4-Pro",
		});
		const compat = model.compat;
		// Assistant turn whose only content is a tool call (no text) - matches what the SDK
		// produces after a pure tool-use turn. content must end up "" (not null) because
		// DeepSeek rejects null content alongside reasoning_content.
		const toolOnly: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_repro_2",
					name: "list_files",
					arguments: { path: "." },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		const messages = convertMessages(model, { messages: [toolOnly] }, compat);
		const assistant = findOpenAICompletionAssistantWireMessage(messages);
		expect(assistant).toBeDefined();
		expect(assistant?.content).toBe("");
	});
});
