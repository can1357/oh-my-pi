/**
 * OpenAI Responses HTTP wire-format ↔ omp Context bridge for the auth-gateway.
 *
 * Inbound: parses `POST /v1/responses` request bodies into a {@link ParsedRequest}.
 * Outbound: encodes omp's {@link AssistantMessage} (and event stream) back into
 * the documented `response.*` SSE taxonomy or the non-streaming JSON shape.
 *
 * Spec: https://platform.openai.com/docs/api-reference/responses
 * Inverse direction (source-of-truth for item shapes): ../../providers/openai-responses.ts
 */

import { type } from "@oh-my-pi/omptype";
import { logger, structuredCloneJSON } from "@oh-my-pi/pi-utils";
import { resolvePromptCacheKey } from "../auth-gateway/http";
import type { AuthGatewayStreamControl, AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";
import * as AIError from "../error";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	ComputerAction,
	ComputerSafetyCheck,
	ComputerScreenshotRef,
	Context,
	ImageContent,
	Message,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";
import { decodeDataUri } from "./openai-data-uri";
import {
	type OpenAIResponsesComputerCallItem,
	type OpenAIResponsesComputerCallOutputItem,
	type OpenAIResponsesCustomToolCallOutputItem,
	type OpenAIResponsesFunctionCallItem,
	type OpenAIResponsesFunctionCallOutputItem,
	type OpenAIResponsesInputContent,
	type OpenAIResponsesInputFileBlock,
	type OpenAIResponsesInputImageBlock,
	type OpenAIResponsesOutputContent,
	type OpenAIResponsesReasoningItem,
	type OpenAIResponsesTool,
	openaiResponsesRequestSchema,
} from "./openai-responses-server-schema";
import { encodeTextSignatureV1, parseTextSignature } from "./openai-shared";

export type { ParsedRequest };

// ─── narrow guards ──────────────────────────────────────────────────────────

const OPENAI_RESPONSE_INCLUDES: Record<NonNullable<ParsedRequest["options"]["include"]>[number], true> = {
	"file_search_call.results": true,
	"web_search_call.results": true,
	"web_search_call.action.sources": true,
	"message.input_image.image_url": true,
	"computer_call_output.output.image_url": true,
	"code_interpreter_call.outputs": true,
	"reasoning.encrypted_content": true,
	"message.output_text.logprobs": true,
};

function isOpenAIResponseInclude(value: unknown): value is keyof typeof OPENAI_RESPONSE_INCLUDES {
	return typeof value === "string" && value in OPENAI_RESPONSE_INCLUDES;
}

function isReasoningEffort(value: unknown): value is NonNullable<ParsedRequest["options"]["reasoning"]> {
	return (
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isServiceTier(value: unknown): value is NonNullable<ParsedRequest["options"]["serviceTier"]> {
	return value === "auto" || value === "default" || value === "flex" || value === "scale" || value === "priority";
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const UNSUPPORTED_EXPLICIT_PROMPT_CACHE_MESSAGE =
	"openai-responses: prompt_cache_options and prompt_cache_breakpoint are unsupported by this auth-gateway route; use /v1/pi/stream with options.promptCache instead";

function hasUnsupportedExplicitPromptCacheFields(body: unknown): boolean {
	if (!isObj(body)) return false;
	if ("prompt_cache_options" in body || "prompt_cache_breakpoint" in body) return true;
	if (!Array.isArray(body.input)) return false;

	return body.input.some(item => {
		if (!isObj(item)) return false;
		if ("prompt_cache_breakpoint" in item) return true;
		return Array.isArray(item.content) && item.content.some(part => isObj(part) && "prompt_cache_breakpoint" in part);
	});
}

function rejectUnsupportedExplicitPromptCacheFields(body: unknown): void {
	if (hasUnsupportedExplicitPromptCacheFields(body)) {
		throw new AIError.ValidationError(UNSUPPORTED_EXPLICIT_PROMPT_CACHE_MESSAGE);
	}
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

type AssistantItemPhase = "commentary" | "final_answer";
type MessageSignature = { id: string; phase?: AssistantItemPhase };

function parseAssistantItemPhase(value: unknown): AssistantItemPhase | undefined {
	return value === "commentary" || value === "final_answer" ? value : undefined;
}

function messageTextSignature(id: unknown, phase: unknown): string | undefined {
	const parsedPhase = parseAssistantItemPhase(phase);
	if (typeof id === "string" && id.length > 0) return encodeTextSignatureV1(id, parsedPhase);
	if (!parsedPhase) return undefined;
	return encodeTextSignatureV1(makeMsgId(), parsedPhase);
}

// ─── id helpers ─────────────────────────────────────────────────────────────

function uuidNoDashes(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

function makeRespId(): string {
	return `resp_${uuidNoDashes()}`;
}

function makeMsgId(): string {
	return `msg_${uuidNoDashes()}`;
}

function makeReasoningId(): string {
	return `rs_${uuidNoDashes()}`;
}

function makeFuncCallId(): string {
	return `fc_${uuidNoDashes()}`;
}

function makeCustomCallId(): string {
	return `ctc_${uuidNoDashes()}`;
}

// ─── once-only warnings ─────────────────────────────────────────────────────
// Module-scoped so we don't spam logs once per turn.

let warnedReasoningSummaryLevel = false;

// ─── inbound parser helpers ─────────────────────────────────────────────────

function extractReasoningTextFromItem(item: OpenAIResponsesReasoningItem): string {
	// Prefer `summary[]` — mirrors real OpenAI and the openai-responses provider
	// which writes the surfaced reasoning summary into `summary[].text`.
	const fromSummary = (item.summary ?? []).map(c => c.text).join("");
	if (fromSummary) return fromSummary;
	return (item.content ?? []).map(c => c.text).join("");
}

type InputBlockUnion =
	| { type: "input_text"; text: string }
	| { type: "text"; text: string }
	| OpenAIResponsesInputImageBlock
	| OpenAIResponsesInputFileBlock;

/** Walk an input message's content array and retain only text for the generic view.
 * Native image/file references are preserved on the message provider payload. */
function inputContentParts(blocks: OpenAIResponsesInputContent[] | string | undefined): string | TextContent[] {
	if (typeof blocks === "string") return blocks;
	if (!blocks) return [];
	const parts: TextContent[] = [];
	for (const raw of blocks) {
		const block = raw as InputBlockUnion;
		if (block.type === "input_text" || block.type === "text") {
			parts.push({ type: "text", text: block.text });
		}
	}
	return parts.length === 1 ? parts[0].text : parts;
}

type OutputBlockUnion =
	| { type: "output_text"; text: string }
	| { type: "text"; text: string }
	| { type: "refusal"; refusal: string };

function outputTextOf(
	blocks: OpenAIResponsesOutputContent[] | string | undefined,
	message?: { id?: unknown; phase?: unknown },
): TextContent[] {
	const textSignature = messageTextSignature(message?.id, message?.phase);
	const textContent = (text: string): TextContent =>
		textSignature ? { type: "text", text, textSignature } : { type: "text", text };
	if (typeof blocks === "string") return blocks.length > 0 ? [textContent(blocks)] : [];
	if (!blocks) return [];
	const parts: string[] = [];
	for (const raw of blocks) {
		const block = raw as OutputBlockUnion;
		if (block.type === "output_text" || block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "refusal") {
			// Preserve the refusal reason so history replay still carries it.
			parts.push(`[refusal: ${block.refusal}]`);
		}
	}
	const text = parts.join("");
	return text.length > 0 ? [textContent(text)] : [];
}

// The schema accepts a much wider tool_choice union than the SDK type so the
// walker narrows against the local schema shape.
type ParsedToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; name: string }
	| { type: "custom"; name: string }
	| {
			type:
				| "web_search_preview"
				| "file_search"
				| "computer"
				| "computer_use_preview"
				| "code_interpreter"
				| "image_generation"
				| "mcp";
	  }
	| { type: "allowed_tools"; mode: "auto" | "required"; tools: Array<{ type: string; name?: string }> };

function mapToolChoice(value: ParsedToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "none" || value === "required") return value;
	if ("type" in value) {
		if (value.type === "function" || value.type === "custom") return { name: value.name };
		if (value.type === "computer") return { type: "computer" };
		// Other hosted tools + allowed_tools are not surfaced to pi-ai.
		return "auto";
	}
	return undefined;
}

function buildTools(tools: Array<OpenAIResponsesTool | { type: string }> | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	const out: Tool[] = [];
	for (const t of tools) {
		if (t.type === "computer") {
			out.push({
				name: "computer",
				description: "",
				parameters: {} as Tool["parameters"],
				native: { type: "computer" },
			});
			continue;
		}
		// Skip non-function tools (web_search, file_search, …).
		if (t.type !== "function") continue;
		const fn = t as Extract<OpenAIResponsesTool, { type: "function" }>;
		const tool: Tool = {
			name: fn.name,
			description: fn.description ?? "",
			parameters: (fn.parameters ?? {}) as Tool["parameters"],
		};
		if (fn.strict !== undefined && fn.strict !== null) tool.strict = fn.strict;
		out.push(tool);
	}
	return out.length > 0 ? out : undefined;
}

function ensureAssistantPlaceholder(messages: Message[], modelId: string, now: number): AssistantMessage {
	const last = messages[messages.length - 1];
	if (last && last.role === "assistant") return last;
	const placeholder: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: now,
	};
	messages.push(placeholder);
	return placeholder;
}

function functionOutputContent(output: string | readonly unknown[] | undefined): (TextContent | ImageContent)[] {
	if (typeof output === "string") return [{ type: "text", text: output }];
	if (!output) return [{ type: "text", text: "" }];

	const content: (TextContent | ImageContent)[] = [];
	let legacyText = "";
	const flushLegacyText = (): void => {
		if (legacyText.length === 0) return;
		content.push({ type: "text", text: legacyText });
		legacyText = "";
	};
	for (const raw of output) {
		if (!isObj(raw)) continue;
		const blockType = raw.type;
		if (blockType === "input_text") {
			flushLegacyText();
			const text = asString(raw.text);
			if (text !== undefined) content.push({ type: "text", text });
			continue;
		}
		if (blockType === "output_text" || blockType === "text") {
			const text = asString(raw.text);
			if (text) legacyText += text;
			continue;
		}
		if (blockType === "refusal") {
			const refusal = asString(raw.refusal);
			if (refusal) legacyText += `[refusal: ${refusal}]`;
			continue;
		}
		if (blockType === "input_image") {
			flushLegacyText();
			const imageUrl = asString(raw.image_url) || undefined;
			const decoded = imageUrl ? decodeDataUri(imageUrl) : undefined;
			const detail =
				raw.detail === "auto" || raw.detail === "low" || raw.detail === "high" || raw.detail === "original"
					? raw.detail
					: undefined;
			if (decoded) {
				content.push({ type: "image", ...decoded, ...(detail ? { detail } : {}) });
			} else {
				const referenceImage: ImageContent = {
					type: "image",
					data: "",
					mimeType: "application/octet-stream",
					...(detail ? { detail } : {}),
				};
				if (imageUrl) {
					content.push({ ...referenceImage, url: imageUrl });
				} else {
					const fileId = asString(raw.file_id) || undefined;
					if (fileId) content.push({ ...referenceImage, providerFile: { provider: "openai", id: fileId } });
				}
			}
		}
	}
	flushLegacyText();
	return content.length > 0 ? content : [{ type: "text", text: "" }];
}

// ─── parseRequest ───────────────────────────────────────────────────────────

export function parseRequest(body: unknown, headers?: Headers): ParsedRequest {
	// Header capture is centralized in `auth-gateway/server.ts` (the
	// allow-listed set lands on `options.headers` automatically). We also
	// consult `headers` here to populate `options.promptCacheKey` when the
	// client signals a cache identity outside the body — see the
	// `resolvePromptCacheKey` call further down.

	rejectUnsupportedExplicitPromptCacheFields(body);
	const data = openaiResponsesRequestSchema(body);
	if (data instanceof type.errors) {
		throw new AIError.ValidationError(`openai-responses: ${data.summary}`);
	}

	const now = Date.now();
	const messages: Message[] = [];
	const systemPrompt: string[] = [];

	if (typeof data.instructions === "string" && data.instructions.length > 0) {
		systemPrompt.push(data.instructions);
	}

	if (typeof data.input === "string") {
		messages.push({ role: "user", content: data.input, timestamp: now });
	} else if (data.input) {
		for (const item of data.input) {
			// Items may omit `type` and rely on `role` (the convenience shape).
			const effectiveType = item.type ?? ("role" in item ? "message" : undefined);
			if (effectiveType === "message") {
				const msg = item as {
					role?: string;
					content?: OpenAIResponsesInputContent[] | OpenAIResponsesOutputContent[] | string;
					id?: unknown;
					phase?: unknown;
				};
				switch (msg.role) {
					case "system": {
						const content = inputContentParts(msg.content as OpenAIResponsesInputContent[] | string | undefined);
						const flat = typeof content === "string" ? content : content.map(part => part.text).join("");
						const hasNativeRefs =
							Array.isArray(msg.content) &&
							msg.content.some(part => part.type === "input_image" || part.type === "input_file");
						if (hasNativeRefs) {
							messages.push({
								role: "developer",
								content,
								providerPayload: {
									type: "openaiResponsesHistory",
									items: [structuredCloneJSON(item) as unknown as Record<string, unknown>],
									dt: true,
								},
								timestamp: now,
							});
						} else if (flat.length > 0) {
							systemPrompt.push(flat);
						}
						break;
					}
					case "user":
					case "developer": {
						const content = inputContentParts(msg.content as OpenAIResponsesInputContent[] | string | undefined);
						const nativeItem = structuredCloneJSON(item) as unknown as Record<string, unknown>;
						messages.push({
							role: msg.role,
							content,
							providerPayload: { type: "openaiResponsesHistory", items: [nativeItem], dt: true },
							timestamp: now,
						});
						break;
					}
					case "assistant": {
						const parts = outputTextOf(msg.content as OpenAIResponsesOutputContent[] | string | undefined, {
							id: msg.id,
							phase: msg.phase,
						});
						messages.push({
							role: "assistant",
							content: parts,
							api: "openai-responses",
							provider: "openai",
							model: data.model,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: now,
						});
						break;
					}
				}
				continue;
			}
			if (effectiveType === "reasoning") {
				const reasoning = item as OpenAIResponsesReasoningItem;
				const text = extractReasoningTextFromItem(reasoning);
				const thinking: ThinkingContent = {
					type: "thinking",
					thinking: text,
					thinkingSignature: JSON.stringify(reasoning),
					...(reasoning.id ? { itemId: reasoning.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(thinking);
				continue;
			}
			if (effectiveType === "function_call") {
				const call = item as OpenAIResponsesFunctionCallItem;
				const argsRaw = call.arguments ?? "{}";
				let args: Record<string, unknown>;
				try {
					const parsedArgs: unknown = JSON.parse(argsRaw);
					args = isObj(parsedArgs) ? parsedArgs : {};
				} catch {
					throw new AIError.ValidationError(
						`openai-responses: function_call ${call.call_id} has invalid JSON arguments`,
					);
				}
				const toolCall: ToolCall = {
					type: "toolCall",
					id: call.call_id,
					name: call.name,
					arguments: args,
					...(call.id ? { thoughtSignature: call.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
				continue;
			}
			if (effectiveType === "custom_tool_call") {
				const call = item as { id?: string; call_id: string; name: string; input: string };
				// Custom tools carry a raw input string. We stash it in `arguments.input`
				// matching pi-ai's openai-shared convention, and tag the call
				// with `customWireName` so encoders re-emit it as `custom_tool_call`.
				const toolCall: ToolCall = {
					type: "toolCall",
					id: call.call_id,
					name: call.name,
					arguments: { input: call.input ?? "" },
					customWireName: call.name,
					...(call.id ? { thoughtSignature: call.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
				continue;
			}
			if (effectiveType === "computer_call") {
				const call = item as OpenAIResponsesComputerCallItem;
				const actions = (
					call.actions?.length ? call.actions : call.action ? [call.action] : []
				) as ComputerAction[];
				const toolCall: ToolCall = {
					type: "toolCall",
					id: call.call_id,
					name: "computer",
					arguments: { actions },
					providerMetadata: {
						type: "computer",
						providerItemId: call.id,
						actions,
						pendingSafetyChecks: call.pending_safety_checks as ComputerSafetyCheck[],
					},
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
				continue;
			}
			if (effectiveType === "function_call_output") {
				const output = item as OpenAIResponsesFunctionCallOutputItem;
				messages.push({
					role: "toolResult",
					toolCallId: output.call_id,
					toolName: findToolNameById(messages, output.call_id),
					content: functionOutputContent(output.output),
					isError: false,
					timestamp: now,
				});
				continue;
			}
			if (effectiveType === "computer_call_output") {
				const output = item as OpenAIResponsesComputerCallOutputItem;
				messages.push({
					role: "toolResult",
					toolCallId: output.call_id,
					toolName: findToolNameById(messages, output.call_id) || "computer",
					content: [],
					isError: output.status === "failed",
					providerMetadata: {
						type: "computer",
						screenshot: output.output as ComputerScreenshotRef,
						acknowledgedSafetyChecks: (output.acknowledged_safety_checks ?? []) as ComputerSafetyCheck[],
					},
					timestamp: now,
				});
				continue;
			}
			if (effectiveType === "custom_tool_call_output") {
				const output = item as OpenAIResponsesCustomToolCallOutputItem;
				const toolName = findToolNameById(messages, output.call_id);
				messages.push({
					role: "toolResult",
					toolCallId: output.call_id,
					toolName,
					content: functionOutputContent(output.output),
					isError: false,
					timestamp: now,
				});
			}
			// Other item types are tolerated but not bridged.
		}
	}

	const tools = buildTools(data.tools);
	const context: Context = {
		...(systemPrompt.length > 0 ? { systemPrompt } : {}),
		messages,
		...(tools ? { tools } : {}),
	};

	const options: ParsedRequest["options"] = {};
	if (data.max_output_tokens !== undefined) options.maxOutputTokens = data.max_output_tokens;
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (data.stop !== undefined && data.stop !== null) {
		options.stopSequences = typeof data.stop === "string" ? [data.stop] : data.stop;
	}
	const toolChoice = mapToolChoice(data.tool_choice as ParsedToolChoice | undefined);
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	if (data.reasoning?.effort && isReasoningEffort(data.reasoning.effort)) {
		options.reasoning = data.reasoning.effort;
	}
	// OpenAI summary: `none` → suppress; `auto`/`concise`/`detailed` → request
	// visible summary. pi-ai has no per-level plumbing — log once and let the
	// provider default kick in.
	if (data.reasoning?.summary === "none") {
		options.hideThinkingSummary = true;
	} else if (
		data.reasoning?.summary === "auto" ||
		data.reasoning?.summary === "concise" ||
		data.reasoning?.summary === "detailed"
	) {
		if (!warnedReasoningSummaryLevel) {
			warnedReasoningSummaryLevel = true;
			logger.debug("openai-responses-server: reasoning.summary level not differentiated", {
				level: data.reasoning.summary,
			});
		}
	}
	if (data.service_tier !== undefined && isServiceTier(data.service_tier)) {
		options.serviceTier = data.service_tier;
	}
	if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
	if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
	if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
	if (Array.isArray(data.include)) options.include = data.include.filter(isOpenAIResponseInclude);
	const cacheKey = resolvePromptCacheKey(body, headers);
	if (cacheKey !== undefined) options.promptCacheKey = cacheKey;
	if (data.previous_response_id !== undefined) options.previousResponseId = data.previous_response_id;
	if (data.user !== undefined) options.user = data.user;
	if (isObj(data.metadata)) options.metadata = data.metadata;
	// `store` is a stateful-storage hint that omp's gateway doesn't honour;
	// silently accepted by the schema. No typed slot — drop.

	return {
		modelId: data.model,
		context,
		stream: data.stream === true,
		options,
	};
}

function findToolNameById(messages: Message[], callId: string): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		for (const c of m.content) {
			if (c.type === "toolCall" && c.id === callId) return c.name;
		}
	}
	return "";
}

// ─── formatError ────────────────────────────────────────────────────────────

export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { message, type } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// ─── output item builders (shared by streaming + non-streaming encoders) ────

type ReasoningOutputItem = {
	type: "reasoning";
	id: string;
	summary: Array<{ type: "summary_text"; text: string }>;
} & Record<string, unknown>;

type MessageOutputItem = {
	type: "message";
	id: string;
	role: "assistant";
	status: "completed";
	content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
	phase?: AssistantItemPhase;
};

type FunctionCallOutputItem = {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	arguments: string;
	status: "completed";
};

type CustomToolCallOutputItem = {
	type: "custom_tool_call";
	id: string;
	call_id: string;
	name: string;
	input: string;
	status: "completed";
};

type ComputerCallOutputItem = {
	type: "computer_call";
	id: string;
	call_id: string;
	actions: ComputerAction[];
	pending_safety_checks: ComputerSafetyCheck[];
	status: "completed" | "in_progress" | "incomplete";
};

type OutputItem =
	| ReasoningOutputItem
	| MessageOutputItem
	| FunctionCallOutputItem
	| CustomToolCallOutputItem
	| ComputerCallOutputItem;

type ResponseStatus = "completed" | "in_progress" | "failed" | "incomplete";

function responseStatusForStopReason(message: AssistantMessage): ResponseStatus {
	if (message.stopReason === "length") return "incomplete";
	if (message.stopReason === "error" || message.stopReason === "aborted") return "failed";
	return "completed";
}

function incompleteDetailsForStatus(status: ResponseStatus): { reason: "max_output_tokens" } | null {
	return status === "incomplete" ? { reason: "max_output_tokens" } : null;
}

function buildReasoningItem(part: ThinkingContent): ReasoningOutputItem {
	const baseId = part.itemId ?? makeReasoningId();
	if (part.thinkingSignature) {
		try {
			const sigParsed: unknown = JSON.parse(part.thinkingSignature);
			if (isObj(sigParsed) && sigParsed.type === "reasoning") {
				const id = part.itemId ?? asString(sigParsed.id) ?? makeReasoningId();
				// Preserve any extra fields (encrypted_content, …) the original carried,
				// but normalize the summary into the canonical `{type, text}[]` shape.
				const merged: Record<string, unknown> = { ...sigParsed, type: "reasoning", id };
				merged.summary = [{ type: "summary_text", text: part.thinking }];
				// `content[]` is the encrypted/raw side-channel; leave whatever was
				// already there. If absent, omit — real OpenAI only emits `content[]`
				// when `include=['reasoning.encrypted_content']` is set.
				return merged as ReasoningOutputItem;
			}
		} catch {
			// Not a serialized Responses reasoning item; fall through to fresh build.
		}
	}
	return {
		type: "reasoning",
		id: baseId,
		summary: [{ type: "summary_text", text: part.thinking }],
	};
}

function reasoningItemId(part: ThinkingContent): string {
	if (part.itemId) return part.itemId;
	if (part.thinkingSignature) {
		try {
			const sigParsed: unknown = JSON.parse(part.thinkingSignature);
			if (isObj(sigParsed)) {
				const id = asString(sigParsed.id);
				if (id) return id;
			}
		} catch {
			// Not a serialized Responses reasoning item.
		}
	}
	return makeReasoningId();
}

/**
 * pi-ai responses providers mint composite `"{call_id}|{item_id}"` tool-call
 * ids ({@link encodeResponsesToolCallId}). Only the call_id half belongs on
 * the wire: third-party clients validate the `call_id` charset
 * (`^[a-zA-Z0-9_-]+$`) or echo it to other backends, and `|` fails both.
 */
function wireCallId(id: string): string {
	const sep = id.indexOf("|");
	return sep >= 0 ? id.slice(0, sep) : id;
}

/**
 * Walk the assistant content array and group consecutive TextContent into a
 * single message item; each ThinkingContent / ToolCall is its own item.
 */
function buildOutputItems(message: AssistantMessage): OutputItem[] {
	const out: OutputItem[] = [];
	let pendingMessage: MessageOutputItem | null = null;
	let pendingMessageSignature: { id: string; phase?: AssistantItemPhase } | undefined;
	const flushMessage = () => {
		if (pendingMessage) {
			out.push(pendingMessage);
			pendingMessage = null;
			pendingMessageSignature = undefined;
		}
	};

	for (const part of message.content) {
		if (part.type === "text") {
			const signature = parseTextSignature(part.textSignature);
			const sameSignature =
				!pendingMessage ||
				(pendingMessageSignature?.id === signature?.id && pendingMessageSignature?.phase === signature?.phase);
			if (!sameSignature) flushMessage();
			if (!pendingMessage) {
				pendingMessage = {
					type: "message",
					id: signature?.id ?? makeMsgId(),
					role: "assistant",
					status: "completed",
					content: [],
					...(signature?.phase ? { phase: signature.phase } : {}),
				};
				pendingMessageSignature = signature;
			}
			pendingMessage.content.push({ type: "output_text", text: part.text, annotations: [] });
		} else if (part.type === "thinking") {
			flushMessage();
			out.push(buildReasoningItem(part));
		} else if (part.type === "toolCall") {
			flushMessage();
			if (part.providerMetadata?.type === "computer") {
				out.push({
					type: "computer_call",
					id: part.providerMetadata.providerItemId,
					call_id: wireCallId(part.id),
					actions: part.providerMetadata.actions,
					pending_safety_checks: part.providerMetadata.pendingSafetyChecks,
					status: "completed",
				});
				continue;
			}
			if (part.customWireName) {
				const input = part.arguments?.input;
				const rawInput = typeof input === "string" ? input : "";
				out.push({
					type: "custom_tool_call",
					id: part.thoughtSignature ?? makeCustomCallId(),
					call_id: wireCallId(part.id),
					name: part.customWireName,
					input: rawInput,
					status: "completed",
				});
			} else {
				out.push({
					type: "function_call",
					id: part.thoughtSignature ?? makeFuncCallId(),
					call_id: wireCallId(part.id),
					name: part.name,
					arguments: JSON.stringify(part.arguments ?? {}),
					status: "completed",
				});
			}
		}
		// RedactedThinking / Image are silently dropped — no direct Responses wire representation.
	}
	flushMessage();
	return out;
}

function buildUsage(message: AssistantMessage): Record<string, unknown> {
	const u = message.usage;
	const inputTokens = u.input + u.cacheRead + u.cacheWrite;
	return {
		input_tokens: inputTokens,
		input_tokens_details: { cached_tokens: u.cacheRead },
		output_tokens: u.output,
		output_tokens_details: { reasoning_tokens: u.reasoningTokens ?? 0 },
		total_tokens: inputTokens + u.output,
	};
}

function buildResponseEnvelope(
	message: AssistantMessage,
	requestedModelId: string,
	id: string,
	status: ResponseStatus,
	items: OutputItem[] | [],
	usage: Record<string, unknown> | null,
): Record<string, unknown> {
	return {
		id,
		object: "response",
		created_at: Math.floor(message.timestamp / 1000),
		status,
		model: requestedModelId,
		output: items,
		usage,
		incomplete_details: incompleteDetailsForStatus(status),
		...(status === "failed" ? { error: { message: message.errorMessage ?? "response failed" } } : {}),
	};
}

// ─── encodeResponse (non-streaming) ─────────────────────────────────────────

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	const items = buildOutputItems(message);
	return buildResponseEnvelope(
		message,
		requestedModelId,
		makeRespId(),
		responseStatusForStopReason(message),
		items,
		buildUsage(message),
	);
}

// ─── encodeStream ───────────────────────────────────────────────────────────

interface OpenMessage {
	kind: "message";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	currentPartText: string;
	content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
	signature?: MessageSignature;
}
interface OpenReasoning {
	kind: "reasoning";
	itemId: string;
	outputIndex: number;
	reasoningText: string;
}
interface OpenFunctionCall {
	kind: "function_call";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	callId: string;
	name: string;
	argsText: string;
	/** Set when the underlying ToolCall is a custom-tool emission. */
	customWireName?: string;
}
interface OpenComputerCall {
	kind: "computer_call";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	callId: string;
	actions: ComputerAction[];
	pendingSafetyChecks: ComputerSafetyCheck[];
}
type OpenItem = OpenMessage | OpenReasoning | OpenFunctionCall | OpenComputerCall;

function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	_options?: ParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const responseId = makeRespId();
	let sequenceNumber = 0;
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });
	const seq = () => sequenceNumber++;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (name: string, data: Record<string, unknown>) => {
				if (!cancelled)
					controller.enqueue(encoder.encode(sseEvent(name, { type: name, sequence_number: seq(), ...data })));
			};
			const emitDone = () => {
				if (!cancelled) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			};

			let createdAt = Math.floor(Date.now() / 1000);
			let outputIndex = 0;
			const state: { open: OpenItem | null } = { open: null };
			const openToolCalls = new Map<number, OpenFunctionCall | OpenComputerCall>();
			const openItemsByContentIndex = new Map<number, OpenItem>();
			const finishedItems: OutputItem[] = [];
			const allocateOutputIndex = (): number => outputIndex++;
			const removeOpenItem = (item: OpenItem): void => {
				for (const [contentIndex, candidate] of openItemsByContentIndex) {
					if (candidate === item) openItemsByContentIndex.delete(contentIndex);
				}
			};
			const openItemForContentIndex = (contentIndex: number): OpenItem | null =>
				openItemsByContentIndex.get(contentIndex) ?? null;

			const responseSnapshot = (status: ResponseStatus, output: OutputItem[] | []) => ({
				id: responseId,
				object: "response",
				created_at: createdAt,
				status,
				model: requestedModelId,
				output,
				usage: null,
				incomplete_details: incompleteDetailsForStatus(status),
			});

			const openMessage = (signature: MessageSignature | undefined, sourceContentIndex: number): OpenMessage => {
				const itemOutputIndex = allocateOutputIndex();
				const itemId = signature?.id ?? makeMsgId();
				const item = {
					type: "message" as const,
					id: itemId,
					status: "in_progress" as const,
					role: "assistant" as const,
					content: [] as Array<{ type: "output_text"; text: string; annotations: never[] }>,
					...(signature?.phase ? { phase: signature.phase } : {}),
				};
				emit("response.output_item.added", { output_index: itemOutputIndex, item });
				const next: OpenMessage = {
					kind: "message",
					itemId,
					outputIndex: itemOutputIndex,
					contentIndex: 0,
					currentPartText: "",
					content: [],
					...(signature ? { signature } : {}),
				};
				state.open = next;
				openItemsByContentIndex.set(sourceContentIndex, next);
				return next;
			};

			const openReasoning = (partial: AssistantMessage, contentIndex: number): OpenReasoning => {
				const itemOutputIndex = allocateOutputIndex();
				const part = partial.content[contentIndex];
				const itemId = part && part.type === "thinking" ? reasoningItemId(part) : makeReasoningId();
				const item = {
					type: "reasoning" as const,
					id: itemId,
					summary: [] as Array<{ type: "summary_text"; text: string }>,
				};
				emit("response.output_item.added", { output_index: itemOutputIndex, item });
				emit("response.reasoning_summary_part.added", {
					item_id: itemId,
					output_index: itemOutputIndex,
					summary_index: 0,
					part: { type: "summary_text", text: "" },
				});
				const next: OpenReasoning = { kind: "reasoning", itemId, outputIndex: itemOutputIndex, reasoningText: "" };
				openItemsByContentIndex.set(contentIndex, next);
				state.open = next;
				return next;
			};
			const openToolCall = (
				partial: AssistantMessage,
				contentIndex: number,
			): OpenFunctionCall | OpenComputerCall => {
				const itemOutputIndex = allocateOutputIndex();
				const part = partial.content[contentIndex];
				const tc = part && part.type === "toolCall" ? part : undefined;
				if (tc?.providerMetadata?.type === "computer") {
					const metadata = tc.providerMetadata;
					const item = {
						type: "computer_call" as const,
						id: metadata.providerItemId,
						call_id: wireCallId(tc.id),
						actions: metadata.actions,
						pending_safety_checks: metadata.pendingSafetyChecks,
						status: "in_progress" as const,
					};
					emit("response.output_item.added", { output_index: itemOutputIndex, item });
					const next: OpenComputerCall = {
						kind: "computer_call",
						itemId: metadata.providerItemId,
						outputIndex: itemOutputIndex,
						contentIndex,
						callId: wireCallId(tc.id),
						actions: metadata.actions,
						pendingSafetyChecks: metadata.pendingSafetyChecks,
					};
					openToolCalls.set(contentIndex, next);
					openItemsByContentIndex.set(contentIndex, next);
					state.open = next;
					return next;
				}
				const customWireName: string | undefined =
					tc && typeof tc.customWireName === "string" && tc.customWireName.length > 0
						? tc.customWireName
						: undefined;
				const isCustom = customWireName !== undefined;
				const itemId = tc?.thoughtSignature ?? (isCustom ? makeCustomCallId() : makeFuncCallId());
				const callId = wireCallId(tc?.id ?? "");
				const name = customWireName ?? tc?.name ?? "";
				const item = isCustom
					? {
							type: "custom_tool_call" as const,
							id: itemId,
							call_id: callId,
							name,
							input: "",
							status: "in_progress",
						}
					: {
							type: "function_call" as const,
							id: itemId,
							call_id: callId,
							name,
							arguments: "",
							status: "in_progress",
						};
				emit("response.output_item.added", { output_index: itemOutputIndex, item });
				const next: OpenFunctionCall = {
					kind: "function_call",
					itemId,
					outputIndex: itemOutputIndex,
					contentIndex,
					callId,
					name,
					argsText: "",
					...(isCustom ? { customWireName } : {}),
				};
				openToolCalls.set(contentIndex, next);
				openItemsByContentIndex.set(contentIndex, next);
				state.open = next;
				return next;
			};

			const closeComputerCall = (call: OpenComputerCall): void => {
				const item: ComputerCallOutputItem = {
					type: "computer_call",
					id: call.itemId,
					call_id: call.callId,
					actions: call.actions,
					pending_safety_checks: call.pendingSafetyChecks,
					status: "completed",
				};
				emit("response.output_item.done", { output_index: call.outputIndex, item });
				finishedItems.push(item);
				openToolCalls.delete(call.contentIndex);
				removeOpenItem(call);
				if (state.open === call) state.open = null;
			};

			const closeFunctionCall = (call: OpenFunctionCall): void => {
				const text = call.argsText ?? "";
				if (call.customWireName) {
					const item = {
						type: "custom_tool_call",
						id: call.itemId,
						call_id: call.callId ?? "",
						name: call.customWireName,
						input: text,
						status: "completed",
					};
					emit("response.output_item.done", { output_index: call.outputIndex, item });
					finishedItems.push({
						type: "custom_tool_call",
						id: call.itemId,
						call_id: call.callId ?? "",
						name: call.customWireName,
						input: text,
						status: "completed",
					});
				} else {
					const item = {
						type: "function_call",
						id: call.itemId,
						call_id: call.callId ?? "",
						name: call.name ?? "",
						arguments: text,
						status: "completed",
					};
					emit("response.output_item.done", { output_index: call.outputIndex, item });
					finishedItems.push({
						type: "function_call",
						id: call.itemId,
						call_id: call.callId ?? "",
						name: call.name ?? "",
						arguments: text,
						status: "completed",
					});
				}
				openToolCalls.delete(call.contentIndex);
				removeOpenItem(call);
				if (state.open === call) state.open = null;
			};

			const closeOpen = (target: OpenItem | null = state.open): void => {
				if (!target) return;
				if (target.kind === "message") {
					const item = {
						type: "message" as const,
						id: target.itemId,
						status: "completed" as const,
						role: "assistant" as const,
						content: target.content,
						...(target.signature?.phase ? { phase: target.signature.phase } : {}),
					};
					emit("response.output_item.done", { output_index: target.outputIndex, item });
					finishedItems.push(item);
					removeOpenItem(target);
					if (state.open === target) state.open = null;
				} else if (target.kind === "reasoning") {
					const summary = [{ type: "summary_text" as const, text: target.reasoningText ?? "" }];
					const item = { type: "reasoning" as const, id: target.itemId, summary };
					emit("response.output_item.done", { output_index: target.outputIndex, item });
					finishedItems.push(item);
					removeOpenItem(target);
					if (state.open === target) state.open = null;
				} else if (target.kind === "computer_call") {
					closeComputerCall(target);
				} else {
					closeFunctionCall(target);
				}
			};

			const closeAllOpenItems = (): void => {
				const openItems = new Set(openItemsByContentIndex.values());
				if (state.open) openItems.add(state.open);
				for (const item of openItems) closeOpen(item);
			};

			const toolCallForEvent = (contentIndex: number): OpenFunctionCall | OpenComputerCall | undefined => {
				const item = openItemForContentIndex(contentIndex);
				return item?.kind === "function_call" || item?.kind === "computer_call" ? item : undefined;
			};
			let finalMessage: AssistantMessage | undefined;
			let failureMessage: AssistantMessage | undefined;
			try {
				if (cancelled) {
					controller.close();
					return;
				}
				for await (const ev of events) {
					if (cancelled) return;
					switch (ev.type) {
						case "start": {
							createdAt = Math.floor((ev.partial.timestamp || Date.now()) / 1000);
							// response.created — initial envelope.
							emit("response.created", { response: responseSnapshot("in_progress", []) });
							// response.in_progress — mirrors real OpenAI; some clients gate
							// on it before reading items.
							emit("response.in_progress", { response: responseSnapshot("in_progress", []) });
							break;
						}
						case "text_start": {
							let cur: OpenMessage;
							const textBlock = ev.partial.content[ev.contentIndex];
							const signature =
								textBlock?.type === "text" ? parseTextSignature(textBlock.textSignature) : undefined;
							const existing = [...new Set(openItemsByContentIndex.values())].find(candidate => {
								if (candidate.kind !== "message") return false;
								return (
									(!signature && !candidate.signature) ||
									(signature !== undefined &&
										candidate.signature?.id === signature.id &&
										candidate.signature.phase === signature.phase)
								);
							}) as OpenMessage | undefined;
							if (existing) {
								cur = existing;
								cur.currentPartText = "";
								openItemsByContentIndex.set(ev.contentIndex, cur);
								state.open = cur;
							} else {
								cur = openMessage(signature, ev.contentIndex);
							}
							const contentPart = { type: "output_text", text: "", annotations: [] as never[] };
							emit("response.content_part.added", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								part: contentPart,
							});
							break;
						}
						case "text_delta": {
							const item = openItemForContentIndex(ev.contentIndex);
							if (item?.kind !== "message") break;
							const cur = item;
							cur.currentPartText += ev.delta;
							emit("response.output_text.delta", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								delta: ev.delta,
								logprobs: [],
							});
							// TODO: when pi-ai surfaces output_text annotations
							// (web_search citations, …), emit
							// `response.output_text.annotation.added` here.
							break;
						}
						case "text_end": {
							const item = openItemForContentIndex(ev.contentIndex);
							if (item?.kind !== "message") break;
							const cur = item;
							const text = ev.content ?? cur.currentPartText;
							emit("response.output_text.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								text,
								logprobs: [],
							});
							cur.content.push({ type: "output_text", text, annotations: [] });
							emit("response.content_part.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								part: { type: "output_text", text, annotations: [] },
							});
							cur.contentIndex += 1;
							cur.currentPartText = "";
							break;
						}
						case "thinking_start": {
							openReasoning(ev.partial, ev.contentIndex);
							break;
						}
						case "thinking_delta": {
							const item = openItemForContentIndex(ev.contentIndex);
							if (item?.kind !== "reasoning") break;
							const cur = item;
							cur.reasoningText += ev.delta;
							emit("response.reasoning_summary_text.delta", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								delta: ev.delta,
							});
							break;
						}
						case "thinking_end": {
							const item = openItemForContentIndex(ev.contentIndex);
							if (item?.kind !== "reasoning") break;
							const cur = item;
							const text = ev.content ?? cur.reasoningText;
							cur.reasoningText = text;
							emit("response.reasoning_summary_text.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								text,
							});
							emit("response.reasoning_summary_part.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								part: { type: "summary_text", text },
							});
							closeOpen(cur);
							break;
						}
						case "toolcall_start": {
							openToolCall(ev.partial, ev.contentIndex);
							break;
						}
						case "toolcall_delta": {
							const cur = toolCallForEvent(ev.contentIndex);
							if (!cur || cur.kind === "computer_call") break;
							cur.argsText += ev.delta;
							if (cur.customWireName) {
								emit("response.custom_tool_call_input.delta", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									delta: ev.delta,
								});
							} else {
								emit("response.function_call_arguments.delta", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									delta: ev.delta,
								});
							}
							break;
						}
						case "toolcall_end": {
							const cur = toolCallForEvent(ev.contentIndex);
							if (!cur) break;
							const tc = ev.toolCall;
							if (cur.kind === "computer_call") {
								cur.callId = wireCallId(tc.id);
								if (tc.providerMetadata?.type === "computer") {
									cur.itemId = tc.providerMetadata.providerItemId;
									cur.actions = tc.providerMetadata.actions;
									cur.pendingSafetyChecks = tc.providerMetadata.pendingSafetyChecks;
								}
								closeComputerCall(cur);
								break;
							}
							// Promote possibly-late info from the canonical ToolCall.
							if (tc.customWireName && !cur.customWireName) cur.customWireName = tc.customWireName;
							if (tc.thoughtSignature) cur.itemId = tc.thoughtSignature;
							cur.callId = wireCallId(tc.id);
							cur.name = cur.customWireName ?? tc.name;
							if (cur.customWireName) {
								// Custom tool: raw input string. Streamed deltas accumulated
								// the wire-level body; fall back to `arguments.input` from
								// the finalized ToolCall when nothing streamed (rare).
								const rawInput =
									cur.argsText ||
									(typeof tc.arguments?.input === "string" ? (tc.arguments.input as string) : "");
								cur.argsText = rawInput;
								emit("response.custom_tool_call_input.done", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									input: rawInput,
									name: cur.name,
								});
							} else {
								// Standard JSON tool: arguments object on the omp side, the
								// wire wants the JSON string the model emitted (= streamed deltas).
								const argsJson = cur.argsText || JSON.stringify(tc.arguments ?? {});
								cur.argsText = argsJson;
								emit("response.function_call_arguments.done", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									arguments: argsJson,
									name: cur.name,
								});
							}
							closeFunctionCall(cur);
							break;
						}
						case "done": {
							finalMessage = ev.message;
							break;
						}
						case "error": {
							failureMessage = ev.error;
							break;
						}
					}
				}

				if (failureMessage) {
					closeAllOpenItems();
					controller.enqueue(
						encoder.encode(
							sseEvent("response.failed", {
								type: "response.failed",
								sequence_number: seq(),
								response: {
									...responseSnapshot("failed", finishedItems),
									error: { message: failureMessage.errorMessage ?? "stream failed" },
								},
							}),
						),
					);
					emitDone();
					controller.close();
					return;
				}

				closeAllOpenItems();
				const message = finalMessage ?? ((await events.result().catch(() => null)) as AssistantMessage | null);

				// Build the canonical output from the final message so non-streaming
				// readers see the exact same shape they'd get from encodeResponse().
				const items = message ? buildOutputItems(message) : finishedItems;
				const usage = message ? buildUsage(message) : null;
				const status = message ? responseStatusForStopReason(message) : "completed";
				const terminalEvent =
					status === "incomplete"
						? "response.incomplete"
						: status === "failed"
							? "response.failed"
							: "response.completed";
				controller.enqueue(
					encoder.encode(
						sseEvent(terminalEvent, {
							type: terminalEvent,
							sequence_number: seq(),
							response: {
								id: responseId,
								object: "response",
								created_at: createdAt,
								status,
								model: requestedModelId,
								output: items,
								usage,
								incomplete_details: incompleteDetailsForStatus(status),
								...(status === "failed"
									? { error: { message: message?.errorMessage ?? "response failed" } }
									: {}),
							},
						}),
					),
				);
				emitDone();
				controller.close();
			} catch (err) {
				if (!cancelled) {
					controller.enqueue(
						encoder.encode(
							sseEvent("response.failed", {
								type: "response.failed",
								sequence_number: seq(),
								response: {
									id: responseId,
									object: "response",
									created_at: Math.floor(Date.now() / 1000),
									status: "failed",
									model: requestedModelId,
									output: [],
									error: { message: err instanceof Error ? err.message : String(err) },
									incomplete_details: null,
								},
							}),
						),
					);
					emitDone();
					controller.close();
				}
			} finally {
				control?.signal?.removeEventListener("abort", markCancelled);
			}
		},
		cancel(reason) {
			cancelled = true;
			control?.signal?.removeEventListener("abort", markCancelled);
			control?.onCancel?.(reason);
		},
	});
}
