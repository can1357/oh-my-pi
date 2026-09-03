import * as fs from "node:fs/promises";
import * as net from "node:net";
import { logger, postmortem, withFileLock } from "@oh-my-pi/pi-utils";
import { LineParser, writeJsonLine } from "./jsonl-socket";
import type { TinyWorkerRequest, TinyWorkerResponse } from "./title-protocol";

/** Socket-owning request loop shared by the ONNX worker (`mlx-server.py` mirrors it in Python). */

const SHUTDOWN_BUDGET_MS = 2_000;

export interface TinyWorkerServerOptions {
	/** Launch identity echoed in `pong`; clients replace a worker whose tag differs. */
	tag: string;
	/** Idle window (nothing in flight, no request received) after which the process exits. */
	idleMs: number;
	/** Serve one `load`/`chat`; `reply.send` reaches only the requesting client. Errors become `error` replies. */
	handle(
		request: Extract<TinyWorkerRequest, { type: "load" | "chat" }>,
		reply: { send(message: TinyWorkerResponse): void },
	): Promise<void>;
}

/**
 * Owns one endpoint: clears a stale socket file under a file lock (a crashed
 * predecessor) but defers to a live one (a concurrent spawn that won), serves
 * every connection with requests serialized through one queue, and exits the
 * process once idle or on a `shutdown` request.
 */
export class TinyWorkerServer {
	#options: TinyWorkerServerOptions;
	#connections = new Set<net.Socket>();
	#queue = Promise.resolve();
	#inFlight = 0;
	#idleTimer: NodeJS.Timeout | undefined;
	#server: net.Server | undefined;
	#endpoint = "";
	#stopped = Promise.withResolvers<void>();

	constructor(options: TinyWorkerServerOptions) {
		this.#options = options;
	}

	/** Bind `endpoint` and serve until idle exit or `shutdown`; resolves once the socket is released. */
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
		const cancelCleanup = postmortem.register("tiny-worker", () => this.#shutdown());
		this.#armIdle();
		process.stdout.write(`omp tiny worker listening on ${endpoint}\n`);
		try {
			await this.#stopped.promise;
		} finally {
			cancelCleanup();
		}
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
		if (await endpointAlive(endpoint)) throw new Error(`tiny worker already listening on ${endpoint}`);
		await fs.unlink(endpoint);
	}

	#accept(socket: net.Socket): void {
		this.#connections.add(socket);
		socket.setEncoding("utf-8");
		const reply = { send: (message: TinyWorkerResponse): void => writeJsonLine(socket, message) };
		const parser = new LineParser(line => {
			let request: TinyWorkerRequest;
			try {
				request = JSON.parse(line) as TinyWorkerRequest;
			} catch (error) {
				logger.warn("tiny-worker: malformed request line", { error: String(error) });
				return;
			}
			this.#dispatch(request, reply);
		});
		socket.on("data", (chunk: string) => parser.push(chunk));
		socket.on("error", () => {
			// "close" always follows.
		});
		socket.once("close", () => this.#connections.delete(socket));
	}

	#dispatch(request: TinyWorkerRequest, reply: { send(message: TinyWorkerResponse): void }): void {
		if (request.type === "ping") {
			reply.send({ type: "pong", id: request.id, tag: this.#options.tag });
			return;
		}
		if (request.type === "shutdown") {
			logger.debug("tiny-worker: shutdown requested", { endpoint: this.#endpoint });
			void this.#shutdown().finally(() => process.exit(0));
			return;
		}
		this.#inFlight += 1;
		this.#armIdle();
		const run = async (): Promise<void> => {
			try {
				await this.#options.handle(request, reply);
			} catch (error) {
				reply.send({
					type: "error",
					id: request.id,
					error: error instanceof Error ? (error.stack ?? error.message) : String(error),
				});
			} finally {
				this.#inFlight -= 1;
				this.#armIdle();
			}
		};
		this.#queue = this.#queue.then(run, run);
	}

	#armIdle(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			if (this.#inFlight > 0) {
				this.#armIdle();
				return;
			}
			logger.debug("tiny-worker: idle; exiting", { endpoint: this.#endpoint, idleMs: this.#options.idleMs });
			void this.#shutdown().finally(() => process.exit(0));
		}, this.#options.idleMs);
	}

	async #shutdown(): Promise<void> {
		clearTimeout(this.#idleTimer);
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
