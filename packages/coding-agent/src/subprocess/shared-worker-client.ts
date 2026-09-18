import { spawn as spawnDetached } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isBunTestRuntime, logger } from "@pk-nerdsaver-ai/pi-utils";
import type { Socket } from "bun";
import { DAEMON_CONNECT_TIMEOUT_MS, SHARED_WORKERS_ENV, spawnLockPath } from "./shared-worker-config";
import type { RefCountedWorkerHandle, WorkerSpawnCommand } from "./worker-client";

/**
 * Client side of the shared inference daemon. Instead of every ompk instance
 * spawning its own ONNX subprocess over 1:1 Bun IPC, N instances connect to one
 * per-user daemon over a Unix socket (named pipe on Windows) and speak
 * newline-delimited JSON — the same message types the IPC worker used, so the
 * client classes (`TinyTitleClient`, `MnemopiEmbedClient`) plug in unchanged.
 *
 * The daemon owns the model and its own idle timer; `terminate()` here only
 * disconnects. A daemon that is not yet listening is spawned once and the
 * connect is retried until {@link DAEMON_CONNECT_TIMEOUT_MS} elapses, after
 * which every `onError` handler fires once and the caller's existing
 * error→terminate→respawn recovery takes over.
 */
export interface SharedWorkerSpawnSpec {
	socketPath: string;
	/** Relaunch command for the daemon (`resolveWorkerSpawnCmd(<DAEMON_ARG>)`). */
	spawnCommand: WorkerSpawnCommand;
	/** Env for the daemon process (e.g. `tinyWorkerEnv()`); the first spawner's env wins. */
	env: Record<string, string>;
	/** Log/error label, e.g. `"tiny model daemon"`. */
	label: string;
	/** Test seam: override the cold-start connect budget. */
	connectTimeoutMs?: number;
}

const FAST_RETRY_WINDOW_MS = 2_000;
const FAST_RETRY_INTERVAL_MS = 100;
const SLOW_RETRY_INTERVAL_MS = 500;

/** Split a UTF-8 byte stream into complete NDJSON lines across chunk boundaries. */
export class NdjsonLineBuffer {
	readonly #decoder = new TextDecoder("utf-8");
	#pending = "";

	push(chunk: Uint8Array): string[] {
		this.#pending += this.#decoder.decode(chunk, { stream: true });
		const lines: string[] = [];
		let newline = this.#pending.indexOf("\n");
		while (newline !== -1) {
			const line = this.#pending.slice(0, newline);
			this.#pending = this.#pending.slice(newline + 1);
			if (line.length > 0) lines.push(line);
			newline = this.#pending.indexOf("\n");
		}
		return lines;
	}
}

export function createSharedWorkerHandle<Inbound extends { type: string }, Outbound extends { type: string }>(
	spec: SharedWorkerSpawnSpec,
): RefCountedWorkerHandle<Inbound, Outbound> {
	const inbound = new Set<(message: Outbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const queue: string[] = [];
	const lines = new NdjsonLineBuffer();
	let socket: Socket | undefined;
	let terminated = false;
	let errored = false;
	// Desired ref state before the socket exists; applied on open. Outside
	// `bun test` an idle connection must never keep the parent alive.
	let wantRef = isBunTestRuntime();

	const failOnce = (error: Error): void => {
		if (errored || terminated) return;
		errored = true;
		for (const handler of errors) handler(error);
	};

	const connectOnce = async (): Promise<Socket> =>
		Bun.connect({
			unix: spec.socketPath,
			socket: {
				open(s) {
					if (terminated) {
						s.end();
						return;
					}
					socket = s;
					if (wantRef) s.ref();
					else s.unref();
					for (const frame of queue) s.write(frame);
					queue.length = 0;
				},
				data(_s, chunk) {
					for (const line of lines.push(chunk)) {
						let message: Outbound;
						try {
							message = JSON.parse(line) as Outbound;
						} catch {
							logger.warn("shared-worker: bad frame", { label: spec.label, line: line.slice(0, 200) });
							continue;
						}
						for (const handler of inbound) handler(message);
					}
				},
				close() {
					socket = undefined;
					failOnce(new Error(`${spec.label} connection closed`));
				},
				error(_s, error) {
					socket = undefined;
					failOnce(error instanceof Error ? error : new Error(String(error)));
				},
			},
		});

	/**
	 * Claim the right to spawn the daemon for this socket. N clients that all
	 * find nobody listening would otherwise each cold-start a daemon; the bind
	 * race sorts out the winner, but every loser still pays a full module-graph
	 * boot. The lock is a `wx`-created sidecar; a leftover older than the connect
	 * budget is treated as abandoned and reclaimed.
	 */
	const claimSpawnLock = (budget: number): boolean => {
		const lockPath = spawnLockPath(spec.socketPath);
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				fs.mkdirSync(path.dirname(lockPath), { recursive: true });
				fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
				return true;
			} catch (err) {
				if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) return true;
				let ageMs = 0;
				try {
					ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
				} catch {
					continue; // vanished between the two calls — retry the claim
				}
				if (ageMs < budget) return false;
				fs.rmSync(lockPath, { force: true });
			}
		}
		return false;
	};

	const spawnDaemon = (): void => {
		// A socket path nobody is listening on is a crash leftover (Bun materializes
		// the Unix socket as a filesystem entry on every platform, Windows
		// included); the daemon's bind would fail with EADDRINUSE on it.
		fs.rmSync(spec.socketPath, { force: true });
		try {
			// `node:child_process` rather than `Bun.spawn`: only the former exposes
			// `detached`, and without it Bun's Windows job object kills the daemon
			// the moment this instance exits (verified empirically). On Unix,
			// `detached` also makes it a session leader so no tty SIGHUP reaches it.
			const [file, ...args] = spec.spawnCommand.cmd;
			if (!file) throw new Error("empty daemon spawn command");
			const child = spawnDetached(file, args, {
				cwd: spec.spawnCommand.cwd,
				// A daemon must never fan out into more daemons: whatever runs inside
				// it (memory consolidation, title generation) takes the direct
				// subprocess path, which dies with its parent over IPC.
				env: { ...spec.env, [SHARED_WORKERS_ENV]: "0" },
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			// The daemon must outlive this parent; never hold a reference to it.
			child.unref();
		} catch (err) {
			fs.rmSync(spawnLockPath(spec.socketPath), { force: true });
			logger.warn("shared-worker: daemon spawn failed", {
				label: spec.label,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const connectWithSpawn = async (): Promise<void> => {
		try {
			await connectOnce();
			return;
		} catch {
			// Nobody is listening (or the path is stale): spawn and poll.
		}
		if (terminated) return;
		const budget = spec.connectTimeoutMs ?? DAEMON_CONNECT_TIMEOUT_MS;
		if (claimSpawnLock(budget)) spawnDaemon();
		const start = performance.now();
		while (!terminated) {
			const elapsed = performance.now() - start;
			if (elapsed >= budget) break;
			await Bun.sleep(elapsed < FAST_RETRY_WINDOW_MS ? FAST_RETRY_INTERVAL_MS : SLOW_RETRY_INTERVAL_MS);
			if (terminated) return;
			try {
				await connectOnce();
				fs.rmSync(spawnLockPath(spec.socketPath), { force: true });
				return;
			} catch {
				// keep polling until the budget is spent
			}
		}
		if (!terminated) {
			failOnce(new Error(`${spec.label} unreachable at ${spec.socketPath} after ${budget}ms`));
		}
	};

	void connectWithSpawn();

	return {
		send(message) {
			if (terminated) return;
			const frame = `${JSON.stringify(message)}\n`;
			if (socket) socket.write(frame);
			else queue.push(frame);
		},
		onMessage(handler) {
			inbound.add(handler);
			return () => inbound.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		async terminate() {
			if (terminated) return;
			terminated = true;
			inbound.clear();
			errors.clear();
			queue.length = 0;
			const s = socket;
			socket = undefined;
			s?.end();
		},
		ref() {
			wantRef = true;
			socket?.ref();
		},
		unref() {
			wantRef = false;
			socket?.unref();
		},
	};
}
