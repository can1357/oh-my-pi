/**
 * Gemini v1beta generateContent API ↔ pi-ai gateway translation.
 * Inbound: foreign HTTP body → omp Context. Outbound:
 * omp AssistantMessage[Stream] → Gemini-shaped JSON / SSE.
 *
 * Native body: `{ contents: [{ role, parts: [{ text }] }] }`.
 * Also accepts OpenAI-ish `{ messages }`. `model` may be absent on the body
 * (Gemini puts it on the path: `/v1beta/models/{model}:generateContent`).
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	AuthGatewayFormatModule,
	AuthGatewayStreamControl,
	AuthGatewayParsedRequest as ParsedRequest,
} from "../auth-gateway/types";
import * as AIError from "../error";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	ServiceTier,
	StopReason,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types";

export type { ParsedRequest };

const GEMINI_API = "google-generative-ai" as const;
const GEMINI_PROVIDER = "google" as const;
const SSE_ENCODER = new TextEncoder();

function isServiceTier(value: unknown): value is ServiceTier {
	return value === "auto" || value === "default" || value === "flex" || value === "scale" || value === "priority";
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.length > 0) out.push(item);
	}
	return out.length > 0 ? out : undefined;
}

function textFromGeminiParts(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	let text = "";
	for (const part of parts) {
		if (!isRecord(part)) continue;
		if (part.thought === true) continue;
		if (typeof part.text === "string") text += part.text;
	}
	return text;
}

function readInlineData(part: Record<string, unknown>): ImageContent | undefined {
	const inline = part.inlineData ?? part.inline_data;
	if (!isRecord(inline)) return undefined;
	const mimeType =
		typeof inline.mimeType === "string"
			? inline.mimeType
			: typeof inline.mime_type === "string"
				? inline.mime_type
				: undefined;
	const data = typeof inline.data === "string" ? inline.data : undefined;
	if (!mimeType || !data) return undefined;
	return { type: "image", mimeType, data };
}

/** Map Gemini text/inlineData parts to user/assistant content. */
function contentFromGeminiParts(parts: unknown): string | (TextContent | ImageContent)[] {
	if (!Array.isArray(parts)) return "";
	const blocks: (TextContent | ImageContent)[] = [];
	let textOnly = "";
	let hasImage = false;
	for (const part of parts) {
		if (!isRecord(part)) continue;
		if (part.thought === true) continue;
		if (typeof part.text === "string" && part.text.length > 0) {
			textOnly += part.text;
			blocks.push({ type: "text", text: part.text });
			continue;
		}
		const image = readInlineData(part);
		if (image) {
			hasImage = true;
			blocks.push(image);
			continue;
		}
		if (part.fileData !== undefined || part.file_data !== undefined) {
			throw new AIError.ValidationError(
				"gemini-v1beta: unsupported part type (fileData); only text, inlineData, functionCall, and functionResponse are accepted",
			);
		}
	}
	if (!hasImage) return textOnly;
	return blocks;
}

function readFunctionCall(part: Record<string, unknown>): ToolCall | undefined {
	const call = part.functionCall ?? part.function_call;
	if (!isRecord(call)) return undefined;
	const name = typeof call.name === "string" ? call.name : undefined;
	if (!name) return undefined;
	const id =
		typeof call.id === "string" && call.id.length > 0
			? call.id
			: `gemini_call_${name}_${Math.random().toString(36).slice(2, 10)}`;
	const args = call.args ?? call.arguments;
	return {
		type: "toolCall",
		id,
		name,
		arguments: isRecord(args) ? args : {},
	};
}

function functionResponseToToolResult(
	part: Record<string, unknown>,
	timestamp: number,
): ToolResultMessage | undefined {
	const resp = part.functionResponse ?? part.function_response;
	if (!isRecord(resp)) return undefined;
	const name = typeof resp.name === "string" ? resp.name : "unknown";
	const id =
		typeof resp.id === "string" && resp.id.length > 0
			? resp.id
			: `gemini_resp_${name}_${Math.random().toString(36).slice(2, 10)}`;
	const response = resp.response;
	let isError = false;
	let text = "";
	if (typeof response === "string") {
		text = response;
	} else if (isRecord(response)) {
		if (typeof response.error === "string") {
			isError = true;
			text = response.error;
		} else if (typeof response.output === "string") {
			text = response.output;
		} else {
			try {
				text = JSON.stringify(response);
			} catch {
				text = String(response);
			}
		}
	} else if (response !== undefined) {
		text = String(response);
	}
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: text.length > 0 ? [{ type: "text", text }] : [],
		isError,
		timestamp,
	};
}

function textFromOpenAiContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let text = "";
		for (const part of content) {
			if (typeof part === "string") {
				text += part;
				continue;
			}
			if (!isRecord(part)) continue;
			if (typeof part.text === "string") text += part.text;
		}
		return text;
	}
	if (isRecord(content) && typeof content.text === "string") return content.text;
	return "";
}

function collectSystemTexts(value: unknown, into: string[]): void {
	if (typeof value === "string") {
		if (value.length > 0) into.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectSystemTexts(item, into);
		return;
	}
	if (!isRecord(value)) return;
	if (Array.isArray(value.parts)) {
		const text = textFromGeminiParts(value.parts);
		if (text.length > 0) into.push(text);
		return;
	}
	if (typeof value.text === "string" && value.text.length > 0) into.push(value.text);
}

function classifyRole(role: unknown): "user" | "assistant" | "system" | undefined {
	if (role === "user" || role === "human") return "user";
	if (role === "model" || role === "assistant") return "assistant";
	if (role === "system" || role === "developer") return "system";
	return undefined;
}

function makeAssistantMessage(
	content: string | (TextContent | ImageContent | ToolCall)[],
	modelId: string,
	timestamp: number,
): AssistantMessage {
	const blocks: (TextContent | ToolCall)[] =
		typeof content === "string"
			? content.length > 0
				? [{ type: "text", text: content }]
				: []
			: content.filter(
					(block): block is TextContent | ToolCall => block.type === "text" || block.type === "toolCall",
				);
	return {
		role: "assistant",
		content: blocks,
		api: GEMINI_API,
		provider: GEMINI_PROVIDER,
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
		timestamp,
	};
}

function pushTurn(
	messages: Message[],
	systemParts: string[],
	role: "user" | "assistant" | "system",
	content: string | (TextContent | ImageContent | ToolCall)[],
	modelId: string,
	timestamp: number,
): void {
	if (role === "system") {
		const text =
			typeof content === "string"
				? content
				: content
						.filter((block): block is TextContent => block.type === "text")
						.map(block => block.text)
						.join("");
		if (text.length > 0) systemParts.push(text);
		return;
	}
	const empty = typeof content === "string" ? content.length === 0 : content.length === 0;
	if (empty) return;
	if (role === "user") {
		const userContent: string | (TextContent | ImageContent)[] =
			typeof content === "string"
				? content
				: content.filter((block): block is TextContent | ImageContent => block.type !== "toolCall");
		messages.push({ role: "user", content: userContent, timestamp });
	} else messages.push(makeAssistantMessage(content, modelId, timestamp));
}

function walkContents(
	contents: unknown[],
	messages: Message[],
	systemParts: string[],
	modelId: string,
	timestamp: number,
): void {
	for (const item of contents) {
		if (!isRecord(item)) continue;
		const role = classifyRole(item.role) ?? "user";
		const parts = Array.isArray(item.parts) ? item.parts : [];
		const toolCalls: ToolCall[] = [];
		const toolResults: ToolResultMessage[] = [];
		const mediaParts: unknown[] = [];
		for (const part of parts) {
			if (!isRecord(part)) continue;
			const call = readFunctionCall(part);
			if (call) {
				toolCalls.push(call);
				continue;
			}
			const result = functionResponseToToolResult(part, timestamp);
			if (result) {
				toolResults.push(result);
				continue;
			}
			mediaParts.push(part);
		}
		const content = contentFromGeminiParts(mediaParts);
		if (toolCalls.length > 0) {
			const blocks: (TextContent | ImageContent | ToolCall)[] =
				typeof content === "string"
					? [...(content.length > 0 ? [{ type: "text" as const, text: content }] : []), ...toolCalls]
					: [...content, ...toolCalls];
			pushTurn(messages, systemParts, role === "system" ? "assistant" : role, blocks, modelId, timestamp);
		} else {
			const hasContent = !(typeof content === "string" ? content.length === 0 : content.length === 0);
			if (hasContent) {
				pushTurn(messages, systemParts, role, content, modelId, timestamp);
			}
		}
		for (const result of toolResults) {
			messages.push(result);
		}
	}
}

function walkMessages(
	wireMessages: unknown[],
	messages: Message[],
	systemParts: string[],
	modelId: string,
	timestamp: number,
): void {
	for (const item of wireMessages) {
		if (!isRecord(item)) continue;
		const role = classifyRole(item.role);
		if (role === undefined) continue;
		pushTurn(messages, systemParts, role, textFromOpenAiContent(item.content), modelId, timestamp);
	}
}

function applyGenerationConfig(options: ParsedRequest["options"], config: Record<string, unknown>): void {
	const temperature = readFiniteNumber(config.temperature);
	if (temperature !== undefined) options.temperature = temperature;
	const maxOutputTokens = readFiniteNumber(config.maxOutputTokens) ?? readFiniteNumber(config.max_output_tokens);
	if (maxOutputTokens !== undefined) options.maxOutputTokens = maxOutputTokens;
	const topP = readFiniteNumber(config.topP) ?? readFiniteNumber(config.top_p);
	if (topP !== undefined) options.topP = topP;
	const topK = readFiniteNumber(config.topK) ?? readFiniteNumber(config.top_k);
	if (topK !== undefined) options.topK = topK;
	const presencePenalty = readFiniteNumber(config.presencePenalty) ?? readFiniteNumber(config.presence_penalty);
	if (presencePenalty !== undefined) options.presencePenalty = presencePenalty;
	const frequencyPenalty = readFiniteNumber(config.frequencyPenalty) ?? readFiniteNumber(config.frequency_penalty);
	if (frequencyPenalty !== undefined) options.frequencyPenalty = frequencyPenalty;
	const seed = readFiniteNumber(config.seed);
	if (seed !== undefined) options.seed = seed;
	const stopSequences = readStringArray(config.stopSequences) ?? readStringArray(config.stop_sequences);
	if (stopSequences) options.stopSequences = stopSequences;
	const serviceTier = config.serviceTier ?? config.service_tier;
	if (isServiceTier(serviceTier)) options.serviceTier = serviceTier;
	const responseMimeType =
		typeof config.responseMimeType === "string"
			? config.responseMimeType
			: typeof config.response_mime_type === "string"
				? config.response_mime_type
				: undefined;
	if (responseMimeType !== undefined) options.responseMimeType = responseMimeType;
	const responseSchema = config.responseSchema ?? config.response_schema;
	if (isRecord(responseSchema)) options.responseSchema = responseSchema;
	const responseJsonSchema = config.responseJsonSchema ?? config.response_json_schema;
	if (isRecord(responseJsonSchema)) options.responseJsonSchema = responseJsonSchema;
}

function applyOpenAiSampling(options: ParsedRequest["options"], body: Record<string, unknown>): void {
	const temperature = readFiniteNumber(body.temperature);
	if (temperature !== undefined && options.temperature === undefined) options.temperature = temperature;
	const maxOutputTokens = readFiniteNumber(body.max_tokens) ?? readFiniteNumber(body.maxOutputTokens);
	if (maxOutputTokens !== undefined && options.maxOutputTokens === undefined) {
		options.maxOutputTokens = maxOutputTokens;
	}
	const topP = readFiniteNumber(body.top_p) ?? readFiniteNumber(body.topP);
	if (topP !== undefined && options.topP === undefined) options.topP = topP;
	const topK = readFiniteNumber(body.top_k) ?? readFiniteNumber(body.topK);
	if (topK !== undefined && options.topK === undefined) options.topK = topK;
	const stopSequences = readStringArray(body.stop);
	if (stopSequences && options.stopSequences === undefined) options.stopSequences = stopSequences;
}

// ---------------------------------------------------------------------------
// parseRequest
// ---------------------------------------------------------------------------

export function parseRequest(body: unknown, _headers?: Headers, defaultStream = false): ParsedRequest {
	if (!isRecord(body)) {
		throw new AIError.ValidationError("gemini-v1beta: request body must be a JSON object");
	}

	const hasContents = "contents" in body && body.contents !== undefined;
	const hasMessages = "messages" in body && body.messages !== undefined;
	if (!hasContents && !hasMessages) {
		throw new AIError.ValidationError("gemini-v1beta: missing contents or messages");
	}
	if (hasContents && !Array.isArray(body.contents)) {
		throw new AIError.ValidationError("gemini-v1beta: contents must be an array");
	}
	if (hasMessages && !Array.isArray(body.messages)) {
		throw new AIError.ValidationError("gemini-v1beta: messages must be an array");
	}

	const modelId = typeof body.model === "string" && body.model.length > 0 ? body.model : "";
	const now = Date.now();
	const messages: Message[] = [];
	const systemParts: string[] = [];

	collectSystemTexts(body.systemInstruction ?? body.system_instruction, systemParts);

	if (Array.isArray(body.contents)) {
		walkContents(body.contents, messages, systemParts, modelId, now);
	} else if (Array.isArray(body.messages)) {
		walkMessages(body.messages, messages, systemParts, modelId, now);
	}

	const options: ParsedRequest["options"] = {};
	const generationConfig = body.generationConfig ?? body.generation_config;
	if (isRecord(generationConfig)) applyGenerationConfig(options, generationConfig);
	applyOpenAiSampling(options, body);

	const tools = buildToolsFromGeminiBody(body.tools);
	const context: Context = {
		messages,
		...(systemParts.length > 0 ? { systemPrompt: systemParts } : {}),
		...(tools ? { tools } : {}),
	};

	return {
		modelId,
		context,
		stream: typeof body.stream === "boolean" ? body.stream : defaultStream,
		options,
	};
}

/** Translate Gemini `tools[].functionDeclarations` into canonical `Context.tools`. */
function buildToolsFromGeminiBody(tools: unknown): Context["tools"] | undefined {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	const out: NonNullable<Context["tools"]> = [];
	for (const entry of tools) {
		if (!isRecord(entry)) continue;
		const decls = entry.functionDeclarations ?? entry.function_declarations;
		if (!Array.isArray(decls)) continue;
		for (const decl of decls) {
			if (!isRecord(decl) || typeof decl.name !== "string" || decl.name.length === 0) continue;
			const parameters = (decl.parametersJsonSchema ??
				decl.parameters_json_schema ??
				decl.parameters ??
				{}) as NonNullable<Context["tools"]>[number]["parameters"];
			out.push({
				name: decl.name,
				description: typeof decl.description === "string" ? decl.description : "",
				parameters,
			});
		}
	}
	return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// encodeResponse (non-streaming)
// ---------------------------------------------------------------------------

function flattenAssistantParts(message: AssistantMessage): Record<string, unknown>[] {
	const parts: Record<string, unknown>[] = [];
	for (const part of message.content) {
		if (part.type === "text" && part.text.length > 0) {
			parts.push({ text: part.text });
			continue;
		}
		if (part.type === "toolCall") {
			parts.push({
				functionCall: {
					name: part.name,
					args: part.arguments ?? {},
					id: part.id,
				},
			});
		}
	}
	return parts;
}

function mapFinishReason(reason: StopReason): string {
	if (reason === "length") return "MAX_TOKENS";
	if (reason === "toolUse") return "STOP";
	return "STOP";
}

function geminiCandidate(parts: Record<string, unknown>[], finishReason: string | undefined): Record<string, unknown> {
	const candidate: Record<string, unknown> = {
		content: {
			role: "model",
			parts: parts.length > 0 ? parts : [{ text: "" }],
		},
	};
	if (finishReason !== undefined) candidate.finishReason = finishReason;
	return { candidates: [candidate] };
}

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new AIError.ProviderResponseError(message.errorMessage ?? `gemini-v1beta: upstream ${message.stopReason}`, {
			provider: GEMINI_PROVIDER,
			kind: "output",
		});
	}
	return {
		...geminiCandidate(flattenAssistantParts(message), mapFinishReason(message.stopReason)),
		modelVersion: requestedModelId,
	};
}


// ---------------------------------------------------------------------------
// encodeStream (SSE)
// ---------------------------------------------------------------------------

function writeSse(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown, cancelled: boolean): void {
	if (!cancelled) controller.enqueue(SSE_ENCODER.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	_options?: ParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				if (cancelled) {
					controller.close();
					return;
				}
				for await (const event of events) {
					if (cancelled) return;
					switch (event.type) {
						case "text_delta":
							if (event.delta.length > 0) {
								writeSse(
									controller,
									{ ...geminiCandidate([{ text: event.delta }], undefined), modelVersion: requestedModelId },
									cancelled,
								);
							}
							break;
						case "toolcall_start":
						case "toolcall_delta":
						case "toolcall_end": {
							const call = event.toolCall;
							writeSse(
								controller,
								{
									...geminiCandidate(
										[
											{
												functionCall: {
													name: call.name,
													args: call.arguments ?? {},
													id: call.id,
												},
											},
										],
										undefined,
									),
									modelVersion: requestedModelId,
								},
								cancelled,
							);
							break;
						}
						case "done":
							writeSse(
								controller,
								{
									...geminiCandidate([], mapFinishReason(event.reason)),
									modelVersion: requestedModelId,
								},
								cancelled,
							);
							controller.close();
							return;
						case "error": {
							const msg = event.error.errorMessage ?? "stream error";
							writeSse(controller, { error: { message: msg, status: "INTERNAL", code: 500 } }, cancelled);
							controller.close();
							return;
						}
						default:
							break;
					}
				}
				if (!cancelled) {
					writeSse(controller, { ...geminiCandidate([], "STOP"), modelVersion: requestedModelId }, cancelled);
					controller.close();
				}
			} catch (err) {
				if (!cancelled) {
					const msg = err instanceof Error ? err.message : String(err);
					writeSse(controller, { error: { message: msg, status: "INTERNAL", code: 500 } }, cancelled);
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

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * Gemini error envelope: `{ error: { message, status, code } }`.
 * See https://ai.google.dev/gemini-api/docs/troubleshooting.
 */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { message, status: type, code: status } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export const geminiV1betaFormatModule: AuthGatewayFormatModule = {
	parseRequest,
	encodeResponse,
	encodeStream,
	formatError,
};
