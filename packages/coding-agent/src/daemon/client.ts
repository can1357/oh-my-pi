import * as net from "node:net";
import { daemonEndpoint, daemonRuntimeDir, readOrCreateDaemonToken } from "./paths";
import {
	DAEMON_MAX_FRAME_BYTES,
	DAEMON_PROTOCOL_MAJOR,
	type DaemonEvent,
	type DaemonFrame,
	type DaemonHelloOk,
	type DaemonOperation,
	DaemonProtocolError,
	type DaemonServerStatus,
	type DaemonSnapshotFrame,
	decodeDaemonFrame,
	encodeDaemonFrame,
	parseDaemonServerStatus,
} from "./protocol";
import type { DaemonConnectionSnapshot, DaemonProfile, DaemonShard } from "./status";

const CONNECT_TIMEOUT_MS = 10_000;
const RECOVERY_COOLDOWN_MS = 5_000;

export type { DaemonConnectionSnapshot } from "./status";

export type DaemonClientOptions = {
	profile: DaemonProfile;
	runtimeDir?: string;
	endpoint?: string;
	token?: string;
	requestTimeoutMs?: number;
	connectTimeoutMs?: number;
	maxFrameBytes?: number;
	/** Request a replacement shard after an established connection becomes unavailable. */
	recoverUnavailable?: () => void;
};

type PendingRequest = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

function errorFromUnknown(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function openSocket(endpoint: string, timeoutMs: number): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection({ path: endpoint });
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`Timed out connecting to daemon at ${endpoint}`));
	}, timeoutMs);
	const cleanup = (): void => {
		clearTimeout(timer);
		socket.off("connect", onConnect);
		socket.off("error", onError);
	};
	const onConnect = (): void => {
		cleanup();
		resolve(socket);
	};
	const onError = (error: Error): void => {
		cleanup();
		socket.destroy();
		reject(error);
	};
	socket.once("connect", onConnect);
	socket.once("error", onError);
	return promise;
}

/** Persistent authenticated Unix-socket connection to one profile daemon. */
export class DaemonClient {
	readonly profile: DaemonProfile;
	readonly #runtimeDir: string;
	readonly #endpoint: string;
	readonly #tokenOverride: string | undefined;
	readonly #requestTimeoutMs: number;
	readonly #connectTimeoutMs: number;
	readonly #maxFrameBytes: number;
	readonly #recoverUnavailable: (() => void) | undefined;
	readonly #shard: DaemonShard;
	readonly #pending = new Map<string, PendingRequest>();
	#socket: net.Socket | undefined;
	#connectPromise: Promise<void> | undefined;
	#buffer = "";
	#handshake:
		| { requestId: string; resolve: (hello: DaemonHelloOk) => void; reject: (error: Error) => void }
		| undefined;
	#closed = false;
	#reconnectAttempt = 0;
	#snapshotListeners = new Set<(snapshot: DaemonConnectionSnapshot) => void>();
	#snapshotValue: DaemonConnectionSnapshot;
	#eventListeners = new Set<(event: DaemonEvent) => void>();
	#latestStatus: DaemonServerStatus | undefined;
	#snapshotFrameListeners = new Set<(frame: DaemonSnapshotFrame) => void>();
	#hello: DaemonHelloOk | undefined;
	#reconnectTimer: NodeJS.Timeout | undefined;
	#generation = 0;
	#writeChain: Promise<void> = Promise.resolve();
	#lastRecoveryRequestAt = 0;

	constructor(options: DaemonClientOptions) {
		this.profile = options.profile;
		this.#shard = { profile: this.profile };
		this.#runtimeDir = options.runtimeDir ?? daemonRuntimeDir();
		this.#endpoint = options.endpoint ?? daemonEndpoint(this.#runtimeDir);
		this.#tokenOverride = options.token;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
		this.#maxFrameBytes = options.maxFrameBytes ?? DAEMON_MAX_FRAME_BYTES;
		this.#recoverUnavailable = options.recoverUnavailable;
		this.#snapshotValue = { state: "unavailable", shard: this.#shard };
	}

	get snapshot(): DaemonConnectionSnapshot {
		return this.#snapshotValue;
	}
	get runtimeDir(): string {
		return this.#runtimeDir;
	}

	get endpoint(): string {
		return this.#endpoint;
	}

	/** Whether close() was called; a closed client never reconnects. */
	get closed(): boolean {
		return this.#closed;
	}

	/** Build pairing identity from the daemon's hello; undefined until connected or on pre-stamp daemons. */
	get serverBuildStamp(): string | undefined {
		return this.#hello?.buildStamp;
	}

	onSnapshot(listener: (snapshot: DaemonConnectionSnapshot) => void): () => void {
		this.#snapshotListeners.add(listener);
		return () => this.#snapshotListeners.delete(listener);
	}
	/** Subscribe to ordered snapshot frames for remote session replay. */
	onSnapshotFrame(listener: (frame: DaemonSnapshotFrame) => void): () => void {
		this.#snapshotFrameListeners.add(listener);
		return () => this.#snapshotFrameListeners.delete(listener);
	}
	/** Subscribe to ordered session events. */
	onEvent(listener: (event: DaemonEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	async connect(): Promise<void> {
		if (this.#closed) throw new Error("Daemon client is closed");
		if (this.#socket && !this.#socket.destroyed && this.#hello) return;
		if (this.#connectPromise) return this.#connectPromise;
		this.#setSnapshot({
			state: this.#reconnectAttempt === 0 ? "connecting" : "reconnecting",
			shard: this.#shard,
			...(this.#reconnectAttempt === 0 ? {} : { attempt: this.#reconnectAttempt }),
		});
		this.#connectPromise = this.#connectOnce();
		try {
			await this.#connectPromise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async reconnect(): Promise<void> {
		if (this.#closed) throw new Error("Daemon client is closed");
		this.#reconnectAttempt++;
		this.#generation++;
		this.#rejectPending(new Error("Daemon connection replaced"));
		this.#handshake?.reject(new Error("Daemon connection replaced"));
		this.#handshake = undefined;
		const oldSocket = this.#socket;
		this.#socket = undefined;
		this.#hello = undefined;
		oldSocket?.destroy();
		await this.connect();
	}

	async request(
		operation: DaemonOperation["op"] | DaemonOperation,
		payload: Record<string, unknown> = {},
	): Promise<unknown> {
		if (this.#closed) throw new Error("Daemon client is closed");
		await this.connect();
		const socket = this.#socket;
		if (!socket || socket.destroyed || !this.#hello) throw new Error("Daemon socket is unavailable");
		const normalized = typeof operation === "string" ? { op: operation, ...payload } : operation;
		const requestId = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			const pending = this.#pending.get(requestId);
			if (!pending) return;
			this.#pending.delete(requestId);
			this.#replaceUnresponsiveSocket(socket);
			pending.reject(
				new Error(`Daemon ${typeof operation === "string" ? operation : operation.op} request timed out`),
			);
		}, this.#requestTimeoutMs);
		this.#pending.set(requestId, { resolve, reject, timer });
		try {
			await this.#writeFrame(socket, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "request",
				requestId,
				operation: normalized as DaemonOperation,
			});
		} catch (error) {
			clearTimeout(timer);
			this.#pending.delete(requestId);
			reject(errorFromUnknown(error));
		}
		return promise;
	}

	async serverStatus(): Promise<DaemonServerStatus> {
		const status = parseDaemonServerStatus(await this.request("server_status"));
		this.#latestStatus = status;
		this.#applyStatus(status);
		return status;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#generation++;
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#hello = undefined;
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.destroy();
		this.#rejectPending(new Error("Daemon client closed"));
		this.#handshake?.reject(new Error("Daemon client closed"));
		this.#handshake = undefined;
		this.#setSnapshot({ state: "unavailable", shard: this.#shard });
	}

	async #connectOnce(): Promise<void> {
		const generation = this.#generation;
		this.#latestStatus = undefined;
		if (this.#closed) throw new Error("Daemon client is closed");
		const token = this.#tokenOverride ?? (await readOrCreateDaemonToken(this.#runtimeDir));
		if (this.#closed || generation !== this.#generation) throw new Error("Daemon client is closed");
		let socket: net.Socket;
		try {
			socket = await openSocket(this.#endpoint, this.#connectTimeoutMs);
		} catch (error) {
			if (!this.#closed && generation === this.#generation)
				this.#setSnapshot({ state: "unavailable", shard: this.#shard });
			throw errorFromUnknown(error);
		}
		if (this.#closed || generation !== this.#generation) {
			socket.destroy();
			throw new Error("Daemon client is closed");
		}
		this.#bindSocket(socket);
		const requestId = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<DaemonHelloOk>();
		const handshake = { requestId, resolve, reject };
		this.#handshake = handshake;
		// The timer must cover the hello WRITE as well as the response wait: a
		// connection accepted into a closing listener's backlog never gets read,
		// erred, or closed by the peer, so an unguarded write parks forever
		// (found via a daemon-replacement race). Timeout destroys the socket,
		// which also unsticks a parked write via its close event.
		const handshakeTimer = setTimeout(() => {
			if (this.#handshake === handshake) handshake.reject(new Error("Timed out waiting for daemon hello"));
			socket.destroy();
		}, this.#connectTimeoutMs);
		// The write path can throw before the hello response is awaited; keep an
		// observer on the handshake promise so its rejection is never unhandled.
		promise.catch(() => undefined);
		try {
			await this.#writeFrame(socket, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "hello",
				requestId,
				profile: this.profile,
				token,
			});
			const hello = await promise;
			clearTimeout(handshakeTimer);
			if (this.#closed || generation !== this.#generation) throw new Error("Daemon client is closed");
			if (hello.requestId !== requestId)
				throw new DaemonProtocolError("invalid_frame", "hello response correlation mismatch");
			if (hello.protocolVersion !== DAEMON_PROTOCOL_MAJOR) {
				this.#setSnapshot({
					state: "incompatible",
					shard: this.#shard,
					clientVersion: String(DAEMON_PROTOCOL_MAJOR),
					serverVersion: hello.serverVersion,
				});
				throw new Error(`incompatible protocol: server major ${hello.protocolVersion}`);
			}
			if (hello.shard.profile !== this.profile) throw new Error("daemon profile scope mismatch");
			this.#hello = hello;
			if (hello.capabilities.includes("server_status")) {
				this.#latestStatus = await this.serverStatus();
			}
			this.#reconnectAttempt = 0;
			this.#setSnapshot({
				state: "connected",
				shard: hello.shard,
				daemonId: hello.daemonId,
				serverVersion: hello.serverVersion,
				protocolVersion: hello.protocolVersion,
				sessionCount: this.#latestStatus?.sessionCount ?? 0,
				attachmentCount: this.#latestStatus?.attachmentCount ?? 0,
				protectedJobCount: this.#latestStatus?.protectedJobCount ?? 0,
				uptimeMs: this.#latestStatus?.uptimeMs ?? 0,
			});
		} catch (error) {
			this.#handshake = undefined;
			if (this.#socket === socket) this.#socket = undefined;
			socket.destroy();
			if (!this.#closed && generation === this.#generation && this.#snapshotValue.state !== "incompatible")
				this.#setSnapshot({ state: "unavailable", shard: this.#shard });
			throw errorFromUnknown(error);
		} finally {
			clearTimeout(handshakeTimer!);
			if (this.#handshake === handshake) this.#handshake = undefined;
		}
	}

	#bindSocket(socket: net.Socket): void {
		this.#socket = socket;
		this.#buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
		socket.on("error", () => undefined);
		socket.on("close", () => {
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			this.#hello = undefined;
			if (this.#handshake) this.#handshake.reject(new Error("Daemon connection closed"));
			this.#handshake = undefined;
			this.#rejectPending(new Error("Daemon connection closed"));
			if (!this.#closed) {
				this.#reconnectAttempt++;
				this.#scheduleReconnect();
			}
		});
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxFrameBytes && !this.#buffer.includes("\n")) {
			const error = new DaemonProtocolError("invalid_frame", "frame exceeds maximum size");
			this.#handshake?.reject(error);
			this.#rejectPending(error);
			this.#socket?.destroy();
			return;
		}
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.length === 0) continue;
			let frame: DaemonFrame;
			try {
				if (Buffer.byteLength(line, "utf8") > this.#maxFrameBytes)
					throw new DaemonProtocolError("invalid_frame", "frame exceeds maximum size");
				frame = decodeDaemonFrame(line);
			} catch (error) {
				const parsed = errorFromUnknown(error);
				this.#handshake?.reject(parsed);
				this.#rejectPending(parsed);
				this.#socket?.destroy();
				continue;
			}
			this.#dispatch(frame);
		}
	}

	#scheduleReconnect(): void {
		if (this.#closed || this.#reconnectTimer) return;
		const attempt = Math.max(1, this.#reconnectAttempt);
		const delay = Math.min(5_000, 100 * 2 ** Math.min(attempt - 1, 6));
		this.#setSnapshot({ state: "reconnecting", shard: this.#shard, attempt });
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			void this.connect().catch(() => {
				this.#requestRecovery();
				this.#scheduleReconnect();
			});
		}, delay);
	}

	#replaceUnresponsiveSocket(socket: net.Socket): void {
		if (this.#closed || this.#socket !== socket || socket.destroyed) return;
		this.#requestRecovery();
		this.#setSnapshot({
			state: "reconnecting",
			shard: this.#shard,
			attempt: Math.max(1, this.#reconnectAttempt + 1),
		});
		socket.destroy();
	}

	#requestRecovery(): void {
		if (!this.#recoverUnavailable) return;
		const now = Date.now();
		if (now - this.#lastRecoveryRequestAt < RECOVERY_COOLDOWN_MS) return;
		this.#lastRecoveryRequestAt = now;
		try {
			this.#recoverUnavailable();
		} catch {
			// The bounded reconnect loop retries and may request recovery again.
		}
	}

	async #writeFrame(socket: net.Socket, frame: DaemonFrame): Promise<void> {
		const line = encodeDaemonFrame(frame);
		const write = async (): Promise<void> => {
			if (this.#closed || this.#socket !== socket || socket.destroyed)
				throw new Error("Daemon socket is unavailable");
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const cleanup = (): void => {
					socket.off("error", onError);
					socket.off("close", onClose);
					socket.off("drain", onDrain);
				};
				const finish = (): void => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve();
				};
				const onError = (error: Error): void => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				};
				const onClose = (): void => onError(new Error("Daemon connection closed"));
				const onDrain = (): void => finish();
				socket.once("error", onError);
				socket.once("close", onClose);
				const accepted = socket.write(line, () => {
					if (accepted) finish();
				});
				if (!accepted) socket.once("drain", onDrain);
			});
		};
		const pending = this.#writeChain.then(write, write);
		this.#writeChain = pending.catch(() => undefined);
		return pending;
	}

	#dispatch(frame: DaemonFrame): void {
		if (frame.tag === "hello_ok") {
			this.#handshake?.resolve(frame);
			return;
		}
		if (frame.tag === "event") {
			for (const listener of this.#eventListeners) listener(frame);
			return;
		}
		if (
			frame.tag === "snapshot_begin" ||
			frame.tag === "snapshot_chunk" ||
			frame.tag === "snapshot_end" ||
			frame.tag === "snapshot_restart"
		) {
			for (const listener of this.#snapshotFrameListeners) listener(frame);
			return;
		}
		if (frame.tag === "server_status") {
			this.#applyStatus(frame.status);
			return;
		}
		if (frame.tag === "response" && this.#handshake?.requestId === frame.requestId) {
			if (frame.ok)
				this.#handshake.reject(new DaemonProtocolError("invalid_frame", "hello response must be hello_ok"));
			else this.#handshake.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
			return;
		}
		if (frame.tag !== "response") return;
		const pending = this.#pending.get(frame.requestId);
		if (!pending) return;
		this.#pending.delete(frame.requestId);
		clearTimeout(pending.timer);
		if (frame.ok) pending.resolve(frame.result);
		else pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
	}

	#applyStatus(status: DaemonServerStatus): void {
		this.#latestStatus = status;
		const current = this.#snapshotValue;
		if (current.state === "connected")
			this.#setSnapshot({ ...current, ...status, state: "connected", shard: current.shard });
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#setSnapshot(snapshot: DaemonConnectionSnapshot): void {
		this.#snapshotValue = snapshot;
		for (const listener of this.#snapshotListeners) listener(snapshot);
	}
}

export type CreateDaemonClientOptions = DaemonClientOptions;

export async function createDaemonClient(options: CreateDaemonClientOptions): Promise<DaemonClient> {
	return new DaemonClient(options);
}
