import { isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils/fetch-retry";
import type { Api, AssistantMessage, Usage } from "../types";
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
	type RateLimitReason,
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
	/**
	 * An Anthropic-compatible endpoint rejected the `cache_control` field with a
	 * 400, so prompt-cache breakpoints must be dropped for it.
	 *
	 * Every bit from {@link Flag.Class} up is already taken, so this claims a low
	 * bit instead. Those belong to the raw-status lane — an unclassified id is an
	 * HTTP status (100-599, see `statusFromId`) — and 0x800 is 2048, above every
	 * status value, so no raw status id can set it.
	 */
	CacheControlUnsupported: 0x0000_0800,
	/**
	 * The request died on the wire with no HTTP status: a socket or stream
	 * closed, a chunked transfer was cut mid-body, an SSE stream ended before
	 * its terminal event. Nothing the model produced caused it, and no lower
	 * retry budget covers it — `fetchWithRetry` and the provider's pre-output
	 * retry both end once a status line has arrived.
	 *
	 * Deliberately exclusive of capacity signals (429, 529, overloaded, quota):
	 * those say the host declined to serve, which another model can serve now.
	 * Also exclusive of any failure carrying a status, including a gateway's
	 * own 5xx — that one the transport already replayed on its own budget.
	 * Turn recovery uses the distinction to decide whether an identical replay
	 * is worth trying before the fallback chain advances.
	 *
	 * Claims a low bit for the reason {@link Flag.CacheControlUnsupported}
	 * documents: 0x400 is 1024, above every HTTP status, so no raw status id
	 * can set it.
	 */
	Connection: 0x0000_0400,
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
	Flag.CacheControlUnsupported |
	Flag.Connection |
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
	/\bprompt\s*\(\s*\d+\s+tokens\s*\)\s*\+\s*max\s+tokens\s*\(\s*\d+\s*\)\s+exceeds\s+the\s+context\s*\(\s*\d+\s*\)/i, // Strata server
	/\bprompt\s*\(\s*\d+\s+tokens\s*\)\s+leaves\s+no\s+room\s+to\s+answer\s+in\s+the\s+context\s*\(\s*\d+\s*\)/i, // Strata server
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
const TRANSIENT_ENVELOPE_TRUNCATION_PATTERN = /before message_(?:start|delta|stop)/i;
export const STREAM_READ_ERROR_PATTERN = /stream[_ -]?read[_ -]?error/i;
/** Python h2/httpx diagnostics forwarded through provider or proxy error events. */
export const PYTHON_HTTP2_STREAM_RESET_PATTERN = /<StreamReset stream_id:\d+, error_code:(?:2|7), remote_reset:True>/;
/** Python h11/httpx EOF while reading an HTTP/1.1 chunked response body. */
export const PYTHON_HTTP_INCOMPLETE_CHUNK_PATTERN =
	/peer closed connection without sending complete message body \(incomplete chunked read\)/;
/** reqwest body-frame failures forwarded by the Codex HTTP proxy. */
export const CODEX_HTTP_BODY_READ_ERROR_PATTERN = /\btransport error reading codex response body\b/i;

const RESPONSES_REQUEST_BODY_READ_TIMEOUT_PATTERN = /\btimed out reading request body\b/i;

/** Exact HTTP request-body-read timeout diagnostic. */
export function isRequestBodyReadTimeout(status: number | undefined, message: string | undefined): boolean {
	return status === 408 && RESPONSES_REQUEST_BODY_READ_TIMEOUT_PATTERN.test(message ?? "");
}

/** Exact pre-output Responses 408 that needs a changed-request recovery path. */
export function isResponsesRequestBodyReadTimeout(message: {
	api?: Api;
	errorStatus?: number;
	errorMessage?: string;
	requestBodyReadTimeoutFullReplay?: boolean;
}): boolean {
	return (
		message.api === "openai-responses" &&
		message.requestBodyReadTimeoutFullReplay === true &&
		isRequestBodyReadTimeout(message.errorStatus, message.errorMessage)
	);
}

/**
 * Codex code for the experimental native turn lane refusing a mid-response
 * `response.steer`; the server then drops the in-flight response and closes
 * the socket.
 */
export const CODEX_NATIVE_LANE_STEER_REJECTED_CODE = "unsupported_native_inflight_message";

/**
 * A Codex turn the native turn lane dropped because omp steered it. The
 * rejection answers our own `response.steer`, not the model's health: the
 * provider stops steering the session, so the same model replays cleanly.
 */
export function isCodexSteerRejection(message: { api?: Api; errorMessage?: string }): boolean {
	return (
		message.api === "openai-codex-responses" &&
		message.errorMessage?.includes(`code=${CODEX_NATIVE_LANE_STEER_REJECTED_CODE}`) === true
	);
}

/**
 * Transport-failure wording that marks an error transient. Covers
 * diagnostics forwarded verbatim by gateways/proxies in other runtimes, e.g.
 * undici's "other side closed" and Go's `net.ErrClosed` ("use of closed
 * network connection", #15385). Also covers OMP's own network-failure
 * sentences from `networkFailureMessage` (offline / unreachable / refused /
 * TLS), which must stay at least as retryable as the bare `Connection error.`
 * text they replaced.
 */
export const TRANSIENT_TRANSPORT_PATTERN =
	/\b(?:no[_ -]?capacity|(?:high|peak)[ _-]?demand|(?:at|over|insufficient)[ _-]?capacity|capacity[ _-]?(?:exceeded|exhausted)|peak[ _-]?load)\b|overloaded|provider.?returned.?error|rate.?limit|too many requests|auth-gateway\s+5\d{2}(?=[:\s]|$)|\b(?:429|500|502|503|504)\b|service.?unavailable|temporar(?:y|ily)[ _-]?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|unable.?to.?connect\.\s*is the computer able to access the url\?|other side closed|use of closed network connection|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|nghttp2_(?:internal_error|refused_stream)|stream closed with error code nghttp2_(?:internal_error|refused_stream)|\bE(?:TIMEOUT|NOTFOUND|NETUNREACH|HOSTUNREACH)\b|\bFailedToOpenSocket\b|no internet connection|couldn.?t reach|couldn.?t connect to|tls certificate verification failed|malformed.?function.?call/i;
const AUTH_FAILURE_PATTERN =
	/\b(?:401|403|unauthorized|forbidden|authentication|auth[_ ]?unavailable|no auth available|(?:invalid|no)[_ ]?api[_ ]?key)\b/i;
const MALFORMED_FUNCTION_CALL_PATTERN =
	/\b(?:malformed[_. ]?(?:function[_. ]?call|response)|unexpected[_. ]?tool[_. ]?call)\b/i;
const PROVIDER_FINISH_ERROR_PATTERN = /\bProvider (?:returned error finish_reason|finish_reason:\s*error)\b/i;
const EMPTY_RESPONSE_PATTERN = /\bthought-only response without final output\b/i;
const CONTENT_FILTER_PATTERN = /\b(?:incomplete:\s*)?content_filter\b/i;
const ACCOUNT_POLICY_PATTERN = /\bcyber_policy\b|trusted access for cyber/i;
export const ANTHROPIC_ACCOUNT_POLICY_PATTERN =
	/\b(?:oauth_not_allowed_for_organization|permission_error)\b|\bOAuth authentication is currently not allowed for this organization\b/i;

/** Whether an error message represents an Anthropic account-scoped permission/policy denial. */
export function isAnthropicAccountPolicyText(text: string, provider?: string, statusArg?: number): boolean {
	if (provider !== undefined && provider !== "anthropic") return false;
	const statusCandidate = statusArg ?? (text ? status({ message: text }) : undefined);
	if (statusCandidate !== undefined && statusCandidate !== 403) return false;
	return ANTHROPIC_ACCOUNT_POLICY_PATTERN.test(text);
}

const IMMUTABLE_LATEST_THINKING_PATTERN =
	/messages\.\d+\.content\.\d+.*\b(?:thinking|redacted_thinking)\b.*\blatest assistant message cannot be modified\b/is;

/**
 * Anthropic's rejection of a replayed latest assistant turn whose `thinking` or
 * `redacted_thinking` blocks no longer verify. Resending the same turn fails the
 * same way; only a request that changes that turn's reasoning can succeed.
 */
export function isImmutableLatestThinkingText(text: string): boolean {
	return IMMUTABLE_LATEST_THINKING_PATTERN.test(text);
}

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

// Fireworks (and other OpenAI-compat backends) can abort mid-generation with an
// HTTP 400 `invalid_request_error` whose body reports a model-side numerical
// fault: "Floating point NaN (not-a-number) is detected in generation". Despite
// the request-validation wrapper this is a decode-time logits overflow, not a
// bad request — a byte-identical replay of the same payload succeeds. The fault
// fires before any content is emitted, so retry is replay-safe. Kept narrow
// (both the NaN wording and "detected in generation") so it cannot swallow
// genuine request-validation 400s.
const GENERATION_NAN_PATTERN = /floating[ _-]?point nan\b.*\bdetected in generation/is;
// Aliyun DashScope's compatible-mode multimodal gateway intermittently fails
// perfectly valid inline image payloads with a validation-flavored 400:
// "The provided URL does not appear to be valid" or "Download multimodal file
// timed out" (InternalError.Algo.InvalidParameter). The gateway's internal
// fetch/decode of the data-URL image flakes; a byte-identical replay of the
// same payload succeeds (verified against production with the original
// failing request). Kept narrow to these two gateway phrasings so genuine
// request-validation 400s stay terminal; the retry budget bounds a truly bad
// payload to maxRetries attempts before it surfaces anyway.
export const ALIYUN_MM_GATEWAY_PATTERN = /provided url does not appear to be valid|download multimodal file timed out/i;
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
// Upstream strict-schema validation surfaced through a translating gateway.
// Vercel AI Gateway serves non-Anthropic upstreams on its Anthropic
// `/v1/messages` route and applies Anthropic's `strict: true` to an OpenAI
// function tool. OpenAI strict mode additionally demands every `properties`
// key in `required`, which Anthropic's strict subset does not, so a
// legally-optional parameter is rejected only after translation and the sole
// recovery is dropping `strict`. Mirrors the phrasings
// `shouldRetryWithoutStrictTools` already recognizes on the OpenAI-family path.
const STRICT_TOOL_SCHEMA_REJECTION_PATTERN = /invalid schema for function|invalid tool parameters schema/i;
// Anthropic fast-mode unsupported: 400 rejecting `speed`, or 429 rate_limit_error
// because the account lacks the extra-usage entitlement fast mode requires.
const FAST_MODE_SPEED_PARAM_PATTERN = /\bspeed\b/i;
const FAST_MODE_NOT_SUPPORTED_PATTERN = /not support/i;
const FAST_MODE_RATE_LIMIT_PATTERN = /rate_limit_error/i;
const FAST_MODE_ENTITLEMENT_PATTERN = /fast mode/i;
// Anthropic-compatible proxies that do not implement prompt caching reject the
// `cache_control` field itself with a 400 naming it. Requires rejection wording
// so a 400 that merely mentions the field for another reason stays terminal.
//
// The trigger is deliberately a bare mention. Whether such a 400 refused the
// field or one option *under* it — `ttl`, `scope` — is not decidable from the
// message. The forward direction is: punctuation between the field and a
// following member proves the member is the next token, for any joiner, without
// enumerating them. The backward direction is not, and it is where four rounds
// of this rule died. Prose subordinates a member to the field through an
// English connective, grammar does not partition the way syntax does, and
// `unsupported content type for cache_control` is unresolvable in principle:
// `type` is both a member of `CacheControlEphemeral` and an ordinary noun, and
// the construction that clause uses is the construction a real member refusal
// uses. A rule that decides one direction and guesses the other still hands its
// caller a partition the caller cannot trust.
//
// So this predicate answers only "this 400 is about `cache_control`", and the
// retry ladder in `providers/anthropic.ts` asks the endpoint the rest. When the
// failing request carried `ttl` or `scope`, the ladder replays with every
// breakpoint intact and those options removed, and the rung that carries the
// turn names what was refused: that rung succeeding means the field is
// supported and an option was not, so short-lived caching stays on for the
// session instead of being latched off by a reading of the prose. When the
// request carried neither option a nested refusal is impossible — `type` is
// mandatory and its only legal value is constant — so the ladder starts at the
// breakpoint-free replay, which is the behavior this predicate has always had.
const CACHE_CONTROL_FIELD_PATTERN = /\bcache_control\b/i;
const CACHE_CONTROL_REJECTION_PATTERN =
	/\bunexpected\b|\bunrecognized\b|\bnot permitted\b|\bnot allowed\b|\bnot recognized\b|\bnot supported\b|\bunsupported\b|\binvalid[_ ]field\b|\bextra (?:inputs?|fields?)\b/i;
// The bare-word gate above reads prose, and `_` is a word character, so it
// misses every snake_cased error code: `\bunsupported\b` never fires on
// `unsupported_parameter`, `\bunrecognized\b` never fires on
// `unrecognized_keys`. Strict decoders and OpenAI-compatible validators report
// a refused *member* rather than a forbidden extra input, either as a negation
// (`json: unknown field "cache_control"` — Go `DisallowUnknownFields`;
// `unknown_parameter` — OpenAI-compatible error codes; `Unpermitted parameter`
// — Rails strong parameters; `is not a valid field` — hand-rolled validators)
// or as a bare adjective (`Invalid parameter: cache_control` and the
// `invalid_parameter` / `unsupported_parameter` codes — OpenAI-compatible;
// `unrecognized_keys` — a strict Zod object, which is how this repo's own
// auth-broker 400'd an extension field; `invalid_argument` — the gRPC/Connect
// canonical code; `Unknown name "cache_control": Cannot find field` —
// protojson, so every Google-gateway-fronted deployment).
//
// Both families stay anchored to a schema-member noun one joiner away, and that
// anchor is the false-positive bound: `invalid_request_error` prefixes nearly
// every Anthropic 400 and still cannot match, because `request` is not a member
// noun. `value` is absent for the same reason — a 400 refusing a cache_control
// *value* while naming no member says nothing about the field.
const CACHE_CONTROL_MEMBER_REFUSAL_PATTERN =
	/\b(?:un(?:known|permitted|supported|recognized|expected)|invalid|bad|not (?:an? )?(?:known|valid|accepted|supported|permitted|allowed|recognized))[_ -](?:field|name|param(?:eter)?|argument|key|propert(?:y|ies)|attribute|member|option|input)s?\b/i;
// Anthropic rejects a breakpoint on an empty text block with a 400 that names
// `cache_control` too. That is a content-shape fault — dropping every
// breakpoint neither fixes it nor proves the endpoint lacks prompt caching.
const CACHE_CONTROL_EMPTY_TEXT_PATTERN =
	/empty text block|text content block.*non-(?:empty|whitespace)|text.{0,40}must (?:be non-empty|not be empty)/i;
// Definitive OAuth refresh failure — the stored grant/client is dead.
const OAUTH_DEFINITIVE_FAILURE_PATTERN =
	/invalid_grant|invalid_token|unauthorized_client|\brevoked\b|refresh[\s_]?token.*expired/i;
const OAUTH_TRANSIENT_FAILURE_PATTERN =
	/timeout|network|fetch failed|ECONN(?:REFUSED|RESET)|ETIMEDOUT|ETIMEOUT|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|FailedToOpenSocket|EAI_AGAIN|socket hang up|\b(?:408|425|429|5\d{2})\b|rate.?limit|too many requests|temporar|unavailable|forbidden|permission_denied|cloudflare|captcha/i;
const OAUTH_HTTP_AUTH_PATTERN = /\b401\b/;

function matchesStrictToolsRejection(message: string, errorStatus: number | undefined): boolean {
	if (errorStatus !== 400) return false;
	if (ANTHROPIC_STRICT_FIELD_PATTERN.test(message) && EXTRA_INPUTS_NOT_PERMITTED_PATTERN.test(message)) {
		return true;
	}
	if (STRUCTURED_OUTPUTS_PATTERN.test(message) && FEATURE_NOT_SUPPORTED_PATTERN.test(message)) return true;
	if (STRICT_TOOL_SCHEMA_REJECTION_PATTERN.test(message)) return true;
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

function matchesCacheControlRejection(message: string, errorStatus: number | undefined): boolean {
	if (errorStatus !== 400) return false;
	if (!CACHE_CONTROL_FIELD_PATTERN.test(message)) return false;
	if (CACHE_CONTROL_EMPTY_TEXT_PATTERN.test(message)) return false;
	return CACHE_CONTROL_REJECTION_PATTERN.test(message) || CACHE_CONTROL_MEMBER_REFUSAL_PATTERN.test(message);
}

/** Whether an OAuth refresh error message means the grant is definitively dead. */
export function isOAuthExpiry(errorMessage: string): boolean {
	if (OAUTH_DEFINITIVE_FAILURE_PATTERN.test(errorMessage)) return true;
	return OAUTH_HTTP_AUTH_PATTERN.test(errorMessage) && !OAUTH_TRANSIENT_FAILURE_PATTERN.test(errorMessage);
}

const ERROR_KIND_LABELS: readonly [Flag, string][] = [
	[Flag.ThinkingLoop, "thinking-loop"],
	[Flag.Transient, "transient"],
	[Flag.Connection, "connection"],
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

/** A URL: its digits are a host, port, path or query, never the status of the response. */
const URL_PATTERN = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi;
/**
 * A `key=value` or `key: value` field with a number for its value, the value
 * quoted or not. Which of them name a status is decided by
 * {@link STATUS_FIELD_KEY}; every other value is metadata — a duration
 * (`retry-after-ms=401`, `elapsed_ms="503"`), an id (`request_id=529`, Python
 * h2's `stream_id:503`, Go's `LastStreamID=503`), a frame code (`error_code:2`),
 * a size.
 */
const FIELD_NUMBER_PATTERN = /(["']?)([A-Za-z][\w.-]*)\1\s*([:=])\s*(["']?)(\d+(?:\.\d+)?)\4/g;
/**
 * The field keys whose number is an HTTP status: `status`, `status_code`,
 * `statusCode`, `http_status`, `upstream_status`, `x-http-status`, `code`,
 * `http_code`, and the `error: 503` / `failed: 503` spellings the status reader
 * already takes.
 */
const STATUS_FIELD_KEY = /status(?:[_-]?code)?$|^(?:code|http[_-]?code|error|failed|http)$/i;
/**
 * A key that names an amount of time: a time word anywhere in it (`elapsed`,
 * `duration`, `latency`, `delay`, `timeout`, `wait`, `ttl`, `backoff`,
 * `interval`, `retry-after`), or a time-unit suffix (`_ms`, `-ns`, `Us`,
 * `_secs`). Its number is a duration whatever separates it from the key, so
 * `elapsed: 503` is time, not a 503.
 */
const DURATION_FIELD_KEY =
	/elapsed|duration|latency|delay|timeout|wait|ttl|backoff|interval|retry[_-]?after|(?:^|[_.-]|[a-z](?=[A-Z]))(?:ns|nanos?|us|µs|μs|micros?|ms|msecs?|millis?|s|secs?|seconds|mins?|minutes|h|hrs?|hours)$/i;
/**
 * A key whose colon makes a field rather than a sentence: quoted, spelled as
 * an identifier (`retry-after-ms`, `elapsed_ms`, `latencyMs`, `request.id`), an
 * id, or a key that names time. A plain word before a colon is otherwise prose
 * — `closed the connection: 503 Service Unavailable` keeps its status — while
 * `=` always makes a field.
 */
function isFieldKey(quote: string, key: string, separator: string): boolean {
	return (
		separator === "=" ||
		quote !== "" ||
		/[_.-]/.test(key) ||
		/[a-z][A-Z]/.test(key) ||
		/^id$/i.test(key) ||
		DURATION_FIELD_KEY.test(key)
	);
}
/**
 * A stream number in prose: Go's frame field (`stream error: stream ID 503`) and
 * HTTP/3's (`HTTP/3 stream 503`). A stream is numbered, never a status.
 */
const STREAM_NUMBER_PATTERN = /\bstream\s+(?:ID\s+)?\d+/gi;
/**
 * A port, by the host in front of it: anything in brackets — every IPv6
 * spelling, a zone (`[fe80::1%eth0]:401`, `[fe80::1%25eth0]:403`), an IPv4
 * mapping (`[::ffff:192.0.2.1]:503`) — a dotted numeric host of two to four
 * parts (`127.0.0.1:503`, the shorthand `127.1:401`), or `localhost`; or a port
 * named in prose (`port 503`). A dotted host name before a colon is already a
 * field key, so `h.invalid:503` is covered there.
 */
const PORT_NUMBER_PATTERN = /(?:\[[^\]\s]+\]|\b\d{1,3}(?:\.\d{1,3}){1,3}|\blocalhost):\d+|\bport\s+\d+/gi;
/**
 * Every character Unicode marks as default-ignorable: nothing renders, so
 * nothing can separate a number from its unit. Covers the zero-width space,
 * joiners, the soft hyphen (`503\u00ADms`), the invisible separator
 * (`529\u2063ms`), the word joiner and the byte-order mark, and any such
 * character Unicode adds later.
 */
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/gu;
/**
 * A number in the role of a duration: followed by a unit of time, glued or
 * spaced, or by a size or token unit. The unit decides, whatever surrounds
 * it. Latin units come in every spelling of every SI prefix of the second
 * (`ns`, `nsec`, `nanos`, `nanosecond`, `nano-second`, the micro sign as
 * U+00B5 or U+03BC), and minutes through years; a Latin unit must end the word,
 * so `503 Service` is not `503 s`. CJK and Korean units need no word end,
 * because those scripts have none (`503秒后重试`): seconds and their
 * subdivisions, minutes, hours, days, weeks, months and years in Chinese,
 * Japanese and Korean.
 */
const UNIT_NUMBER_PATTERN =
	/(?<![\w.])\d+(?:\.\d+)?\s*(?:(?:n(?:ano)?s(?:ecs?)?|nanos?(?:-?secs?|-?seconds?)?|[uµμ]s(?:ecs?)?|micros?(?:-?secs?|-?seconds?)?|ms(?:ecs?)?|millis?(?:-?secs?|-?seconds?)?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mos?|months?|y|yrs?|years?|bytes?|[kmgt]i?b|tokens?)(?![\p{L}\p{N}_])|纳秒|微秒|毫秒|秒钟|秒鐘|秒|分钟|分鐘|分|小时|小時|時間|个月|個月|ヶ月|か月|カ月|月|星期|週間|周|週|天|日|年|나노초|마이크로초|밀리초|초|분|시간|개월|일|주|달|년)/giu;
/**
 * Digits glued into an ASCII identifier or a path: `x-request-503-trace`,
 * `/jobs/503/`, `gpt-503-preview`. ASCII only on purpose: CJK prose glues a
 * status to the words around it (`服务器返回503错误`), and that number is the
 * status; a CJK or Korean unit after the number is read as a duration above.
 */
const GLUED_NUMBER_PATTERN = /(?<=[A-Za-z_\-/])\d+|\d+(?=[A-Za-z_\-/])/g;

/**
 * `text` with the digits that are diagnostic metadata removed, by the role
 * each number plays: inside a URL; a port; a stream number; a duration, size
 * or token count (a unit after it, or the value of a field whose key names
 * time); the value of any other field that does not name a status; or glued
 * into an identifier or a path. Every reader that takes a bare number as an
 * HTTP status, an auth rejection, a capacity refusal or a transient status
 * reads this instead, so `read ECONNRESET after 401 ns` stays a wire cut. A
 * status the sentence states — `HTTP 503`, `status=529`, `503 Service
 * Unavailable`, `error: 429`, `(429)` — keeps its digits.
 */
function withoutMetadataNumbers(text: string): string {
	return text
		.replace(DEFAULT_IGNORABLE_PATTERN, "")
		.replace(URL_PATTERN, url => url.replace(/\d+/g, ""))
		.replace(PORT_NUMBER_PATTERN, port => port.replace(/\d+$/, ""))
		.replace(FIELD_NUMBER_PATTERN, (field, quote: string, key: string, separator: string, _q, value: string) => {
			if (!isFieldKey(quote, key, separator) || STATUS_FIELD_KEY.test(key)) return field;
			const at = field.lastIndexOf(value);
			return field.slice(0, at) + field.slice(at + value.length);
		})
		.replace(STREAM_NUMBER_PATTERN, field => field.replace(/\d+/g, ""))
		.replace(UNIT_NUMBER_PATTERN, quantity => quantity.replace(/^[\d.]+/, ""))
		.replace(GLUED_NUMBER_PATTERN, "");
}

/** Words that introduce a decoration rather than state a reason (`after 401 ns`, `took 2 s`). */
const DECORATION_FILLER_PATTERN = /\b(?:after|took|in|at|via|from|on|over|elapsed)\b/gi;
/** A protocol name: `HTTP/1.1`, `HTTP/3`. */
const PROTOCOL_PATTERN = /\bHTTP\/\d(?:\.\d)?\b/gi;
/**
 * A field whose value carries a digit, quoted or not — a number
 * (`retry-after-ms=9000`, `elapsed_ms="401"`) or an identifier
 * (`model=gpt-503-preview`, `request_id=req_7`) — or whose key names an
 * identifier (`trace: abc`).
 */
const METADATA_FIELD_PATTERN =
	/\b(?:[A-Za-z][\w.-]*\s*[:=]\s*(["']?)(?=[\w.-]*\d)[\w.-]+\1|(?:[A-Za-z][\w.-]*?(?:_id|-id|\.id|Id|ID)|id|trace)\s*[:=]\s*(["']?)[\w.-]+\2)/g;
/**
 * A token that joins letters and digits with `-`, `_` or `.`: an identifier
 * (`x-request-503`, `gpt-503-preview`, `req_7`). A reason is words; a word with
 * no digit (`SIGKILL`, `content_policy`) is not taken for an identifier.
 */
const DIGIT_IDENTIFIER_PATTERN = /\b(?=[\w.-]*\d)(?=[\w.-]*[A-Za-z])[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+\b/g;

/**
 * Whether `tail` carries metadata and nothing else: URLs, ports, stream
 * numbers, protocol names, durations and sizes, fields whose value carries a
 * digit, identifier fields, identifiers that carry a digit, the words that
 * introduce them, and punctuation. One word of any other kind — a reason such
 * as `content policy violation`, `process killed by SIGKILL`, `permission
 * denied`, `due to …`, `reason=content_policy` — and it is not.
 */
function isMetadataOnly(tail: string): boolean {
	const residue = tail
		.replace(DEFAULT_IGNORABLE_PATTERN, "")
		.replace(URL_PATTERN, " ")
		.replace(PORT_NUMBER_PATTERN, " ")
		.replace(STREAM_NUMBER_PATTERN, " ")
		.replace(PROTOCOL_PATTERN, " ")
		.replace(METADATA_FIELD_PATTERN, " ")
		.replace(UNIT_NUMBER_PATTERN, " ")
		.replace(DIGIT_IDENTIFIER_PATTERN, " ")
		.replace(DECORATION_FILLER_PATTERN, " ")
		.replace(/[\s;,.()[\]{}]+/g, "");
	return residue === "";
}

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
		if (typeof errObj.errorStatus === "number" && errObj.errorStatus >= 100 && errObj.errorStatus <= 599) {
			return errObj.errorStatus;
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
			const text = withoutMetadataNumbers(message);
			for (const pattern of STATUS_MESSAGE_PATTERNS) {
				const match = pattern.exec(text);
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

/** Persisted-text form of a truncated stream envelope: an
 *  `Anthropic stream envelope error:` diagnostic naming the frame the stream
 *  never reached (`before message_start|delta|stop`). Covers both a connection
 *  that dies inside an open envelope and an in-band `error` frame that a
 *  gateway or proxy substitutes for the cut, so turn recovery can classify the
 *  family by its envelope marker instead of per-gateway wording. */
export function isStreamEnvelopeTruncationText(text: string): boolean {
	return TRANSIENT_ENVELOPE_PATTERN.test(text) && TRANSIENT_ENVELOPE_TRUNCATION_PATTERN.test(text);
}

/** The bare status arm of {@link TRANSIENT_TRANSPORT_PATTERN}. */
const TRANSIENT_STATUS_NUMBER_PATTERN = /\b(?:429|500|502|503|504)\b/;
const TRANSIENT_STATUS_NUMBERS = /\b(?:429|500|502|503|504)\b/g;

/**
 * The shared transport pattern, with its bare status numbers read off the
 * metadata-free text ({@link withoutMetadataNumbers}) so `elapsed_ms=503` is
 * not a 503. The wording arms read the text as given: they name tokens such as
 * `HTTP2StreamReset` whose digits are not metadata.
 */
function isTransientErrorText(text: string): boolean {
	return (
		isUnexpectedSocketCloseMessage(text) ||
		isStreamReadErrorText(text) ||
		PYTHON_HTTP2_STREAM_RESET_PATTERN.test(text) ||
		PYTHON_HTTP_INCOMPLETE_CHUNK_PATTERN.test(text) ||
		isStreamEnvelopeTruncationText(text) ||
		TRANSIENT_TRANSPORT_PATTERN.test(text.replace(TRANSIENT_STATUS_NUMBERS, "")) ||
		TRANSIENT_STATUS_NUMBER_PATTERN.test(withoutMetadataNumbers(text))
	);
}

/**
 * Capacity wording the rate-limit parsers do not already name: a far side that
 * answered and declined to serve for load. The parsers own every throttle with
 * a recognised reason or usage-limit phrasing, so this covers only the plain
 * English and bare status codes they leave (`TooManyRequests`, `slow down`,
 * `model is busy`). Capacity signals can ride alongside a wire failure; a
 * request carrying one must walk the fallback chain rather than be held on the
 * model.
 */
const CAPACITY_PRESSURE_PATTERN =
	/\b(?:no[_ -]?capacity|(?:high|peak)[ _-]?demand|(?:at|over|insufficient)[ _-]?capacity|capacity[ _-]?(?:exceeded|exhausted)|peak[ _-]?load)\b|overloaded|\bbusy\b|rate.?limit|too[ _-]?many[ _-]?requests|service.?unavailable|temporar(?:y|ily)[ _-]?unavailable|slow down|\b(?:429|503|529)\b/i;

/**
 * Whether the far side declined to serve for load or quota, so an identical
 * replay re-hits the same cap. Defers to the rate-limit parsers first; the
 * regex only covers what they leave.
 */
function isCapacityPressure(text: string, reason: RateLimitReason): boolean {
	if (reason !== "UNKNOWN") return true;
	if (matchesUsageLimitText(text)) return true;
	return CAPACITY_PRESSURE_PATTERN.test(text);
}

/**
 * Whether a diagnostic carries capacity or quota evidence — see
 * {@link isCapacityPressure}. Pass `reason` when the caller already parsed it;
 * it is re-parsed only when metadata digits had to be blanked first
 * ({@link withoutMetadataNumbers}): both capacity readers match bare
 * `429`/`503`/`529` tokens (`parseRateLimitReason`, rate-limit.ts, and the
 * pattern above), which a stream number, a URL or a request id satisfies by
 * accident and vetoes the connection lane for a cut that reached no status line.
 */
function hasCapacityEvidence(text: string, reason?: RateLimitReason): boolean {
	const capacityText = withoutMetadataNumbers(text);
	if (capacityText === text) return isCapacityPressure(text, reason ?? parseRateLimitReason(text));
	return isCapacityPressure(capacityText, parseRateLimitReason(capacityText));
}

/**
 * Transport diagnostics for a wire that died after the request was accepted:
 * the socket, the SSE stream or the chunked transfer failed partway. Two kinds
 * of wording are deliberately absent. Connect-phase (`unable to connect`,
 * `fetch failed`, `ECONNREFUSED`, `EAI_AGAIN`, `ETIMEDOUT`) is already
 * replayed by `fetchWithRetry` on its own budget. A bare mention of the
 * transfer-encoding header is a request fault, not a cut body, so only the
 * error spelling matches.
 *
 * The HTTP/2 arm covers the three reset spellings this repo already treats as
 * transport resets elsewhere — the `NGHTTP2_INTERNAL_ERROR` /
 * `NGHTTP2_REFUSED_STREAM` wording a gateway forwards, the bare
 * `HTTP2StreamReset` token, and Go's `stream error: stream ID 7;
 * INTERNAL_ERROR` — each a stream the peer reset with no status line of its
 * own. `INTERNAL_ERROR` is matched only inside that `stream error:` frame, so
 * a model's own "internal error" prose is not a cut stream. Go's GOAWAY
 * sentence (`http2: server sent GOAWAY and closed the connection;
 * LastStreamID=1, …`) reaches the lane through `closed the connection`; it
 * carries no status line either.
 */
const CONNECTION_FAILURE_PATTERN =
	/connection (?:closed|reset|aborted)|closed the connection|socket hang up|socket is closed|other side closed|use of closed network connection|reset before headers|premature close|incomplete chunked|transfer[ _-]?encoding\s*error|\bECONNRESET\b|\bEPIPE\b|HTTP2(?:StreamReset|RefusedStream)|\bNGHTTP2_(?:INTERNAL_ERROR|REFUSED_STREAM)\b|stream error:[^;]*;\s*(?:INTERNAL_ERROR|REFUSED_STREAM)\b/i;

/**
 * undici's whole diagnostic for a response body that ended early is the bare
 * word `terminated`. Anchored, because the word on its own inside a sentence
 * means something else entirely — a killed process ("Process terminated by
 * signal SIGKILL"), a policy stop ("terminated: content policy") — neither of
 * which an identical replay recovers.
 */
const UNDICI_TERMINATED_HEAD_PATTERN = /^(?:TypeError:\s*)?terminated\.?/i;

/**
 * undici's `terminated`, alone or followed by metadata only
 * ({@link isMetadataOnly}): `terminated; after 401 ns`, `terminated
 * (https://h/v1)`, `terminated retry-after-ms=9000`. A reason never passes,
 * whatever separates it — `terminated; process killed by SIGKILL`, `terminated
 * (content policy violation)`, `terminated retry-after-ms=200 due to content
 * policy` — and a colon always introduces one.
 */
function isUndiciTerminatedText(text: string): boolean {
	const head = UNDICI_TERMINATED_HEAD_PATTERN.exec(text);
	if (!head) return false;
	const tail = text.slice(head[0].length);
	return !/^\s*:/.test(tail) && isMetadataOnly(tail);
}

/**
 * Wire failures a runtime reports only as an errno on `err.code`, leaving the
 * message generic. `UND_ERR_SOCKET` is undici's own code for a socket that
 * died mid-response.
 *
 * Not handled, deliberately: an HTTP/2 GOAWAY. No diagnostic wording for it
 * has been observed, and its frame surfaces differently in each runtime, so
 * widening the flag would be a guess. Add a concrete diagnostic when observed.
 *
 * Errnos only, never a provider's own error code: the branch that reads this
 * does not look at the message, so a code copied verbatim from an upstream
 * payload must never be matched here, or a terminal failure becomes retriable.
 */
const WIRE_FAILURE_CODE_PATTERN = /^(?:ECONNRESET|EPIPE|ECONNABORTED|UND_ERR_SOCKET)$/;

/**
 * Whether a failure happened on the wire rather than at the model — see
 * {@link Flag.Connection}.
 *
 * Restricted to failures carrying no HTTP status. A status means the request
 * reached a status line, which `fetchWithRetry` and the provider's pre-output
 * retry already replay on their own budgets; by the time such an error reaches
 * turn recovery the same model has been asked many times. A statusless wire
 * failure — the stream cut mid-body, the socket closed, the chunked transfer
 * truncated — is past the point either of those budgets covers, so it arrives
 * with almost no replay spent on it.
 */
function isConnectionFailure(text: string, status: number | undefined, reason: RateLimitReason): boolean {
	if (status !== undefined) return false;
	if (hasCapacityEvidence(text, reason)) return false;
	return (
		isUnexpectedSocketCloseMessage(text) ||
		isStreamReadErrorText(text) ||
		PYTHON_HTTP2_STREAM_RESET_PATTERN.test(text) ||
		PYTHON_HTTP_INCOMPLETE_CHUNK_PATTERN.test(text) ||
		isStreamEnvelopeTruncationText(text) ||
		isTransientStreamDropError(text) ||
		isTransientStreamParseError(text) ||
		CODEX_HTTP_BODY_READ_ERROR_PATTERN.test(text) ||
		isUndiciTerminatedText(text.trim()) ||
		CONNECTION_FAILURE_PATTERN.test(text)
	);
}

/**
 * `Flag.Connection` means "no status, no capacity signal, no rejected
 * credential", but both assembly points OR per-link kinds together: a
 * statusless connection-worded cause under a 429 or 5xx wrapper, beside a
 * proven usage limit, beside capacity wording on another link, or beside an
 * authentication rejection would otherwise carry the bit past its own guard
 * and hold the fallback chain for a route that answered.
 *
 * `capacityEvidence` is the per-link capacity reading the caller collected:
 * `isConnectionFailure` sees only the link it classifies, so
 * `Error("model is busy", { cause: Error("socket hang up") })` reaches here
 * with the bit set from the cause and the refusal recorded on the wrapper.
 * An auth rejection is read off the assembled kinds, which is where
 * `isAuthFailureText` on any link puts it.
 */
function withoutContradictedConnection(kinds: number, status: number | undefined, capacityEvidence: boolean): number {
	if ((kinds & Flag.Connection) === 0) return kinds;
	if (status !== undefined || capacityEvidence || (kinds & (Flag.UsageLimit | Flag.AuthFailed)) !== 0) {
		return kinds & ~Flag.Connection;
	}
	return kinds;
}

function isTimeoutText(text: string): boolean {
	return TIMEOUT_PATTERN.test(text);
}

/** A `401`/`403` in a URL or an identifier is metadata, not a rejection ({@link withoutMetadataNumbers}). */
function isAuthFailureText(text: string): boolean {
	return AUTH_FAILURE_PATTERN.test(withoutMetadataNumbers(text));
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

/**
 * A 4xx the provider rejected as a deterministic client error — every 4xx
 * except 408 (Request Timeout) and 429 (Too Many Requests), the retryable
 * pair. Mirrors the 4xx policy in {@link isProviderRetryableError}: such a
 * request replays identically, so a transient signal riding on it (e.g. a
 * truncation phrase in the body) must not flip it to retryable.
 */
function isTerminalClientErrorStatus(status: number | undefined): boolean {
	return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
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
		const statusClean = errorStatus ? errorStatus : (status({ message: errorMessage }) ?? undefined);

		if (
			ACCOUNT_POLICY_PATTERN.test(errorMessage) ||
			isCodexChatGPTAccountPolicyText(errorMessage, provider, modelId) ||
			(provider === "cursor" && isCursorPlanPolicyText(errorMessage))
		) {
			kinds |= Flag.AccountPolicy | Flag.ContentBlocked;
		}
		if (isAnthropicAccountPolicyText(errorMessage, provider, statusClean)) {
			kinds |= Flag.AccountPolicy;
		}
		if (isAuthFailureText(errorMessage)) kinds |= Flag.AuthFailed;
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
		// Transport/timeout/truncation wording that rides on a terminal 4xx (e.g. a
		// "400 unexpected EOF" malformed request, or a region/entitlement denial
		// whose body carries `type=server_error`) describes a deterministic client
		// error that replays identically, so keep it terminal — the same 4xx policy
		// as isProviderRetryableError. classify() carries the outer terminal status
		// down the cause chain so a wrapped phrase (ProviderHttpError 400 → cause
		// "unexpected EOF") is caught here too.
		if (!isTerminalClientErrorStatus(statusClean)) {
			if (isTimeoutText(errorMessage)) kinds |= Flag.Transient | Flag.Timeout;
			else if (isTransientErrorText(errorMessage)) kinds |= Flag.Transient;
			// A stream truncation, transport-level stream drop, or forwarded Codex
			// HTTP body-read failure may not match TRANSIENT_TRANSPORT_PATTERN. Flag
			// it explicitly so AIError.retriable and the turn-recovery layer treat it
			// as retryable, matching the provider retry path. Separate `if` (not
			// chained onto the else-if) so a timeout whose text also reads as a
			// truncation keeps Flag.Timeout alongside Flag.Transient. The string arm
			// applies the strict STREAM_PARSE_DIAGNOSTIC_PATTERN, per the rationale
			// on isTransientStreamParseError.
			if (
				isTransientStreamParseError(errorMessage) ||
				isTransientStreamDropError(errorMessage) ||
				CODEX_HTTP_BODY_READ_ERROR_PATTERN.test(errorMessage)
			) {
				kinds |= Flag.Transient;
			}
			// Connection-level within the same non-terminal-4xx window: the wire or
			// a gateway in front of the model failed, so an identical replay is
			// worth one cheap try before the fallback chain advances. A usage limit
			// already proven above is a cap the replay re-hits, never that, and a
			// statusless credential rejection ("authentication failed: socket is
			// closed") is a request the far side answered and refused — replaying
			// it holds the session on a route that will refuse it again.
			if (
				(kinds & (Flag.UsageLimit | Flag.AuthFailed)) === 0 &&
				isConnectionFailure(errorMessage, statusClean, reason)
			) {
				kinds |= Flag.Connection | Flag.Transient;
			}
		}
		// A concurrency cap (e.g. Vertex "Online prediction concurrent requests
		// quota exceeded") is transient — shed-and-backoff. The bare wording need
		// not match TRANSIENT_TRANSPORT_PATTERN, so flag it explicitly to keep
		// AIError.retriable from treating the temporary cap as terminal.
		if (reason === "CONCURRENT_LIMIT") kinds |= Flag.Transient;
		if ((api === "openai-responses" || api === "openai-codex-responses") && isStaleResponsesText(errorMessage)) {
			kinds |= Flag.StaleResponsesItem;
		}
		// Retryable like the provider's own classification of the code, so a
		// message reclassified from its text alone still retries.
		if (isCodexSteerRejection({ api, errorMessage })) kinds |= Flag.Transient;

		// Fireworks mid-generation NaN 400 is a model-side decode fault, not a bad
		// request; a byte-identical replay succeeds, so treat it as transient.
		if (statusClean === 400 && GENERATION_NAN_PATTERN.test(cleanMessage)) kinds |= Flag.Transient;
		// Same shape for Aliyun's multimodal gateway: a flaky 400 on valid inline
		// images — replay succeeds (see the pattern's rationale).
		if (statusClean === 400 && ALIYUN_MM_GATEWAY_PATTERN.test(cleanMessage)) kinds |= Flag.Transient;
		if (matchesStrictToolsRejection(cleanMessage, statusClean)) kinds |= Flag.Grammar;
		if (matchesFastModeUnsupported(cleanMessage, statusClean)) kinds |= Flag.FastModeUnsupported;
		if (matchesCacheControlRejection(cleanMessage, statusClean)) kinds |= Flag.CacheControlUnsupported;
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

/** The message a cause-chain link carries: an `Error`'s, a string cause, a plain object's `message` or `errorMessage`. */
function linkMessageOf(link: unknown): string | undefined {
	if (link instanceof Error) return link.message;
	if (typeof link === "string") return link;
	if (typeof link !== "object" || link === null) return undefined;
	if ("message" in link && typeof link.message === "string") return link.message;
	if ("errorMessage" in link && typeof link.errorMessage === "string") return link.errorMessage;
	return undefined;
}

/** A link's status: its structured fields ({@link status}), else the one its own message states. */
function linkStatusOf(link: unknown, message: string | undefined): number | undefined {
	return status(link) ?? (message !== undefined ? status({ message }) : undefined);
}

/**
 * The first terminal 4xx anywhere in an error's cause chain, read from every
 * representation a link can carry it in. It governs every link, above it as
 * much as below, so neither the depth a status sits at nor the shape that
 * carries it decides whether a rejected request retries.
 */
function chainTerminalStatus(error: unknown): number | undefined {
	const seen = new Set<object>();
	let link: unknown = error;
	while (link !== undefined && link !== null) {
		if (typeof link === "object") {
			if (seen.has(link)) break;
			seen.add(link);
		}
		const linkStatus = linkStatusOf(link, linkMessageOf(link));
		if (isTerminalClientErrorStatus(linkStatus)) return linkStatus;
		link = typeof link === "object" && "cause" in link ? (link as { cause: unknown }).cause : undefined;
	}
	return undefined;
}

export function classify(error: unknown, api?: Api): number {
	let kinds = 0;
	const seen = new Set<object>();
	const causeTokenEvidence = hasCauseTokenContextOverflowEvidence(error);
	let link: unknown = error;
	// A terminal 4xx on an outer link governs its own cause diagnostics: a
	// wrapped truncation or transport phrase is describing why the deterministic
	// request failed, not an independently retryable transport fault. Carry it
	// down so the terminal-4xx guard in classifyText sees it on the status-less
	// cause.
	let governingTerminalStatus: number | undefined;
	// And one on any link below governs the links above it: the walk reaches a
	// deep status only after it has classified the outer links, and the text
	// and errno arms set `Transient` on those links. Read it first.
	const terminalStatus = chainTerminalStatus(error);
	// What the connection finalizer needs that no single link carries:
	// `status(error)` alone stops at the third link (`statusInternal`, depth 2),
	// and a capacity refusal on one link is invisible to the link that supplies
	// the wire wording. The messages are kept rather than read here, so the
	// capacity parse runs only for an error that still claims the lane.
	let statusSeen: number | undefined;
	const linkMessages: string[] = [];
	// The errno arm below is decided after the walk, under the same chain-wide
	// terminal-4xx gate as the text arm.
	let wireErrnoSeen = false;
	while (link !== undefined && link !== null) {
		const linkMessage = linkMessageOf(link);
		const linkStatus = linkStatusOf(link, linkMessage);
		statusSeen ??= linkStatus;
		if (typeof link === "object") {
			if (seen.has(link)) break;
			seen.add(link);

			if ("errorId" in link && typeof (link as { errorId: unknown }).errorId === "number") {
				kinds |= (link as { errorId: number }).errorId & KIND_MASK;
			}
			if ("code" in link && typeof link.code === "string") {
				if (ACCOUNT_POLICY_PATTERN.test(link.code)) {
					kinds |= Flag.AccountPolicy | Flag.ContentBlocked;
				} else if (ANTHROPIC_ACCOUNT_POLICY_PATTERN.test(link.code)) {
					kinds |= Flag.AccountPolicy;
				}
				// A runtime that reports the wire failure as an errno puts it in
				// `code` and leaves the message generic ("fetch failed"), so the
				// text predicates never see it. Gated, after the walk, by the same
				// terminal-4xx window as the text arm in `classifyText`: a request
				// the provider rejected as malformed or unentitled replays
				// identically, whatever errno the socket carried on the way out,
				// so neither bit is retriable there.
				if (WIRE_FAILURE_CODE_PATTERN.test(link.code)) wireErrnoSeen = true;
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
					(is402BillingCapBody(link.message) ||
						(code !== undefined && !isOpaqueStatusBody(code) && is402BillingCapBody(code))))
			) {
				linkKinds |= Flag.UsageLimit;
			}
			if (code === "overloaded_error" || code === "rate_limit_error") {
				linkKinds |= Flag.Transient;
			}
			if (
				code === "oauth_not_allowed_for_organization" ||
				code === "permission_error" ||
				(codeStatus === 403 && ANTHROPIC_ACCOUNT_POLICY_PATTERN.test(link.message))
			) {
				linkKinds |= Flag.AccountPolicy;
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

		if (linkMessage !== undefined) linkMessages.push(linkMessage);
		const textId = classifyText(
			linkMessage,
			linkStatus ?? governingTerminalStatus ?? terminalStatus,
			causeTokenEvidence,
			api,
		);
		kinds |= textId & KIND_MASK;
		if (isTerminalClientErrorStatus(linkStatus)) governingTerminalStatus = linkStatus;

		link = typeof link === "object" && "cause" in link ? (link as { cause: unknown }).cause : undefined;
	}

	if (wireErrnoSeen && terminalStatus === undefined) kinds |= Flag.Connection | Flag.Transient;

	if (kinds === 0) return status(error) ?? 0;
	// Only an error still holding the lane pays for the capacity parse.
	const capacityEvidence =
		(kinds & Flag.Connection) !== 0 && linkMessages.some(message => hasCapacityEvidence(message));
	return create(withoutContradictedConnection(kinds, statusSeen, capacityEvidence));
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
 * An Anthropic-compatible endpoint returned a 400 rejecting something about
 * `cache_control`. Whether it refused the field or one nested option is not
 * decidable here (see {@link CACHE_CONTROL_FIELD_PATTERN}); the caller's retry
 * ladder settles it by replaying.
 * Accessor for {@link Flag.CacheControlUnsupported}.
 *
 * Unlike the high-bit accessors this also requires a classified id. The flag
 * sits in the raw-status lane (see {@link Flag.CacheControlUnsupported}), and
 * while no HTTP status reaches 0x800, `is` is a bare bit test — the extra gate
 * keeps a stray non-HTTP status out of the retry path.
 */
export function isCacheControlUnsupported(error: unknown): boolean {
	const id = classify(error);
	return isClassified(id) && is(id, Flag.CacheControlUnsupported);
}

const CLINE_PASS_SURFACE_GATE_PATTERN = /only available via cline product surfaces/i;

/**
 * Cline's gateway gates some roster entries (certain free-tier models) to its
 * own product surfaces with a 403. The API key is valid — the restriction is
 * per-model client policy — so it must neither rotate sibling credentials (they
 * fail identically) nor surface as an auth failure.
 */
export function isClinePassSurfaceGateMessage(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && CLINE_PASS_SURFACE_GATE_PATTERN.test(errorMessage);
}

const GITHUB_COPILOT_POLICY_DENIAL_PATTERN = /GitHub Copilot access denied \(HTTP 403\)/;

/**
 * GitHub Copilot 403s are plan/model-policy/org denials against a valid token —
 * never a revoked credential (those arrive as 401). Wiping stored credentials
 * on them hides the whole provider from `/model` and forces a pointless
 * re-login, so credential-lifetime decisions must exempt them even though
 * they still classify as `Flag.AuthFailed` (issue #11275). Mirrors the 403
 * contract in `rewriteCopilotError` (`utils/http-inspector.ts`).
 */
export function isGitHubCopilotPolicyDenial(
	provider: string | undefined,
	status: number | undefined,
	errorMessage: string | undefined,
): boolean {
	if (provider !== "github-copilot") return false;
	if (status === 403) return true;
	return errorMessage !== undefined && GITHUB_COPILOT_POLICY_DENIAL_PATTERN.test(errorMessage);
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
	// The status the text states counts as much as the structured one, as it
	// does for `classifyText` (`statusClean`): a persisted `Connection` that the
	// message contradicts with `HTTP 400` must not survive because
	// `errorStatus` is unset.
	if ((kinds & Flag.Connection) !== 0) {
		kinds = withoutContradictedConnection(
			kinds,
			currentStatus ?? (classificationMessage ? status({ message: classificationMessage }) : undefined),
			classificationMessage !== undefined && hasCapacityEvidence(classificationMessage),
		);
	}
	const id = kinds !== 0 ? create(kinds) : (statusFromId(textId) ?? statusFromId(existingId) ?? currentStatus ?? 0);

	message.errorId = id;
	return id;
}

export function attach<E extends object>(error: E, id: number): E {
	Object.defineProperty(error, "errorId", { value: id, enumerable: false, configurable: true });
	return error;
}

/** Overflow-classification evidence, including errors received before token usage is available. */
export interface ContextOverflowMessage extends Pick<AssistantMessage, "errorId" | "stopReason" | "errorMessage"> {
	readonly usage?: Pick<Usage, "input" | "cacheRead" | "cacheWrite" | "contextTokens">;
}

/**
 * Provider-reported usage proves context-window excess — authoritative, compaction-owned (#9235).
 *
 * Prefers `contextTokens` when the provider reports it: providers that run
 * several model calls per turn (Cursor's server-side tool loop) report
 * `input`/`cacheRead` summed across those calls, which can exceed the window
 * many times over while the conversation itself stays small.
 */
export function isUsageBackedContextOverflow(message: ContextOverflowMessage, contextWindow?: number): boolean {
	const usage = message.usage;
	if (!contextWindow || !usage) return false;
	const inputTokens = usage.contextTokens ?? usage.input + usage.cacheRead + usage.cacheWrite;
	return inputTokens > contextWindow;
}

/** Classify overflow from error flags, available token usage, or provider error text. */
export function isContextOverflow(message: ContextOverflowMessage, contextWindow?: number): boolean {
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
	message: ContextOverflowMessage | undefined,
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

/**
 * Transport-level stream drops: the connection or upstream stream ended before a
 * terminal event, with no JSON-parse signal and no retryable status attached.
 *
 * Distinct from {@link STREAM_PARSE_TRUNCATION_PATTERN} (mid-body JSON
 * truncation) — these name the transport itself dropping (proxy/gateway closing
 * the SSE stream, socket dying before the TLS handshake completes). The wording
 * is the statusless twin of a `408 stream disconnected`, which the status path
 * already retries; an identical replay recovers it, so callers under a
 * non-terminal status treat it as transient (#11805).
 */
const STREAM_DROP_PATTERN =
	/stream disconnected before completion|(?:stream|websocket) closed before response\.completed|stream was interrupted|stream ended before (?:terminal (?:chunk|completion event)|message_(?:start|delta|stop))|socket disconnected before secure tls connection/i;

/**
 * Transport stream-drop diagnostic (see {@link STREAM_DROP_PATTERN}). Unlike
 * {@link isTransientStreamParseError}, one pattern serves both the live `Error`
 * and the persisted-string forms: the phrasings are high-signal enough to trust
 * detached from a transport `Error`.
 */
export function isTransientStreamDropError(error: unknown): boolean {
	if (typeof error === "string") return STREAM_DROP_PATTERN.test(error);
	return error instanceof Error && STREAM_DROP_PATTERN.test(error.message);
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
