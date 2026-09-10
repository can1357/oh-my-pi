import * as fs from "node:fs/promises";
import * as net from "node:net";
import { groupOutlivesItsLeader, Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { isRecord, logger, postmortem, ptree, setProcessName, withTimeout } from "@oh-my-pi/pi-utils";
import { MessageFramer } from "../../jsonrpc/message-framing";
import type { LspJsonRpcId, LspJsonRpcNotification, LspJsonRpcRequest, LspJsonRpcResponse } from "../types";
import {
	LSP_MUX_PROJECT_DIR_ENV,
	LSP_MUX_SOCKET_ENV,
	lspMuxReadyBanner,
	MUX_CONNECT_METHOD,
	MUX_PING_METHOD,
	MUX_PING_RESULT,
	MUX_RESTART_METHOD,
	type MuxConnectParams,
	type MuxConnectResult,
	muxServerKey,
} from "./protocol";

/**
 * Whether the mux takes ownership of a language server's process group.
 *
 * Read through a holder rather than a constant so both sides of the gate stay
 * exercisable on one host; the underlying probe is cached natively, so calling
 * it per spawn costs a binding hop.
 *
 * Group ownership has a precondition. The mux hears about a server's exit from
 * Bun, which has already reaped it, and a pgid whose leader is gone is a number
 * the kernel may hand to an unrelated session — so the native sweep refuses to
 * signal it, which is right. Only where a signal can be scoped to the leader's
 * retained pidfd is the group reachable without that proof. Where it is not,
 * detaching would buy nothing the pinned descendant set does not already give
 * and would turn a helper that sweep can still reach into a failed shutdown.
 */
export const groupOwnership = {
	available: (): boolean => groupOutlivesItsLeader(),
};

const SERVER_LINGER_MS = 5 * 60 * 1_000;
const MUX_IDLE_MS = 15 * 60 * 1_000;
const SHUTDOWN_BUDGET_MS = 2_000;
/** Hard-termination budget for a server root and anything it left behind. */
export const TERMINATION_BUDGET_MS = 1_000;
/** Termination-failure reasons kept for the shutdown that has to report them. */
export const RETAINED_STOP_FAILURES = 16;

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

interface ProgressParams {
	token: string | number;
	value?: { kind?: string; [key: string]: unknown };
}

interface DiagnosticsParams {
	uri: string;
	version?: number | null;
	[key: string]: unknown;
}

interface TextDocumentParams {
	textDocument: { uri: string; version: number; text?: string; [key: string]: unknown };
	contentChanges?: unknown;
	[key: string]: unknown;
}

class Session {
	readonly socket: net.Socket;
	readonly framer = new MessageFramer(Buffer.alloc(0));
	readonly openUris = new Set<string>();
	readonly forwardedIds = new Map<LspJsonRpcId, LspJsonRpcId>();
	readonly pendingClientRequests = new Map<string, ClientRequestPending>();
	server?: ServerInstance;
	boundKey?: string;
	initialized = false;
	closed = false;
	lastActivity = Date.now();

	constructor(socket: net.Socket) {
		this.socket = socket;
	}
}

class ServerInstance {
	readonly key: string;
	readonly proc: ptree.ChildProcess<"pipe">;
	readonly sessions = new Set<Session>();
	readonly documents = new Set<string>();
	readonly diagnostics = new Map<string, DiagnosticsParams>();
	readonly registrations: RegistrationBatch[] = [];
	readonly progress = new Map<string | number, ProgressParams>();
	readonly pending = new Map<LspJsonRpcId, ForwardedRequest>();
	readonly initializeWaiters = new Map<Session, LspJsonRpcId>();
	writeQueue: Promise<void> = Promise.resolve();
	initializeResult: unknown = undefined;
	initializeCached = false;
	initializeInFlight = false;
	initializedSent = false;
	nextId = 1;
	nextClientId = 1;
	lingerTimer?: NodeJS.Timeout;
	stopping = false;
	stopPromise?: Promise<void>;
	terminationPromise?: Promise<void>;
	// True only while a termination attempt is still running and can therefore
	// retire the server itself. `terminationPromise` is not a substitute: its
	// deadline can expire while the attempt underneath is still going, and the
	// attempt can fail outright and retire nothing.
	terminating = false;

	constructor(key: string, params: MuxConnectParams) {
		this.key = key;
		// Detached, so the server leads a process group of its own. Every earlier
		// attempt to reach what a server leaves behind pinned a set of processes at
		// one instant, and each such pin has the same hole: the server can spawn a
		// helper after it — while answering `shutdown`, or between the last walk and
		// its own exit — and once the root is gone that helper is reparented out of
		// reach of any walk rooted at its pid. Group membership is inherited at fork
		// and outlives the leader, so it names the subtree at termination time
		// rather than at capture time, which is the one thing an instant cannot do.
		//
		// This narrows the hole rather than closing it. Membership is inherited, not
		// enforced: a helper born after the pin that then calls `setsid(2)` or
		// `setpgid(2)` is in neither the pinned set nor the group, and nothing here
		// can name it. Containment that survives a process leaving every inherited
		// relation needs a cgroup or a subreaper, neither of which this spawn owns.
		// The server itself cannot escape — it is already a session leader, so both
		// calls return `EPERM`.
		//
		// Gated, because ownership has a precondition: taking a group the sweep will
		// then refuse to signal would turn a helper the pinned sweep can still reach
		// into a failed shutdown.
		this.proc = ptree.spawn([params.command, ...params.args], {
			cwd: params.cwd,
			stdin: "pipe",
			env: { ...Bun.env, ...params.env },
			detached: groupOwnership.available(),
		});
	}

	muxId(): number {
		return this.nextId++;
	}

	clientId(): string {
		return `mux:${this.nextClientId++}`;
	}
}

function hasMethod(message: RpcMessage): message is LspJsonRpcRequest | LspJsonRpcNotification {
	return "method" in message && typeof message.method === "string";
}

function hasRequestId(message: LspJsonRpcRequest | LspJsonRpcNotification): message is LspJsonRpcRequest {
	return "id" in message && (typeof message.id === "number" || typeof message.id === "string");
}

function frame(message: RpcMessage): string {
	const body = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function rpcResult(id: LspJsonRpcId, result: unknown): LspJsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: LspJsonRpcId, code: number, message: string): LspJsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseConnectParams(params: unknown): MuxConnectParams | undefined {
	if (!isRecord(params) || typeof params.command !== "string" || typeof params.cwd !== "string") return undefined;
	if (!Array.isArray(params.args) || !params.args.every(arg => typeof arg === "string")) return undefined;
	if (params.env !== undefined) {
		if (!isRecord(params.env)) return undefined;
		for (const key in params.env) if (typeof params.env[key] !== "string") return undefined;
	}
	return params as unknown as MuxConnectParams;
}

function parseDocumentParams(params: unknown): TextDocumentParams | undefined {
	if (!isRecord(params) || !isRecord(params.textDocument)) return undefined;
	if (typeof params.textDocument.uri !== "string" || typeof params.textDocument.version !== "number") return undefined;
	return params as unknown as TextDocumentParams;
}

function parseUri(params: unknown): string | undefined {
	if (!isRecord(params) || !isRecord(params.textDocument)) return undefined;
	return typeof params.textDocument.uri === "string" ? params.textDocument.uri : undefined;
}

function parseDiagnostics(params: unknown): DiagnosticsParams | undefined {
	if (!isRecord(params) || typeof params.uri !== "string") return undefined;
	return params as DiagnosticsParams;
}

function parseProgress(params: unknown): ProgressParams | undefined {
	if (!isRecord(params) || (typeof params.token !== "string" && typeof params.token !== "number")) return undefined;
	return params as unknown as ProgressParams;
}

function cloneParams<T>(params: T): T {
	return structuredClone(params);
}

/**
 * Broker-owned, in-process-testable multiplexer for shared language-server children.
 */
export class LspMuxServer {
	/** Called after the mux has had no connected sessions for its idle grace period. */
	onIdle?: () => void;
	readonly #servers = new Set<ServerInstance>();
	readonly #sessions = new Set<Session>();
	#netServer?: net.Server;
	#endpoint?: string;
	#idleTimer?: NodeJS.Timeout;
	#activityClock = Date.now();
	#shuttingDown = false;
	#shutdownPromise?: Promise<void>;
	// Stops still running, kept here rather than only on the server instance:
	// a server is retired from `#servers` as soon as its root termination
	// finishes, which can be well before its helper sweep does, so enumerating
	// the tracked servers alone would let shutdown skip — and never report — a
	// sweep that is still going or about to fail.
	readonly #stopsInFlight = new Set<Promise<void>>();
	// Terminations already handed to `#track`, so a memoized promise offered
	// twice neither attaches a second handler nor counts one failure twice.
	// Weak, because this only answers a question about identity and must not be
	// the reason a settled promise is still reachable.
	readonly #trackedStops = new WeakSet<Promise<void>>();
	// Why terminations already failed. A failure can land long before any
	// shutdown — an idle server's stop is the usual case — and by then the server
	// is retired and the stop settled, so nothing else would carry it and the
	// shutdown that follows would report success over whatever it left behind.
	//
	// Reasons rather than the promises themselves, and capped: anything that can
	// make one termination fail can make the next one fail too, and holding a
	// settled promise per failure for the life of a mux that may never shut down
	// is a leak. `#failedStopCount` keeps the total truthful past the cap, so a
	// bound on what is retained never becomes a bound on what is reported.
	readonly #failedStopReasons: unknown[] = [];
	#failedStopCount = 0;

	/** Number of currently connected mux links, including unbound ping links. */
	get sessionCount(): number {
		return this.#sessions.size;
	}

	/** Keys of currently live shared language-server children. */
	get serverKeys(): string[] {
		return [...this.#servers].map(server => server.key);
	}

	/** Listen for Content-Length framed mux links at a Unix socket or named pipe. */
	async listen(endpoint: string): Promise<void> {
		if (this.#netServer) throw new Error("LSP mux is already listening");
		if (process.platform !== "win32") await this.#clearStaleSocket(endpoint);
		const server = net.createServer(socket => this.#accept(socket));
		this.#netServer = server;
		this.#endpoint = endpoint;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(endpoint, () => {
			server.off("error", onError);
			resolve();
		});
		await promise;
		this.#armMuxIdle();
	}

	/** Gracefully close all children, links, and the listening endpoint. */
	async shutdown(): Promise<void> {
		this.#shutdownPromise ??= this.#performShutdown();
		await this.#shutdownPromise;
	}

	async #performShutdown(): Promise<void> {
		this.#shuttingDown = true;
		clearTimeout(this.#idleTimer);
		for (const session of Array.from(this.#sessions)) session.socket.destroy();
		const stops = [...this.#servers].map(server => this.#stopServer(server));
		// Awaited so their outcomes land, not so they can be read here: a tracked
		// termination reports through the recorded reasons, which is also what
		// carries the ones that settled before this shutdown began. Anything
		// untracked is read straight off the result, rather than assumed covered.
		const awaited = [...new Set([...stops, ...this.#stopsInFlight])];
		const results = await Promise.allSettled(awaited);
		const listener = this.#netServer;
		this.#netServer = undefined;
		if (listener) {
			const { promise, resolve } = Promise.withResolvers<void>();
			listener.close(() => resolve());
			await promise;
		}
		if (process.platform !== "win32" && this.#endpoint) {
			try {
				await fs.unlink(this.#endpoint);
			} catch {
				// The socket may already have been removed by process cleanup.
			}
		}
		const failures: unknown[] = [...this.#failedStopReasons];
		results.forEach((result, index) => {
			if (result.status === "rejected" && !this.#trackedStops.has(awaited[index])) failures.push(result.reason);
		});
		const withheld = this.#failedStopCount - this.#failedStopReasons.length;
		if (withheld > 0) failures.push(new Error(`LSP mux withheld ${withheld} further termination failures`));
		if (failures.length > 0) throw new AggregateError(failures, "LSP mux shutdown incomplete");
	}

	async #clearStaleSocket(endpoint: string): Promise<void> {
		try {
			await fs.stat(endpoint);
		} catch {
			return;
		}
		const alive = await this.#probe(endpoint);
		if (alive) throw new Error(`LSP mux already listening on ${endpoint}`);
		try {
			await fs.unlink(endpoint);
		} catch (error) {
			logger.warn("Failed to remove stale LSP mux socket", { endpoint, error: String(error) });
			throw error;
		}
	}

	async #probe(endpoint: string): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const socket = net.createConnection(endpoint);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
		return promise;
	}

	#accept(socket: net.Socket): void {
		// Shutdown snapshots the sessions and the servers, then waits on the stops
		// and closes the listener. A connection accepted after that snapshot is in
		// neither set, so it can spawn a server nothing will stop and hold the
		// listener open for as long as it stays connected.
		if (this.#shuttingDown) {
			socket.destroy();
			return;
		}
		const session = new Session(socket);
		this.#sessions.add(session);
		this.#disarmMuxIdle();
		socket.on("data", chunk => {
			session.framer.push(Buffer.from(chunk));
			for (const text of session.framer.drain(header => {
				logger.warn("LSP mux client framing resync", { header: header.slice(0, 200) });
			})) {
				try {
					const parsed: unknown = JSON.parse(text);
					if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") throw new Error("invalid JSON-RPC message");
					void this.#fromSession(session, parsed as unknown as RpcMessage).catch(error => {
						logger.warn("LSP mux client message handling failed", { error: String(error) });
					});
				} catch (error) {
					logger.warn("LSP mux client sent malformed JSON", { error: String(error) });
				}
			}
		});
		socket.on("error", error => logger.warn("LSP mux session socket error", { error: error.message }));
		socket.on("close", () => {
			void this.#closeSession(session).catch(error => {
				logger.warn("LSP mux session close failed", { error: String(error) });
			});
		});
	}

	async #fromSession(session: Session, message: RpcMessage): Promise<void> {
		if (session.closed) return;
		this.#activityClock = Math.max(Date.now(), this.#activityClock + 1);
		session.lastActivity = this.#activityClock;
		if (!hasMethod(message)) {
			this.#handleClientResponse(session, message);
			return;
		}
		const request = hasRequestId(message);
		if (message.method === MUX_PING_METHOD && request) {
			this.#sendSession(session, rpcResult(message.id, MUX_PING_RESULT));
			return;
		}
		if (message.method === MUX_CONNECT_METHOD && request) {
			if (session.server) {
				this.#sendSession(session, rpcError(message.id, -32600, "session already bound"));
				return;
			}
			const params = parseConnectParams(message.params);
			if (!params) {
				this.#sendSession(session, rpcError(message.id, -32602, "invalid mux connect params"));
				return;
			}
			// Racing the shutdown snapshot: the socket was accepted before shutdown
			// began but this request arrived after, so spawning here would put a
			// server behind the snapshot just as surely as a late connection would.
			if (this.#shuttingDown) {
				this.#sendSession(session, rpcError(message.id, -32002, "lsp mux is shutting down"));
				return;
			}
			const key = muxServerKey(params);
			let server = [...this.#servers].find(candidate => candidate.key === key && candidate.sessions.size === 0);
			if (server && server.proc.exitCode !== null && !server.terminating) {
				this.#serverExited(server);
				server = undefined;
			}
			let spawned = false;
			if (!server || server.stopping) {
				server = this.#spawnServer(key, params);
				spawned = true;
			}
			if (server.lingerTimer) clearTimeout(server.lingerTimer);
			server.lingerTimer = undefined;
			server.sessions.add(session);
			session.server = server;
			session.boundKey = key;
			const result: MuxConnectResult = { key, spawned, pid: server.proc.pid };
			this.#sendSession(session, rpcResult(message.id, result));
			return;
		}
		const server = session.server;
		if (!server) {
			if (request) this.#sendSession(session, rpcError(message.id, -32002, "muxConnect must be first"));
			return;
		}
		if (message.method === MUX_RESTART_METHOD && !request) {
			await this.#killServerTracked(server);
			return;
		}
		if (message.method === "initialize" && request) {
			await this.#initialize(session, server, message);
			return;
		}
		if (message.method === "initialized" && !request) {
			if (!server.initializedSent) {
				server.initializedSent = true;
				await this.#writeServer(server, message);
			} else {
				this.#replayState(session, server);
			}
			session.initialized = true;
			return;
		}
		if (message.method === "shutdown" && request) {
			this.#sendSession(session, rpcResult(message.id, null));
			return;
		}
		if (message.method === "exit" && !request) {
			session.socket.destroy();
			return;
		}
		if (message.method === "textDocument/didOpen" && !request) {
			await this.#didOpen(session, server, message);
			return;
		}
		if (message.method === "textDocument/didChange" && !request) {
			await this.#didChange(session, server, message);
			return;
		}
		if (message.method === "textDocument/didClose" && !request) {
			await this.#didClose(session, server, message);
			return;
		}
		if (message.method === "$/cancelRequest" && !request) {
			if (!isRecord(message.params)) return;
			const originalId = message.params.id;
			if (typeof originalId !== "string" && typeof originalId !== "number") return;
			const muxId = session.forwardedIds.get(originalId);
			if (muxId !== undefined)
				await this.#writeServer(server, { ...message, params: { ...message.params, id: muxId } });
			return;
		}
		if (request) {
			const muxId = server.muxId();
			server.pending.set(muxId, { session, originalId: message.id });
			session.forwardedIds.set(message.id, muxId);
			await this.#writeServer(server, { ...message, id: muxId });
			return;
		}
		await this.#writeServer(server, message);
	}

	async #initialize(session: Session, server: ServerInstance, message: LspJsonRpcRequest): Promise<void> {
		if (server.initializeCached) {
			this.#sendSession(session, rpcResult(message.id, server.initializeResult));
			return;
		}
		server.initializeWaiters.set(session, message.id);
		if (server.initializeInFlight) return;
		server.initializeInFlight = true;
		const muxId = server.muxId();
		server.pending.set(muxId, { initialize: true });
		const params = isRecord(message.params)
			? { ...message.params, processId: process.pid }
			: { processId: process.pid };
		// Language servers commonly self-terminate with their advertised client pid.
		await this.#writeServer(server, { ...message, id: muxId, params });
	}

	async #didOpen(session: Session, server: ServerInstance, message: LspJsonRpcNotification): Promise<void> {
		const params = parseDocumentParams(message.params);
		if (!params) return;
		const uri = params.textDocument.uri;
		session.openUris.add(uri);
		server.documents.add(uri);
		await this.#writeServer(server, message);
	}

	async #didChange(_session: Session, server: ServerInstance, message: LspJsonRpcNotification): Promise<void> {
		await this.#writeServer(server, message);
	}

	async #didClose(session: Session, server: ServerInstance, message: LspJsonRpcNotification): Promise<void> {
		const uri = parseUri(message.params);
		if (!uri) return;
		session.openUris.delete(uri);
		server.documents.delete(uri);
		await this.#writeServer(server, message);
	}

	#spawnServer(key: string, params: MuxConnectParams): ServerInstance {
		const server = new ServerInstance(key, params);
		this.#servers.add(server);
		void this.#readServer(server);
		server.proc.exited.then(
			() => this.#serverExitedUnlessTerminating(server),
			() => this.#serverExitedUnlessTerminating(server),
		);
		return server;
	}

	async #readServer(server: ServerInstance): Promise<void> {
		const reader = server.proc.stdout.getReader();
		const framer = new MessageFramer(Buffer.alloc(0));
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				framer.push(Buffer.from(value));
				for (const text of framer.drain(header => {
					logger.warn("LSP mux server framing resync", { server: server.key, header: header.slice(0, 200) });
				})) {
					try {
						const parsed: unknown = JSON.parse(text);
						if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") throw new Error("invalid JSON-RPC message");
						await this.#fromServer(server, parsed as unknown as RpcMessage);
					} catch (error) {
						logger.warn("LSP mux server message handling failed", { server: server.key, error: String(error) });
					}
				}
			}
		} catch (error) {
			logger.warn("LSP mux server reader failed", { server: server.key, error: String(error) });
		} finally {
			reader.releaseLock();
		}
	}

	async #fromServer(server: ServerInstance, message: RpcMessage): Promise<void> {
		if (!hasMethod(message)) {
			await this.#handleServerResponse(server, message);
			return;
		}
		if (hasRequestId(message)) {
			await this.#handleServerRequest(server, message);
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			const params = parseDiagnostics(message.params);
			if (!params) return;
			server.diagnostics.set(params.uri, cloneParams(params));
			for (const session of server.sessions) if (session.initialized) this.#sendDiagnostics(session, params);
			return;
		}
		if (message.method === "$/progress") {
			const params = parseProgress(message.params);
			if (params) {
				if (params.value?.kind === "begin") server.progress.set(params.token, cloneParams(params));
				else if (params.value?.kind === "end") server.progress.delete(params.token);
			}
		}
		for (const session of server.sessions) if (session.initialized) this.#sendSession(session, message);
	}

	async #handleServerResponse(server: ServerInstance, message: LspJsonRpcResponse): Promise<void> {
		if (message.id === undefined) return;
		const pending = server.pending.get(message.id);
		if (!pending) return;
		server.pending.delete(message.id);
		if (pending.resolveInternal) {
			pending.resolveInternal();
			return;
		}
		if (pending.initialize) {
			server.initializeInFlight = false;
			if (message.error) {
				for (const [session, id] of server.initializeWaiters) this.#sendSession(session, { ...message, id });
				server.initializeWaiters.clear();
				await this.#killServerTracked(server);
				return;
			}
			server.initializeResult = message.result;
			server.initializeCached = true;
			for (const [session, id] of server.initializeWaiters)
				this.#sendSession(session, rpcResult(id, message.result));
			server.initializeWaiters.clear();
			return;
		}
		const session = pending.session;
		if (!session || session.closed || pending.drop || pending.originalId === undefined) return;
		session.forwardedIds.delete(pending.originalId);
		this.#sendSession(session, { ...message, id: pending.originalId });
	}

	async #handleServerRequest(server: ServerInstance, message: LspJsonRpcRequest): Promise<void> {
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
					server.registrations.push({ registrations: cloneParams(valid) });
				}
			} else if (message.method === "client/unregisterCapability" && isRecord(message.params)) {
				const raw = message.params.unregisterations ?? message.params.unregistrations;
				if (Array.isArray(raw)) {
					const ids = new Set(
						raw.flatMap(item => (isRecord(item) && typeof item.id === "string" ? [item.id] : [])),
					);
					for (const batch of server.registrations)
						batch.registrations = batch.registrations.filter(item => !ids.has(item.id));
				}
			}
			await this.#writeServer(server, rpcResult(message.id, null));
			for (const session of server.sessions) {
				if (!session.initialized) continue;
				this.#forwardNoRelay(session, server, message);
			}
			return;
		}
		// Client-side effects such as applyEdit must reach exactly one, most recently active omp.
		let focus: Session | undefined;
		for (const session of server.sessions) {
			if (!focus || session.lastActivity > focus.lastActivity) focus = session;
		}
		if (!focus) {
			await this.#writeServer(server, rpcError(message.id, -32601, "no client attached"));
			return;
		}
		const id = server.clientId();
		focus.pendingClientRequests.set(id, { relay: true, serverId: message.id });
		this.#sendSession(focus, { ...message, id });
	}

	#forwardNoRelay(session: Session, server: ServerInstance, message: LspJsonRpcRequest): void {
		const id = server.clientId();
		session.pendingClientRequests.set(id, { relay: false });
		this.#sendSession(session, { ...message, id });
	}

	#handleClientResponse(session: Session, message: LspJsonRpcResponse): void {
		if (typeof message.id !== "string") return;
		const pending = session.pendingClientRequests.get(message.id);
		if (!pending) return;
		session.pendingClientRequests.delete(message.id);
		if (!pending.relay || pending.serverId === undefined || !session.server) return;
		void this.#writeServer(session.server, { ...message, id: pending.serverId });
	}

	#sendDiagnostics(session: Session, params: DiagnosticsParams): void {
		this.#sendSession(session, {
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: cloneParams(params),
		});
	}

	#replayState(session: Session, server: ServerInstance): void {
		for (const batch of server.registrations) {
			if (batch.registrations.length === 0) continue;
			this.#forwardNoRelay(session, server, {
				jsonrpc: "2.0",
				id: "replaced",
				method: "client/registerCapability",
				params: cloneParams(batch),
			});
		}
		for (const params of server.diagnostics.values()) this.#sendDiagnostics(session, params);
		for (const params of server.progress.values()) {
			this.#sendSession(session, { jsonrpc: "2.0", method: "$/progress", params: cloneParams(params) });
		}
	}

	#sendSession(session: Session, message: RpcMessage): void {
		if (!session.closed && !session.socket.destroyed) session.socket.write(frame(message));
	}

	#writeServer(server: ServerInstance, message: RpcMessage): Promise<void> {
		const write = server.writeQueue
			.catch(() => {})
			.then(async () => {
				if (!this.#servers.has(server)) return;
				const data = frame(message);
				const pendingWrite = Promise.resolve(server.proc.stdin.write(data));
				void pendingWrite.catch(() => {});
				await Promise.all([pendingWrite, Promise.resolve(server.proc.stdin.flush())]);
			});
		server.writeQueue = write.catch(error => {
			logger.warn("LSP mux server write failed", { server: server.key, error: String(error) });
		});
		return write;
	}

	async #closeSession(session: Session): Promise<void> {
		if (session.closed) return;
		session.closed = true;
		this.#sessions.delete(session);
		const server = session.server;
		try {
			if (server) {
				const cleanup: Promise<void>[] = [];
				for (const uri of session.openUris) {
					server.documents.delete(uri);
					if (server.stopping) continue;
					cleanup.push(
						this.#writeServer(server, {
							jsonrpc: "2.0",
							method: "textDocument/didClose",
							params: { textDocument: { uri } },
						}),
					);
				}
				for (const [muxId, pending] of server.pending) {
					if (pending.session !== session) continue;
					pending.drop = true;
					if (server.stopping) continue;
					cleanup.push(
						this.#writeServer(server, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: muxId } }),
					);
				}
				try {
					if (!server.stopping) {
						await withTimeout(
							Promise.all([...cleanup, server.writeQueue]),
							SHUTDOWN_BUDGET_MS,
							"LSP mux session cleanup timed out",
						);
					}
				} catch (error) {
					logger.warn("LSP mux session cleanup failed", { server: server.key, error: String(error) });
					await this.#killServerTracked(server);
				} finally {
					server.initializeWaiters.delete(session);
					server.sessions.delete(session);
					if (server.sessions.size === 0 && !server.stopping) {
						server.lingerTimer = setTimeout(() => {
							if (server.sessions.size === 0)
								void this.#stopServer(server).catch(error => {
									logger.warn("LSP mux idle server shutdown failed", {
										server: server.key,
										error: String(error),
									});
								});
						}, SERVER_LINGER_MS);
					}
				}
			}
		} finally {
			if (this.#sessions.size === 0) this.#armMuxIdle();
		}
	}

	/**
	 * Retire a server whose OS process is gone, unless a termination attempt is
	 * still running and will retire it itself.
	 *
	 * Deferring to a *settled* termination is what strands the server: a failed
	 * attempt retires nothing, so ignoring the later exit would leave the server
	 * in `#servers` with its sessions attached and every subsequent shutdown
	 * replaying the same rejection.
	 */
	#serverExitedUnlessTerminating(server: ServerInstance): void {
		if (server.terminating) return;
		this.#serverExited(server);
	}

	#serverExited(server: ServerInstance): void {
		server.stopping = true;
		this.#servers.delete(server);
		if (server.lingerTimer) clearTimeout(server.lingerTimer);
		server.pending.clear();
		server.initializeWaiters.clear();
		for (const session of Array.from(server.sessions)) session.socket.destroy();
		server.sessions.clear();
	}

	#stopServer(server: ServerInstance): Promise<void> {
		// An in-flight stop outranks the root's own termination promise: it covers
		// the helper subtree as well, and it is already set by the time the root
		// enters termination. Returning the narrower promise would let shutdown
		// close the listener as soon as the root exited, without waiting for — or
		// reporting — a helper that is still terminating or ultimately times out.
		if (server.stopPromise) return server.stopPromise;
		if (server.terminationPromise) return server.terminationPromise;
		const stop = this.#performStopServer(server);
		this.#track(stop);
		server.stopPromise = stop;
		return stop;
	}

	/**
	 * Carry a termination's outcome to whatever shutdown comes next.
	 *
	 * Idempotent because the promises handed here are memoized: `#killServer`
	 * returns one termination per server however often it is asked, and
	 * re-registering would attach a handler per call.
	 */
	#track(outcome: Promise<void>): void {
		if (this.#trackedStops.has(outcome)) return;
		this.#trackedStops.add(outcome);
		this.#stopsInFlight.add(outcome);
		void outcome.then(
			() => this.#stopsInFlight.delete(outcome),
			(reason: unknown) => {
				this.#stopsInFlight.delete(outcome);
				this.#failedStopCount++;
				if (this.#failedStopReasons.length < RETAINED_STOP_FAILURES) this.#failedStopReasons.push(reason);
			},
		);
	}

	/**
	 * Terminate a server outside a stop, keeping the outcome accountable.
	 *
	 * `#stopServer` records how its own attempt ended; a bare `#killServer` has
	 * nothing around it that does, and each of its three callers — restart, a
	 * failed `initialize`, and session cleanup — reaches it from a handler that
	 * only logs. Root-exit cleanup then retires the server from `#servers`, so
	 * an attempt that left a helper running is carried by nothing at all and the
	 * next shutdown reports success over it.
	 */
	#killServerTracked(server: ServerInstance): Promise<void> {
		const terminated = this.#killServer(server);
		this.#track(terminated);
		return terminated;
	}

	async #performStopServer(server: ServerInstance): Promise<void> {
		if (server.stopping) return;
		server.stopping = true;
		if (server.lingerTimer) clearTimeout(server.lingerTimer);
		const id = server.muxId();
		const { promise, resolve } = Promise.withResolvers<void>();
		server.pending.set(id, { resolveInternal: resolve });
		// Pinned before the handshake, because this method waits for the root to
		// exit: a walk rooted at an exited pid finds nothing, so a helper the
		// server leaves running would be unreachable by the time it is killed.
		// The whole subtree, not just direct children: a helper that dies during
		// the handshake reparents its own children out of reach of both it and the
		// exited root.
		//
		// No instant is the right one, which is why the group above exists: this
		// pin cannot hold a helper the server spawns while answering `shutdown`.
		// What it does hold is a helper that leaves the group afterwards, and
		// everything at all on a host where the group is unattributable.
		//
		// A walk that stopped short throws rather than handing back a short set as
		// a whole one. Caught here so the handshake still runs — the server gets
		// its chance to exit cleanly either way — but the stop is failed at the
		// end, because a helper this never pinned is one nothing will sweep.
		let helpers: Process[] = [];
		let helperPinFailure: unknown;
		try {
			// No reference is the same outcome as a walk that stopped short, and it
			// has to be read that way rather than as an empty subtree: the pin runs
			// while the server is expected alive, so failing to open one means a
			// refused `pidfd_open` or a root that died into the gap — and in both
			// the helpers it may have left are past reach, not absent.
			const root = Process.fromPid(server.proc.pid);
			if (!root) throw new Error(`no reference to server root ${server.proc.pid}`);
			// Liveness is required on both sides of the walk, not compared across
			// it. A walk rooted at a pid whose process has gone enumerates nothing
			// and reports that as whole — correctly, since the native side cannot
			// separate a root that died a syscall ago from one gone for an hour,
			// and charging every exited node as a gap would make the hard wave's
			// rescan of a dying tree unattributable. Only this side knows the root
			// was expected alive, so only this side can read an empty subtree as
			// "it went away before I could look" rather than "it had none" — and a
			// root that goes away takes its helpers with it, out to init, where
			// nothing rooted at its pid will ever name them.
			//
			// Both reads have to be a demand rather than a precondition for the
			// other. Treating the first as a gate — only checking the second when
			// the first said Running — accepts a root that was already a zombie
			// when it was pinned, and that is the wider window of the two: it
			// covers everything from the server's exit up to this line, where the
			// second covers a single walk.
			//
			// A stop failed over a root that exited in the instant after a walk
			// that did see everything is the cost, and it is the survivable
			// direction; the pinned set is still swept either way.
			//
			// Not covered here: the pin resolves a bare pid, so where the runtime
			// has reaped the root and no retained reference holds its number, a
			// reused pid answers Running as somebody else. That is the
			// constructor-side identity gap recorded in the natives changelog, not
			// something a liveness read can close.
			if (root.status() !== ProcessStatus.Running)
				throw new Error(`server root ${server.proc.pid} was already gone when its subtree was pinned`);
			helpers = root.descendants();
			if (root.status() !== ProcessStatus.Running)
				throw new Error(`server root ${server.proc.pid} exited before its subtree could be walked`);
		} catch (error) {
			helperPinFailure = error;
			logger.warn("LSP mux could not pin the server's helper subtree", {
				server: server.key,
				error: String(error),
			});
		}
		try {
			await withTimeout(
				(async () => {
					await this.#writeServer(server, { jsonrpc: "2.0", id, method: "shutdown", params: null });
					await promise;
					await this.#writeServer(server, { jsonrpc: "2.0", method: "exit" });
					await server.proc.exited;
				})(),
				SHUTDOWN_BUDGET_MS,
				"LSP mux server shutdown timed out",
			);
		} catch (error) {
			logger.warn("LSP mux graceful server shutdown failed", { server: server.key, error: String(error) });
		} finally {
			resolve();
			server.pending.delete(id);
			// Started before the root's own termination, which sweeps the whole
			// process group where the mux owns one: the group signal would otherwise
			// reach these helpers first, and a sweep whose targets are already dying
			// reports nothing about whether it could have terminated them. Ordering
			// is enough because the native side captures and hard-signals its targets
			// synchronously, before it returns the promise this does not await.
			//
			// This one holds pinned identities and needs no proof of the group's
			// ownership, so it is also the only sweep that works where the group
			// cannot be attributed, or where a helper has left it.
			const helperSweep = this.#killHelpers(server, helpers);
			const outcomes = await Promise.allSettled([helperSweep, this.#killServer(server)]);
			const failures = outcomes.flatMap(outcome => (outcome.status === "rejected" ? [outcome.reason] : []));
			// An unpinnable subtree fails the stop for the same reason an unswept
			// helper does: what it left behind is unaccounted for either way.
			if (helperPinFailure !== undefined)
				failures.push(new Error(`LSP mux helper subtree could not be pinned: ${String(helperPinFailure)}`));
			// A helper left behind is an incomplete termination exactly like a root
			// left behind, so it fails the shutdown rather than only warning.
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1)
				throw new AggregateError(failures, `LSP mux server termination incomplete: ${server.key}`);
		}
	}

	/**
	 * Hard-kill anything pinned from the server's tree before its root exited.
	 *
	 * `killAndWait()` captures the tree when it runs, and by then the root is
	 * gone. Where the mux owns the server's process group that sweep still
	 * reaches the subtree, but the group is not always attributable and a helper
	 * can leave it, so these pinned references remain the handle that needs no
	 * proof of ownership. Each is identity-checked natively, so a pid that has
	 * since been recycled is not signalled.
	 *
	 * Held to the same contract as the root: the same hard-termination budget,
	 * and an outcome that leaves a process alive — a rejection or an exhausted
	 * budget alike — is reported rather than logged and dropped.
	 */
	async #killHelpers(server: ServerInstance, helpers: Process[]): Promise<void> {
		const survivors = helpers.filter(helper => helper.status() === ProcessStatus.Running);
		if (survivors.length === 0) return;
		// Normalized into promises rather than called bare: a synchronous throw from
		// any one of them would abandon the rest of the batch mid-map, leaving later
		// helpers unattempted and earlier ones unawaited.
		const results = await Promise.allSettled(
			survivors.map(helper => Promise.try(() => helper.killTreeAndWait({ timeoutMs: TERMINATION_BUDGET_MS }))),
		);
		const failures = results.flatMap((result, index) => {
			const pid = survivors[index].pid;
			if (result.status === "rejected")
				return [new Error(`LSP mux helper termination failed: ${pid}: ${String(result.reason)}`)];
			return result.value ? [] : [new Error(`LSP mux helper termination timed out: ${pid}`)];
		});
		if (failures.length === 0) return;
		for (const failure of failures)
			logger.warn("LSP mux helper termination incomplete", { server: server.key, error: failure.message });
		if (failures.length === 1) throw failures[0];
		throw new AggregateError(failures, `LSP mux helper termination incomplete: ${server.key}`);
	}

	#killServer(server: ServerInstance): Promise<void> {
		if (server.terminationPromise) return server.terminationPromise;
		server.stopping = true;
		server.terminating = true;
		if (server.lingerTimer) clearTimeout(server.lingerTimer);
		const terminated = server.proc.killAndWait(undefined, -1).then(
			() => {
				server.terminating = false;
				this.#serverExited(server);
			},
			error => {
				// Termination failed, so nothing here will retire the server. Do it now
				// if the process is already gone; otherwise the exit callback owns it,
				// which the cleared flag now allows.
				server.terminating = false;
				if (server.proc.exitCode !== null) this.#serverExited(server);
				throw error;
			},
		);
		server.terminationPromise = withTimeout(
			terminated,
			TERMINATION_BUDGET_MS,
			`LSP mux server termination timed out: ${server.key}`,
		);
		return server.terminationPromise;
	}

	#disarmMuxIdle(): void {
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
	}

	#armMuxIdle(): void {
		this.#disarmMuxIdle();
		if (this.#shuttingDown || this.#sessions.size > 0) return;
		this.#idleTimer = setTimeout(() => {
			if (this.#sessions.size === 0) this.onIdle?.();
		}, MUX_IDLE_MS);
	}
}

/** Start the detached LSP mux selected by the CLI worker host environment. */
export async function startLspMuxFromEnvironment(): Promise<void> {
	const endpoint = process.env[LSP_MUX_SOCKET_ENV];
	const projectDir = process.env[LSP_MUX_PROJECT_DIR_ENV];
	if (!endpoint || !projectDir) throw new Error("LSP mux environment is incomplete");
	delete process.env[LSP_MUX_SOCKET_ENV];
	delete process.env[LSP_MUX_PROJECT_DIR_ENV];
	setProcessName("omp lsp mux");
	const server = new LspMuxServer();
	const stopped = Promise.withResolvers<void>();
	server.onIdle = () => {
		void server.shutdown().then(
			() => {
				stopped.resolve();
				process.exit(0);
			},
			error => {
				logger.error("LSP mux shutdown failed", { error: String(error) });
				stopped.resolve();
				process.exit(1);
			},
		);
	};
	const cancelCleanup = postmortem.register("lsp-mux", () => server.shutdown());
	try {
		await server.listen(endpoint);
		process.stdout.write(`${lspMuxReadyBanner(endpoint)}\n`);
		await stopped.promise;
	} finally {
		cancelCleanup();
	}
}
