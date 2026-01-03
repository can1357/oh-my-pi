import * as fs from "node:fs";
import { applyWorkspaceEdit } from "./edits.js";
import type {
	Diagnostic,
	LspClient,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	ServerConfig,
	WorkspaceEdit,
} from "./types.js";
import { detectLanguageId, fileToUri } from "./utils.js";

// =============================================================================
// Client State
// =============================================================================

const clients = new Map<string, LspClient>();

// Idle timeout: shutdown clients after 5 minutes of inactivity
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

// Background task to shutdown idle clients
let idleCheckInterval: Timer | null = null;

function startIdleChecker(): void {
	if (idleCheckInterval) return;
	idleCheckInterval = setInterval(() => {
		const now = Date.now();
		for (const [key, client] of Array.from(clients.entries())) {
			if (now - client.lastActivity > IDLE_TIMEOUT_MS) {
				console.log(`[LSP] Shutting down idle client: ${key}`);
				shutdownClient(key);
			}
		}
	}, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleChecker(): void {
	if (idleCheckInterval) {
		clearInterval(idleCheckInterval);
		idleCheckInterval = null;
	}
}

// =============================================================================
// Client Capabilities
// =============================================================================

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: {
			didSave: true,
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
		},
		hover: {
			contentFormat: ["markdown", "plaintext"],
			dynamicRegistration: false,
		},
		definition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		references: {
			dynamicRegistration: false,
		},
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		rename: {
			dynamicRegistration: false,
			prepareSupport: true,
		},
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
						"source.fixAll",
					],
				},
			},
			resolveSupport: {
				properties: ["edit"],
			},
		},
		formatting: {
			dynamicRegistration: false,
		},
		rangeFormatting: {
			dynamicRegistration: false,
		},
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: false,
			tagSupport: { valueSet: [1, 2] },
			codeDescriptionSupport: true,
			dataSupport: true,
		},
	},
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "textOnlyTransactional",
		},
		configuration: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
	},
	experimental: {
		snippetTextEdit: true,
	},
};

// =============================================================================
// LSP Message Protocol
// =============================================================================

/**
 * Parse a single LSP message from a buffer.
 * Returns the parsed message and remaining buffer, or null if incomplete.
 */
function parseMessage(
	buffer: Uint8Array,
): { message: LspJsonRpcResponse | LspJsonRpcNotification; remaining: Uint8Array } | null {
	// Only decode enough to find the header
	const headerEndIndex = findHeaderEnd(buffer);
	if (headerEndIndex === -1) return null;

	const headerText = new TextDecoder().decode(buffer.slice(0, headerEndIndex));
	const contentLengthMatch = headerText.match(/Content-Length: (\d+)/i);
	if (!contentLengthMatch) return null;

	const contentLength = Number.parseInt(contentLengthMatch[1], 10);
	const messageStart = headerEndIndex + 4; // Skip \r\n\r\n
	const messageEnd = messageStart + contentLength;

	if (buffer.length < messageEnd) return null;

	const messageBytes = buffer.slice(messageStart, messageEnd);
	const messageText = new TextDecoder().decode(messageBytes);
	const remaining = buffer.slice(messageEnd);

	return {
		message: JSON.parse(messageText),
		remaining,
	};
}

/**
 * Find the end of the header section (before \r\n\r\n)
 */
function findHeaderEnd(buffer: Uint8Array): number {
	for (let i = 0; i < buffer.length - 3; i++) {
		if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
			return i;
		}
	}
	return -1;
}

/**
 * Concatenate two Uint8Arrays efficiently
 */
function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
	const result = new Uint8Array(a.length + b.length);
	result.set(a);
	result.set(b, a.length);
	return result;
}

async function writeMessage(
	sink: import("bun").FileSink,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): Promise<void> {
	const content = JSON.stringify(message);
	const contentBytes = new TextEncoder().encode(content);
	const header = `Content-Length: ${contentBytes.length}\r\n\r\n`;
	const fullMessage = new TextEncoder().encode(header + content);

	sink.write(fullMessage);
	await sink.flush();
}

// =============================================================================
// Message Reader
// =============================================================================

/**
 * Start background message reader for a client.
 * Routes responses to pending requests and handles notifications.
 */
async function startMessageReader(client: LspClient): Promise<void> {
	if (client.isReading) return;
	client.isReading = true;

	const reader = (client.process.stdout as ReadableStream<Uint8Array>).getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			client.messageBuffer = concatBuffers(client.messageBuffer, value);

			// Process all complete messages in buffer
			let parsed = parseMessage(client.messageBuffer);
			while (parsed) {
				const { message, remaining } = parsed;
				client.messageBuffer = remaining;

				// Route message
				if ("id" in message && message.id !== undefined) {
					// Response to a request
					const pending = client.pendingRequests.get(message.id);
					if (pending) {
						client.pendingRequests.delete(message.id);
						if ("error" in message && message.error) {
							pending.reject(new Error(`LSP error: ${message.error.message}`));
						} else {
							pending.resolve(message.result);
						}
					} else if ("method" in message) {
						await handleServerRequest(client, message as LspJsonRpcRequest);
					}
				} else if ("method" in message) {
					// Server notification
					if (message.method === "textDocument/publishDiagnostics" && message.params) {
						const params = message.params as { uri: string; diagnostics: Diagnostic[] };
						client.diagnostics.set(params.uri, params.diagnostics);
					}
				}

				parsed = parseMessage(client.messageBuffer);
			}
		}
	} catch (err) {
		// Connection closed or error - reject all pending requests
		for (const pending of Array.from(client.pendingRequests.values())) {
			pending.reject(new Error(`LSP connection closed: ${err}`));
		}
		client.pendingRequests.clear();
	} finally {
		reader.releaseLock();
		client.isReading = false;
	}
}

/**
 * Handle workspace/configuration requests from the server.
 */
async function handleConfigurationRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { items?: Array<{ section?: string }> };
	const items = params?.items ?? [];
	const result = items.map((item) => {
		const section = item.section ?? "";
		return client.config.settings?.[section] ?? {};
	});
	await sendResponse(client, message.id, result, "workspace/configuration");
}

/**
 * Handle workspace/applyEdit requests from the server.
 */
async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { edit?: WorkspaceEdit };
	if (!params?.edit) {
		await sendResponse(
			client,
			message.id,
			{ applied: false, failureReason: "No edit provided" },
			"workspace/applyEdit",
		);
		return;
	}

	try {
		await applyWorkspaceEdit(params.edit, client.cwd);
		await sendResponse(client, message.id, { applied: true }, "workspace/applyEdit");
	} catch (err) {
		await sendResponse(client, message.id, { applied: false, failureReason: String(err) }, "workspace/applyEdit");
	}
}

/**
 * Respond to a server-initiated request.
 */
async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		await handleConfigurationRequest(client, message);
		return;
	}
	if (message.method === "workspace/applyEdit") {
		await handleApplyEditRequest(client, message);
		return;
	}
	if (typeof message.id !== "number") return;
	await sendResponse(client, message.id, null, message.method, {
		code: -32601,
		message: `Method not found: ${message.method}`,
	});
}

/**
 * Send an LSP response to the server.
 */
async function sendResponse(
	client: LspClient,
	id: number,
	result: unknown,
	method: string,
	error?: { code: number; message: string; data?: unknown },
): Promise<void> {
	const response: LspJsonRpcResponse = {
		jsonrpc: "2.0",
		id,
		...(error ? { error } : { result }),
	};

	try {
		await writeMessage(client.process.stdin as import("bun").FileSink, response);
	} catch (err) {
		console.error(`[LSP] Failed to respond to ${method}: ${err}`);
	}
}

// =============================================================================
// Client Management
// =============================================================================

/**
 * Get or create an LSP client for the given server configuration and working directory.
 */
export async function getOrCreateClient(config: ServerConfig, cwd: string): Promise<LspClient> {
	const key = `${config.command}:${cwd}`;

	if (clients.has(key)) {
		const client = clients.get(key)!;
		client.lastActivity = Date.now();
		return client;
	}

	const args = config.args ?? [];
	const proc = Bun.spawn([config.command, ...args], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const client: LspClient = {
		name: key,
		cwd,
		process: proc,
		config,
		requestId: 0,
		diagnostics: new Map(),
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(0),
		isReading: false,
		lastActivity: Date.now(),
	};
	clients.set(key, client);

	// Start idle checker if not already running
	startIdleChecker();

	// Register crash recovery - remove client on process exit
	proc.exited.then(() => {
		console.log(`[LSP] Process exited: ${key}`);
		clients.delete(key);
		if (clients.size === 0) {
			stopIdleChecker();
		}
	});

	// Start background message reader
	startMessageReader(client);

	try {
		// Send initialize request
		const initResult = (await sendRequest(client, "initialize", {
			processId: process.pid,
			rootUri: fileToUri(cwd),
			rootPath: cwd,
			capabilities: CLIENT_CAPABILITIES,
			initializationOptions: config.initOptions ?? {},
			workspaceFolders: [{ uri: fileToUri(cwd), name: cwd.split("/").pop() ?? "workspace" }],
		})) as { capabilities?: unknown };

		if (!initResult) {
			throw new Error("Failed to initialize LSP: no response");
		}

		client.serverCapabilities = initResult.capabilities as LspClient["serverCapabilities"];

		// Send initialized notification
		await sendNotification(client, "initialized", {});

		return client;
	} catch (err) {
		// Clean up on initialization failure
		clients.delete(key);
		proc.kill();
		throw err;
	}
}

/**
 * Ensure a file is opened in the LSP client.
 * Sends didOpen notification if the file is not already tracked.
 */
export async function ensureFileOpen(client: LspClient, filePath: string): Promise<void> {
	const uri = fileToUri(filePath);
	if (client.openFiles.has(uri)) {
		return;
	}

	const content = fs.readFileSync(filePath, "utf-8");
	const languageId = detectLanguageId(filePath);

	await sendNotification(client, "textDocument/didOpen", {
		textDocument: {
			uri,
			languageId,
			version: 1,
			text: content,
		},
	});

	client.openFiles.set(uri, { version: 1, languageId });
	client.lastActivity = Date.now();
}

/**
 * Refresh a file in the LSP client.
 * Increments version, sends didChange and didSave notifications.
 */
export async function refreshFile(client: LspClient, filePath: string): Promise<void> {
	const uri = fileToUri(filePath);
	const info = client.openFiles.get(uri);

	if (!info) {
		await ensureFileOpen(client, filePath);
		return;
	}

	const content = fs.readFileSync(filePath, "utf-8");
	info.version++;

	await sendNotification(client, "textDocument/didChange", {
		textDocument: { uri, version: info.version },
		contentChanges: [{ text: content }],
	});

	await sendNotification(client, "textDocument/didSave", {
		textDocument: { uri },
		text: content,
	});

	client.lastActivity = Date.now();
}

/**
 * Shutdown a specific client by key.
 */
export function shutdownClient(key: string): void {
	const client = clients.get(key);
	if (!client) return;

	// Reject all pending requests
	for (const pending of Array.from(client.pendingRequests.values())) {
		pending.reject(new Error("LSP client shutdown"));
	}
	client.pendingRequests.clear();

	// Send shutdown request (best effort, don't wait)
	sendRequest(client, "shutdown", null).catch(() => {});

	// Kill process
	client.process.kill();
	clients.delete(key);

	if (clients.size === 0) {
		stopIdleChecker();
	}
}

// =============================================================================
// LSP Protocol Methods
// =============================================================================

/**
 * Send an LSP request and wait for response.
 */
export async function sendRequest(client: LspClient, method: string, params: unknown): Promise<unknown> {
	const id = ++client.requestId;
	const request: LspJsonRpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};

	client.lastActivity = Date.now();

	return new Promise((resolve, reject) => {
		// Set timeout
		const timeout = setTimeout(() => {
			if (client.pendingRequests.has(id)) {
				client.pendingRequests.delete(id);
				reject(new Error(`LSP request ${method} timed out`));
			}
		}, 30000);

		// Register pending request with timeout wrapper
		client.pendingRequests.set(id, {
			resolve: (result) => {
				clearTimeout(timeout);
				resolve(result);
			},
			reject: (err) => {
				clearTimeout(timeout);
				reject(err);
			},
			method,
		});

		// Write request
		writeMessage(client.process.stdin as import("bun").FileSink, request).catch((err) => {
			clearTimeout(timeout);
			client.pendingRequests.delete(id);
			reject(err);
		});
	});
}

/**
 * Send an LSP notification (no response expected).
 */
export async function sendNotification(client: LspClient, method: string, params: unknown): Promise<void> {
	const notification: LspJsonRpcNotification = {
		jsonrpc: "2.0",
		method,
		params,
	};

	client.lastActivity = Date.now();
	await writeMessage(client.process.stdin as import("bun").FileSink, notification);
}

/**
 * Shutdown all LSP clients.
 */
export function shutdownAll(): void {
	stopIdleChecker();

	for (const client of Array.from(clients.values())) {
		// Reject all pending requests
		for (const pending of Array.from(client.pendingRequests.values())) {
			pending.reject(new Error("LSP client shutdown"));
		}
		client.pendingRequests.clear();

		// Send shutdown request (best effort, don't wait)
		sendRequest(client, "shutdown", null).catch(() => {});

		client.process.kill();
	}
	clients.clear();
}

/** Status of an LSP server */
export interface LspServerStatus {
	name: string;
	status: "connecting" | "ready" | "error";
	fileTypes: string[];
	error?: string;
}

/**
 * Get status of all active LSP clients.
 */
export function getActiveClients(): LspServerStatus[] {
	return Array.from(clients.values()).map((client) => ({
		name: client.config.command,
		status: "ready" as const,
		fileTypes: client.config.fileTypes,
	}));
}

// =============================================================================
// Process Cleanup
// =============================================================================

// Register cleanup on module unload
if (typeof process !== "undefined") {
	process.on("beforeExit", shutdownAll);
	process.on("SIGINT", () => {
		shutdownAll();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		shutdownAll();
		process.exit(0);
	});
}
