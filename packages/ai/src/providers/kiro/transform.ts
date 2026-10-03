import { prompt } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { Context, Effort, ImageContent, Message, Model, Tool, ToolCall, ToolResultMessage } from "../../types";
import { toolWireSchema } from "../../utils/schema/wire";
import { buildKiroModelRequestFields } from "./adaptive-thinking";
import { type KiroAssistantGroup, type KiroOrdinaryMessage, prepareKiroHistory } from "./history";
import { createKiroToolUseIdNormalizer } from "./id-normalizer";
import continuationPrompt from "./prompts/continuation.md" with { type: "text" };
import historicalToolDescriptionPrompt from "./prompts/historical-tool-description.md" with { type: "text" };
import joinedContentPrompt from "./prompts/joined-content.md" with { type: "text" };
import type {
	KiroAssistantResponseMessage,
	KiroHistoryEntry,
	KiroImageBlock,
	KiroRequest,
	KiroToolResult,
	KiroToolSpec,
	KiroUserInputMessage,
} from "./types";

const CONTINUATION_PROMPT = prompt.render(continuationPrompt);
const HISTORICAL_TOOL_DESCRIPTION = prompt.render(historicalToolDescriptionPrompt);
const CURRENT_TOOL_RESULT_IMAGE_PLACEHOLDER = "(see attached image)";
const HISTORICAL_IMAGE_PLACEHOLDER = "(image omitted from history)";
const TOOL_RESULT_MAX_BYTES = 25_000;
const HISTORY_BASE_BYTES = 850_000;
const HISTORY_BASE_TOKENS = 200_000;
const HISTORY_TRUNCATION_SUFFIX = "\n...[truncated]";

function joinPromptContent(prefix: string, content: string): string {
	return prompt.render(joinedContentPrompt, { prefix, content });
}
function textContent(message: Message): string {
	if (typeof message.content === "string") return message.content.toWellFormed();
	let text = "";
	for (const part of message.content) if (part.type === "text") text += part.text;
	return text.toWellFormed();
}
function joinMessageText(messages: readonly KiroOrdinaryMessage[]): string {
	let text = "";
	for (const message of messages) {
		const next = textContent(message);
		if (next) text = text ? joinPromptContent(text, next) : next;
	}
	return text;
}
function imageFormat(mimeType: string): KiroImageBlock["format"] {
	switch (mimeType.trim().toLowerCase()) {
		case "image/jpeg":
		case "image/jpg":
			return "jpeg";
		case "image/png":
			return "png";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			throw new Error(`Kiro does not support image type: ${mimeType}`);
	}
}
function isImageContent(part: unknown): part is ImageContent {
	return typeof part === "object" && part !== null && "type" in part && part.type === "image" && "mimeType" in part;
}
function imageContent(message: Message): KiroImageBlock[] {
	if (typeof message.content === "string") return [];
	const images: KiroImageBlock[] = [];
	for (const part of message.content)
		if (isImageContent(part)) images.push({ format: imageFormat(part.mimeType), source: { bytes: part.data } });
	return images;
}
function parseToolArguments(call: ToolCall): Record<string, unknown> {
	if (typeof call.arguments !== "string") return call.arguments;
	const value: unknown = JSON.parse(call.arguments);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`Kiro historical tool call ${call.id} must contain a JSON object`);
	return value as Record<string, unknown>;
}
function assistantMessage(
	group: KiroAssistantGroup,
	normalizeId: (id: string) => string,
): KiroAssistantResponseMessage {
	let text = "";
	for (const message of group.messages) {
		for (const part of message.content) {
			if (part.type === "text") text += part.text;
		}
	}
	const toolUses = group.calls.map(call => ({
		name: call.name,
		toolUseId: normalizeId(call.id),
		input: parseToolArguments(call),
	}));
	return { content: text.toWellFormed(), ...(toolUses.length > 0 ? { toolUses } : {}) };
}
function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(text.toWellFormed());
	if (bytes.byteLength <= maxBytes) return text.toWellFormed();
	const suffixBytes = new TextEncoder().encode(HISTORY_TRUNCATION_SUFFIX);
	let end = Math.max(0, maxBytes - suffixBytes.byteLength);
	while (end > 0 && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end--;
	return `${new TextDecoder().decode(bytes.subarray(0, end))}${HISTORY_TRUNCATION_SUFFIX}`;
}
function toolResult(
	message: ToolResultMessage,
	normalizeId: (id: string) => string,
	imagePlaceholder: string,
): KiroToolResult {
	const text = textContent(message);
	return {
		content: [{ text: truncateUtf8(text || imagePlaceholder, TOOL_RESULT_MAX_BYTES) }],
		status: message.isError ? "error" : "success",
		toolUseId: normalizeId(message.toolCallId),
	};
}
function toolsToKiro(tools: readonly Tool[]): KiroToolSpec[] {
	return tools.map(tool => ({
		toolSpecification: {
			name: tool.name,
			description: tool.description,
			inputSchema: { json: toolWireSchema(tool) },
		},
	}));
}
function appendHistoricalToolPlaceholders(tools: KiroToolSpec[], history: readonly KiroHistoryEntry[]): void {
	const names = new Set(tools.map(tool => tool.toolSpecification.name));
	for (const entry of history)
		for (const use of entry.assistantResponseMessage?.toolUses ?? [])
			if (!names.has(use.name)) {
				names.add(use.name);
				tools.push({
					toolSpecification: {
						name: use.name,
						description: HISTORICAL_TOOL_DESCRIPTION,
						inputSchema: { json: { type: "object", properties: {} } },
					},
				});
			}
}
function userMessage(content: string, modelId: string): KiroUserInputMessage {
	return { content: content.toWellFormed(), modelId, origin: "KIRO_CLI" };
}
function ordinaryImages(messages: readonly KiroOrdinaryMessage[]): KiroImageBlock[] {
	return messages.flatMap(imageContent);
}
function historicalResultCarrier(
	group: KiroAssistantGroup,
	modelId: string,
	normalizeId: (id: string) => string,
	content: string,
): KiroUserInputMessage {
	const results = group.results.map(result =>
		toolResult(result, normalizeId, imageContent(result).length > 0 ? HISTORICAL_IMAGE_PLACEHOLDER : ""),
	);
	return {
		...userMessage(content, modelId),
		userInputMessageContext: { toolResults: results },
	};
}
function serializedHistoryBytes(history: readonly KiroHistoryEntry[]): number {
	return new TextEncoder().encode(JSON.stringify(history)).byteLength;
}
function validateWireHistory(history: readonly KiroHistoryEntry[]): void {
	let expected: "user" | "assistant" = "user";
	const calls = new Set<string>();
	for (const entry of history) {
		const isUser = entry.userInputMessage !== undefined;
		const isAssistant = entry.assistantResponseMessage !== undefined;
		if (isUser === isAssistant || (isUser && expected !== "user") || (isAssistant && expected !== "assistant"))
			throw new Error("Kiro history alternation is invalid");
		if (isAssistant) {
			for (const use of entry.assistantResponseMessage?.toolUses ?? []) {
				if (calls.has(use.toolUseId)) throw new Error(`Kiro history duplicate wire tool id: ${use.toolUseId}`);
				calls.add(use.toolUseId);
			}
			expected = "user";
		} else {
			for (const result of entry.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
				if (!calls.has(result.toolUseId)) throw new Error(`Kiro history orphan tool result: ${result.toolUseId}`);
				calls.delete(result.toolUseId);
			}
			expected = "assistant";
		}
	}
	if (calls.size > 0) throw new Error("Kiro history contains an incomplete tool-call batch");
}

export function transformKiroRequest(
	model: Model,
	context: Context,
	options: {
		reasoning?: Effort;
		disableReasoning?: boolean;
		hideThinkingSummary?: boolean;
		maxTokens?: number;
		conversationId?: string;
	} = {},
): KiroRequest {
	const normalizer = createKiroToolUseIdNormalizer();
	const plan = prepareKiroHistory(context.messages);
	const modelId = model.requestModelId ?? model.id;
	const history: KiroHistoryEntry[] = [];
	let systemPending = (context.systemPrompt ?? []).join("\n");
	for (const segment of plan.history) {
		if (segment.kind === "assistant") {
			history.push({ assistantResponseMessage: assistantMessage(segment.group, id => normalizer.normalize(id)) });
			continue;
		}
		const ordinary = joinMessageText(segment.group.messages);
		if (segment.group.resultGroup) {
			history.push({
				userInputMessage: historicalResultCarrier(
					segment.group.resultGroup,
					modelId,
					id => normalizer.normalize(id),
					ordinary,
				),
			});
			continue;
		}
		let content = ordinary;
		if (!content && ordinaryImages(segment.group.messages).length > 0) content = HISTORICAL_IMAGE_PLACEHOLDER;
		if (systemPending) {
			content = joinPromptContent(systemPending, content);
			systemPending = "";
		}
		history.push({ userInputMessage: userMessage(content, modelId) });
	}
	let currentContent = CONTINUATION_PROMPT;
	let currentImages: KiroImageBlock[] = [];
	const currentContext: NonNullable<KiroUserInputMessage["userInputMessageContext"]> = {};
	if (plan.current.kind === "user") {
		const ordinary = joinMessageText(plan.current.group.messages);
		if (plan.current.group.resultGroup) {
			currentContent = ordinary;
			if (systemPending && ordinary) {
				currentContent = joinPromptContent(systemPending, ordinary);
				systemPending = "";
			}
			currentContext.toolResults = plan.current.group.resultGroup.results.map(result =>
				toolResult(
					result,
					id => normalizer.normalize(id),
					imageContent(result).length > 0 ? CURRENT_TOOL_RESULT_IMAGE_PLACEHOLDER : "",
				),
			);
			currentImages = [
				...ordinaryImages(plan.current.group.messages),
				...plan.current.group.resultGroup.results.flatMap(imageContent),
			];
		} else {
			currentContent = ordinary;
			if (systemPending) {
				currentContent = joinPromptContent(systemPending, currentContent);
				systemPending = "";
			}
			currentImages = ordinaryImages(plan.current.group.messages);
		}
	}
	if (currentContent.trim().length === 0 && !currentContext.toolResults) currentContent = CONTINUATION_PROMPT;
	const toolSpecs = toolsToKiro(context.tools ?? []);
	appendHistoricalToolPlaceholders(toolSpecs, history);
	if (toolSpecs.length > 0) currentContext.tools = toolSpecs;
	const requestFields = options.disableReasoning
		? undefined
		: buildKiroModelRequestFields(model, options.reasoning, options.hideThinkingSummary, options.maxTokens);
	const request: KiroRequest = {
		agentMode: "vibe",
		conversationState: {
			chatTriggerType: "MANUAL",
			agentTaskType: "vibe",
			conversationId: options.conversationId ?? crypto.randomUUID(),
			currentMessage: {
				userInputMessage: {
					...userMessage(currentContent, modelId),
					...(currentImages.length > 0 ? { images: currentImages } : {}),
					...(Object.keys(currentContext).length > 0 ? { userInputMessageContext: currentContext } : {}),
				},
			},
			...(history.length > 0 ? { history } : {}),
		},
		...(requestFields ? { additionalModelRequestFields: requestFields } : {}),
	};
	validateWireHistory([
		...(request.conversationState.history ?? []),
		{ userInputMessage: request.conversationState.currentMessage.userInputMessage },
	]);
	const contextWindow = model.contextWindow ?? HISTORY_BASE_TOKENS;
	const maxHistoryBytes = Math.floor(HISTORY_BASE_BYTES * (contextWindow / HISTORY_BASE_TOKENS));
	if (serializedHistoryBytes(request.conversationState.history ?? []) > maxHistoryBytes)
		throw AIError.attach(
			new Error(`Kiro history exceeds local limit of ${maxHistoryBytes} UTF-8 bytes`),
			AIError.create(AIError.Flag.ContextOverflow),
		);
	return request;
}
