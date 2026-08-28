import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { convertMessages as convertGoogleMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertMessages as convertOpenAICompletionsMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	appendResponsesToolResultMessages,
	convertResponsesInputContent,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { NON_VISION_IMAGE_PLACEHOLDER } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { Api, AssistantMessage, Context, Model, ModelSpec, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: ResolvedOpenAICompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsMultipleSystemMessages: true,
	supportsReasoningEffort: true,
	supportsReasoningParams: true,
	supportsSamplingParams: true,
	supportsPenaltyAndStopParams: true,
	alwaysSendMaxTokens: false,
	isOpenRouterHost: false,
	isVercelGatewayHost: false,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	supportsToolChoice: true,
	supportsForcedToolChoice: true,
	supportsNamedToolChoice: true,
	disableReasoningOnForcedToolChoice: false,
	disableReasoningOnToolChoice: false,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	reasoningDisableMode: "lowest-effort",
	omitReasoningEffort: false,
	includeEncryptedReasoning: true,
	filterReasoningHistory: false,
	reasoningContentField: "reasoning_content",
	requiresReasoningContentForToolCalls: false,
	requiresReasoningContentForAllAssistantTurns: false,
	allowsSyntheticReasoningContentForToolCalls: true,
	replayReasoningContent: false,
	qwenPreserveThinking: false,
	qwenTemplateReasoningEffort: false,
	requiresAssistantContentForToolCalls: false,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	extraBody: {},
	supportsStrictMode: true,
	toolStrictMode: "none",
	wireModelIdMode: "raw",
	stripDeepseekSpecialTokens: false,
	reasoningDeltasMayBeCumulative: false,
	emptyLengthFinishIsContextError: false,
	usesOpenAIToolCallIdLimit: false,
	dropThinkingWhenReasoningEffort: false,
};

function makeModel<TApi extends Api>(api: TApi, provider: Model["provider"]): Model<TApi> {
	return buildModel({
		id: `${provider}-${api}-text-only`,
		name: `${provider} ${api}`,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as ModelSpec<TApi>);
}

function makeAssistant(api: Model["api"], provider: Model["provider"], modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "python", arguments: { code: "plot()" } }],
		api,
		provider,
		model: modelId,
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function makeToolResult(content: ToolResultMessage["content"]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "python",
		content,
		isError: false,
		timestamp: 3,
	};
}

function countTaggedValues(value: unknown, tag: string): number {
	if (Array.isArray(value)) {
		return value.reduce((sum, item) => sum + countTaggedValues(item, tag), 0);
	}
	if (!value || typeof value !== "object") {
		return 0;
	}
	const record = value as Record<string, unknown>;
	const own = record.type === tag ? 1 : 0;
	return Object.values(record).reduce<number>((sum, item) => sum + countTaggedValues(item, tag), own);
}

function countObjectKeys(value: unknown, key: string): number {
	if (Array.isArray(value)) {
		return value.reduce((sum, item) => sum + countObjectKeys(item, key), 0);
	}
	if (!value || typeof value !== "object") {
		return 0;
	}
	const record = value as Record<string, unknown>;
	const own = Object.hasOwn(record, key) ? 1 : 0;
	return Object.values(record).reduce<number>((sum, item) => sum + countObjectKeys(item, key), own);
}

describe("issue #967 vision guard", () => {
	it("strips non-vision images from OpenAI chat-completions user and tool-result payloads", () => {
		const model = makeModel("openai-completions", "openrouter");
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "plot summary" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					timestamp: 1,
				},
				makeAssistant(model.api, model.provider, model.id),
				makeToolResult([
					{ type: "text", text: "saved plot to /tmp/plot.png" },
					{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
				]),
			],
		};

		const messages = convertOpenAICompletionsMessages(model, context, compat);
		expect(countTaggedValues(messages, "image_url")).toBe(0);
		expect(messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "plot summary" },
				{ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER },
			],
		});
		expect(messages.find(message => message.role === "tool")).toMatchObject({
			content: `saved plot to /tmp/plot.png\n${NON_VISION_IMAGE_PLACEHOLDER}`,
		});
	});

	it("strips non-vision images from OpenAI responses payload builders", () => {
		const model = makeModel("openai-responses", "openrouter");
		const userContent = convertResponsesInputContent(
			[
				{ type: "text", text: "plot summary" },
				{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
			],
			false,
			model.compat.supportsImageDetailOriginal,
		);
		expect(countTaggedValues(userContent, "input_image")).toBe(0);
		expect(userContent).toEqual([
			{ type: "input_text", text: "plot summary" },
			{ type: "input_text", text: NON_VISION_IMAGE_PLACEHOLDER },
		]);

		const payload: unknown[] = [];
		appendResponsesToolResultMessages(
			payload as never,
			makeToolResult([
				{ type: "text", text: "saved plot to /tmp/plot.png" },
				{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
			]),
			model,
			true,
			model.compat.supportsImageDetailOriginal,
			new Set(["call_1"]),
		);
		expect(countTaggedValues(payload, "input_image")).toBe(0);
		expect(payload).toEqual([
			{
				type: "function_call_output",
				call_id: "call_1",
				output: `saved plot to /tmp/plot.png\n${NON_VISION_IMAGE_PLACEHOLDER}`,
			},
		]);
	});

	it("strips non-vision images from Codex responses user and tool-result payloads", () => {
		const model = makeModel("openai-codex-responses", "openai-codex");
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "plot summary" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					timestamp: 1,
				},
				makeAssistant(model.api, model.provider, model.id),
				makeToolResult([{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }]),
			],
		};

		const messages = convertCodexResponsesMessages(model, context);
		expect(countTaggedValues(messages, "input_image")).toBe(0);
		expect(messages.filter(item => (item as { role?: string }).role === "user")).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			role: "user",
			content: [
				{ type: "input_text", text: "plot summary" },
				{ type: "input_text", text: NON_VISION_IMAGE_PLACEHOLDER },
			],
		});
		expect(messages.find(item => (item as { type?: string }).type === "function_call_output")).toMatchObject({
			output: NON_VISION_IMAGE_PLACEHOLDER,
		});
	});

	it("strips non-vision images from Anthropic payloads", () => {
		const model = makeModel("anthropic-messages", "anthropic");
		const messages = convertAnthropicMessages(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "plot summary" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					timestamp: 1,
				},
				makeAssistant(model.api, model.provider, model.id),
				makeToolResult([{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }]),
			],
			model,
			false,
		);
		expect(countTaggedValues(messages, "image")).toBe(0);
		expect(messages[0]).toMatchObject({ role: "user", content: `plot summary\n${NON_VISION_IMAGE_PLACEHOLDER}` });
		const toolResult = messages.at(-1) as { role: string; content: Array<{ type: string; content: unknown }> };
		expect(toolResult.role).toBe("user");
		expect(toolResult.content[0]).toMatchObject({
			type: "tool_result",
			content: NON_VISION_IMAGE_PLACEHOLDER,
		});
	});

	it("strips non-vision images from Google payloads", () => {
		const model = makeModel("google-generative-ai", "google");
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "plot summary" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					timestamp: 1,
				},
				makeAssistant(model.api, model.provider, model.id),
				makeToolResult([{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }]),
			],
		};

		const messages = convertGoogleMessages(model, context);
		expect(countObjectKeys(messages, "inlineData")).toBe(0);
		expect(messages[0]).toMatchObject({
			role: "user",
			parts: [{ text: "plot summary" }, { text: NON_VISION_IMAGE_PLACEHOLDER }],
		});
		expect(messages.at(-1)).toMatchObject({
			role: "user",
			parts: [
				{
					functionResponse: {
						response: { output: NON_VISION_IMAGE_PLACEHOLDER },
					},
				},
			],
		});
	});
});
