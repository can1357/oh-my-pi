import { isUnexpectedSocketCloseMessage } from "@pk-nerdsaver-ai/pi-utils";
import type { Api, AssistantMessage } from "../types";
import {
	AnthropicConnectionError,
	AnthropicConnectionTimeoutError,
	ProviderHttpError,
	STREAM_ENVELOPE_ERROR_PREFIX,
} from "./classes";
import { isOpaqueStatusBody, matchesUsageLimitText, parseRateLimitReason } from "./rate-limit";

export const Flag = {
	Class: 0x1000,
	ThinkingLoop: 0x0001_0000,
	Transient: 0x0002_0000,
	Timeout: 0x0004_0000,
	UsageLimit: 0x0008_0000,
	StaleResponsesItem: 0x0010_0000,
	MalformedFunctionCall: 0x0020_0000,
	ProviderFinishError: 0x0040_0000,
	ContextOverflow: 0x0080_0000,
	AuthFailed: 0x0100_0000,
	SilentAbort: 0x0200_0000,
	UserInterrupt: 0x0400_0000,
	Abort: 0x0800_0000,
	/** Anthropic strict-tool grammar too large / schema too complex to compile (400). */
	Grammar: 0x1000_0000,
	/** Anthropic model/account does not support fast mode / the `speed` parameter. */
	FastModeUnsupported: 0x2000_0000,
	/** OAuth refresh failed definitively — the stored grant is dead, re-login required. */
	OAuthExpiry: 0x4000_0000,
} as const;

export type Flag = (typeof Flag)[keyof typeof Flag];

const KIND_MASK =
	Flag.ThinkingLoop |
	Flag.Transient |
	Flag.Timeout |
	Flag.UsageLimit |
	Flag.StaleResponsesItem |
	Flag.MalformedFunctionCall |
	Flag.ProviderFinishError |
	Flag.ContextOverflow |
	Flag.AuthFailed |
	Flag.SilentAbort |
	Flag.UserInterrupt |
	Flag.Abort |
	Flag.Grammar |
	Flag.FastModeUnsupported |
	Flag.OAuthExpiry;

const RETRIABLE_KINDS =
	Flag.Transient | Flag.UsageLimit | Flag.ThinkingLoop | Flag.StaleResponsesItem | Flag.ProviderFinishError;

const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (all backends)
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/requested tokens?.*exceed.*context (window|length|size)/i, // llama.cpp / OpenAI-compatible local servers
	/context (window|length|size).*(exceeded|overflow|too small)/i, // Generic local server variants
	/(prompt|input).*(too long|too large).*(context|n_ctx)/i, // llama.cpp phrasing variants
	/requested tokens?.*(exceeds?|greater than).*(n_ctx|context)/i, // llama.cpp n_ctx variants
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
	/request_too_large/i, // Anthropic 413 (request body too large)
	/request exceeds the maximum size/i, // Anthropic 413 variant
	/payload too large/i, // Generic HTTP 413 variant
	/entity too large/i, // Generic HTTP 413 variant
	/\b413\b.*\b(request|payload|entity)\b.*\btoo large\b/i, // "413 Request Entity Too Large" variants
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt filled the context window/i, // Ollama OpenAI-compatible empty length completion
];

const OVERFLOW_NO_BODY_PATTERN = /\b4(00|13)\s*(status code)?\s*\(no body\)/i;
const TIMEOUT_PATTERN = /\b(?:operation\s+)?timed?\s*out\b|\btimeout\b|\bstream stall\b/i;
const TRANSIENT_ENVELOPE_PATTERN = /anthropic stream envelope error:/i;
const TRANSIENT_ENVELOPE_BEFORE_START_PATTERN = /before message_start/i;
export const TRANSIENT_TRANSPORT_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|malformed.?function.?call/i;
const AUTH_FAILURE_PATTERN =
	/\b(?:401|403|unauthorized|forbidden|authentication|auth[_ ]?unavailable|no auth available|(?:invalid|no)[_ ]?api[_ ]?key)\b/i;
const MALFORMED_FUNCTION_CALL_PATTERN = /\bmalformed.?function.?call\b/i;
const PROVIDER_FINISH_ERROR_PATTERN = /\bProvider (?:returned error finish_reason|finish_reason:\s*error)\b/i;
const STALE_RESPONSE_ITEM_PATTERNS = [/\bItem with id ['"][^'"]+['"] not found\.?/i, /previous[ _]?response/i] as const;
const STALE_RESPONSE_ITEM_DETAIL_PATTERN = /not[ _]?found|invalid|expired|stale|zero[ _-]?data[ _-]?retention/i;

// Copilot routing flap: HTTP 400 `model_not_supported` (structural code on the
// error, also surfaced in text). Treated as transient — a retry usually lands
// on a backend that has the model.
const COPILOT_MODEL_NOT_SUPPORTED_PATTERN = /model_not_supported/i;
// Anthropic strict-tool grammar too large / schema too complex (400 invalid_request_error).
const GRAMMAR_TOO_LARGE_PATTERN = /compiled grammar/i;
const GRAMMAR_TOO_LARGE_DETAIL_PATTERN = /too large/i;
const SCHEMA_TOO_COMPLEX_PATTERN = /schema/i;
const SCHEMA_TOO_COMPLEX_DETAIL_PATTERN = /too complex/i;
const SCHEMA_COMPILE_PATTERN = /compil/i;
const INVALID_REQUEST_PATTERN = /invalid_request_error/i;
// Anthropic fast-mode unsupported: 400 rejecting `speed`, or 429 rate_limit_error
// because the account lacks the extra-usage entitlement fast mode requires.
const FAST_MODE_SPEED_PARAM_PATTERN = /\bspeed\b/i;
const FAST_MODE_NOT_SUPPORTED_PATTERN = /not support/i;
const FAST_MODE_RATE_LIMIT_PATTERN = /rate_limit_error/i;
const FAST_MODE_ENTITLEMENT_PATTERN = /fast mode/i;
// Definitive OAuth refresh failure — the stored grant/client is dead.
const OAUTH_DEFINITIVE_FAILURE_PATTERN =
	/invalid_grant|invalid_token|unauthorized_client|\brevoked\b|refresh[\s_]?token.*expired/i;
const OAUTH_TRANSIENT_FAILURE_PATTERN =
	/timeout|network|fetch failed|ECONN(?:REFUSED|RESET)|ETIMEDOUT|EAI_AGAIN|socket hang up|\b(?:408|425|429|5\d{2})\b|rate.?limit|too many requests|temporar|unavailable|forbidden|permission_denied|cloudflare|captcha/i;
const OAUTH_HTTP_AUTH_PATTERN = /\b401\b/;

function matchesGrammarTooLarge(message: string, errorStatus: number | undefined): boolean {
	if (errorStatus !== 400) return false;
	if (!INVALID_REQUEST_PATTERN.test(message)) return false;
	const grammarTooLarge = GRAMMAR_TOO_LARGE_PATTERN.test(message) && GRAMMAR_TOO_LARGE_DETAIL_PATTERN.test(message);
	const schemaTooComplex =
		SCHEMA_TOO_COMPLEX_PATTERN.test(message) &&
		SCHEMA_TOO_COMPLEX_DETAIL_PATTERN.test(message) &&
		SCHEMA_COMPILE_PATTERN.test(message);
	return grammarTooLarge || schemaTooComplex;
}

function matchesFastModeUnsupported(message: string, errorStatus: number | undefined): boolean {
	if (errorStatus !== 400 && errorStatus !== 429) return false;
	if (
		errorStatus === 400 &&
		INVALID_REQUEST_PATTERN.test(message) &&
		FAST_MODE_SPEED_PARAM_PATTERN.test(message) &&
		FAST_MODE_NOT_SUPPORTED_PATTERN.test(message)
	) {
		return true;
	}
	return (
		errorStatus === 429 && FAST_MODE_RATE_LIMIT_PATTERN.test(message) && FAST_MODE_ENTITLEMENT_PATTERN.test(message)
	);
}

/** Whether an OAuth refresh error message means the grant is definitively dead. */
export function isOAuthExpiry(errorMessage: string): boolean {
	if (OAUTH_DEFINITIVE_FAILURE_PATTERN.test(errorMessage)) return true;
	return OAUTH_HTTP_AUTH_PATTERN.test(errorMessage) && !OAUTH_TRANSIENT_FAILURE_PATTERN.test(errorMessage);
}

const ERROR_KIND_LABELS: readonly [Flag, string][] = [
	[Flag.ThinkingLoop, "thinking-loop"],
	[Flag.Transient, "transient"],
	[Flag.Timeout, "timeout"],
	[Flag.UsageLimit, "usage-limit"],
	[Flag.StaleResponsesItem, "stale-responses-item"],
	[Flag.MalformedFunctionCall, "malformed-function-call"],
	[Flag.ProviderFinishError, "provider-finish-error"],
	[Flag.ContextOverflow, "context-overflow"],
	[Flag.AuthFailed, "auth-failed"],
	[Flag.SilentAbort, "silent-abort"],
	[Flag.UserInterrupt, "user-interrupt"],
	[Flag.Abort, "abort"],
];

const STATUS_MESSAGE_PATTERNS = [
	/\bstatus(?:_code)?[:=]\s*(\d{3})\b/i,
	/\bstatus\s+(\d{3})\b/i,
	/\bHTTP\s+(\d{3})\b/i,
	/\b(?:error|failed)\s*[:=]?\s*(\d{3})\b/i,
	/(?:^|\s)(\d{3})\s+(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
] as const;

export function create(...flags: number[]): number {
	let bits = 0;
	for (const f of flags) bits |= f;
	return bits | Flag.Class;
}

export function is(id: number | undefined, flag: Flag): boolean {
	return ((id ?? 0) & flag) !== 0;
}

export function retriable(id: number | undefined, opts?: { replayUnsafe?: boolean }): boolean {
	if (is(id, Flag.MalformedFunctionCall)) return true;
	if (opts?.replayUnsafe) return false;
	return ((id ?? 0) & RETRIABLE_KINDS) !== 0;
}

function isClassified(id: number | undefined): boolean {
	return ((id ?? 0) & Flag.Class) !== 0;
}

function statusFromId(id: number | undefined): number | undefined {
	return id && !isClassified(id) ? id : undefined;
}

export function status(error: unknown): number | undefined {
	return statusInternal(error, 0);
}

function statusInternal(error: unknown, depth: number): number | undefined {
	if (depth > 2 || error === undefined || error === null) return undefined;
	if (typeof error === "object") {
		const errObj = error as Record<string, unknown>;

		if (typeof errObj.status === "number" && errObj.status >= 100 && errObj.status <= 599) {
			return errObj.status;
		}
		if (typeof errObj.statusCode === "number" && errObj.statusCode >= 100 && errObj.statusCode <= 599) {
			return errObj.statusCode;
		}
		if (typeof errObj.response === "object" && errObj.response !== null) {
			const resp = errObj.response as Record<string, unknown>;
			if (typeof resp.status === "number" && resp.status >= 100 && resp.status <= 599) {
				return resp.status;
			}
		}

		if ("cause" in errObj) {
			const nested = statusInternal(errObj.cause, depth + 1);
			if (nested !== undefined) return nested;
		}
	}

	if (error instanceof Error || (typeof error === "object" && error !== null && "message" in error)) {
		const message = (error as { message: string }).message;
		if (typeof message === "string") {
			for (const pattern of STATUS_MESSAGE_PATTERNS) {
				const match = pattern.exec(message);
				if (match) {
					const code = parseInt(match[1], 10);
					if (code >= 100 && code <= 599) return code;
				}
			}
		}
	}
	return undefined;
}

function isTransientErrorText(text: string): boolean {
	return (
		isUnexpectedSocketCloseMessage(text) ||
		(TRANSIENT_ENVELOPE_PATTERN.test(text) && TRANSIENT_ENVELOPE_BEFORE_START_PATTERN.test(text)) ||
		TRANSIENT_TRANSPORT_PATTERN.test(text)
	);
}

function isTimeoutText(text: string): boolean {
	return TIMEOUT_PATTERN.test(text);
}

function isAuthFailureText(text: string): boolean {
	return AUTH_FAILURE_PATTERN.test(text);
}

function isStaleResponsesText(text: string): boolean {
	return (
		STALE_RESPONSE_ITEM_PATTERNS[0].test(text) ||
		(STALE_RESPONSE_ITEM_PATTERNS[1].test(text) && STALE_RESPONSE_ITEM_DETAIL_PATTERN.test(text))
	);
}

function isMalformedFunctionCallText(text: string): boolean {
	return MALFORMED_FUNCTION_CALL_PATTERN.test(text);
}

function isProviderFinishErrorText(text: string): boolean {
	return PROVIDER_FINISH_ERROR_PATTERN.test(text);
}

function matchesOverflowText(text: string): boolean {
	return OVERFLOW_PATTERNS.some(p => p.test(text)) || OVERFLOW_NO_BODY_PATTERN.test(text);
}

function classifyText(errorMessage: string | undefined, errorStatus: number | undefined, api?: Api): number {
	let kinds = 0;
	if (errorMessage) {
		if (matchesOverflowText(errorMessage)) kinds |= Flag.ContextOverflow;
		if (isMalformedFunctionCallText(errorMessage)) kinds |= Flag.MalformedFunctionCall;
		if (isProviderFinishErrorText(errorMessage)) kinds |= Flag.ProviderFinishError;
		if (isAuthFailureText(errorMessage)) kinds |= Flag.AuthFailed;

		const statusClean = errorStatus ? errorStatus : (status({ message: errorMessage }) ?? undefined);
		const cleanMessage = errorMessage;
		const isOpaque = isOpaqueStatusBody(cleanMessage);

		const isLimitStatus = statusClean === 429;
		if (
			matchesUsageLimitText(cleanMessage) ||
			(isLimitStatus && (isOpaque || parseRateLimitReason(cleanMessage) === "QUOTA_EXHAUSTED"))
		) {
			kinds |= Flag.UsageLimit;
		}

		if (isTimeoutText(errorMessage)) kinds |= Flag.Transient | Flag.Timeout;
		else if (isTransientErrorText(errorMessage)) kinds |= Flag.Transient;
		if ((api === "openai-responses" || api === "openai-codex-responses") && isStaleResponsesText(errorMessage)) {
			kinds |= Flag.StaleResponsesItem;
		}

		// Copilot per-client routing flap is transient.
		if (statusClean === 400 && COPILOT_MODEL_NOT_SUPPORTED_PATTERN.test(cleanMessage)) kinds |= Flag.Transient;
		if (matchesGrammarTooLarge(cleanMessage, statusClean)) kinds |= Flag.Grammar;
		if (matchesFastModeUnsupported(cleanMessage, statusClean)) kinds |= Flag.FastModeUnsupported;
	}
	if (kinds !== 0) return create(kinds);
	const fallbackStatus = errorStatus ?? (errorMessage ? status({ message: errorMessage }) : undefined);
	if (fallbackStatus === 401 || fallbackStatus === 403) return create(Flag.AuthFailed);
	return fallbackStatus ?? 0;
}

export function classify(error: unknown, api?: Api): number {
	let kinds = 0;
	const seen = new Set<object>();
	let link: unknown = error;
	while (link !== undefined && link !== null) {
		if (typeof link === "object") {
			if (seen.has(link)) break;
			seen.add(link);

			if ("errorId" in link && typeof (link as { errorId: unknown }).errorId === "number") {
				kinds |= (link as { errorId: number }).errorId & KIND_MASK;
			}
		}

		if (link instanceof AnthropicConnectionTimeoutError) {
			kinds |= Flag.Timeout | Flag.Transient;
		} else if (link instanceof AnthropicConnectionError) {
			kinds |= Flag.Transient;
		} else if (
			typeof link === "object" &&
			"name" in link &&
			(link as { name: string }).name === "CodexWebSocketTransportError"
		) {
			kinds |= Flag.Transient;
		} else if (
			link instanceof Error &&
			link.name === "CodexProviderStreamError" &&
			"retryable" in link &&
			(link as { retryable: unknown }).retryable === true
		) {
			kinds |= Flag.Transient;
		} else if (link instanceof ProviderHttpError) {
			let linkKinds = 0;
			const { status: codeStatus, code } = link;
			if (code === "usage_limit_reached" || code === "insufficient_quota") {
				linkKinds |= Flag.UsageLimit;
			}
			if (code === "overloaded_error" || code === "rate_limit_error") {
				linkKinds |= Flag.Transient;
			}
			if (codeStatus === 401 || codeStatus === 403) {
				linkKinds |= Flag.AuthFailed;
			} else if (codeStatus === 429) {
				if ((linkKinds & Flag.UsageLimit) === 0) {
					linkKinds |= Flag.Transient;
				}
			} else if (codeStatus >= 500) {
				linkKinds |= Flag.Transient;
			}
			kinds |= linkKinds;
		}

		let linkMessage: string | undefined;
		if (link instanceof Error) {
			linkMessage = link.message;
		} else if (typeof link === "string") {
			linkMessage = link;
		} else if (
			typeof link === "object" &&
			"message" in link &&
			typeof (link as { message: unknown }).message === "string"
		) {
			linkMessage = (link as { message: string }).message;
		}

		const textId = classifyText(linkMessage, status(link), api);
		kinds |= textId & KIND_MASK;

		link = typeof link === "object" && "cause" in link ? (link as { cause: unknown }).cause : undefined;
	}

	return kinds !== 0 ? create(kinds) : (status(error) ?? 0);
}

/**
 * Whether an error (or message string) classifies as an account usage/quota
 * limit — the persistent, credential-rotation-worthy kind. This is the public
 * accessor for {@link Flag.UsageLimit}; prefer it over re-running message
 * regexes at call sites.
 */
export function isUsageLimit(error: unknown, api?: Api): boolean {
	return is(classify(error, api), Flag.UsageLimit);
}

/**
 * Anthropic strict-tool grammar too large / schema too complex to compile.
 * Accessor for {@link Flag.Grammar}.
 */
export function isGrammarError(error: unknown): boolean {
	return is(classify(error), Flag.Grammar);
}

/**
 * Anthropic model/account does not support fast mode / the `speed` parameter.
 * Accessor for {@link Flag.FastModeUnsupported}.
 */
export function isFastModeUnsupported(error: unknown): boolean {
	return is(classify(error), Flag.FastModeUnsupported);
}

/**
 * GitHub Copilot 400 `model_not_supported` routing flap — transient. Reads the
 * structural `code` (and falls back to {@link Flag.Transient} text classification).
 */
export function isCopilotTransientModelError(error: unknown): boolean {
	if (status(error) === 400 && error && typeof error === "object") {
		const info = error as { code?: unknown; error?: { code?: unknown } | null };
		const code = typeof info.code === "string" ? info.code : info.error?.code;
		if (code === "model_not_supported") return true;
	}
	return false;
}

export function classifyMessage(message: {
	api?: Api;
	errorId?: number;
	errorMessage?: string;
	errorStatus?: number;
}): number {
	const existingId = message.errorId;
	const currentStatus = message.errorStatus ?? statusFromId(existingId);
	const textId = classifyText(message.errorMessage, currentStatus, message.api);

	const kinds = ((existingId ?? 0) | textId) & KIND_MASK;
	const id = kinds !== 0 ? create(kinds) : (statusFromId(textId) ?? statusFromId(existingId) ?? currentStatus ?? 0);

	message.errorId = id;
	return id;
}

export function attach<E extends object>(error: E, id: number): E {
	Object.defineProperty(error, "errorId", { value: id, enumerable: false, configurable: true });
	return error;
}

export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	if (is(message.errorId, Flag.ContextOverflow)) return true;
	if (contextWindow) {
		const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (inputTokens > contextWindow) return true;
	}
	return message.stopReason === "error" && !!message.errorMessage && matchesOverflowText(message.errorMessage);
}

export function stringify(id: number | undefined): string {
	if (!id) return "none";
	if (!isClassified(id)) return `status:${id}`;
	const labels = ERROR_KIND_LABELS.filter(([kind]) => is(id, kind)).map(([, label]) => label);
	return labels.length > 0 ? labels.join("|") : `classified:0x${id.toString(16)}`;
}

const STREAM_PARSE_TRUNCATION_PATTERN =
	/unterminated string|unexpected end of json input|unexpected end of data|unexpected eof|end of file|eof while parsing|truncated/i;
const STREAM_EVENT_ORDER_PATTERN = /stream event order|before message_start/i;

/** Transient stream corruption where the response was truncated mid-JSON. */
export function isTransientStreamParseError(error: unknown): boolean {
	return error instanceof Error && STREAM_PARSE_TRUNCATION_PATTERN.test(error.message);
}

/** Any malformed stream-envelope error (prefix-tagged or out-of-order events). */
export function isStreamEnvelopeError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes(STREAM_ENVELOPE_ERROR_PREFIX) || STREAM_EVENT_ORDER_PATTERN.test(error.message))
	);
}

/** Stream-envelope errors safe to retry against the provider (event ordering only). */
export function isRetryableStreamEnvelopeError(error: unknown): boolean {
	return error instanceof Error && STREAM_EVENT_ORDER_PATTERN.test(error.message);
}
