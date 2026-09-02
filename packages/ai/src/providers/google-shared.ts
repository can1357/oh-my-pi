/**
 * Shared utilities for Google Generative AI and Google Cloud Code Assist providers.
 */

import { scheduler } from "node:timers/promises";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { readSseJson } from "@oh-my-pi/pi-utils";
import { renderDemotedThinking } from "../dialect/demotion";
import { ThinkingFenceStripper } from "../dialect/thinking-fence-strip";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	ImageContent,
	Model,
	ServiceTier,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";
import { shouldSendServiceTier } from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import { normalizeSchemaForCCA, normalizeSchemaForGoogle, toolWireSchema } from "../utils/schema";
import type {
	Content,
	FinishReason,
	FunctionCallingConfigMode,
	GenerateContentConfig,
	GenerateContentParameters,
	GenerateContentResponse,
	Part,
	ThinkingConfig,
	ThinkingLevel,
} from "./google-types";
import { transformMessages } from "./transform-messages";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export type {
	Content,
	FunctionCallingConfigMode,
	GenerateContentParameters,
	GenerateContentResponse,
	ThinkingConfig,
} from "./google-types";
export { normalizeSchemaForGoogle };

type GoogleApiType = "google-generative-ai" | "google-gemini-cli" | "google-vertex";

function convertGoogleImagePart(image: ImageContent): Part {
	if (image.providerFile?.provider === "google" && image.providerFile.uri) {
		return { fileData: { fileUri: image.providerFile.uri, mimeType: image.mimeType } };
	}
	return image.url
		? { fileData: { fileUri: image.url, mimeType: image.mimeType } }
		: { inlineData: { mimeType: image.mimeType, data: image.data } };
}

/**
 * Thinking level for Gemini 3 models. Mirrors Google's `ThinkingLevel` enum values.
 * Defined here (not in any specific provider) so all Google providers can reference it
 * without inducing a circular dependency.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Sampling/thinking options shared by `streamGoogle` and `streamGoogleVertex`.
 * `google-gemini-cli` uses a different transport and request shape — do not extend this for it.
 */
export interface GoogleSharedStreamOptions extends StreamOptions {
	/**
	 * Tool selection mode. String forms map directly to Gemini
	 * `FunctionCallingConfigMode`. The object form forces a single named tool
	 * — `mode: "ANY"` is wire-required when `allowedFunctionNames` is set.
	 */
	toolChoice?: "auto" | "none" | "any" | { mode: "ANY"; allowedFunctionNames: [string, ...string[]] };
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleThinkingLevel;
	};
	/** Request that Google omit human-readable thought summaries while still allowing internal reasoning. */
	hideThinkingSummary?: boolean;
	/** Gemini/Vertex serving tier (`flex`/`priority`); other values are omitted. */
	serviceTier?: ServiceTier;
	/**
	 * Caller-owned Google context-cache resource name for GenerateContent.
	 * Passed through opaquely as the wire `cachedContent` field on
	 * `google-generative-ai` and `google-vertex` only. OMP does not create,
	 * refresh, validate model/project/location compatibility, or delete the
	 * resource — callers own that lifecycle.
	 *
	 * @see https://ai.google.dev/api/generate-content
	 * @see `@google/genai` `GenerateContentConfig.cachedContent`
	 */
	cachedContent?: string;
}

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const emittedToolCallNames = new Map<string, string>();

	const normalizeToolCallId = (id: string): string => {
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	// Gemini < 3 image tool results go in a separate user turn, but parallel tool results must
	// stay a single contiguous functionResponse turn ("number of function response parts is not
	// equal to number of function call parts"). Buffer image turns and flush them only after the
	// merged functionResponse turn is complete.
	let pendingToolImageParts: Part[] = [];
	const flushPendingToolImages = () => {
		if (pendingToolImageParts.length === 0) return;
		contents.push({ role: "user", parts: pendingToolImageParts });
		pendingToolImageParts = [];
	};

	for (const msg of transformedMessages) {
		if (msg.role !== "toolResult") flushPendingToolImages();
		if (msg.role === "user" || msg.role === "developer") {
			if (typeof msg.content === "string") {
				// Skip empty user messages
				if (!msg.content || msg.content.trim() === "") continue;
				contents.push({
					role: "user",
					parts: [{ text: msg.content.toWellFormed() }],
				});
			} else {
				const supportsImages = model.input.includes("image");
				const parts: Part[] = [];
				let omittedImages = false;
				for (const item of msg.content) {
					if (item.type === "text") {
						const text = item.text.toWellFormed();
						if (text.trim().length === 0) continue;
						parts.push({ text });
					} else if (supportsImages) {
						parts.push(convertGoogleImagePart(item));
					} else {
						omittedImages = true;
					}
				}
				if (omittedImages) {
					parts.push({ text: NON_VISION_IMAGE_PLACEHOLDER });
				}
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
			const dropsUnsignedThinking = model.compat.dropUnsignedThinking;

			for (const block of msg.content) {
				if (block.type === "text") {
					// Skip empty text blocks - they can cause issues with some models (e.g. Claude via Antigravity)
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: block.text.toWellFormed(),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Skip empty thinking blocks
					if (!block.thinking || block.thinking.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
					if (dropsUnsignedThinking && !thoughtSignature) continue;
					if (thoughtSignature) {
						parts.push({
							thought: true,
							text: block.thinking.toWellFormed(),
							thoughtSignature,
						});
					} else {
						parts.push({
							text: renderDemotedThinking(model.id, block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					emittedToolCallNames.set(block.id, block.name);
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const effectiveSignature =
						thoughtSignature || (model.compat.requiresSkipThoughtSignature ? SKIP_THOUGHT_SIGNATURE : undefined);

					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(model.compat.supportsFunctionPartId ? { id: block.id } : {}),
						},
					};
					if (effectiveSignature) {
						part.thoughtSignature = effectiveSignature;
					}
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const supportsImages = model.input.includes("image");
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map(c => c.text).join("\n");
			const imageContent = supportsImages ? msg.content.filter((c): c is ImageContent => c.type === "image") : [];
			const omittedImages = !supportsImages && msg.content.some((c): c is ImageContent => c.type === "image");

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Antigravity also accept this shape. Gemini < 3 still needs a separate user image turn.
			const modelSupportsMultimodalFunctionResponse = model.compat.multimodalFunctionResponse;

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = omittedImages
				? [hasText ? textResult.toWellFormed() : "", NON_VISION_IMAGE_PLACEHOLDER].filter(Boolean).join("\n")
				: hasText
					? textResult.toWellFormed()
					: hasImages
						? "(see attached image)"
						: "";

			const imageParts = imageContent.map(convertGoogleImagePart);

			const includeId = model.compat.supportsFunctionPartId;
			const emittedName = emittedToolCallNames.get(msg.toolCallId);
			const functionResponsePart: Part = {
				functionResponse: {
					name: emittedName ?? msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some(p => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, buffer images for a separate user message after the functionResponse turn
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				pendingToolImageParts.push({ text: "Tool result image:" }, ...imageParts);
			}
		}
	}
	flushPendingToolImages();

	return contents;
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * We prefer `parametersJsonSchema` (full JSON Schema: anyOf/oneOf/const/etc.).
 *
 * Claude models via Cloud Code Assist require the legacy `parameters` field; the API
 * translates it into Anthropic's `input_schema`. When using that path, we sanitize the
 * schema to remove Google-unsupported JSON Schema keywords.
 */
export function convertTools(
	tools: Tool[],
	model: Model<"google-generative-ai" | "google-gemini-cli" | "google-vertex">,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;

	/**
	 * Claude models on Cloud Code Assist need the legacy `parameters` field;
	 * the API translates it into Anthropic's `input_schema`.
	 */
	const useParameters = model.compat.ccaLegacyParametersSchema;

	return [
		{
			functionDeclarations: tools.map(tool => ({
				name: tool.name,
				description: tool.description || "",
				...(useParameters
					? { parameters: normalizeSchemaForCCA(toolWireSchema(tool)) }
					: { parametersJsonSchema: normalizeSchemaForGoogle(toolWireSchema(tool)) }),
			})),
		},
	];
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return "AUTO";
		case "none":
			return "NONE";
		case "any":
			return "ANY";
		default:
			return "AUTO";
	}
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "SAFETY":
		case "IMAGE_SAFETY":
		case "IMAGE_PROHIBITED_CONTENT":
		case "IMAGE_RECITATION":
		case "IMAGE_OTHER":
		case "RECITATION":
		case "FINISH_REASON_UNSPECIFIED":
		case "OTHER":
		case "LANGUAGE":
		case "MALFORMED_FUNCTION_CALL":
		case "UNEXPECTED_TOOL_CALL":
		case "NO_IMAGE":
			return "error";
		default: {
			throw new AIError.ConfigurationError(`Unhandled stop reason: ${reason satisfies never}`);
		}
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

/**
 * Bounded retries for the well-known Gemini "empty response" failure: a benign
 * `finishReason: STOP` carrying only an empty/whitespace text part and no tool call.
 * Shared by the public/Vertex `streamGoogleGenAI` path and the Cloud Code Assist
 * (`google-gemini-cli`/`google-antigravity`) provider so both apply the same policy.
 */
export const MAX_EMPTY_STREAM_RETRIES = 2;
export const EMPTY_STREAM_BASE_DELAY_MS = 500;

/**
 * Whether a completed Google assistant message carries content worth delivering.
 *
 * A tool call or any non-whitespace text counts as meaningful. An empty/whitespace-only
 * text part — or thinking that never produced an answer — is the "empty response" failure:
 * delivered as-is the agent loop has nothing to act on and silently halts, so the request
 * must be retried instead of surfaced.
 */
export function hasMeaningfulGoogleContent(output: AssistantMessage): boolean {
	for (const block of output.content) {
		if (block.type === "toolCall") return true;
		if (block.type === "text" && block.text.trim().length > 0) return true;
	}
	return false;
}

/** Wipe a streamed message between empty-response retries so the next attempt starts clean. */
function resetGoogleStreamOutputForRetry(output: AssistantMessage): void {
	output.content = [];
	output.usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	output.stopReason = "stop";
	output.errorMessage = undefined;
	output.timestamp = Date.now();
}

/**
 * Module-local counter for generating unique tool call IDs across Google providers.
 * Shared so that a single monotonically-increasing sequence is used regardless of which
 * Google API surface produced the stream — purely for uniqueness, not ordering semantics.
 */
let toolCallCounter = 0;

export function nextToolCallId(name: string): string {
	return `${name}_${Date.now()}_${++toolCallCounter}`;
}

/**
 * Push the appropriate `text_end` / `thinking_end` event for the given block.
 * Shared between the SDK-backed stream consumer and the gemini-cli SSE consumer so
 * the end-of-block event shape stays in lockstep.
 */
export function pushBlockEndEvent(
	block: TextContent | ThinkingContent,
	contentIndex: number,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	if (block.type === "text") {
		stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
	} else {
		stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
	}
}

/**
 * Push the three lifecycle events (`toolcall_start` / `toolcall_delta` / `toolcall_end`) for a
 * fully-assembled `ToolCall`. Caller is responsible for appending the toolCall to `output.content`
 * before invoking — this helper does not mutate `output.content`.
 */
export function pushToolCallEvents(
	toolCall: ToolCall,
	contentIndex: number,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({
		type: "toolcall_delta",
		contentIndex,
		delta: JSON.stringify(toolCall.arguments),
		partial: output,
	});
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

/**
 * Append a new text- or thinking-block to `output.content` and push the matching
 * `text_start` / `thinking_start` event. `onBeforeStartEvent` lets the SSE consumer
 * inject its `ensureStarted()` first-token side effect into the canonical event order.
 */
export function startTextOrThinkingBlock(
	isThinking: true,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onBeforeStartEvent?: () => void,
): ThinkingContent;
export function startTextOrThinkingBlock(
	isThinking: false,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onBeforeStartEvent?: () => void,
): TextContent;
export function startTextOrThinkingBlock(
	isThinking: boolean,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onBeforeStartEvent?: () => void,
): TextContent | ThinkingContent;
export function startTextOrThinkingBlock(
	isThinking: boolean,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onBeforeStartEvent?: () => void,
): TextContent | ThinkingContent {
	const block: TextContent | ThinkingContent = isThinking
		? { type: "thinking", thinking: "", thinkingSignature: undefined }
		: { type: "text", text: "" };
	output.content.push(block);
	onBeforeStartEvent?.();
	const contentIndex = output.content.length - 1;
	if (isThinking) {
		stream.push({ type: "thinking_start", contentIndex, partial: output });
	} else {
		stream.push({ type: "text_start", contentIndex, partial: output });
	}
	return block;
}

/**
 * Drives the chunked `generateContentStream` iterator into an `AssistantMessage` and
 * the corresponding `AssistantMessageEventStream`. Shared between `streamGoogle` and
 * `streamGoogleVertex` — every observable event order and stop-reason rule is preserved.
 *
 * The caller still owns: `output` construction, timing fields (`duration`/`ttft`),
 * `rawRequestDump`, the `client.models.generateContentStream(params)` call itself,
 * pushing `start`/`done`/`error` events, and the surrounding try/catch that translates
 * thrown errors into `output.stopReason`/`errorMessage`.
 *
 * This helper handles: the chunk loop, currentBlock flush transitions, usage metadata
 * decoding (`calculateCost` included), tool-call id collision avoidance, finish-reason
 * mapping, and the abort/stop-reason post-checks that re-throw to bubble into the
 * caller's catch.
 */
export async function consumeGoogleStream<T extends GoogleApiType>(args: {
	googleStream: AsyncIterable<GenerateContentResponse>;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	model: Model<T>;
	options: { signal?: AbortSignal } | undefined;
	/** Vertex preserves `textSignature` on streamed text deltas; google-generative-ai does not. */
	retainTextSignature?: boolean;
	onFirstToken?: () => void;
}): Promise<void> {
	const { googleStream, output, stream, model, options, retainTextSignature, onFirstToken } = args;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	let currentBlock: TextContent | ThinkingContent | null = null;
	// Heals a leaked reasoning-fence opener (```thinking / ``````thinking) that some
	// Gemini thought summaries emit as a between-summary delimiter (#8719). One
	// stripper per thinking block; created lazily on first thinking delta.
	let thinkingStripper: ThinkingFenceStripper | null = null;
	let firstTokenSeen = false;
	let sawFinishReason = false;

	const flushCurrent = () => {
		if (!currentBlock) return;
		if (currentBlock.type === "thinking" && thinkingStripper) {
			const tail = thinkingStripper.flush();
			if (tail) {
				currentBlock.thinking += tail;
				stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta: tail, partial: output });
			}
		}
		thinkingStripper = null;
		pushBlockEndEvent(currentBlock, blockIndex(), output, stream);
	};

	for await (const chunk of googleStream) {
		if (chunk.error) {
			const detail = chunk.error.message || chunk.error.status || "unknown error";
			const message = `Google API stream error: ${detail}`;
			throw typeof chunk.error.code === "number" && chunk.error.code >= 400
				? new AIError.GoogleApiError(message, chunk.error.code)
				: new AIError.ProviderResponseError(message, { provider: model.provider, kind: "output" });
		}
		if (!chunk.candidates?.length && chunk.promptFeedback?.blockReason) {
			const detail = chunk.promptFeedback.blockReasonMessage;
			throw new AIError.ProviderResponseError(
				`Request blocked by Google (${chunk.promptFeedback.blockReason})${detail ? `: ${detail}` : ""}`,
				{ provider: model.provider, kind: "content-blocked" },
			);
		}
		const candidate = chunk.candidates?.[0];
		if (candidate?.content?.parts) {
			for (const part of candidate.content.parts) {
				if (part.text !== undefined && part.text !== "") {
					if (!firstTokenSeen) {
						firstTokenSeen = true;
						onFirstToken?.();
					}
					const isThinking = isThinkingPart(part);
					if (
						!currentBlock ||
						(isThinking && currentBlock.type !== "thinking") ||
						(!isThinking && currentBlock.type !== "text")
					) {
						flushCurrent();
						currentBlock = startTextOrThinkingBlock(isThinking, output, stream);
					}
					if (currentBlock.type === "thinking") {
						thinkingStripper ??= new ThinkingFenceStripper();
						const cleaned = thinkingStripper.push(part.text);
						currentBlock.thinking += cleaned;
						currentBlock.thinkingSignature = retainThoughtSignature(
							currentBlock.thinkingSignature,
							part.thoughtSignature,
						);
						if (cleaned) {
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: cleaned,
								partial: output,
							});
						}
					} else {
						currentBlock.text += part.text;
						if (retainTextSignature) {
							currentBlock.textSignature = retainThoughtSignature(
								currentBlock.textSignature,
								part.thoughtSignature,
							);
						}
						stream.push({
							type: "text_delta",
							contentIndex: blockIndex(),
							delta: part.text,
							partial: output,
						});
					}
				} else if (part.text === "" && part.thoughtSignature && currentBlock && !part.functionCall) {
					if (currentBlock.type === "thinking") {
						currentBlock.thinkingSignature = retainThoughtSignature(
							currentBlock.thinkingSignature,
							part.thoughtSignature,
						);
					} else if (retainTextSignature) {
						currentBlock.textSignature = retainThoughtSignature(
							currentBlock.textSignature,
							part.thoughtSignature,
						);
					}
				}

				if (part.functionCall) {
					if (currentBlock) {
						flushCurrent();
						currentBlock = null;
					}

					// Generate unique ID if not provided or if it's a duplicate
					const providedId = part.functionCall.id;
					const needsNewId = !providedId || output.content.some(b => b.type === "toolCall" && b.id === providedId);
					const toolCallId = needsNewId ? nextToolCallId(part.functionCall.name || "tool") : providedId;

					const toolCall: ToolCall = {
						type: "toolCall",
						id: toolCallId,
						name: part.functionCall.name || "",
						arguments: (part.functionCall.args ?? {}) as Record<string, any>,
						...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
					};

					output.content.push(toolCall);
					pushToolCallEvents(toolCall, blockIndex(), output, stream);
				}
			}
		}

		if (candidate?.finishReason) {
			sawFinishReason = true;
			const mapped = mapStopReason(candidate.finishReason);
			// Only let a trailing tool call upgrade benign finishes; SAFETY/MALFORMED_FUNCTION_CALL
			// and friends must surface as errors even when earlier chunks carried valid tool calls.
			if ((mapped === "stop" || mapped === "length") && output.content.some(b => b.type === "toolCall")) {
				output.stopReason = "toolUse";
			} else {
				output.stopReason = mapped;
				if (mapped === "error") {
					output.errorMessage = `Generation failed with finish reason: ${candidate.finishReason}`;
				}
			}
		}

		if (chunk.usageMetadata) {
			// promptTokenCount includes cachedContentTokenCount when cached content is used.
			// Subtract to get non-cached input, matching the OpenAI convention where
			// input = uncached prompt tokens and cacheRead = cached tokens so that
			// input + cacheRead = total prompt tokens (no double-counting).
			// Ref: https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse.UsageMetadata
			const cachedTokens = chunk.usageMetadata.cachedContentTokenCount || 0;
			const thinkingTokens = chunk.usageMetadata.thoughtsTokenCount || 0;
			output.usage = {
				input: (chunk.usageMetadata.promptTokenCount || 0) - cachedTokens,
				output: (chunk.usageMetadata.candidatesTokenCount || 0) + thinkingTokens,
				cacheRead: cachedTokens,
				cacheWrite: 0,
				totalTokens: chunk.usageMetadata.totalTokenCount || 0,
				...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			};
			calculateCost(model, output.usage);
		}
	}

	flushCurrent();

	if (options?.signal?.aborted) {
		throw new AIError.AbortError();
	}

	if (!sawFinishReason) {
		throw new AIError.ProviderResponseError(
			"Google API stream ended without a finish reason (connection dropped or response truncated)",
			{ provider: model.provider, kind: "incomplete-stream" },
		);
	}

	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
			provider: model.provider,
			kind: "output",
		});
	}
}

/**
 * Generation/sampling fields that map directly onto Gemini's `GenerateContentConfig`.
 * Excludes any provider-specific extensions (`topP`/`topK`/etc are all forwarded as-is).
 */
interface GoogleGenerationConfig extends GenerateContentConfig {
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
}

/**
 * Build the `GenerateContentParameters` payload for the public Gemini API and Vertex AI.
 * Both surfaces accept the same `GenerateContentConfig` shape — every numeric/string knob,
 * tool-config, thinking-config, and system-instruction conversion is identical.
 *
 * `google-gemini-cli` is NOT routed through here: its `CloudCodeAssistRequest` body has a
 * distinct top-level shape (project/request/requestType) and a different thinking-config
 * placement on `generationConfig`.
 */
export function buildGoogleGenerateContentParams<T extends "google-generative-ai" | "google-vertex">(
	model: Model<T>,
	context: Context,
	options: GoogleSharedStreamOptions,
): GenerateContentParameters {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const contents = convertMessages(model, context);

	const generationConfig: GoogleGenerationConfig = {};
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
	if (options.topP !== undefined) generationConfig.topP = options.topP;
	if (options.topK !== undefined) generationConfig.topK = options.topK;
	if (options.minP !== undefined) generationConfig.minP = options.minP;
	if (options.presencePenalty !== undefined) generationConfig.presencePenalty = options.presencePenalty;
	if (options.repetitionPenalty !== undefined) generationConfig.repetitionPenalty = options.repetitionPenalty;

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(systemPrompts.length > 0 && { systemInstruction: { parts: systemPrompts.map(text => ({ text })) } }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools, model) }),
	};

	// Gemini API (google-generative-ai) reads the tier from the request body;
	// Vertex AI ignores a body field and requires the
	// `X-Vertex-AI-LLM-Shared-Request-Type` header instead (added in
	// streamGoogleVertex), so only emit the body field for the direct API.
	if (model.provider === "google" && shouldSendServiceTier(options.serviceTier, model.provider)) {
		config.serviceTier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		const choice = options.toolChoice;
		if (typeof choice === "string") {
			const mode = mapToolChoice(choice);
			if (mode !== "AUTO") {
				config.toolConfig = {
					functionCallingConfig: { mode },
				};
			}
		} else {
			// Named-tool routing — `mode: "ANY"` plus an explicit allow-list. The
			// caller is responsible for ensuring the names exist in `context.tools`.
			config.toolConfig = {
				functionCallingConfig: {
					mode: "ANY",
					allowedFunctionNames: [...choice.allowedFunctionNames],
				},
			};
		}
	} else {
		config.toolConfig = undefined;
	}

	const thinking = options.thinking;
	if (
		thinking &&
		model.reasoning &&
		(thinking.enabled || thinking.level !== undefined || thinking.budgetTokens !== undefined)
	) {
		const cfg: ThinkingConfig = { includeThoughts: thinking.enabled && !options.hideThinkingSummary };
		if (thinking.level !== undefined) {
			// GoogleThinkingLevel mirrors the SDK's ThinkingLevel string enum values 1:1.
			cfg.thinkingLevel = thinking.level as ThinkingLevel;
		} else if (thinking.budgetTokens !== undefined) {
			cfg.thinkingBudget = thinking.budgetTokens;
		}
		config.thinkingConfig = cfg;
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new AIError.AbortError("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	if (options.cachedContent !== undefined) {
		// Blank names are never valid resource references; anything else stays
		// opaque so we do not invent format/model/project checks here.
		if (options.cachedContent.trim().length === 0) {
			throw new AIError.ValidationError("cachedContent must not be blank");
		}
		const incompatibleFields = [
			config.systemInstruction !== undefined && "systemInstruction",
			config.tools !== undefined && "tools",
			config.toolConfig !== undefined && "toolConfig",
		].filter((field): field is string => Boolean(field));
		if (incompatibleFields.length > 0) {
			throw new AIError.ValidationError(
				`cachedContent cannot be combined with request-level ${incompatibleFields.join(", ")}`,
			);
		}
		config.cachedContent = options.cachedContent;
	}

	return {
		model: model.id,
		contents,
		config,
	};
}

/**
 * Drive the `streamGoogle` / `streamGoogleVertex` event flow: build the assistant message,
 * push start/done/error events, run `consumeGoogleStream`, and translate thrown errors into
 * the canonical `error` event shape.
 *
 * Caller-supplied `prepare()` runs inside the try-block so any failure (missing project,
 * bad auth, etc.) is funneled through the same error path as a streaming failure.
 */
export interface GoogleGenAIRequestPlan {
	params: GenerateContentParameters;
	url: string;
	headers: Record<string, string>;
	fetch?: FetchImpl;
	/** Optional URL retried once when {@link url} returns 404 (regional Vertex endpoint missing a global-only model). */
	fallbackUrl?: string;
}

export function streamGoogleGenAI<T extends "google-generative-ai" | "google-vertex">(args: {
	model: Model<T>;
	options: GoogleSharedStreamOptions | undefined;
	api: T;
	retainTextSignature?: boolean;
	prepare: () => GoogleGenAIRequestPlan | Promise<GoogleGenAIRequestPlan>;
}): AssistantMessageEventStream {
	const { model, options, api, retainTextSignature, prepare } = args;
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: api as Api,
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
		let rawRequestDump: RawHttpRequestDump | undefined;

		try {
			const plan = await prepare();
			let params = plan.params;
			const replacement = await options?.onPayload?.(params, model);
			if (replacement !== undefined) {
				params = replacement as GenerateContentParameters;
			}
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: plan.url,
				body: params,
				headers: plan.headers,
			};

			const bodyJson = JSON.stringify(paramsToWireBody(params));
			const fetchImpl = plan.fetch ?? options?.fetch ?? (globalThis.fetch.bind(globalThis) as FetchImpl);
			const openStreamAt = async (requestUrl: string): Promise<ReadableStream<Uint8Array>> => {
				const response = await fetchImpl(requestUrl, {
					method: "POST",
					headers: { ...plan.headers, "Content-Type": "application/json", Accept: "text/event-stream" },
					body: bodyJson,
					signal: options?.signal,
				});
				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					throw new AIError.GoogleApiError(
						`Google API error (${response.status}): ${extractGoogleErrorMessage(errorText)}`,
						response.status,
						{ headers: response.headers },
					);
				}
				if (!response.body) {
					throw new AIError.ProviderResponseError("Google API returned an empty response body", {
						provider: model.provider,
						kind: "empty-body",
					});
				}
				return response.body as ReadableStream<Uint8Array>;
			};
			// A regional Vertex endpoint 404s for models published only on the
			// global endpoint; retry global once so a stale/ambient region never
			// breaks a request that worked before regional routing existed.
			const openStream = async (): Promise<ReadableStream<Uint8Array>> => {
				if (!plan.fallbackUrl) return openStreamAt(plan.url);
				try {
					return await openStreamAt(plan.url);
				} catch (error) {
					if (error instanceof AIError.GoogleApiError && error.status === 404) {
						return openStreamAt(plan.fallbackUrl);
					}
					throw error;
				}
			};

			let body = await openStream();
			stream.push({ type: "start", partial: output });

			// Gemini occasionally finishes with `finishReason: STOP` while emitting only an empty
			// text part and no tool call. Delivered as-is the agent receives a blank message and
			// silently halts mid-task, so retry a bounded number of times before giving up.
			for (let emptyAttempt = 0; ; emptyAttempt++) {
				const googleStream = readSseJson<GenerateContentResponse>(body, options?.signal, event =>
					options?.onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, model),
				);
				await consumeGoogleStream({
					googleStream,
					output,
					stream,
					model,
					options,
					retainTextSignature,
					onFirstToken: () => {
						firstTokenTime = performance.now();
					},
				});

				if (
					output.stopReason !== "stop" ||
					hasMeaningfulGoogleContent(output) ||
					options?.acceptEmptyResponse === true
				) {
					break;
				}
				if (emptyAttempt >= MAX_EMPTY_STREAM_RETRIES) {
					throw new AIError.ProviderResponseError(
						`Google API returned an empty response (finishReason STOP with no content) after ${MAX_EMPTY_STREAM_RETRIES + 1} attempts`,
						{ provider: model.provider, kind: "empty-body" },
					);
				}
				try {
					await scheduler.wait(EMPTY_STREAM_BASE_DELAY_MS * 2 ** emptyAttempt, { signal: options?.signal });
				} catch {
					throw new AIError.AbortError();
				}
				resetGoogleStreamOutputForRetry(output);
				body = await openStream();
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason as "length" | "stop" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal, rawRequestDump });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

/**
 * Lift the SDK's `params.config` fields out of `config` and place them where the
 * Gemini / Vertex AI REST API expects them on the request body. Mirrors the
 * generateContentParametersTo{Mldev,Vertex} transformation in @google/genai
 * for the subset of fields this codebase actually sets.
 *
 * `abortSignal` is intentionally dropped — the SDK propagates it via `fetch.signal`,
 * which our caller already wires up through `options.signal`.
 */
function paramsToWireBody(params: GenerateContentParameters): Record<string, unknown> {
	const body: Record<string, unknown> = { contents: params.contents };
	const config = params.config;
	if (!config) return body;

	if (config.systemInstruction !== undefined) body.systemInstruction = config.systemInstruction;
	if (config.tools !== undefined) body.tools = config.tools;
	if (config.toolConfig !== undefined) body.toolConfig = config.toolConfig;
	if (config.safetySettings !== undefined) body.safetySettings = config.safetySettings;
	if (config.cachedContent !== undefined) body.cachedContent = config.cachedContent;
	if (config.serviceTier !== undefined) body.serviceTier = config.serviceTier;

	const gen: Record<string, unknown> = {};
	if (config.temperature !== undefined) gen.temperature = config.temperature;
	if (config.maxOutputTokens !== undefined) gen.maxOutputTokens = config.maxOutputTokens;
	if (config.topP !== undefined) gen.topP = config.topP;
	if (config.topK !== undefined) gen.topK = config.topK;
	if (config.candidateCount !== undefined) gen.candidateCount = config.candidateCount;
	if (config.stopSequences !== undefined) gen.stopSequences = config.stopSequences;
	if (config.presencePenalty !== undefined) gen.presencePenalty = config.presencePenalty;
	if (config.frequencyPenalty !== undefined) gen.frequencyPenalty = config.frequencyPenalty;
	if (config.seed !== undefined) gen.seed = config.seed;
	if (config.responseMimeType !== undefined) gen.responseMimeType = config.responseMimeType;
	if (config.responseSchema !== undefined) gen.responseSchema = config.responseSchema;
	if (config.responseJsonSchema !== undefined) gen.responseJsonSchema = config.responseJsonSchema;
	if (config.responseModalities !== undefined) gen.responseModalities = config.responseModalities;
	if (config.thinkingConfig !== undefined) gen.thinkingConfig = config.thinkingConfig;
	const generationConfig = config as unknown as { minP?: number; repetitionPenalty?: number };
	if (generationConfig.minP !== undefined) gen.minP = generationConfig.minP;
	if (generationConfig.repetitionPenalty !== undefined) gen.repetitionPenalty = generationConfig.repetitionPenalty;
	if (Object.keys(gen).length > 0) body.generationConfig = gen;
	return body;
}

function extractGoogleErrorMessage(errorText: string): string {
	if (!errorText) return "Unknown error";
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) return parsed.error.message;
	} catch {
		// fall through to raw text
	}
	return errorText;
}
