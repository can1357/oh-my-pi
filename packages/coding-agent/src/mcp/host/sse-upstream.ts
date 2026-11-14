/**
 * HTTP+SSE upstream of the MCP host (protocol revision 2024-11-05): one
 * long-lived GET stream carries every server message, and the client POSTs to
 * the endpoint that stream announces. Handshake-era only; nothing modern
 * speaks it.
 */
import { isRecord, logger, postmortem, readSseEvents } from "@oh-my-pi/pi-utils";
import {
	createMCPJsonRpcError,
	MCPTransportError,
	nonRetryableMCPTransportError,
	normalizeMCPTransportError,
	parseMCPRetryAfterMs,
} from "../errors";
import { routeProgressNotification, withProgressToken } from "../progress";
import { RequestIdAllocator } from "../request-id";
import type { MCPRequestOptions, MCPTransport } from "../types";
import { toJsonRpcError } from "../types";
import type { McpRemoteSpec } from "./contract";
import { mcpFetch } from "./header-policy";
import { jsonRpcErrorOf } from "./stdio-upstream";

interface PendingRequest {
	resolve(value: unknown): void;
	reject(reason: Error): void;
	onProgress?: MCPRequestOptions["onProgress"];
}

function streamClosed(): MCPTransportError {
	return new MCPTransportError({
		transport: "http",
		stage: "receive",
		failure: "closed",
		message: "Transport closed: legacy SSE stream closed",
		retryable: false,
	});
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
 * One 2024-11-05 HTTP+SSE server. Requests have no deadline here; a caller
 * bounds one with its `signal`. Only the wait for the endpoint event in
 * {@link connect} is bounded, by the spec's `timeoutMs`.
 */
export class SseUpstream implements MCPTransport {
	readonly #spec: McpRemoteSpec;
	readonly #pending = new Map<string | number, PendingRequest>();
	readonly #requestIds = new RequestIdAllocator();
	#connected = false;
	#endpointUrl: string | null = null;
	#sseConnection: AbortController | null = null;
	#lifecycleController = new AbortController();

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(spec: McpRemoteSpec) {
		this.#spec = spec;
	}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.#spec.url;
	}

	/** Combine caller cancellation with upstream shutdown, so `close()` ends an in-flight POST as well as the GET stream. */
	#operationSignal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.#lifecycleController.signal]) : this.#lifecycleController.signal;
	}

	/**
	 * Open the GET stream and wait for its `endpoint` event. `signal` and the
	 * spec's bound cancel only that wait; an established stream outlives both.
	 *
	 * @throws MCPTransportError when the stream is refused, ends or stays silent past the bound, or names an endpoint on another origin; the abort reason when `signal` aborts first.
	 */
	async connect(signal?: AbortSignal): Promise<void> {
		if (this.#connected || this.#sseConnection) return;
		signal?.throwIfAborted();
		if (this.#lifecycleController.signal.aborted) this.#lifecycleController = new AbortController();

		const connection = new AbortController();
		const onAbort = (): void => connection.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeoutMs = this.#spec.timeoutMs;
		let timedOut = false;
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						connection.abort();
					}, timeoutMs)
				: undefined;
		const streamSignal = this.#operationSignal(connection.signal);
		const endpointReady = Promise.withResolvers<void>();
		// The reader may reject this after `connect` already failed for another reason.
		void endpointReady.promise.catch(() => {});
		this.#sseConnection = connection;

		try {
			const response = await mcpFetch(
				this.#spec.url,
				{ method: "GET", signal: streamSignal },
				{ generated: { Accept: "text/event-stream" }, configured: this.#spec.headers },
				this.#spec.headerPolicy === "origin-locked",
			);
			if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
			if (!response.body) throw new Error("Legacy SSE response did not include a body");

			void this.#readSSEStream(response.body, streamSignal, endpointReady).finally(() => {
				const wasConnected = this.#connected;
				this.#connected = false;
				if (this.#sseConnection === connection) this.#sseConnection = null;
				if (!wasConnected) return;
				const onClose = this.onClose;
				this.onClose = undefined;
				onClose?.();
			});
			await endpointReady.promise;
		} catch (error) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			connection.abort();
			if (timedOut) {
				throw new MCPTransportError({
					transport: "http",
					stage: "connect",
					failure: "timeout",
					message: `Legacy SSE endpoint timeout after ${timeoutMs}ms`,
					retryable: false,
					cause: error,
				});
			}
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			throw normalizeMCPTransportError(error, { transport: "http", stage: "connect" });
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async #readSSEStream(
		body: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		endpointReady: PromiseWithResolvers<void>,
	): Promise<void> {
		let endpointReceived = false;
		try {
			for await (const event of readSseEvents(body, signal)) {
				if (event.event === "endpoint") {
					if (!this.#endpointUrl) {
						const endpointUrl = new URL(event.data, this.#spec.url);
						const configuredUrl = new URL(this.#spec.url);
						if (endpointUrl.origin !== configuredUrl.origin) {
							throw new Error(
								`Legacy SSE endpoint origin mismatch: expected ${configuredUrl.origin}, received ${endpointUrl.origin}`,
							);
						}
						this.#endpointUrl = endpointUrl.href;
						this.#connected = true;
						endpointReceived = true;
						endpointReady.resolve();
					}
					continue;
				}
				if (event.data === "" || event.data === "[DONE]") continue;

				let payload: unknown;
				try {
					payload = JSON.parse(event.data);
				} catch {
					throw new SyntaxError(`Legacy SSE message event contained non-JSON data: ${event.data}`);
				}
				for (const message of Array.isArray(payload) ? payload : [payload]) this.#dispatchMessage(message);
			}
			if (!endpointReceived) {
				endpointReady.reject(
					signal.aborted
						? (signal.reason ?? new Error("Aborted"))
						: new Error("Legacy SSE endpoint event not received"),
				);
			}
		} catch (error) {
			if (!endpointReceived) {
				endpointReady.reject(error);
			} else if (!signal.aborted) {
				const failure = nonRetryableMCPTransportError(
					normalizeMCPTransportError(error, { transport: "http", stage: "receive" }),
				);
				logger.debug("Legacy SSE stream error", { url: this.#spec.url, error: failure.message });
				this.onError?.(failure);
				this.#rejectPending(failure);
			}
		} finally {
			if (endpointReceived) this.#rejectPending(streamClosed());
		}
	}

	#dispatchMessage(message: unknown): void {
		if (!isRecord(message)) return;
		const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
		if (typeof message.method === "string") {
			if (id !== undefined) {
				void this.#handleServerRequest(id, message.method, message.params);
				return;
			}
			routeProgressNotification(message.method, message.params, token => this.#pending.get(token)?.onProgress);
			this.onNotification?.(message.method, message.params);
			return;
		}
		if (id === undefined) return;
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		if (message.error === undefined) {
			pending.resolve(message.result);
			return;
		}
		const rpc = jsonRpcErrorOf(message.error);
		pending.reject(
			rpc
				? createMCPJsonRpcError("http", rpc)
				: new MCPTransportError({
						transport: "http",
						stage: "decode",
						failure: "malformed_response",
						message: "Malformed JSON-RPC error response",
						retryable: false,
					}),
		);
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#endpointUrl) throw notConnected();
		options?.signal?.throwIfAborted();

		const id = this.#requestIds.next(this.#spec.requestIdFormat);
		options?.onRequestId?.(id);
		const signal = this.#operationSignal(options?.signal);
		const deferred = Promise.withResolvers<unknown>();
		// A stream-close rejection may land while the POST below is still
		// awaited; observe it now so it is never flagged as unhandled.
		void deferred.promise.catch(() => {});
		this.#pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, onProgress: options?.onProgress });
		const onAbort = (): void => {
			if (this.#pending.delete(id)) {
				deferred.reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
			}
		};
		signal.addEventListener("abort", onAbort, { once: true });

		let posted = false;
		try {
			const response = await this.#post(
				{
					jsonrpc: "2.0",
					id,
					method,
					params: options?.onProgress ? withProgressToken(params, id) : (params ?? {}),
				},
				signal,
			);
			if (!response.ok) {
				const status = response.status;
				throw new MCPTransportError({
					transport: "http",
					stage: "receive",
					failure: "http_status",
					message: `HTTP ${status}: ${await response.text()}`,
					retryable: status === 404 || status === 429 || status === 502 || status === 503,
					code: status,
					retryAfterMs: parseMCPRetryAfterMs(response.headers.get("Retry-After")),
				});
			}
			posted = true;
			await response.body?.cancel();
			return (await deferred.promise) as T;
		} catch (error) {
			this.#pending.delete(id);
			if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			const normalized = normalizeMCPTransportError(error, {
				transport: "http",
				stage: posted ? "receive" : "send",
			});
			// A reset or EOF can follow the server reading the POST; only a
			// connection-establishment failure or a refusing status proves it was not processed.
			const lost = normalized.failure === "reset" || normalized.failure === "eof";
			throw posted || lost ? nonRetryableMCPTransportError(normalized) : normalized;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#endpointUrl) throw notConnected();
		const timeoutMs = this.#spec.timeoutMs;
		const signal =
			timeoutMs > 0
				? AbortSignal.any([this.#lifecycleController.signal, AbortSignal.timeout(timeoutMs)])
				: this.#lifecycleController.signal;
		try {
			const response = await this.#post({ jsonrpc: "2.0", method, params: params ?? {} }, signal);
			if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
			await response.body?.cancel();
		} catch (error) {
			if (this.#lifecycleController.signal.aborted) throw this.#lifecycleController.signal.reason;
			if (signal.aborted) {
				throw new MCPTransportError({
					transport: "http",
					stage: "send",
					failure: "timeout",
					message: `Notify timeout after ${timeoutMs}ms`,
					retryable: false,
					cause: error,
				});
			}
			throw normalizeMCPTransportError(error, { transport: "http", stage: "send" });
		}
	}

	#post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
		const endpointUrl = this.#endpointUrl;
		if (!endpointUrl) return Promise.reject(notConnected());
		return mcpFetch(
			endpointUrl,
			{ method: "POST", body: JSON.stringify(body), signal },
			{
				generated: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				configured: this.#spec.headers,
			},
			this.#spec.headerPolicy === "origin-locked",
		);
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
		try {
			const delivered = await this.#post(response, this.#lifecycleController.signal);
			await delivered.body?.cancel();
		} catch {
			// Best-effort: the server may have gone away.
		}
	}

	#rejectPending(error: Error): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) entry.reject(error);
	}

	/** Abort the stream and every in-flight POST; pending requests reject with the close reason. Idempotent. */
	async close(): Promise<void> {
		if (!this.#connected && !this.#sseConnection) return;
		const wasConnected = this.#connected;
		this.#connected = false;
		this.#endpointUrl = null;
		const closeReason = postmortem.markExpectedCleanupError(
			new DOMException("MCP legacy SSE transport closed", "AbortError"),
		);
		// Before rejecting pending entries, so an in-flight POST is cancelled
		// rather than left holding a socket.
		this.#lifecycleController.abort(closeReason);
		if (this.#sseConnection) {
			this.#sseConnection.abort(closeReason);
			this.#sseConnection = null;
		}
		this.#rejectPending(closeReason);
		const onClose = this.onClose;
		this.onClose = undefined;
		if (wasConnected) onClose?.();
	}
}
