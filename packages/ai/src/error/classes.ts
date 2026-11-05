import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import { AbortError } from "./abort";
import { networkFailureMessage } from "./network-cause";

/** Prefix on errors raised when an Anthropic SSE stream envelope is malformed. */
export const STREAM_ENVELOPE_ERROR_PREFIX = "Anthropic stream envelope error:";

/** Structured HTTP errors thrown by provider clients. */
export interface ProviderHttpErrorOptions {
	/** Response headers; enables `retry-after`/rate-limit extraction downstream. */
	headers?: Headers;
	/** Machine-readable error code from the response body (`error.code` / `error.type`). */
	code?: string;
	cause?: unknown;
}

/** Non-2xx HTTP response from a provider. */
export class ProviderHttpError extends Error {
	readonly status: number;
	readonly headers: Headers | undefined;
	readonly code: string | undefined;

	constructor(message: string, status: number, options?: ProviderHttpErrorOptions) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderHttpError";
		this.status = status;
		this.headers = options?.headers;
		this.code = options?.code;
	}
}

/** Non-2xx response from an OpenAI-wire endpoint, with the decoded body attached. */
export class OpenAIHttpError extends ProviderHttpError {
	readonly captured: CapturedHttpErrorResponse;

	constructor(message: string, captured: CapturedHttpErrorResponse, code?: string, cause?: unknown) {
		super(message, captured.status, { headers: captured.headers, code, cause });
		this.name = "OpenAIHttpError";
		this.captured = captured;
	}

	/**
	 * Pull a human-readable message and machine code out of an OpenAI-style error
	 * envelope (`{ error: { message, code, type } }`), tolerating the flat shapes
	 * compat hosts return (`{ error: "..." }`, `{ message: "..." }`) and falling
	 * back to the raw body text.
	 */
	static parseEnvelope(
		bodyJson: unknown,
		bodyText: string | undefined,
	): { detail: string | undefined; code: string | undefined } {
		if (typeof bodyJson === "object" && bodyJson !== null) {
			const envelope = bodyJson as { error?: unknown; message?: unknown };
			// One authority for which object the error is, the flat root included: a body with no
			// `error` member but a `code` of its own is the shape compat hosts return, and dropping
			// its code made the same refusal rotate every credential over HTTP while reading
			// correctly in band.
			const source = responseErrorEnvelope(bodyJson) as
				| { message?: unknown; code?: unknown; type?: unknown }
				| undefined;
			if (source) {
				const { message, code, type } = source;
				return {
					detail: typeof message === "string" && message.length > 0 ? message : bodyText,
					code: typeof code === "string" ? code : typeof type === "string" ? type : undefined,
				};
			}
			const error = envelope.error;
			if (typeof error === "string" && error.length > 0) {
				return { detail: error, code: undefined };
			}
			if (typeof envelope.message === "string" && envelope.message.length > 0) {
				return { detail: envelope.message, code: undefined };
			}
		}
		return { detail: bodyText, code: undefined };
	}
}

/**
 * How many wrapper levels a resolve walks. The bound exists only so a malformed or hostile payload
 * cannot make the parse walk forever; the deepest nesting anyone here has a case for is three, and
 * the limit is well clear of it so that the depth is never the thing that loses a code.
 */
const MAX_WRAPPED_ENVELOPE_DEPTH = 8;

/**
 * The envelope inside a wrapped error (`{ error: { error: { code, message } } }`), or `undefined`
 * when `error` is already an ordinary envelope.
 *
 * This is the single answer to "which object is the error", and every reader of an OpenAI-wire
 * error asks it rather than walking itself. Four review rounds of this pull request were spent on
 * two readers of one envelope disagreeing — about whether an `error` field beside a code is the
 * envelope, and about how deep a wrapper may be — and a disagreement is worse than either answer:
 * one reader recognised a refusal that the other reported as a plain failure, and the turn fell
 * between them into the generic transient classifier.
 *
 * The rules, in one place:
 * - an inner value only wins when the outer carries no `code` or `type` **string** of its own. A
 *   number in `code` is a status wearing the field's name, not a machine-readable code;
 * - the inner must be a plain, non-array object;
 * - it wins when it carries a `code`, `type` or `message` of its own, **or** when it is itself
 *   nothing but another wrapper around one. A gateway that fronts a gateway produces exactly that
 *   intermediate level, and refusing to walk through it loses the code at the bottom.
 */
export function wrappedErrorEnvelope(error: object, depth = 0): object | undefined {
	if (depth >= MAX_WRAPPED_ENVELOPE_DEPTH) return undefined;
	const outerCode = Reflect.get(error, "code");
	const outerType = Reflect.get(error, "type");
	if (typeof outerCode === "string" || typeof outerType === "string") return undefined;
	const inner: unknown = Reflect.get(error, "error");
	if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return undefined;
	const innerCode = Reflect.get(inner, "code");
	const innerType = Reflect.get(inner, "type");
	const innerMessage = Reflect.get(inner, "message");
	if (typeof innerCode === "string" || typeof innerType === "string" || typeof innerMessage === "string") {
		// This level carries fields of its own, so it is an answer; keep resolving in case a
		// further wrapper below it carries the code, because the innermost envelope is the one
		// every reader wants.
		return wrappedErrorEnvelope(inner, depth + 1) ?? inner;
	}
	// Nothing of its own: a pure intermediate wrapper, which a gateway fronting a gateway produces.
	// Walk through it rather than stopping, or the code at the bottom is lost.
	return wrappedErrorEnvelope(inner, depth + 1);
}

/**
 * Which object a reader should take an error out of, given a parsed response body.
 *
 * This is the single answer for a whole body, as {@link wrappedErrorEnvelope} is for one value,
 * and it exists because every round of fixing this class found the error in one more position
 * than the previous round had enumerated. **A new position is a row in this list, never a new
 * reader.** In precedence order:
 *
 * 1. **the body root's own `code` string.** A code at the root is the flat shape compat hosts
 *    return, and an `error` field beside it is a diagnostic rather than the envelope — the same
 *    rule that governs every level below. Reading the diagnostic instead discarded the refusal
 *    and spent every stored credential;
 * 2. **`error`**, resolved to its innermost envelope;
 * 3. **`response.error`** and **`response.status_details.error`** — the Responses-shaped failure,
 *    which arrives in band on one wire and as a non-2xx body on another;
 * 4. **the body root's own `type` string**, last. `type` at the root is usually a DISCRIMINATOR
 *    naming the frame (`"error"`, `"response.failed"`), not a machine code, so it must lose to
 *    any real envelope inside the body: ranking it first read
 *    `{ type: "error", error: { code: "cyber_policy" } }` as the code `"error"` and sent the
 *    declined content to every credential. It still wins when nothing else matched, which is the
 *    host that writes its code in `type`.
 *
 * A code counts only when it is a **string**: a number there is a status wearing the field's name.
 * `undefined` when the body carries no error at all.
 */
export function responseErrorEnvelope(bodyJson: unknown): object | undefined {
	if (typeof bodyJson !== "object" || bodyJson === null || Array.isArray(bodyJson)) return undefined;
	if (typeof Reflect.get(bodyJson, "code") === "string") return bodyJson;
	const error: unknown = Reflect.get(bodyJson, "error");
	if (typeof error === "object" && error !== null && !Array.isArray(error)) {
		return wrappedErrorEnvelope(error) ?? error;
	}
	const response: unknown = Reflect.get(bodyJson, "response");
	if (typeof response === "object" && response !== null && !Array.isArray(response)) {
		const responseError: unknown = Reflect.get(response, "error");
		if (typeof responseError === "object" && responseError !== null && !Array.isArray(responseError)) {
			return wrappedErrorEnvelope(responseError) ?? responseError;
		}
		const statusDetails: unknown = Reflect.get(response, "status_details");
		if (typeof statusDetails === "object" && statusDetails !== null && !Array.isArray(statusDetails)) {
			const detailsError: unknown = Reflect.get(statusDetails, "error");
			if (typeof detailsError === "object" && detailsError !== null && !Array.isArray(detailsError)) {
				return wrappedErrorEnvelope(detailsError) ?? detailsError;
			}
		}
	}
	return typeof Reflect.get(bodyJson, "type") === "string" ? bodyJson : undefined;
}

/** Non-2xx response from the Anthropic API. */
const DEFAULT_ANTHROPIC_ERROR_BODY_READ_TIMEOUT_MS = 5_000;
const MAX_ANTHROPIC_ERROR_BODY_BYTES = 64 * 1024;
const ANTHROPIC_ERROR_BODY_TRUNCATION_MARKER = "\n[Response body truncated after 64 KiB]";
let anthropicErrorBodyReadTimeoutMs = DEFAULT_ANTHROPIC_ERROR_BODY_READ_TIMEOUT_MS;

/** Test-only control for the otherwise bounded Anthropic error-body drain. */
export const __anthropicApiErrorForTesting = {
	setBodyReadTimeoutMs(timeoutMs: number | undefined): void {
		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
			throw new RangeError("Anthropic error-body timeout must be a non-negative finite number.");
		}
		anthropicErrorBodyReadTimeoutMs = timeoutMs ?? DEFAULT_ANTHROPIC_ERROR_BODY_READ_TIMEOUT_MS;
	},
};

/** Non-2xx response from the Anthropic API. */
export class AnthropicApiError extends ProviderHttpError {
	declare readonly headers: Headers;
	readonly requestId: string | null;

	constructor(status: number, message: string, headers: Headers, options?: { code?: string; cause?: unknown }) {
		super(message, status, { headers, code: options?.code, cause: options?.cause });
		this.name = "AnthropicApiError";
		this.requestId = headers.get("request-id");
	}

	static async fromResponse(response: Response, signal?: AbortSignal): Promise<AnthropicApiError> {
		// Avoid getReader() throwing when another consumer already owns the body.
		const reader = response.body?.locked ? undefined : response.body?.getReader();

		if (!reader) {
			if (signal?.aborted) throw new AbortError("Request was aborted.");
			const detail = "status code (no body)";
			return new AnthropicApiError(response.status, `${response.status} ${detail}`, response.headers);
		}

		let aborted = false;
		let timedOut = false;
		let readerCancelled = false;
		const cancelReader = () => {
			if (readerCancelled) return;
			readerCancelled = true;
			void reader.cancel().catch(() => {});
		};
		const onAbort = () => {
			if (aborted) return;
			aborted = true;
			cancelReader();
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		const deadline = performance.now() + anthropicErrorBodyReadTimeoutMs;
		const timeout = setTimeout(() => {
			timedOut = true;
			cancelReader();
		}, anthropicErrorBodyReadTimeoutMs);

		let capturedBytes = 0;
		let truncated = false;
		const bodyChunks: string[] = [];
		try {
			const decoder = new TextDecoder();
			let cleanEof = false;
			while (!aborted && !timedOut) {
				if (performance.now() >= deadline) {
					timedOut = true;
					cancelReader();
					break;
				}

				let result: { readonly done: boolean; readonly value?: Uint8Array };
				try {
					result = await reader.read();
				} catch {
					break;
				}
				if (aborted || timedOut) break;
				if (result.done) {
					cleanEof = true;
					break;
				}

				const chunk = result.value;
				if (!chunk) break;
				const bytesToCapture = Math.min(MAX_ANTHROPIC_ERROR_BODY_BYTES - capturedBytes, chunk.byteLength);
				if (bytesToCapture > 0) {
					bodyChunks.push(decoder.decode(chunk.subarray(0, bytesToCapture), { stream: true }));
					capturedBytes += bytesToCapture;
				}
				if (bytesToCapture < chunk.byteLength) {
					truncated = true;
					cancelReader();
					break;
				}
			}
			if (aborted || signal?.aborted) throw new AbortError("Request was aborted.");
			if (cleanEof) bodyChunks.push(decoder.decode());
			if (truncated) bodyChunks.push(ANTHROPIC_ERROR_BODY_TRUNCATION_MARKER);
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reader.releaseLock();
		}

		const detail = bodyChunks.join("").trim() || "status code (no body)";
		let code: string | undefined;
		try {
			const parsed: unknown = JSON.parse(detail);
			if (parsed && typeof parsed === "object" && "error" in parsed) {
				const err = parsed.error;
				if (err && typeof err === "object") {
					if (
						"details" in err &&
						err.details &&
						typeof err.details === "object" &&
						"error_code" in err.details &&
						typeof err.details.error_code === "string"
					) {
						code = err.details.error_code;
					} else if ("type" in err && typeof err.type === "string") {
						code = err.type;
					}
				}
			}
		} catch {}
		return new AnthropicApiError(response.status, `${response.status} ${detail}`, response.headers, { code });
	}
}

/** Network-level failure (DNS, TLS, socket reset) after retries were exhausted. */
export class AnthropicConnectionError extends Error {
	constructor(cause: unknown, requestUrl?: string) {
		super(networkFailureMessage(cause, requestUrl) ?? "Connection error.", { cause });
		this.name = "AnthropicConnectionError";
	}
}

/** No response headers arrived within the configured request timeout. */
export class AnthropicConnectionTimeoutError extends Error {
	constructor() {
		super("Request timed out.");
		this.name = "AnthropicConnectionTimeoutError";
	}
}

/**
 * A malformed or truncated Anthropic SSE stream envelope — events arriving out
 * of order (before `message_start`), a retryable in-band `error` frame that ends
 * the message before its terminal frame, or otherwise a stream that never
 * reached that frame. A deterministic provider rejection keeps its
 * completed-turn error instead. The message is prefixed with
 * {@link STREAM_ENVELOPE_ERROR_PREFIX} so the shared envelope predicates
 * classify it.
 */
export class AnthropicStreamEnvelopeError extends Error {
	constructor(detail: string) {
		super(`${STREAM_ENVELOPE_ERROR_PREFIX} ${detail}`);
		this.name = "AnthropicStreamEnvelopeError";
	}
}

/** Non-2xx response (or in-stream exception event) from the Bedrock runtime API. */
export class BedrockApiError extends ProviderHttpError {
	override readonly name = "BedrockApiError";
}

/** Non-2xx response (or in-stream error chunk) from the Cloud Code Assist API. */
export class GeminiCliApiError extends ProviderHttpError {
	override readonly name = "GeminiCliApiError";
}

/** Non-2xx response (or in-stream error chunk) from the Google Generative Language / Vertex API. */
export class GoogleApiError extends ProviderHttpError {
	override readonly name = "GoogleApiError";
}

/** Non-2xx response from the Ollama `/api/chat` endpoint. */
export class OllamaApiError extends ProviderHttpError {
	override readonly name = "OllamaApiError";
}

/** Auth gateway HTTP failure. */
export class AuthGatewayError extends ProviderHttpError {
	constructor(message: string, status: number, headers?: Headers, code?: string) {
		super(message, status, { headers, code });
		this.name = "AuthGatewayError";
	}
}

export class CodexWebSocketTransportError extends Error {
	constructor(detail: string) {
		super(`Codex websocket transport failure: ${detail}`);
		this.name = "CodexWebSocketTransportError";
	}
}

export class CodexWhitespaceToolCallLoopError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexWhitespaceToolCallLoopError";
	}
}

export class CodexProviderStreamError extends Error {
	readonly retryable: boolean;

	constructor(message: string, options?: { retryable?: boolean; cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = "CodexProviderStreamError";
		this.retryable = options?.retryable !== false;
	}
}

export class AuthBrokerError extends Error {
	readonly status: number | undefined;
	readonly body: string | undefined;
	constructor(message: string, opts: { status?: number; body?: string; cause?: unknown } = {}) {
		super(message, { cause: opts.cause });
		this.name = "AuthBrokerError";
		this.status = opts.status;
		this.body = opts.body;
	}
}

export class AuthBrokerStreamUnsupportedError extends AuthBrokerError {
	constructor(message = "Auth broker does not support /v1/snapshot/stream") {
		super(message, { status: 404 });
		this.name = "AuthBrokerStreamUnsupportedError";
	}
}
