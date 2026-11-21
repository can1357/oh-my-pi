/**
 * `lsp` daemon module: shared language-server processes.
 *
 * One unit is one language-server process, keyed by its server identity
 * (`muxServerKey`) plus an instance index, scoped to the project of its
 * canonical cwd. A server is handed to a new client only while no session is
 * attached to it: {@link LSP_ACQUIRE_METHOD} reserves the first free instance
 * key, the client `open`s it and `attach`es with the reservation token. Each
 * tunnel speaks Content-Length-framed LSP JSON-RPC; the unit remaps request
 * ids per session, answers `initialize` from cache for later sessions,
 * replays diagnostics/registrations/progress, closes a session's documents
 * when it detaches, and forwards watched-file changes it observes itself.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isRecord, logger, settleWithin } from "@oh-my-pi/pi-utils";
import { encodeMessageFrame, MessageFramer } from "../../jsonrpc/message-framing";
import {
	LSP_ACQUIRE_METHOD,
	LSP_MODULE_KIND,
	LSP_MODULE_VERSION,
	LSP_UNRESERVE_METHOD,
	type LspAcquireResult,
	lspInstanceKey,
	MUX_RESTART_METHOD,
	MUX_SERVER_EXIT_STDERR_BYTES,
	MUX_SERVER_EXITED_METHOD,
	type MuxServerExit,
	muxServerKey,
} from "../../lsp/mux/protocol";
import type { LspJsonRpcId, LspJsonRpcNotification, LspJsonRpcRequest, LspJsonRpcResponse } from "../../lsp/types";
import { uriToFile } from "../../lsp/utils";
import { advertisesWatchedFiles, WATCHED_FILES_METHOD, WatchedFilesForwarder } from "../../lsp/watched-files";
import type {
	DaemonModule,
	ManagedChild,
	ManagedChildState,
	ModuleClient,
	ModuleContext,
	ModuleTunnel,
	ModuleUnit,
} from "../module";
import { projectScope, scopeKey, type UnitPolicy, type UnitScope } from "../protocol";

/** Grace after the last lease before an unused server is stopped. */
const SERVER_LINGER_MS = 5 * 60 * 1_000;
const SHUTDOWN_BUDGET_MS = 2_000;
const KILL_GRACE_MS = 2_000;
/** How long a tunnel told its server exited may stay open to flush before the unit closes it. */
const EXITED_LINK_CLOSE_MS = 2_000;
/** How long an acquired instance key stays reserved for the attach that follows. */
const RESERVATION_MS = 30_000;

const LSP_POLICY: UnitPolicy = {
	hold: "leases",
	idleMs: SERVER_LINGER_MS,
	onIdle: "stop",
	restart: "no",
	survive: "exec",
};

type RpcMessage = LspJsonRpcRequest | LspJsonRpcResponse | LspJsonRpcNotification;

interface ForwardedRequest {
	session?: Session;
	originalId?: LspJsonRpcId;
	drop?: boolean;
	initialize?: boolean;
	resolveInternal?: () => void;
}

interface ClientRequestPending {
	relay: boolean;
	serverId?: LspJsonRpcId;
}

interface Registration {
	id: string;
	[key: string]: unknown;
}

interface RegistrationBatch {
	registrations: Registration[];
}

const ServerParams = type({
	command: "string",
	args: "string[]",
	cwd: "string",
	"env?": "Record<string, string>",
	"initializationOptions?": "unknown",
});
const UnitParams = type({
	command: "string",
	args: "string[]",
	cwd: "string",
	"env?": "Record<string, string>",
	"initializationOptions?": "unknown",
	spawnEnv: "Record<string, string>",
});
const UnreserveParams = type({ scope: { kind: "'project'", dir: "string" }, key: "string", token: "string" });
/** Every validated params value keeps its undeclared keys: messages are forwarded and replayed as received. */
const DocumentParams = type({ textDocument: { uri: "string", version: "number" } });
const UriParams = type({ textDocument: { uri: "string" } });
const DiagnosticsParams = type({ uri: "string" });
const ProgressParams = type({ token: "string | number", "value?": "Record<string, unknown>" });
type DiagnosticsParams = typeof DiagnosticsParams.infer;
type ProgressParams = typeof ProgressParams.infer;

/** Re-exec state of one unit, from {@link LspServerUnit.snapshot}. */
interface LspUnitState {
	child: ManagedChildState;
	slot: string;
	cwd: string;
	label: string;
	initializeResult: unknown;
	initializeCached: boolean;
	initializedSent: boolean;
	registrations: RegistrationBatch[];
	diagnostics: DiagnosticsParams[];
	progress: ProgressParams[];
	/** Documents sessions left open; closed on restore since those sessions are gone. */
	documents: string[];
	/** Workspace folders sessions added; removed on restore. */
	workspaceFolders: unknown[];
	watchFiles: boolean;
	nextId: number;
	nextClientId: number;
	stderrTail: string;
	/** Base64 of server stdout bytes not yet framed. */
	pending: string;
}

interface Reservation {
	token: string;
	connectionId: string;
	timer: NodeJS.Timeout;
}

/** Instance keys handed out by `acquire` and not yet attached, by {@link slotKey}. */
const reservations = new Map<string, Reservation>();

function slotKey(scope: UnitScope, key: string): string {
	return `${scopeKey(scope)}\0${key}`;
}

function releaseReservation(slot: string, token?: string, connectionId?: string): void {
	const reservation = reservations.get(slot);
	if (!reservation || (token !== undefined && reservation.token !== token)) return;
	if (connectionId !== undefined && reservation.connectionId !== connectionId) return;
	clearTimeout(reservation.timer);
	reservations.delete(slot);
}

class Session {
	readonly tunnel: ModuleTunnel;
	readonly framer = new MessageFramer(Buffer.alloc(0));
	readonly openUris = new Set<string>();
	/** Workspace folders this session added; removed from the server when the session leaves. */
	readonly workspaceFolders = new Map<string, unknown>();
	readonly forwardedIds = new Map<LspJsonRpcId, LspJsonRpcId>();
	readonly pendingClientRequests = new Map<string, ClientRequestPending>();
	initialized = false;
	closed = false;
	lastActivity = Date.now();

	constructor(tunnel: ModuleTunnel) {
		this.tunnel = tunnel;
	}

	send(message: RpcMessage): void {
		if (!this.closed) this.tunnel.send(encodeMessageFrame(message));
	}
}

function hasMethod(message: RpcMessage): message is LspJsonRpcRequest | LspJsonRpcNotification {
	return "method" in message && typeof message.method === "string";
}

function hasRequestId(message: LspJsonRpcRequest | LspJsonRpcNotification): message is LspJsonRpcRequest {
	return "id" in message && (typeof message.id === "number" || typeof message.id === "string");
}

function rpcResult(id: LspJsonRpcId, result: unknown): LspJsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: LspJsonRpcId, code: number, message: string): LspJsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseRpc(text: string): RpcMessage {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") throw new Error("invalid JSON-RPC message");
	return parsed as unknown as RpcMessage;
}

async function canonicalDir(dir: string): Promise<string> {
	const resolved = path.resolve(dir);
	try {
		return await fs.realpath(resolved);
	} catch {
		return resolved;
	}
}

interface LspServerUnitOptions {
	child: ManagedChild;
	slot: string;
	cwd: string;
	label: string;
	restored?: LspUnitState;
}

/** One shared language-server process and the sessions attached to it. */
class LspServerUnit implements ModuleUnit {
	readonly label: string;
	readonly ready = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	readonly #child: ManagedChild;
	readonly #slot: string;
	/** The server's working directory; plain relative watch globs resolve against it. */
	readonly #cwd: string;
	readonly #sessions = new Set<Session>();
	readonly #documents = new Set<string>();
	readonly #diagnostics = new Map<string, DiagnosticsParams>();
	#registrations: RegistrationBatch[] = [];
	readonly #progress = new Map<string | number, ProgressParams>();
	readonly #pending = new Map<LspJsonRpcId, ForwardedRequest>();
	readonly #initializeWaiters = new Map<Session, LspJsonRpcId>();
	readonly #framer: MessageFramer;
	#initializeResult: unknown = undefined;
	#initializeCached = false;
	#initializeInFlight = false;
	#initializedSent = false;
	#nextId = 1;
	#nextClientId = 1;
	#stopping = false;
	#gone = false;
	#stopReason?: string;
	#stderrTail = "";
	/** Frame announcing the server's exit; set once it exited. */
	#exitFrame?: Buffer;
	/**
	 * Watches for the server's `workspace/didChangeWatchedFiles` registrations, for every
	 * attached session at once; created when the initialize asked the server to hand watching over.
	 */
	#watchedFiles?: WatchedFilesForwarder;

	constructor(options: LspServerUnitOptions) {
		this.#child = options.child;
		this.#slot = options.slot;
		this.#cwd = options.cwd;
		this.label = options.label;
		const restored = options.restored;
		this.#framer = new MessageFramer(restored ? Buffer.from(restored.pending, "base64") : Buffer.alloc(0));
		if (restored) this.#restoreState(restored);
		this.#child.onStdout(chunk => this.#fromServerBytes(chunk));
		this.#child.onStderr(chunk => {
			this.#stderrTail = (this.#stderrTail + Buffer.from(chunk).toString("utf-8")).slice(
				-MUX_SERVER_EXIT_STDERR_BYTES,
			);
		});
		this.exited = this.#child.exited.then(
			exit => {
				const code = exit.exitCode ?? -1;
				this.#serverExited(code);
				return {
					exitCode: exit.exitCode,
					reason: this.#stopReason ?? (exit.signal !== undefined ? `signal ${exit.signal}` : undefined),
				};
			},
			error => {
				this.#serverExited(-1);
				return { reason: String(error) };
			},
		);
	}

	/** Free for a new client: nothing attached and the process is not going away. */
	get available(): boolean {
		return this.#sessions.size === 0 && !this.#stopping && !this.#gone;
	}

	pids(): number[] {
		return [this.#child.pid];
	}

	busy(): boolean {
		return this.#sessions.size > 0;
	}

	attach(tunnel: ModuleTunnel, channel: string | undefined): void {
		releaseReservation(this.#slot, channel);
		const session = new Session(tunnel);
		if (this.#gone) {
			tunnel.start(
				() => {},
				() => {},
			);
			if (this.#exitFrame) tunnel.send(this.#exitFrame);
			tunnel.close();
			return;
		}
		this.#sessions.add(session);
		tunnel.start(
			chunk => this.#fromSessionBytes(session, chunk),
			() => this.#closeSession(session),
		);
	}

	async stop(reason: string): Promise<void> {
		this.#stopReason ??= reason;
		if (!this.#gone && !this.#stopping) {
			this.#stopping = true;
			await this.#shutdownGracefully();
		}
		this.#stopping = true;
		if (!this.#gone) this.#child.kill();
		const timer = setTimeout(() => {
			if (!this.#gone) this.#child.kill("SIGKILL");
		}, KILL_GRACE_MS);
		try {
			await this.exited;
		} finally {
			clearTimeout(timer);
		}
	}

	snapshot(): LspUnitState {
		const workspaceFolders: unknown[] = [];
		for (const session of this.#sessions) workspaceFolders.push(...session.workspaceFolders.values());
		return {
			child: this.#child.state(),
			slot: this.#slot,
			cwd: this.#cwd,
			label: this.label,
			initializeResult: this.#initializeResult,
			initializeCached: this.#initializeCached,
			initializedSent: this.#initializedSent,
			registrations: this.#registrations,
			diagnostics: [...this.#diagnostics.values()],
			progress: [...this.#progress.values()],
			documents: [...this.#documents],
			workspaceFolders,
			watchFiles: this.#watchedFiles !== undefined,
			nextId: this.#nextId,
			nextClientId: this.#nextClientId,
			stderrTail: this.#stderrTail,
			pending: this.#framer.remainder().toString("base64"),
		};
	}

	/** Adopt re-exec state; the sessions it belonged to are gone, so their documents and folders are released. */
	#restoreState(state: LspUnitState): void {
		this.#initializeResult = state.initializeResult;
		this.#initializeCached = state.initializeCached;
		this.#initializedSent = state.initializedSent;
		this.#registrations = state.registrations;
		for (const params of state.diagnostics) this.#diagnostics.set(params.uri, params);
		for (const params of state.progress) this.#progress.set(params.token, params);
		this.#nextId = state.nextId;
		this.#nextClientId = state.nextClientId;
		this.#stderrTail = state.stderrTail;
		if (state.watchFiles) {
			this.#watchedFiles = this.#createWatchedFiles();
			for (const batch of this.#registrations) {
				for (const registration of batch.registrations) {
					if (registration.method === WATCHED_FILES_METHOD) {
						void this.#watchedFiles.register(registration.id, registration.registerOptions);
					}
				}
			}
		}
		for (const uri of state.documents) {
			this.#writeServer({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } });
		}
		if (state.workspaceFolders.length > 0) {
			this.#writeServer({
				jsonrpc: "2.0",
				method: "workspace/didChangeWorkspaceFolders",
				params: { event: { added: [], removed: state.workspaceFolders } },
			});
		}
	}

	#muxId(): number {
		return this.#nextId++;
	}

	#clientId(): string {
		return `mux:${this.#nextClientId++}`;
	}

	#fromSessionBytes(session: Session, chunk: Uint8Array): void {
		try {
			session.framer.push(chunk);
			for (const text of session.framer.drain(header => {
				logger.warn("LSP client framing resync", { header: header.slice(0, 200) });
			})) {
				let message: RpcMessage;
				try {
					message = parseRpc(text);
				} catch (error) {
					logger.warn("LSP client sent malformed JSON", { error: String(error) });
					continue;
				}
				try {
					this.#fromSession(session, message);
				} catch (error) {
					logger.warn("LSP client message handling failed", { error: String(error) });
				}
			}
		} catch (error) {
			logger.warn("LSP client framing failed", { error: String(error) });
			session.tunnel.close();
			this.#closeSession(session);
		}
	}

	#fromSession(session: Session, message: RpcMessage): void {
		if (session.closed) return;
		session.lastActivity = Date.now();
		if (!hasMethod(message)) {
			this.#handleClientResponse(session, message);
			return;
		}
		const request = hasRequestId(message);
		switch (message.method) {
			case MUX_RESTART_METHOD:
				if (!request) {
					this.#stopReason ??= "restart requested";
					this.#killServer();
					return;
				}
				break;
			case "initialize":
				if (request) {
					this.#initialize(session, message);
					return;
				}
				break;
			case "initialized":
				if (!request) {
					if (!this.#initializedSent) {
						this.#initializedSent = true;
						this.#writeServer(message);
					} else {
						this.#replayState(session);
					}
					session.initialized = true;
					return;
				}
				break;
			case "shutdown":
				// A session's shutdown leaves the process running for reuse.
				if (request) {
					session.send(rpcResult(message.id, null));
					return;
				}
				break;
			case "exit":
				if (!request) {
					session.tunnel.close();
					this.#closeSession(session);
					return;
				}
				break;
			case "textDocument/didOpen":
				if (!request) {
					const params = DocumentParams(message.params);
					if (params instanceof type.errors) return;
					session.openUris.add(params.textDocument.uri);
					this.#documents.add(params.textDocument.uri);
					this.#writeServer(message);
					return;
				}
				break;
			case "textDocument/didClose":
				if (!request) {
					const params = UriParams(message.params);
					if (params instanceof type.errors) return;
					session.openUris.delete(params.textDocument.uri);
					// Safe to forward: a server is handed out only while no session is attached,
					// so no other session holds an overlay of this document on this server.
					this.#documents.delete(params.textDocument.uri);
					this.#writeServer(message);
					return;
				}
				break;
			case "workspace/didChangeWorkspaceFolders":
				if (!request) {
					this.#trackWorkspaceFolders(session, message);
					void this.#watchedFiles?.refresh();
					this.#writeServer(message);
					return;
				}
				break;
			case WATCHED_FILES_METHOD:
				if (!request) {
					// A client reporting its own writes: the unit's watcher skips echoing them.
					this.#watchedFiles?.announced(message.params);
					this.#writeServer(message);
					return;
				}
				break;
			case "$/cancelRequest":
				if (!request) {
					if (!isRecord(message.params)) return;
					const originalId = message.params.id;
					if (typeof originalId !== "string" && typeof originalId !== "number") return;
					const muxId = session.forwardedIds.get(originalId);
					if (muxId !== undefined) this.#writeServer({ ...message, params: { ...message.params, id: muxId } });
					return;
				}
				break;
		}
		if (request) {
			const muxId = this.#muxId();
			this.#pending.set(muxId, { session, originalId: message.id });
			session.forwardedIds.set(message.id, muxId);
			this.#writeServer({ ...message, id: muxId });
			return;
		}
		this.#writeServer(message);
	}

	#initialize(session: Session, message: LspJsonRpcRequest): void {
		if (this.#initializeCached) {
			session.send(rpcResult(message.id, this.#initializeResult));
			return;
		}
		this.#initializeWaiters.set(session, message.id);
		if (this.#initializeInFlight) return;
		this.#initializeInFlight = true;
		const muxId = this.#muxId();
		this.#pending.set(muxId, { initialize: true });
		// Language servers commonly self-terminate with their advertised client pid; the
		// daemon keeps its pid across re-execs, so it outlives every session.
		const params = isRecord(message.params)
			? { ...message.params, processId: process.pid }
			: { processId: process.pid };
		// The server hands watching to the client only when asked to, so the unit
		// (the server's process owner) watches only then.
		if (advertisesWatchedFiles(params)) this.#watchedFiles ??= this.#createWatchedFiles();
		this.#writeServer({ ...message, id: muxId, params });
	}

	#createWatchedFiles(): WatchedFilesForwarder {
		return new WatchedFilesForwarder({
			roots: () => [
				this.#cwd,
				...[...this.#sessions].flatMap(session =>
					[...session.workspaceFolders.keys()].map(folderUri => uriToFile(folderUri)),
				),
			],
			send: changes => this.#writeServer({ jsonrpc: "2.0", method: WATCHED_FILES_METHOD, params: { changes } }),
		});
	}

	#trackWorkspaceFolders(session: Session, message: LspJsonRpcNotification): void {
		const event = isRecord(message.params) ? message.params.event : undefined;
		if (!isRecord(event)) return;
		const folders = (value: unknown): Array<{ uri: string } & Record<string, unknown>> =>
			Array.isArray(value)
				? value.filter((folder): folder is { uri: string } => isRecord(folder) && typeof folder.uri === "string")
				: [];
		for (const folder of folders(event.removed)) session.workspaceFolders.delete(folder.uri);
		for (const folder of folders(event.added)) session.workspaceFolders.set(folder.uri, folder);
	}

	#fromServerBytes(chunk: Uint8Array): void {
		try {
			this.#framer.push(chunk);
			for (const text of this.#framer.drain(header => {
				logger.warn("LSP server framing resync", { server: this.#slot, header: header.slice(0, 200) });
			})) {
				try {
					this.#fromServer(parseRpc(text));
				} catch (error) {
					logger.warn("LSP server message handling failed", { server: this.#slot, error: String(error) });
				}
			}
		} catch (error) {
			logger.warn("LSP server reader failed", { server: this.#slot, error: String(error) });
			this.#stopReason ??= "server output unreadable";
			this.#killServer();
		}
	}

	#fromServer(message: RpcMessage): void {
		if (!hasMethod(message)) {
			this.#handleServerResponse(message);
			return;
		}
		if (hasRequestId(message)) {
			this.#handleServerRequest(message);
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			const params = DiagnosticsParams(message.params);
			if (params instanceof type.errors) return;
			// Freshly parsed and never mutated: stored as-is for replay to later sessions.
			this.#diagnostics.set(params.uri, params);
			this.#broadcast({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params });
			return;
		}
		if (message.method === "$/progress") {
			const params = ProgressParams(message.params);
			if (!(params instanceof type.errors)) {
				if (params.value?.kind === "begin") this.#progress.set(params.token, params);
				else if (params.value?.kind === "end") this.#progress.delete(params.token);
			}
		}
		this.#broadcast(message);
	}

	#handleServerResponse(message: LspJsonRpcResponse): void {
		if (message.id === undefined) return;
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (pending.resolveInternal) {
			pending.resolveInternal();
			return;
		}
		if (pending.initialize) {
			this.#initializeInFlight = false;
			if (message.error) {
				for (const [session, id] of this.#initializeWaiters) session.send({ ...message, id });
				this.#initializeWaiters.clear();
				this.#stopReason ??= "initialize failed";
				this.#killServer();
				return;
			}
			this.#initializeResult = message.result;
			this.#initializeCached = true;
			for (const [session, id] of this.#initializeWaiters) session.send(rpcResult(id, message.result));
			this.#initializeWaiters.clear();
			return;
		}
		const session = pending.session;
		if (!session || session.closed || pending.drop || pending.originalId === undefined) return;
		session.forwardedIds.delete(pending.originalId);
		session.send({ ...message, id: pending.originalId });
	}

	#handleServerRequest(message: LspJsonRpcRequest): void {
		if (
			message.method === "client/registerCapability" ||
			message.method === "client/unregisterCapability" ||
			message.method === "window/workDoneProgress/create"
		) {
			if (message.method === "client/registerCapability" && isRecord(message.params)) {
				const registrations = message.params.registrations;
				if (Array.isArray(registrations)) {
					const valid = registrations.filter(
						(registration): registration is Registration =>
							isRecord(registration) && typeof registration.id === "string",
					);
					this.#registrations.push({ registrations: valid });
					for (const registration of valid) {
						if (registration.method === WATCHED_FILES_METHOD) {
							void this.#watchedFiles?.register(registration.id, registration.registerOptions);
						}
					}
				}
			} else if (message.method === "client/unregisterCapability" && isRecord(message.params)) {
				const raw = message.params.unregisterations ?? message.params.unregistrations;
				if (Array.isArray(raw)) {
					const ids = new Set(
						raw.flatMap(item => (isRecord(item) && typeof item.id === "string" ? [item.id] : [])),
					);
					for (const batch of this.#registrations)
						batch.registrations = batch.registrations.filter(item => !ids.has(item.id));
					for (const id of ids) void this.#watchedFiles?.unregister(id);
				}
			}
			this.#writeServer(rpcResult(message.id, null));
			for (const session of this.#sessions) {
				if (session.initialized) this.#forwardNoRelay(session, message);
			}
			return;
		}
		// Client-side effects such as applyEdit must reach exactly one, most recently active omp.
		let focus: Session | undefined;
		for (const session of this.#sessions) {
			if (!focus || session.lastActivity > focus.lastActivity) focus = session;
		}
		if (!focus) {
			this.#writeServer(rpcError(message.id, -32601, "no client attached"));
			return;
		}
		const id = this.#clientId();
		focus.pendingClientRequests.set(id, { relay: true, serverId: message.id });
		focus.send({ ...message, id });
	}

	#forwardNoRelay(session: Session, message: LspJsonRpcRequest): void {
		const id = this.#clientId();
		session.pendingClientRequests.set(id, { relay: false });
		session.send({ ...message, id });
	}

	#handleClientResponse(session: Session, message: LspJsonRpcResponse): void {
		if (typeof message.id !== "string") return;
		const pending = session.pendingClientRequests.get(message.id);
		if (!pending) return;
		session.pendingClientRequests.delete(message.id);
		if (!pending.relay || pending.serverId === undefined) return;
		this.#writeServer({ ...message, id: pending.serverId });
	}

	#replayState(session: Session): void {
		for (const batch of this.#registrations) {
			if (batch.registrations.length === 0) continue;
			this.#forwardNoRelay(session, {
				jsonrpc: "2.0",
				id: "replaced",
				method: "client/registerCapability",
				params: batch,
			});
		}
		for (const params of this.#diagnostics.values()) {
			session.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params });
		}
		for (const params of this.#progress.values()) {
			session.send({ jsonrpc: "2.0", method: "$/progress", params });
		}
	}

	/** Serialize a server notification once and write the same frame to every initialized session. */
	#broadcast(message: RpcMessage): void {
		let data: Buffer | undefined;
		for (const session of this.#sessions) {
			if (!session.initialized || session.closed) continue;
			data ??= encodeMessageFrame(message);
			session.tunnel.send(data);
		}
	}

	/** Queue one frame on the server's stdin; a dead server drops it. */
	#writeServer(message: RpcMessage): void {
		if (this.#gone) return;
		try {
			this.#child.write(encodeMessageFrame(message));
		} catch (error) {
			logger.warn("LSP server write failed", { server: this.#slot, error: String(error) });
		}
	}

	#closeSession(session: Session): void {
		if (session.closed) return;
		session.closed = true;
		this.#initializeWaiters.delete(session);
		if (!this.#sessions.delete(session)) return;
		for (const uri of session.openUris) {
			this.#documents.delete(uri);
			this.#writeServer({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } });
		}
		for (const [muxId, pending] of this.#pending) {
			if (pending.session !== session) continue;
			pending.drop = true;
			this.#writeServer({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: muxId } });
		}
		if (session.workspaceFolders.size > 0) {
			this.#writeServer({
				jsonrpc: "2.0",
				method: "workspace/didChangeWorkspaceFolders",
				params: { event: { added: [], removed: [...session.workspaceFolders.values()] } },
			});
		}
		void this.#watchedFiles?.refresh();
	}

	#serverExited(code: number): void {
		if (this.#gone) return;
		this.#gone = true;
		this.#stopping = true;
		this.#watchedFiles?.close();
		this.#pending.clear();
		// A bare close reads as a clean exit on the client; tell each tunnel the real code and
		// stderr first, then close it once that last frame is flushed.
		const exit: MuxServerExit = { code, stderr: this.#stderrTail };
		const frame = encodeMessageFrame({ jsonrpc: "2.0", method: MUX_SERVER_EXITED_METHOD, params: exit });
		this.#exitFrame = frame;
		for (const session of this.#sessions) {
			session.closed = true;
			const { tunnel } = session;
			tunnel.send(frame);
			void Promise.race([tunnel.drained(), Bun.sleep(EXITED_LINK_CLOSE_MS)]).then(() => tunnel.close());
		}
		this.#sessions.clear();
	}

	async #shutdownGracefully(): Promise<void> {
		const id = this.#muxId();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#pending.set(id, { resolveInternal: resolve });
		this.#writeServer({ jsonrpc: "2.0", id, method: "shutdown", params: null });
		await settleWithin(Promise.race([promise, this.exited]), SHUTDOWN_BUDGET_MS);
		this.#writeServer({ jsonrpc: "2.0", method: "exit" });
	}

	#killServer(): void {
		this.#stopping = true;
		if (this.#gone) return;
		try {
			this.#child.kill();
		} catch {
			this.#serverExited(-1);
		}
	}
}

/** Reserve the first instance of `params`' server identity that no session is attached to. */
async function acquire(context: ModuleContext, params: unknown, client: ModuleClient): Promise<LspAcquireResult> {
	const server = ServerParams(params);
	if (server instanceof type.errors) throw new Error(`invalid lsp acquire params: ${server.summary}`);
	const scope = projectScope(await canonicalDir(server.cwd));
	const identity = muxServerKey(server);
	// Synchronous from here: concurrent acquires each see the previous one's reservation.
	for (let index = 0; ; index++) {
		const key = lspInstanceKey(identity, index);
		const slot = slotKey(scope, key);
		if (reservations.has(slot)) continue;
		const unit = context.unit(scope, key);
		if (unit && !(unit instanceof LspServerUnit && unit.available)) continue;
		const token = Bun.randomUUIDv7();
		const timer = setTimeout(() => releaseReservation(slot, token), RESERVATION_MS);
		timer.unref();
		reservations.set(slot, { token, connectionId: client.connectionId, timer });
		return { scope, key, token };
	}
}

function serverLabel(command: string, key: string): string {
	const hash = key.indexOf("#");
	const name = path.basename(command);
	return hash < 0 ? name : `${name} ${key.slice(hash)}`;
}

/** Shared language servers, one unit per server process. */
export const lspModule: DaemonModule = {
	kind: LSP_MODULE_KIND,
	version: LSP_MODULE_VERSION,
	policy: () => ({ ...LSP_POLICY }),
	open(context, request) {
		const params = UnitParams(request.params);
		if (params instanceof type.errors) throw new Error(`invalid lsp unit params: ${params.summary}`);
		const child = context.spawn({
			application: params.command,
			args: params.args,
			env: params.spawnEnv,
			cwd: params.cwd,
		});
		return new LspServerUnit({
			child,
			slot: slotKey(request.scope, request.key),
			cwd: params.cwd,
			label: serverLabel(params.command, request.key),
		});
	},
	async call(context, method, params, client) {
		if (method === LSP_ACQUIRE_METHOD) return acquire(context, params, client);
		if (method === LSP_UNRESERVE_METHOD) {
			const reservation = UnreserveParams(params);
			if (reservation instanceof type.errors)
				throw new Error(`invalid lsp unreserve params: ${reservation.summary}`);
			releaseReservation(
				slotKey(projectScope(reservation.scope.dir), reservation.key),
				reservation.token,
				client.connectionId,
			);
			return null;
		}
		throw new Error(`unknown lsp method: ${method}`);
	},
	async restore(context, _request, state) {
		const restored = state as LspUnitState;
		const child = context.adoptChild(restored.child);
		if (!child) return undefined;
		return new LspServerUnit({ child, slot: restored.slot, cwd: restored.cwd, label: restored.label, restored });
	},
	disconnected(client) {
		for (const [slot, reservation] of reservations) {
			if (reservation.connectionId === client.connectionId) releaseReservation(slot);
		}
	},
	async dispose() {
		for (const slot of reservations.keys()) releaseReservation(slot);
	},
};
