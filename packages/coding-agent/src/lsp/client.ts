import * as path from "node:path";
import { isEnoent, logger, postmortem, ptree, stableStringifyJson, untilAborted } from "@oh-my-pi/pi-utils";
import { MessageFramer } from "../jsonrpc/message-framing";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { applyWorkspaceEdit, type ExecutedWorkspaceChange } from "./edits";
import { getLspmuxCommand, isLspmuxSupported } from "./lspmux";
import { connectSharedLspTransport } from "./mux/daemon";
import type {
	LspClient,
	LspJsonRpcId,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	LspTransport,
	LspWriteSink,
	PublishDiagnosticsParams,
	ServerConfig,
	WorkspaceEdit,
} from "./types";
import { detectLanguageId, EquivalentUriMap, fileToUri, uriToFile } from "./utils";

// =============================================================================
// Client State
// =============================================================================

const clients = new Map<string, LspClient>();
interface PendingClient {
	promise: Promise<LspClient>;
	cwd: string;
	config: ServerConfig;
	token: symbol;
}
const clientLocks = new Map<string, PendingClient>();
const invalidatedClientKeys = new Set<string>();
const clientReloadBarriers = new Map<string, Promise<unknown>>();
const fileOperationLocks = new Map<string, Promise<void>>();

/** Negative cache of recent init failures so a broken server fails fast instead of re-spawning per call. */
const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
const initFailures = new Map<string, { at: number; message: string }>();
const READER_EXIT_GRACE_MS = 100;

// Idle timeout configuration (disabled by default)
let idleTimeoutMs: number | null = null;
let idleCheckInterval: NodeJS.Timeout | null = null;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

// Broker-shared server mode (one language server per project shared by every
// omp instance through the LSP mux daemon). Off by default so embedders and
// tests that drive getOrCreateClient directly never touch the daemon broker;
// the SDK turns it on from the `lsp.shared` setting at session creation.
let sharedLspEnabled = false;

/** Enable or disable attaching to broker-shared language servers. */
export function setSharedLspEnabled(enabled: boolean): void {
	sharedLspEnabled = enabled;
}

/**
 * Configure the idle timeout for LSP clients.
 * @param ms - Timeout in milliseconds, or null/undefined to disable
 */
export function setIdleTimeout(ms: number | null | undefined): void {
	idleTimeoutMs = ms ?? null;

	if (idleTimeoutMs && idleTimeoutMs > 0) {
		startIdleChecker();
	} else {
		stopIdleChecker();
	}
}

/**
 * Whether a client may be reaped by the idle checker.
 *
 * A client with in-flight requests is *busy*, never idle. `lastActivity` is
 * stamped when a request is written, not while it is outstanding, so a single
 * request that runs longer than the idle timeout used to look like silence:
 * the checker tore the client down mid-flight and `shutdownClientInstance`
 * rejected the caller's still-pending promise with "LSP client shutdown"
 * (issue #8390). Requests that settle refresh `lastActivity`, so a client
 * becomes eligible again only after the final one lands and the full idle
 * window then elapses.
 *
 * Exported for tests; the idle checker is the only production caller.
 */
export function isIdleClient(client: LspClient, now: number, timeoutMs: number): boolean {
	if (client.pendingRequests.size > 0) return false;
	return now - client.lastActivity > timeoutMs;
}

function startIdleChecker(): void {
	if (idleCheckInterval) return;
	idleCheckInterval = setInterval(() => {
		if (!idleTimeoutMs) return;
		const now = Date.now();
		for (const [key, client] of Array.from(clients.entries())) {
			if (isIdleClient(client, now, idleTimeoutMs)) {
				void shutdownClient(key);
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
		typeDefinition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		implementation: {
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
			versionSupport: true,
			tagSupport: { valueSet: [1, 2] },
			codeDescriptionSupport: true,
			dataSupport: true,
		},
		diagnostic: {
			dynamicRegistration: true,
		},
	},
	window: {
		workDoneProgress: true,
	},
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "abort",
		},
		configuration: true,
		workspaceFolders: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		fileOperations: {
			dynamicRegistration: false,
			willCreate: false,
			didCreate: false,
			willRename: true,
			didRename: true,
			willDelete: false,
			didDelete: false,
		},
	},
};

/** LSP `FileChangeType` values for workspace/didChangeWatchedFiles notifications. */
export enum FileChangeType {
	Created = 1,
	Changed = 2,
	Deleted = 3,
}

/** Filesystem change authored by the harness and announced to active LSP clients. */
export interface WatchedFileChange {
	filePath: string;
	type: FileChangeType;
}

// =============================================================================
// LSP Message Protocol
// =============================================================================

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new ToolAbortError();
}

class LspDrainAbortError extends Error {
	constructor(readonly reason: Error) {
		super(reason.message);
		this.name = "LspDrainAbortError";
	}
}

async function writeMessage(
	sink: LspWriteSink,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) {
		throw abortReason(signal);
	}
	const content = JSON.stringify(message);
	const write = Promise.resolve(
		sink.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`),
	);
	// Attach before flush(): it may throw synchronously after write() returned a
	// rejected Promise, and leaving that rejection unobserved kills the host.
	void write.catch(() => {});
	const drain = Promise.all([write, Promise.resolve(sink.flush())]).then(() => {});
	if (!signal) {
		await drain;
		return;
	}
	// Either sink operation can block on the OS-level pipe drain when a live
	// server stops reading stdin. Race the combined drain against the caller's
	// signal so a wedged server surfaces as the tool's normal timeout/cancel.
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () => {
		signal.removeEventListener("abort", onAbort);
		// The underlying drain stays pending in the background; suppress its
		// eventual settlement so we do not surface an unhandled rejection.
		drain.catch(() => {});
		reject(new LspDrainAbortError(abortReason(signal)));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	drain.then(
		() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		},
		(err: unknown) => {
			signal.removeEventListener("abort", onAbort);
			reject(err);
		},
	);
	await promise;
}

/**
 * Kill a client whose write queue is stuck (an aborted drain left a sink
 * operation pending, so subsequent writes queue behind the wedge forever).
 * Remove it from `clients` immediately so concurrent `getOrCreateClient`
 * callers do not grab the corpse before `proc.exited` cleans up.
 */
function teardownWedgedClient(client: LspClient): void {
	if (clients.get(client.name) === client) clients.delete(client.name);
	try {
		client.proc.kill();
	} catch {
		// process already gone or unkillable — the exit handler will finish cleanup.
	}
}

function queueWriteMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
	signal?: AbortSignal,
): Promise<void> {
	const write = client.writeQueue.catch(() => {}).then(() => writeMessage(client.proc.stdin, message, signal));
	const result = write.catch((err: unknown) => {
		if (err instanceof LspDrainAbortError) {
			// Only an abort that raced this write's in-flight drain leaves
			// the sink pending. Pre-write aborts and queued caller timeouts
			// must not kill a healthy shared client.
			teardownWedgedClient(client);
			throw err.reason;
		}
		throw err;
	});
	client.writeQueue = result.catch(() => {});
	return result;
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

	const reader = (client.proc.stdout as ReadableStream<Uint8Array>).getReader();

	const framer = new MessageFramer(Buffer.from(client.messageBuffer));

	let readerFailed = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			framer.push(Buffer.from(value));

			// Drain every complete message currently buffered.
			for (const messageText of framer.drain(headerText => {
				// Non-protocol bytes on stdout (e.g. a wrapper script printing).
				// Drop past the bogus terminator and resync instead of stalling
				// on the same junk header forever.
				logger.warn("LSP framing resync: header block without Content-Length", {
					server: client.name,
					header: headerText.slice(0, 200),
				});
			})) {
				// A malformed message or a throwing server-request handler must not
				// kill the reader — later messages are still well-framed.
				try {
					const message: LspJsonRpcResponse | LspJsonRpcNotification = JSON.parse(messageText);

					// Route message. A JSON-RPC message carrying a `method` is always
					// server-originated: a request when it also has an `id`, a
					// notification otherwise. A message with only an `id` is a response
					// to one of our requests. Disambiguate on `method` FIRST: a
					// server's request ids live in its own id space and routinely
					// collide with our in-flight client request ids (e.g. a
					// basedpyright `workspace/configuration` pull arriving while a
					// `documentSymbol` request with the same id is pending). Matching
					// pending requests first would swallow that pull as a bogus
					// response -- dropping the config answer the server blocks on and
					// resolving our request with `undefined`, wedging the lazy
					// cold-start handshake (#3001).
					if ("method" in message) {
						if ("id" in message && message.id !== undefined) {
							// Server-initiated request: must be answered.
							await handleServerRequest(client, message as LspJsonRpcRequest);
						} else {
							// Server notification
							if (message.method === "textDocument/publishDiagnostics" && message.params) {
								const params = message.params as PublishDiagnosticsParams;
								client.diagnostics.set(params.uri, {
									diagnostics: params.diagnostics,
									version: params.version ?? null,
								});
								client.diagnosticsVersion += 1;
							} else if (message.method === "$/progress" && message.params) {
								const params = message.params as { token: string | number; value?: { kind?: string } };
								if (params.value?.kind === "begin") {
									client.activeProgressTokens.add(params.token);
								} else if (params.value?.kind === "end") {
									client.activeProgressTokens.delete(params.token);
									if (client.activeProgressTokens.size === 0) {
										client.resolveProjectLoaded();
									}
								}
							}
						}
					} else if ("id" in message && message.id !== undefined) {
						// Response to one of our requests.
						const pending = client.pendingRequests.get(message.id);
						if (pending) {
							client.pendingRequests.delete(message.id);
							if ("error" in message && message.error) {
								// Include the JSON-RPC error code: `isMethodNotFoundError` matches
								// `-32601` by substring, so method-not-found is recognized even when
								// the server's message text is nonstandard (e.g. "Unknown request").
								const code = message.error.code;
								pending.reject(
									new Error(
										`LSP error${typeof code === "number" ? ` ${code}` : ""}: ${message.error.message}`,
									),
								);
							} else {
								pending.resolve(message.result);
							}
						}
					}
				} catch (err) {
					logger.warn("LSP message handling failed", {
						server: client.name,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}
	} catch (err) {
		readerFailed = true;
		// Connection closed or error - reject all pending requests
		for (const pending of Array.from(client.pendingRequests.values())) {
			pending.reject(new Error(`LSP connection closed: ${err}`));
		}
		client.pendingRequests.clear();
	} finally {
		// Persist any unparsed remainder so a restarted reader resumes mid-message.
		client.messageBuffer = framer.remainder();
		reader.releaseLock();
		client.isReading = false;
		if (!readerFailed && client.proc.exitCode === null) {
			await waitForExit(client, READER_EXIT_GRACE_MS);
		}
		// Reader exited while the server process is still alive (unrecoverable
		// read error or bad stream state): nothing will route responses anymore,
		// so tear the client down — the next call respawns instead of timing out.
		if (client.proc.exitCode === null) {
			client.status = "error";
			if (clients.get(client.name) === client) {
				clients.delete(client.name);
			}
			const teardownErr = new Error("LSP reader stopped; client torn down");
			for (const pending of client.pendingRequests.values()) {
				pending.reject(teardownErr);
			}
			client.pendingRequests.clear();
			client.resolveProjectLoaded();
			client.proc.kill();
		}
	}
}

/**
 * Build the workspace folder list advertised to the server. Identical shape
 * for `initialize` params and `workspace/workspaceFolders` server requests.
 */
function currentWorkspaceFolders(client: LspClient): Array<{ uri: string; name: string }> {
	return [{ uri: fileToUri(client.cwd), name: path.basename(client.cwd) || "workspace" }];
}

/**
 * Handle workspace/workspaceFolders requests from the server.
 */
async function handleWorkspaceFoldersRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	await sendResponse(client, message.id, currentWorkspaceFolders(client), "workspace/workspaceFolders");
}

/**
 * Handle workspace/configuration requests from the server.
 */
async function handleConfigurationRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	const params = message.params as { items?: Array<{ section?: string }> };
	const items = params?.items ?? [];
	const result = items.map(item => {
		const section = item.section ?? "";
		return client.config.settings?.[section] ?? null;
	});
	await sendResponse(client, message.id, result, "workspace/configuration");
}

/**
 * Handle workspace/applyEdit requests from the server.
 */
async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
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
		await applyWorkspaceEditWithLsp(params.edit, client.cwd);
		await sendResponse(client, message.id, { applied: true }, "workspace/applyEdit");
	} catch (err) {
		await sendResponse(client, message.id, { applied: false, failureReason: String(err) }, "workspace/applyEdit");
	}
}

function workspaceEditChanges(executed: ExecutedWorkspaceChange[]): {
	finalUris: Set<string>;
	deletedRoots: Set<string>;
	watchedFiles: WatchedFileChange[];
} {
	const finalUris = new Set<string>();
	const deletedRoots = new Set<string>();
	const watchedFiles: WatchedFileChange[] = [];
	const watch = (uri: string, type: FileChangeType) => {
		watchedFiles.push({ filePath: uriToFile(uri), type });
	};

	for (const change of executed) {
		if (change.kind === "edit") {
			finalUris.add(change.uri);
			watch(change.uri, FileChangeType.Changed);
		} else if (change.kind === "create") {
			finalUris.add(change.uri);
			watch(change.uri, FileChangeType.Created);
		} else if (change.kind === "rename") {
			deletedRoots.add(change.oldUri);
			finalUris.add(change.newUri);
			watch(change.oldUri, FileChangeType.Deleted);
			watch(change.newUri, FileChangeType.Created);
		} else {
			deletedRoots.add(change.uri);
			watch(change.uri, FileChangeType.Deleted);
		}
	}

	return { finalUris, deletedRoots, watchedFiles };
}

function uriIsWithin(uri: string, root: string): boolean {
	return uri === root || uri.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Reconcile open overlays and file watchers with the ops a workspace edit actually performed. */
async function reconcileExecutedChanges(
	executed: ExecutedWorkspaceChange[],
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	if (executed.length === 0) return;
	const { finalUris, deletedRoots, watchedFiles } = workspaceEditChanges(executed);
	const workspace = path.resolve(cwd);
	const activeClients = Array.from(clients.values()).filter(
		client => client.status === "ready" && path.resolve(client.cwd) === workspace,
	);

	for (const activeClient of activeClients) {
		for (const uri of Array.from(activeClient.openFiles.keys())) {
			let deleted = false;
			for (const root of deletedRoots) {
				if (uriIsWithin(uri, root)) {
					deleted = true;
					break;
				}
			}
			if (!deleted) continue;
			await sendNotification(activeClient, "textDocument/didClose", { textDocument: { uri } }, signal);
			activeClient.openFiles.delete(uri);
			activeClient.diagnostics.delete(uri);
		}
		for (const uri of finalUris) {
			if (!activeClient.openFiles.has(uri)) continue;
			await refreshFile(activeClient, uriToFile(uri), signal);
		}
	}
	await notifyWorkspaceWatchedFiles(cwd, watchedFiles, signal);
}

/**
 * Apply a server-provided workspace edit and reconcile every affected open LSP document.
 * Runtime callers use this wrapper so later semantic requests observe the committed files.
 * Reconciliation is derived from the ops that actually ran — an op skipped via
 * `ignoreIfExists`/`ignoreIfNotExists` neither closes overlays nor notifies watchers, and
 * when the edit fails partway the already-executed prefix is still reconciled before the
 * error propagates so mutated files never keep stale overlays.
 */
export async function applyWorkspaceEditWithLsp(
	edit: WorkspaceEdit,
	cwd: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const executed: ExecutedWorkspaceChange[] = [];
	let applied: string[];
	try {
		({ applied } = await applyWorkspaceEdit(edit, cwd, change => executed.push(change)));
	} catch (err) {
		// Best-effort: overlays for the mutated prefix must not stay stale, but
		// reconciliation problems must not mask the original apply failure.
		try {
			await reconcileExecutedChanges(executed, cwd, signal);
		} catch (reconcileErr) {
			logger.warn("LSP overlay reconciliation after failed workspace edit failed", {
				error: reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr),
			});
		}
		throw err;
	}
	await reconcileExecutedChanges(executed, cwd, signal);
	return applied;
}

interface DynamicCapabilityRegistration {
	id?: unknown;
	method?: unknown;
}

interface DynamicCapabilityParams {
	registrations?: DynamicCapabilityRegistration[];
	unregisterations?: DynamicCapabilityRegistration[];
	unregistrations?: DynamicCapabilityRegistration[];
}

function updateDynamicCapabilities(client: LspClient, message: LspJsonRpcRequest): void {
	const params = message.params as DynamicCapabilityParams;
	if (message.method === "client/registerCapability") {
		if (!Array.isArray(params.registrations)) return;
		let registrations = client.dynamicCapabilityRegistrations;
		if (!registrations) {
			registrations = new Map();
			client.dynamicCapabilityRegistrations = registrations;
		}
		for (const registration of params.registrations) {
			if (typeof registration.id === "string" && typeof registration.method === "string") {
				registrations.set(registration.id, registration.method);
			}
		}
		return;
	}

	const registrations = client.dynamicCapabilityRegistrations;
	if (!registrations) return;
	const unregistrations = params.unregisterations ?? params.unregistrations;
	if (!Array.isArray(unregistrations)) return;
	for (const registration of unregistrations) {
		if (typeof registration.id === "string") {
			registrations.delete(registration.id);
		}
	}
}

/** Whether the server advertised LSP 3.17 document diagnostic pulls statically or through registration. */
export function supportsDocumentDiagnostics(client: LspClient): boolean {
	const staticProvider = client.serverCapabilities?.diagnosticProvider;
	if (staticProvider) return true;

	const registrations = client.dynamicCapabilityRegistrations;
	if (!registrations) return false;
	for (const method of registrations.values()) {
		if (method === "textDocument/diagnostic") return true;
	}
	return false;
}

/**
 * Respond to a server-initiated request.
 */
async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		await handleConfigurationRequest(client, message);
		return;
	}
	if (message.method === "workspace/workspaceFolders") {
		await handleWorkspaceFoldersRequest(client, message);
		return;
	}
	if (message.method === "workspace/applyEdit") {
		await handleApplyEditRequest(client, message);
		return;
	}
	if (message.method === "window/workDoneProgress/create") {
		// Accept progress token registration from the server.
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
		updateDynamicCapabilities(client, message);
		// Some servers block semantic requests until dynamic registration succeeds.
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (message.method === "window/showMessageRequest") {
		// Headless: no UI to surface the prompt. Spec says null = "no action selected".
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (message.method === "window/showDocument") {
		// Headless: nothing to display. Spec result is `{ success: boolean }`.
		await sendResponse(client, message.id, { success: false }, message.method);
		return;
	}
	if (
		message.method === "workspace/semanticTokens/refresh" ||
		message.method === "workspace/inlayHint/refresh" ||
		message.method === "workspace/codeLens/refresh" ||
		message.method === "workspace/codeAction/refresh" ||
		message.method === "workspace/inlineValue/refresh" ||
		message.method === "workspace/foldingRange/refresh" ||
		message.method === "workspace/diagnostic/refresh"
	) {
		// Void acknowledgement per spec; servers that stall waiting for a reply
		// (same failure mode as the dynamic-registration hang in #3029) move on.
		await sendResponse(client, message.id, null, message.method);
		return;
	}
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
	id: LspJsonRpcId,
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
		await queueWriteMessage(client, response);
	} catch (err) {
		logger.error("LSP failed to respond.", { method, error: String(err) });
	}
}

// =============================================================================
// Client Management
// =============================================================================

/** Timeout for warmup initialize requests (5 seconds) */
export const WARMUP_TIMEOUT_MS = 5000;

/** Max time to poll rust-analyzer after progress ends but before Cargo workspaces are ready. */
const RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS = 5_000;
const RUST_ANALYZER_WORKSPACE_READY_POLL_MS = 100;
const RUST_ANALYZER_WORKSPACE_READY_SETTLE_MS = 2_000;
const RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS = 1_000;
const rustAnalyzerReadyClients = new WeakSet<LspClient>();

function commandBasename(command: string): string {
	const slash = command.lastIndexOf("/");
	const backslash = command.lastIndexOf("\\");
	const separator = Math.max(slash, backslash);
	return separator === -1 ? command : command.slice(separator + 1);
}

/**
 * True when this client speaks the rust-analyzer protocol, detected by the
 * command basename (`rust-analyzer[.exe]`) of the configured or resolved
 * binary. Callers use it to gate rust-analyzer-only requests such as
 * `rust-analyzer/reloadWorkspace` (see {@link reloadServer}).
 */
export function isRustAnalyzerClient(client: LspClient): boolean {
	return (
		commandBasename(client.config.command) === "rust-analyzer" ||
		(client.config.resolvedCommand ? commandBasename(client.config.resolvedCommand) === "rust-analyzer" : false)
	);
}

function isRustAnalyzerStatusTimeout(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith("LSP request rust-analyzer/analyzerStatus timed out after ");
}

async function waitForRustAnalyzerWorkspace(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (rustAnalyzerReadyClients.has(client)) {
		return;
	}
	const timings = client.config.workspaceReadyTimings;
	const timeoutMs = timings?.timeoutMs ?? RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS;
	const pollMs = timings?.pollMs ?? RUST_ANALYZER_WORKSPACE_READY_POLL_MS;
	const settleMs = timings?.settleMs ?? RUST_ANALYZER_WORKSPACE_READY_SETTLE_MS;
	const statusRequestTimeoutMs = timings?.statusRequestTimeoutMs ?? RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS;
	const started = Date.now();
	const deadline = started + timeoutMs;
	while (true) {
		throwIfAborted(signal);
		let status: unknown;
		try {
			status = await sendRequest(client, "rust-analyzer/analyzerStatus", {}, signal, statusRequestTimeoutMs);
		} catch (err) {
			if (!isRustAnalyzerStatusTimeout(err) || Date.now() >= deadline) {
				return;
			}
			await Bun.sleep(pollMs);
			continue;
		}
		const ready = typeof status === "string" && !status.startsWith("No workspaces");
		if (ready && Date.now() - started >= settleMs) {
			rustAnalyzerReadyClients.add(client);
			return;
		}
		if (Date.now() >= deadline) {
			return;
		}
		await Bun.sleep(pollMs);
	}
}

const PROJECT_LOAD_TIMEOUT_MS = 15_000;

/** Max time to wait for graceful LSP shutdown and process exit. */
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 1_000;

/**
 * Identity of a server process *and* its initialization: everything that makes
 * two configs unsafe to share one client. `command` + `cwd` alone handed a
 * config with different args/settings the client another config had spawned
 * (#8382), and left a changed config resolving to the stale client after
 * `reload *` (#8384). The command component mirrors the spawn site
 * (`resolvedCommand ?? command`), so two configs naming the same binary
 * differently still share, while the same name resolving to different binaries
 * does not. JSON-encoded so no value can forge the separator.
 */
function clientKey(config: ServerConfig, cwd: string): string {
	const spawnCommand = config.resolvedCommand ?? config.command;
	const identity = stableStringifyJson([
		config.args ?? [],
		config.initOptions ?? null,
		config.settings ?? null,
		config.languageId ?? null,
	]);
	return `${spawnCommand}:${cwd}:${identity}`;
}

/**
 * Shut down clients for `cwd` whose identity is absent from `configs`, and
 * return the server commands torn down.
 *
 * `reload *` re-reads config from disk. Identity-aware keys make a changed
 * server resolve to a fresh client, but the process spawned from the old
 * config would stay registered and running — the idle checker that would
 * eventually reap it is opt-in and off by default.
 */
export function shutdownStaleClients(
	cwd: string,
	configs: readonly ServerConfig[],
	signal?: AbortSignal,
): Promise<string[]> {
	const fresh = new Set(configs.map(config => clientKey(config, cwd)));
	const resolvedCwd = path.resolve(cwd);
	const previousBarrier = clientReloadBarriers.get(resolvedCwd);
	const cleanup = (async (): Promise<string[]> => {
		if (previousBarrier) {
			try {
				await untilAborted(signal, previousBarrier);
			} catch {
				throwIfAborted(signal);
				// A later explicit reload retries teardown after an earlier one
				// failed; ordinary client creation remains blocked in between.
			}
		}
		for (const key of fresh) invalidatedClientKeys.delete(key);
		// Tombstone stale identities before awaiting initialization. Existing
		// callers keep sharing their in-flight promise; later callers cannot spawn
		// another stale process while reload is blocked on teardown.
		const stalePending = Array.from(clientLocks.entries()).filter(
			([key, pending]) => path.resolve(pending.cwd) === resolvedCwd && !fresh.has(key),
		);
		for (const [key] of stalePending) invalidatedClientKeys.add(key);
		for (const client of clients.values()) {
			if (path.resolve(client.cwd) === resolvedCwd && !fresh.has(client.name)) {
				invalidatedClientKeys.add(client.name);
			}
		}
		await Promise.all(
			stalePending.map(async ([, pending]) => {
				try {
					await untilAborted(signal, pending.promise);
				} catch {
					throwIfAborted(signal);
				}
			}),
		);

		const stale = Array.from(clients.values()).filter(
			client => path.resolve(client.cwd) === resolvedCwd && !fresh.has(client.name),
		);
		const results = await Promise.all(stale.map(client => shutdownClientInstance(client)));
		const failed = stale.filter((_client, index) => results[index] !== true);
		if (failed.length > 0) {
			throw new Error(
				"Failed to stop LSP server(s) with superseded configuration: " +
					failed.map(client => client.config.command).join(", "),
			);
		}
		return stale.map(client => client.config.command);
	})();
	clientReloadBarriers.set(resolvedCwd, cleanup);
	void cleanup.then(
		() => {
			if (clientReloadBarriers.get(resolvedCwd) === cleanup) clientReloadBarriers.delete(resolvedCwd);
		},
		() => {},
	);
	return cleanup;
}

/** Allow an explicit user reload to retry a matching initialization failure immediately. */
export function clearInitializationFailure(config: ServerConfig, cwd: string): void {
	initFailures.delete(clientKey(config, cwd));
}

/**
 * Get or create an LSP client for the given server configuration and working directory.
 * @param config - Server configuration
 * @param cwd - Working directory
 * @param initTimeoutMs - Optional hard deadline for the initialize handshake (warmup / other
 *   short-lived callers). When set it takes precedence over `signal` inside `sendRequest`.
 * @param signal - Optional caller abort signal. Threaded into the initialize `sendRequest`
 *   and the `initialized` notification so a wedged server surfaces the caller's
 *   timeout/cancel instead of falling back to the internal 30s default.
 */
export async function getOrCreateClient(
	config: ServerConfig,
	cwd: string,
	initTimeoutMs?: number,
	signal?: AbortSignal,
): Promise<LspClient> {
	const key = clientKey(config, cwd);
	// Check if client already exists
	const existingClient = clients.get(key);
	if (existingClient && !invalidatedClientKeys.has(key)) {
		existingClient.lastActivity = Date.now();
		return existingClient;
	}

	// Check if another coroutine is already creating this client
	const existingLock = clientLocks.get(key);
	if (existingLock) {
		return existingLock.promise;
	}
	if (invalidatedClientKeys.has(key)) {
		throw new Error(`LSP configuration was superseded during reload: ${config.command}`);
	}

	// Do not start a fresh identity until superseded processes are confirmed stopped.
	const reloadBarrier = clientReloadBarriers.get(path.resolve(cwd));
	if (reloadBarrier) {
		try {
			await untilAborted(signal, reloadBarrier);
		} catch (error) {
			throwIfAborted(signal);
			throw error;
		}
		const clientAfterReload = clients.get(key);
		if (clientAfterReload && !invalidatedClientKeys.has(key)) {
			clientAfterReload.lastActivity = Date.now();
			return clientAfterReload;
		}
		const lockAfterReload = clientLocks.get(key);
		if (lockAfterReload) return lockAfterReload.promise;
		if (invalidatedClientKeys.has(key)) {
			throw new Error(`LSP configuration was superseded during reload: ${config.command}`);
		}
	}

	// Fail fast on a recent deterministic init failure instead of re-spawning
	// a broken server (and paying its full init wait) on every call.
	const recentFailure = initFailures.get(key);
	if (recentFailure) {
		if (Date.now() - recentFailure.at < INIT_FAILURE_BACKOFF_MS) {
			throw new Error(`LSP server ${config.command} failed to initialize recently: ${recentFailure.message}`);
		}
		initFailures.delete(key);
	}

	// Create new client with lock
	const lockToken = Symbol();
	const clientPromise = (async () => {
		const baseCommand = config.resolvedCommand ?? config.command;
		const baseArgs = config.args ?? [];

		// Wrap with lspmux if available and supported
		const { command, args, env } = isLspmuxSupported(baseCommand)
			? await getLspmuxCommand(baseCommand, baseArgs)
			: { command: baseCommand, args: baseArgs };

		// Prefer the broker-shared server unless an external lspmux wrapper is
		// already multiplexing this command. Any shared-path failure falls back
		// to a private spawn so LSP never regresses on broker trouble.
		let proc: LspTransport | null = null;
		if (sharedLspEnabled && command === baseCommand) {
			proc = await connectSharedLspTransport({ command, args, cwd, env, signal });
		}
		proc ??= ptree.spawn([command, ...args], {
			cwd,
			stdin: "pipe",
			env: env ? { ...Bun.env, ...env } : undefined,
		});

		let resolveProjectLoaded!: () => void;
		const projectLoaded = new Promise<void>(resolve => {
			resolveProjectLoaded = resolve;
		});
		// Auto-resolve after timeout in case server doesn't use progress tokens
		const projectLoadTimeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS);
		const originalResolve = resolveProjectLoaded;
		resolveProjectLoaded = () => {
			clearTimeout(projectLoadTimeout);
			originalResolve();
		};

		const client: LspClient = {
			name: key,
			cwd,
			proc,
			config,
			requestId: 0,
			diagnostics: new EquivalentUriMap(),
			diagnosticsVersion: 0,
			dynamicCapabilityRegistrations: new Map(),
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: new Uint8Array(0),
			isReading: false,
			status: "connecting",
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded,
			resolveProjectLoaded,
		};

		// Register crash recovery - remove client on process exit
		proc.exited.then(() => {
			if (clients.get(key) === client) clients.delete(key);
			if (clientLocks.get(key)?.token === lockToken) clientLocks.delete(key);
			client.resolveProjectLoaded();

			// Reject any pending requests — the server is gone, they will never complete.
			if (client.pendingRequests.size > 0) {
				// Strip informational log lines (e.g. marksman's [INF]/[DBG] prefix)
				// — they are startup noise, not actionable errors.
				const rawStderr = proc.peekStderr().trim();
				const stderr = rawStderr
					.split("\n")
					.filter(line => !/^\[\d{2}:\d{2}:\d{2} (?:INF|DBG|VRB)\]/.test(line))
					.join("\n")
					.trim();
				const code = proc.exitCode;
				const err = new Error(
					stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`,
				);
				for (const pending of client.pendingRequests.values()) {
					pending.reject(err);
				}
				client.pendingRequests.clear();
			}
		});

		// Start background message reader
		startMessageReader(client);

		try {
			// Send initialize request
			const initResult = (await sendRequest(
				client,
				"initialize",
				{
					processId: process.pid,
					rootUri: fileToUri(cwd),
					rootPath: cwd,
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: config.initOptions ?? {},
					workspaceFolders: currentWorkspaceFolders(client),
				},
				signal,
				initTimeoutMs,
			)) as { capabilities?: unknown };

			if (!initResult) {
				throw new Error("Failed to initialize LSP: no response");
			}

			client.serverCapabilities = initResult.capabilities as LspClient["serverCapabilities"];

			// Finish the initialize handshake before publishing the client as ready.
			await sendNotification(client, "initialized", {}, signal);
			await sendNotification(
				client,
				"workspace/didChangeConfiguration",
				{ settings: config.settings ?? {} },
				signal,
			);

			client.status = "ready";
			// Publish only after init succeeds: pre-init clients are reachable
			// solely through clientLocks, so concurrent callers (warmup vs first
			// tool call) wait for init instead of using an unacknowledged client.
			if (invalidatedClientKeys.has(key)) {
				throw new Error(`LSP configuration was superseded during initialization: ${config.command}`);
			}
			clients.set(key, client);
			initFailures.delete(key);
			return client;
		} catch (err) {
			// Clean up on initialization failure
			client.status = "error";
			if (clients.get(key) === client) clients.delete(key);
			proc.kill();
			const message = err instanceof Error ? err.message : String(err);
			// Negative-cache deterministic failures. Timeouts under a
			// caller-shortened deadline (warmup/writethrough) and caller-signal
			// aborts are transient — the server may simply be slow or the user may
			// have cancelled, so a later call with a fresh deadline should retry.
			if (!signal?.aborted && !(initTimeoutMs !== undefined && message.includes("timed out"))) {
				initFailures.set(key, { at: Date.now(), message });
			}
			throw err;
		} finally {
			if (clientLocks.get(key)?.token === lockToken) clientLocks.delete(key);
		}
	})();

	clientLocks.set(key, { promise: clientPromise, cwd, config, token: lockToken });
	return clientPromise;
}

/** Return an active or already-starting client without starting a language server. */
export async function getActiveOrPendingClient(
	config: ServerConfig,
	cwd: string,
	signal?: AbortSignal,
): Promise<LspClient | undefined> {
	throwIfAborted(signal);
	const client = clients.get(clientKey(config, cwd));
	if (client) {
		client.lastActivity = Date.now();
		return client;
	}

	const pending = clientLocks.get(clientKey(config, cwd));
	if (!pending) return undefined;
	try {
		return await untilAborted(signal, pending.promise);
	} catch {
		throwIfAborted(signal);
		return undefined;
	}
}

/**
 * Ensure a file is opened in the LSP client.
 * Sends didOpen notification if the file is not already tracked.
 */
export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;

	// Check if file is already open
	if (client.openFiles.has(uri)) {
		return;
	}

	// Check if another operation is already opening this file
	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
		return;
	}

	// Lock and open file
	const openPromise = (async () => {
		throwIfAborted(signal);
		// Double-check after acquiring lock
		if (client.openFiles.has(uri)) {
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const languageId = client.config.languageId ?? detectLanguageId(filePath);
		throwIfAborted(signal);

		await sendNotification(
			client,
			"textDocument/didOpen",
			{
				textDocument: {
					uri,
					languageId,
					version: 1,
					text: content,
				},
			},
			signal,
		);

		client.openFiles.set(uri, { version: 1, languageId });
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, openPromise);
	try {
		await openPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Wait for the server's initial project loading to complete.
 * Races the server's $/progress tracking against the abort signal.
 * Returns immediately if loading already completed or timed out.
 */
export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await Promise.race([
		client.projectLoaded,
		...(signal
			? [new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]
			: []),
	]);
	if (isRustAnalyzerClient(client)) {
		await waitForRustAnalyzerWorkspace(client, signal);
	}
}

/**
 * Sync in-memory content to the LSP client without reading from disk.
 * Use this to provide instant feedback during edits before the file is saved.
 */
export async function syncContent(
	client: LspClient,
	filePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;
	throwIfAborted(signal);

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const syncPromise = (async () => {
		// Clear stale diagnostics before syncing new content
		client.diagnostics.delete(uri);

		const info = client.openFiles.get(uri);

		if (!info) {
			// Open file with provided content instead of reading from disk
			const languageId = client.config.languageId ?? detectLanguageId(filePath);
			throwIfAborted(signal);
			await sendNotification(
				client,
				"textDocument/didOpen",
				{
					textDocument: {
						uri,
						languageId,
						version: 1,
						text: content,
					},
				},
				signal,
			);
			client.openFiles.set(uri, { version: 1, languageId });
			client.lastActivity = Date.now();
			return;
		}

		const version = ++info.version;
		throwIfAborted(signal);
		await sendNotification(
			client,
			"textDocument/didChange",
			{
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			},
			signal,
		);
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, syncPromise);
	try {
		await syncPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Notify LSP that a file was saved.
 * Assumes content was already synced via syncContent - just sends didSave.
 */
export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath);
	const info = client.openFiles.get(uri);
	if (!info) return; // File not open, nothing to notify

	throwIfAborted(signal);
	await sendNotification(
		client,
		"textDocument/didSave",
		{
			textDocument: { uri },
		},
		signal,
	);
	client.lastActivity = Date.now();
}

function isPathInsideWorkspace(filePath: string, workspace: string): boolean {
	const relative = path.relative(workspace, path.resolve(filePath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Budget for the one-way watched-files notification: a wedged server that
 *  stops draining stdin must never hang the filesystem mutation that
 *  triggered it. Failures degrade to a debug log below. */
const WATCHED_FILES_NOTIFY_TIMEOUT_MS = 2_000;

/**
 * Announce harness-authored filesystem changes to active LSP clients for `cwd`.
 *
 * This covers sibling files that are not open text documents, such as generated
 * CSS modules or type files that another edited document imports immediately.
 *
 * The underlying stdin write drain is self-bounded by
 * {@link WATCHED_FILES_NOTIFY_TIMEOUT_MS}; only an abort of the caller's
 * `signal` rejects.
 */
export async function notifyWorkspaceWatchedFiles(
	cwd: string,
	changes: readonly WatchedFileChange[],
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	if (changes.length === 0) return;

	const workspace = path.resolve(cwd);
	const activeClients = Array.from(clients.values()).filter(
		client => client.status === "ready" && path.resolve(client.cwd) === workspace,
	);
	if (activeClients.length === 0) return;

	const timeoutSignal = AbortSignal.timeout(WATCHED_FILES_NOTIFY_TIMEOUT_MS);
	const sendSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const results = await Promise.allSettled(
		activeClients.map(async client => {
			const clientChanges = changes
				.filter(change => isPathInsideWorkspace(change.filePath, workspace))
				.map(change => {
					const uri = fileToUri(change.filePath);
					client.diagnostics.delete(uri);
					return { uri, type: change.type };
				});
			if (clientChanges.length === 0) return;
			await sendNotification(client, "workspace/didChangeWatchedFiles", { changes: clientChanges }, sendSignal);
		}),
	);
	throwIfAborted(signal);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.debug("LSP watched-files notification failed", { cwd, error: String(result.reason) });
		}
	}
}

/**
 * Refresh a file in the LSP client.
 * Increments version, sends didChange and didSave notifications.
 */
export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const refreshPromise = (async () => {
		throwIfAborted(signal);
		// Drop cached diagnostics for this URI before asking the server to recompute.
		// Otherwise an unrelated publishDiagnostics notification can advance the global
		// diagnostics version and cause waiters to accept stale unversioned diagnostics.
		client.diagnostics.delete(uri);
		const info = client.openFiles.get(uri);

		if (!info) {
			await ensureFileOpen(client, filePath, signal);
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const version = ++info.version;
		throwIfAborted(signal);

		await sendNotification(
			client,
			"textDocument/didChange",
			{
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			},
			signal,
		);
		throwIfAborted(signal);

		await sendNotification(
			client,
			"textDocument/didSave",
			{
				textDocument: { uri },
				text: content,
			},
			signal,
		);

		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, refreshPromise);
	try {
		await refreshPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

async function waitForExit(client: LspClient, timeoutMs: number): Promise<boolean> {
	return await Promise.race([
		client.proc.exited.then(
			() => true,
			() => true,
		),
		Bun.sleep(timeoutMs).then(() => false),
	]);
}

/**
 * Tear down a specific client instance using the LSP shutdown/exit handshake.
 *
 * Removes the client from the registry by identity first (never evicting a
 * newer client already republished under the same key), then performs a bounded
 * graceful shutdown, force-killing and awaiting confirmed process exit.
 *
 * @returns `true` once the process is confirmed exited, `false` if it outlived
 * the shutdown budget — callers reporting a restart must treat `false` as a
 * failed teardown, not a completed restart.
 */
export async function shutdownClientInstance(client: LspClient): Promise<boolean> {
	if (clients.get(client.name) === client) clients.delete(client.name);

	const err = new Error("LSP client shutdown");
	for (const pending of Array.from(client.pendingRequests.values())) {
		pending.reject(err);
	}
	client.pendingRequests.clear();

	const shutdownCompleted = await sendRequest(client, "shutdown", null, undefined, SHUTDOWN_TIMEOUT_MS).then(
		() => true,
		() => false,
	);
	if (shutdownCompleted) {
		await sendNotification(client, "exit", undefined).catch(() => {});
		if (await waitForExit(client, EXIT_TIMEOUT_MS)) return true;
	}

	client.proc.kill();
	const exited = await waitForExit(client, EXIT_TIMEOUT_MS);
	if (!exited && !clients.has(client.name)) clients.set(client.name, client);
	return exited;
}

/**
 * Shutdown a specific client by key.
 *
 * @returns `true` when the client is gone (already absent or confirmed exited),
 * `false` if a live process outlived the shutdown budget.
 */
export async function shutdownClient(key: string): Promise<boolean> {
	const client = clients.get(key);
	if (!client) return true;
	return await shutdownClientInstance(client);
}

// =============================================================================
// LSP Protocol Methods
// =============================================================================

/** Default timeout for LSP requests when no abort signal is provided (30 seconds) */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Send an LSP request and wait for response.
 *
 * Timeout policy:
 * - If `timeoutMs` is explicitly provided, that value is used.
 * - Else, if `signal` is provided, no internal timer is installed (the caller
 *   owns the deadline via the signal — typically a wall-clock `AbortSignal.timeout`
 *   from the LSP tool). Installing a second hard-coded 30s timer here used to
 *   cause "timed out after 30000ms" errors even when the caller had requested
 *   `timeout: 60`.
 * - Else (no signal, no explicit timeout), fall back to `DEFAULT_REQUEST_TIMEOUT_MS`
 *   to avoid leaking pending requests forever.
 */
export async function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<unknown> {
	// Atomically increment and capture request ID
	const id = ++client.requestId;
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		return Promise.reject(reason);
	}

	const request: LspJsonRpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};

	client.lastActivity = Date.now();

	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let timeout: NodeJS.Timeout | undefined;
	const cleanup = () => {
		if (signal) {
			signal.removeEventListener("abort", abortHandler);
		}
	};
	const abortHandler = () => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
		}
		void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
		if (timeout) clearTimeout(timeout);
		cleanup();
		const reason = signal?.reason instanceof Error ? signal.reason : new ToolAbortError();
		reject(reason);
	};

	const effectiveTimeoutMs = timeoutMs ?? (signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS);
	if (effectiveTimeoutMs !== undefined) {
		timeout = setTimeout(() => {
			if (client.pendingRequests.has(id)) {
				client.pendingRequests.delete(id);
				void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
				const err = new Error(`LSP request ${method} timed out after ${effectiveTimeoutMs}ms`);
				cleanup();
				reject(err);
			}
		}, effectiveTimeoutMs);
	}
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
		if (signal.aborted) {
			abortHandler();
			return promise;
		}
	}

	// Register pending request with timeout wrapper.
	// Settling stamps `lastActivity`: the idle window must be measured from when
	// the exchange finished, not from when it started. Without this a request
	// that outlives the timeout would leave the client instantly reapable the
	// moment it lands, so the next idle sweep would kill a server that had just
	// answered (issue #8390).
	client.pendingRequests.set(id, {
		resolve: result => {
			if (timeout) clearTimeout(timeout);
			client.lastActivity = Date.now();
			cleanup();
			resolve(result);
		},
		reject: err => {
			if (timeout) clearTimeout(timeout);
			client.lastActivity = Date.now();
			cleanup();
			reject(err);
		},
		method,
	});

	// Write request. `queueWriteMessage(..., signal)` bounds the sink flush
	// so a wedged server does not stall the write queue past the signal's
	// deadline; the write-queue teardown kills the client on abort.
	queueWriteMessage(client, request, signal).catch(err => {
		if (timeout) clearTimeout(timeout);
		client.pendingRequests.delete(id);
		cleanup();
		reject(err);
	});
	return promise;
}

/**
 * Send an LSP notification (no response expected).
 * `signal` bounds the underlying `sink.flush()` — without it a server that
 * stops draining stdin blocks every future write on the client's write queue.
 */
export async function sendNotification(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<void> {
	const notification: LspJsonRpcNotification = {
		jsonrpc: "2.0",
		method,
		params,
	};

	client.lastActivity = Date.now();
	await queueWriteMessage(client, notification, signal);
}

/**
 * Shutdown all LSP clients.
 */
export async function shutdownAll(): Promise<void> {
	stopIdleChecker();
	invalidatedClientKeys.clear();
	clientReloadBarriers.clear();
	const clientsToShutdown = Array.from(clients.values());
	clients.clear();
	// Mid-initialize clients live only in clientLocks (publication is deferred
	// until init succeeds) — without this, their server processes outlive
	// shutdown. Failed init promises already cleaned up after themselves.
	const pendingClients = Array.from(clientLocks.values(), pending => pending.promise);
	clientLocks.clear();
	const seen = new Set<LspClient>(clientsToShutdown);
	await Promise.allSettled([
		...clientsToShutdown.map(client => shutdownClientInstance(client)),
		...pendingClients.map(pending =>
			pending.then(client => {
				if (seen.has(client)) return;
				seen.add(client);
				return shutdownClientInstance(client);
			}),
		),
	]);
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
	return Array.from(clients.values()).map(client => ({
		name: client.config.command,
		status: client.status,
		fileTypes: client.config.fileTypes,
	}));
}

// =============================================================================
// Process Cleanup
// =============================================================================

// Route signal-triggered LSP cleanup through the shared `postmortem` cleanup
// list so it runs alongside every other session teardown (draft save,
// `session.dispose()`, kernels, MCP) instead of racing them via a
// module-owned `SIGINT`/`SIGTERM` handler + `process.exit(0)`. Historically
// this file registered its own signal handlers that called `shutdownAll()`
// then `process.exit(0)` — winning the race would drop `session_shutdown`
// extensions, orphan background bash/task jobs, and skip the editor draft
// save (issue #4080). `beforeExit` stays as-is: it fires only when the event
// loop drains with no more work, distinct from signal delivery.
if (typeof process !== "undefined") {
	process.on("beforeExit", () => {
		void shutdownAll();
	});
	postmortem.register("lsp-shutdown", () => shutdownAll());
}
