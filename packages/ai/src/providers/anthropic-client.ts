/**
 * Minimal HTTP client for the Anthropic Messages API.
 *
 * pi-ai builds every request header itself (`buildAnthropicHeaders`), serializes
 * the body itself (`buildParams`), and parses SSE frames itself
 * (`iterateAnthropicEvents`), so the only `@anthropic-ai/sdk` surface this
 * package ever exercised was URL assembly, auth-header injection, bounded
 * retries, the pre-response timeout, and HTTP-error-to-status mapping. This
 * module implements exactly that surface and nothing else.
 *
 * Behavioral contract (kept compatible with the SDK so downstream error
 * classification keeps working):
 * - Non-2xx responses throw {@link AnthropicApiError} whose `status` property
 *   carries the HTTP status and whose message is `"<status> <body>"`.
 * - Pre-response timeouts throw {@link AnthropicConnectionTimeoutError}
 *   ("Request timed out.").
 * - Caller aborts throw an `Error` with message "Request was aborted.".
 * - Retries: connection errors and 408/409/429/5xx (or `x-should-retry: true`)
 *   are retried up to `maxRetries` times, honoring `retry-after-ms` /
 *   `retry-after`, otherwise exponential backoff (0.5s * 2^n, capped at 8s,
 *   with up to 25% jitter).
 */
import { scheduler } from "node:timers/promises";
import * as AIError from "../error";
import { AnthropicApiError, AnthropicConnectionError, AnthropicConnectionTimeoutError } from "../error";

export { AnthropicApiError, AnthropicConnectionError, AnthropicConnectionTimeoutError };

import type { FetchImpl } from "../types";
import type { MessageCreateParamsStreaming } from "./anthropic-wire";

/** Default pre-response timeout, matching the SDK's 10-minute default. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** Default retry budget, matching the SDK's default. */
const DEFAULT_MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_S = 0.5;
const MAX_RETRY_DELAY_S = 8;

/** Per-request options accepted by {@link AnthropicMessages.create}. */
export interface AnthropicRequestOptions {
	signal?: AbortSignal;
	/** Pre-response timeout in milliseconds. */
	timeout?: number;
	/** Per-request retry budget override. */
	maxRetries?: number;
	/** Per-request headers merged after client defaults. */
	headers?: Record<string, string>;
}

/**
 * Extra `RequestInit` fields merged into every fetch call. Bun extends
 * `RequestInit` with a `tls` option used for the Claude Code TLS profile and
 * Foundry mTLS. Core request fields (`method`, `headers`, `body`, `signal`)
 * are owned by the client and cannot be overridden from here — the timeout
 * controller's signal in particular must always win.
 */
export type AnthropicFetchOptions = RequestInit & {
	tls?: {
		rejectUnauthorized?: boolean;
		serverName?: string;
		ciphers?: string;
		ca?: string | string[];
		cert?: string;
		key?: string;
	};
	/** Bun extension: see {@link FetchWithRetryOptions.timeout} — `false` disables Bun's native fetch TTFT timeout (issue #2422). */
	timeout?: number | false;
};

export interface AnthropicClientOptions {
	/** Sent as `X-Api-Key` unless the header is already present in `defaultHeaders`. */
	apiKey?: string | null;
	/** Sent as `Authorization: Bearer <token>` unless the header is already present in `defaultHeaders`. */
	authToken?: string | null;
	baseURL?: string | null;
	maxRetries?: number;
	/** Pre-response timeout in milliseconds. Defaults to 10 minutes. */
	timeout?: number;
	defaultHeaders?: Record<string, string>;
	fetch?: FetchImpl;
	fetchOptions?: AnthropicFetchOptions;
}

function createAbortError(): Error {
	return new AIError.AbortError("Request was aborted.");
}

/** `x-should-retry` override, then 408/409/429/5xx. */
function shouldRetryResponse(response: Response): boolean {
	const shouldRetryHeader = response.headers.get("x-should-retry");
	if (shouldRetryHeader === "true") return true;
	if (shouldRetryHeader === "false") return false;
	const status = response.status;
	// Canonical transient set (408/429/5xx) plus 409, which Anthropic's client
	// also retries.
	return AIError.isTransientStatus(status) || status === 409;
}

/** Server-suggested delay (`retry-after-ms`, then `retry-after` seconds or HTTP date). */
export function retryDelayFromHeaders(headers: Headers | undefined): number | undefined {
	if (!headers) return undefined;
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const ms = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(ms) && ms >= 0) return ms;
	}
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		const dateMs = Date.parse(retryAfter) - Date.now();
		if (Number.isFinite(dateMs) && dateMs >= 0) return dateMs;
	}
	return undefined;
}

export function calculateAnthropicRetryDelayMs(attempt: number): number {
	const sleepSeconds = Math.min(INITIAL_RETRY_DELAY_S * 2 ** attempt, MAX_RETRY_DELAY_S);
	const jitter = 1 - Math.random() * 0.25;
	return sleepSeconds * jitter * 1000;
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, lowerName: string): boolean {
	for (const key in headers) {
		if (key.toLowerCase() === lowerName) return true;
	}
	return false;
}

/**
 * Lazy in-flight request handle. The HTTP request starts on the first
 * `asResponse()` call; subsequent calls return the same promise.
 *
 * Shape-compatible with the SDK's `APIPromise.asResponse()` so
 * `getAnthropicStreamResponse` treats internal and injected clients uniformly.
 */
export class AnthropicApiRequest {
	#start: () => Promise<Response>;
	#response: Promise<Response> | undefined;

	constructor(start: () => Promise<Response>) {
		this.#start = start;
	}

	asResponse(): Promise<Response> {
		this.#response ??= this.#start();
		return this.#response;
	}
}

/**
 * `messages` resource. `create` lives on the prototype so tests can intercept
 * every outgoing request with `vi.spyOn(AnthropicMessages.prototype, "create")`.
 */
export class AnthropicMessages {
	#client: AnthropicMessagesClient;
	#path: string;

	constructor(client: AnthropicMessagesClient, path: string) {
		this.#client = client;
		this.#path = path;
	}

	create(params: MessageCreateParamsStreaming, options?: AnthropicRequestOptions): AnthropicApiRequest {
		return this.#client.request(this.#path, params, options);
	}
}

/**
 * Structural interface satisfied by both {@link AnthropicMessagesClient} and
 * SDK-style clients (e.g. `AnthropicVertex`), so callers can inject an
 * alternative Messages-API client via `AnthropicOptions.client`.
 */
export interface AnthropicMessagesClientLike {
	messages: { create(params: MessageCreateParamsStreaming, options?: AnthropicRequestOptions): unknown };
	beta?: { messages: { create(params: MessageCreateParamsStreaming, options?: AnthropicRequestOptions): unknown } };
}

export class AnthropicMessagesClient implements AnthropicMessagesClientLike {
	readonly messages: AnthropicMessages;
	readonly beta: { readonly messages: AnthropicMessages };
	#options: AnthropicClientOptions;

	constructor(options: AnthropicClientOptions) {
		this.#options = options;
		this.messages = new AnthropicMessages(this, "/v1/messages");
		this.beta = { messages: new AnthropicMessages(this, "/v1/messages?beta=true") };
	}

	request(path: string, params: MessageCreateParamsStreaming, options?: AnthropicRequestOptions): AnthropicApiRequest {
		return new AnthropicApiRequest(() => this.#send(path, params, options));
	}

	#buildHeaders(requestHeaders?: Record<string, string>): Record<string, string> {
		const opts = this.#options;
		const defaults = opts.defaultHeaders ?? {};
		const headers: Record<string, string> = {};
		if (opts.apiKey != null && !hasHeaderCaseInsensitive(defaults, "x-api-key")) {
			headers["X-Api-Key"] = opts.apiKey;
		}
		if (opts.authToken != null && !hasHeaderCaseInsensitive(defaults, "authorization")) {
			headers.Authorization = `Bearer ${opts.authToken}`;
		}
		Object.assign(headers, defaults);
		Object.assign(headers, requestHeaders);
		return headers;
	}

	async #send(
		path: string,
		params: MessageCreateParamsStreaming,
		options?: AnthropicRequestOptions,
	): Promise<Response> {
		const opts = this.#options;
		const fetchFn: FetchImpl = opts.fetch ?? fetch;
		const callerSignal = options?.signal;
		const timeoutMs = options?.timeout ?? opts.timeout ?? DEFAULT_TIMEOUT_MS;
		const maxRetries = Math.max(0, options?.maxRetries ?? opts.maxRetries ?? DEFAULT_MAX_RETRIES);
		const url = `${opts.baseURL ?? "https://api.anthropic.com"}${path}`;
		const headers = this.#buildHeaders(options?.headers);
		const body = JSON.stringify(params);

		for (let attempt = 0; ; attempt++) {
			if (callerSignal?.aborted) throw createAbortError();

			let response: Response;
			try {
				response = await this.#fetchOnce(fetchFn, url, headers, body, timeoutMs, callerSignal);
			} catch (error) {
				if (callerSignal?.aborted) throw createAbortError();
				if (attempt < maxRetries) {
					await this.#backoff(attempt, undefined, callerSignal);
					continue;
				}
				if (error instanceof AIError.AnthropicConnectionTimeoutError) throw error;
				throw new AIError.AnthropicConnectionError(error);
			}

			if (response.ok) return response;

			if (attempt < maxRetries && shouldRetryResponse(response)) {
				await response.body?.cancel().catch(() => {});
				await this.#backoff(attempt, response.headers, callerSignal);
				continue;
			}
			throw await AIError.AnthropicApiError.fromResponse(response);
		}
	}

	async #fetchOnce(
		fetchFn: FetchImpl,
		url: string,
		headers: Record<string, string>,
		body: string,
		timeoutMs: number,
		callerSignal: AbortSignal | undefined,
	): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onAbort = () => controller.abort();
		callerSignal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await fetchFn(url, {
				...(this.#options.fetchOptions ?? {}),
				method: "POST",
				headers,
				body,
				signal: controller.signal,
			});
		} catch (error) {
			if (timedOut && !callerSignal?.aborted) throw new AIError.AnthropicConnectionTimeoutError();
			throw error;
		} finally {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", onAbort);
		}
	}

	async #backoff(
		attempt: number,
		responseHeaders: Headers | undefined,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const delayMs = retryDelayFromHeaders(responseHeaders) ?? calculateAnthropicRetryDelayMs(attempt);
		try {
			await scheduler.wait(delayMs, { signal });
		} catch {
			throw createAbortError();
		}
	}
}
