/**
 * Client for the ovnfs daemon's admin socket.
 *
 * The protocol frames JSON objects with a little-endian u32 length: the client
 * says `{"hello": {...}}` and gets `{"welcome": {version, ops, ...}}`, then each
 * `{"id": N, "<op>": {args}}` is answered by `{"id": N, "ok": reply}` or
 * `{"id": N, "error": {code, message}}`, in any order. `{"cancel": N}` asks the
 * daemon to stop request N; the request then ends with error code `canceled`.
 *
 * Every call to one socket shares a single connection, opened on first use and
 * reopened after the daemon goes away. It does not keep the process alive
 * while no call is in flight.
 *
 * @example
 * const reply = await callSocket<{ total: number }>(socket, "glob", { dir, pattern: "*.ts" }, signal);
 */
import * as net from "node:net";
import { isRecord, untilAborted } from "@oh-my-pi/pi-utils";

/** The ovnfs admin protocol generation this client speaks. */
export const PROTOCOL_VERSION = 5;

/** A failure the ovnfs daemon reported, e.g. `not_found` or `exists`. */
export class OvnfsError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`ovnfs: ${code}: ${message}`);
		this.name = "OvnfsError";
	}
}

/** Encode one protocol frame. */
function frame(value: object): Buffer {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
}

/** A call waiting for its reply. */
interface Pending {
	resolve(value: unknown): void;
	reject(reason: unknown): void;
}

/** An authenticated connection to one daemon, multiplexing calls by request id. */
class Connection {
	readonly #conn: net.Socket;
	readonly #socket: string;
	readonly #onClose: () => void;
	readonly #ready = Promise.withResolvers<this>();
	readonly #pending = new Map<number, Pending>();
	#waiters = 0;
	#ops: ReadonlySet<string> | undefined;
	#features: ReadonlySet<string> = new Set();
	#next = 1;
	#chunks: Buffer[] = [];
	#buffered = 0;
	#frameLength = -1;
	#closed: Error | undefined;

	constructor(socket: string, onClose: () => void) {
		this.#socket = socket;
		this.#onClose = onClose;
		this.#ready.promise.catch(() => {});
		this.#conn = net.createConnection({ path: socket });
		this.#conn.unref();
		this.#conn.on("connect", () => this.#conn.write(frame({ hello: { client: "omp" } })));
		this.#conn.on("data", (chunk: Buffer) => this.#receive(chunk));
		this.#conn.on("error", err => this.#close(err));
		this.#conn.on("close", () => this.#close(new Error(`ovnfs at ${socket} closed the connection`)));
	}

	/**
	 * Resolves once the daemon has welcomed this client on {@link PROTOCOL_VERSION},
	 * or rejects with `signal.reason` once `signal` aborts.
	 */
	ready(signal?: AbortSignal): Promise<this> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.#closed) return Promise.reject(this.#closed);
		if (this.#ops) return Promise.resolve(this);
		this.#waiters++;
		this.#conn.ref();
		return untilAborted(signal, this.#ready.promise).then(
			conn => {
				this.#waiters--;
				this.#idle();
				return conn;
			},
			err => {
				this.#waiters--;
				this.#idle();
				throw signal?.aborted ? signal.reason : err;
			},
		);
	}

	/** Optional request fields the daemon said it honors (`api.Features`), e.g. `diff.binary`. */
	get features(): ReadonlySet<string> {
		return this.#features;
	}

	/**
	 * Run `op`. Aborting `signal` sends `{"cancel": id}` and rejects with
	 * `signal.reason` at once; the connection stays open for other calls.
	 */
	call(op: string, args: object, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.#closed) return Promise.reject(this.#closed);
		if (!this.#ops?.has(op)) {
			return Promise.reject(new Error(`ovnfs at ${this.#socket} does not serve ${op}`));
		}
		const id = this.#next++;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const onAbort = () => {
			if (!this.#pending.delete(id)) return;
			this.#idle();
			if (!this.#closed) this.#conn.write(frame({ cancel: id }));
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pending.set(id, {
			resolve: value => {
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			},
			reject: reason => {
				signal?.removeEventListener("abort", onAbort);
				reject(reason);
			},
		});
		this.#conn.ref();
		this.#conn.write(frame({ id, [op]: args }));
		return promise;
	}

	/**
	 * Close an unfinished connection once no caller is waiting on it; once
	 * welcomed, let the process exit while no call is in flight.
	 */
	#idle(): void {
		if (this.#waiters > 0 || this.#pending.size > 0) return;
		if (!this.#ops) {
			this.#close(new Error(`ovnfs at ${this.#socket} closed before welcome`));
			return;
		}
		this.#conn.unref();
	}

	#close(err: Error): void {
		if (this.#closed) return;
		this.#closed = err;
		this.#onClose();
		this.#conn.destroy();
		this.#ready.reject(err);
		for (const pending of this.#pending.values()) pending.reject(err);
		this.#pending.clear();
	}

	/** Split the byte stream into frames, copying each byte about once. */
	#receive(chunk: Buffer): void {
		this.#chunks.push(chunk);
		this.#buffered += chunk.length;
		for (;;) {
			if (this.#frameLength < 0) {
				if (this.#buffered < 4) return;
				this.#frameLength = this.#take(4).readUInt32LE(0);
			}
			if (this.#buffered < this.#frameLength) return;
			const body = this.#take(this.#frameLength);
			this.#frameLength = -1;
			let message: unknown;
			try {
				message = JSON.parse(body.toString("utf8"));
			} catch (err) {
				this.#close(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			if (isRecord(message)) this.#dispatch(message);
		}
	}

	#take(n: number): Buffer {
		const all = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#buffered);
		const rest = all.subarray(n);
		this.#chunks = rest.length > 0 ? [rest] : [];
		this.#buffered = rest.length;
		return all.subarray(0, n);
	}

	#dispatch(message: Record<string, unknown>): void {
		if (!this.#ops) {
			const welcome = message.welcome;
			if (!isRecord(welcome) || welcome.version !== PROTOCOL_VERSION || !Array.isArray(welcome.ops)) {
				this.#close(new Error(`ovnfs at ${this.#socket} does not speak admin protocol ${PROTOCOL_VERSION}`));
				return;
			}
			this.#ops = new Set(welcome.ops.filter(op => typeof op === "string"));
			if (Array.isArray(welcome.features))
				this.#features = new Set(welcome.features.filter(feature => typeof feature === "string"));
			this.#ready.resolve(this);
			this.#idle();
			return;
		}
		const id = message.id;
		if (typeof id !== "number") return; // an event
		const pending = this.#pending.get(id);
		if (!pending) return; // a late reply to a cancelled call
		this.#pending.delete(id);
		this.#idle();
		const error = message.error;
		if (isRecord(error)) pending.reject(new OvnfsError(String(error.code), String(error.message)));
		else pending.resolve(message.ok);
	}
}

/** Open connections by socket path. */
const connections = new Map<string, Connection>();

/** The shared connection to `socket`, opened (or reopened) on demand. */
function connection(socket: string, signal?: AbortSignal): Promise<Connection> {
	signal?.throwIfAborted();
	let conn = connections.get(socket);
	if (!conn) {
		const opened = new Connection(socket, () => {
			if (connections.get(socket) === opened) connections.delete(socket);
		});
		connections.set(socket, opened);
		conn = opened;
	}
	return conn.ready(signal);
}

/**
 * Run `op` on the daemon at `socket` over the shared connection. Rejects with
 * {@link OvnfsError} for a daemon error, with the socket error (e.g.
 * `ECONNREFUSED`, `ENOENT`) when it cannot connect, and with `signal.reason`
 * once `signal` aborts (the daemon is told to cancel).
 */
export async function callSocket<T>(socket: string, op: string, args: object, signal?: AbortSignal): Promise<T> {
	const conn = await connection(socket, signal);
	// Replies are the daemon's api shapes; callers name the one their op returns.
	return conn.call(op, args, signal) as Promise<T>;
}

/** The optional request fields the daemon at `socket` honors; empty for one that names none. */
export async function socketFeatures(socket: string): Promise<ReadonlySet<string>> {
	return (await connection(socket)).features;
}
