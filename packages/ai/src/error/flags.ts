import { isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils/fetch-retry";
import type { Api, AssistantMessage } from "../types";
import { AwsCredentialsError } from "./aws";
import {
	AnthropicConnectionError,
	AnthropicConnectionTimeoutError,
	ProviderHttpError,
	STREAM_ENVELOPE_ERROR_PREFIX,
} from "./classes";
import {
	is402BillingCapBody,
	isAccountScopedCapText,
	isDashScopeTokenLimitText,
	isOpaqueStatusBody,
	isUsageLimitStatus,
	matchesUsageLimitText,
	parseRateLimitReason,
} from "./rate-limit";

export const Flag = {
	Class: 0x1000,
	ThinkingLoop: 0x0001_0000,
	Transient: 0x0002_0000,
	Timeout: 0x0004_0000,
	UsageLimit: 0x0008_0000,
	StaleResponsesItem: 0x0010_0000,
	MalformedFunctionCall: 0x0020_0000,
	ProviderFinishError: 0x0040_0000,
	EmptyResponse: 0x0000_2000,
	ContentBlocked: 0x0000_8000,
	/** Account-scoped provider policy denial that may succeed with another credential. */
	AccountPolicy: 0x0000_4000,
	ContextOverflow: 0x0080_0000,
	AuthFailed: 0x0100_0000,
	SilentAbort: 0x0200_0000,
	UserInterrupt: 0x0400_0000,
	Abort: 0x0800_0000,
	/** Strict-tool rejection (400): grammar too large, schema too complex, or structured outputs unsupported by the model/endpoint. */
	Grammar: 0x1000_0000,
	/** Anthropic model/account does not support fast mode / the `speed` parameter. */
	FastModeUnsupported: 0x2000_0000,
	/** OAuth refresh failed definitively — the stored grant is dead, re-login required. */
	OAuthExpiry: 0x4000_0000,
	/** HTTP 413 byte/media rejection — token compaction cannot shrink bytes or media budgets (#9235). */
	PayloadRejected: 0x8000_0000,
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
	Flag.EmptyResponse |
	Flag.ContentBlocked |
	Flag.AccountPolicy |
	Flag.ContextOverflow |
	Flag.AuthFailed |
	Flag.PayloadRejected |
	Flag.SilentAbort |
	Flag.UserInterrupt |
	Flag.Abort |
	Flag.Grammar |
	Flag.FastModeUnsupported |
	Flag.OAuthExpiry;

const RETRIABLE_KINDS =
	Flag.Transient |
	Flag.UsageLimit |
	Flag.ThinkingLoop |
	Flag.StaleResponsesItem |
	Flag.ProviderFinishError |
	Flag.EmptyResponse;

const CONTEXT_OVERFLOW_EVIDENCE_PATTERNS = [
	/prompt is too long/i, // Anthropic
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (all backends)
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
	/request_too_large[^\n]*\btokens?\b/i,
	/\btokens?\b[^\n]*request_too_large/i,
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt filled the context window/i, // Ollama OpenAI-compatible empty length completion
	/exceeds the limit of \d+ tokens?\b/i,
	/chat history exceeds the \d+-message limit/i, // Provider message-count cap
] as const;
// Numeric limit pattern — also matches media budgets, so must never veto a payload flag (#9235).
const GENERIC_LIMIT_OVERFLOW_PATTERN = /exceeds the limit of \d+/i;
const OVERFLOW_PATTERNS = [...CONTEXT_OVERFLOW_EVIDENCE_PATTERNS, GENERIC_LIMIT_OVERFLOW_PATTERN];

/** Token-context evidence only — excludes GENERIC_LIMIT_OVERFLOW_PATTERN which media budgets also match (#9235). */
function hasTokenContextOverflowEvidence(text: string): boolean {
	return CONTEXT_OVERFLOW_EVIDENCE_PATTERNS.some(p => p.test(text));
}

/** Checks every cause-chain link; a wrapper whose nested 413 names the token budget stays overflow-only (#9235). */
function hasCauseTokenContextOverflowEvidence(error: unknown): boolean {
	const seen = new Set<object>();
	let link: unknown = error;
	while (link !== undefined && link !== null) {
		if (typeof link !== "object") {
			if (typeof link === "string" && hasTokenContextOverflowEvidence(link)) return true;
			break;
		}
		if (seen.has(link)) break;
		seen.add(link);
		if ("message" in link) {
			const message: unknown = link.message;
			if (typeof message === "string" && hasTokenContextOverflowEvidence(message)) return true;
		}
		if ("cause" in link) {
			link = link.cause;
			continue;
		}
		break;
	}
	return false;
}

const OVERFLOW_NO_BODY_PATTERN = /\b4(00|13)\s*(status code)?\s*\(no body\)/i;
// Bare `413 (no body)` deliberately dual-flagged; maintenance arbitrates against local headroom (#9235).
const PAYLOAD_REJECTION_PATTERNS = [
	/\b413\s*(?:status code\s*)?\(no body\)/i,
	/\b413\b[^.\n]{0,120}\b(?:request|payload|entity|body)\b[^.\n]{0,60}\b(?:exceed|too large|limit)/i,
	/request_too_large/i,
	/(?:payload|entity) too large/i,
	/request exceeds the maximum (?:size|number of bytes)/i,
] as const;

function matchesPayloadRejectionText(text: string): boolean {
	if (!PAYLOAD_REJECTION_PATTERNS.some(p => p.test(text))) return false;
	// Token-context evidence vetoes; only token wording counts — generic numeric limits also match media budgets.
	if (hasTokenContextOverflowEvidence(text)) return false;
	return true;
}

const TIMEOUT_PATTERN = /\b(?:operation\s+)?timed?\s*out\b|\btimeout\b|\bstream stall\b/i;
const TRANSIENT_ENVELOPE_PATTERN = /anthropic stream envelope error:/i;
const TRANSIENT_ENVELOPE_TRUNCATION_PATTERN = /before message_(?:start|stop)/i;
export const STREAM_READ_ERROR_PATTERN = /stream[_ -]?read[_ -]?error/i;
export const TRANSIENT_TRANSPORT_PATTERN =
	/\b(?:no[_ -]?capacity|(?:high|peak)[ _-]?demand|(?:at|over|insufficient)[ _-]?capacity|capacity[ _-]?(?:exceeded|exhausted)|peak[ _-]?load)\b|overloaded|provider.?returned.?error|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|unable.?to.?connect\.\s*is the computer able to access the url\?|other side closed|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|nghttp2_(?:internal_error|refused_stream)|stream closed with error code nghttp2_(?:internal_error|refused_stream)|malformed.?function.?call/i;
const AUTH_FAILURE_PATTERN =
	/\b(?:401|403|unauthorized|forbidden|authentication|auth[_ ]?unavailable|no auth available|(?:invalid|no)[_ ]?api[_ ]?key)\b/i;
const MALFORMED_FUNCTION_CALL_PATTERN = /\bmalformed.?function.?call\b/i;
const PROVIDER_FINISH_ERROR_PATTERN = /\bProvider (?:returned error finish_reason|finish_reason:\s*error)\b/i;
const EMPTY_RESPONSE_PATTERN = /\bthought-only response without final output\b/i;
const CONTENT_FILTER_PATTERN = /\b(?:incomplete:\s*)?content_filter\b/i;
const ACCOUNT_POLICY_PATTERN = /\bcyber_policy\b|trusted access for cyber/i;
const CODEX_CHATGPT_ACCOUNT_MODEL_POLICY_PATTERN =
	/\bThe ['"]([^'"\r\n]+)['"] model is not supported when using Codex with a ChatGPT account\./i;
const CODEX_CHATGPT_ACCOUNT_MODEL_MAX_LENGTH = 256;
const CURSOR_PLAN_POLICY_MARKER_PATTERN = /\bERROR_RATE_LIMITED_CHANGEABLE\b/i;
const CURSOR_PLAN_POLICY_PATTERN = /\bNamed models unavailable\b|\bModel unavailable on\b|\bFree plans can only use\b/i;

function isCursorPlanPolicyText(text: string): boolean {
	return CURSOR_PLAN_POLICY_MARKER_PATTERN.test(text) && CURSOR_PLAN_POLICY_PATTERN.test(text);
}

function normalizeCodexChatGPTAccountPolicyModel(modelId: string | undefined): string | undefined {
	if (typeof modelId !== "string") return undefined;
	const separator = modelId.lastIndexOf("/");
	const bareModelId = (separator === -1 ? modelId : modelId.slice(separator + 1)).trim().toLowerCase();
	if (!bareModelId || bareModelId.length > CODEX_CHATGPT_ACCOUNT_MODEL_MAX_LENGTH || bareModelId.includes("\0")) {
		return undefined;
	}
	return bareModelId;
}

function codexChatGPTAccountPolicyModelFromText(text: string): string | undefined {
	const modelId = CODEX_CHATGPT_ACCOUNT_MODEL_POLICY_PATTERN.exec(text)?.[1]?.trim();
	return normalizeCodexChatGPTAccountPolicyModel(modelId) === undefined ? undefined : modelId;
}

function isCodexChatGPTAccountPolicyText(
	text: string,
	provider: string | undefined,
	modelId: string | undefined,
): boolean {
	if (provider !== "openai-codex") return false;
	const deniedModel = codexChatGPTAccountPolicyModelFromText(text);
	const deniedIdentity = normalizeCodexChatGPTAccountPolicyModel(deniedModel);
	const requestedIdentity = normalizeCodexChatGPTAccountPolicyModel(modelId);
	return deniedIdentity !== undefined && deniedIdentity === requestedIdentity;
}
const STALE_RESPONSE_ITEM_PATTERNS = [/\bItem with id ['"][^'"]+['"] not found\.?/i, /previous[ _]?response/i] as const;
const STALE_RESPONSE_ITEM_DETAIL_PATTERN = /not[ _]?found|invalid|expired|stale|zero[ _-]?data[ _-]?retention/i;
/**
 * Local llama.cpp / Ollama deterministic tool-call argument JSON parse failure.
 * The model emitted invalid JSON in a tool call and the server returned HTTP 500
 * with this exact text — replaying the same prompt yields the same malformed
 * output, so callers strip {@link Flag.Transient} when this matches.
 */
export const LLAMA_CPP_TOOL_CALL_PARSE_PATTERN =
	/failed to parse tool call arguments as json|\[json\.exception\.parse_error\.101\]/i;

// Copilot fleet skew: HTTP 400 `model_not_supported` can reject a model that
// `/models` advertised on the same host when the request lands on a stale
// replica. `model_not_available_for_integrator` is deliberately excluded:
// GitHub also uses it for stable per-integrator entitlement denials and includes
// that integrator's actionable `Available models` list in the response.
const COPILOT_TRANSIENT_MODEL_CODES: Record<string, true> = {
	model_not_supported: true,
};
const COPILOT_TRANSIENT_MODEL_PATTERN = /model_not_supported/i;
// Fireworks (and other OpenAI-compat backends) can abort mid-generation with an
// HTTP 400 `invalid_request_error` whose body reports a model-side numerical
// fault: "Floating point NaN (not-a-number) is detected in generation". Despite
// the request-validation wrapper this is a decode-time logits overflow, not a
// bad request — a byte-identical replay of the same payload succeeds. The fault
// fires before any content is emitted, so retry is replay-safe. Kept narrow
// (both the NaN wording and "detected in generation") so it cannot swallow
// genuine request-validation 400s.
const GENERATION_NAN_PATTERN = /floating[ _-]?point nan\b.*\bdetected in generation/is;
// Anthropic strict-tool grammar too large / schema too complex (400 invalid_request_error).
// Feature-gated deployments (Azure Foundry, Baseten, …) reject `strict: true`
// tools outright when the hosted model lacks structured outputs, e.g.
// "structured_outputs not supported" — without an invalid_request_error wrapper.
const GRAMMAR_TOO_LARGE_PATTERN = /compiled grammar/i;
const GRAMMAR_TOO_LARGE_DETAIL_PATTERN = /too large/i;
const SCHEMA_TOO_COMPLEX_PATTERN = /schema/i;
const SCHEMA_TOO_COMPLEX_DETAIL_PATTERN = /too complex/i;
const SCHEMA_COMPILE_PATTERN = /compil/i;
const INVALID_REQUEST_PATTERN = /invalid_request_error/i;
const STRUCTURED_OUTPUTS_PATTERN = /structured[_ -]?outputs?/i;
const FEATURE_NOT_SUPPORTED_PATTERN = /not (?:supported|available|enabled)|unsupported|does(?: not|n'?t) support/i;
const ANTHROPIC_STRICT_FIELD_PATTERN = /\btools\.\d+\.custom\.strict\b/i;
const EXTRA_INPUTS_NOT_PERMITTED_PATTERN = /extra inputs? (?:are|is) not permitted/i;
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

function matchesStrictToolsRejection(message: string, errorStatus: number | undefined): boolean {
	if (errorStatus !== 400) return false;
	if (ANTHROPIC_STRICT_FIELD_PATTERN.test(message) && EXTRA_INPUTS_NOT_PERMITTED_PATTERN.test(message)) {
		return true;
	}
	if (STRUCTURED_OUTPUTS_PATTERN.test(message) && FEATURE_NOT_SUPPORTED_PATTERN.test(message)) return true;
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
	[Flag.EmptyResponse, "empty-response"],
	[Flag.ContentBlocked, "content-blocked"],
	[Flag.AccountPolicy, "account-policy"],
	[Flag.ContextOverflow, "context-overflow"],
	[Flag.PayloadRejected, "payload-rejected"],
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
	if (is(id, Flag.ContentBlocked)) return false;
	if (is(id, Flag.PayloadRejected)) return false;
	if (opts?.replayUnsafe) return false;
	if (is(id, Flag.MalformedFunctionCall)) return true;
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

export function isStreamReadErrorText(text: string): boolean {
	return STREAM_READ_ERROR_PATTERN.test(text);
}

/** Persisted-text form of {@link isStreamEnvelopeError}: recognizes the
 *  prefix-tagged envelope diagnostic on an aborted turn's `errorMessage` /
 *  `stopDetails.explanation` so loop-level salvage can classify it after the
 *  original `Error` instance is gone. */
export function isStreamEnvelopeErrorText(text: string): boolean {
	return text.includes(STREAM_ENVELOPE_ERROR_PREFIX);
}

function isTransientErrorText(text: string): boolean {
	return (
		isUnexpectedSocketCloseMessage(text) ||
		isStreamReadErrorText(text) ||
		(TRANSIENT_ENVELOPE_PATTERN.test(text) && TRANSIENT_ENVELOPE_TRUNCATION_PATTERN.test(text)) ||
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

function isContentBlockedText(text: string): boolean {
	return CONTENT_FILTER_PATTERN.test(text);
}

function matchesOverflowText(text: string): boolean {
	return OVERFLOW_PATTERNS.some(p => p.test(text)) || OVERFLOW_NO_BODY_PATTERN.test(text);
}

function classifyText(
	errorMessage: string | undefined,
	errorStatus: number | undefined,
	priorTokenOverflowEvidence = false,
	api?: Api,
	provider?: string,
	modelId?: string,
): number {
	let kinds = 0;
	if (errorMessage) {
		if (matchesOverflowText(errorMessage)) kinds |= Flag.ContextOverflow;
		if (matchesPayloadRejectionText(errorMessage)) kinds |= Flag.PayloadRejected;
		if (isMalformedFunctionCallText(errorMessage)) kinds |= Flag.MalformedFunctionCall;
		if (isProviderFinishErrorText(errorMessage)) kinds |= Flag.ProviderFinishError;
		if (EMPTY_RESPONSE_PATTERN.test(errorMessage)) kinds |= Flag.EmptyResponse | Flag.Transient;
		if (isContentBlockedText(errorMessage)) kinds |= Flag.ContentBlocked;
		if (
			ACCOUNT_POLICY_PATTERN.test(errorMessage) ||
			isCodexChatGPTAccountPolicyText(errorMessage, provider, modelId) ||
			(provider === "cursor" && isCursorPlanPolicyText(errorMessage))
		) {
			kinds |= Flag.AccountPolicy | Flag.ContentBlocked;
		}
		if (isAuthFailureText(errorMessage)) kinds |= Flag.AuthFailed;

		const statusClean = errorStatus ? errorStatus : (status({ message: errorMessage }) ?? undefined);
		const cleanMessage = errorMessage;
		const isOpaque = isOpaqueStatusBody(cleanMessage);

		const isLimitStatus = isUsageLimitStatus(statusClean);
		const reason = parseRateLimitReason(cleanMessage);
		const is402BillingCap = statusClean === 402 && is402BillingCapBody(cleanMessage);
		// Concurrency caps (e.g. Vertex "Online prediction concurrent requests
		// quota exceeded") are shed-and-backoff, not credential-rotatable —
		// exclude them even when the quota-worded phrasing matches the generic
		// usage-limit text matcher, whose `quota.?exceeded` arm would otherwise
		// set Flag.UsageLimit and burn a healthy sibling credential. HTTP 402 is
		// excluded from this gate: a 402 whose body merely mentions concurrency
		// still classifies as a usage limit, mirroring isUsageLimitOutcome.
		const concurrencyExcluded = reason === "CONCURRENT_LIMIT" && statusClean !== 402;
		if (
			!concurrencyExcluded &&
			(is402BillingCap ||
				matchesUsageLimitText(cleanMessage) ||
				((statusClean === 403 || statusClean === undefined) && isAccountScopedCapText(cleanMessage)) ||
				(isLimitStatus && (isOpaque || reason === "QUOTA_EXHAUSTED")))
		) {
			kinds |= Flag.UsageLimit;
		}
		if (isTimeoutText(errorMessage)) kinds |= Flag.Transient | Flag.Timeout;
		else if (isTransientErrorText(errorMessage)) kinds |= Flag.Transient;
		// A concurrency cap (e.g. Vertex "Online prediction concurrent requests
		// quota exceeded") is transient — shed-and-backoff. The bare wording need
		// not match TRANSIENT_TRANSPORT_PATTERN, so flag it explicitly to keep
		// AIError.retriable from treating the temporary cap as terminal.
		if (reason === "CONCURRENT_LIMIT") kinds |= Flag.Transient;
		if ((api === "openai-responses" || api === "openai-codex-responses") && isStaleResponsesText(errorMessage)) {
			kinds |= Flag.StaleResponsesItem;
		}

		// Copilot's `model_not_supported` fleet-skew rejection is transient.
		if (statusClean === 400 && COPILOT_TRANSIENT_MODEL_PATTERN.test(cleanMessage)) kinds |= Flag.Transient;
		// Fireworks mid-generation NaN 400 is a model-side decode fault, not a bad
		// request; a byte-identical replay succeeds, so treat it as transient.
		if (statusClean === 400 && GENERATION_NAN_PATTERN.test(cleanMessage)) kinds |= Flag.Transient;
		if (matchesStrictToolsRejection(cleanMessage, statusClean)) kinds |= Flag.Grammar;
		if (matchesFastModeUnsupported(cleanMessage, statusClean)) kinds |= Flag.FastModeUnsupported;
	}
	// Status-only 413: infer PayloadRejected unless prior classification carries token-context evidence (#9235).
	const statusEvidence = errorStatus ?? (errorMessage ? status({ message: errorMessage }) : undefined);
	if (
		statusEvidence === 413 &&
		!priorTokenOverflowEvidence &&
		!(errorMessage && hasTokenContextOverflowEvidence(errorMessage))
	) {
		kinds |= Flag.PayloadRejected;
	}
	if (statusEvidence === 402 && (errorMessage === undefined || isOpaqueStatusBody(errorMessage))) {
		kinds |= Flag.UsageLimit;
	}
	if (kinds !== 0) return create(kinds);
	const fallbackStatus = errorStatus ?? (errorMessage ? status({ message: errorMessage }) : undefined);
	if (fallbackStatus === 401 || fallbackStatus === 403) return create(Flag.AuthFailed);
	return fallbackStatus ?? 0;
}

export function classify(error: unknown, api?: Api): number {
	let kinds = 0;
	const seen = new Set<object>();
	const causeTokenEvidence = hasCauseTokenContextOverflowEvidence(error);
	let link: unknown = error;
	while (link !== undefined && link !== null) {
		if (typeof link === "object") {
			if (seen.has(link)) break;
			seen.add(link);

			if ("errorId" in link && typeof (link as { errorId: unknown }).errorId === "number") {
				kinds |= (link as { errorId: number }).errorId & KIND_MASK;
			}
			if ("code" in link && typeof link.code === "string" && ACCOUNT_POLICY_PATTERN.test(link.code)) {
				kinds |= Flag.AccountPolicy | Flag.ContentBlocked;
			}
		}

		if (link instanceof AwsCredentialsError) {
			kinds |= Flag.AuthFailed;
		} else if (link instanceof AnthropicConnectionTimeoutError) {
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
			if (
				code === "usage_limit_reached" ||
				(code === "insufficient_quota" && !isDashScopeTokenLimitText(link.message)) ||
				(codeStatus === 402 &&
					(code === "payment_required" || code === "deactivated_workspace" || is402BillingCapBody(link.message)))
			) {
				linkKinds |= Flag.UsageLimit;
			}
			if (code === "overloaded_error" || code === "rate_limit_error") {
				linkKinds |= Flag.Transient;
			}
			if (
				(codeStatus === 401 || codeStatus === 403) &&
				!(codeStatus === 403 && parseRateLimitReason(link.message) === "CONCURRENT_LIMIT")
			) {
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

		const textId = classifyText(linkMessage, status(link), causeTokenEvidence, api);
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

/** Whether an upstream rejection is an account-scoped policy denial worth retrying with a sibling credential. */
export function isAccountPolicyError(error: unknown, api?: Api): boolean {
	return is(classify(error, api), Flag.AccountPolicy);
}

/**
 * Model id from Codex's exact ChatGPT-account entitlement denial. Generic
 * unsupported-model invalid requests deliberately do not match.
 */
export function codexChatGPTAccountPolicyModel(error: unknown, depth = 0): string | undefined {
	if (depth > 6) return undefined;
	if (typeof error === "string") return codexChatGPTAccountPolicyModelFromText(error);
	if (!error || typeof error !== "object") return undefined;
	const errorMessage =
		"errorMessage" in error && typeof error.errorMessage === "string" ? error.errorMessage : undefined;
	const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
	const direct =
		(errorMessage ? codexChatGPTAccountPolicyModelFromText(errorMessage) : undefined) ??
		(message ? codexChatGPTAccountPolicyModelFromText(message) : undefined);
	if (direct !== undefined) return direct;
	return "cause" in error ? codexChatGPTAccountPolicyModel(error.cause, depth + 1) : undefined;
}

/** Whether the exact Codex entitlement denial applies to this provider and requested model. */
export function isCodexChatGPTAccountPolicyError(
	error: unknown,
	provider: string,
	modelId: string | undefined,
): boolean {
	const deniedModel = codexChatGPTAccountPolicyModel(error);
	const deniedIdentity = normalizeCodexChatGPTAccountPolicyModel(deniedModel);
	const requestedIdentity = normalizeCodexChatGPTAccountPolicyModel(modelId);
	return provider === "openai-codex" && deniedIdentity !== undefined && deniedIdentity === requestedIdentity;
}

/** Whether Cursor returned a non-retryable plan entitlement denial for this account. */
export function isCursorPlanAccountPolicyError(error: unknown, provider: string, depth = 0): boolean {
	if (provider !== "cursor" || depth > 6) return false;
	if (typeof error === "string") return isCursorPlanPolicyText(error);
	if (!error || typeof error !== "object") return false;
	if (
		"errorMessage" in error &&
		typeof error.errorMessage === "string" &&
		isCursorPlanPolicyText(error.errorMessage)
	) {
		return true;
	}
	if ("message" in error && typeof error.message === "string" && isCursorPlanPolicyText(error.message)) return true;
	return "cause" in error && isCursorPlanAccountPolicyError(error.cause, provider, depth + 1);
}

/**
 * Strict-tool rejection: grammar too large, schema too complex, or structured
 * outputs unsupported by the model/endpoint.
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
 * Depth-bounded search for a provider error `code`. SDK error objects keep the
 * parsed response body on `.error`, and Copilot's body is itself
 * `{ error: { code } }`, so the code sits up to two envelopes below the thrown
 * error depending on which SDK produced it.
 */
function providerErrorCode(error: object): string | undefined {
	let node: object = error;
	for (let depth = 0; depth < 3; depth++) {
		if ("code" in node && typeof node.code === "string") return node.code;
		if (!("error" in node)) return undefined;
		const nested: unknown = node.error;
		if (!nested || typeof nested !== "object") return undefined;
		node = nested;
	}
	return undefined;
}

/**
 * GitHub Copilot 400 `model_not_supported` response for a model advertised by
 * `/models` — transient fleet skew, not a malformed request. Reads the
 * structural `code` through the SDK/body envelopes, then falls back to the
 * stringified body both SDK families put in `message`.
 */
export function isCopilotTransientModelError(error: unknown): boolean {
	if (!error || typeof error !== "object" || status(error) !== 400) return false;
	const code = providerErrorCode(error);
	// `Object.hasOwn`, not a bare index: `code` is provider-controlled, and a
	// prototype key (`__proto__`, `toString`, …) would otherwise read truthy.
	if (code !== undefined && Object.hasOwn(COPILOT_TRANSIENT_MODEL_CODES, code)) return true;
	const message: unknown = "message" in error ? error.message : undefined;
	return typeof message === "string" && COPILOT_TRANSIENT_MODEL_PATTERN.test(message);
}

export function classifyMessage(message: {
	api?: Api;
	provider?: string;
	model?: string;
	errorId?: number;
	errorMessage?: string;
	errorClassificationMessage?: string;
	errorStatus?: number;
}): number {
	const existingId = message.errorId;
	const currentStatus = message.errorStatus ?? statusFromId(existingId);
	const existingOverflowOnly =
		existingId !== undefined && is(existingId, Flag.ContextOverflow) && !is(existingId, Flag.PayloadRejected);
	const classificationMessage = message.errorClassificationMessage ?? message.errorMessage;
	const textId = classifyText(
		classificationMessage,
		currentStatus,
		existingOverflowOnly,
		message.api,
		message.provider,
		message.model,
	);

	let kinds = ((existingId ?? 0) | textId) & KIND_MASK;
	// Two-phase finalization: drop stale status-inferred payload bit when final text proves token overflow (#9235).
	if (
		currentStatus === 413 &&
		classificationMessage &&
		hasTokenContextOverflowEvidence(classificationMessage) &&
		!(textId & Flag.PayloadRejected)
	) {
		kinds &= ~Flag.PayloadRejected;
	}
	if (classificationMessage && LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(classificationMessage)) {
		// Deterministic local-model tool-call JSON parse failure: HTTP 500 is misleading
		// because the same prompt reproduces the same malformed output, so the agent-level
		// auto-retry would loop. Strip Transient so the recovery message surfaces immediately.
		kinds &= ~Flag.Transient;
	}
	const id = kinds !== 0 ? create(kinds) : (statusFromId(textId) ?? statusFromId(existingId) ?? currentStatus ?? 0);

	message.errorId = id;
	return id;
}

export function attach<E extends object>(error: E, id: number): E {
	Object.defineProperty(error, "errorId", { value: id, enumerable: false, configurable: true });
	return error;
}

/** Provider-reported usage proves context-window excess — authoritative, compaction-owned (#9235). */
export function isUsageBackedContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	if (!contextWindow) return false;
	const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
	return inputTokens > contextWindow;
}

export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	if (is(message.errorId, Flag.ContextOverflow)) return true;
	if (isUsageBackedContextOverflow(message, contextWindow)) return true;
	return message.stopReason === "error" && !!message.errorMessage && matchesOverflowText(message.errorMessage);
}

/** HTTP 413 byte/media rejection (#9235); may co-occur with {@link isContextOverflow} for bare `413 (no body)`.
 *  Callers with local headroom should skip compaction when this returns true. */
export function isPayloadRejection(message: AssistantMessage): boolean {
	if (is(message.errorId, Flag.PayloadRejected)) return true;
	const { errorMessage } = message;
	if (message.stopReason !== "error" || !errorMessage) return false;
	return matchesPayloadRejectionText(errorMessage);
}

/** Dual-flagged 413 (PayloadRejected + ContextOverflow) with no provider-reported token excess (#9235).
 *  The co-flag means a different provider's larger byte/media budget may accept the request.
 *  Usage-backed overflows are authoritative window excesses and never ambiguous. */
export function isTextAmbiguousContextOverflow(
	errorId: number,
	message: AssistantMessage | undefined,
	contextWindow?: number,
): boolean {
	const overflowFlagged =
		is(errorId, Flag.ContextOverflow) || (message !== undefined && isContextOverflow(message, contextWindow));
	if (!overflowFlagged) return false;
	if (!is(errorId, Flag.PayloadRejected)) return false;
	return !(message !== undefined && isUsageBackedContextOverflow(message, contextWindow));
}

export function stringify(id: number | undefined): string {
	if (!id) return "none";
	if (!isClassified(id)) return `status:${id}`;
	const labels = ERROR_KIND_LABELS.filter(([kind]) => is(id, kind)).map(([, label]) => label);
	return labels.length > 0 ? labels.join("|") : `classified:0x${id.toString(16)}`;
}

const STREAM_PARSE_TRUNCATION_PATTERN =
	/unterminated string|unexpected end of json input|unexpected end of data|unexpected eof|end of file|eof while parsing|truncated/i;
const STREAM_PARSE_DIAGNOSTIC_PATTERN =
	/(?:json parse error:\s*(?:unterminated string|unexpected end of json input|unexpected end of data|unexpected eof|end of file|eof while parsing|truncated)|json\.parse:\s*(?:unterminated string|unexpected end of data)|unexpected end of json input|unexpected eof|eof while parsing)/i;
const STREAM_EVENT_ORDER_PATTERN = /stream event order|before message_start/i;

/**
 * Transient stream corruption where the response was truncated mid-JSON.
 *
 * Strings (persisted `stopDetails.explanation`/`errorMessage` diagnostics) are matched with the
 * stricter {@link STREAM_PARSE_DIAGNOSTIC_PATTERN} — bare "truncated"/"end of file" text is too
 * low-signal to trust once detached from a live transport `Error`, which keeps the broad pattern.
 */
export function isTransientStreamParseError(error: unknown): boolean {
	if (typeof error === "string") return STREAM_PARSE_DIAGNOSTIC_PATTERN.test(error);
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
