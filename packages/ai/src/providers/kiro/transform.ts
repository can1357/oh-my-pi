import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, mapEffortToAnthropicAdaptiveEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { prompt } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { Context, DeveloperMessage, ImageContent, Model, ToolResultMessage, UserMessage } from "../../types";
import { toolWireSchema } from "../../utils/schema/wire";
import { normalizeToolCallId, transformMessages } from "../transform-messages";
import continuationPrompt from "./prompts/continuation.md" with { type: "text" };
import historicalToolDescriptionPrompt from "./prompts/historical-tool-description.md" with { type: "text" };
import joinedContentPrompt from "./prompts/joined-content.md" with { type: "text" };
import toolResultTruncatedPrompt from "./prompts/tool-result-truncated.md" with { type: "text" };

interface KiroToolUse {
	name: string;
	toolUseId: string;
	input: Record<string, unknown>;
}

interface KiroToolResult {
	content: Array<{ text: string }>;
	status: "success" | "error";
	toolUseId: string;
}

interface KiroToolSpec {
	toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}

interface KiroImageBlock {
	format: "jpeg" | "png" | "gif" | "webp";
	source: { bytes: string };
}

interface KiroUserInputMessage {
	content: string;
	modelId: string;
	origin: "KIRO_CLI";
	images?: KiroImageBlock[];
	userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}

interface KiroHistoryEntry {
	userInputMessage?: KiroUserInputMessage;
	assistantResponseMessage?: { content: string; toolUses?: KiroToolUse[] };
}

export interface KiroRequest {
	agentMode: "vibe";
	conversationState: {
		chatTriggerType: "MANUAL";
		agentTaskType: "vibe";
		conversationId: string;
		currentMessage: { userInputMessage: KiroUserInputMessage };
		history?: KiroHistoryEntry[];
	};
	profileArn?: string;
	additionalModelRequestFields?:
		| {
				thinking: { type: "adaptive"; display: "summarized" | "omitted" };
				output_config: { effort: string };
				max_tokens?: number;
		  }
		| { thinking: { type: "disabled" } }
		| { reasoning: { mode: "standard"; effort: string } };
}

const CONTINUATION_PROMPT = prompt.render(continuationPrompt);
const HISTORICAL_TOOL_DESCRIPTION = prompt.render(historicalToolDescriptionPrompt);
const CURRENT_TOOL_RESULT_IMAGE_PLACEHOLDER = "(see attached image)";
const HISTORICAL_IMAGE_PLACEHOLDER = "(image omitted from history)";
/**
 * Per-result UTF-8 cap, marker included: the Kiro service's hard limit
 * (aws/amazon-q-developer-cli `chat/consts.rs`: "Actual service limit is
 * 800_000"). A safety net only; normal result size is OMP's tool-output policy.
 */
const TOOL_RESULT_MAX_BYTES = 800_000;
/** Size a tool result shrinks to when the request is over budget (kiro-cli's `max_message_length` fallback). */
const TOOL_RESULT_SHRUNK_BYTES = 25_000;
/** Serialized history plus current user input allowed per `BUDGET_BASE_TOKENS` of context window. */
const BUDGET_BASE_BYTES = 850_000;
const BUDGET_BASE_TOKENS = 200_000;
const UTF8 = new TextEncoder();
const IMAGE_FORMATS: Record<string, KiroImageBlock["format"]> = {
	"image/jpeg": "jpeg",
	"image/jpg": "jpeg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** A user turn: ordinary messages plus the tool results answering the preceding assistant turn. */
interface UserTurn {
	role: "user";
	messages: Array<UserMessage | DeveloperMessage>;
	results: ToolResultMessage[];
}
interface AssistantTurn {
	role: "assistant";
	text: string;
	toolUses: KiroToolUse[];
}

/** A tool result whose wire text may be shrunk to fit the request budget. */
interface BudgetedToolResult {
	part: { text: string };
	full: string;
	fullBytes: number;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

function joinPromptContent(prefix: string, content: string): string {
	return prompt.render(joinedContentPrompt, { prefix, content });
}

function textOf(message: UserMessage | DeveloperMessage | ToolResultMessage): string {
	if (typeof message.content === "string") return message.content.toWellFormed();
	let text = "";
	for (const part of message.content) if (part.type === "text") text += part.text;
	return text.toWellFormed();
}

function imagesOf(message: UserMessage | DeveloperMessage | ToolResultMessage): ImageContent[] {
	return typeof message.content === "string" ? [] : message.content.filter(part => part.type === "image");
}

function imageBlock(image: ImageContent): KiroImageBlock {
	const format = IMAGE_FORMATS[image.mimeType.toLowerCase()];
	if (!format) throw new Error(`Kiro does not support image type: ${image.mimeType}`);
	return { format, source: { bytes: image.data } };
}

/** Cut `text` of `totalBytes` UTF-8 bytes to `maxBytes`, ending with a marker that tells the model so. */
function truncateToolResultText(text: string, totalBytes: number, maxBytes: number): string {
	if (totalBytes <= maxBytes) return text;
	// Size the marker for the widest count it can carry; the real one is never longer.
	const markerBytes = Buffer.byteLength(
		prompt.render(toolResultTruncatedPrompt, { keptBytes: maxBytes, totalBytes }),
		"utf8",
	);
	// `encodeInto` stops before a character that would not fit, so the cut is UTF-8 safe.
	const { read, written } = UTF8.encodeInto(text, new Uint8Array(maxBytes - markerBytes - 2));
	return `${text.slice(0, read)}\n\n${prompt.render(toolResultTruncatedPrompt, { keptBytes: written, totalBytes })}`;
}

/** Shrink `results` in order until `total` bytes fit `limit`; adjusts the total without re-serializing. */
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

function requestFields(
	model: Model,
	options: { reasoning?: Effort; disableReasoning?: boolean; hideThinkingSummary?: boolean; maxTokens?: number },
): KiroRequest["additionalModelRequestFields"] {
	const thinking = model.thinking;
	if (!thinking || thinking.efforts.length === 0) return undefined;
	// No effort means thinking off. Kiro applies the schema default when these
	// fields are absent, so a model that advertises an off value is sent it;
	// discovery marks the others `requiresEffort` and the caller clamps them.
	const effort = options.disableReasoning ? undefined : clampThinkingLevelForModel(model, options.reasoning);
	if (effort === undefined) {
		if (!thinking.suppressWhenOff) return undefined;
		if (thinking.mode === "anthropic-adaptive") return { thinking: { type: "disabled" } };
		// Discovery sets `suppressWhenOff` on an effort ladder only when it advertises `none`.
		if (thinking.mode === "effort") return { reasoning: { mode: "standard", effort: "none" } };
		return undefined;
	}
	if (thinking.mode === "anthropic-adaptive") {
		// Adaptive thinking has no separate budget: `max_tokens` bounds the whole output.
		const requested =
			options.maxTokens !== undefined && options.maxTokens > 0 ? Math.floor(options.maxTokens) : Infinity;
		const limit = Math.min(requested, model.maxTokens ?? Infinity);
		return {
			thinking: { type: "adaptive", display: options.hideThinkingSummary ? "omitted" : "summarized" },
			output_config: { effort: mapEffortToAnthropicAdaptiveEffort(model, effort) },
			...(Number.isFinite(limit) ? { max_tokens: limit } : {}),
		};
	}
	if (thinking.mode === "effort") {
		return { reasoning: { mode: "standard", effort: thinking.effortMap?.[effort] ?? effort } };
	}
	return undefined;
}

/** Group the repaired transcript into strictly alternating user/assistant turns, opening and closing on a user turn. */
function toTurns(context: Context, model: Model): Array<UserTurn | AssistantTurn> {
	const turns: Array<UserTurn | AssistantTurn> = [];
	const userTurn = (): UserTurn => {
		const last = turns.at(-1);
		if (last?.role === "user") return last;
		const turn: UserTurn = { role: "user", messages: [], results: [] };
		turns.push(turn);
		return turn;
	};
	// The shared pipeline sanitizes ids and keeps calls and results paired and unique.
	for (const message of transformMessages(context.messages, model, id => normalizeToolCallId(id))) {
		if (message.role === "toolResult") userTurn().results.push(message);
		else if (message.role !== "assistant") userTurn().messages.push(message);
		else {
			let text = "";
			const toolUses: KiroToolUse[] = [];
			for (const part of message.content) {
				if (part.type === "text") text += part.text;
				else if (part.type === "toolCall")
					toolUses.push({ name: part.name, toolUseId: part.id, input: part.arguments });
			}
			if (!text && toolUses.length === 0) continue;
			const last = turns.at(-1);
			if (last?.role === "assistant") {
				last.text += text;
				last.toolUses.push(...toolUses);
			} else {
				if (!last) userTurn();
				turns.push({ role: "assistant", text, toolUses });
			}
		}
	}
	userTurn();
	return turns;
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
	const modelId = model.requestModelId ?? model.id;
	const turns = toTurns(context, model);
	const current = turns.pop() as UserTurn;
	const historicalResults: BudgetedToolResult[] = [];
	const currentResults: BudgetedToolResult[] = [];
	const encodeResults = (turn: UserTurn, imagePlaceholder: string, budgeted: BudgetedToolResult[]) =>
		turn.results.map((message): KiroToolResult => {
			const full = textOf(message) || (imagesOf(message).length > 0 ? imagePlaceholder : "");
			const fullBytes = Buffer.byteLength(full, "utf8");
			const part = { text: truncateToolResultText(full, fullBytes, TOOL_RESULT_MAX_BYTES) };
			budgeted.push({ part, full, fullBytes });
			return {
				content: [part],
				status: message.isError ? "error" : "success",
				toolUseId: message.toolCallId,
			};
		});
	const userContent = (turn: UserTurn, index: number, imagePlaceholder: string): string => {
		let content = "";
		for (const message of turn.messages) {
			const text = textOf(message);
			if (text) content = content ? joinPromptContent(content, text) : text;
		}
		if (!content && turn.messages.some(message => imagesOf(message).length > 0)) content = imagePlaceholder;
		// The first user turn carries the system prompt.
		if (index === 0 && context.systemPrompt?.length) {
			content = joinPromptContent(context.systemPrompt.join("\n"), content);
		}
		return content.trim() || turn.results.length > 0 ? content : CONTINUATION_PROMPT;
	};

	const history = turns.map((turn, index): KiroHistoryEntry => {
		if (turn.role === "assistant") {
			return {
				assistantResponseMessage: {
					content: turn.text.toWellFormed(),
					...(turn.toolUses.length > 0 ? { toolUses: turn.toolUses } : {}),
				},
			};
		}
		const results = encodeResults(turn, HISTORICAL_IMAGE_PLACEHOLDER, historicalResults);
		return {
			userInputMessage: {
				content: userContent(turn, index, HISTORICAL_IMAGE_PLACEHOLDER),
				modelId,
				origin: "KIRO_CLI",
				...(results.length > 0 ? { userInputMessageContext: { toolResults: results } } : {}),
			},
		};
	});

	// Images are sent only on the current turn; tool-result images ride along with it.
	const currentContent = userContent(current, history.length, "");
	const images = [...current.messages, ...current.results].flatMap(imagesOf).map(imageBlock);
	const toolResults = encodeResults(current, CURRENT_TOOL_RESULT_IMAGE_PLACEHOLDER, currentResults);
	const tools: KiroToolSpec[] = (context.tools ?? []).map(tool => ({
		toolSpecification: {
			name: tool.name,
			description: tool.description,
			inputSchema: { json: toolWireSchema(tool) },
		},
	}));
	// Kiro rejects history tool uses whose tool is not declared; declare retired ones as placeholders.
	const declared = new Set(tools.map(tool => tool.toolSpecification.name));
	for (const turn of turns) {
		if (turn.role !== "assistant") continue;
		for (const { name } of turn.toolUses) {
			if (declared.has(name)) continue;
			declared.add(name);
			tools.push({
				toolSpecification: {
					name,
					description: HISTORICAL_TOOL_DESCRIPTION,
					inputSchema: { json: { type: "object", properties: {} } },
				},
			});
		}
	}
	const fields = requestFields(model, options);
	const request: KiroRequest = {
		agentMode: "vibe",
		conversationState: {
			chatTriggerType: "MANUAL",
			agentTaskType: "vibe",
			conversationId: options.conversationId ?? crypto.randomUUID(),
			currentMessage: {
				userInputMessage: {
					content: currentContent,
					modelId,
					origin: "KIRO_CLI",
					...(images.length > 0 ? { images } : {}),
					...(toolResults.length > 0 || tools.length > 0
						? {
								userInputMessageContext: {
									...(toolResults.length > 0 ? { toolResults } : {}),
									...(tools.length > 0 ? { tools } : {}),
								},
							}
						: {}),
				},
			},
			...(history.length > 0 ? { history } : {}),
		},
		...(fields ? { additionalModelRequestFields: fields } : {}),
	};

	// Budget = serialized history plus the current text, images, and tool results.
	// Over budget, historical results shrink oldest first, then current ones;
	// what still does not fit is a context overflow.
	const maxRequestBytes = Math.floor(
		BUDGET_BASE_BYTES * ((model.contextWindow ?? BUDGET_BASE_TOKENS) / BUDGET_BASE_TOKENS),
	);
	let requestBytes = jsonBytes(history) + jsonBytes(currentContent) + jsonBytes(images);
	for (const result of currentResults) requestBytes += jsonBytes(result.part.text);
	requestBytes = shrinkToolResults(historicalResults, requestBytes, maxRequestBytes);
	requestBytes = shrinkToolResults(currentResults, requestBytes, maxRequestBytes);
	if (requestBytes > maxRequestBytes) {
		throw AIError.attach(
			new Error(`Kiro request exceeds local limit of ${maxRequestBytes} UTF-8 bytes`),
			AIError.create(AIError.Flag.ContextOverflow),
		);
	}
	return request;
}
