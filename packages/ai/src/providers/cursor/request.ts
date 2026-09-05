import type {
	InferenceContentPart,
	InferenceCoreMessage,
	InferenceModelConfig,
	InferenceRequestedModel,
	InferenceStreamRequest,
	RunInferenceRoutingMessage,
	RunInferenceRunRequest,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	InferenceAgentToolSchema,
	InferenceContentPartSchema,
	InferenceContentPartsSchema,
	InferenceCoreMessageSchema,
	InferenceImagePartSchema,
	InferenceMessageRole,
	InferenceModelConfigSchema,
	InferenceModelParameterValueSchema,
	InferenceReasoningPartSchema,
	InferenceRequestedModelSchema,
	InferenceStreamRequestSchema,
	InferenceTextPartSchema,
	InferenceToolCallSchema,
	InferenceToolResultContentSchema,
	InferenceToolResultPartSchema,
	RunInferenceRoutingMessageSchema,
	RunInferenceRoutingRole,
	RunInferenceRunRequestSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	create,
	encodeJsonStruct,
	encodeJsonValue,
	type JsonObject,
	type JsonValue,
} from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { Context, ImageContent, Message, Model, TextContent, Tool, ToolChoice } from "../../types";
import { normalizeSystemPrompts, normalizeToolCallId } from "../../utils";
import { toolWireSchema } from "../../utils/schema";
import {
	collectToolCallOriginScope,
	createToolResultLookahead,
	renderStaleToolResult,
	sanitizeMalformedToolCalls,
	toolCallPairingKey,
	type ToolCallOriginScope,
} from "../transform-messages";
import { joinTextWithImagePlaceholder, partitionVisionContent } from "../vision-guard";
import {
	cursorEffortParameters,
	cursorEffortSuffix,
	cursorModelParameters,
	cursorModelRoute,
} from "@oh-my-pi/pi-catalog/compat/behavior";
import missingToolResult from "./missing-tool-result.md" with { type: "text" };

export interface CursorInferenceRequestOptions {
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly topP?: number;
	readonly stopSequences?: readonly string[];
	readonly toolChoice?: ToolChoice;
}

export interface CursorRequestedModelOptions {
	readonly wireModelId?: string;
	readonly maxMode?: boolean;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every(isJsonValue);
}

function requiredJsonObject(value: unknown, label: string): JsonObject {
	if (!isJsonValue(value) || Array.isArray(value) || value === null || typeof value !== "object") {
		throw new Error(`${label} must be a JSON object`);
	}
	return value;
}

function imagePart(image: ImageContent): InferenceContentPart {
	return create(InferenceContentPartSchema, {
		part: {
			case: "image",
			value: create(InferenceImagePartSchema, { data: image.data, mimeType: image.mimeType }),
		},
	});
}

function textPart(text: string): InferenceContentPart {
	return create(InferenceContentPartSchema, {
		part: { case: "text", value: create(InferenceTextPartSchema, { text }) },
	});
}

function textAndImagesContent(
	content: string | (TextContent | ImageContent)[],
	supportsImages: boolean,
): InferenceCoreMessage["content"] {
	if (typeof content === "string") return { case: "text", value: content };
	if (!supportsImages) {
		const { textBlocks, omittedImages } = partitionVisionContent(content, false);
		return {
			case: "text",
			value: joinTextWithImagePlaceholder(textBlocks.map(part => part.text).join(""), omittedImages),
		};
	}
	if (content.every(part => part.type === "text")) {
		return { case: "text", value: content.map(part => part.text).join("") };
	}
	return {
		case: "parts",
		value: create(InferenceContentPartsSchema, {
			parts: content.map(part => (part.type === "text" ? textPart(part.text) : imagePart(part))),
		}),
	};
}

function toolResultJson(message: Extract<Message, { role: "toolResult" }>, supportsImages: boolean): JsonValue {
	const text = message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
	if (!supportsImages && message.content.some(part => part.type === "image")) {
		return joinTextWithImagePlaceholder(text.join("\n"), true);
	}
	if (text.length === 1) return text[0] ?? "";
	return text.map(value => ({ type: "text", text: value }));
}

function toolResultExperimentalContent(
	message: Extract<Message, { role: "toolResult" }>,
	supportsImages: boolean,
): InferenceContentPart[] {
	if (!supportsImages || !message.content.some(part => part.type === "image")) return [];
	return message.content.map(part => (part.type === "text" ? textPart(part.text) : imagePart(part)));
}

export function messageToInference(
	message: Message,
	toolCallIds: ReadonlyMap<object, string>,
	supportsImages = true,
): InferenceCoreMessage {
	if (message.role === "user" || message.role === "developer") {
		return create(InferenceCoreMessageSchema, {
			role: message.role === "user" ? InferenceMessageRole.USER : InferenceMessageRole.SYSTEM,
			content: textAndImagesContent(message.content, supportsImages),
		});
	}
	if (message.role === "assistant") {
		const visibleParts: (TextContent | ImageContent)[] = [];
		const reasoningParts = [];
		const toolCalls = [];
		for (const part of message.content) {
			switch (part.type) {
				case "text":
				case "image":
					visibleParts.push(part);
					break;
				case "thinking":
					if (message.api !== "cursor-agent") break;
					reasoningParts.push(
						create(InferenceReasoningPartSchema, {
							text: part.thinking,
							signature: part.thinkingSignature,
							modelName: message.upstreamModel,
						}),
					);
					break;
				case "redactedThinking":
					if (message.api !== "cursor-agent") break;
					reasoningParts.push(
						create(InferenceReasoningPartSchema, { isRedacted: true, text: "", redactedData: part.data }),
					);
					break;
				case "toolCall": {
					const args = requiredJsonObject(part.arguments, `Cursor inference tool '${part.name}' arguments`);
					toolCalls.push(
						create(InferenceToolCallSchema, {
							toolCallId: toolCallIds.get(part) ?? normalizeToolCallId(part.id),
							toolName: part.name,
							args: encodeJsonStruct(args),
							rawToolCallArgs: JSON.stringify(args),
						}),
					);
					break;
				}
				case "fallback":
				case "anthropicServerTool":
					break;
			}
		}
		const hasImages = visibleParts.some(part => part.type === "image");
		const visibleText = visibleParts.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
		const content =
			hasImages && supportsImages
				? {
						case: "parts" as const,
						value: create(InferenceContentPartsSchema, {
							parts: visibleParts.map(part => (part.type === "text" ? textPart(part.text) : imagePart(part))),
						}),
					}
				: visibleText === "" && !hasImages
					? undefined
					: {
							case: "text" as const,
							value: joinTextWithImagePlaceholder(visibleText, hasImages && !supportsImages),
						};
		return create(InferenceCoreMessageSchema, {
			role: InferenceMessageRole.ASSISTANT,
			content,
			reasoningParts,
			toolCalls,
			modelProviderMessageId: message.responseId,
		});
	}
	return create(InferenceCoreMessageSchema, {
		role: InferenceMessageRole.TOOL,
		content: {
			case: "toolContent",
			value: create(InferenceToolResultContentSchema, {
				parts: [
					create(InferenceToolResultPartSchema, {
						toolCallId: toolCallIds.get(message) ?? normalizeToolCallId(message.toolCallId),
						toolName: message.toolName,
						result: encodeJsonValue(toolResultJson(message, supportsImages)),
						isError: message.isError,
						experimentalContent: toolResultExperimentalContent(message, supportsImages),
					}),
				],
			}),
		},
	});
}

function toolToInference(tool: Tool) {
	const schema = requiredJsonObject(toolWireSchema(tool), `Cursor inference tool '${tool.name}' schema`);
	return create(InferenceAgentToolSchema, {
		name: tool.customWireName ?? tool.name,
		description: tool.description,
		// Cursor's IDE converter wraps the JSON Schema before serializing the Struct.
		parameters: encodeJsonStruct({ jsonSchema: schema }),
	});
}

/** Build the complete per-invocation request. Routing and model selection stay on the outer run. */
function uniqueToolCallIds(context: Context): ReadonlyMap<object, string> {
	const assignments = new Map<object, string>();
	const pending = new Map<string, string[]>();
	const originScope = collectToolCallOriginScope(context.messages);
	const used = new Set<string>();
	const allocate = (rawId: string): string => {
		const normalized = normalizeToolCallId(rawId);
		let candidate = normalized;
		let duplicate = 1;
		while (used.has(candidate)) {
			const suffix = `_dup${duplicate++}`;
			candidate = `${normalized.slice(0, 64 - suffix.length)}${suffix}`;
		}
		used.add(candidate);
		return candidate;
	};
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				const assigned = allocate(part.id);
				assignments.set(part, assigned);
				const key = toolCallPairingKey(part.id, originScope);
				const queue = pending.get(key) ?? [];
				queue.push(assigned);
				pending.set(key, queue);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const key = pendingResultKey(pending, message.toolCallId, originScope);
		const queue = pending.get(key);
		const assigned = queue?.shift() ?? allocate(message.toolCallId);
		assignments.set(message, assigned);
		if (queue?.length === 0) pending.delete(key);
	}
	return assignments;
}

function pendingResultKey(pending: ReadonlyMap<string, unknown>, id: string, originScope: ToolCallOriginScope): string {
	if (pending.has(id)) return id;
	const pairingKey = toolCallPairingKey(id, originScope);
	return pending.has(pairingKey) ? pairingKey : id;
}

interface PendingCursorToolCall {
	readonly key: string;
	readonly id: string;
	readonly name: string;
	readonly timestamp: number;
	readonly startIndex: number;
}

function repairToolResultPairing(messages: readonly Message[]): Message[] {
	const pending: PendingCursorToolCall[] = [];
	const repaired: Message[] = [];
	const originScope = collectToolCallOriginScope(messages);
	const realToolResults = createToolResultLookahead(messages, originScope);
	const callIndicesByKey = new Map<string, number[]>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const key = toolCallPairingKey(part.id, originScope);
			const indices = callIndicesByKey.get(key) ?? [];
			indices.push(index);
			callIndicesByKey.set(key, indices);
		}
	}
	const flushPending = (): void => {
		for (const call of pending.splice(0)) {
			const nextCallIndex = callIndicesByKey.get(call.key)?.find(index => index > call.startIndex);
			const realResult = realToolResults.take(call.id, call.startIndex, nextCallIndex);
			if (realResult !== undefined) {
				repaired.push(realResult);
				continue;
			}
			repaired.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: missingToolResult.trimEnd() }],
				isError: true,
				timestamp: call.timestamp,
			});
		}
	};
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "toolResult") {
			if (realToolResults.isConsumed(message)) continue;
			const key = pendingResultKey(new Map(pending.map(call => [call.key, true])), message.toolCallId, originScope);
			const pendingIndex = pending.findIndex(call => call.key === key);
			if (pendingIndex >= 0) {
				pending.splice(pendingIndex, 1);
				realToolResults.consume(message);
				repaired.push(message);
				continue;
			}
			if (pending.length > 0) continue;
			const text = message.content
				.flatMap(part => (part.type === "text" && part.text.trim() !== "" ? [part.text] : []))
				.join("\n");
			if (text === "") continue;
			repaired.push({
				role: "user",
				content: renderStaleToolResult(message, text),
				timestamp: message.timestamp,
			});
			continue;
		}
		flushPending();
		repaired.push(message);
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const key = toolCallPairingKey(part.id, originScope);
			pending.push({
				key,
				id: part.id,
				name: part.name,
				timestamp: message.timestamp,
				startIndex: index,
			});
		}
	}
	flushPending();
	return repaired;
}

export function buildInferenceRequest(
	model: Model<"cursor-agent">,
	context: Context,
	options: CursorInferenceRequestOptions = {},
): InferenceStreamRequest {
	const sanitizedMessages = sanitizeMalformedToolCalls([...context.messages]);
	const repairedContext = { ...context, messages: repairToolResultPairing(sanitizedMessages) };
	const toolCallIds = uniqueToolCallIds(repairedContext);
	const supportsImages = model.input.includes("image");
	const messages = repairedContext.messages.map(message => messageToInference(message, toolCallIds, supportsImages));
	const systemPrompt = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	if (systemPrompt !== "") {
		messages.unshift(
			create(InferenceCoreMessageSchema, {
				role: InferenceMessageRole.SYSTEM,
				content: { case: "text", value: systemPrompt },
			}),
		);
	}
	const modelConfig: InferenceModelConfig | undefined =
		options.maxTokens === undefined &&
		options.temperature === undefined &&
		options.topP === undefined &&
		options.stopSequences === undefined
			? undefined
			: create(InferenceModelConfigSchema, {
					maxTokens: options.maxTokens,
					temperature: options.temperature,
					topP: options.topP,
					stopSequences: options.stopSequences === undefined ? undefined : [...options.stopSequences],
				});
	const forcedToolName =
		typeof options.toolChoice === "object"
			? options.toolChoice.type === "computer"
				? "computer"
				: "function" in options.toolChoice
					? options.toolChoice.function.name
					: options.toolChoice.name
			: undefined;
	const tools =
		options.toolChoice === "none"
			? []
			: forcedToolName === undefined
				? (context.tools ?? [])
				: (context.tools ?? []).filter(
						tool => tool.name === forcedToolName || tool.customWireName === forcedToolName,
					);
	return create(InferenceStreamRequestSchema, {
		messages,
		tools: tools.map(toolToInference),
		modelConfig,
	});
}

/** Preserve visible thinking while omitting opaque reasoning state owned by an earlier outer run. */
export function withoutRunScopedReasoning(
	request: InferenceStreamRequest,
	preserveCurrentTurn = false,
): InferenceStreamRequest {
	const currentTurnStart = preserveCurrentTurn
		? request.messages.findLastIndex(message => message.role === InferenceMessageRole.USER)
		: request.messages.length;
	if (!request.messages.some((message, index) => index <= currentTurnStart && message.reasoningParts.length > 0)) {
		return request;
	}
	return {
		...request,
		messages: request.messages.map((message, index) => {
			if (index > currentTurnStart || message.reasoningParts.length === 0) return message;
			return {
				...message,
				reasoningParts: message.reasoningParts.flatMap(part =>
					part.isRedacted || part.text.trim() === "" ? [] : [{ ...part, signature: undefined }],
				),
			};
		}),
	};
}

interface RequestedModelFields {
	readonly modelId: string;
	readonly parameters: readonly { readonly id: string; readonly value: string }[];
}

function requestedModelFields(model: Model<"cursor-agent">, modelId: string): RequestedModelFields {
	const discovered = model.cursorModelRoutes?.[modelId];
	if (discovered !== undefined) return discovered;
	const routed = cursorModelRoute(modelId);
	if (routed !== undefined) return routed;

	const effort = cursorEffortSuffix(modelId);
	if (effort !== undefined) {
		return {
			modelId: `${effort.base}${effort.fast ? "-fast" : ""}`,
			parameters: cursorEffortParameters(effort.tier, effort.fast),
		};
	}

	return { modelId, parameters: cursorModelParameters(modelId) };
}

function withCursorContext(
	parameters: readonly { readonly id: string; readonly value: string }[],
	context: string | undefined,
): readonly { readonly id: string; readonly value: string }[] {
	if (context === undefined) return parameters;
	const retained = parameters.filter(parameter => parameter.id !== "context");
	return [{ id: "context", value: context }, ...retained];
}

export function inferenceRequestedModel(
	model: Model<"cursor-agent">,
	options: CursorRequestedModelOptions = {},
): InferenceRequestedModel {
	const selectedId = options.wireModelId ?? model.requestModelId ?? model.id;
	const requested = requestedModelFields(model, selectedId);
	return create(InferenceRequestedModelSchema, {
		modelId: requested.modelId,
		maxMode: options.maxMode ?? model.cursorMaxMode === true,
		parameters: withCursorContext(requested.parameters, model.cursorContext).map(parameter =>
			create(InferenceModelParameterValueSchema, parameter),
		),
	});
}

export function inferenceRoutingKey(model: Model<"cursor-agent">, options: CursorRequestedModelOptions = {}): string {
	const requested = inferenceRequestedModel(model, options);
	return JSON.stringify({
		modelId: requested.modelId,
		maxMode: requested.maxMode,
		parameters: requested.parameters.map(({ id, value }) => ({ id, value })),
	});
}

function routingText(message: Extract<Message, { role: "user" }>): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
}

function routingConversation(context: Context): RunInferenceRoutingMessage[] {
	const message = context.messages.at(-1);
	if (message?.role !== "user") return [];
	const text = routingText(message);
	if (text.trim() === "") return [];
	return [
		create(RunInferenceRoutingMessageSchema, {
			role: RunInferenceRoutingRole.USER,
			text,
		}),
	];
}

export function buildInferenceRunRequest(
	model: Model<"cursor-agent">,
	context: Context,
	sessionId: string,
	options: CursorRequestedModelOptions = {},
): RunInferenceRunRequest {
	if (sessionId === "") throw new Error("Cursor managed inference requires a stable session id");
	return create(RunInferenceRunRequestSchema, {
		conversationId: sessionId,
		requestedModel: inferenceRequestedModel(model, options),
		routingConversation: routingConversation(context),
		agentMode: "agent",
	});
}
