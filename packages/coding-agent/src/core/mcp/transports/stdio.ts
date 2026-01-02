/**
 * MCP stdio transport.
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 */

import { type Subprocess, spawn } from "bun";
import type { JsonRpcResponse, MCPStdioServerConfig, MCPTransport } from "../types.js";

/** Generate unique request ID */
function generateId(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 */
export class StdioTransport implements MCPTransport {
	private process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	private pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	private buffer = "";
	private _connected = false;
	private readLoop: Promise<void> | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this._connected;
	}

	/**
	 * Start the subprocess and begin reading.
	 */
	async connect(): Promise<void> {
		if (this._connected) return;

		const args = this.config.args ?? [];
		const env = {
			...process.env,
			...this.config.env,
		};

		this.process = spawn({
			cmd: [this.config.command, ...args],
			cwd: this.config.cwd ?? process.cwd(),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		this._connected = true;

		// Start reading stdout
		this.readLoop = this.startReadLoop();

		// Log stderr for debugging
		this.startStderrLoop();
	}

	private async startReadLoop(): Promise<void> {
		if (!this.process?.stdout) return;

		const reader = this.process.stdout.getReader();
		const decoder = new TextDecoder();

		try {
			while (this._connected) {
				const { done, value } = await reader.read();
				if (done) break;

				this.buffer += decoder.decode(value, { stream: true });
				this.processBuffer();
			}
		} catch (error) {
			if (this._connected) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			reader.releaseLock();
			this.handleClose();
		}
	}

	private async startStderrLoop(): Promise<void> {
		if (!this.process?.stderr) return;

		const reader = this.process.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this._connected) {
				const { done, value } = await reader.read();
				if (done) break;
				// Log stderr but don't treat as error - servers use it for logging
				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
					// Could expose via onStderr callback if needed
					// For now, silent - MCP spec says clients MAY capture/ignore
				}
			}
		} catch {
			// Ignore stderr read errors
		} finally {
			reader.releaseLock();
		}
	}

	private processBuffer(): void {
		const lines = this.buffer.split("\n");
		// Keep incomplete last line in buffer
		this.buffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			try {
				const message = JSON.parse(trimmed) as JsonRpcResponse;
				this.handleMessage(message);
			} catch {
				// Ignore malformed lines
			}
		}
	}

	private handleMessage(message: JsonRpcResponse): void {
		// Check if it's a response (has id)
		if ("id" in message && message.id !== null) {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				this.pendingRequests.delete(message.id);
				if (message.error) {
					pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
				} else {
					pending.resolve(message.result);
				}
			}
		} else if ("method" in message) {
			// It's a notification from server
			const notification = message as { method: string; params?: unknown };
			this.onNotification?.(notification.method, notification.params);
		}
	}

	private handleClose(): void {
		if (!this._connected) return;
		this._connected = false;

		// Reject all pending requests
		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.pendingRequests.clear();

		this.onClose?.();
	}

	async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		if (!this._connected || !this.process?.stdin) {
			throw new Error("Transport not connected");
		}

		const id = generateId();
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		return new Promise<T>((resolve, reject) => {
			this.pendingRequests.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
			});

			const message = `${JSON.stringify(request)}\n`;
			try {
				// Bun's FileSink has write() method directly
				this.process!.stdin.write(message);
				this.process!.stdin.flush();
			} catch (error: unknown) {
				this.pendingRequests.delete(id);
				reject(error);
			}
		});
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this._connected || !this.process?.stdin) {
			throw new Error("Transport not connected");
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const message = `${JSON.stringify(notification)}\n`;
		// Bun's FileSink has write() method directly
		this.process.stdin.write(message);
		this.process.stdin.flush();
	}

	async close(): Promise<void> {
		if (!this._connected) return;
		this._connected = false;

		// Reject pending requests
		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.pendingRequests.clear();

		// Kill subprocess
		if (this.process) {
			this.process.kill();
			this.process = null;
		}

		// Wait for read loop to finish
		if (this.readLoop) {
			await this.readLoop.catch(() => {});
			this.readLoop = null;
		}

		this.onClose?.();
	}
}

/**
 * Create and connect a stdio transport.
 */
export async function createStdioTransport(config: MCPStdioServerConfig): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.connect();
	return transport;
}
