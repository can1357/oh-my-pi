/**
 * Session-scoped Unix domain socket transport for the RPC protocol.
 *
 * A live session publishes `<endpointDir>/<sessionId>.sock` (owner-only) and a
 * `<sessionId>.json` discovery sidecar. Any number of external clients attach
 * to the same `RpcSessionSocketSurface` the stdio transport serves; the session
 * itself is owned by the process that listens, never by a client. A client
 * disconnect therefore fails only that client's in-flight work (the surface's
 * `close` hook) and never stops the listener, ends the session, or aborts a
 * turn.
 *
 * Frames are newline-delimited JSON, exactly like stdio. Each connection gets
 * its own `ready` frame and its own `negotiate_protocol` state: a v1 client
 * receives single frames (oversized ones are shrunk as on stdio) while a v2
 * client receives `rpc_chunk` sequences, on the same listener.
 *
 * Session events are broadcast to every attached connection. The surface owns
 * all unsolicited frames it can attribute to a connection (host tool calls,
 * prompts' results); process-wide notices stay on the stdio sink.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import { resolveSessionEndpointDir } from "../../launch/session-attach";
import { sessionOwnerContext } from "../../launch/session-owner";
import type { AgentSession } from "../../session/agent-session";
import { RpcClientConnection, type RpcClientConn } from "./client-connection";
import { MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, RpcFrameEncoder } from "./rpc-frame";

const READY_FRAME = {
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	supportsBashExcludeFromContext: true,
} as const;

/** Session identity published for discovery. Read again on every rebind. */
export interface RpcSessionSocketIdentity {
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
	agent: string;
}

/** Broker coordinates of the PTY that hosts this process as a session owner. */
export interface RpcSessionSocketTerminal {
	protocolVersion: 1;
	projectDir: string;
	name: string;
	id: string;
}

/** Discovery sidecar contents; see the module docs for ownership rules. */
export interface RpcSessionSocketMetadata {
	pid: number;
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	agent: string;
	startedAt: number;
	terminal?: RpcSessionSocketTerminal;
}

export interface RpcSessionSocketOptions {
	/** Directory holding `<sessionId>.sock` and `<sessionId>.json`; injected by tests. */
	endpointDir: string;
	/** Read for every publication, so a rebind names the session that replaced it. */
	identity: () => RpcSessionSocketIdentity;
	/** Session event source; the socket broadcasts each event to every attached connection. */
	subscribe: (listener: (event: object) => void) => () => void;
	/** Broker coordinates of this process's owner PTY, read for every publication; omit when not an owner. */
	terminal?: () => RpcSessionSocketTerminal | undefined;
	/**
	 * Per-connection projection of a broadcast session event. Returning
	 * `undefined` drops the frame for that connection; the raw event is sent
	 * when no projector is installed. A terminal-hosted publication uses it for
	 * per-view `set_event_filter` and message stamping.
	 */
	projectEvent?: (event: object, conn: RpcClientConn) => object | undefined;
}

/** Per-connection RPC surface, supplied by the transport owner that speaks the protocol. */
export interface RpcSessionSocketSurface {
	/** Handle one decoded frame from this connection. */
	dispatch(frame: object): void;
	/** The client went away; release its per-connection state. Must not end the session. */
	close?(reason: string): void;
}

type SocketConnectionState = {
	conn: RpcClientConnection;
	socket: IpcConnection;
	decoder: RpcFrameDecoder;
	encoder: RpcFrameEncoder;
	surface: RpcSessionSocketSurface | undefined;
	detached: boolean;
};

interface ListenerState {
	server: IpcServer;
	endpoint: string;
	sidecarPath: string;
	sessionId: string;
}

/**
 * Publish one live session for external attachment.
 *
 * `listen` binds and announces; `rebind` moves the announcement when the
 * session id changes while keeping attached clients; `close` withdraws it.
 * The exit hook unlinks the socket and sidecar on a normal process exit. A
 * client disconnect never reaches either unlink.
 */
export class RpcSessionSocket {
	readonly #options: RpcSessionSocketOptions;
	readonly #startedAt = Date.now();
	readonly #connections = new Set<SocketConnectionState>();
	readonly #exitHandler = (): void => this.#removeArtifactsSync();
	#listener: ListenerState | undefined;
	#createSurface: ((conn: RpcClientConn) => RpcSessionSocketSurface) | undefined;
	#unsubscribe: (() => void) | undefined;
	#exitHookInstalled = false;
	#tail: Promise<void> = Promise.resolve();
	#sequence = 0;
	#closed = false;
	#projectEvent: ((event: object, conn: RpcClientConn) => object | undefined) | undefined;

	constructor(options: RpcSessionSocketOptions) {
		if (typeof options?.identity !== "function") throw new TypeError("RpcSessionSocket requires an identity source");
		if (typeof options.subscribe !== "function") throw new TypeError("RpcSessionSocket requires a session source");
		if (!options.endpointDir) throw new TypeError("RPC session socket requires an endpoint directory");
		this.#options = options;
		this.#projectEvent = options.projectEvent;
	}

	/** Install or replace the per-connection broadcast projection. */
	setEventProjector(project: ((event: object, conn: RpcClientConn) => object | undefined) | undefined): void {
		this.#projectEvent = project;
	}

	get endpoint(): string | undefined {
		return this.#listener?.endpoint;
	}

	get sidecarPath(): string | undefined {
		return this.#listener?.sidecarPath;
	}

	listen(createSurface: (conn: RpcClientConn) => RpcSessionSocketSurface): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#closed) throw new Error("RPC session socket is closed");
			if (this.#createSurface) throw new Error("RPC session socket is already listening");
			await this.#start(createSurface);
			this.#createSurface = createSurface;
		});
	}

	/**
	 * Re-publish under the session's current id. Attached connections and the
	 * event subscription survive; only the endpoint and sidecar move. An
	 * unchanged id only refreshes the sidecar.
	 */
	rebind(): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#closed || !this.#createSurface) return;
			const identity = this.#options.identity();
			if (this.#listener?.endpoint === ipcEndpoint(this.#options.endpointDir, identity.sessionId)) {
				await writeSidecar(this.#listener.sidecarPath, this.#metadata(identity));
				return;
			}
			await this.#stopPublication();
			await this.#start(this.#createSurface as (conn: RpcClientConn) => RpcSessionSocketSurface);
		});
	}

	close(): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#closed) return;
			this.#closed = true;
			await this.#stopPublication();
			for (const state of Array.from(this.#connections)) {
				state.detached = true;
				this.#connections.delete(state);
				state.conn.close();
				try {
					state.surface?.close?.("RPC session socket closed");
				} catch (error) {
					logger.warn("RPC socket surface cleanup failed", { error: toError(error).message });
				}
				state.socket.destroy();
			}
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
			this.#createSurface = undefined;
		});
	}

	#enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(work, work);
		this.#tail = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	async #start(createSurface: (conn: RpcClientConn) => RpcSessionSocketSurface): Promise<void> {
		const identity = this.#options.identity();
		const directory = this.#options.endpointDir;
		await ensurePrivateDir(directory);
		const endpoint = ipcEndpoint(directory, identity.sessionId);
		const sidecarPath = path.join(directory, `${identity.sessionId}.json`);

		const server = await IpcServer.listen(
			endpoint,
			{ framing: "lines", maxFrameBytes: MAX_RPC_REASSEMBLED_BYTES },
			conn => this.#accept(conn, createSurface),
		);

		try {
			await writeSidecar(sidecarPath, this.#metadata(identity));
		} catch (error) {
			await server.close();
			removeFilesSync([endpoint, `${endpoint}.bind.lock`]);
			throw error;
		}

		this.#listener = { server, endpoint, sidecarPath, sessionId: identity.sessionId };
		this.#unsubscribe ??= this.#options.subscribe(event => this.#broadcast(event));
		if (!this.#exitHookInstalled) {
			process.once("exit", this.#exitHandler);
			this.#exitHookInstalled = true;
		}
	}

	async #stopPublication(): Promise<void> {
		const listener = this.#listener;
		this.#listener = undefined;
		if (!listener) return;
		if (this.#exitHookInstalled) {
			process.off("exit", this.#exitHandler);
			this.#exitHookInstalled = false;
		}
		unlinkOwnedSidecarSync(listener.sidecarPath);
		await listener.server.close();
		removeFilesSync([listener.endpoint, `${listener.endpoint}.bind.lock`]);
	}

	#metadata(identity: RpcSessionSocketIdentity): RpcSessionSocketMetadata {
		const terminal = this.#options.terminal?.();
		return {
			pid: process.pid,
			sessionId: identity.sessionId,
			sessionFile: identity.sessionFile ?? null,
			cwd: identity.cwd,
			agent: identity.agent,
			startedAt: this.#startedAt,
			...(terminal === undefined ? {} : { terminal }),
		};
	}

	#accept(socket: IpcConnection, createSurface: (conn: RpcClientConn) => RpcSessionSocketSurface): void {
		const conn = new RpcClientConnection({
			id: `socket-${++this.#sequence}`,
			// `state` is initialized before any frame can reach this sink: the
			// listener starts below, after the state object exists.
			send: frame => this.#send(state, frame),
		});
		const state: SocketConnectionState = {
			conn,
			socket,
			decoder: new RpcFrameDecoder(),
			encoder: new RpcFrameEncoder(),
			surface: undefined,
			detached: false,
		};
		this.#connections.add(state);
		// Lines can only be read once the native connection is started, but the client
		// must see `ready` first and never before the surface exists: hold early frames.
		const early: string[] = [];
		let live = false;
		socket.start(
			line => {
				if (live) this.#onLine(state, line);
				else early.push(line);
			},
			reason => this.#detach(state, reason ?? "RPC socket client disconnected"),
		);
		this.#send(state, READY_FRAME);
		state.surface = createSurface(conn);
		live = true;
		for (const line of early) this.#onLine(state, line);
	}

	#onLine(state: SocketConnectionState, line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			this.#send(state, this.#parseError(`Failed to parse command: ${toError(error).message}`));
			return;
		}
		let frame: object | undefined;
		try {
			frame = state.decoder.push(parsed);
		} catch (error) {
			this.#send(state, this.#parseError(toError(error).message));
			return;
		}
		if (!frame) return;
		try {
			state.surface?.dispatch(frame);
		} catch (error) {
			this.#send(state, this.#parseError(toError(error).message));
		}
	}

	#parseError(message: string): object {
		return { type: "response", command: "parse", success: false, error: message };
	}

	#send(state: SocketConnectionState, frame: object): void {
		if (this.#closed || state.detached || !state.conn.isOpen) return;
		try {
			for (const line of state.encoder.encodeFrames(frame)) {
				if (state.detached) return;
				state.socket.send(line.endsWith("\n") ? line.slice(0, -1) : line);
			}
		} catch (error) {
			logger.warn("RPC socket frame delivery failed", { error: toError(error).message });
			this.#detach(state, "RPC socket frame delivery failed");
			return;
		}
		if (
			isRecord(frame) &&
			frame.type === "response" &&
			frame.command === "negotiate_protocol" &&
			frame.success === true
		) {
			state.encoder.setProtocolVersion(2);
		}
	}

	#broadcast(event: object): void {
		if (this.#closed) return;
		const project = this.#projectEvent;
		for (const state of Array.from(this.#connections)) {
			if (!project) {
				this.#send(state, event);
				continue;
			}
			let projected: object | undefined;
			try {
				projected = project(event, state.conn);
			} catch (error) {
				logger.warn("RPC socket event projection failed", { error: toError(error).message });
				this.#send(state, event);
				continue;
			}
			if (projected !== undefined) this.#send(state, projected);
		}
	}

	#detach(state: SocketConnectionState, reason: string): void {
		if (state.detached) return;
		state.detached = true;
		this.#connections.delete(state);
		state.conn.close();
		try {
			state.surface?.close?.(reason);
		} catch (error) {
			logger.warn("RPC socket surface cleanup failed", { error: toError(error).message });
		}
	}

	#removeArtifactsSync(): void {
		const listener = this.#listener;
		if (!listener) return;
		unlinkOwnedSidecarSync(listener.sidecarPath);
		removeFilesSync([listener.endpoint, `${listener.endpoint}.bind.lock`]);
	}
}

/** Build the publication for one live session, under the configured session run directory. */
export function createAgentSessionSocket(
	session: AgentSession,
	options: { endpointDir?: string } = {},
): RpcSessionSocket {
	return new RpcSessionSocket({
		endpointDir: resolveSessionEndpointDir(options.endpointDir),
		identity: () => ({
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd: session.sessionManager.getCwd(),
			agent: session.model ? `${session.model.provider}/${session.model.id}` : "unknown",
		}),
		subscribe: listener => session.subscribe(event => listener(event)),
		terminal: () => {
			const context = sessionOwnerContext();
			return context === undefined ? undefined : { protocolVersion: 1, ...context };
		},
	});
}

async function writeSidecar(file: string, metadata: RpcSessionSocketMetadata): Promise<void> {
	const temporary = `${file}.tmp-${process.pid}`;
	const handle = await fs.promises.open(temporary, "w", 0o600);
	try {
		await handle.writeFile(JSON.stringify(metadata), "utf8");
	} finally {
		await handle.close();
	}
	try {
		await fs.promises.rename(temporary, file);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
}

/** Create the runtime directory owner-only; refuse to publish into a symlink or another user's directory. */
async function ensurePrivateDir(directory: string): Promise<void> {
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.promises.lstat(directory);
	if (stat.isSymbolicLink()) throw new Error(`RPC session socket directory is a symlink: ${directory}`);
	if (!stat.isDirectory()) throw new Error(`RPC session socket path is not a directory: ${directory}`);
	if (process.platform === "win32") return;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`RPC session socket directory is not owned by the current user: ${directory}`);
	}
	if ((stat.mode & 0o077) !== 0) await fs.promises.chmod(directory, 0o700);
}

/**
 * Unlink a sidecar this process wrote. Called before the listener closes, so a
 * successor with the same session id cannot have replaced it yet.
 */
function unlinkOwnedSidecarSync(file: string): void {
	try {
		const metadata = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
		if (metadata.pid !== process.pid) return;
	} catch {
		// Missing or unreadable: nothing this process can claim.
		return;
	}
	fs.rmSync(file, { force: true });
}

/** Unix files an endpoint leaves on disk: the socket and the native listener's bind lock. */
function removeFilesSync(files: string[]): void {
	for (const file of files) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Best-effort: the OS closes the endpoint on the next crash, and the next publisher recovers it.
		}
	}
}
