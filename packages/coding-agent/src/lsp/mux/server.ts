import * as fs from "node:fs/promises";
import * as net from "node:net";
import { isRecord, logger, postmortem, ptree, setProcessName } from "@oh-my-pi/pi-utils";
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

const SERVER_LINGER_MS = 5 * 60 * 1_000;
const MUX_IDLE_MS = 15 * 60 * 1_000;
const SHUTDOWN_BUDGET_MS = 2_000;

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

	constructor(key: string, params: MuxConnectParams) {
		this.key = key;
		this.proc = ptree.spawn([params.command, ...params.args], {
			cwd: params.cwd,
			stdin: "pipe",
			env: { ...Bun.env, ...params.env },
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
		for (const session of [...this.#sessions]) session.socket.destroy();
		await Promise.all([...this.#servers].map(server => this.#stopServer(server)));
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
		socket.on("close", () => void this.#closeSession(session));
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
			const key = muxServerKey(params);
			let server = [...this.#servers].find(candidate => candidate.key === key && candidate.sessions.size === 0);
			if (server && server.proc.exitCode !== null) {
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
			this.#killServer(server);
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
			() => this.#serverExited(server),
			() => this.#serverExited(server),
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
			this.#handleServerResponse(server, message);
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

	#handleServerResponse(server: ServerInstance, message: LspJsonRpcResponse): void {
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
				this.#killServer(server);
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
		if (server) {
			let cleanup: Promise<void> | undefined;
			for (const uri of session.openUris) {
				server.documents.delete(uri);
				cleanup = this.#writeServer(server, {
					jsonrpc: "2.0",
					method: "textDocument/didClose",
					params: { textDocument: { uri } },
				});
			}
			await cleanup;
			for (const [muxId, pending] of server.pending) {
				if (pending.session !== session) continue;
				pending.drop = true;
				await this.#writeServer(server, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: muxId } });
			}
			server.initializeWaiters.delete(session);
			server.sessions.delete(session);
			if (server.sessions.size === 0 && !server.stopping) {
				server.lingerTimer = setTimeout(() => {
					if (server.sessions.size === 0) void this.#stopServer(server);
				}, SERVER_LINGER_MS);
			}
		}
		if (this.#sessions.size === 0) this.#armMuxIdle();
	}

	#serverExited(server: ServerInstance): void {
		server.stopping = true;
		this.#servers.delete(server);
		if (server.lingerTimer) clearTimeout(server.lingerTimer);
		server.pending.clear();
		for (const session of [...server.sessions]) session.socket.destroy();
		server.sessions.clear();
	}

	async #stopServer(server: ServerInstance): Promise<void> {
		if (server.stopping) return;
		server.stopping = true;
		if (server.lingerTimer) clearTimeout(server.lingerTimer);
		const id = server.muxId();
		const { promise, resolve } = Promise.withResolvers<void>();
		server.pending.set(id, { resolveInternal: resolve });
		try {
			await this.#writeServer(server, { jsonrpc: "2.0", id, method: "shutdown", params: null });
			const timeout = Promise.withResolvers<void>();
			const timer = setTimeout(timeout.resolve, SHUTDOWN_BUDGET_MS);
			try {
				await Promise.race([promise, timeout.promise]);
			} finally {
				clearTimeout(timer);
			}
			await this.#writeServer(server, { jsonrpc: "2.0", method: "exit" });
		} catch (error) {
			logger.warn("LSP mux graceful server shutdown failed", { server: server.key, error: String(error) });
		} finally {
			this.#killServer(server);
		}
	}

	#killServer(server: ServerInstance): void {
		server.stopping = true;
		try {
			server.proc.kill();
		} catch {
			this.#serverExited(server);
		}
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
		void server.shutdown().finally(() => {
			stopped.resolve();
			process.exit(0);
		});
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
