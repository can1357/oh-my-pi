import * as AIError from "@oh-my-pi/pi-ai/error";
import { logger, readSseEvents } from "@oh-my-pi/pi-utils";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { RequestIdAllocator } from "../request-id";
import { createMCPTimeout, getNeverAbortSignal, resolveMCPTimeoutMs } from "../timeout";
import { type MCPFetchInit, mcpFetch } from "./header-policy";

interface MCPTimeoutOperation {
	signal?: AbortSignal;
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
}

interface PendingLegacySseRequest {
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	operation: MCPTimeoutOperation;
	abortHandler?: () => void;
}

/** Legacy MCP HTTP+SSE transport from protocol revision 2024-11-05. */
export class LegacySseTransport implements MCPTransport {
	#connected = false;
	#endpointUrl: string | null = null;
	#sseConnection: AbortController | null = null;
	#pending = new Map<string | number, PendingLegacySseRequest>();
	#config: MCPSseServerConfig;
	readonly #requestIds = new RequestIdAllocator();

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(config: MCPSseServerConfig) {
		this.#config = config;
	}

	/** Fetch an endpoint with header precedence and origin policy. */
	#fetch(url: string, init: MCPFetchInit, generated: Record<string, string>): Promise<Response> {
		return mcpFetch(
			url,
			init,
			{ generated, configured: this.#config.headers },
			this.#config.headerPolicy === "origin-locked",
		);
	}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.#config.url;
	}

	async connect(): Promise<void> {
		if (this.#connected) return;
		if (this.#sseConnection) return;

		const connection = new AbortController();
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout, connection.signal);
		const endpointReady = Promise.withResolvers<void>();
		this.#sseConnection = connection;

		try {
			const response = await this.#fetch(
				this.#config.url,
				{ method: "GET", signal: operation.signal },
				{ Accept: "text/event-stream" },
			);

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`HTTP ${response.status}: ${text}`);
			}
			if (!response.body) {
				throw new Error("Legacy SSE response did not include a body");
			}

			void this.#readSSEStream(response.body, operation, endpointReady).finally(() => {
				const wasConnected = this.#connected;
				if (this.#sseConnection === connection) this.#sseConnection = null;
				if (wasConnected) this.onClose?.();
			});
			await endpointReady.promise;
		} catch (error) {
			operation.clear();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			connection.abort();
			if (operation.isTimeoutAbort(error)) {
				throw new Error(`Legacy SSE endpoint timeout after ${timeout}ms`);
			}
			throw error;
		}
	}

	async #readSSEStream(
		body: ReadableStream<Uint8Array>,
		operation: MCPTimeoutOperation,
		endpointReady: PromiseWithResolvers<void>,
	): Promise<void> {
		const signal = operation.signal ?? getNeverAbortSignal();
		let endpointReceived = false;
		try {
			for await (const event of readSseEvents(body, signal)) {
				if (event.event === "endpoint") {
					if (!this.#endpointUrl) {
						const endpointUrl = new URL(event.data, this.#config.url);
						const configuredUrl = new URL(this.#config.url);
						if (endpointUrl.origin !== configuredUrl.origin) {
							throw new Error(
								`Legacy SSE endpoint origin mismatch: expected ${configuredUrl.origin}, received ${endpointUrl.origin}`,
							);
						}
						this.#endpointUrl = endpointUrl.href;
						this.#connected = true;
						endpointReceived = true;
						operation.clear();
						endpointReady.resolve();
					}
					continue;
				}
				if (event.data === "" || event.data === "[DONE]") continue;

				let payload: unknown;
				try {
					payload = JSON.parse(event.data) as unknown;
				} catch (error) {
					if (error instanceof SyntaxError) {
						throw new Error(`Legacy SSE message event contained non-JSON data: ${event.data}`);
					}
					throw error;
				}

				const messages = Array.isArray(payload) ? payload : [payload];
				for (const message of messages) {
					if (typeof message !== "object" || message === null) continue;
					this.#dispatchMessage(message as JsonRpcMessage);
				}
			}
			if (!endpointReceived) {
				endpointReady.reject(new Error("Legacy SSE endpoint event not received"));
			}
		} catch (error) {
			if (!endpointReceived) {
				endpointReady.reject(error);
			} else if (error instanceof Error && error.name !== "AbortError") {
				logger.debug("Legacy SSE stream error", { url: this.#config.url, error: error.message });
				this.onError?.(error);
				this.#rejectPending(error);
			}
		} finally {
			operation.clear();
			if (endpointReceived) {
				this.#rejectPending(new Error("Transport closed: legacy SSE stream closed"));
			}
		}
	}

	#dispatchMessage(message: JsonRpcMessage): void {
		if ("id" in message && ("result" in message || "error" in message)) {
			const pending = this.#pending.get(message.id);
			if (pending) {
				this.#pending.delete(message.id);
				pending.operation.clear();
				if (pending.abortHandler) pending.operation.signal?.removeEventListener("abort", pending.abortHandler);
				const response = message as JsonRpcResponse;
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
				return;
			}
		}
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}
		if ("method" in message && !("id" in message)) {
			this.onNotification?.(message.method, message.params);
		}
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#endpointUrl) {
			throw new Error("Transport not connected");
		}

		const id = this.#requestIds.next(this.#config.requestIdFormat);
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout, options?.signal);
		const deferred = Promise.withResolvers<unknown>();
		// Observe the response promise synchronously so a stream-close rejection
		// from `#rejectPending` that lands while `request()` is still awaiting the
		// POST round-trip is never flagged as an unhandled rejection. The real
		// `await deferred.promise` below still receives and propagates the error.
		void deferred.promise.catch(() => undefined);
		const pending: PendingLegacySseRequest = {
			resolve: deferred.resolve,
			reject: deferred.reject,
			operation,
		};
		if (operation.signal) {
			pending.abortHandler = () => {
				this.#pending.delete(id);
				operation.clear();
				deferred.reject(
					options?.signal?.aborted && options.signal.reason instanceof Error
						? options.signal.reason
						: new Error(`Legacy SSE response timeout after ${timeout}ms`),
				);
			};
			operation.signal.addEventListener("abort", pending.abortHandler, { once: true });
		}
		this.#pending.set(id, pending);

		try {
			const response = await this.#postJson(body, operation.signal);
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`HTTP ${response.status}: ${text}`);
			}
			await response.body?.cancel();
			return (await deferred.promise) as T;
		} catch (error) {
			this.#pending.delete(id);
			operation.clear();
			if (pending.abortHandler) operation.signal?.removeEventListener("abort", pending.abortHandler);
			if (operation.isTimeoutAbort(error)) {
				throw new Error(`Request timeout after ${timeout}ms`);
			}
			throw error;
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#endpointUrl) {
			throw new Error("Transport not connected");
		}

		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout);
		try {
			const response = await this.#postJson(
				{
					jsonrpc: "2.0" as const,
					method,
					params: params ?? {},
				},
				operation.signal,
			);
			operation.clear();
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`HTTP ${response.status}: ${text}`);
			}
			await response.body?.cancel();
		} catch (error) {
			operation.clear();
			if (operation.isTimeoutAbort(error)) {
				throw new Error(`Notify timeout after ${timeout}ms`);
			}
			throw error;
		}
	}

	async #postJson(
		body: JsonRpcRequest | JsonRpcResponse | { jsonrpc: "2.0"; method: string; params: Record<string, unknown> },
		signal?: AbortSignal,
	): Promise<Response> {
		const endpointUrl = this.#endpointUrl;
		if (!endpointUrl) throw new Error("Transport not connected");
		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		const payload = JSON.stringify(body);
		let response = await this.#fetch(endpointUrl, { method: "POST", body: payload, signal }, generated);
		const status = AIError.status(response);
		if (!this.onAuthError || (status !== 401 && status !== 403)) return response;

		const refreshedHeaders = await this.onAuthError();
		if (!refreshedHeaders) return response;
		await response.body?.cancel();
		this.#config.headers = refreshedHeaders;
		response = await this.#fetch(endpointUrl, { method: "POST", body: payload, signal }, generated);
		return response;
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

	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected) return;
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout);
		try {
			const response = await this.#postJson(
				error ? { jsonrpc: "2.0" as const, id, error } : { jsonrpc: "2.0" as const, id, result: result ?? {} },
				operation.signal,
			);
			operation.clear();
			await response.body?.cancel();
		} catch {
			operation.clear();
		}
	}

	#rejectPending(error: Error): void {
		for (const [id, pending] of this.#pending) {
			this.#pending.delete(id);
			pending.operation.clear();
			if (pending.abortHandler) pending.operation.signal?.removeEventListener("abort", pending.abortHandler);
			pending.reject(error);
		}
	}

	async close(): Promise<void> {
		if (!this.#connected && !this.#sseConnection) return;
		const wasConnected = this.#connected;
		this.#connected = false;
		this.#endpointUrl = null;
		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}
		this.#rejectPending(new Error("Transport closed"));
		if (wasConnected) this.onClose?.();
		this.onClose = undefined;
	}
}

/** Create and connect a legacy HTTP+SSE transport. */
export async function createSseTransport(config: MCPSseServerConfig): Promise<LegacySseTransport> {
	const transport = new LegacySseTransport(config);
	await transport.connect();
	return transport;
}
