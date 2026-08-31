import { isClinePassSurfaceGateMessage, isUsageLimit, matchesOverflowText } from "./flags";

/** Who owns a classified gateway failure. */
export type GatewayErrorOwner =
	| "request"
	| "credential"
	| "quota"
	| "model"
	| "provider"
	| "transport"
	| "policy"
	| "orchestration"
	| "gateway"
	| "cancelled";

/** What a classified gateway failure means for retry / failover. */
export type GatewayErrorDisposition =
	| "credential_permanent"
	| "credential_quota"
	| "credential_transient"
	| "provider_transient"
	| "provider_unavailable"
	| "model_unavailable"
	| "context_overflow"
	| "request_terminal"
	| "policy_terminal"
	| "gateway_terminal"
	| "cancelled";

/** A gateway-facing classification of an arbitrary upstream/internal error. */
export interface GatewayErrorClassification {
	status: number;
	type: string;
	message: string;
	owner: GatewayErrorOwner;
	disposition: GatewayErrorDisposition;
}

const RETRYABLE_DISPOSITION: Record<GatewayErrorDisposition, boolean> = {
	credential_permanent: false,
	credential_quota: true,
	credential_transient: true,
	provider_transient: true,
	provider_unavailable: true,
	model_unavailable: true,
	context_overflow: false,
	request_terminal: false,
	policy_terminal: false,
	gateway_terminal: false,
	cancelled: false,
};

/** True when a disposition may be retried against another credential or provider. */
export function isRetryableGatewayDisposition(disposition: GatewayErrorDisposition): boolean {
	return RETRYABLE_DISPOSITION[disposition];
}

const PROVIDER_WIDE_PATTERN =
	/\b(?:overloaded|service unavailable|provider.?returned.?error|(?:at|over|insufficient)[ _-]?capacity|capacity[ _-]?(?:exceeded|exhausted)|peak[ _-]?(?:load|demand)|high[ _-]?demand)\b/i;
const REVOKED_PATTERN = /\brevoked\b|\binvalid_grant\b/i;
const TIMEOUT_OR_CONNECTION_PATTERN =
	/\b(?:operation\s+)?timed?\s*out\b|\btimeout\b|\bconnection(?:\s+error|\s+refused)?\b|\bsocket hang up\b|\bfetch failed\b/i;
const POLICY_PATTERN = /\bcyber_policy\b|trusted access for cyber/i;
const MODEL_UNAVAILABLE_PATTERN = /\bmodel[_ ]?(?:not[_ ]found|unavailable|not[_ ]supported)\b/i;
const INVALID_REQUEST_PATTERN =
	/\b(?:unsupported|invalid_request|invalid request|bad request|malformed|GenerateContentRequest)\b/i;
const GATEWAY_INVARIANT_PATTERN = /\bgateway_terminal\b|\binternal invariant\b/i;

/**
 * Classify an upstream / gateway-internal error into a status code and a
 * format-neutral type. The order is intentional:
 *
 *  1. Honour an explicit numeric `status` property on the thrown error.
 *  2. Parse a status code embedded in the message string. Provider errors
 *     virtually always carry one (`Google API error (400): …`, `HTTP 429`,
 *     `status=503`) and the embedded value is authoritative.
 *  3. Fall through to **word-boundaried** substring heuristics. The old
 *     `lower.includes("rate")` test famously matched `GenerateContentRequest`,
 *     surfacing every Google 400 as a 429 `rate_limit_error`. The patterns here
 *     all require boundaries so they don't collide with provider field names.
 */
export function classifyGatewayError(err: unknown): GatewayErrorClassification {
	const message = err instanceof Error ? err.message : String(err);

	if (err instanceof Error && err.name === "AbortError") {
		return withOwnerDisposition(err, { status: 499, type: "request_aborted", message });
	}
	if (/\baborted\b|\babort signal\b/i.test(message)) {
		return withOwnerDisposition(err, { status: 499, type: "request_aborted", message });
	}

	// Honour an explicit numeric `status` property on the thrown error. This
	// sits below the abort checks on purpose: acting on a stale transport
	// status after the client cancelled could trigger post-abort failover.
	let statusProp: number | undefined;
	if (typeof err === "object" && err !== null && "status" in err && typeof err.status === "number") {
		statusProp = err.status | 0;
	}
	if (statusProp !== undefined) {
		return withOwnerDisposition(err, bucketStatus(statusProp, message));
	}

	// Status code embedded in the message. Requires a contextual keyword
	// (`HTTP`, `API error`, `status`, …) or a leading `(NNN)` token so we
	// don't trip on incidental three-digit numbers ("took 200ms").
	const embedded = extractEmbeddedStatus(message);
	if (embedded !== undefined) return withOwnerDisposition(err, bucketStatus(embedded, message));

	if (
		// Match rate-limit phrasings before auth wording: some providers
		// describe throttling as "unauthorized due to rate limit".
		// Keep boundaries so this does not collide with
		// `GenerateContentRequest`, `accelerate`, `iterate`, `deprecated`, etc.
		/\brate[- _]?limit(?:s|ed|ing)?\b|\bquota(?:_exceeded| exceeded)?\b|\btoo[- _]many[- _]requests\b/i.test(
			message,
		) ||
		// Usage-limit phrasings emit no embedded status. Codex friendly text
		// reads "You have hit your ChatGPT usage limit … Try again in ~158
		// min."; the central usage-limit classifier already encodes every known
		// provider variant, so reuse it instead of forking the regex. Without
		// this branch the classifier falls through to the default
		// 502/upstream_error, which is what callers saw when their account
		// hit its cap.
		isUsageLimit(message)
	) {
		return withOwnerDisposition(err, { status: 429, type: "rate_limit_error", message });
	}
	if (/\b(?:unauthorized|forbidden)\b/i.test(message)) {
		return withOwnerDisposition(err, { status: 401, type: "authentication_error", message });
	}
	if (/\b(?:unsupported|invalid_request|invalid request|bad request|malformed)\b/i.test(message)) {
		return withOwnerDisposition(err, { status: 400, type: "invalid_request_error", message });
	}
	return withOwnerDisposition(err, { status: 502, type: "upstream_error", message });
}

function bucketStatus(status: number, message: string): { status: number; type: string; message: string } {
	if (status === 401 || status === 403) return { status, type: "authentication_error", message };
	if (status === 429) return { status, type: "rate_limit_error", message };
	// Request timeout is provider-transient, not a client invalid_request.
	if (status === 408) return { status, type: "upstream_error", message };
	if (status >= 400 && status < 500) return { status, type: "invalid_request_error", message };
	if (status >= 500) return { status, type: "upstream_error", message };
	return { status: 502, type: "upstream_error", message };
}

function withOwnerDisposition(
	err: unknown,
	http: { status: number; type: string; message: string },
): GatewayErrorClassification {
	const { owner, disposition } = classifyOwnerDisposition(err, http);
	return { ...http, owner, disposition };
}

function classifyOwnerDisposition(
	err: unknown,
	http: { status: number; type: string; message: string },
): { owner: GatewayErrorOwner; disposition: GatewayErrorDisposition } {
	const { status, type, message } = http;

	if (
		status === 499 ||
		(err instanceof Error && err.name === "AbortError") ||
		/\baborted\b|\babort signal\b/i.test(message)
	) {
		return { owner: "cancelled", disposition: "cancelled" };
	}

	// Internal invariant — never a retryable provider failure, regardless of HTTP mapping.
	let ownerProp: string | undefined;
	if (typeof err === "object" && err !== null && "owner" in err && typeof err.owner === "string") {
		ownerProp = err.owner;
	}
	const errName = err instanceof Error ? err.name : "";
	if (
		ownerProp === "gateway" ||
		errName === "gateway_terminal" ||
		GATEWAY_INVARIANT_PATTERN.test(message) ||
		GATEWAY_INVARIANT_PATTERN.test(errName)
	) {
		return { owner: "gateway", disposition: "gateway_terminal" };
	}

	// Authoritative HTTP buckets first: message heuristics never rebrand a
	// status the provider already chose. A 5xx means what the provider said —
	// wording like "context length" or "revoked" inside an upstream error's
	// echoed detail must not turn it into a non-retryable request/policy
	// disposition. Heuristics apply only within their status range, or as a
	// last-resort fall-through when no status signal exists.
	if (status === 429 || type === "rate_limit_error") {
		// Structured usage-limit evidence beats generic 429 wording: the
		// pre-chain maps "hit your usage limit" phrasing to 429/rate_limit_error.
		if (isUsageLimit(err) || isUsageLimit(message)) {
			return { owner: "quota", disposition: "credential_quota" };
		}
		if (PROVIDER_WIDE_PATTERN.test(message)) {
			return { owner: "provider", disposition: "provider_transient" };
		}
		return { owner: "credential", disposition: "credential_transient" };
	}

	if (status === 402) {
		return { owner: "quota", disposition: "credential_quota" };
	}

	if (status === 401 || status === 403 || type === "authentication_error") {
		if (isClinePassSurfaceGateMessage(message)) {
			return { owner: "policy", disposition: "policy_terminal" };
		}
		if (REVOKED_PATTERN.test(message)) {
			return { owner: "credential", disposition: "credential_permanent" };
		}
		return { owner: "credential", disposition: "credential_transient" };
	}

	if (status === 404 && MODEL_UNAVAILABLE_PATTERN.test(message)) {
		return { owner: "model", disposition: "model_unavailable" };
	}

	// Policy denials and context overflows are provider decisions delivered on
	// 4xx statuses; on 5xx they are usually quoted upstream detail, not the
	// provider's own verdict. Definitive OAuth failures also surface as
	// 400 `invalid_grant`.
	if (status > 0 && status < 500) {
		if (POLICY_PATTERN.test(message)) {
			return { owner: "policy", disposition: "policy_terminal" };
		}
		if (matchesOverflowText(message)) {
			return { owner: "request", disposition: "context_overflow" };
		}
		if (REVOKED_PATTERN.test(message)) {
			return { owner: "credential", disposition: "credential_permanent" };
		}
	}

	if (status === 408) {
		return { owner: "provider", disposition: "provider_transient" };
	}

	if (status === 400 || type === "invalid_request_error") {
		return { owner: "request", disposition: "request_terminal" };
	}

	if (status >= 500) {
		if (TIMEOUT_OR_CONNECTION_PATTERN.test(message)) {
			return { owner: "provider", disposition: "provider_transient" };
		}
		return { owner: "provider", disposition: "provider_unavailable" };
	}

	// No authoritative status signal (fall-through): message heuristics only.
	if (isUsageLimit(err) || isUsageLimit(message)) {
		return { owner: "quota", disposition: "credential_quota" };
	}
	if (POLICY_PATTERN.test(message)) {
		return { owner: "policy", disposition: "policy_terminal" };
	}
	if (matchesOverflowText(message)) {
		return { owner: "request", disposition: "context_overflow" };
	}
	if (TIMEOUT_OR_CONNECTION_PATTERN.test(message)) {
		return { owner: "transport", disposition: "provider_transient" };
	}
	if (INVALID_REQUEST_PATTERN.test(message)) {
		return { owner: "request", disposition: "request_terminal" };
	}

	return { owner: "provider", disposition: "provider_unavailable" };
}

/**
 * Pull a status code from common error-message shapes. Returns undefined when
 * no contextual keyword is present, so we never guess at incidental numbers.
 */

/**
 * Pull a status code from common error-message shapes. Returns undefined when
 * no contextual keyword is present, so we never guess at incidental numbers.
 */
function extractEmbeddedStatus(message: string): number | undefined {
	// `Google API error (400)`, `OpenAI API error (429): …`, `(503)`
	// `HTTP 429: too many requests`
	// `status: 503`, `status_code=429`, `status=400`
	const re = /(?:\bHTTP\b|\bAPI error\b|\bstatus(?:[- _]?code)?\b)\s*[:=]?\s*\(?\s*(\d{3})\b|\((\d{3})\)/i;
	const m = message.match(re);
	if (!m) return undefined;
	const raw = m[1] ?? m[2];
	if (!raw) return undefined;
	const code = Number.parseInt(raw, 10);
	return Number.isFinite(code) && code >= 100 && code < 600 ? code : undefined;
}
