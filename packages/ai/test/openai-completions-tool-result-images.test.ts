import { describe, expect, it } from "bun:test";
import { convertMessages } from "@pk-nerdsaver-ai/pi-ai/providers/openai-completions";
import { NON_VISION_IMAGE_PLACEHOLDER } from "@pk-nerdsaver-ai/pi-ai/providers/vision-guard";
import type { AssistantMessage, Context, Model, ToolResultMessage, Usage } from "@pk-nerdsaver-ai/pi-ai/types";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import type { ResolvedOpenAICompat } from "@pk-nerdsaver-ai/pi-catalog/types";

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
	requiresAssistantContentForToolCalls: false,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	extraBody: {},
	supportsStrictMode: true,
	toolStrictMode: "none",
	supportsReasoningParams: true,
	alwaysSendMaxTokens: false,
	isOpenRouterHost: false,
	isVercelGatewayHost: false,
	wireModelIdMode: "raw",
	stripDeepseekSpecialTokens: false,
	reasoningDeltasMayBeCumulative: false,
	emptyLengthFinishIsContextError: false,
	usesOpenAIToolCallIdLimit: false,
	dropThinkingWhenReasoningEffort: false,
};

function buildToolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		],
		isError: false,
		timestamp,
	};
}

describe("openai-completions convertMessages", () => {
	it("batches tool-result images after consecutive tool results", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text", "image"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "img-1.png" } },
				{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "img-2.png" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read the images", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1),
				buildToolResult("tool-2", now + 2),
			],
		};

		const messages = convertMessages(model, context, compat);
		const roles = messages.map(message => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);

		const imageMessage = messages[messages.length - 1];
		expect(imageMessage.role).toBe("user");
		expect(Array.isArray(imageMessage.content)).toBe(true);

		const imageParts = (imageMessage.content as Array<{ type?: string }>).filter(part => part?.type === "image_url");
		expect(imageParts.length).toBe(2);
	});
	it("serializes assistant tool-call turns with string content for strict OpenAI-compatible backends", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const context: Context = {
			messages: [
				{ role: "user", content: "Read missing file", timestamp: now - 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "missing.txt" } }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: emptyUsage,
					stopReason: "toolUse",
					timestamp: now,
				},
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "read",
					content: [{ type: "text", text: "" }],
					isError: false,
					timestamp: now + 1,
				},
			],
		};

		const messages = convertMessages(model, context, compat);
		const assistantParam = messages.find(message => message.role === "assistant") as
			| { role: "assistant"; content: unknown; tool_calls?: Array<{ id: string }> }
			| undefined;

		expect(assistantParam?.tool_calls).toHaveLength(1);
		expect(assistantParam?.content).toBe("");
	});

	it("uses generated tool_call_id values when assistant/tool IDs are empty", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "", name: "read", arguments: { path: "README.md" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read README", timestamp: now - 1 },
				assistantMessage,
				{
					role: "toolResult",
					toolCallId: "",
					toolName: "read",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: now + 1,
				},
			],
		};

		const messages = convertMessages(model, context, compat);
		const assistantParam = messages.find(message => message.role === "assistant") as
			| { role: "assistant"; tool_calls?: Array<{ id: string }> }
			| undefined;
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.tool_calls).toBeDefined();
		const generatedId = assistantParam!.tool_calls![0].id;
		expect(generatedId.length).toBeGreaterThan(0);

		const toolParam = messages.find(message => message.role === "tool") as { tool_call_id: string } | undefined;
		expect(toolParam).toBeDefined();
		expect(toolParam?.tool_call_id).toBe(generatedId);
	});

	it("serializes string tool arguments into valid JSON objects", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tool-1",
					name: "read",
					arguments: '{"path":"README.md"}' as unknown as Record<string, any>,
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [{ role: "user", content: "Read README", timestamp: now - 1 }, assistantMessage],
		};

		const messages = convertMessages(model, context, compat);
		const assistantParam = messages.find(message => message.role === "assistant") as
			| { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> }
			| undefined;
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.tool_calls).toBeDefined();
		const serializedArgs = assistantParam!.tool_calls![0].function.arguments;
		expect(JSON.parse(serializedArgs)).toEqual({ path: "README.md" });
	});
	it("strips image_url content for DashScope compatible-mode text-only Qwen models (issue #1859)", () => {
		// Reproduces the bailian/qwen3.7-max + dashscope.aliyuncs.com/compatible-mode
		// 400 from issue #1859: even when a misconfigured `model.input` claims
		// image support, sending an `image_url` part to a non-VL/Omni Qwen on
		// the consumer DashScope endpoint server-errors with
		// "Unexpected item type in content.". Verify both the synthesized user
		// turn (text-only message) and the tool-result image batching path drop
		// images for that combination, substituting the standard placeholder.
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			id: "qwen3.7-max",
			provider: "bailian" as Model<"openai-completions">["provider"],
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			api: "openai-completions",
			// Wrong-but-realistic user config: claims vision capability even
			// though qwen3.7-max on this endpoint is text-only upstream.
			input: ["text", "image"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "browser", arguments: { action: "screenshot" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Take a screenshot" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/webp" },
					],
					timestamp: now - 2,
				},
				assistantMessage,
				buildToolResult("tool-1", now + 1),
			],
		};

		const messages = convertMessages(model, context, compat);

		// No converted turn carries an image_url part — the dashscope guard
		// must veto both the user-content and tool-result-batching emit paths.
		for (const m of messages) {
			if (Array.isArray(m.content)) {
				for (const part of m.content as Array<{ type?: string }>) {
					expect(part?.type).not.toBe("image_url");
				}
			}
		}

		// User content with the dropped image keeps the text and appends the
		// standard "image omitted" placeholder so the model still sees that an
		// attachment existed.
		const userMessage = messages.find(m => m.role === "user");
		expect(userMessage).toBeDefined();
		const userContent = userMessage?.content;
		const userText =
			typeof userContent === "string"
				? userContent
				: (userContent as Array<{ type?: string; text?: string }>)
						.filter(p => p?.type === "text")
						.map(p => p?.text ?? "")
						.join("\n");
		expect(userText).toContain("Take a screenshot");
		expect(userText).toContain(NON_VISION_IMAGE_PLACEHOLDER);

		// Tool-result image is folded into the tool text content with the same
		// placeholder rather than emitted as a follow-up multimodal user turn.
		const toolMessage = messages.find(m => m.role === "tool");
		expect(toolMessage).toBeDefined();
		expect(typeof toolMessage?.content).toBe("string");
		expect(toolMessage?.content as string).toContain(NON_VISION_IMAGE_PLACEHOLDER);
	});

	it("preserves image_url for DashScope compatible-mode multimodal Qwen models", () => {
		// Counter-cases for the issue #1859 guard: DashScope also exposes
		// genuinely multimodal Qwen ids without `vl` in the name (`qwen3.7-plus`),
		// so the text-only override must be limited to known text-only families.
		for (const id of ["qwen3.7-plus", "qwen-vl-max"]) {
			const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			const model: Model<"openai-completions"> = {
				...baseModel,
				id,
				provider: "bailian" as Model<"openai-completions">["provider"],
				baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				api: "openai-completions",
				input: ["text", "image"],
			};

			const now = Date.now();
			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "img.png" } }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage,
				stopReason: "toolUse",
				timestamp: now,
			};

			const context: Context = {
				messages: [
					{ role: "user", content: "Read the image", timestamp: now - 2 },
					assistantMessage,
					buildToolResult("tool-1", now + 1),
				],
			};

			const messages = convertMessages(model, context, compat);
			const trailingUser = messages[messages.length - 1];
			expect(trailingUser.role).toBe("user");
			expect(Array.isArray(trailingUser.content)).toBe(true);
			const imageParts = (trailingUser.content as Array<{ type?: string }>).filter(p => p?.type === "image_url");
			expect(imageParts.length).toBe(1);
		}
	});
});
