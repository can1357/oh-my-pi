/**
 * Google Gemini CLI / Antigravity provider.
 * Shared implementation for both google-gemini-cli and google-antigravity providers.
 * Uses the Cloud Code Assist API endpoint to access Gemini and Claude models.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { scheduler } from "node:timers/promises";
import { calculateCost } from "@pk-nerdsaver-ai/pi-catalog/models";
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	getAntigravityModelWireProfile,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
} from "@pk-nerdsaver-ai/pi-catalog/wire/gemini-headers";
import { extractHttpStatusFromError, fetchWithRetry, readSseJson } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderSessionState,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../utils/google-validation";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import { armPreResponseTimeout, getStreamFirstEventTimeoutMs } from "../utils/idle-iterator";
// Refresh is the sole responsibility of AuthStorage (broker-aware, single-flighted);
// the stream provider trusts the access token threaded through `options.apiKey`.
import { normalizeSchemaForCCA } from "../utils/schema";
import type { Content, FunctionCallingConfigMode, ThinkingConfig } from "./google-shared";
import {
	convertMessages,
	convertTools,
	EMPTY_STREAM_BASE_DELAY_MS,
	type GoogleThinkingLevel,
	hasMeaningfulGoogleContent,
	isThinkingPart,
	MAX_EMPTY_STREAM_RETRIES,
	mapStopReasonString,
	mapToolChoice,
	nextToolCallId,
	pushBlockEndEvent,
	pushToolCallEvents,
	retainThoughtSignature,
	startTextOrThinkingBlock,
} from "./google-shared";

/**
 * Thinking level for Gemini 3 models. Re-exported from `google-shared` so existing
 * `import { GoogleThinkingLevel } from "./google-gemini-cli"` callers keep working.
 */
export type { GoogleThinkingLevel };

function isPlanningLeakPrefix(text: string): boolean {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{")) {
		return false;
	}
	const afterBrace = trimmed.slice(1).trimStart();
	if (afterBrace === "") {
		return trimmed.length <= 100;
	}
	if (afterBrace[0] !== '"') {
		return false;
	}
	const nextQuoteIndex = afterBrace.indexOf('"', 1);
	if (nextQuoteIndex === -1) {
		const keyPrefix = afterBrace.slice(1);
		return "thought".startsWith(keyPrefix) && trimmed.length <= 100;
	}
	const key = afterBrace.slice(1, nextQuoteIndex);
	if (key !== "thought") {
		return false;
	}
	const afterKey = afterBrace.slice(nextQuoteIndex + 1).trimStart();
	if (afterKey === "") {
		return trimmed.length <= 100;
	}
	if (afterKey[0] !== ":") {
		return false;
	}
	return true;
}

type BufferedPlanningResult =
	| { kind: "incomplete" }
	| { kind: "plain"; visibleText: string }
	| { kind: "leak"; visibleText: string };

function isPlanningLeakObject(parsed: unknown, toolNames: Set<string>): boolean {
	if (!parsed || typeof parsed !== "object") return false;
	const record = parsed as Record<string, unknown>;
	const hasThought = typeof record.thought === "string";
	const isOmpTool = typeof record.call === "string" && toolNames.has(record.call);
	const hasToolSignature =
		"_i" in record || "paths" in record || "command" in record || ("path" in record && "content" in record);
	return hasThought || isOmpTool || hasToolSignature;
}

function splitLeadingJsonObject(text: string): { prefixLength: number; jsonText: string; rest: string } | undefined {
	const prefixLength = text.length - text.trimStart().length;
	const trimmed = text.slice(prefixLength);
	if (!trimmed.startsWith("{")) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < trimmed.length; index += 1) {
		const ch = trimmed[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			depth += 1;
			continue;
		}
		if (ch !== "}") continue;
		depth -= 1;
		if (depth !== 0) continue;

		const jsonText = trimmed.slice(0, index + 1);
		return {
			prefixLength: prefixLength + index + 1,
			jsonText,
			rest: trimmed.slice(index + 1),
		};
	}

	return undefined;
}

function splitLeadingJsonObjectIgnoringQuotes(
	text: string,
): { prefixLength: number; jsonText: string; rest: string } | undefined {
	const prefixLength = text.length - text.trimStart().length;
	const trimmed = text.slice(prefixLength);
	if (!trimmed.startsWith("{")) return undefined;

	let depth = 0;
	for (let index = 0; index < trimmed.length; index += 1) {
		const ch = trimmed[index];
		if (ch === "{") {
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				return {
					prefixLength: prefixLength + index + 1,
					jsonText: trimmed.slice(0, index + 1),
					rest: trimmed.slice(index + 1),
				};
			}
		}
	}
	return undefined;
}

function consumePlanningBuffer(text: string, toolNames: Set<string>, isFinal = false): BufferedPlanningResult {
	if (!isPlanningLeakPrefix(text)) {
		return { kind: "plain", visibleText: text };
	}

	// Try standard brace-balanced slicing first (respecting quotes and escapes)
	let leading = splitLeadingJsonObject(text);

	// If standard parsing fails (e.g. due to unescaped quotes), fall back to quote-ignoring brace-balanced slicing
	if (!leading) {
		leading = splitLeadingJsonObjectIgnoringQuotes(text);
	}

	if (!leading) {
		if (isFinal) {
			// At EOF, if the buffer has a leak signature but no closing brace at all, discard the whole buffer.
			const trimmed = text.trim();
			const hasThoughtKey = trimmed.includes('"thought"');
			const hasToolKey = Array.from(toolNames).some(name => trimmed.includes(`"${name}"`));
			const hasToolSignature =
				trimmed.includes('"_i"') ||
				trimmed.includes('"paths"') ||
				trimmed.includes('"command"') ||
				(trimmed.includes('"path"') && trimmed.includes('"content"'));
			if (hasThoughtKey || hasToolKey || hasToolSignature) {
				return { kind: "leak", visibleText: "" };
			}
			return { kind: "plain", visibleText: text };
		}
		return { kind: "incomplete" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(leading.jsonText);
	} catch {
		// Fallback to substring matching if JSON parsing fails due to unescaped quotes
		const hasThoughtKey = leading.jsonText.includes('"thought"');
		const hasToolKey = Array.from(toolNames).some(name => leading.jsonText.includes(`"${name}"`));
		const hasToolSignature =
			leading.jsonText.includes('"_i"') ||
			leading.jsonText.includes('"paths"') ||
			leading.jsonText.includes('"command"') ||
			(leading.jsonText.includes('"path"') && leading.jsonText.includes('"content"'));
		const isLeak = hasThoughtKey || hasToolKey || hasToolSignature;
		if (isLeak) {
			return { kind: "leak", visibleText: leading.rest };
		}
		// Unparseable leading object is not safe to strip; release it as normal text.
		return { kind: "plain", visibleText: text };
	}

	return isPlanningLeakObject(parsed, toolNames)
		? { kind: "leak", visibleText: leading.rest }
		: { kind: "plain", visibleText: text };
}

export interface GoogleGeminiCliOptions extends StreamOptions {
	/**
	 * Tool selection mode. String forms map directly to Gemini
	 * `FunctionCallingConfigMode`. The object form forces a single named tool —
	 * `mode: "ANY"` is wire-required when `allowedFunctionNames` is set.
	 */
	toolChoice?: "auto" | "none" | "any" | { mode: "ANY"; allowedFunctionNames: [string, ...string[]] };
	/**
	 * Thinking/reasoning configuration.
	 * - Gemini 2.x models: use `budgetTokens` to set the thinking budget
	 * - Gemini 3 models (gemini-3-pro-*, gemini-3-flash-*): use `level` instead
	 *
	 * When using `streamSimple`, this is handled automatically based on the model.
	 */
	thinking?: {
		enabled: boolean;
		/** Thinking budget in tokens. Use for Gemini 2.x models. */
		budgetTokens?: number;
		/** Thinking level. Use for Gemini 3 models (LOW/HIGH for Pro, MINIMAL/LOW/MEDIUM/HIGH for Flash). */
		level?: GoogleThinkingLevel;
		/**
		 * Explicit wire suppression when `enabled` is false. Cloud Code Assist
		 * re-applies the per-id baked server default when thinkingConfig is
		 * omitted, so models with `thinking.suppressWhenOff` must send
		 * `includeThoughts: false` plus a MINIMAL level (or zero budget).
		 */
		suppress?: { level: GoogleThinkingLevel } | { budget: number };
	};
	/**
	 * Upstream wire model id override for collapsed effort-tier variants.
	 * Serialized as `requestModelId ?? model.requestModelId ?? model.id`.
	 */
	requestModelId?: string;
	projectId?: string;
	/** Antigravity endpoint routing mode: "auto" (default with failover), "production", "sandbox". */
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	providerSessionState?: Map<string, ProviderSessionState>;
}

export interface AntigravityProviderSessionState extends ProviderSessionState {
	lastGoodEndpoint?: string;
	/**
	 * Per-conversation request-envelope identity that mirrors the real
	 * Antigravity client. `sessionId` is the signed-decimal session id;
	 * `agentId`/`trajectoryId` are UUIDs; `stepIndex` is the monotonic step
	 * counter; `lastExecutionId` is the prior response id echoed as
	 * `labels.last_execution_id`.
	 */
	agentId?: string;
	trajectoryId?: string;
	sessionId?: string;
	stepIndex?: number;
	lastExecutionId?: string;
}

const ANTIGRAVITY_PROVIDER_SESSION_STATE_KEY = "google-antigravity-session-state";

export function getAntigravityProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): AntigravityProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	let existing = providerSessionState.get(ANTIGRAVITY_PROVIDER_SESSION_STATE_KEY) as
		| AntigravityProviderSessionState
		| undefined;
	if (!existing) {
		existing = {
			close: () => {},
		};
		providerSessionState.set(ANTIGRAVITY_PROVIDER_SESSION_STATE_KEY, existing);
	}
	return existing;
}

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;

export {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
	getGeminiCliUserAgent,
} from "@pk-nerdsaver-ai/pi-catalog/wire/gemini-headers";

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";
const GOOGLE_GEMINI_REFRESH_SKEW_MS = 60_000;
const ANTIGRAVITY_REFRESH_SKEW_MS = 60_000;

function isClaudeModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("claude");
}

function needsClaudeThinkingBetaHeader(model: Model<"google-gemini-cli">): boolean {
	return model.provider === "google-antigravity" && model.id.startsWith("claude-") && model.reasoning;
}

function shouldInjectAntigravitySystemInstruction(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return normalized.includes("claude") || normalized.includes("gemini-3");
}

const optionalCredentialString = type("unknown").pipe(raw => {
	const out = type("string")(raw);
	return out instanceof type.errors ? undefined : out;
});

const innerCredentialsSchema = type({
	"token?": optionalCredentialString,
	"projectId?": optionalCredentialString,
	"project_id?": optionalCredentialString,
	"refreshToken?": optionalCredentialString,
	"refresh?": optionalCredentialString,
	"email?": optionalCredentialString,
	"expiresAt?": "unknown",
	"expires?": "unknown",
});

const geminiCliCredentialsSchema = type("unknown").pipe(raw => {
	const out = innerCredentialsSchema(raw);
	return out instanceof type.errors ? {} : out;
});

interface ParsedGeminiCliCredentials {
	accessToken: string;
	projectId: string;
	refreshToken?: string;
	expiresAt?: number;
	email?: string;
}

function normalizeExpiryMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return value < 10_000_000_000 ? value * 1000 : value;
}

export function parseGeminiCliCredentials(apiKeyRaw: string): ParsedGeminiCliCredentials {
	const invalidCredentialsMessage = "Invalid Google Cloud Code Assist credentials. Use /login to re-authenticate.";
	const missingCredentialsMessage =
		"Missing token or projectId in Google Cloud credentials. Use /login to re-authenticate.";

	let rawCredentials: unknown;
	try {
		rawCredentials = JSON.parse(apiKeyRaw);
	} catch {
		throw new AIError.ValidationError(invalidCredentialsMessage);
	}
	const parsed = geminiCliCredentialsSchema(rawCredentials);
	if (parsed instanceof type.errors) {
		throw new AIError.ValidationError(invalidCredentialsMessage);
	}

	const projectId = parsed.projectId ?? parsed.project_id;
	if (parsed.token === undefined || projectId === undefined) {
		throw new AIError.ValidationError(missingCredentialsMessage);
	}

	const refreshToken = parsed.refreshToken ?? parsed.refresh;
	const expiresAt = normalizeExpiryMs(parsed.expiresAt ?? parsed.expires);
	const email = parsed.email && parsed.email.length > 0 ? parsed.email : undefined;

	return {
		accessToken: parsed.token,
		projectId,
		refreshToken,
		expiresAt,
		email,
	};
}

export function shouldRefreshGeminiCliCredentials(
	expiresAt: number | undefined,
	isAntigravity: boolean,
	nowMs = Date.now(),
): boolean {
	if (expiresAt === undefined) {
		return false;
	}

	const skewMs = isAntigravity ? ANTIGRAVITY_REFRESH_SKEW_MS : GOOGLE_GEMINI_REFRESH_SKEW_MS;
	return nowMs + skewMs >= expiresAt;
}

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			topP?: number;
			topK?: number;
			minP?: number;
			presencePenalty?: number;
			repetitionPenalty?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: { functionDeclarations: Record<string, unknown>[] }[] | undefined;
		toolConfig?: {
			functionCallingConfig: {
				mode: FunctionCallingConfigMode;
				allowedFunctionNames?: string[];
			};
		};
		labels?: Record<string, string>;
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

interface CloudCodeAssistResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					thought?: boolean;
					thoughtSignature?: string;
					functionCall?: {
						name: string;
						args: Record<string, unknown>;
						id?: string;
					};
				}>;
			};
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		modelVersion?: string;
		responseId?: string;
		promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
	};
	/** In-band stream failure (quota, internal error) delivered as a final JSON event. */
	error?: { code?: number; message?: string; status?: string };
	traceId?: string;
}

export const streamGoogleGeminiCli: StreamFunction<"google-gemini-cli"> = (
	model: Model<"google-gemini-cli">,
	context: Context,
	options?: GoogleGeminiCliOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-gemini-cli" as Api,
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
			const apiKeyRaw = options?.apiKey;
			if (!apiKeyRaw) {
				throw new AIError.ConfigurationError(
					"Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.",
				);
			}

			const isAntigravity = model.provider === "google-antigravity";
			const parsedCredentials = parseGeminiCliCredentials(apiKeyRaw);
			const { accessToken, projectId } = parsedCredentials;
			// AuthStorage already refreshed credentials before threading them
			// here (see {@link OAUTH_REFRESH_SKEW_MS}). If the credential lands
			// expired we bail rather than POSTing a stale token; the next call
			// — driven by AuthStorage's invalidate+retry path — will carry a
			// fresh credential.
			if (
				shouldRefreshGeminiCliCredentials(parsedCredentials.expiresAt, isAntigravity) &&
				parsedCredentials.expiresAt !== undefined &&
				Date.now() >= parsedCredentials.expiresAt
			) {
				throw new AIError.OAuthError(
					"OAuth token expired before request — please retry; AuthStorage will refresh on the next attempt.",
					{ kind: "token-refresh", provider: model.provider },
				);
			}
			const baseUrl = model.baseUrl?.trim();
			let endpoints: string[];
			const providerState = isAntigravity
				? getAntigravityProviderSessionState(options?.providerSessionState)
				: undefined;

			if (isAntigravity) {
				const mode = options?.antigravityEndpointMode ?? "auto";
				if (mode === "sandbox") {
					endpoints = [ANTIGRAVITY_SANDBOX_ENDPOINT];
					if (providerState) providerState.lastGoodEndpoint = undefined;
				} else if (mode === "production") {
					endpoints = [ANTIGRAVITY_DAILY_ENDPOINT];
					if (providerState) providerState.lastGoodEndpoint = undefined;
				} else {
					// auto mode
					if (baseUrl) {
						const cleanUrl = baseUrl.replace(/\/+$/, "");
						if (cleanUrl !== ANTIGRAVITY_DAILY_ENDPOINT && cleanUrl !== ANTIGRAVITY_SANDBOX_ENDPOINT) {
							endpoints = [baseUrl];
							if (providerState) providerState.lastGoodEndpoint = undefined;
						} else {
							const defaultFallbacks = [...ANTIGRAVITY_ENDPOINT_FALLBACKS] as string[];
							const lastGood = providerState?.lastGoodEndpoint;
							if (lastGood && defaultFallbacks.includes(lastGood)) {
								endpoints = [lastGood, ...defaultFallbacks.filter(e => e !== lastGood)];
							} else {
								endpoints = defaultFallbacks;
							}
						}
					} else {
						const defaultFallbacks = [...ANTIGRAVITY_ENDPOINT_FALLBACKS] as string[];
						const lastGood = providerState?.lastGoodEndpoint;
						if (lastGood && defaultFallbacks.includes(lastGood)) {
							endpoints = [lastGood, ...defaultFallbacks.filter(e => e !== lastGood)];
						} else {
							endpoints = defaultFallbacks;
						}
					}
				}
			} else {
				endpoints = baseUrl ? [baseUrl] : [DEFAULT_ENDPOINT];
			}

			let requestBody = buildRequest(model, context, projectId, options, isAntigravity);
			const replacementPayload = await options?.onPayload?.(requestBody, model);
			if (replacementPayload !== undefined) {
				requestBody = replacementPayload as typeof requestBody;
			}
			const headers = isAntigravity ? { "User-Agent": getAntigravityUserAgent() } : getGeminiCliHeaders(model.id);

			const requestHeaders = {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...headers,
				...(needsClaudeThinkingBetaHeader(model) ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER } : {}),
				...(options?.headers ?? {}),
			};
			const requestBodyJson = JSON.stringify(requestBody);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				body: requestBody,
				headers: requestHeaders,
			};

			// Direct callers that skip `register-builtins` (which installs the
			// iterator-level watchdog) need a pre-response timer alongside
			// `timeout: false`; otherwise a stalled Cloud Code Assist proxy
			// would hang forever. Floor matches the lazy wrapper's 5min default.
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(undefined, 300_000);
			const callerSignal = options?.signal;
			const toolNames = new Set(context.tools?.map(t => t.name) ?? []);
			const isFlashLeakModel = model.id.includes("flash");

			let started = false;
			let sawFinishReason = false;
			let lastResponseId: string | undefined;
			const ensureStarted = () => {
				if (!started) {
					if (!firstTokenTime) firstTokenTime = performance.now();
					stream.push({ type: "start", partial: output });
					started = true;
				}
			};

			const resetOutput = () => {
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
				sawFinishReason = false;
			};

			const streamResponse = async (activeResponse: Response): Promise<boolean> => {
				if (!activeResponse.body) {
					throw new AIError.ProviderResponseError("No response body", {
						provider: model.provider,
						kind: "empty-body",
					});
				}

				// Scoped per attempt so a failed/empty retry cannot leak its
				// response id into the next request's last_execution_id.
				lastResponseId = undefined;

				let currentBlock: TextContent | ThinkingContent | null = null;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;

				let isBuffering = false;
				let textBuffer = "";
				let bufferedTextSignature: string | undefined;

				const emitVisibleText = (delta: string, thoughtSignature?: string) => {
					if (!delta || !currentBlock || currentBlock.type !== "text") return;
					currentBlock.text += delta;
					currentBlock.textSignature = retainThoughtSignature(currentBlock.textSignature, thoughtSignature);
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta,
						partial: output,
					});
				};

				for await (const chunk of readSseJson<CloudCodeAssistResponseChunk>(
					activeResponse.body!,
					options?.signal,
					event => options?.onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, model),
				)) {
					if (chunk.error) {
						const detail = chunk.error.message || chunk.error.status || "unknown error";
						const message = `Cloud Code Assist stream error: ${detail}`;
						throw typeof chunk.error.code === "number" && chunk.error.code >= 400
							? new AIError.GeminiCliApiError(message, chunk.error.code)
							: new AIError.ProviderResponseError(message, { provider: model.provider, kind: "runtime" });
					}
					const responseData = chunk.response;
					if (!responseData) continue;
					if (responseData.responseId) lastResponseId = responseData.responseId;
					if (!responseData.candidates?.length && responseData.promptFeedback?.blockReason) {
						const detail = responseData.promptFeedback.blockReasonMessage;
						throw new AIError.ProviderResponseError(
							`Request blocked by Google (${responseData.promptFeedback.blockReason})${detail ? `: ${detail}` : ""}`,
							{ provider: model.provider, kind: "content-blocked" },
						);
					}

					const candidate = responseData.candidates?.[0];
					if (candidate?.content?.parts) {
						for (const part of candidate.content.parts) {
							if (part.text !== undefined && part.text !== "") {
								const isThinking = isThinkingPart(part);
								if (
									!currentBlock ||
									(isThinking && currentBlock.type !== "thinking") ||
									(!isThinking && currentBlock.type !== "text")
								) {
									if (currentBlock) {
										pushBlockEndEvent(currentBlock, blockIndex(), output, stream);
									}
									currentBlock = startTextOrThinkingBlock(isThinking, output, stream, ensureStarted);
								}
								if (currentBlock.type === "thinking") {
									currentBlock.thinking += part.text;
									currentBlock.thinkingSignature = retainThoughtSignature(
										currentBlock.thinkingSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "thinking_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								} else {
									if (isBuffering) {
										textBuffer += part.text;
										bufferedTextSignature = retainThoughtSignature(
											bufferedTextSignature,
											part.thoughtSignature,
										);
									} else if (isFlashLeakModel && part.text.trimStart().startsWith("{")) {
										isBuffering = true;
										textBuffer = part.text;
										bufferedTextSignature = part.thoughtSignature;
									} else {
										emitVisibleText(part.text, part.thoughtSignature);
									}

									if (isBuffering) {
										const buffered = consumePlanningBuffer(textBuffer, toolNames);
										if (buffered.kind !== "incomplete") {
											if (buffered.kind === "leak") {
												sawLeak = true;
											}
											const visibleSignature = bufferedTextSignature;
											isBuffering = false;
											textBuffer = "";
											bufferedTextSignature = undefined;
											emitVisibleText(buffered.visibleText, visibleSignature);
										}
									}
								}
							} else if (part.text === "" && part.thoughtSignature && currentBlock && !part.functionCall) {
								if (currentBlock.type === "thinking") {
									currentBlock.thinkingSignature = retainThoughtSignature(
										currentBlock.thinkingSignature,
										part.thoughtSignature,
									);
								} else {
									currentBlock.textSignature = retainThoughtSignature(
										currentBlock.textSignature,
										part.thoughtSignature,
									);
								}
							}

							if (part.functionCall) {
								if (currentBlock) {
									pushBlockEndEvent(currentBlock, blockIndex(), output, stream);
									currentBlock = null;
								}
								isBuffering = false;
								textBuffer = "";

								const providedId = part.functionCall.id;
								const needsNewId =
									!providedId || output.content.some(b => b.type === "toolCall" && b.id === providedId);
								const toolCallId = needsNewId ? nextToolCallId(part.functionCall.name || "tool") : providedId;

								const toolCall: ToolCall = {
									type: "toolCall",
									id: toolCallId,
									name: part.functionCall.name || "",
									arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
									...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
								};

								output.content.push(toolCall);
								ensureStarted();
								pushToolCallEvents(toolCall, blockIndex(), output, stream);
							}
						}
					}

					if (candidate?.finishReason) {
						sawFinishReason = true;
						const mapped = mapStopReasonString(candidate.finishReason);
						// Only let a trailing tool call upgrade benign finishes; error finishes
						// (SAFETY, MALFORMED_FUNCTION_CALL, ...) must surface even with tool calls present.
						if ((mapped === "stop" || mapped === "length") && output.content.some(b => b.type === "toolCall")) {
							output.stopReason = "toolUse";
						} else {
							output.stopReason = mapped;
							if (mapped === "error") {
								output.errorMessage = `Generation failed with finish reason: ${candidate.finishReason}`;
							}
						}
					}

					if (responseData.usageMetadata) {
						// promptTokenCount includes cachedContentTokenCount, so subtract to get fresh input
						const promptTokens = responseData.usageMetadata.promptTokenCount || 0;
						const cacheReadTokens = responseData.usageMetadata.cachedContentTokenCount || 0;
						const thinkingTokens = responseData.usageMetadata.thoughtsTokenCount || 0;
						output.usage = {
							input: promptTokens - cacheReadTokens,
							output: (responseData.usageMetadata.candidatesTokenCount || 0) + thinkingTokens,
							cacheRead: cacheReadTokens,
							cacheWrite: 0,
							totalTokens: responseData.usageMetadata.totalTokenCount || 0,
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

				if (isBuffering && textBuffer !== "") {
					const buffered = consumePlanningBuffer(textBuffer, toolNames, true);
					if (buffered.kind === "leak") {
						sawLeak = true;
					}
					if (buffered.kind !== "incomplete") {
						emitVisibleText(buffered.visibleText, bufferedTextSignature);
					}
					bufferedTextSignature = undefined;
					isBuffering = false;
					textBuffer = "";
				}

				if (currentBlock) {
					pushBlockEndEvent(currentBlock, blockIndex(), output, stream);
				}

				return hasMeaningfulGoogleContent(output) || sawLeak;
			};

			let receivedContent = false;
			let sawLeak = false;

			for (let i = 0; i < endpoints.length; i++) {
				const endpoint = endpoints[i];
				const isLastEndpoint = i === endpoints.length - 1;
				try {
					started = false;
					resetOutput();

					// Per attempt: arm a pre-response (TTFT) timer, cleared the instant
					// headers arrive so it never aborts the actively streaming body —
					// an absolute `AbortSignal.timeout` would (issue #2422).
					const watchdog = armPreResponseTimeout(callerSignal, firstEventTimeoutMs);
					let response: Response;
					try {
						response = await fetchWithRetry(() => `${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
							method: "POST",
							headers: requestHeaders,
							body: requestBodyJson,
							signal: watchdog.signal,
							maxAttempts: isLastEndpoint ? MAX_RETRIES + 1 : 1,
							defaultDelayMs: attempt => BASE_DELAY_MS * 2 ** attempt,
							maxDelayMs: options?.maxRetryDelayMs ?? RATE_LIMIT_BUDGET_MS,
							fetch: options?.fetch,
							timeout: false,
						});
					} finally {
						watchdog.clear();
					}

					if (!response.ok) {
						if (AIError.isTransientStatus(response.status)) {
							if (!isLastEndpoint) {
								continue;
							}
						}
						const errorText = await response.text();
						const validationUrl = extractGoogleValidationUrl(errorText);
						const errorMessage = validationUrl
							? formatGoogleValidationRequiredMessage(
									validationUrl,
									"retry your request",
									parsedCredentials.email,
								)
							: errorText;
						throw new AIError.GeminiCliApiError(
							`Cloud Code Assist API error (${response.status}): ${errorMessage}`,
							response.status,
							{ headers: response.headers },
						);
					}

					const requestUrl = response.url;
					let currentResponse = response;

					for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt++) {
						if (options?.signal?.aborted) {
							throw new AIError.AbortError("Request was aborted");
						}

						if (emptyAttempt > 0) {
							const backoffMs = EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1);
							try {
								await scheduler.wait(backoffMs, { signal: options?.signal });
							} catch {
								throw new AIError.AbortError("Request was aborted");
							}

							if (!requestUrl) {
								throw new AIError.ConfigurationError("Missing request URL");
							}

							currentResponse = await (options?.fetch ?? fetch)(requestUrl, {
								method: "POST",
								headers: requestHeaders,
								body: requestBodyJson,
								signal: options?.signal,
							});

							if (!currentResponse.ok) {
								const retryErrorText = await currentResponse.text();
								throw new AIError.GeminiCliApiError(
									`Cloud Code Assist API error (${currentResponse.status}): ${retryErrorText}`,
									currentResponse.status,
									{ headers: currentResponse.headers },
								);
							}
						}

						const streamed = await streamResponse(currentResponse);
						if (streamed) {
							receivedContent = true;
							break;
						}

						if (emptyAttempt < MAX_EMPTY_STREAM_RETRIES) {
							resetOutput();
						}
					}

					if (!receivedContent) {
						throw new AIError.ProviderResponseError("Cloud Code Assist API returned an empty response", {
							provider: model.provider,
							kind: "empty-body",
						});
					}

					if (options?.signal?.aborted) {
						throw new AIError.AbortError("Request was aborted");
					}

					if (!sawFinishReason) {
						throw new AIError.ProviderResponseError(
							"Cloud Code Assist stream ended without a finish reason (connection dropped or response truncated)",
							{ provider: model.provider, kind: "incomplete-stream" },
						);
					}

					// Succeeded! Break the endpoints loop.
					if (
						providerState &&
						(options?.antigravityEndpointMode === "auto" || !options?.antigravityEndpointMode)
					) {
						providerState.lastGoodEndpoint = endpoint;
					}
					// Commit after a fully successful attempt (content + finish reason);
					// used as the next request's last_execution_id. Overwrite even when
					// undefined so a response without an id can't leave a stale value.
					if (providerState) {
						providerState.lastExecutionId = lastResponseId;
					}
					break;
				} catch (error) {
					const status = extractHttpStatusFromError(error);
					if (AIError.isTransientStatus(status)) {
						if (!isLastEndpoint && !started) {
							continue;
						}
					}
					throw error;
				}
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
					provider: model.provider,
					kind: "output",
				});
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
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
};

const INT63_MASK = (1n << 63n) - 1n;
const ANTIGRAVITY_RANDOM_BOUND = 9_000_000_000_000_000_000n;

function formatSignedDecimalSessionId(value: bigint): string {
	return `-${value.toString()}`;
}

function deriveSignedDecimalFromHash(text: string): string {
	const digest = createHash("sha256").update(text).digest();
	let value = 0n;
	for (let index = 0; index < 8; index += 1) {
		value = (value << 8n) | BigInt(digest[index] ?? 0);
	}
	return formatSignedDecimalSessionId(value & INT63_MASK);
}

function randomBoundedInt63(maxExclusive: bigint): bigint {
	while (true) {
		const bytes = randomBytes(8);
		let value = 0n;
		for (const byte of bytes) {
			value = (value << 8n) | BigInt(byte);
		}
		value &= INT63_MASK;
		if (value < maxExclusive) {
			return value;
		}
	}
}

function randomSignedDecimalSessionId(): string {
	return formatSignedDecimalSessionId(randomBoundedInt63(ANTIGRAVITY_RANDOM_BOUND));
}

function getFirstUserTextForAntigravitySession(context: Context): string | undefined {
	for (const message of context.messages) {
		if (message.role !== "user") {
			continue;
		}

		if (typeof message.content === "string") {
			return message.content;
		}

		if (Array.isArray(message.content)) {
			const firstTextPart = message.content.find((item): item is TextContent => item.type === "text");
			return firstTextPart?.text;
		}

		return undefined;
	}

	return undefined;
}

function deriveAntigravitySessionId(context: Context): string {
	const text = getFirstUserTextForAntigravitySession(context);
	if (text && text.trim().length > 0) {
		return deriveSignedDecimalFromHash(text);
	}

	return randomSignedDecimalSessionId();
}

function normalizeAntigravityTools(
	tools: CloudCodeAssistRequest["request"]["tools"],
): CloudCodeAssistRequest["request"]["tools"] {
	return tools?.map(tool => ({
		...tool,
		functionDeclarations: tool.functionDeclarations.map(declaration => {
			if ("parameters" in declaration) {
				return declaration;
			}

			const { parametersJsonSchema, ...rest } = declaration;
			return {
				...rest,
				parameters: normalizeSchemaForCCA(parametersJsonSchema),
			};
		}),
	}));
}

interface AntigravityRequestEnvelope {
	sessionId: string;
	requestId: string;
	labels: Record<string, string>;
}

/**
 * Build the Antigravity request envelope (sessionId, structured requestId,
 * labels) advancing the per-conversation session state. Mirrors the real
 * `antigravity/hub` client: `requestId` is `agent/<agentId>/<ts>/<trajectoryId>/<step>`
 * and `labels.last_step_index` trails the requestId step by one. Without session
 * state (direct callers/tests) it falls back to ephemeral ids.
 */
function buildAntigravityRequestEnvelope(
	model: Model<"google-gemini-cli">,
	context: Context,
	wireModelId: string,
	state: AntigravityProviderSessionState | undefined,
): AntigravityRequestEnvelope {
	if (state) {
		state.agentId ??= randomUUID();
		state.trajectoryId ??= randomUUID();
		state.sessionId ??= randomSignedDecimalSessionId();
		state.stepIndex = (state.stepIndex ?? 1) + 1;
	}
	const agentId = state?.agentId ?? randomUUID();
	const trajectoryId = state?.trajectoryId ?? randomUUID();
	const sessionId = state?.sessionId ?? deriveAntigravitySessionId(context);
	const step = state?.stepIndex ?? 2;
	const requestId = `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`;
	const isClaude = isClaudeModel(model.id);
	const profile = getAntigravityModelWireProfile(wireModelId);
	const labels: Record<string, string> = {};
	if (state?.lastExecutionId) labels.last_execution_id = state.lastExecutionId;
	labels.last_step_index = String(step - 1);
	if (profile?.modelEnum !== undefined) labels.model_enum = profile.modelEnum;
	labels.trajectory_id = trajectoryId;
	labels.used_claude = String(isClaude);
	labels.used_claude_conservative = String(isClaude);
	return { sessionId, requestId, labels };
}

export function buildRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
	isAntigravity = false,
): CloudCodeAssistRequest {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const contents = convertMessages(model, context);
	const generationConfig: CloudCodeAssistRequest["request"]["generationConfig"] = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}
	if (options.topP !== undefined) {
		generationConfig.topP = options.topP;
	}
	if (options.topK !== undefined) {
		generationConfig.topK = options.topK;
	}
	if (options.minP !== undefined) {
		generationConfig.minP = options.minP;
	}
	if (options.presencePenalty !== undefined) {
		generationConfig.presencePenalty = options.presencePenalty;
	}
	if (options.repetitionPenalty !== undefined) {
		generationConfig.repetitionPenalty = options.repetitionPenalty;
	}

	// Thinking config
	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = {
			includeThoughts: true,
		};
		// Gemini 3 models use thinkingLevel, older models use thinkingBudget
		if (options.thinking.level !== undefined) {
			// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level as any;
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	} else if (options.thinking?.suppress && model.reasoning) {
		// Explicit off: omitting thinkingConfig re-applies the per-id baked
		// server default (the model silently thinks and bills the tokens).
		const suppress = options.thinking.suppress;
		generationConfig.thinkingConfig = { includeThoughts: false };
		if ("level" in suppress) {
			// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
			generationConfig.thinkingConfig.thinkingLevel = suppress.level as any;
		} else {
			generationConfig.thinkingConfig.thinkingBudget = suppress.budget;
		}
	}

	const request: CloudCodeAssistRequest["request"] = {
		contents,
	};

	// System instruction is an object with parts, not a plain string. Antigravity
	// tags it with role "user" to mirror the real client.
	if (systemPrompts.length > 0) {
		request.systemInstruction = {
			...(isAntigravity ? { role: "user" } : {}),
			parts: systemPrompts.map(text => ({ text })),
		};
	}

	if (isAntigravity && shouldInjectAntigravitySystemInstruction(model.id)) {
		const existingParts = request.systemInstruction?.parts ?? [];
		request.systemInstruction = {
			role: "user",
			parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...existingParts],
		};
	}

	if (context.tools && context.tools.length > 0) {
		const convertedTools = convertTools(context.tools, model);
		request.tools = isAntigravity ? normalizeAntigravityTools(convertedTools) : convertedTools;
		if (options.toolChoice) {
			const choice = options.toolChoice;
			if (typeof choice === "string") {
				const mode = mapToolChoice(choice);
				if (mode !== "AUTO") {
					request.toolConfig = {
						functionCallingConfig: { mode },
					};
				}
			} else {
				request.toolConfig = {
					functionCallingConfig: {
						mode: "ANY",
						allowedFunctionNames: [...choice.allowedFunctionNames],
					},
				};
			}
		}
		// Antigravity's default tool mode is VALIDATED (verified for Gemini and
		// Claude); an explicit non-auto tool choice above wins.
		if (isAntigravity && !request.toolConfig) {
			request.toolConfig = {
				functionCallingConfig: { mode: "VALIDATED" as FunctionCallingConfigMode },
			};
		}
	}

	// Claude on Antigravity always forces VALIDATED, even with no tools declared.
	if (isAntigravity && isClaudeModel(model.id)) {
		request.toolConfig = {
			functionCallingConfig: {
				mode: "VALIDATED" as FunctionCallingConfigMode,
			},
		};
	}

	const wireModelId = options.requestModelId ?? model.requestModelId ?? model.id;

	if (isAntigravity) {
		// The real client sends a fixed per-model output cap independent of the
		// thinking budget; reassign so it keeps its slot ahead of thinkingConfig.
		const profile = getAntigravityModelWireProfile(wireModelId);
		if (profile) {
			generationConfig.maxOutputTokens = profile.maxOutputTokens;
		}
		const state = getAntigravityProviderSessionState(options.providerSessionState);
		const envelope = buildAntigravityRequestEnvelope(model, context, wireModelId, state);
		request.labels = envelope.labels;
		if (Object.keys(generationConfig).length > 0) {
			request.generationConfig = generationConfig;
		}
		request.sessionId = envelope.sessionId;
		return {
			project: projectId,
			requestId: envelope.requestId,
			request,
			model: wireModelId,
			userAgent: "antigravity",
			requestType: "agent",
		};
	}

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	return {
		project: projectId,
		model: wireModelId,
		request,
	};
}
