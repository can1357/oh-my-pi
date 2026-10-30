/**
 * Client half of the machine-shared workers: one detached process per worker
 * name that owns an IPC endpoint under a runtime directory, serves every omp
 * process on the machine, and exits on its own once idle (its server half is
 * `JsonLineServer` in `jsonl-server.ts`). A caller describes how to start the
 * worker ({@link SharedWorkerLaunch}); {@link connectSharedWorker} adopts a
 * live worker answering with the same launch tag, replaces a stale one, or
 * spawns one. Used by the tiny-model workers and the mnemopi embedding server
 * so their models are loaded once per machine instead of once per omp process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { RefCountedWorkerHandle } from "./worker-client";

const CONNECT_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_INTERVAL_MS = 200;
/** Time for a spawned worker to bind its endpoint; a compiled binary may first side-install its runtime. */
const READY_TIMEOUT_MS = 120_000;
/** Time for a stale worker to honour `shutdown` and release its endpoint. */
const SHUTDOWN_WAIT_MS = 5_000;

/** Requests every shared worker answers inline: a tagged `ping`, and `shutdown` (a client found a stale tag). */
export type SharedWorkerControl = { type: "ping"; id: string } | { type: "shutdown"; id: string };

/** Reply to `ping`, carrying the worker's launch tag. */
export type SharedWorkerPong = { type: "pong"; id: string; tag: string };

/** Error surfaced when a worker closes the connection (idle exit, replacement, crash); clients reconnect on demand. */
export const WORKER_CONNECTION_CLOSED = "worker connection closed";

/** A spawned worker process and the file its stdout/stderr go to. */
export interface SpawnedWorker {
	proc: Subprocess;
	logPath: string;
}

/** How to start one shared worker. */
export interface SharedWorkerLaunch {
	/** Names the worker in errors, e.g. `tiny onnx worker for lfm2.5-230m`. */
	label: string;
	/** Launch identity echoed in `pong`; a live worker answering with another tag is told to shut down and replaced. */
	tag: string;
	/** Start the worker (normally via {@link spawnDetached}) so it binds `endpoint` and logs to `logPath`. */
	spawn(endpoint: string, logPath: string): Promise<SpawnedWorker>;
}

/** Stdout/stderr log file of the worker called `name` (kept beside its endpoint, never derived from a pipe name). */
export function sharedWorkerLogPath(runtimeDir: string, name: string): string {
	return path.join(runtimeDir, `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
}

/**
 * A started lines connection whose handlers can be swapped: `start()` runs
 * once, but the probe reads the `pong` before the worker handle takes over.
 */
class LineChannel {
	onLine: (line: string) => void = () => {};
	onClose: () => void = () => {};
	closed = false;

	constructor(readonly connection: IpcConnection) {
		connection.start(
			line => this.onLine(line),
			() => {
				this.closed = true;
				this.onClose();
			},
		);
	}
}

/**
 * Wrap a live worker connection. An unexpected close surfaces as an error
 * whose message starts with {@link WORKER_CONNECTION_CLOSED}, followed by the
 * tail of the worker's log so a native crash (`onnxruntime` load failure,
 * missing model file) reaches the caller instead of a bare "closed".
 */
function createSocketWorkerHandle<Req, Res>(channel: LineChannel, logPath: string): RefCountedWorkerHandle<Req, Res> {
	const { connection } = channel;
	const messages = new Set<(message: Res) => void>();
	const errors = new Set<(error: Error) => void>();
	let terminated = false;
	const reportClosed = (): void => {
		if (terminated) return;
		void logTail(logPath).then(tail => {
			const error = new Error(tail ? `${WORKER_CONNECTION_CLOSED}: ${tail}` : WORKER_CONNECTION_CLOSED);
			for (const handler of errors) handler(error);
		});
	};
	channel.onLine = line => {
		const message = JSON.parse(line) as Res;
		for (const handler of messages) handler(message);
	};
	channel.onClose = reportClosed;
	if (channel.closed) reportClosed();
	return {
		send(message) {
			connection.send(JSON.stringify(message));
		},
		onMessage(handler) {
			messages.add(handler);
			return () => messages.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		terminate() {
			terminated = true;
			connection.destroy();
			return Promise.resolve();
		},
		ref() {
			connection.ref();
		},
		unref() {
			connection.unref();
		},
	};
}

/**
 * Handle that resolves its backing worker asynchronously. Clients need a
 * handle synchronously (they subscribe and send in the same tick), but reaching
 * a shared worker means probing and possibly spawning; sends queue until the
 * connection lands, and a failed connect surfaces through `onError`.
 * `terminate()` only drops this connection — the worker keeps serving others.
 */
export class LazyWorkerHandle<Req, Res> implements RefCountedWorkerHandle<Req, Res> {
	#inner: RefCountedWorkerHandle<Req, Res> | null = null;
	#queue: Req[] = [];
	#messages = new Set<(message: Res) => void>();
	#errors = new Set<(error: Error) => void>();
	#refed = false;
	#terminated = false;

	constructor(connect: () => Promise<RefCountedWorkerHandle<Req, Res>>) {
		connect().then(
			inner => {
				if (this.#terminated) {
					void inner.terminate();
					return;
				}
				this.#inner = inner;
				inner.onMessage(message => {
					for (const handler of this.#messages) handler(message);
				});
				inner.onError(error => {
					for (const handler of this.#errors) handler(error);
				});
				if (this.#refed) inner.ref();
				else inner.unref();
				const queued = this.#queue;
				this.#queue = [];
				for (const message of queued) inner.send(message);
			},
			(error: unknown) => {
				if (this.#terminated) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				for (const handler of this.#errors) handler(failure);
			},
		);
	}

	send(message: Req): void {
		if (this.#inner) this.#inner.send(message);
		else this.#queue.push(message);
	}

	onMessage(handler: (message: Res) => void): () => void {
		this.#messages.add(handler);
		return () => this.#messages.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errors.add(handler);
		return () => this.#errors.delete(handler);
	}

	terminate(): Promise<void> {
		this.#terminated = true;
		this.#queue = [];
		return this.#inner?.terminate() ?? Promise.resolve();
	}

	ref(): void {
		this.#refed = true;
		this.#inner?.ref();
	}

	unref(): void {
		this.#refed = false;
		this.#inner?.unref();
	}
}

type ProbeResult = { kind: "live"; channel: LineChannel } | { kind: "stale" } | { kind: "absent" };

/** Connect and ping. `stale` means a worker answered with a different launch tag (and was told to shut down). */
async function probeSharedWorker(endpoint: string, tag: string): Promise<ProbeResult> {
	let connection: IpcConnection;
	try {
		connection = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: CONNECT_TIMEOUT_MS });
	} catch {
		// Nothing listening (or not ours); the caller spawns one.
		return { kind: "absent" };
	}
	const channel = new LineChannel(connection);
	const pong = Promise.withResolvers<SharedWorkerPong | null>();
	channel.onLine = line => pong.resolve(JSON.parse(line) as SharedWorkerPong);
	channel.onClose = () => pong.resolve(null);
	const timer = setTimeout(() => pong.resolve(null), PROBE_TIMEOUT_MS);
	connection.send(JSON.stringify({ type: "ping", id: "probe" } satisfies SharedWorkerControl));
	const reply = await pong.promise;
	clearTimeout(timer);
	if (reply?.type === "pong" && reply.tag === tag) return { kind: "live", channel };
	if (reply?.type === "pong") {
		logger.debug("shared-worker: launch tag mismatch; replacing", { endpoint, running: reply.tag, expected: tag });
		connection.send(JSON.stringify({ type: "shutdown", id: "replace" } satisfies SharedWorkerControl));
		connection.end();
		return { kind: "stale" };
	}
	connection.destroy();
	return { kind: "absent" };
}

/** Detach a worker so it outlives this omp process; its output goes to `logPath`. */
export function spawnDetached(
	cmd: string[],
	cwd: string | undefined,
	env: Record<string, string>,
	logPath: string,
): SpawnedWorker {
	const log = fs.openSync(logPath, "w");
	try {
		const proc = Bun.spawn({
			cmd,
			cwd,
			env,
			detached: true,
			stdin: "ignore",
			stdout: log,
			stderr: log,
			windowsHide: true,
		});
		proc.unref();
		return { proc, logPath };
	} finally {
		fs.closeSync(log);
	}
}

async function waitForEndpointRelease(endpoint: string): Promise<void> {
	const deadline = Date.now() + SHUTDOWN_WAIT_MS;
	while (Date.now() < deadline) {
		if ((await probeSharedWorker(endpoint, "")).kind === "absent") return;
		await Bun.sleep(PROBE_INTERVAL_MS);
	}
}

/** Last 500 chars of a worker's log, minus its readiness banner; `""` when absent or empty. */
async function logTail(logPath: string): Promise<string> {
	try {
		const text = await Bun.file(logPath).text();
		return text
			.split("\n")
			.filter(line => !/^omp .+ listening on /.test(line))
			.join("\n")
			.trim()
			.slice(-500);
	} catch {
		return "";
	}
}

/** Probe until the spawned worker answers with the launch tag; throws with its log tail once it exits or the time runs out. */
async function awaitSpawnedWorker(
	launch: SharedWorkerLaunch,
	spawned: SpawnedWorker,
	endpoint: string,
	timeoutMs: number,
): Promise<LineChannel> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await probeSharedWorker(endpoint, launch.tag);
		if (result.kind === "live") return result.channel;
		if (spawned.proc.exitCode !== null) {
			// Our child is gone: either it lost the bind race to a sibling omp
			// (adopted by the probe above if so) or it crashed.
			const tail = await logTail(spawned.logPath);
			throw new Error(`${launch.label} exited with code ${spawned.proc.exitCode}${tail ? `: ${tail}` : ""}`);
		}
		await Bun.sleep(PROBE_INTERVAL_MS);
	}
	throw new Error(`${launch.label} did not bind ${endpoint} within ${timeoutMs}ms`);
}

/**
 * Connect to the worker called `name` under `runtimeDir`, spawning it when
 * absent or replacing it when its launch tag is stale. A concurrent omp
 * process may win the spawn race; our child then fails to bind (`EADDRINUSE`)
 * and exits while the probe adopts the winner.
 */
export async function connectSharedWorker<Req, Res>(
	launch: SharedWorkerLaunch,
	runtimeDir: string,
	name: string,
): Promise<RefCountedWorkerHandle<Req, Res>> {
	await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const endpoint = ipcEndpoint(runtimeDir, name);
	const logPath = sharedWorkerLogPath(runtimeDir, name);
	const probed = await probeSharedWorker(endpoint, launch.tag);
	if (probed.kind === "live") return createSocketWorkerHandle(probed.channel, logPath);
	if (probed.kind === "stale") await waitForEndpointRelease(endpoint);
	const spawned = await launch.spawn(endpoint, logPath);
	return createSocketWorkerHandle(await awaitSpawnedWorker(launch, spawned, endpoint, READY_TIMEOUT_MS), logPath);
}

/**
 * Distribution smoke test: spawn the worker into a scratch directory under
 * `runtimeDir`, wait for its tagged `pong`, then kill it. Proves the hidden
 * CLI selector boots in binary, source-link, and tarball installs.
 */
export async function smokeTestSharedWorker(
	launch: SharedWorkerLaunch,
	runtimeDir: string,
	name: string,
	timeoutMs: number,
): Promise<void> {
	await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const dir = await fs.promises.mkdtemp(path.join(runtimeDir, "smoke-"));
	const endpoint = ipcEndpoint(dir, name);
	const spawned = await launch.spawn(endpoint, sharedWorkerLogPath(dir, name));
	try {
		(await awaitSpawnedWorker(launch, spawned, endpoint, timeoutMs)).connection.destroy();
	} finally {
		// The worker was spawned unref'd; re-reference it so awaiting its exit
		// cannot drain the event loop and end the smoke run early.
		spawned.proc.ref();
		spawned.proc.kill();
		await spawned.proc.exited.catch(() => {});
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
}
