import * as fs from "node:fs";
import * as path from "node:path";
import { isBunTestRuntime, logger } from "@pk-nerdsaver-ai/pi-utils";
import type { Socket } from "bun";
import { NdjsonLineBuffer } from "./shared-worker-client";
import { spawnLockPath } from "./shared-worker-config";

/**
 * Daemon side of the shared inference worker. One process per worker kind
 * hosts the exact `start(transport)` function the IPC subprocess ran, but in
 * front of a Unix socket that multiplexes many ompk instances:
 *
 * - request ids are rewritten to `${clientSeq}:${originalId}` on the way in
 *   and restored on the way out, so each client's independent id counter
 *   never collides with another's;
 * - `log` messages (no id) are broadcast to every connected client;
 * - responses for a client that has since disconnected are dropped;
 * - with zero clients the process SIGKILLs itself after `idleMs` (hard kill on
 *   purpose: onnxruntime-node's NAPI finalizer must never run — see cli.ts).
 */
export const TINY_DAEMON_ARG = "__omp_daemon_tiny_inference";
export const MNEMOPI_EMBED_DAEMON_ARG = "__omp_daemon_mnemopi_embed";

/** Transport a worker `start` function drives; identical to the IPC worker contract in cli.ts. */
export interface WorkerTransport<In, Out> {
	send(message: Out): void;
	onMessage(handler: (message: In) => void): () => void;
}

export type WorkerStart<In, Out> = (transport: WorkerTransport<In, Out>) => void;

type Identified = { type: string; id?: unknown };

/** Split a daemon-internal id back into its client sequence and the client's original id. */
export function splitDaemonId(id: string): { clientSeq: number; originalId: string } | undefined {
	const colon = id.indexOf(":");
	if (colon <= 0) return undefined;
	const clientSeq = Number.parseInt(id.slice(0, colon), 10);
	if (!Number.isFinite(clientSeq)) return undefined;
	return { clientSeq, originalId: id.slice(colon + 1) };
}

export interface SocketDaemonOptions {
	/** Test seam: replace the SIGKILL-on-idle with an observable callback. */
	onIdleExit?: () => void;
}

/**
 * Bind `socketPath`, host `start`, and never return. Exits 0 immediately when
 * the bind fails (another daemon won the spawn race — the spawner's connect
 * loop finds the winner).
 */
export async function runSocketDaemonWorker<In extends Identified, Out extends Identified>(
	socketPath: string,
	start: WorkerStart<In, Out>,
	idleMs: number,
	options: SocketDaemonOptions = {},
): Promise<never> {
	fs.mkdirSync(path.dirname(socketPath), { recursive: true });

	const clients = new Map<number, { socket: Socket<number>; lines: NdjsonLineBuffer }>();
	const inboundHandlers = new Set<(message: In) => void>();
	let nextClientSeq = 0;
	let idleTimer: Timer | undefined;

	const removeSocketFile = (): void => {
		try {
			fs.rmSync(socketPath, { force: true });
		} catch {
			// Still bound on some platforms; the next spawner's stale-file cleanup handles it.
		}
	};
	const exitIdle = (): void => {
		if (options.onIdleExit) {
			options.onIdleExit();
			return;
		}
		logger.debug("worker-daemon: idle exit", { socketPath, idleMs });
		removeSocketFile();
		process.kill(process.pid, "SIGKILL");
	};
	const armIdle = (): void => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(exitIdle, idleMs);
		if (isBunTestRuntime()) idleTimer.unref();
	};
	const disarmIdle = (): void => {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	const writeTo = (socket: Socket<number>, message: unknown): void => {
		try {
			socket.write(`${JSON.stringify(message)}\n`);
		} catch {
			// The peer is gone; its close handler will drop it from the map.
		}
	};

	const transport: WorkerTransport<In, Out> = {
		send(message) {
			if (typeof message.id !== "string") {
				for (const client of clients.values()) writeTo(client.socket, message);
				return;
			}
			const target = splitDaemonId(message.id);
			if (!target) return;
			const client = clients.get(target.clientSeq);
			if (!client) return;
			writeTo(client.socket, { ...message, id: target.originalId });
		},
		onMessage(handler) {
			inboundHandlers.add(handler);
			return () => inboundHandlers.delete(handler);
		},
	};

	const removeClient = (socket: Socket<number>): void => {
		for (const [seq, client] of clients) {
			if (client.socket === socket) {
				clients.delete(seq);
				break;
			}
		}
		if (clients.size === 0) armIdle();
	};

	try {
		Bun.listen<number>({
			unix: socketPath,
			socket: {
				open(socket) {
					disarmIdle();
					const seq = ++nextClientSeq;
					clients.set(seq, { socket, lines: new NdjsonLineBuffer() });
					socket.data = seq;
					logger.debug("worker-daemon: client connected", { socketPath, clientSeq: seq, clients: clients.size });
				},
				data(socket, chunk) {
					const seq = socket.data;
					const client = clients.get(seq);
					if (!client) return;
					for (const line of client.lines.push(chunk)) {
						let message: In;
						try {
							message = JSON.parse(line) as In;
						} catch {
							continue;
						}
						if (typeof message.id === "string") {
							message = { ...message, id: `${seq}:${message.id}` };
						}
						for (const handler of inboundHandlers) handler(message);
					}
				},
				close(socket) {
					removeClient(socket);
				},
				error(socket) {
					removeClient(socket);
				},
			},
		});
	} catch (err) {
		// Lost the bind race (or a live daemon already serves this path).
		logger.debug("worker-daemon: bind failed, yielding", {
			socketPath,
			error: err instanceof Error ? err.message : String(err),
		});
		process.exit(0);
	}

	// Bound: the spawner's claim is fulfilled, let future clients skip the spawn.
	fs.rmSync(spawnLockPath(socketPath), { force: true });
	logger.debug("worker-daemon: listening", { socketPath, idleMs });
	start(transport);

	// A spawner that dies before ever connecting must not leave an orphan.
	armIdle();

	process.on("SIGTERM", () => {
		removeSocketFile();
		process.exit(0);
	});
	process.on("SIGINT", () => {
		removeSocketFile();
		process.exit(0);
	});

	const keepalive = setInterval(() => {}, 2 ** 30);
	if (isBunTestRuntime()) keepalive.unref();
	const { promise: forever } = Promise.withResolvers<never>();
	return forever;
}
