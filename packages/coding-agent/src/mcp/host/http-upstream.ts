/**
 * Streamable HTTP upstream of the MCP host, in both bindings.
 *
 * - `modern` (2026-07-28): every message is its own POST carrying the request
 *   metadata headers; the answer is one JSON object or an SSE stream that ends
 *   with the response. There is no session, no GET stream, no DELETE and no
 *   resumption, and closing the response stream is the cancellation.
 * - `legacy` (2025-03-26 … 2025-11-25): the handshake-era binding with
 *   `Mcp-Session-Id`, the optional GET listener, `Last-Event-ID` resumption and
 *   DELETE on close.
 *
 * Neither mode applies a request deadline or refreshes credentials: the
 * session bounds its requests and, on a 401/403, re-resolves its headers and
 * attaches to the unit those headers identify.
 */
import { isRecord, logger, postmortem, readSseEvents, readSseJson } from "@oh-my-pi/pi-utils";
import {
	createMCPJsonRpcError,
	type MCPFailureStage,
	MCPTransportError,
	mcpTraceIdFromHeaders,
	nonRetryableMCPTransportError,
	normalizeMCPTransportError,
} from "../errors";
import { routeProgressNotification, withProgressToken } from "../progress";
import { MCP_PROTOCOL_VERSION, MCPMeta } from "../protocol";
import { RequestIdAllocator } from "../request-id";
import type { JsonRpcError, JsonRpcMessage, MCPRequestOptions, MCPTransport } from "../types";
import { toJsonRpcError } from "../types";
import type { McpRemoteSpec } from "./contract";
import { type MCPFetchInit, mcpFetch, withoutHeader } from "./header-policy";
import { jsonRpcErrorOf } from "./stdio-upstream";

/** Which Streamable HTTP binding an {@link HttpUpstream} speaks. */
export type HttpUpstreamMode = "modern" | "legacy";

const SSE_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_SSE_RETRY_MS = 3_000;
/** Bound on the best-effort session DELETE when the spec sets none, so `close()` cannot hang on a dead origin. */
const SESSION_DELETE_TIMEOUT_MS = 5_000;

/** Request parameter that names the target of a method, mirrored into `Mcp-Name`. */
const NAME_PARAM: Record<string, "name" | "uri"> = {
	"tools/call": "name",
	"prompts/get": "name",
	"resources/read": "uri",
};

const BASE64_SENTINEL = /^=\?base64\?.*\?=$/;
/** Visible ASCII, space and tab, without leading or trailing whitespace. */
const PLAIN_HEADER_VALUE = /^(?:[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?)?$/;

/**
 * Encode a value for an `Mcp-Name` or `Mcp-Param-*` header: as-is when it is
 * plain visible ASCII, otherwise (and when it would read as the sentinel
 * itself) `=?base64?…?=` around the Base64 of its UTF-8 bytes.
 */
export function encodeMcpHeaderValue(value: string | number | boolean): string {
	const text = String(value);
	if (PLAIN_HEADER_VALUE.test(text) && !BASE64_SENTINEL.test(text)) return text;
	return `=?base64?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

interface SSEResumeState {
	lastEventId: string | null;
	retryMs: number;
}

/** How long `initialize` waits for the optional GET listener to open; 0 waits for the server's answer. */
function sseConnectTimeoutMs(timeoutMs: number): number {
	if (timeoutMs <= 0) return 0;
	return Math.max(1, Math.min(SSE_CONNECT_TIMEOUT_MS, Math.floor(timeoutMs / 4)));
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("MCP HTTP request aborted", "AbortError");
}

function notConnected(): MCPTransportError {
	return new MCPTransportError({
		transport: "http",
		stage: "connect",
		failure: "closed",
		message: "Transport not connected",
		retryable: true,
	});
}

/**
 * A failure after the server accepted the POST: it may have executed the
 * request, so it is never retryable and carries no status a caller could
 * mistake for an unsent request's.
 */
function resumeError(message: string): MCPTransportError {
	return new MCPTransportError({ transport: "http", stage: "receive", failure: "eof", message, retryable: false });
}

/** One remote MCP endpoint reached by POST, with optional SSE responses. */
export class HttpUpstream implements MCPTransport {
	readonly #spec: McpRemoteSpec;
	readonly #mode: HttpUpstreamMode;
	#connected = false;
	#sessionId: string | null = null;
	#sseConnection: AbortController | null = null;
	readonly #requestIds = new RequestIdAllocator();
	readonly #progressCallbacks = new Map<string | number, NonNullable<MCPRequestOptions["onProgress"]>>();
	#lifecycleController = new AbortController();
	readonly #activeRequests = new Set<Promise<unknown>>();
	readonly #activeFetches = new Set<Promise<Response>>();
	readonly #backgroundDrains = new Set<Promise<void>>();
	#closePromise: Promise<void> | null = null;
	/**
	 * Legacy mode: the version negotiated by `initialize`, echoed in
	 * `MCP-Protocol-Version` afterwards. `null` until then, because a server
	 * that only knows an older revision may reject a header sent before
	 * negotiation. Modern mode takes the header from each request's `_meta`.
	 */
	#protocolVersion: string | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/**
	 * Modern mode: further client-generated headers for a request, such as the
	 * `Mcp-Param-*` mirror of annotated tool arguments. They never override the
	 * standard request headers.
	 */
	requestHeaders?: (method: string, params: Record<string, unknown>) => Record<string, string> | undefined;

	constructor(spec: McpRemoteSpec, mode: HttpUpstreamMode) {
		this.#spec = spec;
		this.#mode = mode;
	}

	/**
	 * Fetch the endpoint with header precedence and origin policy.
	 * `MCP-Protocol-Version` belongs to the upstream: it is stripped from the
	 * configured headers so configuration can never inject it.
	 */
	#fetch(init: MCPFetchInit, generated: Record<string, string>): Promise<Response> {
		const configured = withoutHeader(this.#spec.headers, "MCP-Protocol-Version");
		const withVersion =
			this.#protocolVersion === null ? generated : { "MCP-Protocol-Version": this.#protocolVersion, ...generated };
		const request = mcpFetch(
			this.#spec.url,
			init,
			{ generated: withVersion, configured },
			this.#spec.headerPolicy === "origin-locked",
		);
		this.#activeFetches.add(request);
		void request.then(
			() => this.#activeFetches.delete(request),
			() => this.#activeFetches.delete(request),
		);
		return request;
	}

	/** Headers of a POST. `method` is undefined for a JSON-RPC response, which only the legacy binding sends. */
	#postHeaders(method: string | undefined, params: Record<string, unknown>): Record<string, string> {
		const standard: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (this.#mode === "legacy" || method === undefined) {
			if (this.#sessionId) standard["Mcp-Session-Id"] = this.#sessionId;
			return standard;
		}
		const meta = isRecord(params._meta) ? params._meta : undefined;
		const version = meta?.[MCPMeta.protocolVersion];
		standard["MCP-Protocol-Version"] = typeof version === "string" ? version : MCP_PROTOCOL_VERSION;
		standard["Mcp-Method"] = method;
		const nameParam = Object.hasOwn(NAME_PARAM, method) ? params[NAME_PARAM[method]] : undefined;
		if (typeof nameParam === "string") standard["Mcp-Name"] = encodeMcpHeaderValue(nameParam);
		return { ...this.requestHeaders?.(method, params), ...standard };
	}

	/** Combine caller cancellation with upstream shutdown for every HTTP operation. */
	#operationSignal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.#lifecycleController.signal]) : this.#lifecycleController.signal;
	}

	/**
	 * Shutdown plus the spec's bound, for the steps no caller signal covers
	 * (notifications, responses to the server). `lift` ends the bound once the
	 * step is done: a response body that outlives the step is then cut only by
	 * shutdown, not by a timer that covered sending.
	 */
	#bound(): { signal: AbortSignal; expired(): boolean; lift(): void } {
		const timeoutMs = this.#spec.timeoutMs;
		if (timeoutMs <= 0) return { signal: this.#lifecycleController.signal, expired: () => false, lift: () => {} };
		const expiry = new AbortController();
		const timer = setTimeout(() => expiry.abort(), timeoutMs);
		return {
			signal: AbortSignal.any([this.#lifecycleController.signal, expiry.signal]),
			expired: () => expiry.signal.aborted,
			lift: () => clearTimeout(timer),
		};
	}

	/** Keep a rejection observer on public requests even if a caller abandons the returned promise. */
	#trackRequest<T>(request: Promise<T>): Promise<T> {
		this.#activeRequests.add(request);
		void request.then(
			() => this.#activeRequests.delete(request),
			() => this.#activeRequests.delete(request),
		);
		return request;
	}

	/** Own a fire-and-forget body drain until it settles. */
	#trackBackgroundDrain(drain: Promise<void>): void {
		const handled = drain.catch(error => {
			if (error instanceof Error && error.name === "AbortError") return;
			logger.debug("MCP HTTP background drain failed", {
				url: this.#spec.url,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this.#backgroundDrains.add(handled);
		void handled.then(() => this.#backgroundDrains.delete(handled));
	}

	/** Record the protocol version negotiated during a legacy `initialize`. */
	setProtocolVersion(version: string): void {
		if (this.#mode === "legacy") this.#protocolVersion = version;
	}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.#spec.url;
	}

	/** Mark the upstream usable. HTTP holds no connection; the first request proves reachability. */
	async connect(): Promise<void> {
		if (this.#connected) return;
		if (this.#closePromise) await this.#closePromise;
		if (this.#lifecycleController.signal.aborted) {
			this.#lifecycleController = new AbortController();
		}
		this.#closePromise = null;
		this.#connected = true;
	}

	/**
	 * Legacy mode: open the optional GET stream for server-initiated messages.
	 * Resolves once the stream is established, refused, the startup bound
	 * passed or `signal` aborted, which gives up on a stream still being
	 * opened and leaves an established one alone; reading continues in the
	 * background and `onClose` fires when an established stream ends. No-op in
	 * modern mode, which has no GET stream.
	 */
	async startSSEListener(signal?: AbortSignal): Promise<void> {
		if (this.#mode !== "legacy" || !this.#connected || this.#sseConnection || signal?.aborted) return;

		const connection = new AbortController();
		this.#sseConnection = connection;
		const generated: Record<string, string> = { Accept: "text/event-stream" };
		if (this.#sessionId) generated["Mcp-Session-Id"] = this.#sessionId;

		let response: Response | null;
		let abandoned = false;
		let startupFinished = false;
		const startupTimeoutMs = sseConnectTimeoutMs(this.#spec.timeoutMs);
		const fetchPromise = this.#fetch({ method: "GET", signal: this.#operationSignal(connection.signal) }, generated);
		const startup = Promise.withResolvers<null>();
		const abandon = (): void => {
			if (!startupFinished) {
				abandoned = true;
				connection.abort();
			}
			startup.resolve(null);
		};
		const startupTimer = startupTimeoutMs > 0 ? setTimeout(abandon, startupTimeoutMs) : undefined;
		signal?.addEventListener("abort", abandon, { once: true });
		try {
			response = await Promise.race([fetchPromise, startup.promise]);
		} catch (error) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			if (error instanceof Error && error.name !== "AbortError" && !abandoned) {
				this.onError?.(error);
			}
			return;
		} finally {
			startupFinished = true;
			clearTimeout(startupTimer);
			signal?.removeEventListener("abort", abandon);
		}
		if (response === null) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			void fetchPromise.then(lateResponse => lateResponse.body?.cancel()).catch(() => {});
			return;
		}

		if (this.#sseConnection !== connection) {
			await response.body?.cancel();
			return;
		}
		if (response.status === 405 || !response.ok || !response.body) {
			await response.body?.cancel();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			return;
		}

		// Established: read in the background. A stream that ends on its own
		// (server restart, network drop) means the session is gone.
		this.#trackBackgroundDrain(
			this.#runSSEListener(response.body, this.#operationSignal(connection.signal)).finally(() => {
				const wasConnected = this.#connected;
				if (this.#sseConnection === connection) this.#sseConnection = null;
				if (wasConnected) this.onClose?.();
			}),
		);
	}

	async #readSSEStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const message of readSseJson<JsonRpcMessage>(body, signal)) {
				if (!this.#connected) break;
				this.#dispatchSSEMessage(message);
			}
		} catch (error) {
			if (error instanceof Error && error.name !== "AbortError") {
				logger.debug("HTTP SSE stream error", { url: this.#spec.url, error: error.message });
				this.onError?.(error);
			}
		}
	}

	/**
	 * Read the long-lived GET stream, resuming with `Last-Event-ID` when the
	 * server closes the physical connection mid-stream (2025-11-25 permits
	 * polling-style servers). Returns only when the logical stream ends. A
	 * resume cycle that delivers no events before dropping again ends the
	 * stream rather than retrying forever against a broken server.
	 */
	async #runSSEListener(initialBody: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		const resume: SSEResumeState = { lastEventId: null, retryMs: DEFAULT_SSE_RETRY_MS };
		let body = initialBody;
		let progressed = true;
		for (;;) {
			try {
				for await (const event of readSseEvents(body, signal)) {
					progressed = true;
					if (event.id !== undefined) resume.lastEventId = event.id || null;
					if (event.retry !== undefined) resume.retryMs = event.retry;
					if (event.data === "") continue;
					if (!this.#connected) return;
					this.#dispatchSSEMessage(JSON.parse(event.data));
				}
			} catch (error) {
				if (signal.aborted) return;
				logger.debug("HTTP SSE stream error", {
					url: this.#spec.url,
					error: error instanceof Error ? error.message : String(error),
				});
				if (resume.lastEventId === null) {
					if (error instanceof Error) this.onError?.(error);
					return;
				}
			}
			if (!this.#connected || signal.aborted || resume.lastEventId === null || !progressed) return;
			progressed = false;
			try {
				body = await this.#fetchSSEResume(resume, signal);
			} catch (error) {
				if (!signal.aborted) {
					logger.debug("HTTP SSE listener resume failed", {
						url: this.#spec.url,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
		}
	}

	/**
	 * Legacy mode: resume a logical SSE stream via GET + `Last-Event-ID` after
	 * the server-provided retry interval.
	 *
	 * @throws MCPTransportError, never retryable: the POST behind the stream was already accepted.
	 */
	async #fetchSSEResume(resume: SSEResumeState, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
		if (resume.lastEventId === null) {
			throw resumeError("SSE stream ended without a resumable event ID");
		}
		await Promise.race([Bun.sleep(resume.retryMs), abortion(signal)]);
		const generated: Record<string, string> = {
			Accept: "text/event-stream",
			"Last-Event-ID": resume.lastEventId,
		};
		if (this.#sessionId) generated["Mcp-Session-Id"] = this.#sessionId;
		const response = await this.#fetch({ method: "GET", signal }, generated);
		if (!response.ok) {
			const text = await response.text().catch(() => {
				signal.throwIfAborted();
				return "";
			});
			throw resumeError(`HTTP ${response.status} resuming MCP SSE stream: ${text}`);
		}
		const contentType = response.headers.get("Content-Type") ?? "";
		if (!contentType.includes("text/event-stream") || !response.body) {
			await response.body?.cancel();
			throw resumeError(`MCP SSE resume returned unsupported Content-Type: ${contentType || "(missing)"}`);
		}
		return response.body;
	}

	/** Route a message (or batch) that is not the awaited response. */
	#dispatchSSEMessage(message: unknown): void {
		if (Array.isArray(message)) {
			for (const entry of message) this.#dispatchSSEMessage(entry);
			return;
		}
		if (!isRecord(message) || typeof message.method !== "string") return;
		const id = message.id;
		if (typeof id === "string" || typeof id === "number") {
			// The modern binding forbids server requests; asks arrive as `input_required` results.
			if (this.#mode === "legacy") void this.#handleServerRequest(id, message.method, message.params);
			else logger.debug("Ignored a server request on a modern MCP stream", { method: message.method });
			return;
		}
		routeProgressNotification(message.method, message.params, token => this.#progressCallbacks.get(token));
		this.onNotification?.(message.method, message.params);
	}

	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
		return this.#trackRequest(this.#executeRequest<T>(method, params, options));
	}

	async #executeRequest<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		if (!this.#connected) throw notConnected();

		const id = this.#requestIds.next(this.#spec.requestIdFormat);
		options?.onRequestId?.(id);
		const payload = options?.onProgress ? withProgressToken(params, id) : (params ?? {});
		const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: payload });
		const generated = this.#postHeaders(method, payload);

		// Legacy: caller cancellation owns the request only until its response
		// arrives; messages the server keeps sending on the same stream belong
		// to the upstream. Modern: the stream is the request, start to end.
		let callerSignal = options?.signal;
		let releaseCaller: (() => void) | undefined;
		if (this.#mode === "legacy" && options?.signal) {
			const source = options.signal;
			const controller = new AbortController();
			const forwardAbort = (): void => controller.abort(source.reason);
			if (source.aborted) forwardAbort();
			else {
				source.addEventListener("abort", forwardAbort, { once: true });
				releaseCaller = () => source.removeEventListener("abort", forwardAbort);
			}
			callerSignal = controller.signal;
		}
		const signal = this.#operationSignal(callerSignal);
		const sentSession = this.#sessionId;
		let sessionExpired = false;
		let stage: MCPFailureStage = "send";
		let accepted = false;
		let traceId: string | undefined;

		try {
			if (options?.onProgress) this.#progressCallbacks.set(id, options.onProgress);
			const response = await this.#fetch({ method: "POST", body, signal }, generated);
			stage = "receive";
			traceId = mcpTraceIdFromHeaders(response.headers);

			if (this.#mode === "legacy") {
				const newSessionId = response.headers.get("Mcp-Session-Id");
				if (newSessionId) this.#sessionId = newSessionId;
			}

			if (!response.ok) {
				// A handshake-era server answers 404 to a session id it no longer knows.
				sessionExpired = sentSession !== null && response.status === 404;
				throw await this.#statusError(response, traceId);
			}
			accepted = true;

			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream")) {
				return this.#mode === "legacy"
					? await this.#parseSSEResponse<T>(response, id, signal, traceId, releaseCaller)
					: await this.#readModernStream<T>(response, id, signal, traceId);
			}

			stage = "decode";
			const result: unknown = await response.json();
			if (!isRecord(result) || result.jsonrpc !== "2.0" || (!("result" in result) && !("error" in result))) {
				throw new SyntaxError("Malformed JSON-RPC response");
			}
			if (result.error !== undefined) {
				const rpc = jsonRpcErrorOf(result.error);
				if (!rpc) throw new SyntaxError("Malformed JSON-RPC error response");
				throw createMCPJsonRpcError("http", rpc, traceId);
			}
			return result.result as T;
		} catch (error) {
			if (signal.aborted) throw abortError(signal);
			if (error instanceof Error && error.name === "AbortError") throw error;
			const normalized = normalizeMCPTransportError(error, { transport: "http", stage, traceId });
			// A reset or EOF can follow the server reading the POST; only a
			// connection-establishment failure or a refusing status proves it was not processed.
			const lost = normalized.failure === "reset" || normalized.failure === "eof";
			throw accepted || lost ? nonRetryableMCPTransportError(normalized) : normalized;
		} finally {
			this.#progressCallbacks.delete(id);
			releaseCaller?.();
			if (sessionExpired) this.#retireSession(sentSession);
		}
	}

	/**
	 * The server ended the session: nothing sent on it can succeed any more.
	 * Close without the DELETE an unknown session has no use for; `onClose`
	 * tells the owner, which opens a new session with a new upstream.
	 */
	#retireSession(expired: string | null): void {
		if (this.#sessionId === expired) this.#sessionId = null;
		void this.close();
	}

	/**
	 * The error for a non-2xx POST response. The message keeps the
	 * `HTTP <status>: <body> [WWW-Authenticate: …; Mcp-Auth-Server: …]` form
	 * OAuth discovery parses.
	 *
	 * A modern server reports protocol errors (header mismatch, unsupported
	 * version, unknown method) as a JSON-RPC error body under a 4xx status:
	 * that error is surfaced as the server's own (`failure: "json_rpc"`), with
	 * the status error as its `cause` for callers that classify by status.
	 */
	async #statusError(response: Response, traceId: string | undefined): Promise<MCPTransportError> {
		const status = response.status;
		const text = await response.text();
		const wwwAuthenticate = response.headers.get("WWW-Authenticate");
		const mcpAuthServer = response.headers.get("Mcp-Auth-Server");
		const authHints = [
			wwwAuthenticate ? `WWW-Authenticate: ${wwwAuthenticate}` : null,
			mcpAuthServer ? `Mcp-Auth-Server: ${mcpAuthServer}` : null,
		]
			.filter(Boolean)
			.join("; ");
		const suffix = authHints ? ` [${authHints}]` : "";
		const statusError = new MCPTransportError({
			transport: "http",
			stage: "receive",
			failure: "http_status",
			message: `HTTP ${status}: ${text}${suffix}`,
			retryable: status === 404 || status === 502 || status === 503,
			code: status,
			traceId,
		});
		if (this.#mode === "legacy" || status === 401 || status === 403) return statusError;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return statusError;
		}
		const rpc: JsonRpcError | undefined = isRecord(parsed) ? jsonRpcErrorOf(parsed.error) : undefined;
		if (!rpc) return statusError;
		const rpcError = createMCPJsonRpcError("http", rpc, traceId);
		return new MCPTransportError({
			transport: rpcError.transport,
			stage: rpcError.stage,
			failure: rpcError.failure,
			message: rpcError.message,
			retryable: false,
			code: rpcError.code,
			data: rpcError.data,
			traceId: rpcError.traceId,
			rpc,
			cause: statusError,
		});
	}

	/**
	 * Modern mode: read the SSE answer to one POST. Notifications before the
	 * response go to their handlers; the response ends the read and closes the
	 * stream. A `subscriptions/listen` stream simply stays open until the
	 * server ends it or `signal` aborts, which closes it — the binding's
	 * cancellation.
	 */
	async #readModernStream<T>(
		response: Response,
		expectedId: string | number,
		signal: AbortSignal,
		traceId: string | undefined,
	): Promise<T> {
		const body = response.body;
		if (!body) {
			throw new MCPTransportError({
				transport: "http",
				stage: "decode",
				failure: "malformed_response",
				message: "SSE response did not include a body",
				retryable: false,
				traceId,
			});
		}
		try {
			for await (const event of readSseEvents(body, signal)) {
				if (event.data === "") continue;
				const raw: unknown = JSON.parse(event.data);
				for (const message of Array.isArray(raw) ? raw : [raw]) {
					if (!isRecord(message)) continue;
					if (typeof message.method === "string" || message.id !== expectedId) {
						this.#dispatchSSEMessage(message);
						continue;
					}
					if (message.error === undefined) return message.result as T;
					const rpc = jsonRpcErrorOf(message.error);
					if (!rpc) throw new SyntaxError("Malformed JSON-RPC error response");
					throw createMCPJsonRpcError("http", rpc, traceId);
				}
			}
		} finally {
			await body.cancel().catch(() => {});
		}
		signal.throwIfAborted();
		throw new MCPTransportError({
			transport: "http",
			stage: "receive",
			failure: "eof",
			message: `No response received for request ID ${expectedId}`,
			retryable: false,
			traceId,
		});
	}

	/**
	 * Legacy mode: read the SSE answer to one POST. The stream may carry
	 * server requests and notifications around the response and may be cut and
	 * resumed with `Last-Event-ID`; it is drained to its end in the background
	 * even after the response settled the returned promise.
	 */
	#parseSSEResponse<T>(
		response: Response,
		expectedId: string | number,
		signal: AbortSignal,
		traceId: string | undefined,
		releaseCaller: (() => void) | undefined,
	): Promise<T> {
		const firstBody = response.body;
		if (!firstBody) {
			throw new MCPTransportError({
				transport: "http",
				stage: "decode",
				failure: "malformed_response",
				message: "SSE response did not include a body",
				retryable: false,
				traceId,
			});
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		// The upstream owns this promise until the physical drain exits; keep a
		// rejection observer attached even when a caller abandons the request.
		void promise.catch(() => {});
		const resume: SSEResumeState = { lastEventId: null, retryMs: DEFAULT_SSE_RETRY_MS };
		let captured = false;

		const drain = async (): Promise<void> => {
			let current: ReadableStream<Uint8Array> = firstBody;
			try {
				for (;;) {
					try {
						for await (const event of readSseEvents(current, signal)) {
							if (event.id !== undefined) resume.lastEventId = event.id || null;
							if (event.retry !== undefined) resume.retryMs = event.retry;
							if (event.data === "") continue;
							const raw: unknown = JSON.parse(event.data);
							for (const message of Array.isArray(raw) ? raw : [raw]) {
								if (!isRecord(message)) continue;
								if (
									!captured &&
									message.id === expectedId &&
									typeof message.method !== "string" &&
									("result" in message || "error" in message)
								) {
									captured = true;
									// The same batch may hold notifications after this response.
									this.#progressCallbacks.delete(expectedId);
									releaseCaller?.();
									if (message.error === undefined) {
										resolve(message.result as T);
										continue;
									}
									const rpc = jsonRpcErrorOf(message.error);
									reject(
										rpc
											? createMCPJsonRpcError("http", rpc, traceId)
											: new MCPTransportError({
													transport: "http",
													stage: "decode",
													failure: "malformed_response",
													message: "Malformed JSON-RPC error response",
													retryable: false,
													traceId,
												}),
									);
									continue;
								}
								if (!this.#connected) continue;
								this.#dispatchSSEMessage(message);
							}
						}
					} catch (error) {
						// An abrupt drop is as resumable as a server-initiated close once an event ID exists.
						if (captured) return;
						if (signal.aborted || resume.lastEventId === null) throw error;
						logger.debug("MCP SSE response stream dropped; resuming", {
							url: this.#spec.url,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					if (captured) return;
					if (signal.aborted) throw abortError(signal);
					if (resume.lastEventId === null) {
						throw new MCPTransportError({
							transport: "http",
							stage: "receive",
							failure: "eof",
							message: `No response received for request ID ${expectedId}`,
							retryable: false,
							traceId,
						});
					}
					current = await this.#fetchSSEResume(resume, signal);
				}
			} catch (error) {
				if (captured) return;
				// The server accepted this POST before the drain or a resume
				// failed, so nothing here may invite a replay.
				if (signal.aborted) {
					reject(abortError(signal));
				} else {
					reject(
						nonRetryableMCPTransportError(
							normalizeMCPTransportError(error, {
								transport: "http",
								stage: error instanceof SyntaxError ? "decode" : "receive",
								traceId,
							}),
						),
					);
				}
			} finally {
				await current.cancel().catch(() => {});
			}
		};

		this.#trackBackgroundDrain(drain());
		return promise;
	}

	async #handleServerRequest(id: string | number, method: string, params: unknown): Promise<void> {
		let response: Record<string, unknown>;
		try {
			if (!this.onRequest) throw Object.assign(new Error("Method not found"), { code: -32601 });
			response = { jsonrpc: "2.0", id, result: (await this.onRequest(method, params)) ?? {} };
		} catch (error) {
			response = { jsonrpc: "2.0", id, error: toJsonRpcError(error) };
		}
		if (!this.#connected) return;
		const bound = this.#bound();
		try {
			const delivered = await this.#fetch(
				{ method: "POST", body: JSON.stringify(response), signal: bound.signal },
				this.#postHeaders(undefined, {}),
			);
			await delivered.body?.cancel();
		} catch {
			// Best-effort: the server may have gone away.
		} finally {
			bound.lift();
		}
	}

	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.#trackRequest(this.#sendNotification(method, params ?? {}));
	}

	async #sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
		if (!this.#connected) throw notConnected();

		const bound = this.#bound();
		let stage: MCPFailureStage = "send";
		let traceId: string | undefined;
		try {
			const response = await this.#fetch(
				{ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method, params }), signal: bound.signal },
				this.#postHeaders(method, params),
			);
			stage = "receive";
			traceId = mcpTraceIdFromHeaders(response.headers);

			// 202 Accepted is the success status of a notification.
			if (!response.ok) {
				const text = await response.text();
				throw new MCPTransportError({
					transport: "http",
					stage,
					failure: "http_status",
					message: `HTTP ${response.status}: ${text}`,
					retryable: response.status === 404 || response.status === 502 || response.status === 503,
					code: response.status,
					traceId,
				});
			}

			// A legacy server may piggyback requests or notifications on the
			// notification's response; that body is a background server-message
			// stream from here on.
			const contentType = response.headers.get("Content-Type") ?? "";
			if (this.#mode === "legacy" && contentType.includes("text/event-stream") && response.body) {
				const drainSignal = this.#sseConnection
					? this.#operationSignal(this.#sseConnection.signal)
					: this.#lifecycleController.signal;
				this.#trackBackgroundDrain(this.#readSSEStream(response.body, drainSignal));
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			if (this.#lifecycleController.signal.aborted) throw abortError(this.#lifecycleController.signal);
			if (bound.expired()) {
				throw new MCPTransportError({
					transport: "http",
					stage,
					failure: "timeout",
					message: `Notify timeout after ${this.#spec.timeoutMs}ms`,
					retryable: false,
					traceId,
					cause: error,
				});
			}
			throw normalizeMCPTransportError(error, { transport: "http", stage, traceId });
		} finally {
			bound.lift();
		}
	}

	/**
	 * Abort everything in flight, wait until the aborted fetches and readers
	 * have unwound, end a legacy session with DELETE (best-effort), then fire
	 * `onClose`. Idempotent.
	 */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		if (!this.#connected) return Promise.resolve();
		this.#closePromise = this.#closeTransport();
		// `close()` is commonly fire-and-forget during teardown.
		void this.#closePromise.catch(() => {});
		return this.#closePromise;
	}

	async #closeTransport(): Promise<void> {
		this.#connected = false;
		const closeReason = postmortem.markExpectedCleanupError(
			new DOMException("MCP HTTP transport closed", "AbortError"),
		);
		this.#lifecycleController.abort(closeReason);

		if (this.#sseConnection) {
			this.#sseConnection.abort(closeReason);
			this.#sseConnection = null;
		}

		// Aborting is only the cancellation request. Wait until fetches and body
		// readers have observed it before teardown closes sockets underneath
		// still-running continuations.
		while (this.#activeFetches.size > 0 || this.#activeRequests.size > 0 || this.#backgroundDrains.size > 0) {
			await Promise.allSettled([...this.#activeFetches, ...this.#activeRequests, ...this.#backgroundDrains]);
		}

		if (this.#sessionId) {
			try {
				const response = await this.#fetch(
					{
						method: "DELETE",
						signal: AbortSignal.timeout(
							this.#spec.timeoutMs > 0 ? this.#spec.timeoutMs : SESSION_DELETE_TIMEOUT_MS,
						),
					},
					{ "Mcp-Session-Id": this.#sessionId },
				);
				await response.body?.cancel();
			} catch {
				// Session termination is best-effort.
			}
			this.#sessionId = null;
		}

		const onClose = this.onClose;
		this.onClose = undefined;
		try {
			onClose?.();
		} catch (error) {
			logger.debug("MCP HTTP onClose callback failed during teardown", {
				url: this.#spec.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** Rejects with the abort reason once `signal` aborts; never resolves. */
function abortion(signal: AbortSignal): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	if (signal.aborted) reject(abortError(signal));
	else signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
	return promise;
}
