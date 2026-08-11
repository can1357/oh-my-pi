/**
 * MCP JSON-RPC 2.0 over HTTPS.
 *
 * Lightweight utilities for calling MCP servers directly via HTTP
 * without maintaining persistent connections.
 */
import { logger, readSseJson, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { buildModernMCPHttpHeaders } from "./transports/http";
import {
	buildModernRequestParams,
	type MCPImplementation,
	type MCPMeta,
	type MCPModernClientCapabilities,
	type MCPModernProtocolVersion,
	type MCPToolHeaderMetadata,
} from "./types";

/** Hard ceiling on a single MCP HTTP request when the caller provides no signal. */
const MCP_DEFAULT_TIMEOUT_MS = 60_000;

const SENSITIVE_QUERY_PARAM = /key|token|secret|auth/i;

/**
 * Redact credential-bearing query params (e.g. `exaApiKey`) so failed
 * requests never write secrets to the persistent log file.
 */
export function redactUrlForLog(url: string): string {
	try {
		const parsed = new URL(url);
		for (const name of parsed.searchParams.keys()) {
			if (SENSITIVE_QUERY_PARAM.test(name)) parsed.searchParams.set(name, "[redacted]");
		}
		return parsed.toString();
	} catch {
		// Unparseable URL — drop the query string entirely rather than risk leaking it.
		return url.split("?")[0];
	}
}

/**
 * Compatibility parser for callers that only need the first JSON SSE event.
 * `callMCP` deliberately does not use it: a modern request stream can carry
 * notifications before its final, ID-correlated response.
 */
export function parseSSE(text: string): unknown {
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.startsWith("data: ")) {
			const data = line.slice(6).trim();
			if (data === "[DONE]") continue;
			try {
				const result = JSON.parse(data) as unknown;
				if (result) return result;
			} catch {
				// Non-JSON data line (keep-alive/comment) — skip and keep scanning.
			}
		}
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** JSON-RPC 2.0 response structure. */
export interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: string | number;
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

/**
 * Explicit modern request context for the stateless direct HTTP helper.
 * The helper does not infer a protocol era and cannot be used as a bare
 * initialization-era/legacy HTTP compatibility call.
 */
export interface ModernMCPRequestContext {
	version: MCPModernProtocolVersion;
	clientCapabilities: MCPModernClientCapabilities;
	clientInfo?: MCPImplementation;
	metadata?: MCPMeta;
	/** Validated tools/list metadata when a direct tools/call needs Mcp-Param-* mirrors. */
	toolHeaderMetadata?: MCPToolHeaderMetadata;
}

/** Options controlling one explicitly modern direct MCP HTTP request. */
export interface CallMcpOptions {
	context: ModernMCPRequestContext;
	signal?: AbortSignal;
	onNotification?: (method: string, params: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotification(value: unknown): value is { method: string; params: unknown } {
	return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && !Object.hasOwn(value, "id");
}

/**
 * Returns a final response only when it is correlated to this request. SSE
 * streams may contain notification events (and malformed/foreign events), but
 * those must never be presented to the caller as a response.
 */
function responseForRequestId<T>(
	value: unknown,
	expectedId: string | number,
	source: "json" | "sse",
): JsonRpcResponse<T> | undefined {
	if (!isRecord(value)) {
		if (source === "json") throw new Error("Invalid JSON-RPC response");
		return undefined;
	}
	if (source === "json" && !Object.hasOwn(value, "result") && !Object.hasOwn(value, "error")) {
		throw new Error("Expected a JSON-RPC response");
	}
	if (value.jsonrpc !== "2.0") {
		if (source === "json" || (isRecord(value) && Object.hasOwn(value, "id") && value.id === expectedId)) {
			throw new Error("Invalid JSON-RPC version in response");
		}
		return undefined;
	}
	if (value.id !== expectedId) {
		if (source === "json") {
			throw new Error(`Mismatched response ID: expected ${expectedId}, received ${String(value.id)}`);
		}
		return undefined;
	}
	const hasResult = Object.hasOwn(value, "result");
	const hasError = Object.hasOwn(value, "error");
	if (hasResult === hasError) throw new Error("Invalid JSON-RPC response shape");
	if (hasError) {
		const error = value.error;
		if (!isRecord(error) || !Number.isInteger(error.code) || typeof error.message !== "string") {
			throw new Error("Invalid JSON-RPC error response");
		}
	}
	return value as unknown as JsonRpcResponse<T>;
}

async function readModernSseResponse<T>(
	body: ReadableStream<Uint8Array>,
	expectedId: string | number,
	signal: AbortSignal,
	onNotification: ((method: string, params: unknown) => void) | undefined,
): Promise<JsonRpcResponse<T>> {
	for await (const raw of readSseJson<unknown | unknown[]>(body, signal)) {
		const messages = Array.isArray(raw) ? raw : [raw];
		for (const message of messages) {
			const response = responseForRequestId<T>(message, expectedId, "sse");
			if (response) return response;
			if (isNotification(message)) onNotification?.(message.method, message.params);
		}
	}
	throw new Error(`No response received for request ID ${expectedId}`);
}

/**
 * Sends one 2026-07-28 stateless Streamable HTTP request. Callers must supply
 * the negotiated request context explicitly; legacy initialize/session HTTP is
 * intentionally outside this one-shot helper.
 */
export async function callMCP<T = unknown>(
	url: string,
	method: string,
	params: Record<string, unknown> | undefined,
	options: CallMcpOptions,
): Promise<JsonRpcResponse<T>> {
	const requestParams = buildModernRequestParams(
		params,
		{
			version: options.context.version,
			clientCapabilities: options.context.clientCapabilities,
		},
		options.context.metadata,
		options.context.clientInfo,
	);
	const id = Snowflake.next();
	const body = {
		jsonrpc: "2.0" as const,
		id,
		method,
		params: requestParams,
	};
	const headers = buildModernMCPHttpHeaders(method, requestParams, options.context, {
		...(options.context.toolHeaderMetadata ? { toolHeaderMetadata: options.context.toolHeaderMetadata } : {}),
	});
	const signal = options.signal ?? AbortSignal.timeout(MCP_DEFAULT_TIMEOUT_MS);
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		await response.body?.cancel();
		const errorMessage = `MCP request failed: ${response.status} ${response.statusText}`;
		logger.error(errorMessage, { url: redactUrlForLog(url), method });
		throw new Error(errorMessage);
	}

	const contentType = response.headers.get("Content-Type") ?? "";
	if (contentType.includes("text/event-stream")) {
		if (!response.body) throw new Error("MCP SSE response has no body");
		return readModernSseResponse<T>(response.body, id, signal, options.onNotification);
	}
	if (!contentType.includes("application/json")) {
		await response.body?.cancel();
		throw new Error(`Unsupported MCP response content type: ${contentType || "missing"}`);
	}
	return responseForRequestId<T>(await response.json(), id, "json")!;
}
