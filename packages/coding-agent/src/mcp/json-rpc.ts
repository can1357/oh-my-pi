/**
 * MCP JSON-RPC 2.0 over HTTPS.
 *
 * Lightweight utilities for calling MCP servers directly via HTTP
 * without maintaining persistent connections.
 */
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { logger, readSseEvents } from "@oh-my-pi/pi-utils";

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
	fetch?: FetchImpl;
	headers?: Record<string, string>;
	onHttpError?: (response: Response, body: string) => Error;
	onParseError?: (responseText: string) => Error;
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
	const signal = options?.signal ?? AbortSignal.timeout(MCP_DEFAULT_TIMEOUT_MS);

	const response = await (options?.fetch ?? fetch)(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...options?.headers,
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		if (options?.onHttpError) {
			throw options.onHttpError(response, await response.text());
		}
		const errorMsg = `MCP request failed: ${response.status} ${response.statusText}`;
		logger.error(errorMsg, { url: redactUrlForLog(url), method, params });
		throw new Error(errorMsg);
	}

	let text = "";
	let result: JsonRpcResponse<T> | null = null;
	if (response.headers.get("Content-Type")?.includes("text/event-stream") && response.body) {
		for await (const event of readSseEvents(response.body, signal)) {
			text = event.data;
			let message: JsonRpcResponse<T> | null;
			try {
				message = JSON.parse(text) as JsonRpcResponse<T> | null;
			} catch {
				continue;
			}
			// Notifications and replies to other requests are not this call's result.
			if (message?.id === body.id && ("result" in message || "error" in message)) {
				result = message;
				break;
			}
		}
		signal.throwIfAborted();
	} else {
		text = await response.text();
		result = parseSSE(text) as JsonRpcResponse<T> | null;
	}

	if (!result) {
		logger.error("Failed to parse MCP response", {
			url: redactUrlForLog(url),
			method,
			responseText: text.slice(0, 500),
		});
		throw options?.onParseError?.(text) ?? new Error("Failed to parse MCP response");
	}

	return result;
}
