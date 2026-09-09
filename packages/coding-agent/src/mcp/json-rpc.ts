/**
 * MCP JSON-RPC 2.0 over HTTPS.
 *
 * Lightweight utilities for calling MCP servers directly via HTTP
 * without maintaining persistent connections.
 */
import { logger } from "@oh-my-pi/pi-utils";

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

/** Parse SSE response format (lines starting with "data: ") */
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
	// Fallback: try parsing entire response as JSON
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** JSON-RPC 2.0 response structure */
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
export async function callMCP<T = unknown>(
	url: string,
	method: string,
	params?: Record<string, unknown>,
	options?: CallMcpOptions,
): Promise<JsonRpcResponse<T>> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
		signal: options?.signal ?? AbortSignal.timeout(MCP_DEFAULT_TIMEOUT_MS),
	});

	if (!response.ok) {
		const errorMsg = `MCP request failed: ${response.status} ${response.statusText}`;
		logger.error(errorMsg, { url: redactUrlForLog(url), method, params });
		throw new Error(errorMsg);
	}

	const text = await response.text();
	const result = parseSSE(text) as JsonRpcResponse<T> | null;

	if (!result) {
		logger.error("Failed to parse MCP response", {
			url: redactUrlForLog(url),
			method,
			responseText: text.slice(0, 500),
		});
		throw new Error("Failed to parse MCP response");
	}

	return result;
}
