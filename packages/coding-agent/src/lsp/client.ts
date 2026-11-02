import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger, postmortem, ptree, stableStringifyJson, untilAborted } from "@oh-my-pi/pi-utils";
import { encodeMessageFrame, MessageFramer } from "../jsonrpc/message-framing";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { resolveSyscallTarget } from "../tools/path-utils";
import { findRepoRoot } from "../capability/fs";
import { getConfig } from "./config";
import { applyWorkspaceEdit, type ExecutedWorkspaceChange } from "./edits";
import { getLspmuxCommand, isLspmuxSupported } from "./lspmux";
import { connectSharedLspTransport } from "./mux/daemon";
import type {
	DocumentBuildStatus,
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
import { detectLanguageId, EquivalentUriMap, fileToUri, readTextFromDisk, uriToFile } from "./utils";

/**
 * A JSON-RPC error response to one of our requests. The message keeps the code, so
 * substring checks such as `isMethodNotFoundError` still match.
 */
export class LspResponseError extends Error {
	constructor(
		readonly code: number | undefined,
		readonly data: unknown,
		message: string,
	) {
		super(`LSP error${code === undefined ? "" : ` ${code}`}: ${message}`);
		this.name = "LspResponseError";
	}
}

/** A request the server did not answer within its timeout; it may still be computing the answer. */
export class LspRequestTimeoutError extends Error {
	constructor(
		readonly method: string,
		readonly timeoutMs: number,
	) {
		super(`LSP request ${method} timed out after ${timeoutMs}ms`);
		this.name = "LspRequestTimeoutError";
	}
}

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
/**
 * URIs whose server overlay OMP has intentionally advanced ahead of the on-disk
 * file for an in-flight write/edit: the writethrough syncs the new (and possibly
 * formatted) text to the language server before committing it to disk, so while
 * a write is pending the file on disk is *older* than the overlay. Refcounted by
 * {@link beginPendingDiskWrite}/{@link endPendingDiskWrite} so overlapping writes
 * to the same file stay marked until the last one commits.
 */
const pendingDiskWrites = new Map<string, number>();

/** Negative cache of recent init failures so a broken server fails fast instead of re-spawning per call. */
const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
const initFailures = new Map<string, { at: number; message: string }>();
const READER_EXIT_GRACE_MS = 100;

// Idle timeout configuration (disabled by default)
let idleTimeoutMs: number | null = null;
let idleCheckInterval: NodeJS.Timeout | null = null;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

// Broker-shared server mode: language servers hosted by the per-project LSP mux
// daemon, one per connection; a released server lingers for reuse while the mux runs.
// The newest hold decides; with none it is off, so embedders and tests that drive
// getOrCreateClient directly never touch the daemon broker. Each process-binding SDK
// session holds it from its `lsp.shared` setting until disposed, then hands it back to
// the previous holder. Only consulted at cold-start, so running clients keep their transport.
interface SharedLspHold {
	enabled: boolean;
}
const sharedLspHolds: SharedLspHold[] = [];

/** Whether a client cold start attaches to a broker-shared language server. */
export function isSharedLspEnabled(): boolean {
	return sharedLspHolds.at(-1)?.enabled ?? false;
}

/** Hold the shared-LSP mode at `enabled` until released; `set` follows later setting changes. */
export function holdSharedLsp(enabled: boolean): { set(enabled: boolean): void; release(): void } {
	const hold: SharedLspHold = { enabled };
	sharedLspHolds.push(hold);
	return {
		set(next) {
			hold.enabled = next;
		},
		release() {
			const index = sharedLspHolds.indexOf(hold);
			if (index !== -1) sharedLspHolds.splice(index, 1);
		},
	};
}

/**
 * Configure the global fallback idle timeout for LSP clients (used in tests/overrides).
 * When unset, each client evaluates against its workspace config (`getConfig(client.cwd).idleTimeoutMs`).
 * @param ms - Timeout in milliseconds, or null/undefined to disable global override
 */
export function setIdleTimeout(ms: number | null | undefined): void {
	idleTimeoutMs = ms ?? null;
	reconcileIdleChecker();
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

function hasConfiguredIdleTimeout(client?: LspClient): boolean {
	if (idleTimeoutMs && idleTimeoutMs > 0) return true;
	if (client) {
		const timeoutMs = getConfig(client.cwd).idleTimeoutMs;
		if (timeoutMs && timeoutMs > 0) return true;
	}
	for (const c of clients.values()) {
		const timeoutMs = getConfig(c.cwd).idleTimeoutMs;
		if (timeoutMs && timeoutMs > 0) return true;
	}
	return false;
}

function maybeStartIdleChecker(client?: LspClient): void {
	if (hasConfiguredIdleTimeout(client)) {
		startIdleChecker();
	}
}

/**
 * Whether the background idle checker interval is currently active.
 * Exported for tests.
 */
export function isIdleCheckerRunning(): boolean {
	return idleCheckInterval !== null;
}

/**
 * Reconcile the background idle checker interval against currently configured timeouts.
 * Starts the checker if any registered client or workspace has a positive timeout,
 * or stops it if none do.
 */
export function reconcileIdleChecker(): void {
	if (hasConfiguredIdleTimeout()) {
		startIdleChecker();
	} else {
		stopIdleChecker();
	}
}

function maybeStopIdleChecker(): void {
	if (!hasConfiguredIdleTimeout()) {
		stopIdleChecker();
	}
}

/**
 * Sweeps all registered LSP clients against their workspace idle timeout.
 * Exported for tests.
 */
export async function checkIdleClients(): Promise<void> {
	const now = Date.now();
	for (const [key, client] of Array.from(clients.entries())) {
		const timeoutMs = idleTimeoutMs ?? getConfig(client.cwd).idleTimeoutMs;
		if (timeoutMs && timeoutMs > 0 && isIdleClient(client, now, timeoutMs)) {
			await shutdownClient(key);
		}
	}
}

function startIdleChecker(): void {
	if (idleCheckInterval) return;
	idleCheckInterval = logger.withoutContext(() =>
		setInterval(() => {
			void checkIdleClients();
		}, IDLE_CHECK_INTERVAL_MS),
	);
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
	const write = Promise.resolve(sink.write(encodeMessageFrame(message)));
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

/** Drain budget for a message written after its caller aborted (see {@link queueWriteMessage}). */
const DELIVER_QUEUED_TIMEOUT_MS = 2_000;

/**
 * Queue `message` behind earlier writes. A `signal` aborted while the message is
 * still queued skips its write, unless `deliverQueued` is set: then the message is
 * written anyway, bounded by {@link DELIVER_QUEUED_TIMEOUT_MS} instead of `signal`,
 * so writes queued after it never overtake it and a server that stops reading stdin
 * is still torn down.
 */
function queueWriteMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
	signal?: AbortSignal,
	deliverQueued = false,
): Promise<void> {
	const write = client.writeQueue
		.catch(() => {})
		.then(() =>
			writeMessage(
				client.proc.stdin,
				message,
				deliverQueued && signal?.aborted ? AbortSignal.timeout(DELIVER_QUEUED_TIMEOUT_MS) : signal,
			),
		);
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
	// Keep the internal queue chained so writes stay serialized, but do not make
	// this caller wait forever behind an earlier wedged write. `writeMessage`
	// observes the same signal once this write reaches the sink; until then the
	// abort race only releases the caller and deliberately leaves the client alive.
	return untilAborted(signal, result);
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

	const framer = new MessageFramer(Buffer.alloc(0));

	let readerFailed = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			framer.push(value);

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
								if (typeof params.version === "number") client.publishesDocumentVersions = true;
							} else if (message.method === "$/progress" && message.params) {
								const params = message.params as { token: string | number; value?: { kind?: string } };
								if (params.value?.kind === "begin") {
									client.activeProgressTokens.add(params.token);
									countFolderLoad(client, -1);
								} else if (params.value?.kind === "end") {
									client.activeProgressTokens.delete(params.token);
									// After a folder add, only progress that began since ends the load.
									if (
										client.activeProgressTokens.size === 0 &&
										!workspaceFolderStates.get(client)?.pendingLoads
									) {
										client.resolveProjectLoaded();
									}
								}
							} else if (message.method === "textDocument/clangd.fileStatus" && message.params) {
								const params = message.params as { uri: string; state?: string };
								const buildStatus = (client.buildStatus ??= new EquivalentUriMap<DocumentBuildStatus>());
								const status = buildStatus.get(params.uri) ?? { busySeq: 0, idleSeq: 0 };
								const seq = (client.buildStatusSeq ?? 0) + 1;
								client.buildStatusSeq = seq;
								if (params.state === "idle") status.idleSeq = seq;
								else status.busySeq = seq;
								buildStatus.set(params.uri, status);
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
								const { code, data } = message.error;
								pending.reject(
									new LspResponseError(
										typeof code === "number" ? code : undefined,
										data,
										message.error.message,
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

/** Workspace folders a client gained after `initialize`. */
interface WorkspaceFolderState {
	/**
	 * Checkouts added to the workspace, as symlink-resolved paths, each with its
	 * `didChangeWorkspaceFolders` delivery. A failed delivery removes its entry.
	 */
	added: Map<string, Promise<void>>;
	/**
	 * Folder-add notifications whose load has not begun: each progress `begin` after an
	 * add starts one, and the project load stays pending while any is left.
	 */
	pendingLoads: number;
	/** The last folder delivery; the next waits for it to settle. */
	lastDelivery: Promise<void>;
}

const workspaceFolderStates = new WeakMap<LspClient, WorkspaceFolderState>();

function workspaceFolder(folder: string): { uri: string; name: string } {
	return { uri: fileToUri(folder), name: path.basename(folder) || "workspace" };
}

/**
 * Build the workspace folder list advertised to the server: the client's root,
 * then every checkout added since. Identical shape for `initialize` params and
 * `workspace/workspaceFolders` server requests.
 */
function currentWorkspaceFolders(client: LspClient): Array<{ uri: string; name: string }> {
	return [client.cwd, ...(workspaceFolderStates.get(client)?.added.keys() ?? [])].map(workspaceFolder);
}

function countFolderLoad(client: LspClient, delta: number): void {
	const state = workspaceFolderStates.get(client);
	if (state) state.pendingLoads = Math.max(0, state.pendingLoads + delta);
}

/** `filePath` with symlinks resolved, a missing tail kept; lexical when it cannot be resolved. */
async function realPathOf(filePath: string): Promise<string> {
	return (await resolveSyscallTarget(filePath, true)) ?? path.resolve(filePath);
}

/**
 * The checkout to add to `client`'s workspace before it opens `filePath`: the one holding
 * the file (symlinks resolved), when it is not the checkout holding the client's root. A
 * server rooted at the session cwd never loads another checkout on its own (rust-analyzer
 * finds no references there), nested worktrees and checkouts included. Only servers that
 * accept `workspace/didChangeWorkspaceFolders` get one.
 */
async function workspaceFolderToAdd(client: LspClient, filePath: string): Promise<string | undefined> {
	if (!client.serverCapabilities?.workspace?.workspaceFolders?.changeNotifications) return undefined;
	const checkout = await findRepoRoot(path.dirname(await realPathOf(filePath)));
	if (!checkout || checkout === (await findRepoRoot(await realPathOf(client.cwd)))) return undefined;
	// A repository at or above the home directory (a dotfiles checkout) would have the
	// server index everything under it.
	if (isPathInsideWorkspace(await realPathOf(os.homedir()), checkout)) return undefined;
	return checkout;
}

/**
 * Add the checkouts holding `filePaths` to `client`'s workspace where the server would
 * otherwise not load them ({@link workspaceFolderToAdd}), in one notification, and return
 * once the server has them. Concurrent callers for one checkout share its delivery, which
 * a caller's abort does not cancel. The server re-indexes, so the client's project-load
 * wait covers that load too.
 */
export async function ensureWorkspaceFolders(
	client: LspClient,
	filePaths: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	const wanted = new Set<string>();
	for (const filePath of filePaths) {
		throwIfAborted(signal);
		const folder = await workspaceFolderToAdd(client, filePath);
		if (folder) wanted.add(folder);
	}
	if (wanted.size === 0) return;
	throwIfAborted(signal);
	let state = workspaceFolderStates.get(client);
	if (!state) {
		state = { added: new Map(), pendingLoads: 0, lastDelivery: Promise.resolve() };
		workspaceFolderStates.set(client, state);
	}
	const folders = state.added;
	const missing = [...wanted].filter(folder => !folders.has(folder));
	if (missing.length > 0) {
		// One delivery at a time, so a failed write rolls back only its own add's load.
		const current = state;
		const delivery = current.lastDelivery.catch(() => {}).then(() => addWorkspaceFolders(client, missing, current));
		delivery.catch(() => {});
		current.lastDelivery = delivery;
		for (const folder of missing) folders.set(folder, delivery);
	}
	await untilAborted(signal, Promise.all([...wanted].map(folder => folders.get(folder))));
}

/** {@link ensureWorkspaceFolders} for one file. */
export function ensureWorkspaceFolder(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	return ensureWorkspaceFolders(client, [filePath], signal);
}

async function addWorkspaceFolders(
	client: LspClient,
	added: readonly string[],
	state: WorkspaceFolderState,
): Promise<void> {
	const undoLoad = restartProjectLoad(client);
	// Progress already running when the add arrives says nothing about the new folders.
	state.pendingLoads++;
	try {
		await sendNotification(
			client,
			"workspace/didChangeWorkspaceFolders",
			{ event: { added: added.map(workspaceFolder), removed: [] } },
			AbortSignal.timeout(WATCHED_FILES_NOTIFY_TIMEOUT_MS),
		);
	} catch (err) {
		for (const folder of added) state.added.delete(folder);
		countFolderLoad(client, -1);
		undoLoad();
		throw err;
	}
	rustAnalyzerReadyClients.delete(client);
}

/** Whether a change to `filePath` concerns `client`: inside its root or a checkout added to it. */
async function clientServesPath(client: LspClient, filePath: string): Promise<boolean> {
	if (isPathInsideWorkspace(filePath, path.resolve(client.cwd))) return true;
	const folders = workspaceFolderStates.get(client)?.added;
	if (!folders?.size) return false;
	const file = await realPathOf(filePath);
	return [...folders.keys()].some(folder => isPathInsideWorkspace(file, folder));
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
			await closeDocument(activeClient, uri, signal);
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

const CLANGD_BASENAME_RE = /^clangd(?:-\d+)?(?:\.exe)?$/i;

/** True when the configured or resolved binary is clangd (`clangd`, `clangd-18`, `clangd.exe`). */
function isClangdConfig(config: ServerConfig): boolean {
	return [config.command, config.resolvedCommand].some(
		command => command !== undefined && CLANGD_BASENAME_RE.test(commandBasename(command)),
	);
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
			if (!(err instanceof LspRequestTimeoutError) || Date.now() >= deadline) {
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

/**
 * Extends a client's pending project-load wait for another load and returns the undo, or
 * `undefined` once the wait has ended.
 */
const projectLoadExtenders = new WeakMap<LspClient, () => (() => void) | undefined>();

/** A project-load wait that the server's progress, its exit, or {@link PROJECT_LOAD_TIMEOUT_MS} ends. */
function createProjectLoad(): {
	signal: Pick<LspClient, "projectLoaded" | "resolveProjectLoaded">;
	extend: () => (() => void) | undefined;
} {
	const { promise, resolve } = Promise.withResolvers<void>();
	let settled = false;
	const finish = () => {
		clearTimeout(timeout);
		settled = true;
		resolve();
	};
	// Auto-resolve after timeout in case server doesn't use progress tokens
	let deadline = Date.now() + PROJECT_LOAD_TIMEOUT_MS;
	let timeout = setTimeout(finish, PROJECT_LOAD_TIMEOUT_MS);
	const rearm = (at: number) => {
		clearTimeout(timeout);
		deadline = at;
		timeout = setTimeout(finish, Math.max(0, at - Date.now()));
	};
	const extend = () => {
		if (settled) return undefined;
		const previous = deadline;
		rearm(Date.now() + PROJECT_LOAD_TIMEOUT_MS);
		return () => {
			if (!settled) rearm(previous);
		};
	};
	return { signal: { projectLoaded: promise, resolveProjectLoaded: finish }, extend };
}

/**
 * Make `client`'s project-load wait cover a load the server just started: a wait still
 * pending keeps its promise (callers already awaiting it see the new load end), an ended
 * one is replaced. Returns the undo for a load that never started.
 */
function restartProjectLoad(client: LspClient): () => void {
	const undo = projectLoadExtenders.get(client)?.() ?? startProjectLoad(client);
	// However the load ends (its progress, the fallback timer, process exit), adds still
	// counted as unstarted belong to it and must not hold up the next one.
	client.projectLoaded.then(() => {
		const state = workspaceFolderStates.get(client);
		if (state) state.pendingLoads = 0;
	});
	return undo;
}

function startProjectLoad(client: LspClient): () => void {
	const next = createProjectLoad();
	Object.assign(client, next.signal);
	projectLoadExtenders.set(client, next.extend);
	return next.signal.resolveProjectLoaded;
}

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
		maybeStartIdleChecker(existingClient);
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
			maybeStartIdleChecker(clientAfterReload);
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
		// Sent in both the mux handshake and `initialize`: a reused shared server
		// answers `initialize` from cache, so the mux keys servers on these options.
		// clangd reports per-document build status only when asked; diagnostics waits use it
		// to tell a finished rebuild from one still running. User options take precedence.
		const initializationOptions = isClangdConfig(config)
			? { clangdFileStatus: true, ...config.initOptions }
			: (config.initOptions ?? {});

		// Wrap with lspmux if available and supported
		const { command, args, env } = isLspmuxSupported(baseCommand)
			? await getLspmuxCommand(baseCommand, baseArgs)
			: { command: baseCommand, args: baseArgs };

		// Prefer the broker-shared server unless an external lspmux wrapper is
		// already multiplexing this command. Any shared-path failure falls back
		// to a private spawn so LSP never regresses on broker trouble.
		let proc: LspTransport | null = null;
		if (isSharedLspEnabled() && command === baseCommand) {
			proc = await connectSharedLspTransport({ command, args, cwd, env, initializationOptions, signal });
		}
		proc ??= ptree.spawn([command, ...args], {
			cwd,
			stdin: "pipe",
			env: env ? { ...Bun.env, ...env } : undefined,
		});

		const projectLoad = createProjectLoad();
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
			isReading: false,
			status: "connecting",
			lastActivity: Date.now(),
			startedAt: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			...projectLoad.signal,
		};
		projectLoadExtenders.set(client, projectLoad.extend);

		// Register crash recovery - remove client on process exit
		proc.exited.then(() => {
			if (clients.get(key) === client) clients.delete(key);
			maybeStopIdleChecker();
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

		// Start background message reader. The client is shared by every session
		// in the process, so its reader's records name none of them.
		logger.withoutContext(() => startMessageReader(client));

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
					initializationOptions,
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
			maybeStartIdleChecker(client);
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
 * Signature of the document text last handed to the server, used to detect when
 * disk contents have diverged (e.g. an external edit) from the server's copy.
 */
function documentSignature(content: string): number | bigint {
	return Bun.hash(content);
}

/**
 * Mark a file whose server overlay OMP has advanced ahead of disk for an in-flight
 * write. While marked, {@link reconcileFileFromDisk} skips reading disk back into
 * the server, because the on-disk file is the *stale* side until the write commits.
 * Every call MUST be balanced by {@link endPendingDiskWrite}.
 */
export function beginPendingDiskWrite(filePath: string): void {
	const uri = fileToUri(filePath);
	pendingDiskWrites.set(uri, (pendingDiskWrites.get(uri) ?? 0) + 1);
}

/** Release a mark set by {@link beginPendingDiskWrite}; the overlay is authoritative until then. */
export function endPendingDiskWrite(filePath: string): void {
	const uri = fileToUri(filePath);
	const count = pendingDiskWrites.get(uri);
	if (count === undefined) return;
	if (count > 1) {
		pendingDiskWrites.set(uri, count - 1);
	} else {
		pendingDiskWrites.delete(uri);
	}
}

/**
 * Open documents no OMP operation has used for this long are closed before the next
 * document opens. A server keeps the project of every open document loaded, and a
 * TypeScript server drops a project whose documents are all closed when it handles
 * the next open.
 */
const OPEN_FILE_IDLE_MS = 5 * 60 * 1000;

/**
 * Close documents no OMP operation has used within {@link OPEN_FILE_IDLE_MS}. Overlays
 * ahead of disk and documents mid-open, sync or refresh stay open. Each close is queued
 * before the caller's didOpen and is written even if the caller aborts first, so the
 * server always sees the close a later reopen assumes. Its drain is bounded by `signal`,
 * or by its own timeout once `signal` aborted before the write, so a server that stops
 * reading stdin is torn down as it would be for that didOpen.
 */
function closeIdleFiles(client: LspClient, signal?: AbortSignal): void {
	const idleBefore = Date.now() - OPEN_FILE_IDLE_MS;
	for (const [uri, info] of client.openFiles) {
		if (info.lastUsedAt > idleBefore) continue;
		if (pendingDiskWrites.has(uri) || fileOperationLocks.has(`${client.name}:${uri}`)) continue;
		client.openFiles.delete(uri);
		client.diagnostics.delete(uri);
		(client.idleClosedFiles ??= new Map()).set(uri, info.version);
		const notification: LspJsonRpcNotification = {
			jsonrpc: "2.0",
			method: "textDocument/didClose",
			params: { textDocument: { uri } },
		};
		// A failed write means the client is torn down or its process is gone.
		void queueWriteMessage(client, notification, signal, true).catch(() => {});
	}
}

/**
 * Track a document the server just opened at `version`. A document OMP closed
 * (for idleness, or to reopen it for diagnostics) is marked reopened, so diagnostics
 * waits treat the empty publish that cleared its earlier life as provisional.
 */
function trackOpenedFile(client: LspClient, uri: string, languageId: string, version: number, content: string): void {
	const reopened = client.idleClosedFiles?.delete(uri) === true;
	client.openFiles.set(uri, {
		version,
		languageId,
		syncedHash: documentSignature(content),
		lastUsedAt: Date.now(),
		reopenedAt: reopened ? Date.now() : undefined,
	});
	client.lastActivity = Date.now();
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
	const openFile = client.openFiles.get(uri);
	if (openFile) {
		openFile.lastUsedAt = Date.now();
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
			content = await readTextFromDisk(filePath);
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		await ensureWorkspaceFolder(client, filePath, signal);
		const languageId = client.config.languageId ?? detectLanguageId(filePath);
		throwIfAborted(signal);

		closeIdleFiles(client, signal);
		const version = (client.idleClosedFiles?.get(uri) ?? 0) + 1;
		await sendNotification(
			client,
			"textDocument/didOpen",
			{
				textDocument: {
					uri,
					languageId,
					version,
					text: content,
				},
			},
			signal,
		);

		trackOpenedFile(client, uri, languageId, version, content);
	})();

	fileOperationLocks.set(lockKey, openPromise);
	try {
		await openPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Reconcile an already-open document with current disk contents before a semantic query.
 *
 * {@link ensureFileOpen} opens an untracked file but no-ops when the URI is already
 * open, so an external edit — one not routed through OMP's write/edit tools, which
 * announce their changes via {@link notifyWorkspaceWatchedFiles}/{@link refreshFile} —
 * leaves the server holding the pre-edit document while callers compute query
 * positions from disk. This reads the file and, when its contents diverge from the
 * text last sent to the server, pushes a `didChange` so the server's copy matches
 * the disk text the position was derived from. Untracked files fall through to
 * {@link ensureFileOpen}; unchanged files send nothing; a tracked file gone from
 * disk is closed so the server stops answering for it.
 * Returns `true` when the caller should wait for fresh diagnostics because the stale
 * ones were dropped: a `didChange` was pushed for a reconciled overlay, or a document
 * closed for idleness was reopened.
 * A file with an in-flight OMP write ({@link beginPendingDiskWrite}) is skipped
 * entirely: its overlay leads disk, so reading disk back would revert the server
 * to pre-write content.
 */
export async function reconcileFileFromDisk(
	client: LspClient,
	filePath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const openFile = client.openFiles.get(uri);
	if (!openFile) {
		const reopening = client.idleClosedFiles?.has(uri) === true;
		await ensureFileOpen(client, filePath, signal);
		return reopening && client.openFiles.has(uri);
	}
	openFile.lastUsedAt = Date.now();

	// An in-flight OMP write has already synced newer (possibly formatted) text to
	// the server ahead of committing it to disk; the on-disk file is the stale side,
	// so reconciling from it would clobber the overlay. Leave it to the write.
	if (pendingDiskWrites.has(uri)) {
		return false;
	}

	const lockKey = `${client.name}:${uri}`;
	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	let didChange = false;
	const reconcilePromise = (async () => {
		throwIfAborted(signal);
		const info = client.openFiles.get(uri);
		if (!info) {
			await ensureFileOpen(client, filePath, signal);
			return;
		}

		let content: string;
		try {
			content = await readTextFromDisk(filePath);
			throwIfAborted(signal);
		} catch (err) {
			if (!isEnoent(err)) throw err;
			// Deleted outside OMP; a write that started meanwhile owns the overlay instead.
			if (!pendingDiskWrites.has(uri)) await closeDocument(client, uri, signal);
			return;
		}

		// Re-check after the (awaited) disk read: a write may have started and
		// synced its overlay in the meantime, making this disk snapshot stale.
		if (pendingDiskWrites.has(uri)) return;
		const signature = documentSignature(content);
		if (signature === info.syncedHash) return;

		// Drop cached diagnostics computed against the stale document before the
		// server recomputes them for the reconciled content.
		client.diagnostics.delete(uri);
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
		info.syncedHash = signature;
		client.lastActivity = Date.now();
		didChange = true;
	})();

	fileOperationLocks.set(lockKey, reconcilePromise);
	try {
		await reconcilePromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
	return didChange;
}

/**
 * Reconciles every document the client holds open against disk.
 *
 * A project-wide request answers with ranges for every file it touches. An
 * already-open consumer that was edited outside OMP keeps a stale overlay, so
 * the server's ranges still point at the old text — applying them to the
 * current disk text writes the new identifier into the wrong lines while the
 * request reports success (#15772). Reconciling only the requested target
 * leaves those consumers stale, so sync all open documents first.
 *
 * Files with an in-flight OMP write are skipped by
 * {@link reconcileFileFromDisk} (their overlay leads disk), unchanged files
 * send nothing, and `excludeUri` is left for the caller to sync. Returns the
 * number of documents that were re-synced.
 */
export async function reconcileOpenFilesFromDisk(
	client: LspClient,
	signal?: AbortSignal,
	excludeUri?: string,
): Promise<number> {
	let reconciled = 0;
	for (const uri of Array.from(client.openFiles.keys())) {
		if (uri === excludeUri || !uri.startsWith("file://")) continue;
		if (await reconcileFileFromDisk(client, uriToFile(uri), signal)) reconciled++;
	}
	return reconciled;
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
			throwIfAborted(signal);
			closeIdleFiles(client, signal);
			// Open file with provided content instead of reading from disk
			await ensureWorkspaceFolder(client, filePath, signal);
			const languageId = client.config.languageId ?? detectLanguageId(filePath);
			const version = (client.idleClosedFiles?.get(uri) ?? 0) + 1;
			await sendNotification(
				client,
				"textDocument/didOpen",
				{
					textDocument: {
						uri,
						languageId,
						version,
						text: content,
					},
				},
				signal,
			);
			trackOpenedFile(client, uri, languageId, version, content);
			return;
		}

		info.lastUsedAt = Date.now();
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
		info.syncedHash = documentSignature(content);
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
 * Whether the server opted into full text on `didSave`
 * (`textDocumentSync.save.includeText`); otherwise it already has the text from didChange.
 */
function saveIncludesText(client: LspClient): boolean {
	const sync = client.serverCapabilities?.textDocumentSync;
	const save = typeof sync === "object" && sync !== null && "save" in sync ? sync.save : undefined;
	return typeof save === "object" && save !== null && "includeText" in save && save.includeText === true;
}

/**
 * Notify LSP that a file was saved.
 * Assumes content was already synced via syncContent; the saved text is read
 * back only for servers that asked for it.
 */
export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath);
	const info = client.openFiles.get(uri);
	if (!info) return; // File not open, nothing to notify
	info.lastUsedAt = Date.now();

	throwIfAborted(signal);
	const text = saveIncludesText(client) ? await Bun.file(filePath).text() : undefined;
	throwIfAborted(signal);
	await sendNotification(
		client,
		"textDocument/didSave",
		text === undefined ? { textDocument: { uri } } : { textDocument: { uri }, text },
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
 * Created or deleted files can change module resolution for otherwise untouched
 * open documents, so those overlays are refreshed after the watcher notification.
 * This also covers sibling files that are not open text documents, such as generated
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
			const served = await Promise.all(changes.map(change => clientServesPath(client, change.filePath)));
			const clientChanges = changes
				.filter((_change, index) => served[index])
				.map(change => {
					const uri = fileToUri(change.filePath);
					// Keep a report echoing the open document's version only while OMP's own
					// write is in flight: the writethrough synced the overlay before writing, so
					// the report already answers the new disk text, and a publish that beat this
					// notification must not be lost. Any other write (the ACP bridge, for one)
					// leaves the overlay on the old text, so its report is stale.
					const published = client.diagnostics.get(uri);
					const current =
						change.type === FileChangeType.Changed &&
						pendingDiskWrites.has(uri) &&
						published !== undefined &&
						published.version === client.openFiles.get(uri)?.version;
					if (!current) client.diagnostics.delete(uri);
					return { uri, type: change.type };
				});
			if (clientChanges.length === 0) return;
			await sendNotification(client, "workspace/didChangeWatchedFiles", { changes: clientChanges }, sendSignal);
			if (clientChanges.every(change => change.type === FileChangeType.Changed)) return;
			await refreshOpenFiles(client, sendSignal);
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
 * Increments version, sends didChange and didSave notifications; closes a tracked
 * document whose file is gone from disk.
 */
export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	await refreshDocument(client, filePath, "use", signal);
}

/**
 * Close and reopen a document from disk. A push server need not republish diagnostics
 * for an identical-text didChange (clangd does not), but recomputes them on open, picking
 * up changed dependencies whether or not OMP has them open. A save follows the open for
 * servers that validate on save.
 */
export async function reopenFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	await refreshDocument(client, filePath, "reopen", signal);
}

/**
 * Make clangd rebuild an open document from disk and publish its diagnostics. Resolves
 * `true` when it sent the rebuild, so the report for the document's current version is
 * final only once clangd's build status settles (see `waitForRebuiltDiagnostics`); `false`
 * when it opened the document instead, or left it to an in-flight OMP write.
 */
export async function rebuildFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<boolean> {
	return await refreshDocument(client, filePath, "rebuild", signal);
}

/**
 * Re-send every open document after a change that can alter how it resolves. This is
 * not a use: idle documents keep aging, and documents closed meanwhile stay closed.
 */
export async function refreshOpenFiles(client: LspClient, signal?: AbortSignal): Promise<void> {
	await Promise.all(
		Array.from(client.openFiles.keys(), uri => refreshDocument(client, uriToFile(uri), "resync", signal)),
	);
}

/** Resolves whether a `rebuild` sent its changes. */
async function refreshDocument(
	client: LspClient,
	filePath: string,
	purpose: "use" | "resync" | "reopen" | "rebuild",
	signal?: AbortSignal,
): Promise<boolean> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	let rebuilt = false;
	const refreshPromise = (async () => {
		throwIfAborted(signal);
		// A pending OMP write's overlay leads disk; reopening or rebuilding from disk would revert it.
		const fromDisk = purpose === "reopen" || purpose === "rebuild";
		if (fromDisk && pendingDiskWrites.has(uri)) return;
		// Drop cached diagnostics for this URI before asking the server to recompute.
		// Otherwise an unrelated publishDiagnostics notification can advance the global
		// diagnostics version and cause waiters to accept stale unversioned diagnostics.
		client.diagnostics.delete(uri);
		const info = client.openFiles.get(uri);

		if (!info) {
			if (purpose !== "resync") await ensureFileOpen(client, filePath, signal);
			return;
		}
		if (purpose !== "resync") info.lastUsedAt = Date.now();

		let content: string;
		try {
			content = await readTextFromDisk(filePath);
			throwIfAborted(signal);
		} catch (err) {
			if (!isEnoent(err)) throw err;
			// The file is gone; a pending write's overlay still leads disk (new file not yet committed).
			if (!pendingDiskWrites.has(uri)) await closeDocument(client, uri, signal);
			return;
		}
		if (fromDisk && pendingDiskWrites.has(uri)) return;
		const version = ++info.version;
		throwIfAborted(signal);

		if (purpose === "reopen") {
			await closeDocument(client, uri, signal);
			// Record the close like an idle close: a reopen cut short by cancellation resumes
			// this version, and waits treat the empty publish clearing the old document as
			// provisional.
			(client.idleClosedFiles ??= new Map()).set(uri, version);
			await sendNotification(
				client,
				"textDocument/didOpen",
				{ textDocument: { uri, languageId: info.languageId, version, text: content } },
				signal,
			);
			trackOpenedFile(client, uri, info.languageId, version, content);
			await sendNotification(
				client,
				"textDocument/didSave",
				saveIncludesText(client) ? { textDocument: { uri }, text: content } : { textDocument: { uri } },
				signal,
			);
			return;
		}

		if (purpose === "rebuild") {
			// clangd neither rebuilds nor republishes for a didChange carrying the text it
			// already has. A detour through one more trailing newline makes it rebuild the
			// main file, re-checking its headers on disk, and publish for the restored text.
			// Both changes must ask for diagnostics, or clangd drops the detour as superseded
			// and the restored text then matches what it already has.
			const detour = `${content}\n`;
			await sendNotification(
				client,
				"textDocument/didChange",
				{ textDocument: { uri, version }, contentChanges: [{ text: detour }], wantDiagnostics: true },
				signal,
			);
			info.syncedHash = documentSignature(detour);
			const restored = ++info.version;
			await sendNotification(
				client,
				"textDocument/didChange",
				{ textDocument: { uri, version: restored }, contentChanges: [{ text: content }], wantDiagnostics: true },
				signal,
			);
			info.syncedHash = documentSignature(content);
			client.lastActivity = Date.now();
			rebuilt = true;
			return;
		}

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
			saveIncludesText(client) ? { textDocument: { uri }, text: content } : { textDocument: { uri } },
			signal,
		);

		info.syncedHash = documentSignature(content);
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, refreshPromise);
	try {
		await refreshPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
	return rebuilt;
}

/**
 * Send `didClose` for a tracked document and forget it.
 *
 * Servers treat an open document as authoritative over disk, so a file deleted while
 * open keeps contributing references, rename edits and diagnostics until it is closed.
 */
async function closeDocument(client: LspClient, uri: string, signal?: AbortSignal): Promise<void> {
	await sendNotification(client, "textDocument/didClose", { textDocument: { uri } }, signal);
	client.openFiles.delete(uri);
	client.diagnostics.delete(uri);
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
	maybeStopIdleChecker();

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
	if (!exited && !clients.has(client.name)) {
		clients.set(client.name, client);
		maybeStartIdleChecker(client);
	}
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
	const started = Date.now();
	try {
		return await sendRequestOnce(client, method, params, signal, timeoutMs);
	} catch (err) {
		// A server indexing a checkout added with didChangeWorkspaceFolders cancels
		// requests with ContentModified (-32801); LSP asks clients to retry them. A
		// command is never re-run: the server may have acted on it before cancelling.
		const contentModified = err instanceof Error && err.message.startsWith("LSP error -32801");
		if (!contentModified || method === "workspace/executeCommand" || !workspaceFolderStates.get(client)?.added.size) {
			throw err;
		}
		// The retry spends what is left of the first attempt's budget, the default included.
		const budget = timeoutMs ?? (signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS);
		const deadline = budget === undefined ? undefined : started + budget;
		const deadlineReached = Promise.withResolvers<void>();
		const deadlineTimer =
			deadline === undefined ? undefined : setTimeout(deadlineReached.resolve, Math.max(0, deadline - Date.now()));
		try {
			await untilAborted(signal, Promise.race([client.projectLoaded, deadlineReached.promise]));
		} finally {
			clearTimeout(deadlineTimer);
		}
		if (deadline !== undefined && Date.now() >= deadline) throw err;
		return await sendRequestOnce(
			client,
			method,
			params,
			signal,
			deadline === undefined ? undefined : deadline - Date.now(),
		);
	}
}

function sendRequestOnce(
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
				const err = new LspRequestTimeoutError(method, effectiveTimeoutMs);
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
