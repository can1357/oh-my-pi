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
 *   are retried up to `maxRetries` times. The server-stated wait is read by
 *   the one shared reader ({@link getRetryAfterMsFromHeaders}) and bounded by
 *   the one shared ceiling ({@link retryWaitBounds}), so this client's wire
 *   retries cannot read or wait differently from the loop above them;
 *   otherwise exponential backoff (0.5s * 2^n, capped at 8s, with up to 25%
 *   jitter).
 */
import * as AIError from "../error";
import { AnthropicApiError, AnthropicConnectionError, AnthropicConnectionTimeoutError } from "../error";

export { AnthropicApiError, AnthropicConnectionError, AnthropicConnectionTimeoutError };

import { findRetryRefusal } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";
import type { ReplayBudget } from "../utils/replay-budget";
import { getRetryAfterMsFromHeaders, getShouldRetryFromHeaders, retryWaitBounds } from "../utils/retry-after";
import {
	DEFAULT_MAX_RETRY_DELAY_MS,
	markRetryWaitRefused,
	type ProviderRetryPolicy,
	sleepBeforeRetry,
} from "../utils/retry-wait";
import type { MessageCreateParams } from "./anthropic-wire";

/** Default pre-response timeout, matching the SDK's 10-minute default. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** Default retry budget, matching the SDK's default. */
const DEFAULT_MAX_RETRIES = 2;
/** Endpoint every request targets when the caller supplies no `baseURL`. */
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const INITIAL_RETRY_DELAY_S = 0.5;
const MAX_RETRY_DELAY_S = 8;

/** Per-request options accepted by {@link AnthropicMessages.create}. */
export interface AnthropicRequestOptions {
	signal?: AbortSignal;
	/** Pre-response timeout in milliseconds. */
	timeout?: number;
	/** Per-request retry budget override. */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a server-directed retry. If the
	 * server's `retry-after` hint exceeds this value, the retry is declined and
	 * the original error is surfaced. Non-positive values disable the cap. Defaults to 60000.
	 */
	maxRetryDelayMs?: number;
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
	/**
	 * Maximum delay in milliseconds to wait for a server-directed retry. If the
	 * server's `retry-after` hint exceeds this value, the retry is declined and
	 * the original error is surfaced. Non-positive values disable the cap. Defaults to 60000.
	 */
	maxRetryDelayMs?: number;
	/**
	 * The call's retry policy: its ceiling (`providerRetryWaitCeilingMs`) and
	 * its retry-wait hook, which no other option on this client carries. A
	 * call through `stream()` also leaves them in the ambient request policy,
	 * so this is what a direct provider call needs.
	 */
	retryPolicy?: ProviderRetryPolicy;
	/**
	 * The call's replay budget. Every resend this client's own retry loop makes
	 * is a replay like any other rung's: it is admitted, its wait is raced
	 * against the deadline and it is armed, so the send gate around `fetch`
	 * ({@link ReplayBudget.gateFetch}) checks the request that carries it.
	 * Unset, the loop keeps its plain bounded backoff.
	 */
	replayBudget?: ReplayBudget;
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
	const verdict = getShouldRetryFromHeaders(response.headers);
	if (verdict !== undefined) return verdict;
	const status = response.status;
	// Canonical transient set (408/429/5xx) plus 409, which Anthropic's client
	// also retries.
	return AIError.isTransientStatus(status) || status === 409;
}

/**
 * The retry policy this request's wire retries keep to: the call's own, with
 * the per-request `maxRetryDelayMs` override on top, and whatever neither
 * states filled in from the ambient request policy by `providerRetryPolicy`
 * inside {@link retryWaitBounds} and {@link sleepBeforeRetry}.
 */
function requestRetryPolicy(
	policy: ProviderRetryPolicy | undefined,
	maxRetryDelayMs: number | undefined,
): ProviderRetryPolicy {
	return { ...policy, maxRetryDelayMs: maxRetryDelayMs ?? policy?.maxRetryDelayMs };
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

	create(params: MessageCreateParams, options?: AnthropicRequestOptions): AnthropicApiRequest {
		return this.#client.request(this.#path, params, options);
	}
}

/**
 * Structural interface satisfied by both {@link AnthropicMessagesClient} and
 * SDK-style clients (e.g. `AnthropicVertex`), so callers can inject an
 * alternative Messages-API client via `AnthropicOptions.client`.
 */
export interface AnthropicMessagesClientLike {
	messages: { create(params: MessageCreateParams, options?: AnthropicRequestOptions): unknown };
	beta?: { messages: { create(params: MessageCreateParams, options?: AnthropicRequestOptions): unknown } };
	/**
	 * Endpoint the client targets, when it exposes one. SDK-style clients
	 * (`Anthropic`, `AnthropicVertex`) and {@link AnthropicMessagesClient}
	 * publish it; a client that exposes none keeps its transport opaque, and the
	 * provider must not assume the model's own routing on its behalf.
	 */
	baseURL?: string;
}

export class AnthropicMessagesClient implements AnthropicMessagesClientLike {
	readonly messages: AnthropicMessages;
	readonly beta: { readonly messages: AnthropicMessages };
	#http: AnthropicHttpClient;
	/** Endpoint shared with the HTTP transport. */
	get baseURL(): string {
		return this.#http.baseURL;
	}

	constructor(options: AnthropicClientOptions) {
		this.#http = new AnthropicHttpClient(options);
		this.messages = new AnthropicMessages(this, "/v1/messages");
		this.beta = { messages: new AnthropicMessages(this, "/v1/messages?beta=true") };
	}

	request(path: string, params: MessageCreateParams, options?: AnthropicRequestOptions): AnthropicApiRequest {
		return new AnthropicApiRequest(() => this.#http.request("POST", path, params, options));
	}
}

/** Shared Anthropic HTTP transport for Messages and resource APIs. */
export class AnthropicHttpClient {
	#options: AnthropicClientOptions;
	readonly baseURL: string;

	constructor(options: AnthropicClientOptions) {
		this.#options = options;
		this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
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
		if (requestHeaders) {
			for (const key in requestHeaders) {
				for (const existing in headers) {
					if (existing !== key && existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
				}
				headers[key] = requestHeaders[key];
			}
		}
		return headers;
	}

	async request(
		method: "GET" | "POST",
		path: string,
		params?: unknown,
		options?: AnthropicRequestOptions,
	): Promise<Response> {
		const opts = this.#options;
		const fetchFn: FetchImpl = opts.fetch ?? fetch;
		const replayBudget = opts.replayBudget;
		const callerSignal = options?.signal;
		const timeoutMs = options?.timeout ?? opts.timeout ?? DEFAULT_TIMEOUT_MS;
		const maxRetries = Math.max(0, options?.maxRetries ?? opts.maxRetries ?? DEFAULT_MAX_RETRIES);
		const policy = requestRetryPolicy(opts.retryPolicy, options?.maxRetryDelayMs ?? opts.maxRetryDelayMs);
		const waitBounds = retryWaitBounds(policy, DEFAULT_MAX_RETRY_DELAY_MS);
		const url = `${this.baseURL}${path}`;
		const headers = this.#buildHeaders(options?.headers);
		const body = params === undefined ? undefined : JSON.stringify(params);

		for (let attempt = 0; ; attempt++) {
			if (callerSignal?.aborted) throw createAbortError();

			let response: Response;
			try {
				response = await this.#fetchOnce(fetchFn, url, method, headers, body, timeoutMs, callerSignal);
			} catch (error) {
				if (callerSignal?.aborted) throw createAbortError();
				// A request the budget refused as it was handed to the transport
				// stands for the failure its replay replaced; resending it is the
				// one thing that refusal forbids.
				if (findRetryRefusal(error)) throw error;
				if (attempt < maxRetries) {
					const delayMs = Math.min(calculateAnthropicRetryDelayMs(attempt), waitBounds.maxDelayMs);
					if (replayBudget === undefined) {
						await this.#backoff(policy, delayMs, callerSignal);
						continue;
					}
					const failure =
						error instanceof AIError.AnthropicConnectionTimeoutError
							? error
							: new AIError.AnthropicConnectionError(error, url);
					if (await replayBudget.replayAfterDelay(delayMs, failure, callerSignal, policy)) continue;
					throw failure;
				}
				if (error instanceof AIError.AnthropicConnectionTimeoutError) throw error;
				throw new AIError.AnthropicConnectionError(error, url);
			}

			if (response.ok) return response;

			if (attempt < maxRetries && shouldRetryResponse(response)) {
				// Bound the server-directed wait by the one ceiling every other
				// retry in this call keeps to: a longer stated wait declines the
				// retry and surfaces the original error (status/body/headers
				// intact) so higher-level recovery can run, and the refusal is
				// recorded on it so the failed message says which bound refused
				// what. A non-positive cap disables enforcement.
				// Checked before draining the body so `fromResponse` can still read it.
				const refusedWait = waitBounds.refusal(response.headers);
				if (refusedWait !== undefined) {
					const failure = await AIError.AnthropicApiError.fromResponse(response, callerSignal);
					markRetryWaitRefused(failure, refusedWait);
					throw failure;
				}
				// The stated wait has just been checked against the ceiling, so only
				// the client's own ladder is shortened to it — the same clamp
				// `sleepBeforeRetry` applies, hoisted here so the budget admits the
				// wait this retry will actually sleep.
				const delayMs =
					getRetryAfterMsFromHeaders(response.headers) ??
					Math.min(calculateAnthropicRetryDelayMs(attempt), waitBounds.maxDelayMs);
				if (replayBudget !== undefined) {
					// The failure is materialized before the wait, because a refusal
					// answers with it and the body cannot be read afterwards.
					const failure = await AIError.AnthropicApiError.fromResponse(response, callerSignal);
					if (await replayBudget.replayAfterDelay(delayMs, failure, callerSignal, policy)) continue;
					throw failure;
				}
				await response.body?.cancel().catch(() => {});
				await this.#backoff(policy, delayMs, callerSignal);
				continue;
			}

			throw await AIError.AnthropicApiError.fromResponse(response, callerSignal);
		}
	}

	async #fetchOnce(
		fetchFn: FetchImpl,
		url: string,
		method: "GET" | "POST",
		headers: Record<string, string>,
		body: string | undefined,
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
				...this.#options.fetchOptions,
				method,
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

	/**
	 * Sleeps `delayMs` before the next wire attempt, for a call with no replay
	 * budget. The wait is the shared reader's server-stated one (a wait past
	 * the call's bound never reaches here, because the loop refused it above)
	 * or the client's own ladder already shortened to the bound;
	 * {@link sleepBeforeRetry} keeps it there and sleeps it through the call's
	 * retry-wait hook.
	 */
	async #backoff(policy: ProviderRetryPolicy, delayMs: number, signal: AbortSignal | undefined): Promise<void> {
		try {
			await sleepBeforeRetry(policy, delayMs, signal);
		} catch {
			throw createAbortError();
		}
	}
}
