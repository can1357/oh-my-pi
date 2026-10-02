import * as fs from "node:fs/promises";
import * as net from "node:net";
import { logger, postmortem, withFileLock } from "@oh-my-pi/pi-utils";
import { LineParser, writeJsonLine } from "./jsonl-socket";
import type { TinyWorkerRequest, TinyWorkerResponse } from "./title-protocol";

const SHUTDOWN_BUDGET_MS = 2_000;

/** Writes one JSON line back to the connection a request arrived on. */
export interface JsonLineReply<Res> {
	send(message: Res): void;
}

export interface JsonLineServerOptions<Req, Res> {
	/** Log scope. */
	name: string;
	/** `postmortem` cleanup label. */
	cleanupLabel: string;
	/** Subject of the "already listening" bind error. */
	subject: string;
	/** Idle window (nothing {@link JsonLineServer.busy}, no request received) after which the process exits. */
	idleMs: number;
	/** Stdout line announcing the bound endpoint. */
	banner(endpoint: string): string;
	/** Handle one parsed request line; `reply` reaches only the requesting connection. */
	onRequest(request: Req, reply: JsonLineReply<Res>): void;
	/** Runs synchronously as stop begins, before connections and the listener close. */
	beforeStop?(): void;
	/** Runs once during stop, after the listener closes and before the socket file is removed. */
	onStop?(): Promise<void>;
}

/**
 * Socket-owning newline-JSON request loop (`mlx-server.py` mirrors it in Python).
 * Owns one endpoint: clears a stale socket file under a file lock (a crashed
 * predecessor) but defers to a live one (a concurrent spawn that won), feeds
 * every connection's request lines to `onRequest`, and exits the process once idle.
 */
export class JsonLineServer<Req, Res> {
	#options: JsonLineServerOptions<Req, Res>;
	#connections = new Set<net.Socket>();
	#inFlight = 0;
	#idleTimer: NodeJS.Timeout | undefined;
	#server: net.Server | undefined;
	#endpoint = "";
	#stopped = Promise.withResolvers<void>();
	#stopping: Promise<void> | undefined;

	constructor(options: JsonLineServerOptions<Req, Res>) {
		this.#options = options;
	}

	/** Bind `endpoint` and serve until idle exit or {@link exit}; resolves once the socket is released. */
	async serve(endpoint: string): Promise<void> {
		this.#endpoint = endpoint;
		if (process.platform !== "win32") {
			await withFileLock(`${endpoint}.bind`, async () => {
				await this.#clearStaleSocket(endpoint);
				await this.#listen(endpoint);
			});
		} else {
			await this.#listen(endpoint);
		}
		const cancelCleanup = postmortem.register(this.#options.cleanupLabel, () => this.#shutdown());
		this.#armIdle();
		process.stdout.write(`${this.#options.banner(endpoint)}\n`);
		try {
			await this.#stopped.promise;
		} finally {
			cancelCleanup();
		}
	}

	/** Count `work` as in flight, holding off idle exit until it settles. */
	async busy<T>(work: () => Promise<T>): Promise<T> {
		this.#inFlight += 1;
		this.#armIdle();
		try {
			return await work();
		} finally {
			this.#inFlight -= 1;
			this.#armIdle();
		}
	}

	/** Release the endpoint, then exit the process. */
	exit(reason: string): void {
		logger.debug(`${this.#options.name}: ${reason}; exiting`, { endpoint: this.#endpoint });
		void this.#shutdown().finally(() => process.exit(0));
	}

	#listen(endpoint: string): Promise<void> {
		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.off("error", reject);
			resolve();
		});
		return promise;
	}

	async #clearStaleSocket(endpoint: string): Promise<void> {
		try {
			await fs.stat(endpoint);
		} catch {
			return;
		}
		if (await endpointAlive(endpoint)) throw new Error(`${this.#options.subject} already listening on ${endpoint}`);
		await fs.unlink(endpoint);
	}

	#accept(socket: net.Socket): void {
		this.#connections.add(socket);
		socket.setEncoding("utf-8");
		const reply: JsonLineReply<Res> = { send: message => writeJsonLine(socket, message) };
		const parser = new LineParser(line => {
			let request: Req;
			try {
				request = JSON.parse(line) as Req;
			} catch (error) {
				logger.warn(`${this.#options.name}: malformed request line`, { error: String(error) });
				return;
			}
			this.#options.onRequest(request, reply);
		});
		socket.on("data", (chunk: string) => parser.push(chunk));
		socket.on("error", () => {
			// "close" always follows.
		});
		socket.once("close", () => this.#connections.delete(socket));
	}

	#armIdle(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			if (this.#inFlight > 0) {
				this.#armIdle();
				return;
			}
			this.exit(`idle for ${this.#options.idleMs}ms`);
		}, this.#options.idleMs);
	}

	#shutdown(): Promise<void> {
		this.#stopping ??= this.#stop();
		return this.#stopping;
	}

	async #stop(): Promise<void> {
		clearTimeout(this.#idleTimer);
		this.#options.beforeStop?.();
		// `server.close` only completes once every connection is gone; clients reconnect on demand.
		for (const socket of this.#connections) socket.destroy();
		this.#connections.clear();
		const server = this.#server;
		this.#server = undefined;
		if (server) {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await Promise.race([closed.promise, Bun.sleep(SHUTDOWN_BUDGET_MS)]);
		}
		await this.#options.onStop?.();
		if (process.platform !== "win32") {
			try {
				await fs.unlink(this.#endpoint);
			} catch {
				// Already removed.
			}
		}
		this.#stopped.resolve();
	}
}

export interface TinyWorkerServerOptions {
	/** Launch identity echoed in `pong`; clients replace a worker whose tag differs. */
	tag: string;
	/** Idle window (nothing in flight, no request received) after which the process exits. */
	idleMs: number;
	/** Serve one `load`/`chat`/`judge`; `reply.send` reaches only the requesting client. Errors become `error` replies. */
	handle(
		request: Extract<TinyWorkerRequest, { type: "load" | "chat" | "judge" }>,
		reply: JsonLineReply<TinyWorkerResponse>,
	): Promise<void>;
}

/** The ONNX worker's endpoint: answers `ping`/`shutdown` inline and serializes `load`/`chat` through one queue. */
export class TinyWorkerServer {
	#options: TinyWorkerServerOptions;
	#queue = Promise.resolve();
	#server: JsonLineServer<TinyWorkerRequest, TinyWorkerResponse>;

	constructor(options: TinyWorkerServerOptions) {
		this.#options = options;
		this.#server = new JsonLineServer({
			name: "tiny-worker",
			cleanupLabel: "tiny-worker",
			subject: "tiny worker",
			idleMs: options.idleMs,
			banner: endpoint => `omp tiny worker listening on ${endpoint}`,
			onRequest: (request, reply) => this.#dispatch(request, reply),
		});
	}

	/** Bind `endpoint` and serve until idle exit or `shutdown`; resolves once the socket is released. */
	serve(endpoint: string): Promise<void> {
		return this.#server.serve(endpoint);
	}

	#dispatch(request: TinyWorkerRequest, reply: JsonLineReply<TinyWorkerResponse>): void {
		if (request.type === "ping") {
			reply.send({ type: "pong", id: request.id, tag: this.#options.tag });
			return;
		}
		if (request.type === "shutdown") {
			this.#server.exit("shutdown requested");
			return;
		}
		const run = async (): Promise<void> => {
			try {
				await this.#options.handle(request, reply);
			} catch (error) {
				reply.send({
					type: "error",
					id: request.id,
					error: error instanceof Error ? (error.stack ?? error.message) : String(error),
				});
			}
		};
		this.#queue = this.#server.busy(() => this.#queue.then(run, run));
	}
}

/** True when something accepts a connection at `endpoint`. */
export function endpointAlive(endpoint: string): Promise<boolean> {
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
