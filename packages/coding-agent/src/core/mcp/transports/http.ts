/**
 * MCP HTTP transport (Streamable HTTP).
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * Based on MCP spec 2025-03-26.
 */

import type { JsonRpcResponse, MCPHttpServerConfig, MCPSseServerConfig, MCPTransport } from "../types";

/** Generate unique request ID */
function generateId(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Parse SSE data line */
function parseSSELine(line: string): { event?: string; data?: string; id?: string } | null {
	if (line.startsWith("data:")) {
		return { data: line.slice(5).trim() };
	}
	if (line.startsWith("event:")) {
		return { event: line.slice(6).trim() };
	}
	if (line.startsWith("id:")) {
		return { id: line.slice(3).trim() };
	}
	return null;
}

/**
 * HTTP transport for MCP servers.
 * Uses POST for requests, supports SSE responses.
 */
export class HttpTransport implements MCPTransport {
	private _connected = false;
	private sessionId: string | null = null;
	private sseConnection: AbortController | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;

	constructor(private config: MCPHttpServerConfig | MCPSseServerConfig) {}

	get connected(): boolean {
		return this._connected;
	}

	get url(): string {
		return this.config.url;
	}

	/**
	 * Mark transport as connected.
	 * HTTP doesn't need persistent connection, but we track state.
	 */
	async connect(): Promise<void> {
		if (this._connected) return;
		this._connected = true;
	}

	/**
	 * Start SSE listener for server-initiated messages.
	 * Optional - only needed if server sends notifications.
	 */
	async startSSEListener(): Promise<void> {
		if (!this._connected) return;
		if (this.sseConnection) return;

		this.sseConnection = new AbortController();
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			...this.config.headers,
		};

		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}

		try {
			const response = await fetch(this.config.url, {
				method: "GET",
				headers,
				signal: this.sseConnection.signal,
			});

			if (response.status === 405) {
				// Server doesn't support SSE listening, that's OK
				this.sseConnection = null;
				return;
			}

			if (!response.ok || !response.body) {
				this.sseConnection = null;
				return;
			}

			// Read SSE stream
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (this._connected) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const parsed = parseSSELine(line);
					if (parsed?.data && parsed.data !== "[DONE]") {
						try {
							const message = JSON.parse(parsed.data);
							if ("method" in message && !("id" in message)) {
								this.onNotification?.(message.method, message.params);
							}
						} catch {
							// Ignore parse errors
						}
					}
				}
			}
		} catch (error) {
			if (error instanceof Error && error.name !== "AbortError") {
				this.onError?.(error);
			}
		} finally {
			this.sseConnection = null;
		}
	}

	async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		if (!this._connected) {
			throw new Error("Transport not connected");
		}

		const id = generateId();
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};

		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}

		const response = await fetch(this.config.url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		// Check for session ID in response
		const newSessionId = response.headers.get("Mcp-Session-Id");
		if (newSessionId) {
			this.sessionId = newSessionId;
		}

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`HTTP ${response.status}: ${text}`);
		}

		const contentType = response.headers.get("Content-Type") ?? "";

		// Handle SSE response
		if (contentType.includes("text/event-stream")) {
			return this.parseSSEResponse<T>(response, id);
		}

		// Handle JSON response
		const result = (await response.json()) as JsonRpcResponse;

		if (result.error) {
			throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
		}

		return result.result as T;
	}

	private async parseSSEResponse<T>(response: Response, expectedId: string | number): Promise<T> {
		if (!response.body) {
			throw new Error("No response body");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let result: T | undefined;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const parsed = parseSSELine(line);
				if (parsed?.data && parsed.data !== "[DONE]") {
					try {
						const message = JSON.parse(parsed.data) as JsonRpcResponse;

						// Handle our response
						if ("id" in message && message.id === expectedId) {
							if (message.error) {
								throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
							}
							result = message.result as T;
						}
						// Handle notifications
						else if ("method" in message && !("id" in message)) {
							const notification = message as { method: string; params?: unknown };
							this.onNotification?.(notification.method, notification.params);
						}
					} catch (error) {
						if (error instanceof Error && error.message.startsWith("MCP error")) {
							throw error;
						}
						// Ignore other parse errors
					}
				}
			}
		}

		if (result === undefined) {
			throw new Error("No response received");
		}

		return result;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this._connected) {
			throw new Error("Transport not connected");
		}

		const body = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};

		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}

		const response = await fetch(this.config.url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		// 202 Accepted is success for notifications
		if (!response.ok && response.status !== 202) {
			const text = await response.text();
			throw new Error(`HTTP ${response.status}: ${text}`);
		}
	}

	async close(): Promise<void> {
		if (!this._connected) return;
		this._connected = false;

		// Abort SSE listener
		if (this.sseConnection) {
			this.sseConnection.abort();
			this.sseConnection = null;
		}

		// Send session termination if we have a session
		if (this.sessionId) {
			try {
				const headers: Record<string, string> = {
					...this.config.headers,
					"Mcp-Session-Id": this.sessionId,
				};

				await fetch(this.config.url, {
					method: "DELETE",
					headers,
				});
			} catch {
				// Ignore termination errors
			}
			this.sessionId = null;
		}

		this.onClose?.();
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
