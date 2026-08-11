/**
 * MCP HTTP transport (Streamable HTTP).
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * Based on MCP spec 2025-03-26.
 */
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import { logger, readSseJson, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import {
	buildModernRequestParams,
	encodeMCPHeaderValue,
	extractMCPToolHeaderValues,
	getMCPNotificationSubscriptionId,
	hasMCPSubscriptionNotifications,
	isMCPSubscriptionNotificationAcknowledged,
	type JsonRpcError,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type MCPHttpServerConfig,
	type MCPListenHandle,
	type MCPListenOptions,
	type MCPModernProbeFallbackDecision,
	type MCPModernProtocolVersion,
	MCPNotificationMethods,
	type MCPRequestId,
	type MCPRequestOptions,
	type MCPSseServerConfig,
	type MCPSubscriptionNotificationFilter,
	MCPSubscriptionProtocolError,
	type MCPToolHeaderMetadata,
	type MCPTransport,
	type MCPTransportProtocolConfiguration,
	toJsonRpcError,
	validateMCPSubscriptionAcknowledgement,
} from "../../mcp/types";
import { createMCPTimeout, getNeverAbortSignal, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";

const HTTP_SSE_CONNECT_TIMEOUT_MS = 1_000;
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

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_HEADER_VALUE_PATTERN = /^[\t\x20-\x7e]*$/;
const MODERN_RESERVED_HEADER_NAMES = new Set([
	"accept",
	"content-type",
	"last-event-id",
	"mcp-method",
	"mcp-name",
	"mcp-protocol-version",
	"mcp-session-id",
]);
const MODERN_PROTOCOL_ERROR_CODES = new Set([-32020, -32021, -32022]);

function isModernReservedHeader(name: string): boolean {
	const normalized = name.toLowerCase();
	return MODERN_RESERVED_HEADER_NAMES.has(normalized) || normalized.startsWith("mcp-param-");
}

function applyConfiguredModernHeaders(
	headers: Record<string, string>,
	configuredHeaders: Record<string, string> | undefined,
): void {
	for (const [name, value] of Object.entries(configuredHeaders ?? {})) {
		if (!HTTP_HEADER_NAME_PATTERN.test(name) || !HTTP_HEADER_VALUE_PATTERN.test(value)) {
			throw new Error(`Invalid configured HTTP header "${name}"`);
		}
		if (isModernReservedHeader(name)) {
			throw new Error(`Configured HTTP header "${name}" is reserved by modern MCP`);
		}
		headers[name] = value;
	}
}

function requiredMcpName(method: string, params: Record<string, unknown>): string | undefined {
	const sourceField =
		method === "tools/call" || method === "prompts/get" ? "name" : method === "resources/read" ? "uri" : undefined;
	if (!sourceField) return undefined;
	const value = params[sourceField];
	if (typeof value !== "string") {
		throw new Error(`Modern ${method} requests require string params.${sourceField} for Mcp-Name`);
	}
	return encodeMCPHeaderValue(value);
}

/**
 * Builds the complete MCP-owned modern request header set. Configured headers
 * are copied only after rejecting every header whose value is derived from the
 * JSON-RPC body, so neither configuration nor tool schemas can override them.
 */
export function buildModernMCPHttpHeaders(
	method: string,
	params: Record<string, unknown>,
	context: { version: MCPModernProtocolVersion },
	options?: {
		headers?: Record<string, string>;
		toolHeaderMetadata?: MCPToolHeaderMetadata;
	},
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	applyConfiguredModernHeaders(headers, options?.headers);
	headers["MCP-Protocol-Version"] = context.version;
	headers["Mcp-Method"] = method;

	const name = requiredMcpName(method, params);
	if (name !== undefined) headers["Mcp-Name"] = name;

	if (method !== "tools/call" || !options?.toolHeaderMetadata) return headers;
	const toolName = params.name;
	if (typeof toolName !== "string" || options.toolHeaderMetadata.toolName !== toolName) {
		throw new Error("Tool header metadata does not match tools/call params.name");
	}
	const argumentsValue = params.arguments;
	const argumentsRecord =
		typeof argumentsValue === "object" && argumentsValue !== null && !Array.isArray(argumentsValue)
			? (argumentsValue as Record<string, unknown>)
			: undefined;
	for (const header of extractMCPToolHeaderValues(options.toolHeaderMetadata, argumentsRecord)) {
		if (!HTTP_HEADER_NAME_PATTERN.test(header.name)) {
			throw new Error(`Invalid tool parameter header "${header.name}"`);
		}
		headers[header.name] = header.value;
	}
	return headers;
}

function parseJsonRpcErrorBody(body: string): JsonRpcError | undefined {
	try {
		const value = JSON.parse(body) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const response = value as Record<string, unknown>;
		if (response.jsonrpc !== "2.0" || typeof response.error !== "object" || response.error === null) return undefined;
		const error = response.error as Record<string, unknown>;
		if (!Number.isInteger(error.code) || typeof error.message !== "string") return undefined;
		return {
			code: error.code as number,
			message: error.message,
			...(error.data === undefined ? {} : { data: error.data }),
		};
	} catch {
		return undefined;
	}
}

/**
 * Retains the transport-level status and response body alongside a JSON-RPC
 * error when one was actually emitted. The modern-probe classifier deliberately
 * consumes only this representation, so local/auth/network failures cannot
 * accidentally select a legacy lifecycle.
 */
export class MCPHttpResponseError extends Error {
	readonly code?: number;
	readonly data?: unknown;

	constructor(
		readonly status: number,
		readonly responseBody: string,
		readonly jsonRpcError?: JsonRpcError,
		readonly authHints?: string,
	) {
		super(
			jsonRpcError
				? `MCP error ${jsonRpcError.code}: ${jsonRpcError.message}`
				: `HTTP ${status}: ${responseBody}${authHints ? ` [${authHints}]` : ""}`,
		);
		this.name = "MCPHttpResponseError";
		if (jsonRpcError) {
			this.code = jsonRpcError.code;
			this.data = jsonRpcError.data;
		}
	}
}

function responseError(response: Response, body: string): MCPHttpResponseError {
	const authHints = [
		response.headers.get("WWW-Authenticate") ? `WWW-Authenticate: ${response.headers.get("WWW-Authenticate")}` : null,
		response.headers.get("Mcp-Auth-Server") ? `Mcp-Auth-Server: ${response.headers.get("Mcp-Auth-Server")}` : null,
	]
		.filter((value): value is string => value !== null)
		.join("; ");
	return new MCPHttpResponseError(response.status, body, parseJsonRpcErrorBody(body), authHints || undefined);
}

function jsonRpcResponseError(error: JsonRpcError): Error {
	return Object.assign(new Error(`MCP error ${error.code}: ${error.message}`), {
		code: error.code,
		...(error.data === undefined ? {} : { data: error.data }),
	});
}

function isRecognizedModernProtocolError(error: JsonRpcError): boolean {
	return MODERN_PROTOCOL_ERROR_CODES.has(error.code);
}

const IDENTITY_BEARING_AUTH_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"api-key",
	"x-api-key",
	"x-auth-token",
	"x-access-token",
]);

function changedIdentityBearingAuthHeaders(
	currentHeaders: Record<string, string> | undefined,
	nextHeaders: Record<string, string>,
): boolean {
	const normalized = (headers: Record<string, string> | undefined) => {
		const result = new Map<string, string>();
		for (const [name, value] of Object.entries(headers ?? {})) {
			const normalizedName = name.toLowerCase();
			if (IDENTITY_BEARING_AUTH_HEADERS.has(normalizedName)) result.set(normalizedName, value);
		}
		return result;
	};
	const current = normalized(currentHeaders);
	const next = normalized(nextHeaders);
	if (current.size !== next.size) return true;
	for (const [name, value] of current) {
		if (next.get(name) !== value) return true;
	}
	return false;
}

function incrementAuthenticationContextRevision(revision: number): number {
	if (revision >= Number.MAX_SAFE_INTEGER) {
		throw new Error("MCP authentication context revision exhausted");
	}
	return revision + 1;
}

/**
 * HTTP transport for MCP servers.
 * Uses POST for requests, supports SSE responses.
 */
export class HttpTransport implements MCPTransport {
	#connected = false;
	#sessionId: string | null = null;
	#sseConnection: AbortController | null = null;
	#protocol: MCPTransportProtocolConfiguration | undefined;
	#toolHeaderMetadata = new Map<string, MCPToolHeaderMetadata>();
	#authenticationContextRevision = 0;
	#listeners = new Map<MCPRequestId, MCPListenHandle>();

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(private config: MCPHttpServerConfig | MCPSseServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.config.url;
	}

	/**
	 * Stores the era selected by the connection owner. HTTP never guesses an
	 * era from configuration or a response: a modern probe is configured before
	 * its POST and the legacy adapter is configured only after accepted fallback.
	 */
	configureProtocol(configuration: MCPTransportProtocolConfiguration): void {
		if (configuration.era === "modern") {
			this.#sessionId = null;
			if (this.#sseConnection) {
				this.#sseConnection.abort();
				this.#sseConnection = null;
			}
		}
		this.#protocol = configuration;
	}

	getProtocolConfiguration(): MCPTransportProtocolConfiguration | undefined {
		return this.#protocol;
	}

	/**
	 * Opaque identity context version for modern private-result cache isolation.
	 * It intentionally exposes no credential material.
	 */
	getAuthenticationContextRevision(): number {
		return this.#authenticationContextRevision;
	}

	#applyRefreshedHeaders(headers: Record<string, string>): void {
		if (changedIdentityBearingAuthHeaders(this.config.headers, headers)) {
			this.#authenticationContextRevision = incrementAuthenticationContextRevision(
				this.#authenticationContextRevision,
			);
		}
		this.config = { ...this.config, headers };
	}

	/**
	 * Replaces, rather than extends, the validated tools/list snapshot supplied
	 * by the core client. Defensive validation keeps an accidental external
	 * caller from turning a header annotation into an injection primitive.
	 */
	registerToolHeaderMetadata(metadata: readonly MCPToolHeaderMetadata[]): void {
		const snapshot = new Map<string, MCPToolHeaderMetadata>();
		for (const tool of metadata) {
			if (typeof tool.toolName !== "string" || tool.toolName.length === 0 || snapshot.has(tool.toolName)) {
				throw new Error("Invalid duplicate tool header metadata");
			}
			const headerNames = new Set<string>();
			const parameters = tool.parameters.map(parameter => {
				if (
					!HTTP_HEADER_NAME_PATTERN.test(parameter.headerName) ||
					headerNames.has(parameter.headerName.toLowerCase()) ||
					parameter.path.length === 0 ||
					parameter.path.some(segment => typeof segment !== "string" || segment.length === 0) ||
					(parameter.valueType !== "string" &&
						parameter.valueType !== "integer" &&
						parameter.valueType !== "boolean")
				) {
					throw new Error(`Invalid header metadata for tool "${tool.toolName}"`);
				}
				headerNames.add(parameter.headerName.toLowerCase());
				return {
					path: [...parameter.path],
					headerName: parameter.headerName,
					valueType: parameter.valueType,
				};
			});
			snapshot.set(tool.toolName, { toolName: tool.toolName, parameters });
		}
		this.#toolHeaderMetadata = snapshot;
	}

	/**
	 * HTTP is allowed to select legacy only for an unrecognized body on a 400
	 * response to a configured modern probe. In particular, network, timeout,
	 * authentication, and all non-400 failures remain errors instead of an
	 * unsafe downgrade signal.
	 */
	classifyModernProbeFailure(error: unknown): MCPModernProbeFallbackDecision {
		if (this.#protocol?.era !== "modern" || !(error instanceof MCPHttpResponseError) || error.status !== 400) {
			return { kind: "reject" };
		}
		if (error.jsonRpcError && isRecognizedModernProtocolError(error.jsonRpcError)) {
			return { kind: "modern-error", error: error.jsonRpcError };
		}
		return { kind: "legacy" };
	}

	/**
	 * Mark transport as connected.
	 * HTTP doesn't need a persistent connection, but we track state.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;
		this.#connected = true;
	}

	/**
	 * Legacy Streamable HTTP's independent GET listener. Modern 2026-07-28
	 * traffic has no such endpoint, so an accidental call is a no-op rather
	 * than a GET that could select obsolete stateful behavior.
	 */
	async startSSEListener(): Promise<void> {
		if (!this.#connected || this.#protocol?.era !== "legacy") return;
		if (this.#sseConnection) return;

		this.#sseConnection = new AbortController();
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			...this.config.headers,
		};
		if (this.#sessionId) headers["Mcp-Session-Id"] = this.#sessionId;

		let response: Response | null;
		let timedOut = false;
		let startupFinished = false;
		const connection = this.#sseConnection;
		const startupTimeoutMs = resolveSSEConnectTimeoutMs(this.config.timeout);
		const fetchPromise = fetch(this.config.url, {
			method: "GET",
			headers,
			signal: connection.signal,
		});
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
			if (error instanceof Error && error.name !== "AbortError" && !timedOut) this.onError?.(error);
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

		const signal = connection.signal;
		void this.#readSSEStream(response.body, signal).finally(() => {
			const wasConnected = this.#connected;
			if (this.#sseConnection === connection) this.#sseConnection = null;
			if (wasConnected) this.onClose?.();
		});
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

	/** Route legacy SSE messages, while never answering modern server requests. */
	#dispatchSSEMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const item of message) this.#dispatchSSEMessage(item);
			return;
		}
		if ("method" in message && "id" in message && message.id != null) {
			if (this.#protocol?.era === "legacy") void this.#handleServerRequest(message as JsonRpcRequest);
			else logger.warn("Ignoring invalid server-initiated request on modern HTTP", { method: message.method });
			return;
		}
		if ("method" in message && !("id" in message)) {
			this.onNotification?.(message.method, message.params);
		}
	}

	#protocolOrThrow(): MCPTransportProtocolConfiguration {
		if (!this.#protocol) throw new Error("MCP HTTP protocol has not been configured");
		return this.#protocol;
	}

	#legacyHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};
		if (this.#sessionId) headers["Mcp-Session-Id"] = this.#sessionId;
		return headers;
	}

	#requestParts(
		method: string,
		params: Record<string, unknown> | undefined,
		metadata: MCPRequestOptions["metadata"] | undefined,
	): {
		params: Record<string, unknown>;
		headers: Record<string, string>;
		protocol: MCPTransportProtocolConfiguration;
	} {
		const protocol = this.#protocolOrThrow();
		if (protocol.era === "legacy") {
			return { params: params ?? {}, headers: this.#legacyHeaders(), protocol };
		}
		const requestParams = buildModernRequestParams(
			params,
			{ version: protocol.version, clientCapabilities: protocol.clientCapabilities },
			metadata,
			protocol.clientInfo,
		);
		const toolName =
			method === "tools/call" && typeof requestParams.name === "string" ? requestParams.name : undefined;
		return {
			params: requestParams,
			headers: buildModernMCPHttpHeaders(method, requestParams, protocol, {
				headers: this.config.headers,
				...(toolName && this.#toolHeaderMetadata.has(toolName)
					? { toolHeaderMetadata: this.#toolHeaderMetadata.get(toolName) }
					: {}),
			}),
			protocol,
		};
	}

	async listen(
		params: { notifications: MCPSubscriptionNotificationFilter },
		options?: MCPListenOptions,
	): Promise<MCPListenHandle> {
		if (!this.#connected) throw new Error("Transport not connected");
		const protocol = this.#protocolOrThrow();
		if (protocol.era !== "modern" || protocol.phase !== "connected") {
			throw new Error("subscriptions/listen requires a connected modern MCP transport");
		}
		if (!hasMCPSubscriptionNotifications(params.notifications)) {
			throw new Error("subscriptions/listen requires at least one notification filter");
		}
		if (params.notifications.resourceSubscriptions?.some(uri => typeof uri !== "string" || uri.length === 0)) {
			throw new Error("subscriptions/listen resourceSubscriptions must contain non-empty strings");
		}
		if (options?.signal?.aborted) {
			throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
		}

		const requestedNotifications: MCPSubscriptionNotificationFilter = {
			...(params.notifications.toolsListChanged === true ? { toolsListChanged: true } : {}),
			...(params.notifications.promptsListChanged === true ? { promptsListChanged: true } : {}),
			...(params.notifications.resourcesListChanged === true ? { resourcesListChanged: true } : {}),
			...(params.notifications.resourceSubscriptions
				? { resourceSubscriptions: [...new Set(params.notifications.resourceSubscriptions)] }
				: {}),
		};
		const requestId = Snowflake.next();
		const controller = new AbortController();
		const acknowledgment = Promise.withResolvers<MCPSubscriptionNotificationFilter>();
		const completion = Promise.withResolvers<void>();
		// The stream may fail before listen() returns control to its caller.
		// Mark both lifecycle promises handled without changing their observable rejection.
		void acknowledgment.promise.catch(() => {});
		void completion.promise.catch(() => {});
		let acknowledged = false;
		let settled = false;
		let cancelled = false;

		const detachCallerAbort = () => options?.signal?.removeEventListener("abort", onCallerAbort);
		const settleFailure = (error: unknown) => {
			if (settled) return;
			settled = true;
			this.#listeners.delete(requestId);
			detachCallerAbort();
			const failure = error instanceof Error ? error : new Error(String(error));
			if (!acknowledged) acknowledgment.reject(failure);
			completion.reject(failure);
		};
		const settleSuccess = () => {
			if (settled) return;
			settled = true;
			this.#listeners.delete(requestId);
			detachCallerAbort();
			if (!acknowledged) {
				acknowledgment.reject(
					new MCPSubscriptionProtocolError(
						`subscriptions/listen ${requestId} ended before notifications/subscriptions/acknowledged`,
					),
				);
			}
			completion.resolve();
		};
		const cancel = async (): Promise<void> => {
			if (settled) return;
			cancelled = true;
			controller.abort(new DOMException("Subscription cancelled", "AbortError"));
			settleSuccess();
		};
		const onCallerAbort = () => {
			void cancel();
		};
		if (options?.signal) {
			options.signal.addEventListener("abort", onCallerAbort, { once: true });
			if (options.signal.aborted) onCallerAbort();
		}

		const handle: MCPListenHandle = {
			requestId,
			requestedNotifications,
			acknowledged: acknowledgment.promise,
			completion: completion.promise,
			cancel,
		};
		this.#listeners.set(requestId, handle);

		const validateClosure = (result: unknown): void => {
			if (typeof result !== "object" || result === null || Array.isArray(result)) {
				throw new MCPSubscriptionProtocolError("Invalid subscriptions/listen closure result");
			}
			const closure = result as Record<string, unknown>;
			if (closure.resultType !== "complete") {
				throw new MCPSubscriptionProtocolError("Invalid subscriptions/listen closure resultType");
			}
			const subscriptionId =
				typeof closure._meta === "object" && closure._meta !== null && !Array.isArray(closure._meta)
					? (closure._meta as Record<string, unknown>)["io.modelcontextprotocol/subscriptionId"]
					: undefined;
			if (subscriptionId !== requestId) {
				throw new MCPSubscriptionProtocolError("Invalid subscriptions/listen closure subscription ID");
			}
		};

		const dispatchMessage = (message: JsonRpcMessage): boolean => {
			if (typeof message !== "object" || message === null || Array.isArray(message) || message.jsonrpc !== "2.0") {
				throw new MCPSubscriptionProtocolError("Invalid JSON-RPC 2.0 message envelope on stream");
			}
			const hasResult = Object.hasOwn(message, "result");
			const hasError = Object.hasOwn(message, "error");
			if ("id" in message && message.id != null) {
				if (hasResult === hasError) {
					throw new MCPSubscriptionProtocolError("Invalid JSON-RPC 2.0 response shape on stream");
				}
				if (message.id !== requestId) {
					throw new MCPSubscriptionProtocolError(
						`Mismatched subscriptions/listen response ID for request ${requestId}`,
					);
				}
				if ("error" in message && message.error) throw jsonRpcResponseError(message.error);
				if (!("result" in message)) {
					throw new MCPSubscriptionProtocolError("Invalid JSON-RPC 2.0 response shape on stream");
				}
				if (!acknowledged) {
					throw new MCPSubscriptionProtocolError(`subscriptions/listen ${requestId} closed before acknowledgment`);
				}
				validateClosure(message.result);
				settleSuccess();
				return true;
			}
			if (!("method" in message) || typeof message.method !== "string" || hasResult || hasError) {
				throw new MCPSubscriptionProtocolError("Invalid JSON-RPC 2.0 notification on stream");
			}

			if (message.method === MCPNotificationMethods.CANCELLED) {
				const requestIdValue =
					typeof message.params === "object" && message.params !== null && !Array.isArray(message.params)
						? (message.params as Record<string, unknown>).requestId
						: undefined;
				if (requestIdValue !== requestId) {
					throw new MCPSubscriptionProtocolError("Mismatched server subscription cancellation ID");
				}
				settleSuccess();
				return true;
			}

			const subscriptionId = getMCPNotificationSubscriptionId(message.params);
			if (subscriptionId !== requestId) {
				throw new MCPSubscriptionProtocolError(`Mismatched subscription notification ID for request ${requestId}`);
			}
			if (!acknowledged) {
				if (message.method !== MCPNotificationMethods.SUBSCRIPTIONS_ACKNOWLEDGED) {
					throw new MCPSubscriptionProtocolError(
						`subscriptions/listen ${requestId} received ${message.method} before acknowledgment`,
					);
				}
				const accepted = validateMCPSubscriptionAcknowledgement(requestedNotifications, message.params);
				acknowledged = true;
				handle.acknowledgedNotifications = accepted;
				acknowledgment.resolve(accepted);
				return false;
			}
			if (message.method === MCPNotificationMethods.SUBSCRIPTIONS_ACKNOWLEDGED) {
				throw new MCPSubscriptionProtocolError(`subscriptions/listen ${requestId} was acknowledged more than once`);
			}
			if (
				!isMCPSubscriptionNotificationAcknowledged(
					handle.acknowledgedNotifications ?? {},
					message.method,
					message.params,
				)
			) {
				throw new MCPSubscriptionProtocolError(
					`subscriptions/listen ${requestId} received unacknowledged notification ${message.method}`,
				);
			}
			options?.onNotification?.(message.method, message.params);
			return false;
		};

		const run = async (): Promise<void> => {
			try {
				let request = this.#requestParts(
					"subscriptions/listen",
					{ notifications: requestedNotifications },
					options?.metadata,
				);
				const body = {
					jsonrpc: "2.0" as const,
					id: requestId,
					method: "subscriptions/listen",
					params: request.params,
				};
				let response = await fetch(this.config.url, {
					method: "POST",
					headers: request.headers,
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				if (this.onAuthError && (response.status === 401 || response.status === 403)) {
					const newHeaders = await this.onAuthError();
					if (newHeaders && !cancelled) {
						await response.body?.cancel();
						this.#applyRefreshedHeaders(newHeaders);
						request = this.#requestParts(
							"subscriptions/listen",
							{ notifications: requestedNotifications },
							options?.metadata,
						);
						response = await fetch(this.config.url, {
							method: "POST",
							headers: request.headers,
							body: JSON.stringify({ ...body, params: request.params }),
							signal: controller.signal,
						});
					}
				}
				if (!response.ok) {
					const text = await response.text();
					throw responseError(response, text);
				}
				const contentType = response.headers.get("Content-Type") ?? "";
				if (!contentType.includes("text/event-stream") || !response.body) {
					await response.body?.cancel();
					throw new MCPSubscriptionProtocolError("subscriptions/listen requires a text/event-stream response");
				}

				for await (const raw of readSseJson<JsonRpcMessage | JsonRpcMessage[]>(response.body, controller.signal)) {
					const messages = Array.isArray(raw) ? raw : [raw];
					for (const message of messages) {
						if (dispatchMessage(message)) return;
					}
				}
				if (!settled) {
					throw new MCPSubscriptionProtocolError(
						`subscriptions/listen stream ${requestId} closed without a final response`,
					);
				}
			} catch (error) {
				if (cancelled || (error instanceof Error && error.name === "AbortError")) return;
				settleFailure(error);
			}
		};
		void run();
		return handle;
	}

	#parseJsonResponse<T>(value: unknown, expectedId: string | number): T {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("Invalid JSON-RPC response");
		}
		const response = value as Record<string, unknown>;
		if (response.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC version in response");
		if (response.id !== expectedId) {
			throw new Error(`Mismatched response ID: expected ${expectedId}, received ${String(response.id)}`);
		}
		const hasResult = Object.hasOwn(response, "result");
		const hasError = Object.hasOwn(response, "error");
		if (hasResult === hasError) throw new Error("Invalid JSON-RPC response shape");
		if (hasError) {
			const error = parseJsonRpcErrorBody(JSON.stringify(response));
			if (!error) throw new Error("Invalid JSON-RPC error response");
			throw jsonRpcResponseError(error);
		}
		return response.result as T;
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		try {
			return await this.#executeRequest<T>(method, params, options);
		} catch (error) {
			const status =
				error instanceof MCPHttpResponseError
					? error.status
					: error instanceof Error
						? AIError.status(error)
						: undefined;
			if (this.onAuthError && (status === 401 || status === 403)) {
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.#applyRefreshedHeaders(newHeaders);
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
		if (!this.#connected) throw new Error("Transport not connected");

		const id = Snowflake.next();
		const request = this.#requestParts(method, params, options?.metadata);
		const body = { jsonrpc: "2.0" as const, id, method, params: request.params };
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, options?.signal);

		try {
			const response = await fetch(this.config.url, {
				method: "POST",
				headers: request.headers,
				body: JSON.stringify(body),
				signal: operation.signal,
			});
			if (!response.ok) {
				const text = await response.text();
				throw responseError(response, text);
			}
			if (request.protocol.era === "legacy") {
				const sessionId = response.headers.get("Mcp-Session-Id");
				if (sessionId) this.#sessionId = sessionId;
			}

			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream")) {
				operation.clear();
				return this.#parseSSEResponse<T>(response, id, options);
			}
			const value = await response.json();
			operation.clear();
			return this.#parseJsonResponse<T>(value, id);
		} catch (error) {
			operation.clear();
			if (operation.isTimeoutAbort(error)) throw new Error(`Request timeout after ${timeout}ms`);
			throw error;
		}
	}

	#parseSSEResponse<T>(response: Response, expectedId: string | number, options?: MCPRequestOptions): Promise<T> {
		if (!response.body) throw new Error("No response body");

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, options?.signal);
		const signal = operation.signal ?? getNeverAbortSignal();
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let captured = false;

		const drain = async (): Promise<void> => {
			try {
				for await (const raw of readSseJson<JsonRpcMessage | JsonRpcMessage[]>(response.body!, signal)) {
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
							if (message.error) reject(jsonRpcResponseError(message.error));
							else resolve(message.result as T);
							continue;
						}
						if (!this.#connected) continue;
						this.#dispatchSSEMessage(message);
					}
				}
				if (!captured) reject(new Error(`No response received for request ID ${expectedId}`));
			} catch (error) {
				if (captured) return;
				if (operation.isTimeoutAbort(error)) reject(new Error(`SSE response timeout after ${timeout}ms`));
				else reject(error as Error);
			} finally {
				operation.clear();
			}
		};

		void drain();
		return promise;
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		if (this.#protocol?.era !== "legacy") return;
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

	/** Legacy-only response POST for server-to-client JSON-RPC requests. */
	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected || this.#protocol?.era !== "legacy") return;
		const body = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		const headers = this.#legacyHeaders();
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		let operation = createMCPTimeout(timeout);
		try {
			const response = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: operation.signal,
			});
			operation.clear();
			if (this.onAuthError && (response.status === 401 || response.status === 403)) {
				await response.body?.cancel();
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.#applyRefreshedHeaders({ ...this.config.headers, ...newHeaders });
					Object.assign(headers, newHeaders);
					operation = createMCPTimeout(timeout);
					const retry = await fetch(this.config.url, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: operation.signal,
					});
					operation.clear();
					await retry.body?.cancel();
					return;
				}
			}
			await response.body?.cancel();
		} catch {
			operation.clear();
			// Best-effort legacy response delivery: the peer may have disconnected.
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) throw new Error("Transport not connected");

		const request = this.#requestParts(method, params, undefined);
		const body = { jsonrpc: "2.0" as const, method, params: request.params };
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout);
		try {
			const response = await fetch(this.config.url, {
				method: "POST",
				headers: request.headers,
				body: JSON.stringify(body),
				signal: operation.signal,
			});
			if (!response.ok && response.status !== 202) {
				const text = await response.text();
				throw responseError(response, text);
			}
			operation.clear();

			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				if (this.#sseConnection) {
					void this.#readSSEStream(response.body, this.#sseConnection.signal);
				} else {
					const readOperation = createMCPTimeout(timeout);
					const signal = readOperation.signal ?? getNeverAbortSignal();
					void this.#readSSEStream(response.body, signal).finally(() => readOperation.clear());
				}
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			operation.clear();
			if (operation.isTimeoutAbort(error)) throw new Error(`Notify timeout after ${timeout}ms`);
			throw error;
		}
	}

	async close(): Promise<void> {
		const listeners = [...this.#listeners.values()];
		await Promise.allSettled(listeners.map(listener => listener.cancel()));
		if (!this.#connected) return;
		this.#connected = false;
		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}

		if (this.#protocol?.era === "legacy" && this.#sessionId) {
			const timeout = resolveMCPTimeoutMs(this.config.timeout);
			const operation = createMCPTimeout(timeout);
			try {
				const headers: Record<string, string> = {
					...this.config.headers,
					"Mcp-Session-Id": this.#sessionId,
				};
				await fetch(this.config.url, {
					method: "DELETE",
					headers,
					signal: operation.signal,
				});
				operation.clear();
			} catch {
				operation.clear();
				// Ignore best-effort legacy session termination failures.
			}
			this.#sessionId = null;
		}

		this.onClose?.();
		this.onClose = undefined;
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
