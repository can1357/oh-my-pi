/**
 * MCP JSON-RPC 2.0 over HTTPS.
 *
 * Lightweight utilities for calling MCP servers directly via HTTP
 * without maintaining persistent connections.
 */
import { isRecord, logger, readSseEvents } from "@oh-my-pi/pi-utils";
import type { JsonRpcResponse } from "./types";

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

function decodeJsonRpcResponse(message: unknown): JsonRpcResponse | null {
	if (!isRecord(message) || message.jsonrpc !== "2.0") {
		throw new SyntaxError("Malformed JSON-RPC message");
	}

	const hasResult = Object.hasOwn(message, "result");
	const hasError = Object.hasOwn(message, "error");
	if ("method" in message) {
		if (
			typeof message.method !== "string" ||
			hasResult ||
			hasError ||
			("id" in message && typeof message.id !== "string" && typeof message.id !== "number")
		) {
			throw new SyntaxError("Malformed JSON-RPC request");
		}
		if ("params" in message && !isRecord(message.params) && !Array.isArray(message.params)) {
			throw new SyntaxError("Malformed JSON-RPC request");
		}
		return null;
	}

	if (typeof message.id !== "string" && typeof message.id !== "number") {
		throw new SyntaxError("Malformed JSON-RPC response");
	}
	if (hasResult === hasError) {
		throw new SyntaxError("Malformed JSON-RPC response");
	}

	if (hasError) {
		if (
			!isRecord(message.error) ||
			typeof message.error.code !== "number" ||
			typeof message.error.message !== "string"
		) {
			throw new SyntaxError("Malformed JSON-RPC error response");
		}
		return {
			jsonrpc: "2.0",
			id: message.id,
			error: {
				code: message.error.code,
				message: message.error.message,
				...(Object.hasOwn(message.error, "data") ? { data: message.error.data } : {}),
			},
		};
	}

	return { jsonrpc: "2.0", id: message.id, result: message.result };
}

/**
 * Read the matching JSON-RPC response from a JSON or SSE HTTP response.
 *
 * Notifications, server requests, and responses for other request IDs do not
 * satisfy the caller's request. Malformed messages always fail the response.
 */
export async function readMcpJsonRpcResponse(
	response: Response,
	expectedId: string | number,
	signal?: AbortSignal,
): Promise<JsonRpcResponse> {
	let sawUnmatchedResponse = false;

	const selectMessage = (message: unknown): JsonRpcResponse | null => {
		const decoded = decodeJsonRpcResponse(message);
		if (!decoded) return null;
		if (decoded.id === expectedId) return decoded;
		sawUnmatchedResponse = true;
		return null;
	};
	const selectResponse = (payload: unknown): JsonRpcResponse | null => {
		if (!Array.isArray(payload)) return selectMessage(payload);
		for (const message of payload) {
			const matched = selectMessage(message);
			if (matched) return matched;
		}
		return null;
	};

	signal?.throwIfAborted();
	if (response.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream")) {
		if (!response.body) throw new Error("MCP SSE response did not include a body");
		for await (const event of readSseEvents(response.body, signal)) {
			if (event.data === "") continue;
			if (event.data === "[DONE]") break;
			const payload: unknown = JSON.parse(event.data);
			const matched = selectResponse(payload);
			if (matched) {
				signal?.throwIfAborted();
				return matched;
			}
		}
	} else {
		const payload: unknown = await response.json();
		const matched = selectResponse(payload);
		if (matched) {
			signal?.throwIfAborted();
			return matched;
		}
	}
	signal?.throwIfAborted();

	if (sawUnmatchedResponse) {
		throw new Error("MCP response ID did not match request ID");
	}
	throw new Error("MCP response did not include a result or error");
}

/** Options controlling a single MCP JSON-RPC HTTP request. */
export interface CallMcpOptions {
	signal?: AbortSignal;
}

/**
 * Call an MCP server with JSON-RPC 2.0 over HTTPS.
 *
 * @param url - Full MCP server URL (including any query parameters)
 * @param method - JSON-RPC method name (e.g., "tools/list", "tools/call")
 * @param params - Method parameters
 * @param options - Optional transport controls such as cancellation.
 * @returns Parsed JSON-RPC response
 */
export async function callMCP(
	url: string,
	method: string,
	params?: Record<string, unknown>,
	options?: CallMcpOptions,
): Promise<JsonRpcResponse> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};

	const signal = options?.signal ?? AbortSignal.timeout(MCP_DEFAULT_TIMEOUT_MS);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const errorMsg = `MCP request failed: ${response.status} ${response.statusText}`;
		logger.error(errorMsg, { url: redactUrlForLog(url), method, params });
		throw new Error(errorMsg);
	}

	try {
		return await readMcpJsonRpcResponse(response, body.id, signal);
	} catch (error) {
		logger.error("Failed to parse MCP response", {
			url: redactUrlForLog(url),
			method,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
