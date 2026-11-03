import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { transformKiroRequest } from "@oh-my-pi/pi-ai/providers/kiro/index";
import type { AssistantMessage, Context, Model, Tool, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const lookupParameters = type({ path: "string" });
const lookupTool: Tool<typeof lookupParameters> = {
	name: "lookup",
	description: "Look up a path.",
	parameters: lookupParameters,
};

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createModel(
	options: { reasoning?: boolean; thinking?: Model["thinking"]; maxTokens?: number; contextWindow?: number } = {},
): Model<"kiro-api"> {
	return buildModel({
		id: "kiro-test-model",
		name: "Kiro test model",
		api: "kiro-api",
		provider: "kiro",
		baseUrl: "https://runtime.us-east-1.kiro.dev/",
		reasoning: options.reasoning ?? false,
		...(options.thinking ? { thinking: options.thinking } : {}),
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? 32_000,
		maxTokens: options.maxTokens ?? 4_096,
	});
}

function assistantToolCall(id: string, stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "lookup", arguments: { path: "README.md" } }],
		api: "kiro-api",
		provider: "kiro",
		model: "kiro-test-model",
		usage: zeroUsage,
		stopReason,
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, isError = false, content?: ToolResultMessage["content"]) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "lookup",
		content: content ?? [{ type: "text" as const, text: isError ? "lookup failed" : "file contents" }],
		isError,
		timestamp: 2,
	};
}

function assistantText(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "kiro-api",
		provider: "kiro",
		model: "kiro-test-model",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp,
	};
}

describe("Kiro request transformation", () => {
	test("serializes images, tools, paired historical tool results, and profile-safe tool ids", () => {
		const jpegData = "aGVsbG8=";
		const pngData = "iVBORw0KGgo=";
		const context: Context = {
			systemPrompt: ["Follow the system instruction."],
			messages: [
				{ role: "user", content: "Earlier question", timestamp: 0 },
				assistantToolCall("wire/tool.id"),
				toolResult("wire/tool.id"),
				{
					role: "user",
					content: [
						{ type: "text", text: "Current question" },
						{ type: "image", data: jpegData, mimeType: "image/jpeg" },
						{ type: "image", data: pngData, mimeType: "image/png" },
					],
					timestamp: 3,
				},
			],
			tools: [lookupTool],
		};

		const request = transformKiroRequest(createModel(), context);
		const history = request.conversationState.history ?? [];
		const current = request.conversationState.currentMessage.userInputMessage;
		const historicalAssistant = history.find(entry => entry.assistantResponseMessage)?.assistantResponseMessage;
		const historicalResult = current.userInputMessageContext?.toolResults?.[0];

		expect(history[0]?.userInputMessage?.content).toContain("Follow the system instruction.");
		expect(current.content).toBe("Current question");
		expect(current.images).toEqual([
			{ format: "jpeg", source: { bytes: jpegData } },
			{ format: "png", source: { bytes: pngData } },
		]);
		expect(current.userInputMessageContext?.tools?.[0]?.toolSpecification).toMatchObject({
			name: "lookup",
			description: "Look up a path.",
		});
		expect(current.userInputMessageContext?.tools?.[0]?.toolSpecification.inputSchema.json).toMatchObject({
			type: "object",
			properties: { path: { type: "string" } },
		});
		expect(historicalAssistant?.toolUses?.[0]?.name).toBe("lookup");
		expect(historicalAssistant?.toolUses?.[0]?.toolUseId).toMatch(/^call_/);
		expect(historicalResult?.status).toBe("success");
		expect(historicalResult?.toolUseId).toBe(historicalAssistant?.toolUses?.[0]?.toolUseId);
	});

	test("preserves an empty active-tool description without inventing guidance", () => {
		const emptyDescriptionTool: Tool<typeof lookupParameters> = {
			...lookupTool,
			description: "",
		};
		const context: Context = {
			messages: [{ role: "user", content: "Use the tool", timestamp: 0 }],
			tools: [emptyDescriptionTool],
		};

		const description = transformKiroRequest(createModel(), context).conversationState.currentMessage.userInputMessage
			.userInputMessageContext?.tools?.[0]?.toolSpecification.description;

		expect(description).toBe("");
	});

	test("uses the continuation prompt for image-only current turns", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
					timestamp: 0,
				},
			],
		};

		const current = transformKiroRequest(createModel(), context).conversationState.currentMessage.userInputMessage;
		expect(current.content).toBe("Please proceed with the task.");
		expect(current.images).toEqual([{ format: "png", source: { bytes: "aGVsbG8=" } }]);
	});

	test("uses the continuation prompt when the previous message is assistant-last", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "text", text: "The first answer" }],
					api: "kiro-api",
					provider: "kiro",
					model: "kiro-test-model",
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: 1,
				},
			],
		};

		const request = transformKiroRequest(createModel(), context);
		expect(request.conversationState.currentMessage.userInputMessage.content).toBe("Please proceed with the task.");
		expect(request.conversationState.history?.at(-1)?.assistantResponseMessage?.content).toContain(
			"The first answer",
		);
	});

	test("uses the continuation prompt when the current user content is empty", () => {
		const context: Context = {
			messages: [{ role: "user", content: " \t\n", timestamp: 0 }],
		};

		const request = transformKiroRequest(createModel(), context);
		expect(request.conversationState.currentMessage.userInputMessage.content).toBe("Please proceed with the task.");
	});

	test("clamps adaptive effort and output cap, and omits reasoning when disabled", () => {
		const model = createModel({
			reasoning: true,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.High],
				defaultLevel: Effort.Low,
				supportsDisplay: true,
			},
			maxTokens: 4_096,
		});
		const context: Context = { messages: [{ role: "user", content: "Think", timestamp: 0 }] };

		const clamped = transformKiroRequest(model, context, {
			reasoning: Effort.Medium,
			hideThinkingSummary: true,
			maxTokens: 9_999,
		});
		expect(clamped.additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive", display: "omitted" },
			output_config: { effort: "low" },
			max_tokens: 4_096,
		});

		const disabled = transformKiroRequest(model, context, { reasoning: Effort.High, disableReasoning: true });
		expect(disabled.additionalModelRequestFields).toBeUndefined();
	});

	test("serializes effort reasoning with the standard runtime mode", () => {
		const model = createModel({
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				defaultLevel: Effort.High,
				effortMap: { [Effort.Minimal]: "none" },
			},
		});
		const context: Context = { messages: [{ role: "user", content: "Think", timestamp: 0 }] };

		expect(transformKiroRequest(model, context, { reasoning: Effort.Minimal }).additionalModelRequestFields).toEqual({
			reasoning: { mode: "standard", effort: "none" },
		});
		expect(transformKiroRequest(model, context, { reasoning: Effort.High }).additionalModelRequestFields).toEqual({
			reasoning: { mode: "standard", effort: "high" },
		});
	});

	test("drops an aborted assistant turn together with its orphaned tool result", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("unfinished", "aborted"),
				toolResult("unfinished"),
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		};

		const request = transformKiroRequest(createModel(), context);
		const history = request.conversationState.history ?? [];
		expect(history.some(entry => entry.assistantResponseMessage !== undefined)).toBe(false);
		expect(history.some(entry => entry.userInputMessage?.userInputMessageContext?.toolResults !== undefined)).toBe(
			false,
		);
	});

	test("fails closed for unsupported user image formats", () => {
		for (const mimeType of ["image/bmp", "image/tiff"] as const) {
			const context: Context = {
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: "unsupported-image", mimeType }],
						timestamp: 0,
					},
				],
			};

			expect(() => transformKiroRequest(createModel(), context)).toThrow(/Kiro does not support image type/);
		}
	});

	test("serializes gif and webp user-message images with the Amazon Q wire formats", () => {
		for (const [mimeType, format] of [
			["image/gif", "gif"],
			["image/webp", "webp"],
		] as const) {
			const context: Context = {
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: "YmxvYg==", mimeType }],
						timestamp: 0,
					},
				],
			};

			const current = transformKiroRequest(createModel(), context).conversationState.currentMessage.userInputMessage;
			expect(current.images).toEqual([{ format, source: { bytes: "YmxvYg==" } }]);
		}
	});

	test("promotes JPEG and PNG tool-result images onto the paired user input", () => {
		for (const [mimeType, format] of [
			["image/jpeg", "jpeg"],
			["image/png", "png"],
		] as const) {
			const imageData = "aGVsbG8=";
			const context: Context = {
				messages: [
					{ role: "user", content: "Start", timestamp: 0 },
					assistantToolCall("tool-1"),
					{
						...toolResult("tool-1"),
						content: [
							{ type: "text", text: "file contents" },
							{ type: "image", data: imageData, mimeType },
						],
					},
				],
				tools: [lookupTool],
			};

			const request = transformKiroRequest(createModel(), context);
			const current = request.conversationState.currentMessage.userInputMessage;
			const result = current.userInputMessageContext?.toolResults?.[0];
			const assistant = request.conversationState.history?.find(
				entry => entry.assistantResponseMessage,
			)?.assistantResponseMessage;

			expect(result?.content).toEqual([{ text: "file contents" }]);
			expect(result?.status).toBe("success");
			expect(result?.toolUseId).toBe(assistant?.toolUses?.[0]?.toolUseId);
			expect(current.images).toEqual([{ format, source: { bytes: imageData } }]);
		}
	});

	test("promotes WebP tool-result screenshots without dropping tool bookkeeping", () => {
		const webpData = "UklGRnIAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAIAAAABx9D/AAAAAAAA";
		const context: Context = {
			messages: [
				{ role: "user", content: "Inspect the screenshot", timestamp: 0 },
				assistantToolCall("read-1"),
				{
					...toolResult("read-1"),
					content: [
						{ type: "text", text: "[Image: image/webp]" },
						{ type: "image", data: webpData, mimeType: "image/webp" },
					],
				},
			],
			tools: [lookupTool],
		};

		const request = transformKiroRequest(createModel(), context);
		const current = request.conversationState.currentMessage.userInputMessage;
		const result = current.userInputMessageContext?.toolResults?.[0];
		const assistant = request.conversationState.history?.find(
			entry => entry.assistantResponseMessage,
		)?.assistantResponseMessage;

		expect(result?.content).toEqual([{ text: "[Image: image/webp]" }]);
		expect(result?.toolUseId).toBe(assistant?.toolUses?.[0]?.toolUseId);
		expect(current.images).toEqual([{ format: "webp", source: { bytes: webpData } }]);
	});

	test("substitutes a placeholder when a tool result is image-only", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("tool-1"),
				{
					...toolResult("tool-1"),
					content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				},
				assistantText("Image inspected", 3),
				{ role: "user", content: "Continue", timestamp: 4 },
			],
		};

		const request = transformKiroRequest(createModel(), context);
		const history = request.conversationState.history ?? [];
		const resultEntry = history.find(entry => entry.userInputMessage?.userInputMessageContext?.toolResults)
			?.userInputMessage?.userInputMessageContext?.toolResults?.[0];

		expect(resultEntry?.content).toEqual([{ text: "(image omitted from history)" }]);
		expect(
			history.find(entry => entry.userInputMessage?.userInputMessageContext?.toolResults)?.userInputMessage?.images,
		).toBeUndefined();
	});

	test("batches images from consecutive historical tool results", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("tool-a"),
				assistantToolCall("tool-b"),
				{
					...toolResult("tool-a"),
					content: [
						{ type: "text", text: "first result" },
						{ type: "image", data: "aW1nLWE=", mimeType: "image/png" },
					],
				},
				{
					...toolResult("tool-b"),
					content: [
						{ type: "text", text: "second result" },
						{ type: "image", data: "aW1nLWI=", mimeType: "image/webp" },
					],
				},
				assistantText("Both images inspected", 4),
				{ role: "user", content: "Continue", timestamp: 5 },
			],
		};

		const request = transformKiroRequest(createModel(), context);
		const history = request.conversationState.history ?? [];
		const resultEntry = history.find(
			entry => entry.userInputMessage?.userInputMessageContext?.toolResults,
		)?.userInputMessage;
		const assistantEntries = history.filter(entry => entry.assistantResponseMessage);

		expect(resultEntry?.userInputMessageContext?.toolResults?.map(result => result.content[0]?.text)).toEqual([
			"first result",
			"second result",
		]);
		expect(resultEntry?.userInputMessageContext?.toolResults?.map(result => result.toolUseId)).toEqual(
			assistantEntries.flatMap(entry => entry.assistantResponseMessage?.toolUses?.map(use => use.toolUseId) ?? []),
		);
		expect(resultEntry?.images).toBeUndefined();
	});
	test("marks stripped image-only user history without emitting an empty turn", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
					timestamp: 0,
				},
				assistantText("The image shows a dashboard", 1),
				{ role: "user", content: "Continue", timestamp: 2 },
			],
		};

		const historicalUser = transformKiroRequest(createModel(), context).conversationState.history?.[0]
			?.userInputMessage;

		expect(historicalUser?.content).toBe("(image omitted from history)");
		expect(historicalUser?.images).toBeUndefined();
	});

	test("replays visible assistant text without provisional reasoning", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "discarded hypothesis" },
						{ type: "text", text: "Established conclusion" },
					],
					api: "kiro-api",
					provider: "kiro",
					model: "kiro-test-model",
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: 1,
				},
				{ role: "user", content: "Continue", timestamp: 2 },
			],
		};

		const content = transformKiroRequest(createModel(), context).conversationState.history?.find(
			entry => entry.assistantResponseMessage,
		)?.assistantResponseMessage?.content;

		expect(content).toBe("Established conclusion");
		expect(content).not.toContain("discarded hypothesis");
	});

	test("uses empty user content for structured historical tool results", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("tool-1"),
				toolResult("tool-1"),
				assistantText("Tool result handled", 3),
				{ role: "user", content: "Continue", timestamp: 4 },
			],
		};

		const carrier = transformKiroRequest(createModel(), context).conversationState.history?.find(
			entry => entry.userInputMessage?.userInputMessageContext?.toolResults,
		)?.userInputMessage;

		expect(carrier?.content).toBe("");
		expect(carrier?.userInputMessageContext?.toolResults).toHaveLength(1);
	});

	test("drops unmatched tool state without inventing calls or results", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("missing-result"),
				toolResult("orphan-result"),
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		};

		const request = transformKiroRequest(createModel(), context);
		const serialized = JSON.stringify(request.conversationState);

		expect(serialized).not.toContain("missing-result");
		expect(serialized).not.toContain("orphan-result");
		expect(serialized).not.toContain("unknown_tool");
	});

	test("rejects ambiguous duplicate tool IDs before encoding", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("duplicate"),
				assistantToolCall("duplicate"),
				toolResult("duplicate"),
			],
		};

		expect(() => transformKiroRequest(createModel(), context)).toThrow(/duplicate tool call id/);
	});

	test("truncates tool results to 25000 valid UTF-8 bytes", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("large-result"),
				toolResult("large-result", false, [{ type: "text", text: "é".repeat(20_000) }]),
			],
		};

		const result = transformKiroRequest(createModel(), context).conversationState.currentMessage.userInputMessage
			.userInputMessageContext?.toolResults?.[0]?.content[0]?.text;

		expect(result).toBeDefined();
		expect(Buffer.byteLength(result ?? "", "utf8")).toBeLessThanOrEqual(25_000);
		expect(result).toEndWith("\n...[truncated]");
		expect(result).not.toContain("�");
	});

	test("classifies oversized local history as context overflow", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "A history entry larger than the scaled byte limit", timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					api: "kiro-api",
					provider: "kiro",
					model: "kiro-test-model",
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: 1,
				},
				{ role: "user", content: "Continue", timestamp: 2 },
			],
		};

		try {
			transformKiroRequest(createModel({ contextWindow: 1 }), context);
			expect.unreachable("expected local history overflow");
		} catch (error) {
			expect(AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)).toBe(true);
		}
	});

	test("uses an explicit Kiro conversation identity", () => {
		const context: Context = { messages: [{ role: "user", content: "Start", timestamp: 0 }] };

		expect(
			transformKiroRequest(createModel(), context, { conversationId: "session-1" }).conversationState.conversationId,
		).toBe("session-1");
	});

	test("keeps repeated historical tool turns paired and alternating", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "First", timestamp: 0 },
				assistantToolCall("tool-1"),
				toolResult("tool-1"),
				assistantText("First complete", 3),
				{ role: "user", content: "Second", timestamp: 4 },
				{ ...assistantToolCall("tool-2"), timestamp: 5 },
				{ ...toolResult("tool-2"), timestamp: 6 },
				assistantText("Second complete", 7),
				{ role: "user", content: "Continue", timestamp: 8 },
			],
		};

		const history = transformKiroRequest(createModel(), context).conversationState.history ?? [];
		const roles = history.map(entry => (entry.userInputMessage ? "user" : "assistant"));
		const uses = history.flatMap(entry => entry.assistantResponseMessage?.toolUses ?? []);
		const results = history.flatMap(entry => entry.userInputMessage?.userInputMessageContext?.toolResults ?? []);

		expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
		expect(results.map(result => result.toolUseId)).toEqual(uses.map(use => use.toolUseId));
	});

	test("fails closed for unsupported tool-result image formats", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: 0 },
				assistantToolCall("tool-1"),
				{
					...toolResult("tool-1"),
					content: [{ type: "image", data: "bmp-bytes", mimeType: "image/bmp" }],
				},
			],
		};

		expect(() => transformKiroRequest(createModel(), context)).toThrow(
			/Kiro does not support image type: image\/bmp/,
		);
	});
});
