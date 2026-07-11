import type { CapturedHttpErrorResponse } from "../utils/http-inspector";

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
			const error = envelope.error;
			if (typeof error === "object" && error !== null) {
				const { message, code, type } = error as { message?: unknown; code?: unknown; type?: unknown };
				return {
					detail: typeof message === "string" && message.length > 0 ? message : bodyText,
					code: typeof code === "string" ? code : typeof type === "string" ? type : undefined,
				};
			}
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

/** Non-2xx response from the Anthropic API. */
export class AnthropicApiError extends ProviderHttpError {
	declare readonly headers: Headers;
	readonly requestId: string | null;

	constructor(status: number, message: string, headers: Headers) {
		super(message, status, { headers });
		this.name = "AnthropicApiError";
		this.requestId = headers.get("request-id");
	}

	static async fromResponse(response: Response): Promise<AnthropicApiError> {
		const body = await response.text().catch(() => "");
		const detail = body.trim() || "status code (no body)";
		return new AnthropicApiError(response.status, `${response.status} ${detail}`, response.headers);
	}
}

/** Network-level failure (DNS, TLS, socket reset) after retries were exhausted. */
export class AnthropicConnectionError extends Error {
	constructor(cause: unknown) {
		super("Connection error.", { cause });
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
 * A malformed Anthropic SSE stream envelope — events arriving out of order
 * (before `message_start`) or otherwise violating the message-event grammar.
 * The message is prefixed with {@link STREAM_ENVELOPE_ERROR_PREFIX} so the
 * shared envelope predicates classify it.
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
