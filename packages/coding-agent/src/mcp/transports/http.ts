/**
 * MCP HTTP transport (Streamable HTTP).
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * The negotiated protocol revision is carried in the `MCP-Protocol-Version`
 * header on every request (see `MCP_PROTOCOL_VERSION`).
 */
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isRecord, logger, postmortem, readSseEvents, readSseJson, untilAborted } from "@oh-my-pi/pi-utils";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	MCPDiscoverResult,
	MCPHttpServerConfig,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPStreamableHttpServerConfig,
	MCPTransport,
} from "../../mcp/types";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_CLIENT_INFO_META_KEY,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_NAME_HEADER_SOURCE,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_SERVER_INFO_META_KEY,
	toJsonRpcError,
} from "../../mcp/types";
import {
	createMCPJsonRpcError,
	type MCPFailureStage,
	MCPTransportError,
	mcpTraceIdFromHeaders,
	normalizeMCPTransportError,
} from "../errors";
import { RequestIdAllocator } from "../request-id";
import {
	createMCPTimeout,
	getNeverAbortSignal,
	isMCPTimeoutEnabled,
	type MCPTimeoutOperation,
	resolveMCPTimeoutMs,
} from "../timeout";
import { type MCPFetchInit, mcpFetch, withoutHeader } from "./header-policy";

const HTTP_SSE_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_SSE_RETRY_MS = 3_000;

/** 2026-07-28 era selected on a `streamable-http` endpoint. */
type MCPHttpEra = "modern" | "legacy";

const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";
/**
 * JSON-RPC error a modern-only endpoint answers a 2025-era request with
 * (`-32022`, `UnsupportedProtocolVersion`); its reply is the expected
 * downgrade signal when probing a pre-2026 server.
 */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** Probe refusals that mean "this endpoint speaks the 2025 handshake". */
const legacyDowngradeCodes = new Set([UNSUPPORTED_PROTOCOL_VERSION, -32601]);

/**
 * Encode an `Mcp-Method` / `Mcp-Name` value per the 2026-07-28 standard-header
 * rules: values outside RFC 9110 field-value bytes (or already wearing the
 * sentinel) travel Base64-wrapped so the header stays ASCII-safe.
 */
function encodeMcpHeaderValue(value: string): string {
	let needsEncoding = value.length === 0 || value !== value.trim();
	if (!needsEncoding) {
		if (value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX)) {
			needsEncoding = true;
		} else {
			for (let i = 0; i < value.length; i++) {
				const code = value.codePointAt(i)!;
				if (code === 9 || (code >= 32 && code <= 126)) continue;
				needsEncoding = true;
				break;
			}
		}
	}
	if (!needsEncoding) return value;
	return `${BASE64_SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${BASE64_SENTINEL_SUFFIX}`;
}

/** The `params` field an `Mcp-Name` header mirrors for `method`, if any. */
function mcpNameHeaderSource(method: string, params: Record<string, unknown> | undefined): string | undefined {
	const field = Object.hasOwn(MCP_NAME_HEADER_SOURCE, method) ? MCP_NAME_HEADER_SOURCE[method] : undefined;
	if (field === undefined) return undefined;
	const raw = params?.[field];
	return typeof raw === "string" ? raw : undefined;
}

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
	/**
	 * Era of a `streamable-http` endpoint. `null` until {@link negotiate} runs;
	 * plain `http`/`sse` transports always use the legacy handshake.
	 */
	#era: MCPHttpEra | null = null;
	/** Client identity + capabilities stamped into every modern `_meta` envelope. */
	#clientInfo: { name: string; version: string } | null = null;
	#clientCapabilities: Record<string, unknown> | null = null;
	/** Result of the `server/discover` probe once the modern era is selected. */
	#discoverResult: MCPDiscoverResult | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(private config: MCPHttpServerConfig | MCPStreamableHttpServerConfig | MCPSseServerConfig) {}

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

	/** `true` once {@link negotiate} selected the 2026-07-28 stateless era. */
	get isModern(): boolean {
		return this.#era === "modern";
	}

	/**
	 * Decide the wire era for a `streamable-http` endpoint, before any
	 * handshake. The client identity is captured for the per-request `_meta`
	 * envelope and a `server/discover` probe runs on the modern slot (no
	 * `MCP-Protocol-Version` header — a probe is the first sender of the
	 * envelope claim, and the version derives from the body). Servers that
	 * answer with an overlapping modern revision select the modern era;
	 * anything else (probe HTTP error, unsupported-version refusal, malformed
	 * result) falls back to the legacy `initialize` handshake so pre-2026
	 * endpoints keep working.
	 */
	async negotiate(
		clientInfo: { name: string; version: string },
		capabilities: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<void> {
		if (this.config.type !== "streamable-http") return;
		this.#clientInfo = clientInfo;
		this.#clientCapabilities = capabilities;
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal(options?.signal));
		try {
			const id = this.#requestIds.next(this.config.requestIdFormat);
			const response = await this.#fetch(
				{
					method: "POST",
					body: JSON.stringify(this.#modernBody("server/discover", {}, id)),
					signal: operation.signal,
				},
				this.#modernHeaders("server/discover"),
			);
			const payload = await this.#readJsonRpcPayload(response, "server/discover");
			if (payload.error !== undefined) {
				logger.debug("MCP server/discover probe returned a JSON-RPC error; using the legacy handshake", {
					url: this.config.url,
					code: payload.error.code,
					...(!legacyDowngradeCodes.has(payload.error.code) && { message: payload.error.message }),
				});
				this.#era = "legacy";
				return;
			}
			const result = payload.result;
			if (!isRecord(result)) throw new SyntaxError("Malformed server/discover result");
			const supported = Array.isArray(result.supportedVersions)
				? result.supportedVersions.filter((version): version is string => typeof version === "string")
				: [];
			if (!supported.includes(MCP_MODERN_PROTOCOL_VERSION)) {
				this.#era = "legacy";
				return;
			}
			const serverInfo = isRecord(result._meta) ? result._meta[MCP_SERVER_INFO_META_KEY] : undefined;
			this.#discoverResult = {
				supportedVersions: supported,
				capabilities: isRecord(result.capabilities) ? result.capabilities : {},
				...(typeof result.instructions === "string" && { instructions: result.instructions }),
				...(isRecord(serverInfo) &&
					typeof serverInfo.name === "string" &&
					typeof serverInfo.version === "string" && {
						serverInfo: { name: serverInfo.name, version: serverInfo.version },
					}),
			};
			this.#protocolVersion = MCP_MODERN_PROTOCOL_VERSION;
			this.#era = "modern";
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			if (error instanceof Error && error.name === "AbortError" && this.#lifecycleController.signal.aborted) {
				throw error;
			}
			logger.debug("MCP modern protocol probe failed; falling back to the legacy handshake", {
				url: this.config.url,
				error: error instanceof Error ? error.message : String(error),
			});
			this.#era = "legacy";
		} finally {
			operation.clear();
		}
	}

	/** Result of the `server/discover` probe; non-null only in the modern era. */
	get discoverResult(): MCPDiscoverResult | null {
		return this.#discoverResult;
	}

	/**
	 * Request params for a modern exchange: the caller's params with the
	 * per-request `_meta` envelope merged in. Envelope keys are written last so
	 * protocol fields always win over a colliding caller key.
	 */
	#modernParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
		const meta: Record<string, unknown> = {
			[MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
			[MCP_CLIENT_CAPABILITIES_META_KEY]: this.#clientCapabilities ?? {},
		};
		if (this.#clientInfo) meta[MCP_CLIENT_INFO_META_KEY] = this.#clientInfo;
		return { ...params, _meta: { ...(isRecord(params?._meta) ? params._meta : {}), ...meta } };
	}

	#modernBody(
		method: string,
		params: Record<string, unknown> | undefined,
		id?: string | number,
	): Record<string, unknown> {
		return {
			jsonrpc: "2.0" as const,
			...(id !== undefined && { id }),
			method,
			params: this.#modernParams(params),
		};
	}

	/**
	 * Standard headers for a modern request: the `MCP-Protocol-Version` slot
	 * follows from the envelope claim, `Mcp-Method` mirrors the body method,
	 * and `Mcp-Name` mirrors the named `params` field for name-bearing methods.
	 */
	#modernHeaders(method: string, params?: Record<string, unknown>): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
			"Mcp-Method": encodeMcpHeaderValue(method),
		};
		const name = mcpNameHeaderSource(method, params);
		if (name !== undefined) headers["Mcp-Name"] = encodeMcpHeaderValue(name);
		return headers;
	}

	/**
	 * Parse one JSON-RPC payload on the modern slot, transparently accepting an
	 * SSE-framed body. Modern endpoints answer with `application/json`, but the
	 * revision permits a stream; the match is by request id either way.
	 *
	 * A 4xx body that itself parses as this exchange's JSON-RPC error is
	 * returned as `{ error }` — the era probe needs the refusal code, and call
	 * sites turn errors into the same typed failure either way.
	 */
	async #readJsonRpcPayload(
		response: Response,
		label: string,
		expectedId?: string | number,
	): Promise<{ result?: unknown; error?: JsonRpcError }> {
		const contentType = response.headers.get("Content-Type") ?? "";
		if (!response.ok) {
			if (contentType.includes("application/json")) {
				const payload: unknown = await response.json().catch(() => undefined);
				if (
					isRecord(payload) &&
					isRecord(payload.error) &&
					typeof payload.error.code === "number" &&
					typeof payload.error.message === "string"
				) {
					return { error: payload.error as unknown as JsonRpcError };
				}
			}
			const text = contentType.includes("application/json") ? "" : await response.text().catch(() => "");
			throw new MCPTransportError({
				transport: "http",
				stage: "receive",
				failure: "http_status",
				message: `HTTP ${response.status}${label === "server/discover" ? " probing server/discover" : ""}: ${text}`,
				retryable: response.status === 404 || response.status === 502 || response.status === 503,
				code: response.status,
				traceId: mcpTraceIdFromHeaders(response.headers),
			});
		}
		if (contentType.includes("text/event-stream") && response.body) {
			for await (const event of readSseJson<JsonRpcMessage>(response.body, this.#operationSignal())) {
				if (Array.isArray(event)) continue;
				if ("method" in event && !("id" in event)) {
					this.onNotification?.(event.method, event.params);
					continue;
				}
				if ("result" in event || "error" in event) {
					if (expectedId !== undefined && event.id !== expectedId) continue;
					return event;
				}
			}
			throw new MCPTransportError({
				transport: "http",
				stage: "receive",
				failure: "eof",
				message: `No response received for ${label}`,
				retryable: false,
			});
		}
		const payload: unknown = await response.json();
		if (!isRecord(payload) || payload.jsonrpc !== "2.0") throw new SyntaxError("Malformed JSON-RPC response");
		return payload as { result?: unknown; error?: JsonRpcError };
	}

	async #modernRequest<T>(method: string, params: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
		const id = this.#requestIds.next(this.config.requestIdFormat);
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal(options?.signal));
		let stage: MCPFailureStage = "send";
		let traceId: string | undefined;
		try {
			const response = await this.#fetch(
				{ method: "POST", body: JSON.stringify(this.#modernBody(method, params, id)), signal: operation.signal },
				this.#modernHeaders(method, params),
			);
			stage = "receive";
			traceId = mcpTraceIdFromHeaders(response.headers);
			const payload = await this.#readJsonRpcPayload(response, method, id);
			if (payload.error !== undefined) {
				throw createMCPJsonRpcError("http", payload.error, traceId);
			}
			return payload.result as T;
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
		const refreshAuth = this.onAuthError;
		if (refreshAuth && (response.status === 401 || response.status === 403)) {
			await response.body?.cancel();
			const newHeaders = await untilAborted(signal, () => refreshAuth.call(this));
			if (!newHeaders) {
				throw new SSEResumeError(`HTTP ${response.status} resuming MCP SSE stream: auth refresh failed`);
			}
			// Persist refreshed headers so subsequent requests use them directly
			this.config = { ...this.config, headers: newHeaders };
			response = await this.#fetch({ method: "GET", signal }, generated);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => {
				signal.throwIfAborted();
				return "";
			});
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
		if (this.#era === "modern") {
			return this.#trackRequest(this.#modernRequestWithDiscovery<T>(method, params, options));
		}
		return this.#trackRequest(this.#requestWithAuthRetry<T>(method, params, options));
	}

	/**
	 * Modern-slot request wrapper: the era's discovery payload answers the
	 * `initialize` method the client always sends, and auth refreshes keep the
	 * one-retry contract of the legacy slot.
	 */
	async #modernRequestWithDiscovery<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		if (method === "initialize") {
			const discover = this.#discoverResult;
			if (!discover) {
				throw new MCPTransportError({
					transport: "http",
					stage: "protocol",
					failure: "unknown",
					message: "Modern transport chosen without a server/discover result",
					retryable: false,
				});
			}
			return {
				protocolVersion: MCP_MODERN_PROTOCOL_VERSION,
				capabilities: discover.capabilities,
				serverInfo: discover.serverInfo ?? { name: "mcp", version: "0" },
				...(discover.instructions !== undefined && { instructions: discover.instructions }),
			} as T;
		}
		try {
			return await this.#modernRequest<T>(method, params ?? {}, options);
		} catch (error) {
			const status = error instanceof Error ? AIError.status(error) : undefined;
			if (this.onAuthError && (status === 401 || status === 403)) {
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config = { ...this.config, headers: newHeaders };
					return await this.#modernRequest<T>(method, params ?? {}, options);
				}
			}
			throw error;
		}
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

		// Caller cancellation owns this request only until its response arrives;
		// transport cancellation must continue owning any subsequent SSE messages.
		let callerSignal: AbortSignal | undefined;
		let releaseCaller: (() => void) | undefined;
		if (options?.signal) {
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
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal(callerSignal));
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

			// Handle SSE response. Await it here so the fetch and stream parser
			// share one logical deadline; returning the promise would let finally
			// clear the fetch timer before the response body is read.
			if (contentType.includes("text/event-stream")) {
				return await this.#parseSSEResponse<T>(response, id, operation, timeout, releaseCaller);
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
			if (error instanceof SSEResumeError) throw error;
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
			releaseCaller?.();
			operation.clear();
		}
	}

	#parseSSEResponse<T>(
		response: Response,
		expectedId: string | number,
		operation: MCPTimeoutOperation,
		timeout: number,
		releaseCaller?: () => void,
	): Promise<T> {
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
									releaseCaller?.();
									releaseCaller = undefined;
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
				if (error instanceof SSEResumeError) {
					reject(error);
				} else if (operation.isTimeoutAbort(error) || operation.timedOut()) {
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
				} else if (error instanceof Error && error.name === "AbortError") {
					reject(error);
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
		if (this.#era === "modern") {
			return this.#trackRequest(this.#modernNotify(method, params));
		}
		return this.#trackRequest(this.#sendNotification(method, params));
	}

	/**
	 * Send a modern notification. Notifications carry no `id` — the endpoint
	 * distinguishes them from requests (a posted `id` addresses the method for
	 * dispatch and 404s unknown ones). `notifications/initialized` is a
	 * courtesy on this stateless era, so a 202/bodyless answer is the norm;
	 * carrier notifications on an SSE body are dispatched instead of dropped.
	 */
	async #modernNotify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) {
			throw new MCPTransportError({
				transport: "http",
				stage: "connect",
				failure: "closed",
				message: "Transport not connected",
				retryable: true,
			});
		}
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal());
		let stage: MCPFailureStage = "send";
		let traceId: string | undefined;
		try {
			const response = await this.#fetch(
				{ method: "POST", body: JSON.stringify(this.#modernBody(method, params)), signal: operation.signal },
				this.#modernHeaders(method, params),
			);
			stage = "receive";
			traceId = mcpTraceIdFromHeaders(response.headers);
			if (!response.ok) {
				const text = await response.text().catch(() => "");
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
			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				const signal = this.#sseConnection
					? this.#operationSignal(this.#sseConnection.signal)
					: this.#lifecycleController.signal;
				this.#trackBackgroundDrain(this.#readSSEStream(response.body, signal));
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			if (operation.isTimeoutAbort(error) || operation.timedOut()) {
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
				// A successful notification POST has been accepted. Its SSE body is
				// now a background server-message stream, not part of the request
				// deadline; keep draining until its connection or the transport closes.
				const signal = this.#sseConnection
					? this.#operationSignal(this.#sseConnection.signal)
					: this.#lifecycleController.signal;
				this.#trackBackgroundDrain(this.#readSSEStream(response.body, signal));
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			if (operation.isTimeoutAbort(error) || operation.timedOut()) {
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
export async function createHttpTransport(
	config: MCPHttpServerConfig | MCPStreamableHttpServerConfig | MCPSseServerConfig,
): Promise<HttpTransport> {
	const transport = new HttpTransport(config);
	await transport.connect();
	return transport;
}
