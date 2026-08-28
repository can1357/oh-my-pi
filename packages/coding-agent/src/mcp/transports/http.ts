/**
 * MCP HTTP transport (Streamable HTTP).
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * The negotiated protocol revision is carried in the `MCP-Protocol-Version`
 * header on every request (see `MCP_PROTOCOL_VERSION`).
 */
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isRecord, logger, postmortem, readSseEvents, readSseJson } from "@oh-my-pi/pi-utils";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	MCPHttpServerConfig,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import {
	createMCPJsonRpcError,
	type MCPFailureStage,
	MCPTransportError,
	mcpTraceIdFromHeaders,
	normalizeMCPTransportError,
} from "../errors";
import { RequestIdAllocator } from "../request-id";
import { createMCPTimeout, getNeverAbortSignal, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";
import { type MCPFetchInit, mcpFetch, withoutHeader } from "./header-policy";

const HTTP_SSE_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_SSE_RETRY_MS = 3_000;

interface SSEResumeState {
	lastEventId: string | null;
	retryMs: number;
}

/**
 * Failure resuming an accepted request's logical SSE stream. Carries a
 * never-replay contract: by resume time the server has accepted (and possibly
 * executed) the originating POST, so auth-retry paths must not re-send it.
 */
class SSEResumeError extends Error {}

/** Wait for the server-provided SSE retry interval while remaining abortable. */
async function waitForSSERetry(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw signal.reason;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	const onAbort = (): void => reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}
/**
 * Best-effort startup deadline for the optional Streamable HTTP GET SSE listener.
 *
 * Returns `0` (disabled) when the operator has explicitly disabled MCP client-side
 * timeouts via `timeout: 0` or `OMP_MCP_TIMEOUT_MS=0`, mirroring the rest of the
 * MCP timeout surface. Otherwise caps the wait at one second and scales below
 * short request timeouts so connect-time never exceeds the request budget.
 */
export function resolveSSEConnectTimeoutMs(configTimeout?: number): number {
	const requestTimeout = resolveMCPTimeoutMs(configTimeout);
	if (!isMCPTimeoutEnabled(requestTimeout)) return 0;
	const boundedTimeout = Math.min(HTTP_SSE_CONNECT_TIMEOUT_MS, Math.floor(requestTimeout / 4));
	return Math.max(1, boundedTimeout);
}
/**
 * HTTP transport for MCP servers.
 * Uses POST for requests, supports SSE responses.
 */
export class HttpTransport implements MCPTransport {
	#connected = false;
	#sessionId: string | null = null;
	#sseConnection: AbortController | null = null;
	readonly #requestIds = new RequestIdAllocator();
	#lifecycleController = new AbortController();
	readonly #activeRequests = new Set<Promise<unknown>>();
	readonly #activeFetches = new Set<Promise<Response>>();
	readonly #backgroundDrains = new Set<Promise<void>>();
	#closePromise: Promise<void> | null = null;
	/**
	 * Protocol version echoed in the `MCP-Protocol-Version` header. `null` until
	 * the `initialize` response is negotiated (via {@link setProtocolVersion}):
	 * the MCP spec requires the header only on requests *after* `initialize`, and
	 * a server that supports only an older revision may reject a header carrying
	 * a newer version sent before negotiation completes.
	 */
	#protocolVersion: string | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(private config: MCPHttpServerConfig | MCPSseServerConfig) {}

	/**
	 * Fetch the configured endpoint with header precedence and origin policy.
	 *
	 * The transport fully owns `MCP-Protocol-Version`: it is stripped from
	 * configured headers so a user's `mcp.json` can never inject it, and added
	 * only once a version is negotiated (required by the MCP Streamable HTTP spec
	 * after `initialize`). Before negotiation — the `initialize` request itself —
	 * no protocol-version header is sent from either source.
	 */
	#fetch(init: MCPFetchInit, generated: Record<string, string>): Promise<Response> {
		const configured = withoutHeader(this.config.headers, "MCP-Protocol-Version");
		const withVersion =
			this.#protocolVersion === null ? generated : { "MCP-Protocol-Version": this.#protocolVersion, ...generated };
		const request = mcpFetch(
			this.config.url,
			init,
			{ generated: withVersion, configured },
			this.config.headerPolicy === "origin-locked",
		);
		this.#activeFetches.add(request);
		void request.then(
			() => this.#activeFetches.delete(request),
			() => this.#activeFetches.delete(request),
		);
		return request;
	}

	/** Combine caller cancellation with transport shutdown for every HTTP operation. */
	#operationSignal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.#lifecycleController.signal]) : this.#lifecycleController.signal;
	}

	/**
	 * Keep a rejection observer on public requests even if a timeout wrapper
	 * abandons the returned promise. The original promise is returned unchanged,
	 * so callers still observe its normal result or error.
	 */
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
				url: this.config.url,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this.#backgroundDrains.add(handled);
		void handled.then(
			() => this.#backgroundDrains.delete(handled),
			() => this.#backgroundDrains.delete(handled),
		);
	}

	/** Record the protocol version negotiated during `initialize`. */
	setProtocolVersion(version: string): void {
		this.#protocolVersion = version;
	}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.config.url;
	}

	/**
	 * Mark transport as connected.
	 * HTTP doesn't need persistent connection, but we track state.
	 */
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
	 * Start SSE listener for server-initiated messages.
	 * Resolves once the SSE connection is established (or fails/unsupported).
	 * Message reading continues in the background.
	 */
	async startSSEListener(): Promise<void> {
		if (!this.#connected) return;
		if (this.#sseConnection) return;

		this.#sseConnection = new AbortController();
		const generated: Record<string, string> = {
			Accept: "text/event-stream",
		};

		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}

		let response: Response | null;
		let timedOut = false;
		let startupFinished = false;
		const connection = this.#sseConnection;
		const startupTimeoutMs = resolveSSEConnectTimeoutMs(this.config.timeout);
		const fetchPromise = this.#fetch({ method: "GET", signal: connection.signal }, generated);
		const timeoutPromise =
			startupTimeoutMs > 0
				? new Promise<null>(resolve => {
						setTimeout(() => {
							if (!startupFinished) {
								timedOut = true;
								connection.abort();
							}
							resolve(null);
						}, startupTimeoutMs);
					})
				: null;
		try {
			response = timeoutPromise === null ? await fetchPromise : await Promise.race([fetchPromise, timeoutPromise]);
		} catch (error) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			if (error instanceof Error && error.name !== "AbortError" && !timedOut) {
				this.onError?.(error);
			}
			return;
		} finally {
			startupFinished = true;
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

		// Connection established — read messages in background.
		// If the stream ends unexpectedly (server restart, network drop),
		// fire onClose so the manager can trigger reconnection.
		const signal = connection.signal;
		this.#trackBackgroundDrain(
			this.#runSSEListener(response.body, signal).finally(() => {
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
				logger.debug("HTTP SSE stream error", { url: this.config.url, error: error.message });
				this.onError?.(error);
			}
		}
	}

	/**
	 * Read the long-lived GET SSE stream, resuming with `Last-Event-ID` when
	 * the server closes the physical connection mid-stream (2025-11-25 permits
	 * polling-style servers). Returns only when the logical stream ends — the
	 * caller fires `onClose` and the manager's reconnect path takes over. A
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
					this.#dispatchSSEMessage(JSON.parse(event.data) as JsonRpcMessage | JsonRpcMessage[]);
				}
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") return;
				logger.debug("HTTP SSE stream error", {
					url: this.config.url,
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
				const response = await this.#fetchSSEResume(resume, signal);
				body = response.body as ReadableStream<Uint8Array>;
			} catch (error) {
				if (!(error instanceof Error && error.name === "AbortError")) {
					logger.debug("HTTP SSE listener resume failed", {
						url: this.config.url,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
		}
	}

	/**
	 * Resume a logical SSE stream via GET + `Last-Event-ID`, honoring the
	 * server-provided retry interval and refreshing auth once on 401/403.
	 * Failures throw {@link SSEResumeError} so `request()` never replays the
	 * originating POST in response.
	 */
	async #fetchSSEResume(resume: SSEResumeState, signal: AbortSignal): Promise<Response> {
		if (resume.lastEventId === null) {
			throw new SSEResumeError("SSE stream ended without a resumable event ID");
		}
		await waitForSSERetry(resume.retryMs, signal);
		const generated: Record<string, string> = {
			Accept: "text/event-stream",
			"Last-Event-ID": resume.lastEventId,
		};
		if (this.#sessionId) generated["Mcp-Session-Id"] = this.#sessionId;
		let response = await this.#fetch({ method: "GET", signal }, generated);
		if (this.onAuthError && (response.status === 401 || response.status === 403)) {
			await response.body?.cancel();
			const newHeaders = await this.onAuthError();
			if (!newHeaders) {
				throw new SSEResumeError(`HTTP ${response.status} resuming MCP SSE stream: auth refresh failed`);
			}
			// Persist refreshed headers so subsequent requests use them directly
			this.config = { ...this.config, headers: newHeaders };
			response = await this.#fetch({ method: "GET", signal }, generated);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new SSEResumeError(`HTTP ${response.status} resuming MCP SSE stream: ${text}`);
		}
		const contentType = response.headers.get("Content-Type") ?? "";
		if (!contentType.includes("text/event-stream") || !response.body) {
			await response.body?.cancel();
			throw new SSEResumeError(`MCP SSE resume returned unsupported Content-Type: ${contentType || "(missing)"}`);
		}
		return response;
	}

	/** Route an SSE message (or batch) to the appropriate handler. */
	#dispatchSSEMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#dispatchSSEMessage(m);
			return;
		}
		// Server-to-client request: has both method and id
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}
		// Notification: has method but no id
		if ("method" in message && !("id" in message)) {
			this.onNotification?.(message.method, message.params);
		}
	}

	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
		return this.#trackRequest(this.#requestWithAuthRetry<T>(method, params, options));
	}

	async #requestWithAuthRetry<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		try {
			return await this.#executeRequest<T>(method, params, options);
		} catch (error) {
			// Retry once on auth failure if onAuthError is wired. Never replay
			// after an SSE resume failure: the server already accepted the
			// original POST and may have executed it — replaying could run a
			// state-changing tool twice.
			const status = error instanceof Error ? AIError.status(error) : undefined;
			if (!(error instanceof SSEResumeError) && this.onAuthError && (status === 401 || status === 403)) {
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					// Persist refreshed headers so subsequent requests use them directly
					this.config = { ...this.config, headers: newHeaders };
					return this.#executeRequest<T>(method, params, options);
				}
			}
			throw error;
		}
	}

	async #executeRequest<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		if (!this.#connected) {
			throw new MCPTransportError({
				transport: "http",
				stage: "connect",
				failure: "closed",
				message: "Transport not connected",
				retryable: true,
			});
		}

		const id = this.#requestIds.next(this.config.requestIdFormat);
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};

		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal(options?.signal));
		let stage: MCPFailureStage = "send";
		let traceId: string | undefined;

		try {
			const response = await this.#fetch(
				{ method: "POST", body: JSON.stringify(body), signal: operation.signal },
				generated,
			);
			stage = "receive";
			traceId = mcpTraceIdFromHeaders(response.headers);

			// Check for session ID in response
			const newSessionId = response.headers.get("Mcp-Session-Id");
			if (newSessionId) {
				this.#sessionId = newSessionId;
			}

			if (!response.ok) {
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
				throw new MCPTransportError({
					transport: "http",
					stage,
					failure: "http_status",
					message: `HTTP ${response.status}: ${text}${suffix}`,
					retryable: response.status === 404 || response.status === 502 || response.status === 503,
					code: response.status,
					traceId,
				});
			}

			const contentType = response.headers.get("Content-Type") ?? "";

			// Handle SSE response
			if (contentType.includes("text/event-stream")) {
				return this.#parseSSEResponse<T>(response, id, options);
			}

			stage = "decode";
			// Handle JSON response
			const result: unknown = await response.json();
			if (!isRecord(result) || result.jsonrpc !== "2.0" || (!("result" in result) && !("error" in result))) {
				throw new SyntaxError("Malformed JSON-RPC response");
			}
			if (result.error !== undefined) {
				if (
					!isRecord(result.error) ||
					typeof result.error.code !== "number" ||
					typeof result.error.message !== "string"
				) {
					throw new SyntaxError("Malformed JSON-RPC error response");
				}
				throw createMCPJsonRpcError(
					"http",
					{ code: result.error.code, message: result.error.message, data: result.error.data },
					traceId,
				);
			}

			return result.result as T;
		} catch (error) {
			if (operation.isTimeoutAbort(error) || operation.timedOut()) {
				throw new MCPTransportError({
					transport: "http",
					stage,
					failure: "timeout",
					message: `Request timeout after ${timeout}ms`,
					retryable: false,
					traceId,
					cause: error,
				});
			}
			if (error instanceof Error && error.name === "AbortError") throw error;
			throw normalizeMCPTransportError(error, { transport: "http", stage, traceId });
		} finally {
			operation.clear();
		}
	}

	#parseSSEResponse<T>(response: Response, expectedId: string | number, options?: MCPRequestOptions): Promise<T> {
		const traceId = mcpTraceIdFromHeaders(response.headers);
		if (!response.body) {
			throw new MCPTransportError({
				transport: "http",
				stage: "decode",
				failure: "malformed_response",
				message: "SSE response did not include a body",
				retryable: false,
				traceId,
			});
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal(options?.signal));
		const signal = operation.signal ?? getNeverAbortSignal();

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		// The transport owns this promise until the physical stream drain exits.
		// Keep a rejection observer attached even when a caller-side timeout
		// abandons the request before the drain notices its abort.
		void promise.catch(() => {});
		const resume: SSEResumeState = { lastEventId: null, retryMs: DEFAULT_SSE_RETRY_MS };
		let captured = false;

		// Drain each physical SSE connection without leaving its iterator early.
		// A server may close a connection without terminating the logical stream;
		// when it supplied an event ID, resume that stream via GET + Last-Event-ID.
		const drain = async (): Promise<void> => {
			let current = response;
			try {
				for (;;) {
					if (!current.body) throw new Error("SSE response did not include a body");
					try {
						for await (const event of readSseEvents(current.body, signal)) {
							if (event.id !== undefined) resume.lastEventId = event.id || null;
							if (event.retry !== undefined) resume.retryMs = event.retry;
							if (event.data === "") continue;
							const raw = JSON.parse(event.data) as JsonRpcMessage | JsonRpcMessage[];
							const messages = Array.isArray(raw) ? raw : [raw];
							for (const message of messages) {
								if (
									!captured &&
									"id" in message &&
									message.id === expectedId &&
									("result" in message || "error" in message)
								) {
									captured = true;
									operation.clear();
									if (message.error) {
										reject(createMCPJsonRpcError("http", message.error, traceId));
									} else {
										resolve(message.result as T);
									}
									continue;
								}
								if (!this.#connected) continue;
								this.#dispatchSSEMessage(message);
							}
						}
					} catch (error) {
						// An abrupt drop (socket reset, body-read failure) is as
						// resumable as a server-initiated close once an event ID
						// exists; the request timeout still bounds the total wait.
						if (captured) return;
						if (signal.aborted || resume.lastEventId === null) throw error;
						logger.debug("MCP SSE response stream dropped; resuming", {
							url: this.config.url,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					if (captured) return;
					if (signal.aborted) {
						throw signal.reason ?? new DOMException("MCP SSE response aborted", "AbortError");
					}
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
				// The server accepted this POST (it returned a 2xx SSE stream) before
				// the drain or a resume GET failed, so the originating request must
				// never be replayed — it may already have executed a state-changing
				// tool. Preserve SSEResumeError so #requestWithAuthRetry's no-replay
				// guard still fires instead of refreshing auth and re-POSTing, and
				// force every other post-acceptance failure non-retryable so the
				// reconnect path in isRetriableConnectionError cannot replay it.
				if (error instanceof SSEResumeError || (error instanceof Error && error.name === "AbortError")) {
					reject(error);
				} else if (operation.isTimeoutAbort(error)) {
					reject(
						new MCPTransportError({
							transport: "http",
							stage: "receive",
							failure: "timeout",
							message: `SSE response timeout after ${timeout}ms`,
							retryable: false,
							traceId,
							cause: error,
						}),
					);
				} else {
					const normalized = normalizeMCPTransportError(error, {
						transport: "http",
						stage: error instanceof SyntaxError ? "decode" : "receive",
						traceId,
					});
					reject(
						normalized.retryable
							? new MCPTransportError({
									transport: normalized.transport,
									stage: normalized.stage,
									failure: normalized.failure,
									message: normalized.message,
									retryable: false,
									code: normalized.code,
									data: normalized.data,
									traceId: normalized.traceId,
									cause: normalized,
								})
							: normalized,
					);
				}
			} finally {
				operation.clear();
				await current.body?.cancel().catch(() => {});
			}
		};

		this.#trackBackgroundDrain(drain());
		return promise;
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		if (!this.onRequest) {
			await this.#sendServerResponse(request.id, undefined, { code: -32601, message: "Method not found" });
			return;
		}
		try {
			const result = await this.onRequest(request.method, request.params);
			await this.#sendServerResponse(request.id, result);
		} catch (error) {
			await this.#sendServerResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	/** POST a JSON-RPC response back to the server (for server-to-client requests received via SSE). */
	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected) return;
		const body = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}
		const payload = JSON.stringify(body);
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal());
		try {
			const resp = await this.#fetch({ method: "POST", body: payload, signal: operation.signal }, generated);
			// Retry once on auth failure if onAuthError is wired
			if (this.onAuthError && (resp.status === 401 || resp.status === 403)) {
				await resp.body?.cancel();
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config.headers ??= {};
					Object.assign(this.config.headers, newHeaders);
					operation.clear();
					const retryOperation = createMCPTimeout(timeout, this.#operationSignal());
					try {
						const retry = await this.#fetch(
							{ method: "POST", body: payload, signal: retryOperation.signal },
							generated,
						);
						await retry.body?.cancel();
					} finally {
						retryOperation.clear();
					}
					return;
				}
			}
			await resp.body?.cancel();
		} catch {
			// Best-effort response delivery — server may have disconnected
		} finally {
			operation.clear();
		}
	}

	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.#trackRequest(this.#sendNotification(method, params));
	}

	async #sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) {
			throw new MCPTransportError({
				transport: "http",
				stage: "connect",
				failure: "closed",
				message: "Transport not connected",
				retryable: true,
			});
		}

		const body = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};

		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal());
		let stage: MCPFailureStage = "send";
		let traceId: string | undefined;

		try {
			const response = await this.#fetch(
				{ method: "POST", body: JSON.stringify(body), signal: operation.signal },
				generated,
			);
			stage = "receive";
			traceId = mcpTraceIdFromHeaders(response.headers);

			// 202 Accepted is success for notifications
			if (!response.ok && response.status !== 202) {
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

			// The server may piggyback server-to-client requests or notifications
			// on the notification response (MCP Streamable HTTP spec). Read them.
			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				// Use the SSE connection's signal if available; otherwise keep the existing finite read timeout.
				if (this.#sseConnection) {
					this.#trackBackgroundDrain(
						this.#readSSEStream(response.body, this.#operationSignal(this.#sseConnection.signal)),
					);
				} else {
					const readOperation = createMCPTimeout(timeout, this.#operationSignal());
					const signal = readOperation.signal ?? getNeverAbortSignal();
					this.#trackBackgroundDrain(
						this.#readSSEStream(response.body, signal).finally(() => readOperation.clear()),
					);
				}
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			if (operation.isTimeoutAbort(error)) {
				throw new MCPTransportError({
					transport: "http",
					stage,
					failure: "timeout",
					message: `Notify timeout after ${timeout}ms`,
					retryable: false,
					traceId,
					cause: error,
				});
			}
			if (error instanceof Error && error.name === "AbortError") throw error;
			throw normalizeMCPTransportError(error, { transport: "http", stage, traceId });
		} finally {
			operation.clear();
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		if (!this.#connected) return Promise.resolve();
		this.#closePromise = this.#closeTransport();
		// `close()` is commonly fire-and-forget during process teardown.
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
		// readers have actually observed it before session/process teardown can
		// close their sockets underneath still-running promise continuations.
		while (this.#activeFetches.size > 0 || this.#activeRequests.size > 0 || this.#backgroundDrains.size > 0) {
			await Promise.allSettled([...this.#activeFetches, ...this.#activeRequests, ...this.#backgroundDrains]);
		}

		if (this.#sessionId) {
			const timeout = resolveMCPTimeoutMs(this.config.timeout);
			const operation = createMCPTimeout(timeout);
			try {
				const response = await this.#fetch(
					{ method: "DELETE", signal: operation.signal },
					{ "Mcp-Session-Id": this.#sessionId },
				);
				await response.body?.cancel();
			} catch {
				// Session termination is best-effort.
			} finally {
				operation.clear();
			}
			this.#sessionId = null;
		}

		const onClose = this.onClose;
		this.onClose = undefined;
		try {
			onClose?.();
		} catch (error) {
			logger.debug("MCP HTTP onClose callback failed during transport teardown", {
				url: this.config.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Create and connect an HTTP transport.
 */
export async function createHttpTransport(config: MCPHttpServerConfig | MCPSseServerConfig): Promise<HttpTransport> {
	const transport = new HttpTransport(config);
	await transport.connect();
	return transport;
}
