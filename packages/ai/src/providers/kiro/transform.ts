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
import toolResultTruncatedPrompt from "./prompts/tool-result-truncated.md" with { type: "text" };
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
/**
 * Per-result UTF-8 cap, marker included, for current and historical results:
 * the Kiro service's hard limit (aws/amazon-q-developer-cli `chat/consts.rs`:
 * "Actual service limit is 800_000"). This is only a safety net so a request is
 * never rejected; the normal result size is OMP's tool-output policy
 * (`tools.artifactSpillThreshold`), which this cap must not override.
 */
const TOOL_RESULT_MAX_BYTES = 800_000;
/**
 * Size a tool result is shrunk to when the request is over budget — kiro-cli's
 * `max_message_length` fallback for an overflowing conversation.
 */
const TOOL_RESULT_SHRUNK_BYTES = 25_000;
/** Serialized history plus current user input (text, images, tool results) allowed per `BUDGET_BASE_TOKENS` of context window. */
const BUDGET_BASE_BYTES = 850_000;
const BUDGET_BASE_TOKENS = 200_000;
const UTF8 = new TextEncoder();

/** A tool result whose wire text may be shrunk to fit the request budget. */
interface BudgetedToolResult {
	part: { text: string };
	full: string;
	fullBytes: number;
}

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
/** Cut well-formed `text` of `totalBytes` UTF-8 bytes to `maxBytes`, ending with a marker that tells the model so. */
function truncateToolResultText(text: string, totalBytes: number, maxBytes: number): string {
	if (totalBytes <= maxBytes) return text;
	// Size the marker for the widest count it can carry; the real one is never longer.
	const markerBytes = Buffer.byteLength(
		prompt.render(toolResultTruncatedPrompt, { keptBytes: maxBytes, totalBytes }),
		"utf8",
	);
	// `encodeInto` stops before a character that would not fit, so the cut is UTF-8 safe.
	const { read, written } = UTF8.encodeInto(text, new Uint8Array(Math.max(0, maxBytes - markerBytes - 2)));
	const marker = prompt.render(toolResultTruncatedPrompt, { keptBytes: written, totalBytes });
	return `${text.slice(0, read)}\n\n${marker}`;
}
function toolResult(
	message: ToolResultMessage,
	normalizeId: (id: string) => string,
	imagePlaceholder: string,
	budgeted: BudgetedToolResult[],
): KiroToolResult {
	const full = textContent(message) || imagePlaceholder;
	const fullBytes = Buffer.byteLength(full, "utf8");
	const part = { text: truncateToolResultText(full, fullBytes, TOOL_RESULT_MAX_BYTES) };
	budgeted.push({ part, full, fullBytes });
	return {
		content: [part],
		status: message.isError ? "error" : "success",
		toolUseId: normalizeId(message.toolCallId),
	};
}
/**
 * Shrink `results` in order to `TOOL_RESULT_SHRUNK_BYTES` until `total` serialized
 * bytes fit `limit`. Each shrink adjusts `total` by the changed JSON string size,
 * so the request is never re-serialized. Returns the new total.
 */
function shrinkToolResults(results: readonly BudgetedToolResult[], total: number, limit: number): number {
	for (const result of results) {
		if (total <= limit) break;
		if (result.fullBytes <= TOOL_RESULT_SHRUNK_BYTES) continue;
		const before = jsonBytes(result.part.text);
		result.part.text = truncateToolResultText(result.full, result.fullBytes, TOOL_RESULT_SHRUNK_BYTES);
		total += jsonBytes(result.part.text) - before;
	}
	return total;
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
	budgeted: BudgetedToolResult[],
): KiroUserInputMessage {
	const results = group.results.map(result =>
		toolResult(result, normalizeId, imageContent(result).length > 0 ? HISTORICAL_IMAGE_PLACEHOLDER : "", budgeted),
	);
	return {
		...userMessage(content, modelId),
		userInputMessageContext: { toolResults: results },
	};
}
function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
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
	const historicalResults: BudgetedToolResult[] = [];
	const currentResults: BudgetedToolResult[] = [];
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
					historicalResults,
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
		currentContent = ordinary;
		currentImages = ordinaryImages(plan.current.group.messages);
		if (plan.current.group.resultGroup) {
			currentContext.toolResults = plan.current.group.resultGroup.results.map(result =>
				toolResult(
					result,
					id => normalizer.normalize(id),
					imageContent(result).length > 0 ? CURRENT_TOOL_RESULT_IMAGE_PLACEHOLDER : "",
					currentResults,
				),
			);
			currentImages.push(...plan.current.group.resultGroup.results.flatMap(imageContent));
		}
	}
	// No history user turn carried the system prompt (an assistant-first or
	// empty transcript), so the current message carries it, whatever it holds.
	if (systemPending) currentContent = joinPromptContent(systemPending, currentContent);
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
	// Budget = serialized history plus the current user input: its text, images,
	// and tool-result text. Over budget, historical results shrink oldest first,
	// then current ones, each to TOOL_RESULT_SHRUNK_BYTES; what still does not
	// fit is a context overflow.
	const contextWindow = model.contextWindow ?? BUDGET_BASE_TOKENS;
	const maxRequestBytes = Math.floor(BUDGET_BASE_BYTES * (contextWindow / BUDGET_BASE_TOKENS));
	let requestBytes = jsonBytes(history) + jsonBytes(currentContent) + jsonBytes(currentImages);
	for (const result of currentResults) requestBytes += jsonBytes(result.part.text);
	requestBytes = shrinkToolResults(historicalResults, requestBytes, maxRequestBytes);
	requestBytes = shrinkToolResults(currentResults, requestBytes, maxRequestBytes);
	if (requestBytes > maxRequestBytes)
		throw AIError.attach(
			new Error(`Kiro request exceeds local limit of ${maxRequestBytes} UTF-8 bytes`),
			AIError.create(AIError.Flag.ContextOverflow),
		);
	return request;
}
