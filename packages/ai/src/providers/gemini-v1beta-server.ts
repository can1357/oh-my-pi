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
	Message,
	ImageContent,
	ServiceTier,
	StopReason,
	TextContent,
	ToolCall,
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
	return blocksFromGeminiParts(parts).text;
}

interface GeminiPartBlocks {
	text: string;
	images: ImageContent[];
	toolCalls: ToolCall[];
	toolResponses: Array<{ name: string; text: string }>;
}

/** Split native Gemini parts into text, images, tool calls, and tool responses. */
function blocksFromGeminiParts(parts: unknown): GeminiPartBlocks {
	const out: GeminiPartBlocks = { text: "", images: [], toolCalls: [], toolResponses: [] };
	if (!Array.isArray(parts)) return out;
	for (const part of parts) {
		if (!isRecord(part)) continue;
		if (part.thought === true) continue;
		if (typeof part.text === "string") {
			out.text += part.text;
			continue;
		}
		if (isRecord(part.inlineData)) {
			const data = part.inlineData.data;
			const mimeType = part.inlineData.mimeType;
			if (typeof data === "string" && data.length > 0 && typeof mimeType === "string" && mimeType.length > 0) {
				out.images.push({ type: "image", data, mimeType });
			}
			continue;
		}
		if (isRecord(part.fileData)) {
			const fileUri = part.fileData.fileUri;
			if (typeof fileUri === "string" && fileUri.length > 0) {
				const mimeType =
					typeof part.fileData.mimeType === "string" && part.fileData.mimeType.length > 0
						? part.fileData.mimeType
						: "image/png";
				out.images.push({ type: "image", data: "", mimeType, url: fileUri });
			}
			continue;
		}
		if (isRecord(part.functionCall)) {
			const name = part.functionCall.name;
			if (typeof name === "string" && name.length > 0) {
				const args = part.functionCall.args;
				out.toolCalls.push({
					type: "toolCall",
					id: `gemini-fc-${out.toolCalls.length}`,
					name,
					arguments: isRecord(args) ? args : {},
				});
			}
			continue;
		}
		if (isRecord(part.functionResponse)) {
			const name = part.functionResponse.name;
			const response = part.functionResponse.response;
			out.toolResponses.push({
				name: typeof name === "string" ? name : "",
				text: typeof response === "string" ? response : JSON.stringify(response ?? null),
			});
		}
	}
	return out;
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

function makeAssistantMessage(text: string, modelId: string, timestamp: number): AssistantMessage {
	const content: TextContent[] = text.length > 0 ? [{ type: "text", text }] : [];
	return {
		role: "assistant",
		content,
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
	text: string | GeminiPartBlocks,
	ids: string[] = [],
	usedCalls: Set<string> = new Set(),
	modelId: string,
	timestamp: number,
): void {
	if (role === "system") {
		const systemText = typeof text === "string" ? text : text.text;
		if (systemText.length > 0) systemParts.push(systemText);
		return;
	}
	if (typeof text === "string") {
		if (text.length === 0) return;
		if (role === "user") messages.push({ role: "user", content: text, timestamp });
		else messages.push(makeAssistantMessage(text, modelId, timestamp));
		return;
	}
	pushTurnBlocks(messages, role, text, ids, usedCalls, modelId, timestamp);
}

function walkContents(
	contents: unknown[],
	messages: Message[],
	systemParts: string[],
	modelId: string,
	timestamp: number,
): void {
	// Deterministic tool-call ids (`gemini-fc-{turn}-{index}`) so a
	// functionResponse can pair with its call by name within one request.
	const callIds: string[][] = contents.map((item, turn) => {
		if (!isRecord(item)) return [];
		return blocksFromGeminiParts(item.parts).toolCalls.map((_, index) => `gemini-fc-${turn}-${index}`);
	});
	const usedCalls = new Set<string>();
	contents.forEach((item, turn) => {
		if (!isRecord(item)) return;
		pushTurn(
			messages,
			systemParts,
			classifyRole(item.role) ?? "user",
			blocksFromGeminiParts(item.parts),
			callIds[turn] ?? [],
			usedCalls,
			modelId,
			timestamp,
		);
	});
}

function pushTurnBlocks(
	messages: Message[],
	role: "user" | "assistant",
	blocks: GeminiPartBlocks,
	ids: string[],
	usedCalls: Set<string>,
	modelId: string,
	timestamp: number,
): void {
	if (role === "user") {
		if (blocks.text.length > 0 || blocks.images.length > 0) {
			const content: Array<TextContent | ImageContent> = [];
			if (blocks.text.length > 0) content.push({ type: "text", text: blocks.text });
			content.push(...blocks.images);
			messages.push({ role: "user", content, timestamp });
		}
	} else if (blocks.text.length > 0 || blocks.images.length > 0 || blocks.toolCalls.length > 0) {
		const calls = blocks.toolCalls.map((call, index) => ({ ...call, id: ids[index] ?? call.id }));
		const content: AssistantMessage["content"] = [];
		if (blocks.text.length > 0) content.push({ type: "text", text: blocks.text });
		content.push(...blocks.images);
		content.push(...calls);
		messages.push({
			role: "assistant",
			content,
			stopReason: "stop",
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
			timestamp,
		});
	}
	for (const response of blocks.toolResponses) {
		const match = findCallId(messages, response.name, usedCalls);
		messages.push({
			role: "toolResult",
			toolCallId: match ?? `gemini-unpaired-${response.name}`,
			toolName: response.name,
			content: [{ type: "text", text: response.text }],
			isError: false,
			timestamp,
		});
	}
}

/** Pair a function response with the most recent unmatched same-name call. */
function findCallId(messages: Message[], name: string, usedCalls: Set<string>): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (name !== "" && block.name !== name) continue;
			if (usedCalls.has(block.id)) continue;
			usedCalls.add(block.id);
			return block.id;
		}
	}
	return undefined;
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
		pushTurn(messages, systemParts, role, textFromOpenAiContent(item.content), [], new Set(), modelId, timestamp);
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

export function parseRequest(body: unknown, _headers?: Headers): ParsedRequest {
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

	const modelId = typeof body.model === "string" ? body.model : "";
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
		...(tools ? { tools } : {}),
		messages,
		...(systemParts.length > 0 ? { systemPrompt: systemParts } : {}),
	};

	return {
		modelId,
		context,
		stream: typeof body.stream === "boolean" ? body.stream : true,
		options,
	};
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
			const emittedCalls = new Set<string>();
			const emitCall = (call: ToolCall) => {
				if (emittedCalls.has(call.id)) return;
				emittedCalls.add(call.id);
				writeSse(
					controller,
					{
						...geminiCandidate(
							[{ functionCall: { name: call.name, args: call.arguments, id: call.id } }],
							undefined,
						),
						modelVersion: requestedModelId,
					},
					cancelled,
				);
			};
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
						case "toolcall_end":
							emitCall(event.toolCall);
							break;
						case "done":
							for (const part of event.message.content) {
								if (part.type === "toolCall") emitCall(part);
							}
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
