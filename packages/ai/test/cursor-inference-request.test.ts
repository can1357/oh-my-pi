import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { InferenceMessageRole } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import { decodeJsonStruct, decodeJsonValue } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { Context, Model, Tool } from "../src/types";
import {
	buildInferenceRequest,
	buildInferenceRunRequest,
	inferenceRoutingKey,
	withoutRunScopedReasoning,
} from "../src/providers/cursor/request";
import { NON_VISION_IMAGE_PLACEHOLDER } from "../src/providers/vision-guard";

function cursorModel(id = "composer-2.5", input: ("text" | "image")[] = ["text", "image"]): Model<"cursor-agent"> {
	return buildModel({
		id,
		name: id,
		provider: "cursor",
		api: "cursor-agent",
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

const TOOL = {
	name: "join_fragments",
	description: "Join two fragments.",
	parameters: {
		type: "object",
		properties: { left: { type: "string" }, right: { type: "string" } },
		required: ["left", "right"],
		additionalProperties: false,
	},
} as const;

const PNG_BASE64 = Buffer.concat([
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"),
	Buffer.alloc(12),
]).toString("base64");

function history(): Context {
	return {
		systemPrompt: ["Use the tool.", "Return its result."],
		messages: [
			{ role: "user", content: "Join the fragments.", timestamp: 1 },
			{
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: "gpt",
				responseId: "response-1",
				content: [
					{ type: "thinking", thinking: "Use the tool.", thinkingSignature: "sig" },
					{ type: "text", text: "Calling now." },
					{ type: "toolCall", id: "tool-1", name: TOOL.name, arguments: { left: "A", right: "B" } },
				],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: TOOL.name,
				content: [{ type: "text", text: "AB" }],
				isError: false,
				timestamp: 3,
			},
		],
		tools: [TOOL],
	};
}

describe("Cursor managed-inference request", () => {
	test("projects complete cross-provider history and ordinary OMP tools", () => {
		const request = buildInferenceRequest(cursorModel(), history());
		expect(request.invocationId).toBeUndefined();
		expect(request.conversationId).toBeUndefined();
		expect(request.requestedModel).toBeUndefined();
		expect(request.messages.map(message => message.role)).toEqual([4, 1, 2, 3]);
		expect(request.messages[0]?.content).toEqual({ case: "text", value: "Use the tool.\n\nReturn its result." });
		const assistant = request.messages[2];
		expect(assistant?.content).toEqual({ case: "text", value: "Calling now." });
		expect(assistant?.reasoningParts).toEqual([]);
		expect(assistant?.modelProviderMessageId).toBe("response-1");
		expect(decodeJsonStruct(assistant?.toolCalls[0]?.args ?? new Uint8Array())).toEqual({ left: "A", right: "B" });
		const result = request.messages[3]?.content;
		if (result?.case !== "toolContent") throw new Error("tool result content missing");
		expect(decodeJsonValue(result.value.parts[0]?.result ?? new Uint8Array())).toBe("AB");
		expect(request.tools[0]).toMatchObject({ name: TOOL.name, description: TOOL.description });
		expect(decodeJsonStruct(request.tools[0]?.parameters ?? new Uint8Array())).toEqual({
			jsonSchema: {
				...TOOL.parameters,
				required: ["left", "right"],
			},
		});
	});

	test("normalizes cross-provider tool-call and result ids as one pair", () => {
		const context = history();
		const assistant = context.messages[1];
		const result = context.messages[2];
		if (assistant?.role !== "assistant" || result?.role !== "toolResult") throw new Error("tool history missing");
		const call = assistant.content.find(part => part.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("tool call missing");
		call.id = "call_123|fc_assistant";
		result.toolCallId = "call_123|fc_result";
		const request = buildInferenceRequest(cursorModel(), context);
		expect(request.messages[2]?.toolCalls[0]?.toolCallId).toBe("call_123_fc_assistant");
		const toolContent = request.messages[3]?.content;
		if (toolContent?.case !== "toolContent") throw new Error("tool result missing");
		expect(toolContent.value.parts[0]?.toolCallId).toBe("call_123_fc_assistant");
	});

	test("keeps colliding normalized tool-call ids unique", () => {
		const context = history();
		const assistant = context.messages[1];
		const firstResult = context.messages[2];
		if (assistant?.role !== "assistant" || firstResult?.role !== "toolResult") {
			throw new Error("tool history missing");
		}
		const firstCall = assistant.content.find(part => part.type === "toolCall");
		if (firstCall?.type !== "toolCall") throw new Error("tool call missing");
		firstCall.id = "call:a";
		firstResult.toolCallId = "call:a";
		assistant.content.push({
			type: "toolCall",
			id: "call/a",
			name: TOOL.name,
			arguments: { left: "C", right: "D" },
		});
		context.messages.push({
			role: "toolResult",
			toolCallId: "call/a",
			toolName: TOOL.name,
			content: [{ type: "text", text: "CD" }],
			isError: false,
			timestamp: 4,
		});

		const request = buildInferenceRequest(cursorModel(), context);
		expect(request.messages[2]?.toolCalls.map(call => call.toolCallId)).toEqual(["call_a", "call_a_dup1"]);
		const resultIds = request.messages.slice(3).map(message => {
			if (message.content?.case !== "toolContent") throw new Error("tool result missing");
			return message.content.value.parts[0]?.toolCallId;
		});
		expect(resultIds).toEqual(["call_a", "call_a_dup1"]);
	});

	test("deduplicates repeated raw tool ids by call occurrence", () => {
		const context = history();
		const firstAssistant = context.messages[1];
		const firstResult = context.messages[2];
		if (firstAssistant?.role !== "assistant" || firstResult?.role !== "toolResult") {
			throw new Error("tool history missing");
		}
		const firstCall = firstAssistant.content.find(part => part.type === "toolCall");
		if (firstCall?.type !== "toolCall") throw new Error("tool call missing");
		firstCall.id = "reused-id";
		firstResult.toolCallId = "reused-id";
		const secondAssistant = structuredClone(firstAssistant);
		const secondCall = secondAssistant.content.find(part => part.type === "toolCall");
		if (secondCall?.type !== "toolCall") throw new Error("second tool call missing");
		secondCall.id = "reused-id";
		secondAssistant.timestamp = 4;
		context.messages.push(secondAssistant, {
			role: "toolResult",
			toolCallId: "reused-id",
			toolName: TOOL.name,
			content: [{ type: "text", text: "second" }],
			isError: false,
			timestamp: 5,
		});

		const request = buildInferenceRequest(cursorModel(), context);
		const callIds = request.messages.flatMap(message => message.toolCalls.map(call => call.toolCallId));
		const resultIds = request.messages.flatMap(message =>
			message.content?.case === "toolContent" ? message.content.value.parts.map(result => result.toolCallId) : [],
		);
		expect(callIds).toEqual(["reused-id", "reused-id_dup1"]);
		expect(resultIds).toEqual(["reused-id", "reused-id_dup1"]);
	});

	test("omits tools for none and safely narrows unsupported forced choices", () => {
		expect(buildInferenceRequest(cursorModel(), history(), { toolChoice: "none" }).tools).toEqual([]);
		expect(
			buildInferenceRequest(cursorModel(), history(), { toolChoice: "required" }).tools.map(tool => tool.name),
		).toEqual([TOOL.name]);
		expect(
			buildInferenceRequest(
				cursorModel(),
				{ ...history(), tools: [TOOL, { ...TOOL, name: "other" }] },
				{ toolChoice: { type: "tool", name: TOOL.name } },
			).tools.map(tool => tool.name),
		).toEqual([TOOL.name]);
	});

	test("advertises tools under their dispatcher-visible custom wire names", () => {
		const request = buildInferenceRequest(cursorModel(), {
			messages: [{ role: "user", content: "apply the patch", timestamp: 1 }],
			tools: [{ ...TOOL, name: "edit", customWireName: "apply_patch" }],
		});
		expect(request.tools.map(tool => tool.name)).toEqual(["apply_patch"]);
	});

	test("preserves ordered user image parts exactly as the extracted adapter sends them", () => {
		const request = buildInferenceRequest(cursorModel(), {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "before 𝄞" },
						{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
						{ type: "text", text: "after 😀" },
					],
					timestamp: 1,
				},
			],
		});
		const content = request.messages[0]?.content;
		if (content?.case !== "parts") throw new Error("Cursor image parts missing");
		expect(content.value.parts.map(part => part.part.case)).toEqual(["text", "image", "text"]);
		const image = content.value.parts[1]?.part;
		if (image?.case !== "image") throw new Error("Cursor image part missing");
		expect(image.value).toMatchObject({ data: PNG_BASE64, mimeType: "image/png" });
	});

	test("uses standard image placeholders for text-only Cursor models", () => {
		const context = history();
		const user = context.messages[0];
		const assistant = context.messages[1];
		const result = context.messages[2];
		if (user?.role !== "user" || assistant?.role !== "assistant" || result?.role !== "toolResult") {
			throw new Error("tool history missing");
		}
		user.content = [
			{ type: "text", text: "user text" },
			{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
		];
		assistant.content.push({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
		result.content = [
			{ type: "text", text: "tool text" },
			{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
		];

		const request = buildInferenceRequest(cursorModel("text-only", ["text"]), context);
		expect(request.messages[1]?.content).toEqual({
			case: "text",
			value: `user text\n${NON_VISION_IMAGE_PLACEHOLDER}`,
		});
		expect(request.messages[2]?.content).toEqual({
			case: "text",
			value: `Calling now.\n${NON_VISION_IMAGE_PLACEHOLDER}`,
		});
		const toolContent = request.messages[3]?.content;
		if (toolContent?.case !== "toolContent") throw new Error("Cursor tool result missing");
		expect(decodeJsonValue(toolContent.value.parts[0]?.result ?? new Uint8Array())).toBe(
			`tool text\n${NON_VISION_IMAGE_PLACEHOLDER}`,
		);
		expect(toolContent.value.parts[0]?.experimentalContent).toEqual([]);
	});

	test("preserves image-bearing error tool results as experimental content", () => {
		const request = buildInferenceRequest(cursorModel(), {
			messages: [
				{
					role: "assistant",
					api: "cursor-agent",
					provider: "cursor",
					model: "composer-2.5",
					content: [{ type: "toolCall", id: "image-1", name: "inspect_image", arguments: {} }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "image-1",
					toolName: "inspect_image",
					content: [
						{ type: "text", text: "failed after capture" },
						{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
					],
					isError: true,
					timestamp: 2,
				},
			],
		});
		const content = request.messages[1]?.content;
		if (content?.case !== "toolContent") throw new Error("Cursor tool result missing");
		const result = content.value.parts[0];
		expect(result).toMatchObject({ toolCallId: "image-1", toolName: "inspect_image", isError: true });
		expect(result?.experimentalContent.map(part => part.part.case)).toEqual(["text", "image"]);
		const image = result?.experimentalContent[1]?.part;
		if (image?.case !== "image") throw new Error("Cursor tool-result image missing");
		expect(image.value).toMatchObject({ data: PNG_BASE64, mimeType: "image/png" });
	});

	test("drops malformed replay tool calls and their results before Cursor serialization", () => {
		const context = history();
		const assistant = context.messages[1];
		const result = context.messages[2];
		if (assistant?.role !== "assistant" || result?.role !== "toolResult") {
			throw new Error("tool history missing");
		}
		assistant.content = [
			{ type: "text", text: "safe text" },
			{ type: "toolCall", id: " ", name: TOOL.name, arguments: {} },
			{ type: "toolCall", id: "bad-name", name: "\t", arguments: {} },
		];
		context.messages = [assistant, { ...result, toolCallId: " " }, { ...result, toolCallId: "bad-name" }];

		const request = buildInferenceRequest(cursorModel(), context);
		expect(request.messages).toHaveLength(2);
		expect(request.messages[1]?.content).toEqual({ case: "text", value: "safe text" });
		expect(request.messages[1]?.toolCalls).toEqual([]);
	});

	test("repairs orphan tool results before Cursor serialization", () => {
		const request = buildInferenceRequest(cursorModel(), {
			messages: [
				{
					role: "toolResult",
					toolCallId: "orphan",
					toolName: "read",
					content: [{ type: "text", text: "retained output" }],
					isError: false,
					timestamp: 1,
				},
			],
		});
		expect(request.messages).toHaveLength(1);
		expect(request.messages[0]).toMatchObject({
			role: 1,
			content: { case: "text", value: expect.stringContaining("retained output") },
		});
		expect(request.messages[0]?.content.case).not.toBe("toolContent");
	});

	test("drops an orphan result inside a pending tool-call window", () => {
		const context = history();
		const assistant = context.messages[1];
		const result = context.messages[2];
		if (assistant?.role !== "assistant" || result?.role !== "toolResult") {
			throw new Error("tool history missing");
		}
		const request = buildInferenceRequest(cursorModel(), {
			messages: [
				assistant,
				{
					role: "toolResult",
					toolCallId: "orphan",
					toolName: "read",
					content: [{ type: "text", text: "must not split the open window" }],
					isError: false,
					timestamp: 3,
				},
				result,
			],
		});
		expect(request.messages.map(message => message.role)).toEqual([
			InferenceMessageRole.ASSISTANT,
			InferenceMessageRole.TOOL,
		]);
		const toolContent = request.messages[1]?.content;
		if (toolContent?.case !== "toolContent") throw new Error("paired tool result missing");
		expect(toolContent.value.parts[0]?.toolCallId).toBe(request.messages[0]?.toolCalls[0]?.toolCallId);
	});

	test("does not pair composite orphan results with opaque non-Responses calls", () => {
		const context = history();
		const assistant = context.messages[1];
		const result = context.messages[2];
		if (assistant?.role !== "assistant" || result?.role !== "toolResult") {
			throw new Error("tool history missing");
		}
		assistant.api = "openai-completions";
		const call = assistant.content.find(part => part.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("tool call missing");
		call.id = "opaque-call";
		result.toolCallId = "opaque-call";
		result.content = [{ type: "text", text: "real result" }];

		const request = buildInferenceRequest(cursorModel(), {
			...context,
			messages: [
				assistant,
				{
					role: "toolResult",
					toolCallId: "opaque-call|unrelated-item",
					toolName: "wrong-tool",
					content: [{ type: "text", text: "orphan payload" }],
					isError: false,
					timestamp: 3,
				},
				result,
			],
		});
		const toolContent = request.messages.find(message => message.content.case === "toolContent")?.content;
		if (toolContent?.case !== "toolContent") throw new Error("paired tool result missing");
		expect(toolContent.value.parts).toHaveLength(1);
		expect(toolContent.value.parts[0]?.toolName).toBe(TOOL.name);
		expect(decodeJsonValue(toolContent.value.parts[0]?.result ?? new Uint8Array())).toBe("real result");
	});

	test("closes missing tool results before later reused ids", () => {
		const context = history();
		const firstAssistant = context.messages[1];
		if (firstAssistant?.role !== "assistant") throw new Error("assistant history missing");
		const firstCall = firstAssistant.content.find(part => part.type === "toolCall");
		if (firstCall?.type !== "toolCall") throw new Error("tool call missing");
		firstCall.id = "reused-id";
		const secondAssistant = structuredClone(firstAssistant);
		const secondCall = secondAssistant.content.find(part => part.type === "toolCall");
		if (secondCall?.type !== "toolCall") throw new Error("second tool call missing");
		secondCall.id = "reused-id";
		secondAssistant.timestamp = 5;
		context.messages = [
			context.messages[0],
			firstAssistant,
			{ role: "user", content: "continue", timestamp: 4 },
			secondAssistant,
			{
				role: "toolResult",
				toolCallId: "reused-id",
				toolName: TOOL.name,
				content: [{ type: "text", text: "current result" }],
				isError: false,
				timestamp: 6,
			},
		];

		const request = buildInferenceRequest(cursorModel(), context);
		const callIds = request.messages.flatMap(message => message.toolCalls.map(call => call.toolCallId));
		const resultIds = request.messages.flatMap(message =>
			message.content?.case === "toolContent" ? message.content.value.parts.map(result => result.toolCallId) : [],
		);
		expect(callIds).toEqual(["reused-id", "reused-id_dup1"]);
		expect(resultIds).toEqual(["reused-id", "reused-id_dup1"]);
	});

	test("pulls a delayed real tool result before the boundary that closed its call window", () => {
		const context = history();
		const assistant = context.messages[1];
		const result = context.messages[2];
		if (assistant?.role !== "assistant" || result?.role !== "toolResult") {
			throw new Error("tool history missing");
		}
		result.content = [{ type: "text", text: "delayed real output" }];
		const request = buildInferenceRequest(cursorModel(), {
			messages: [assistant, { role: "user", content: "boundary", timestamp: 3 }, { ...result, timestamp: 4 }],
		});

		expect(request.messages.map(message => message.role)).toEqual([
			InferenceMessageRole.ASSISTANT,
			InferenceMessageRole.TOOL,
			InferenceMessageRole.USER,
		]);
		const toolContent = request.messages[1]?.content;
		if (toolContent?.case !== "toolContent") throw new Error("delayed tool result missing");
		expect(decodeJsonValue(toolContent.value.parts[0]?.result ?? new Uint8Array())).toBe("delayed real output");
		expect(toolContent.value.parts[0]?.isError).toBe(false);
	});

	test("preserves visible thinking but removes opaque state before a replacement run", () => {
		const context = history();
		const assistant = context.messages[1];
		if (assistant?.role !== "assistant") throw new Error("assistant fixture missing");
		assistant.api = "cursor-agent";
		assistant.upstreamModel = "gpt-5.6-sol-medium";
		assistant.content = [
			{ type: "thinking", thinking: "visible analysis", thinkingSignature: "opaque-visible" },
			{ type: "thinking", thinking: "", thinkingSignature: "opaque-only" },
			{ type: "redactedThinking", data: "opaque-redacted" },
			{ type: "text", text: "answer" },
		];
		const request = buildInferenceRequest(cursorModel(), { messages: [assistant] });
		const sanitized = withoutRunScopedReasoning(request);
		expect(sanitized.messages[0]?.reasoningParts).toEqual([
			expect.objectContaining({ text: "visible analysis", signature: undefined, isRedacted: false }),
		]);
		expect(request.messages[0]?.reasoningParts).toHaveLength(3);

		context.messages.push(
			{ role: "user", content: "continue in the active run", timestamp: 4 },
			{
				...assistant,
				content: [{ type: "thinking", thinking: "current analysis", thinkingSignature: "opaque-current" }],
				timestamp: 5,
			},
		);
		const continuation = withoutRunScopedReasoning(buildInferenceRequest(cursorModel(), context), true);
		expect(continuation.messages.flatMap(message => message.reasoningParts.map(part => part.signature))).toEqual([
			undefined,
			"opaque-current",
		]);
	});

	test("keeps custom Cursor-provider reasoning and parallel calls on replay", () => {
		const context = history();
		const assistant = context.messages[1];
		if (assistant?.role !== "assistant") throw new Error("assistant fixture missing");
		assistant.api = "cursor-agent";
		assistant.provider = "custom-cursor-provider";
		assistant.upstreamModel = "cursor-grok-4.6-high";
		assistant.content = [
			{ type: "thinking", thinking: "", thinkingSignature: "opaque" },
			{ type: "toolCall", id: "first", name: TOOL.name, arguments: { left: "A", right: "B" } },
			{ type: "toolCall", id: "second", name: TOOL.name, arguments: { left: "C", right: "D" } },
		];
		const request = buildInferenceRequest(cursorModel(), { ...context, messages: context.messages.slice(0, 2) });
		const projected = request.messages[2];
		expect(projected?.reasoningParts).toEqual([
			expect.objectContaining({ signature: "opaque", modelName: "cursor-grok-4.6-high" }),
		]);
		expect(projected?.toolCalls.map(call => call.toolCallId)).toEqual(["first", "second"]);
	});

	test("routes only the current user action on the stable OMP session", () => {
		const model = cursorModel();
		const context = history();
		context.messages.push({ role: "user", content: "Current action.", timestamp: 4 });
		const run = buildInferenceRunRequest(model, context, "omp-session");
		expect(run).toMatchObject({
			conversationId: "omp-session",
			agentMode: "agent",
			requestedModel: {
				modelId: "composer-2.5",
				parameters: [expect.objectContaining({ id: "fast", value: "false" })],
			},
			routingConversation: [expect.objectContaining({ role: 1, text: "Current action." })],
		});
		expect(buildInferenceRunRequest(model, history(), "omp-session").routingConversation).toEqual([]);
		expect(inferenceRoutingKey(model)).toBe(
			'{"modelId":"composer-2.5","maxMode":false,"parameters":[{"id":"fast","value":"false"}]}',
		);
	});

	test("maps every live-tested supported effort into its exact RunInference route", () => {
		const families = [
			{
				modelId: "gpt-5.6-sol",
				wirePrefix: "gpt-5.6-sol-",
				targetModelId: "gpt-5.6-sol",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				parameters: (effort: Effort) => [
					{ id: "context", value: "272k" },
					{ id: "reasoning", value: effort },
					{ id: "fast", value: "false" },
				],
				context: "272k",
			},
			{
				modelId: "claude-opus-5",
				wirePrefix: "claude-opus-5-thinking-",
				targetModelId: "claude-opus-5",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				parameters: (effort: Effort) => [
					{ id: "thinking", value: "true" },
					{ id: "context", value: "300k" },
					{ id: "effort", value: effort },
					{ id: "fast", value: "false" },
				],
			},
			{
				modelId: "gemini-3.7-flash",
				wirePrefix: "gemini-3.7-flash-",
				targetModelId: "gemini-3.7-flash",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				parameters: (effort: Effort) => [{ id: "effort", value: effort }],
			},
			{
				modelId: "cursor-grok-4.6",
				wirePrefix: "cursor-grok-4.6-",
				targetModelId: "grok-4.6",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				parameters: (effort: Effort) => [
					{ id: "effort", value: effort },
					{ id: "fast", value: "false" },
				],
			},
		] as const;

		for (const family of families) {
			const model = cursorModel(family.modelId);
			model.cursorContext = "context" in family ? family.context : undefined;
			for (const effort of family.efforts) {
				expect(JSON.parse(inferenceRoutingKey(model, { wireModelId: `${family.wirePrefix}${effort}` }))).toEqual({
					modelId: family.targetModelId,
					maxMode: false,
					parameters: family.parameters(effort),
				});
			}
		}

		const gpt = cursorModel("gpt-5.6-sol");
		expect(JSON.parse(inferenceRoutingKey(gpt, { wireModelId: "gpt-5.6-sol-extra-high" }))).toEqual({
			modelId: "gpt-5.6-sol",
			maxMode: false,
			parameters: [
				{ id: "reasoning", value: "extra-high" },
				{ id: "fast", value: "false" },
			],
		});
		const grok = cursorModel("cursor-grok-4.6");
		expect(JSON.parse(inferenceRoutingKey(grok, { wireModelId: "cursor-grok-4.6-xhigh-fast" }))).toEqual({
			modelId: "grok-4.6",
			maxMode: false,
			parameters: [
				{ id: "effort", value: "xhigh" },
				{ id: "fast", value: "true" },
			],
		});
		const opus = cursorModel("claude-opus-5");
		opus.cursorModelRoutes = {
			"claude-opus-5-medium": {
				modelId: "claude-opus-5",
				parameters: [
					{ id: "thinking", value: "false" },
					{ id: "context", value: "300k" },
					{ id: "effort", value: "medium" },
					{ id: "fast", value: "false" },
				],
			},
		};
		expect(JSON.parse(inferenceRoutingKey(opus, { wireModelId: "claude-opus-5-medium" }))).toEqual({
			modelId: "claude-opus-5",
			maxMode: false,
			parameters: [
				{ id: "thinking", value: "false" },
				{ id: "context", value: "300k" },
				{ id: "effort", value: "medium" },
				{ id: "fast", value: "false" },
			],
		});

		const composer = cursorModel("composer-2.5");
		const composerEfforts = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
		expect(composer.thinking?.efforts).toEqual(composerEfforts);
		expect(
			composerEfforts.map(effort =>
				JSON.parse(inferenceRoutingKey(composer, { wireModelId: resolveWireModelId(composer, effort) })),
			),
		).toEqual(
			composerEfforts.map(() => ({
				modelId: "composer-2.5",
				maxMode: false,
				parameters: [{ id: "fast", value: "false" }],
			})),
		);

		const max = cursorModel("gpt-5.6-sol");
		max.cursorMaxMode = true;
		max.cursorContext = "1m";
		expect(JSON.parse(inferenceRoutingKey(max, { wireModelId: "gpt-5.6-sol-high" }))).toEqual({
			modelId: "gpt-5.6-sol",
			maxMode: true,
			parameters: [
				{ id: "context", value: "1m" },
				{ id: "reasoning", value: "high" },
				{ id: "fast", value: "false" },
			],
		});
	});

	test("forwards request limits and rejects malformed schemas before transport", () => {
		const request = buildInferenceRequest(cursorModel(), history(), {
			maxTokens: 2048,
			temperature: 0.25,
			topP: 0.9,
			stopSequences: ["STOP"],
		});
		expect(request.modelConfig).toMatchObject({
			maxTokens: 2048,
			temperature: 0.25,
			topP: 0.9,
			stopSequences: ["STOP"],
		});
		expect(() =>
			buildInferenceRequest(cursorModel(), {
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
				tools: [{ name: "bad", description: "bad", parameters: "not-an-object" } as unknown as Tool],
			}),
		).toThrow("schema must be a JSON object");
	});
});
