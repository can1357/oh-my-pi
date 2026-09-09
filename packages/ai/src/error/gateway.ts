import { isUsageLimit } from "./flags";

/** A gateway-facing classification of an arbitrary upstream/internal error. */
export interface GatewayErrorClassification {
	status: number;
	type: string;
	message: string;
}

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

	// 1. Custom pi-ai errors may attach a numeric `status` property.
	const statusProp =
		typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number"
			? (err as { status: number }).status | 0
			: undefined;
	if (statusProp !== undefined) return bucketStatus(statusProp, message);

	if (err instanceof Error && err.name === "AbortError") return { status: 499, type: "request_aborted", message };

	// 2. Status code embedded in the message. Requires a contextual keyword
	// (`HTTP`, `API error`, `status`, …) or a leading `(NNN)` token so we
	// don't trip on incidental three-digit numbers ("took 200ms").
	const embedded = extractEmbeddedStatus(message);
	if (embedded !== undefined) return bucketStatus(embedded, message);

	// 3. Word-boundaried substring heuristics.
	if (/\baborted\b|\babort signal\b/i.test(message)) {
		return { status: 499, type: "request_aborted", message };
	}
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
		return { status: 429, type: "rate_limit_error", message };
	}
	if (/\b(?:unauthorized|forbidden)\b/i.test(message)) {
		return { status: 401, type: "authentication_error", message };
	}
	if (/\b(?:unsupported|invalid_request|invalid request|bad request|malformed)\b/i.test(message)) {
		return { status: 400, type: "invalid_request_error", message };
	}
	return { status: 502, type: "upstream_error", message };
}

function bucketStatus(status: number, message: string): GatewayErrorClassification {
	if (status === 401 || status === 403) return { status, type: "authentication_error", message };
	if (status === 429) return { status, type: "rate_limit_error", message };
	if (status >= 400 && status < 500) return { status, type: "invalid_request_error", message };
	if (status >= 500) return { status, type: "upstream_error", message };
	return { status: 502, type: "upstream_error", message };
}

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
