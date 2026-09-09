/**
 * JSON-POST → SSE transport for OpenAI-wire streaming endpoints (chat
 * completions, responses, azure responses). Replaces the `openai` SDK client:
 *
 * - Retries: `fetchWithRetry` (Retry-After/quota-hint aware; 5xx/408/429 and
 *   transient network errors). Default 6 total attempts — parity with the
 *   SDK's former `maxRetries: 5`.
 * - SSE decode: `readSseJson` (spec-compliant framing, `[DONE]`-aware).
 *   `onSseEvent` observers now receive real wire frames instead of events
 *   re-synthesized from decoded SDK objects.
 * - Errors: {@link OpenAIHttpError} exposes `status`/`headers`/`code`
 *   structurally (ProviderHttpError contract — `extractHttpStatusFromError`,
 *   retry-after extraction, copilot transient classification) and carries the
 *   captured response body for the strict-tools fallback and the responses
 *   chain-state detectors, which regex over `error.message`.
 */
import { fetchWithRetry, readSseJson, type SseEventObserver } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { OpenAIHttpError } from "../error";

export { OpenAIHttpError };

import type { FetchImpl } from "../types";
import type { CapturedHttpErrorResponse } from "./http-inspector";

/**
 * Total attempts (initial + retries). Parity with the removed SDK clients'
 * `maxRetries: 5`, i.e. 6 requests. Callers arming a first-event watchdog
 * stay bounded: the watchdog aborts the request `signal`, which
 * `fetchWithRetry` races on every attempt and every backoff sleep, so
 * transient 408/429/5xx retries can never extend the caller's deadline.
 */
const DEFAULT_MAX_ATTEMPTS = 6;

/** Bound the `Error.message` allocation for proxy HTML error pages and the like. */
const MAX_DETAIL_CHARS = 4096;

/**
 * LiteLLM (and compatible proxies) shed over-concurrency requests *before* the
 * upstream call with an immediate HTTP 429 marked `rate_limit_type:
 * max_parallel_requests` — as a response header and/or a structured body field.
 * This is an admission failure, not an upstream rate/quota limit: the request
 * never reached a model. Retrying it inside the transport (honoring the proxy's
 * `Retry-After`, up to {@link DEFAULT_MAX_ATTEMPTS} times) duplicates — worse,
 * at 60s per sleep instead of 5s — the concurrency backoff and model fallback
 * that `TurnRecovery` already owns, stalling one turn for up to ~300s
 * (issue #8854). {@link isConcurrencyAdmissionRejection} lets the transport
 * surface it on the first attempt so session recovery runs promptly. Genuine
 * RPM/quota 429s carry no such marker and keep honoring `Retry-After`.
 */
const CONCURRENCY_ADMISSION_LIMITER = "max_parallel_requests";

/** Body form of the marker: `"rate_limit_type": "max_parallel_requests"` (top level or under `error`). */
const CONCURRENCY_ADMISSION_BODY_PATTERN = /"rate_limit_type"\s*:\s*"max_parallel_requests"/;

/** `true` for a proxy concurrency-admission 429 that must bypass transport-level retry. */
function isConcurrencyAdmissionRejection(response: Response, bodyText: string): boolean {
	return (
		response.headers.get("rate_limit_type")?.trim() === CONCURRENCY_ADMISSION_LIMITER ||
		CONCURRENCY_ADMISSION_BODY_PATTERN.test(bodyText)
	);
}

export interface OpenAIStreamRequestInit {
	url: string;
	headers: Record<string, string>;
	/** JSON request body; serialized once per call (retries resend the same bytes). */
	body: unknown;
	signal: AbortSignal;
	fetch?: FetchImpl;
	/** Raw wire-frame observer (`onSseEvent` debug pipeline). */
	onSseEvent?: SseEventObserver;
}

export interface OpenAIStreamHandle<TEvent> {
	/** Decoded `data:` payloads; terminates on `[DONE]` or stream end. */
	events: AsyncGenerator<TEvent>;
	response: Response;
	/** `x-request-id` response header (the SDK's former `request_id`). */
	requestId: string | null;
}

/**
 * POST a JSON body and stream back decoded SSE events.
 *
 * Throws {@link OpenAIHttpError} on a non-2xx terminal response. Aborts on
 * `signal` propagate from `fetchWithRetry`/`readSseJson`; callers own the
 * watchdog timers and abort-reason bookkeeping.
 */
export async function postOpenAIStream<TEvent>(init: OpenAIStreamRequestInit): Promise<OpenAIStreamHandle<TEvent>> {
	const response = await fetchWithRetry(init.url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...init.headers },
		body: JSON.stringify(init.body),
		signal: init.signal,
		fetch: init.fetch,
		maxAttempts: DEFAULT_MAX_ATTEMPTS,
		// A proxy concurrency-admission 429 (`rate_limit_type: max_parallel_requests`)
		// surfaces immediately instead of being slept-and-retried here; session
		// recovery owns its backoff/fallback (issue #8854).
		shouldRetryResponse: (response, bodyText) => !isConcurrencyAdmissionRejection(response, bodyText),
		// Bun's native fetch enforces a hard ~300s pre-response timeout (issue #2422).
		// Cold large-context streams legitimately exceed it; the caller's
		// `firstEventTimeoutMs`/`AbortSignal` already govern stuck requests.
		timeout: false,
	});
	if (!response.ok) {
		throw await captureOpenAIHttpError(response);
	}
	if (!response.body) {
		throw new AIError.ProviderResponseError(`OpenAI stream response has no body (status ${response.status})`, {
			kind: "envelope",
		});
	}
	return {
		events: readSseJson<TEvent>(response.body, init.signal, init.onSseEvent),
		response,
		requestId: response.headers.get("x-request-id"),
	};
}

/** Decode a non-2xx response into an {@link OpenAIHttpError} without consuming it twice. */
export async function captureOpenAIHttpError(response: Response): Promise<AIError.OpenAIHttpError> {
	let bodyText: string | undefined;
	let bodyJson: unknown;
	try {
		bodyText = await response.text();
		if (bodyText.trim().length > 0) {
			try {
				bodyJson = JSON.parse(bodyText);
			} catch {}
		} else {
			bodyText = undefined;
		}
	} catch {}
	const captured: CapturedHttpErrorResponse = {
		status: response.status,
		headers: response.headers,
		bodyText,
		bodyJson,
	};
	const { detail, code } = OpenAIHttpError.parseEnvelope(bodyJson, bodyText);
	// "status code (no body)" matches the SDK's former APIError phrasing;
	// `finalizeErrorMessage` keys a repair path on that exact wording.
	const message = detail
		? `${response.status} ${detail.length > MAX_DETAIL_CHARS ? detail.slice(0, MAX_DETAIL_CHARS) : detail}`
		: `${response.status} status code (no body)`;
	return new AIError.OpenAIHttpError(message, captured, code);
}
