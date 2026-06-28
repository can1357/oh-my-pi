import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	ChatMessageRequestType,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "@pk-nerdsaver-ai/pi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import {
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
} from "@pk-nerdsaver-ai/pi-catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import {
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatToolChoiceSchema,
	ChatToolDefinitionSchema,
	PromptCacheOptionsSchema,
} from "@pk-nerdsaver-ai/pi-catalog/discovery/devin-gen/exa/chat_pb/chat_pb";
import {
	ChatMessageSource,
	type ChatToolCall,
	ChatToolCallSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	ImageDataSchema,
	MetadataSchema,
	StopReason,
} from "@pk-nerdsaver-ai/pi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import { calculateCost } from "@pk-nerdsaver-ai/pi-catalog/models";
import { logger, parseStreamingJson } from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";

/** Base host for Codeium/Windsurf's Cascade chat API (Connect protocol over HTTP/1.1). */
export const DEVIN_API_URL = "https://server.codeium.com";

export interface DevinOptions extends StreamOptions {
	/** Cascade conversation id; reused as `cascade_id` so the server threads turns. */
	conversationId?: string;
	/** Falls back to `cascade_id` when no `conversationId` is supplied. */
	sessionId?: string;
	/** Wire model uid selected after thinking-effort routing. */
	chatModelUid?: string;
}

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DEVIN_IDE_VERSION = "3.2.23";
const DEVIN_EXTENSION_VERSION = "1.48.2";
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_DEFAULT_STOP_PATTERNS = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];

/** Connect streaming framing: flag byte bit 0x01 = gzip payload, 0x02 = end-of-stream JSON trailers. */
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;

export const streamDevin: StreamFunction<"devin-agent"> = (
	model: Model<"devin-agent">,
	context: Context,
	options?: DevinOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "devin-agent" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let currentTextBlock: TextContent | null = null;
		let currentThinkingBlock: ThinkingContent | null = null;
		// Tool-call content blocks keyed by streamed tool-call id, plus the JSON-args text
		// accumulated per id (kept out of the content object so finalized tool calls stay clean).
		const toolBlocks = new Map<string, ToolCall>();
		const toolPartialJson = new Map<string, string>();
		let activeToolCallId: string | undefined;
		let latestStopReason = StopReason.UNSPECIFIED;

		const markFirstToken = () => {
			if (firstTokenTime === undefined) firstTokenTime = performance.now();
		};

		const endTextBlock = () => {
			const block = currentTextBlock;
			if (!block) return;
			currentTextBlock = null;
			stream.push({
				type: "text_end",
				contentIndex: output.content.indexOf(block),
				content: block.text,
				partial: output,
			});
		};

		const endThinkingBlock = () => {
			const block = currentThinkingBlock;
			if (!block) return;
			currentThinkingBlock = null;
			stream.push({
				type: "thinking_end",
				contentIndex: output.content.indexOf(block),
				content: block.thinking,
				partial: output,
			});
		};

		try {
			const fetchImpl = options?.fetch ?? fetch;
			const baseUrl = (model.baseUrl || DEVIN_API_URL).replace(/\/+$/, "");
			const apiKey = normalizeDevinSessionToken(options?.apiKey);
			const auth = await fetchDevinAuthMetadata(apiKey, baseUrl, fetchImpl, options?.signal);
			const chatBaseUrl = auth.baseUrl ?? baseUrl;
			const request = buildDevinChatRequest(model, context, options, apiKey, auth.userJwt);
			logger.debug("devin: sending chat request", { model: model.id, tools: context.tools?.length ?? 0 });

			const reqBytes = toBinary(GetChatMessageRequestSchema, request);
			const gz = gzipSync(reqBytes);
			const frame = Buffer.alloc(5 + gz.length);
			frame[0] = CONNECT_COMPRESSED_FLAG;
			frame.writeUInt32BE(gz.length, 1);
			frame.set(gz, 5);

			const response = await fetchImpl(chatBaseUrl + CHAT_MESSAGE_PATH, {
				method: "POST",
				headers: {
					"content-type": "application/connect+proto",
					"connect-protocol-version": "1",
					"connect-content-encoding": "gzip",
					"accept-encoding": "identity",
					"user-agent": "connect-go/1.18.1 (go1.26.3)",
					"connect-accept-encoding": "gzip",
					...(options?.headers ?? {}),
				},
				body: frame,
				signal: options?.signal,
			});

			if (!response.ok) {
				const text = await response.text();
				throw new AIError.DevinApiError(
					`Devin API error ${response.status} ${response.statusText}: ${text}`,
					response.status,
				);
			}
			if (!response.body) {
				throw new AIError.ProviderResponseError("Devin API error: response body is empty", {
					provider: model.provider,
					kind: "empty-body",
				});
			}
			const body = response.body;

			stream.push({ type: "start", partial: output });

			const reader = body.getReader();
			let pending = Buffer.alloc(0);

			for (;;) {
				const { done, value } = await reader.read();
				if (value && value.length > 0) {
					pending = Buffer.concat([pending, value]);
				}

				while (pending.length >= 5) {
					const flag = pending[0];
					const len = pending.readUInt32BE(1);
					if (pending.length < 5 + len) break;
					const payload = pending.subarray(5, 5 + len);
					pending = pending.subarray(5 + len);

					if (flag & CONNECT_END_STREAM_FLAG) {
						const trailerBytes = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
						const trailerError = readConnectTrailerError(trailerBytes.toString("utf8").trim());
						if (trailerError) throw new AIError.ValidationError(trailerError);
						continue;
					}

					const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
					const msg = fromBinary(GetChatMessageResponseSchema, raw);
					if (msg.messageId && !output.responseId) output.responseId = msg.messageId;

					if (msg.deltaThinking) {
						markFirstToken();
						const block: ThinkingContent = currentThinkingBlock ?? { type: "thinking", thinking: "" };
						if (currentThinkingBlock !== block) {
							output.content.push(block);
							currentThinkingBlock = block;
							stream.push({
								type: "thinking_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						block.thinking += msg.deltaThinking;
						if (msg.deltaSignature) block.thinkingSignature = msg.deltaSignature;
						stream.push({
							type: "thinking_delta",
							contentIndex: output.content.indexOf(block),
							delta: msg.deltaThinking,
							partial: output,
						});
					}

					if (msg.deltaText) {
						markFirstToken();
						endThinkingBlock();
						const block: TextContent = currentTextBlock ?? { type: "text", text: "" };
						if (currentTextBlock !== block) {
							output.content.push(block);
							currentTextBlock = block;
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						}
						block.text += msg.deltaText;
						stream.push({
							type: "text_delta",
							contentIndex: output.content.indexOf(block),
							delta: msg.deltaText,
							partial: output,
						});
					}

					if (msg.deltaToolCalls.length > 0) {
						markFirstToken();
						endTextBlock();
						endThinkingBlock();
						for (const tc of msg.deltaToolCalls) {
							const toolCallId = tc.id || activeToolCallId;
							if (!toolCallId) continue;
							let block = toolBlocks.get(toolCallId);
							if (!block) {
								block = { type: "toolCall", id: toolCallId, name: tc.name, arguments: {} };
								output.content.push(block);
								toolBlocks.set(toolCallId, block);
								toolPartialJson.set(toolCallId, "");
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
							if (tc.name) block.name = tc.name;
							activeToolCallId = toolCallId;
							if (!tc.argumentsJson) continue;
							const previousJson = toolPartialJson.get(toolCallId) ?? "";
							const accumulated = tc.argumentsJson.startsWith(previousJson)
								? tc.argumentsJson
								: previousJson + tc.argumentsJson;
							const delta = accumulated.slice(previousJson.length);
							toolPartialJson.set(toolCallId, accumulated);
							block.arguments = parseStreamingJson(accumulated);
							stream.push({
								type: "toolcall_delta",
								contentIndex: output.content.indexOf(block),
								delta,
								partial: output,
							});
						}
					}

					if (msg.stopReason !== StopReason.UNSPECIFIED) {
						latestStopReason = msg.stopReason;
					}

					if (msg.usage) {
						output.usage.input = Number(msg.usage.inputTokens);
						output.usage.output = Number(msg.usage.outputTokens);
						output.usage.cacheRead = Number(msg.usage.cacheReadTokens);
						output.usage.cacheWrite = Number(msg.usage.cacheWriteTokens);
						output.usage.totalTokens = output.usage.input + output.usage.output;
					}
				}

				if (done) break;
			}

			endTextBlock();
			endThinkingBlock();
			for (const [id, block] of toolBlocks) {
				block.arguments = parseStreamingJson(toolPartialJson.get(id));
				stream.push({
					type: "toolcall_end",
					contentIndex: output.content.indexOf(block),
					toolCall: block,
					partial: output,
				});
			}

			const doneReason: "stop" | "length" | "toolUse" =
				toolBlocks.size > 0 ? "toolUse" : latestStopReason === StopReason.MAX_TOKENS ? "length" : "stop";
			output.stopReason = doneReason;

			calculateCost(model, output.usage);
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;

			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			logger.error("devin: stream failed", { error: String(error) });
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: result.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

async function fetchDevinAuthMetadata(
	apiKey: string,
	baseUrl: string,
	fetchImpl: NonNullable<StreamOptions["fetch"]>,
	signal: AbortSignal | undefined,
): Promise<{ userJwt: string; baseUrl?: string }> {
	const request = create(GetUserJwtRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			ideName: "windsurf",
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: "windsurf",
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
	});
	const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body: toBinary(GetUserJwtRequestSchema, request),
		signal,
	});
	const payload = new Uint8Array(await response.arrayBuffer());
	if (!response.ok) {
		throw new AIError.DevinApiError(
			`Devin auth error ${response.status} ${response.statusText}: ${new TextDecoder().decode(payload)}`,
			response.status,
		);
	}
	const decoded = decodeDevinUserJwtResponse(payload);
	if (!decoded.userJwt) {
		throw new AIError.ProviderResponseError("Devin auth error: GetUserJwt returned an empty user JWT", {
			provider: "devin",
			kind: "runtime",
		});
	}
	const customBaseUrl = decoded.customApiServerUrl.trim();
	return { userJwt: decoded.userJwt, ...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, "") } : undefined) };
}

function decodeDevinUserJwtResponse(payload: Uint8Array) {
	try {
		return fromBinary(GetUserJwtResponseSchema, payload);
	} catch {
		return fromBinary(GetUserJwtResponseSchema, gunzipSync(payload));
	}
}

/**
 * Build a {@link GetChatMessageRequest} for one Cascade turn. Auth rides inside
 * `Metadata.apiKey`; the system prompt is the flattened `prompt` string and the
 * conversation history maps to `chatMessagePrompts`.
 */
function buildDevinChatRequest(
	model: Model<"devin-agent">,
	context: Context,
	options: DevinOptions | undefined,
	apiKey: string,
	userJwt: string,
) {
	const cascadeId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
	const stopPatterns =
		options?.stopSequences && options.stopSequences.length > 0
			? [...DEVIN_DEFAULT_STOP_PATTERNS, ...options.stopSequences]
			: DEVIN_DEFAULT_STOP_PATTERNS;
	return create(GetChatMessageRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			userJwt,
			ideName: "windsurf",
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: "windsurf",
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
		prompt: (context.systemPrompt ?? []).join("\n\n"),
		chatMessagePrompts: buildChatMessagePrompts(context.messages, cascadeId),
		chatModelUid: options?.chatModelUid ?? model.requestModelId ?? model.id,
		requestType: ChatMessageRequestType.CASCADE,
		plannerMode: ConversationalPlannerMode.DEFAULT,
		toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
		systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
		disableParallelToolCalls: true,
		cascadeId,
		executionId: crypto.randomUUID(),
		configuration: create(CompletionConfigurationSchema, {
			numCompletions: 1n,
			maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? 64000),
			maxNewlines: 200n,
			temperature: options?.temperature ?? 0.4,
			firstTemperature: options?.temperature ?? 0.4,
			topK: 50n,
			topP: options?.topP ?? 1,
			stopPatterns,
			fimEotProbThreshold: 1,
		}),
		tools: (context.tools ?? []).map((tool: Tool) =>
			create(ChatToolDefinitionSchema, {
				name: tool.name,
				description: tool.description,
				jsonSchemaString: JSON.stringify(toolWireSchema(tool)),
				strict: tool.strict ?? false,
			}),
		),
	});
}

/** Map omp `Message` history onto Cascade `ChatMessagePrompt`s (USER / SYSTEM / TOOL channels). */
function buildChatMessagePrompts(messages: Message[], cascadeId: string): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];
	// messageId seeds are `cascadeId\0index\0role[...]` — prompt text is excluded
	// so ids stay stable across content edits / history rebuilds.
	for (const [index, msg] of messages.entries()) {
		if (msg.role === "user" || msg.role === "developer") {
			let promptText = "";
			const images = [];
			if (typeof msg.content === "string") {
				promptText = msg.content;
			} else {
				for (const part of msg.content) {
					if (part.type === "text") {
						promptText += part.text;
					} else if (part.type === "image") {
						images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
					}
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`),
					source: ChatMessageSource.USER,
					prompt: promptText,
					images,
				}),
			);
		} else if (msg.role === "assistant") {
			let promptText = "";
			let thinkingText = "";
			let signature = "";
			const toolCalls: ChatToolCall[] = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					promptText += part.text;
				} else if (part.type === "thinking") {
					thinkingText += part.thinking;
					if (!signature && part.thinkingSignature) signature = part.thinkingSignature;
				} else if (part.type === "toolCall") {
					toolCalls.push(
						create(ChatToolCallSchema, {
							id: part.id,
							name: part.name,
							argumentsJson: JSON.stringify(part.arguments),
						}),
					);
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: msg.responseId ?? `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
					source: ChatMessageSource.SYSTEM,
					prompt: promptText,
					thinking: thinkingText,
					signature,
					signatureType: "",
					toolCalls,
				}),
			);
		} else {
			let resultText = "";
			const images = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					resultText += part.text;
				} else if (part.type === "image") {
					images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.toolCallId}`),
					source: ChatMessageSource.TOOL,
					toolCallId: msg.toolCallId,
					toolResultIsError: msg.isError,
					prompt: resultText,
					images,
				}),
			);
		}
	}
	return prompts;
}

/**
 * Parse a Connect end-of-stream JSON trailer and return a human-readable error
 * string when it carries `{ error: { code, message } }`, else `null`. The trailer
 * is untrusted server output, so the shape is checked with guards rather than asserted.
 */
function readConnectTrailerError(text: string): string | null {
	if (text.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
	const err = parsed.error;
	if (!err || typeof err !== "object") return null;
	const code = "code" in err && typeof err.code === "string" ? err.code : "";
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	if (!code && !message) return null;
	return `Devin stream error${code ? ` ${code}` : ""}: ${message}`;
}
