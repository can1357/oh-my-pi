/**
 * The single per-user omp daemon process (`__omp_worker_daemon`): one
 * listener, hello/token auth, control-op dispatch into the {@link UnitTable},
 * raw tunnels after `attach`, board/completion fan-out, idle exit, and in-place
 * re-exec into a newer client's build on `upgrade`.
 */
import * as fs from "node:fs/promises";
import { execReplace, FileLock, type IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { errorMessage, isEnoent, isRecord, logger, postmortem, setProcessName } from "@oh-my-pi/pi-utils";
import { daemonBuildId } from "./build";
import { isSameProcess, processStartTime } from "./children";
import type { ModuleClient, ModuleTunnel } from "./module";
import { DAEMON_MODULES } from "./modules";
import {
	daemonDbPath,
	daemonDir,
	daemonEndpoint,
	daemonHandoverPath,
	daemonLockPath,
	daemonTcpAddress,
	daemonTokenPath,
} from "./paths";
import {
	compareDaemonBuilds,
	DAEMON_IDLE_EXIT_GRACE_ENV,
	DAEMON_IDLE_EXIT_GRACE_MS,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_RESUME_ENV,
	DAEMON_RESUME_LEASE_GRACE_ENV,
	DAEMON_RESUME_LEASE_GRACE_MS,
	DAEMON_WORKER_ARG,
	type DaemonEvent,
	type DaemonHello,
	type DaemonOp,
	type DaemonRequest,
	type DaemonResults,
	type DaemonWelcome,
} from "./protocol";
import { DaemonStore } from "./store";
import { type UnitConnection, UnitTable } from "./units";

/** Control lines carry whole launch environments; tunnels are unframed. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const LISTEN_OPTIONS = { framing: "lines", maxFrameBytes: MAX_FRAME_BYTES } as const;
/** How long a re-exec'd image (or one whose exec failed) retries for the lock a stepping-aside daemon briefly holds. */
const LOCK_HANDOVER_TIMEOUT_MS = 10_000;
/** A handover record older than this is stale even when its pid is alive. */
const HANDOVER_MAX_AGE_MS = 60_000;

/** Daemon side of one tunnelled connection. */
class ConnectionTunnel implements ModuleTunnel {
	readonly client: ModuleClient;
	readonly #connection: IpcConnection;
	#pending: Uint8Array[] = [];
	#onData: ((chunk: Uint8Array) => void) | undefined;
	#onClose: (() => void) | undefined;
	#closed = false;

	constructor(client: ModuleClient, connection: IpcConnection) {
		this.client = client;
		this.#connection = connection;
	}

	push(chunk: Uint8Array): void {
		if (this.#onData) this.#onData(chunk);
		else this.#pending.push(chunk);
	}

	ended(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClose?.();
	}

	send(data: string | Uint8Array): boolean {
		return this.#connection.send(data);
	}

	drained(): Promise<void> {
		return this.#connection.drained();
	}

	start(onData: (chunk: Uint8Array) => void, onClose: () => void): void {
		if (this.#onData) throw new Error("Tunnel already started");
		this.#onData = onData;
		this.#onClose = onClose;
		const pending = this.#pending;
		this.#pending = [];
		for (const chunk of pending) onData(chunk);
		if (this.#closed) onClose();
	}

	close(): void {
		this.#connection.end();
		// The peer may keep its write half open; the unit's close handler must not wait for it.
		queueMicrotask(() => this.ended());
	}
}

/** One accepted connection. */
class DaemonConnection implements UnitConnection {
	readonly connection: IpcConnection;
	client: ModuleClient;
	hello: DaemonHello | undefined;
	/** Set once the connection became a tunnel; control lines are no longer read or written. */
	tunnel: ConnectionTunnel | undefined;
	readonly inFlight = new Map<string, AbortController>();

	constructor(connection: IpcConnection) {
		this.connection = connection;
		this.client = { connectionId: crypto.randomUUID(), pid: 0, build: "" };
	}

	get closed(): boolean {
		return this.connection.closed;
	}

	send(event: DaemonEvent): void {
		if (this.tunnel || this.connection.closed) return;
		this.connection.send(JSON.stringify(event));
	}
}

function parseHello(line: string): DaemonHello {
	const value: unknown = JSON.parse(line);
	if (!isRecord(value) || typeof value.v !== "number" || typeof value.token !== "string" || !isRecord(value.client)) {
		throw new Error("Malformed daemon hello");
	}
	const client = value.client;
	if (
		typeof client.pid !== "number" ||
		typeof client.build !== "string" ||
		!Array.isArray(client.exe) ||
		!client.exe.every(part => typeof part === "string")
	) {
		throw new Error("Malformed daemon hello client");
	}
	return value as unknown as DaemonHello;
}

function parseRequest(value: unknown): DaemonRequest {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.op !== "string") {
		throw new Error("Malformed daemon request");
	}
	return value as unknown as DaemonRequest;
}

async function readOrCreateToken(): Promise<string> {
	const tokenPath = daemonTokenPath();
	try {
		const token = (await fs.readFile(tokenPath, "utf8")).trim();
		if (token) return token;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
	try {
		await fs.writeFile(tokenPath, token, { mode: 0o600, flag: "wx" });
		return token;
	} catch (error) {
		// A client wrote it concurrently: theirs wins.
		const existing = (await fs.readFile(tokenPath, "utf8")).trim();
		if (existing) return existing;
		throw error;
	}
}

class Daemon {
	readonly #token: string;
	#lock: FileLock;
	readonly #store: DaemonStore;
	readonly #units: UnitTable;
	readonly #idleExitGraceMs: number;
	readonly #startedAt = Date.now();
	readonly #connections = new Set<DaemonConnection>();
	readonly #finished = Promise.withResolvers<void>();
	#server: IpcServer | undefined;
	#idleTimer: NodeJS.Timeout | undefined;
	/** `upgrade` or `shutdown` began: new requests are rejected. */
	#closing = false;
	#shutdown: Promise<void> | undefined;

	constructor(
		token: string,
		lock: FileLock,
		store: DaemonStore,
		resumed: boolean,
		leaseGraceMs: number,
		idleExitGraceMs: number,
	) {
		this.#token = token;
		this.#lock = lock;
		this.#store = store;
		this.#idleExitGraceMs = idleExitGraceMs;
		this.#units = new UnitTable({
			store,
			modules: DAEMON_MODULES,
			resumed,
			leaseGraceMs,
			onLivenessChange: () => this.#scheduleIdleExit(),
		});
	}

	async run(): Promise<void> {
		await this.#units.start();
		await this.#listen();
		this.#scheduleIdleExit();
		await this.#finished.promise;
	}

	async #listen(): Promise<void> {
		const tcp = daemonTcpAddress();
		const accept = (connection: IpcConnection): void => this.#accept(connection);
		this.#server = tcp
			? await IpcServer.listenTcp(tcp.host, tcp.port, LISTEN_OPTIONS, accept)
			: await IpcServer.listen(daemonEndpoint(), LISTEN_OPTIONS, accept);
		logger.debug("omp daemon listening", { pid: process.pid, build: daemonBuildId(), tcp });
	}

	/** Stop every non-detached unit, close everything, and let the process exit. */
	shutdown(): Promise<void> {
		this.#shutdown ??= (async () => {
			this.#closing = true;
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
			try {
				await this.#units.shutdown();
			} catch (error) {
				logger.error("Daemon unit shutdown failed", { error: errorMessage(error) });
			}
			await this.#closeTransport();
			this.#store.close();
			this.#lock.release();
			this.#finished.resolve();
		})();
		return this.#shutdown;
	}

	async #closeTransport(): Promise<void> {
		await this.#server?.close();
		this.#server = undefined;
		for (const connection of this.#connections) connection.connection.destroy();
		this.#connections.clear();
	}

	#accept(connection: IpcConnection): void {
		const state = new DaemonConnection(connection);
		this.#connections.add(state);
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		connection.start(
			line => void this.#onLine(state, line),
			() => this.#onClose(state),
		);
	}

	#onClose(state: DaemonConnection): void {
		this.#connections.delete(state);
		for (const controller of state.inFlight.values()) controller.abort();
		state.inFlight.clear();
		state.tunnel?.ended();
		if (state.hello) this.#units.disconnected(state);
		this.#scheduleIdleExit();
	}

	async #onLine(state: DaemonConnection, line: string): Promise<void> {
		if (state.tunnel) return;
		if (!state.hello) {
			try {
				const hello = parseHello(line);
				if (hello.v !== DAEMON_PROTOCOL_VERSION) {
					throw new Error(`Daemon protocol ${DAEMON_PROTOCOL_VERSION} does not match client protocol ${hello.v}`);
				}
				if (hello.token !== this.#token) throw new Error("Daemon authentication failed");
				if (this.#closing) throw new Error("Daemon is shutting down");
				state.hello = hello;
				state.client = {
					connectionId: state.client.connectionId,
					pid: hello.client.pid,
					build: hello.client.build,
					session: hello.client.session,
					project: hello.client.project,
				};
				const welcome: DaemonWelcome = {
					v: DAEMON_PROTOCOL_VERSION,
					daemon: { pid: process.pid, build: daemonBuildId(), startedAt: this.#startedAt },
					caps: this.#units.caps(),
				};
				state.connection.send(JSON.stringify(welcome));
			} catch (error) {
				state.connection.send(JSON.stringify({ error: errorMessage(error) }));
				state.connection.end();
			}
			return;
		}
		let id = "unknown";
		try {
			const decoded: unknown = JSON.parse(line);
			// Correlate before validating so a request this build cannot parse still fails its caller.
			if (isRecord(decoded) && typeof decoded.id === "string") id = decoded.id;
			const request = parseRequest(decoded);
			if (this.#closing) throw new Error("Daemon is restarting");
			if (request.op === "attach") {
				await this.#attach(state, request);
				return;
			}
			const abortable = request.op === "wait" || request.op === "logs";
			const controller = abortable ? new AbortController() : undefined;
			if (controller) state.inFlight.set(id, controller);
			let result: unknown;
			try {
				result = await this.#dispatch(state, request, controller?.signal);
			} finally {
				if (controller && state.inFlight.get(id) === controller) state.inFlight.delete(id);
			}
			state.connection.send(JSON.stringify({ id, ok: true, result }));
			if (request.op === "shutdown") setTimeout(() => void this.shutdown(), 10);
			if (request.op === "upgrade" && (result as DaemonResults["upgrade"]).reexec) {
				void this.#replace(state.hello).catch(error => {
					logger.error("Daemon replacement failed", { error: errorMessage(error) });
					process.exit(1);
				});
			}
		} catch (error) {
			if (!state.connection.closed)
				state.connection.send(JSON.stringify({ id, ok: false, error: errorMessage(error) }));
		}
	}

	async #attach(state: DaemonConnection, request: Extract<DaemonRequest, { op: "attach" }>): Promise<void> {
		const unit = await this.#units.attachable(request.unit);
		const tunnel = new ConnectionTunnel(state.client, state.connection);
		const result: DaemonResults["attach"] = { unit };
		state.connection.send(JSON.stringify({ id: request.id, ok: true, result }));
		// Leave control mode synchronously after the reply: every later byte belongs to the unit.
		state.tunnel = tunnel;
		state.connection.upgradeRaw(chunk => tunnel.push(chunk));
		try {
			await this.#units.attach(request.unit, request.channel, tunnel);
		} catch (error) {
			logger.warn("Daemon unit rejected a tunnel", { error: errorMessage(error) });
			tunnel.close();
		}
	}

	async #dispatch(state: DaemonConnection, request: DaemonOp, signal: AbortSignal | undefined): Promise<unknown> {
		const units = this.#units;
		switch (request.op) {
			case "ping":
				return { pid: process.pid, build: daemonBuildId() } satisfies DaemonResults["ping"];
			case "list":
				return units.list(request);
			case "describe":
				return units.describe(request);
			case "watch":
				return units.watch(state);
			case "open": {
				const { op: _op, ...open } = request;
				return units.open(state, open);
			}
			case "release":
				return units.release(state, request.lease);
			case "stop":
				return units.stop(request);
			case "restart":
				return units.restart(request);
			case "mode":
				return units.mode(request);
			case "logs":
				return units.logs(request, signal);
			case "wait":
				return units.wait(request, signal);
			case "send":
				return units.send(request);
			case "cancel": {
				const controller = state.inFlight.get(request.requestId);
				if (!controller) return { cancelled: false } satisfies DaemonResults["cancel"];
				state.inFlight.delete(request.requestId);
				controller.abort();
				return { cancelled: true } satisfies DaemonResults["cancel"];
			}
			case "call":
				return units.call(state, request);
			case "attach":
				throw new Error("attach is handled before dispatch");
			case "register":
				return units.register(state, request);
			case "unregister":
				return units.unregister(state, request);
			case "subscribe":
				return units.subscribe(state, request);
			case "upgrade":
				return this.#upgrade(state);
			case "shutdown":
				this.#closing = true;
				return {} satisfies DaemonResults["shutdown"];
			default: {
				const unknown: { op: string } = request;
				throw new Error(`Unknown daemon operation ${unknown.op}`);
			}
		}
	}

	#upgrade(state: DaemonConnection): DaemonResults["upgrade"] {
		const hello = state.hello;
		if (!hello || hello.client.exe.length === 0) return { reexec: false };
		if (compareDaemonBuilds(hello.client.build, daemonBuildId()) <= 0) return { reexec: false };
		this.#closing = true;
		return { reexec: true };
	}

	/** Become the client's newer build in place (Unix) or step aside for a respawn (Windows). */
	async #replace(hello: DaemonHello | undefined): Promise<void> {
		// Let the `upgrade` reply reach the client first.
		await Promise.all(Array.from(this.#connections, connection => connection.connection.drained()));
		if (process.platform === "win32" || !hello) {
			await this.shutdown();
			process.exit(0);
		}
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		await this.#units.prepareReexec();
		await this.#closeTransport();
		const [command, ...rest] = hello.client.exe;
		const application = Bun.which(command) ?? command;
		const env: Record<string, string> = {};
		for (const name in process.env) {
			const value = process.env[name];
			if (value !== undefined) env[name] = value;
		}
		env[DAEMON_RESUME_ENV] = "1";
		// The lock cannot cross the exec; a daemon that wins it in the gap sees this record and steps aside.
		await Bun.write(
			daemonHandoverPath(),
			JSON.stringify({ pid: process.pid, startedAt: processStartTime(process.pid), at: Date.now() }),
		);
		// Output read from here on would have no log to land in: leave it in the pipes for the successor.
		await this.#units.pauseOutput();
		// Last await.
		await this.#units.releaseLogs();
		// From here to the exec nothing awaits: no callback of this image can run in between.
		const keepFds = this.#units.reexecFds();
		logger.debug("omp daemon re-exec", { from: daemonBuildId(), to: hello.client.build, keepFds });
		try {
			// Closed explicitly so no store fd crosses the exec, whatever its close-on-exec flag.
			this.#store.close();
			this.#lock.release();
			execReplace(application, [command, ...rest, DAEMON_WORKER_ARG], env, keepFds);
		} catch (error) {
			logger.error("Daemon re-exec failed; resuming service", { application, error: errorMessage(error) });
			// Idempotent; still held when the store failed to close.
			this.#lock.release();
			await this.#resumeAfterFailedExec();
		}
	}

	/** `execReplace` threw: take the lock and store back, restore the units, and listen again. */
	async #resumeAfterFailedExec(): Promise<void> {
		const lock = await acquireDaemonLock(LOCK_HANDOVER_TIMEOUT_MS);
		if (!lock) throw new Error("Could not retake the daemon lock after a failed re-exec");
		this.#lock = lock;
		this.#store.reopen();
		await this.#units.abortReexec();
		this.#closing = false;
		await this.#listen();
		this.#scheduleIdleExit();
	}

	/** Exit once nothing is connected and no unit but `hold: "detached"` ones is live. */
	#scheduleIdleExit(): void {
		if (this.#closing || this.#connections.size > 0 || this.#units.keepsDaemonAlive()) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
			return;
		}
		if (this.#idleTimer) return;
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			if (this.#closing || this.#connections.size > 0 || this.#units.keepsDaemonAlive()) return;
			void this.shutdown();
		}, this.#idleExitGraceMs);
	}
}

interface Handover {
	pid: number;
	startedAt?: number;
	at: number;
}

async function readHandover(): Promise<Handover | undefined> {
	try {
		const value: unknown = await Bun.file(daemonHandoverPath()).json();
		if (!isRecord(value) || typeof value.pid !== "number" || typeof value.at !== "number") return undefined;
		return {
			pid: value.pid,
			startedAt: typeof value.startedAt === "number" ? value.startedAt : undefined,
			at: value.at,
		};
	} catch (error) {
		if (!isEnoent(error)) logger.debug("Unreadable daemon handover record", { error: errorMessage(error) });
		return undefined;
	}
}

/**
 * Take the single-instance lock, retrying for `retryMs`. Returns undefined when
 * another daemon holds it, or when a live daemon released it only to re-exec
 * (its handover record names another pid): its successor takes it back.
 */
async function acquireDaemonLock(retryMs: number): Promise<FileLock | undefined> {
	const deadline = Date.now() + retryMs;
	for (;;) {
		const lock = FileLock.tryAcquire(daemonLockPath());
		if (lock.acquired) {
			const handover = await readHandover();
			const yieldTo =
				handover !== undefined &&
				handover.pid !== process.pid &&
				Date.now() - handover.at < HANDOVER_MAX_AGE_MS &&
				isSameProcess(handover.pid, handover.startedAt);
			if (!yieldTo) {
				await fs.rm(daemonHandoverPath(), { force: true });
				return lock;
			}
			lock.release();
			logger.debug("Another omp daemon is re-executing; stepping aside", { pid: handover.pid });
			return undefined;
		}
		if (Date.now() >= deadline) return undefined;
		await Bun.sleep(25);
	}
}

/** Milliseconds from env var `name` when positive, else `fallback`. */
function graceMsFromEnv(name: string, fallback: number): number {
	const graceMs = Number(process.env[name]);
	return graceMs > 0 ? graceMs : fallback;
}

/** Run the daemon until it goes idle, is shut down, or replaces itself. Returns at once when another daemon holds the lock. */
export async function startDaemonFromEnvironment(): Promise<void> {
	const resumed = process.env[DAEMON_RESUME_ENV] !== undefined;
	delete process.env[DAEMON_RESUME_ENV];
	await fs.mkdir(daemonDir(), { recursive: true, mode: 0o700 });
	// Native lock: the OS releases it however this process ends. A re-exec'd image waits out a daemon stepping aside.
	const lock = await acquireDaemonLock(resumed ? LOCK_HANDOVER_TIMEOUT_MS : 0);
	if (!lock) {
		logger.debug("Another omp daemon holds the lock");
		return;
	}
	setProcessName("omp daemon");
	let store: DaemonStore | undefined;
	let daemon: Daemon | undefined;
	try {
		const token = await readOrCreateToken();
		store = DaemonStore.open(daemonDbPath());
		daemon = new Daemon(
			token,
			lock,
			store,
			resumed,
			graceMsFromEnv(DAEMON_RESUME_LEASE_GRACE_ENV, DAEMON_RESUME_LEASE_GRACE_MS),
			graceMsFromEnv(DAEMON_IDLE_EXIT_GRACE_ENV, DAEMON_IDLE_EXIT_GRACE_MS),
		);
		const cancelCleanup = postmortem.register("omp-daemon", () => daemon?.shutdown());
		try {
			await daemon.run();
		} finally {
			cancelCleanup();
		}
	} catch (error) {
		if (daemon) await daemon.shutdown();
		else {
			store?.close();
			lock.release();
		}
		throw error;
	}
}
