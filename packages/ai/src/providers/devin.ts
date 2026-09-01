import { gunzipSync, gzipSync } from "node:zlib";

import {
	AssignModelRequestSchema,
	AssignModelResponseSchema,
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatMessageRequestType,
	ChatMessageSource,
	type ChatToolCall,
	ChatToolCallSchema,
	ChatToolChoiceSchema,
	ChatToolDefinitionSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
	type ImageData,
	ImageDataSchema,
	MetadataSchema,
	type ModelAssignment,
	PromptCacheOptionsSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { DEVIN_DEFAULT_BASE_URL, devinCliMetadata } from "@oh-my-pi/pi-catalog/wire/devin";
import { decodeDevinUnaryMessage } from "@oh-my-pi/pi-catalog/wire/devin-proto";
import { logger, parseStreamingJson, parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	DeveloperMessage,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	UserMessage,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { isDemotedThinking } from "../utils/block-symbols";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";
import { transformMessages } from "./transform-messages";

/** Base host for Codeium/Windsurf's Cascade chat API (Connect protocol over HTTP/1.1). */
export const DEVIN_API_URL = DEVIN_DEFAULT_BASE_URL;

export interface DevinOptions extends StreamOptions {
	/** Cascade conversation id; reused as `cascade_id` so the server threads turns. */
	conversationId?: string;
	/** Falls back to `cascade_id` when no `conversationId` is supplied. */
	sessionId?: string;
	/** Wire model uid selected after thinking-effort routing. */
	chatModelUid?: string;
}

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DEVIN_ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_DEFAULT_STOP_PATTERNS = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];

/** Connect streaming framing: flag byte bit 0x01 = gzip payload, 0x02 = end-of-stream JSON trailers. */
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
/**
 * Hard upper bound on a single Connect frame payload. The 4-byte length prefix
 * is otherwise attacker-controlled (up to `2**32 - 1`), so a malicious or buggy
 * peer could force {@link streamDevin}'s reader to buffer gigabytes via
 * `Buffer.concat` before the idle-timeout wrapper aborts. Well above any
 * legitimate Cascade response but tight enough that a corrupt length prefix
 * fails fast instead of consuming memory.
 */
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;
/**
 * Recovery heuristic for opaque Devin `invalid_argument` trailers. This is not
 * asserted to be the backend's hard limit: small requests can hit the same
 * intermittent error, while compactable message history this large is likely
 * to benefit from the existing context-overflow maintenance path.
 */
const LARGE_HISTORY_RECOVERY_BYTES = 512 * 1024;

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
		// Last-parsed argument-buffer length per tool-call id — bounds the
		// mid-stream parse work to O(N log N) via `parseStreamingJsonThrottled`;
		// the authoritative final parse still runs unconditionally in the
		// toolcall_end loop below.
		const toolLastParseLen = new Map<string, number>();
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
			const auth = await fetchDevinAuthMetadata(options?.apiKey, baseUrl, fetchImpl, options?.signal);
			const chatBaseUrl = auth.baseUrl ?? baseUrl;
			const turn: DevinTurn = {
				apiKey: options?.apiKey,
				userJwt: auth.userJwt,
				cascadeId: options?.conversationId ?? options?.sessionId ?? crypto.randomUUID(),
				messages: transformMessages(context.messages, model),
			};
			// Router models (`adaptive`) are not valid chat model uids: the server
			// resolves them through AssignModel and expects the returned uid plus
			// assignment JWT on the chat request that shares the cascade id.
			let assignment: ModelAssignment | undefined;
			if (model.compat.modelRouter) {
				assignment = await assignDevinModel(model, turn, chatBaseUrl, fetchImpl, options?.signal);
				output.upstreamModel = assignment.modelUid;
			}
			const request = buildDevinChatRequest(model, context, options, turn, assignment);
			const reqBytes = toBinary(GetChatMessageRequestSchema, request);
			const gz = gzipSync(reqBytes);
			logger.debug("devin: sending chat request", {
				model: model.id,
				tools: context.tools?.length ?? 0,
				requestBytes: reqBytes.byteLength,
				compressedBytes: gz.byteLength,
			});
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
					// Steady state drains fully per chunk; view the fresh reader chunk
					// instead of copying it through Buffer.concat (see aws-eventstream.ts).
					pending =
						pending.length === 0
							? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
							: Buffer.concat([pending, value]);
				}

				while (pending.length >= 5) {
					const flag = pending[0];
					const len = pending.readUInt32BE(1);
					if (len > MAX_CONNECT_FRAME_PAYLOAD) {
						throw new AIError.ProviderResponseError(
							`Devin Connect frame length ${len} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
							{ provider: model.provider, kind: "envelope" },
						);
					}
					if (pending.length < 5 + len) break;
					const payload = pending.subarray(5, 5 + len);
					pending = pending.subarray(5 + len);

					if (flag & CONNECT_END_STREAM_FLAG) {
						const trailerBytes = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
						const trailerError = readConnectTrailerError(trailerBytes.toString("utf8").trim());
						if (trailerError) {
							// #4218: these rejections carry no HTTP error body, so the raw
							// trailer is the only server-side evidence. Log it with the
							// request shape before classification discards it.
							logger.warn("devin: stream rejected via Connect trailer", {
								model: model.id,
								code: trailerError.code,
								message: trailerError.message,
								...(trailerError.detail ? { detail: trailerError.detail } : {}),
								rawTrailer: trailerError.raw,
								requestBytes: reqBytes.byteLength,
								compressedBytes: gz.byteLength,
								tools: context.tools?.length ?? 0,
								messages: context.messages.length,
								hadOutput: firstTokenTime !== undefined,
							});
							const error = new AIError.ValidationError(trailerError.formatted);
							if (
								firstTokenTime === undefined &&
								trailerError.code.toLowerCase() === "invalid_argument" &&
								/\binternal error\b/i.test(trailerError.message)
							) {
								// The full protobuf also contains the system prompt and tool
								// schemas, which history maintenance cannot shrink. Re-encode
								// only the repeated history field before choosing recovery.
								let activeTailCount = 0;
								const lastRole = context.messages.at(-1)?.role;
								if (lastRole === "user" || lastRole === "developer") {
									activeTailCount = 1;
									// A trailing developer message can accompany the current user
									// prompt. Earlier user-role records may instead be flushed
									// execution history and must remain eligible for compaction.
									if (lastRole === "developer") {
										for (let i = context.messages.length - 2; i >= 0; i--) {
											const role = context.messages[i].role;
											if (role !== "user" && role !== "developer") break;
											activeTailCount++;
										}
									}
								}
								const shrinkablePrompts =
									activeTailCount > 0
										? request.chatMessagePrompts.slice(0, -activeTailCount)
										: request.chatMessagePrompts;
								const historyBytes = toBinary(
									GetChatMessageRequestSchema,
									create(GetChatMessageRequestSchema, {
										chatMessagePrompts: shrinkablePrompts,
									}),
								).byteLength;
								if (historyBytes >= LARGE_HISTORY_RECOVERY_BYTES) {
									AIError.attach(error, AIError.create(AIError.Flag.ContextOverflow));
									logger.warn("devin: treating large-history invalid_argument as context overflow", {
										model: model.id,
										historyBytes,
										requestBytes: reqBytes.byteLength,
										compressedBytes: gz.byteLength,
									});
								}
							}
							throw error;
						}
						continue;
					}

					const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
					const msg = fromBinary(GetChatMessageResponseSchema, raw);
					if (msg.messageId && !output.responseId) output.responseId = msg.messageId;
					// The router reports the concrete model it landed on; it can differ
					// from the uid AssignModel handed back (fallbacks, capacity routing).
					if (msg.actualModelUid) output.upstreamModel = msg.actualModelUid;

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
							const throttled = parseStreamingJsonThrottled(accumulated, toolLastParseLen.get(toolCallId) ?? 0);
							if (throttled) {
								block.arguments = throttled.value;
								toolLastParseLen.set(toolCallId, throttled.parsedLen);
							}
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
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					}
					if (msg.creditCost || msg.committedCreditCost || msg.committedAcuCost) {
						output.usage.credits ??= {};
						const credits = output.usage.credits;
						if (msg.creditCost) credits.cost = msg.creditCost;
						if (msg.committedCreditCost) credits.committedCost = msg.committedCreditCost;
						if (msg.committedAcuCost) credits.acuCost = msg.committedAcuCost;
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

/** Per-turn wire state shared by `AssignModel` and `GetChatMessage`. */
interface DevinTurn {
	apiKey: string | undefined;
	userJwt: string;
	/** Cascade thread id; assignment and chat must agree on it or the JWT is rejected. */
	cascadeId: string;
	/** History already run through {@link transformMessages}, shared by both calls. */
	messages: Message[];
}

async function fetchDevinAuthMetadata(
	apiKey: string | undefined,
	baseUrl: string,
	fetchImpl: NonNullable<StreamOptions["fetch"]>,
	signal: AbortSignal | undefined,
): Promise<{ userJwt: string; baseUrl?: string }> {
	const request = create(GetUserJwtRequestSchema, { metadata: create(MetadataSchema, devinCliMetadata(apiKey)) });
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
	const decoded = decodeDevinUnaryMessage(GetUserJwtResponseSchema, payload);
	if (!decoded?.userJwt) {
		throw new AIError.ProviderResponseError("Devin auth error: GetUserJwt returned an empty user JWT", {
			provider: "devin",
			kind: "runtime",
		});
	}
	const customBaseUrl = decoded.customApiServerUrl.trim();
	return { userJwt: decoded.userJwt, ...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, "") } : undefined) };
}

/**
 * Resolve a server-side router (`adaptive`) into the concrete model uid plus the
 * assignment JWT that authorizes it. The router uid is never a legal
 * `chatModelUid`, so a failed assignment must fail the turn rather than fall
 * back to sending the router id to `GetChatMessage`.
 */
async function assignDevinModel(
	model: Model<"devin-agent">,
	turn: DevinTurn,
	baseUrl: string,
	fetchImpl: NonNullable<StreamOptions["fetch"]>,
	signal: AbortSignal | undefined,
): Promise<ModelAssignment> {
	const request = create(AssignModelRequestSchema, {
		metadata: create(MetadataSchema, devinCliMetadata(turn.apiKey)),
		modelRouterUid: model.requestModelId ?? model.id,
		cascadeId: turn.cascadeId,
		chatMessagePrompt: buildRouterPrompt(turn.messages),
	});
	const response = await fetchImpl(`${baseUrl}${DEVIN_ASSIGN_MODEL_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body: toBinary(AssignModelRequestSchema, request),
		signal,
	});
	const payload = new Uint8Array(await response.arrayBuffer());
	if (!response.ok) {
		throw new AIError.DevinApiError(
			`Devin AssignModel error ${response.status} ${response.statusText}: ${new TextDecoder().decode(payload)}`,
			response.status,
		);
	}
	const assignment = decodeDevinUnaryMessage(AssignModelResponseSchema, payload)?.assignment;
	if (!assignment?.assignmentJwt || !assignment.modelUid) {
		throw new AIError.ProviderResponseError(
			"Devin AssignModel error: response carried no assignment JWT and model uid",
			{ provider: model.provider, kind: "runtime" },
		);
	}
	logger.debug("devin: router assigned a model", {
		router: model.requestModelId ?? model.id,
		assigned: assignment.modelUid,
	});
	return assignment;
}

/**
 * The prompt the router scores: the current user/developer turn on its own.
 * Native leaves `messageId` empty here — the id for the turn is minted by the
 * chat request that follows.
 */
function buildRouterPrompt(messages: Message[]): ChatMessagePrompt | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const msg = messages[index];
		if (msg.role === "user" || msg.role === "developer") return buildUserPrompt(msg, "");
	}
	return undefined;
}

/**
 * Build a {@link GetChatMessageRequest} for one Cascade turn. Auth rides inside
 * `Metadata.apiKey`; the system prompt is the flattened `prompt` string and the
 * conversation history maps to `chatMessagePrompts`. `assignment` is present only
 * for router models and supplies both the resolved uid and its JWT.
 */
function buildDevinChatRequest(
	model: Model<"devin-agent">,
	context: Context,
	options: DevinOptions | undefined,
	turn: DevinTurn,
	assignment: ModelAssignment | undefined,
) {
	const stopPatterns =
		options?.stopSequences && options.stopSequences.length > 0
			? [...DEVIN_DEFAULT_STOP_PATTERNS, ...options.stopSequences]
			: DEVIN_DEFAULT_STOP_PATTERNS;
	return create(GetChatMessageRequestSchema, {
		metadata: create(MetadataSchema, devinCliMetadata(turn.apiKey, turn.userJwt)),
		prompt: normalizeSystemPrompts(context.systemPrompt).join("\n\n"),
		chatMessagePrompts: buildChatMessagePrompts(turn.messages, turn.cascadeId, model),
		chatModelUid: assignment?.modelUid ?? options?.chatModelUid ?? model.requestModelId ?? model.id,
		...(assignment ? { modelAssignmentJwt: assignment.assignmentJwt } : undefined),
		requestType: ChatMessageRequestType.CASCADE,
		plannerMode: ConversationalPlannerMode.DEFAULT,
		toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
		systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
		disableParallelToolCalls: !model.compat.supportsParallelToolCalls,
		cascadeId: turn.cascadeId,
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

/** Flatten one user/developer turn into a Cascade USER prompt with inline images. */
function buildUserPrompt(msg: UserMessage | DeveloperMessage, messageId: string): ChatMessagePrompt {
	let prompt = "";
	const images: ImageData[] = [];
	if (typeof msg.content === "string") {
		prompt = msg.content;
	} else {
		for (const part of msg.content) {
			if (part.type === "text") {
				prompt += part.text;
			} else if (part.type === "image") {
				images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
			}
		}
	}
	return create(ChatMessagePromptSchema, { messageId, source: ChatMessageSource.USER, prompt, images });
}

/** Map omp `Message` history onto Cascade `ChatMessagePrompt`s (USER / SYSTEM / TOOL channels). */
function buildChatMessagePrompts(
	messages: Message[],
	cascadeId: string,
	model: Model<"devin-agent">,
): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];
	// messageId seeds are `cascadeId\0index\0role[...]` — prompt text is excluded
	// so ids stay stable across content edits / history rebuilds.
	for (const [index, msg] of messages.entries()) {
		if (msg.role === "user" || msg.role === "developer") {
			prompts.push(buildUserPrompt(msg, deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`)));
		} else if (msg.role === "assistant") {
			const isNativeDevinMessage =
				msg.api === model.api && msg.provider === model.provider && msg.model === model.id;
			let promptText = "";
			let thinkingText = "";
			let signature = "";
			const toolCalls: ChatToolCall[] = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					promptText += `${part.text}${isDemotedThinking(part) ? "\n" : ""}`;
				} else if (part.type === "thinking") {
					thinkingText += part.thinking;
					if (isNativeDevinMessage && !signature && part.thinkingSignature) signature = part.thinkingSignature;
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
			if (!promptText && !thinkingText && !signature && toolCalls.length === 0) continue;
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId:
						isNativeDevinMessage && msg.responseId
							? msg.responseId
							: `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
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

interface ConnectTrailerError {
	code: string;
	message: string;
	formatted: string;
	/** Summarized Connect error details entries, when the trailer carried any. */
	detail?: string;
	/** Raw trailer JSON (truncated) retained for evidence logging; see #4218. */
	raw: string;
}

/**
 * Parse a Connect end-of-stream JSON trailer and return its structured error
 * when it carries `{ error: { code, message } }`, else `null`. The trailer is
 * untrusted server output, so the shape is checked with guards rather than asserted.
 */
function readConnectTrailerError(text: string): ConnectTrailerError | null {
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
	const trailer: ConnectTrailerError = {
		code,
		message,
		formatted: `Devin stream error${code ? ` ${code}` : ""}: ${message}`,
		raw: truncateTrailerEvidence(text),
	};
	const detail = "details" in err ? summarizeTrailerDetails(err.details) : undefined;
	if (detail) {
		trailer.detail = detail;
		trailer.formatted += ` [details: ${detail}]`;
	}
	return trailer;
}

/** Upper bound on retained raw-trailer evidence so log entries stay bounded. */
const MAX_TRAILER_EVIDENCE_CHARS = 2000;

function truncateTrailerEvidence(text: string): string {
	return text.length > MAX_TRAILER_EVIDENCE_CHARS ? `${text.slice(0, MAX_TRAILER_EVIDENCE_CHARS)}…` : text;
}

/**
 * Summarize Connect error `details` entries (loosely `{ type, value, debug }`
 * records). #4218's intermittent `invalid_argument` rejections arrive as
 * end-of-stream trailers with no HTTP error body, so any detail payload here
 * is the only server-side evidence available; previously it was discarded.
 */
function summarizeTrailerDetails(details: unknown): string | undefined {
	if (!Array.isArray(details) || details.length === 0) return undefined;
	let summary = "";
	for (const entry of details) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const type = typeof record.type === "string" && record.type ? record.type : undefined;
		const value = typeof record.value === "string" && record.value ? record.value : undefined;
		let debug: string | undefined;
		if (record.debug !== undefined) {
			try {
				debug = typeof record.debug === "string" ? record.debug : JSON.stringify(record.debug);
			} catch {
				debug = undefined;
			}
		}
		const boundedType = type ? truncateTrailerEvidence(type) : undefined;
		const evidence = debug ?? value;
		const boundedEvidence = evidence ? truncateTrailerEvidence(evidence) : undefined;
		let part: string | undefined;
		if (boundedType && boundedEvidence) part = `${boundedType}: ${boundedEvidence}`;
		else part = boundedType ?? boundedEvidence;
		if (!part) continue;
		const next = summary ? `${summary}; ${part}` : part;
		if (next.length > MAX_TRAILER_EVIDENCE_CHARS) return truncateTrailerEvidence(next);
		summary = next;
	}
	return summary || undefined;
}
