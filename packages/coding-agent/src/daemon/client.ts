/**
 * Client side of the single per-user omp daemon: one process-shared control
 * connection ({@link daemonClient}) plus per-unit tunnels from `attach`.
 *
 * The client spawns the daemon when nothing answers, asks an older daemon to
 * re-exec into this build, and reconnects when the daemon restarts. Leases are
 * connection-bound: after a reconnect they are gone and `onReconnect` sinks
 * retake them.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { isEexist, isEnoent, isPidAlive, logger, postmortem, toError } from "@oh-my-pi/pi-utils";
import { resolveCliEntryCmd, resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { daemonBuildId } from "./build";
import { canonicalProjectDir, daemonDir, daemonEndpoint, daemonTcpAddress, daemonTokenPath } from "./paths";
import {
	compareDaemonBuilds,
	DAEMON_DIR_ENV,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_TCP_ENV,
	DAEMON_WORKER_ARG,
	type DaemonClient,
	type DaemonCompletionEvent,
	type DaemonCompletionUnregisterOptions,
	type DaemonEvent,
	type DaemonHello,
	type DaemonNotifyEvent,
	type DaemonOp,
	type DaemonResponse,
	type DaemonResult,
	type DaemonTunnel,
	type DaemonUnitEvent,
	type DaemonWelcome,
	type OpenRequest,
	type OpenResult,
	type UnitRef,
	type UnitScope,
	type UnitSnapshot,
} from "./protocol";

export { canonicalProjectDir };

/** Per-attempt dial timeout. */
const DIAL_TIMEOUT_MS = 250;
/** How long a freshly spawned (or re-exec'ing, or exiting) daemon gets to start answering. */
const START_TIMEOUT_MS = 10_000;
const DIAL_RETRY_MS = 50;
/**
 * Spawn again when nothing answered this long after the last spawn: that daemon
 * may have lost the lock to one that was still exiting. Extra spawns are
 * harmless; the lock admits one.
 */
const RESPAWN_MS = 1_000;
const HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Module opens may load models or start language servers. */
const MODULE_OPEN_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const UPGRADE_TIMEOUT_MS = 60_000;
/** Extra time over a server-side timeout before the client gives up on the answer. */
const TIMEOUT_SLACK_MS = 5_000;
const RECONNECT_MIN_MS = 50;
const RECONNECT_MAX_MS = 2_000;
/** Delay before asking the daemon to redeliver completions a sink failed to handle. */
const COMPLETION_RETRY_MS = 2_000;
const SEEN_COMPLETIONS_LIMIT = 512;
/** Timed-out or aborted requests whose late answers are still inspected (an `open` may grant a lease). */
const ABANDONED_LIMIT = 256;
/** Server errors (`server.ts`) meaning "this daemon is going away; dial its successor". */
const DAEMON_RESTARTING = "Daemon is restarting";
const DAEMON_SHUTTING_DOWN = "Daemon is shutting down";
/**
 * The daemon must outlive whichever omp process spawned it. Bun on Windows puts
 * every non-detached child in a kill-on-close job object owned by the parent,
 * so it is detached; it then has no console and its units spawn hidden.
 */
const DAEMON_SPAWN_OPTIONS = { detached: true, windowsHide: true } as const;

/** The daemon answered a request with an error. */
export class DaemonRejectedError extends Error {}

/** A request got no answer in time; the daemon may still be carrying it out. */
export class DaemonTimeoutError extends Error {}

/** The connection failed before the welcome in a way the next daemon instance may not repeat. */
class DaemonTransientError extends Error {}

interface PendingRequest {
	op: DaemonOp["op"];
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	removeAbort?: () => void;
}

/**
 * How a connection attempt reaches a daemon:
 * - `probe`: one dial, never spawn;
 * - `await`: keep dialing (a daemon is re-exec'ing in place), never spawn;
 * - `start`: keep dialing, spawning the daemon whenever nothing answers.
 */
type DialMode = "probe" | "await" | "start";

interface ConnectOptions {
	/** Start the daemon when nothing answers. */
	spawn: boolean;
	/** Ask an older daemon to re-exec into this build. */
	upgrade: boolean;
	/** Re-dial after the connection drops while anything listens for events. */
	reconnect: boolean;
}

interface Link {
	conn: IpcConnection;
	welcome: DaemonWelcome;
	/** Resolves once the connection closed. */
	closed: Promise<void>;
}

interface LinkHandlers {
	onLine(line: string): void;
	onClose(reason: string | null): void;
}

/** The daemon token, or undefined when none was created yet. Empty means "being written by the daemon". */
async function readToken(): Promise<string | undefined> {
	try {
		// node:fs, not Bun.file().text(): on Windows a Bun.file read that
		// rejects with ENOENT holds no event-loop ref, so the loop can drain
		// mid-await.
		return (await fs.readFile(daemonTokenPath(), "utf8")).trim();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/**
 * Read the token, creating it when absent. The file is published with a hard
 * link from a private temp file, so a reader never sees it half-written; the
 * daemon (`server.ts`) creates it with `wx` and may leave it empty briefly,
 * which is retried here.
 */
async function readOrCreateToken(): Promise<string> {
	const tokenPath = daemonTokenPath();
	await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const existing = await readToken();
		if (existing) return existing;
		if (existing === undefined) {
			const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
			const temp = `${tokenPath}.${process.pid}.${crypto.randomUUID()}`;
			await fs.writeFile(temp, token, { mode: 0o600, flag: "wx" });
			try {
				await fs.link(temp, tokenPath);
				return token;
			} catch (error) {
				if (!isEexist(error)) throw error;
			} finally {
				await fs.rm(temp, { force: true });
			}
			continue;
		}
		// The daemon created the file and has not written it yet.
		await Bun.sleep(10);
	}
	throw new Error(`Timed out initializing the daemon token at ${tokenPath}`);
}

function dial(): Promise<IpcConnection> {
	const options = { framing: "lines", timeoutMs: DIAL_TIMEOUT_MS } as const;
	const tcp = daemonTcpAddress();
	return tcp
		? IpcConnection.connectTcp(tcp.host, tcp.port, options)
		: IpcConnection.connect(daemonEndpoint(), options);
}

function spawnDaemon(): void {
	const spawn = resolveWorkerSpawnCmd(DAEMON_WORKER_ARG);
	const child = Bun.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		...DAEMON_SPAWN_OPTIONS,
	});
	child.unref();
}

function abortError(op: DaemonOp["op"]): Error {
	return new Error(`Daemon ${op} request aborted`);
}

/** Settle with `promise`, or reject with the abort error of `op` as soon as `signal` fires. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined, op: DaemonOp["op"]): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError(op));
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const abort = (): void => reject(abortError(op));
	signal.addEventListener("abort", abort, { once: true });
	return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", abort));
}

function unreachableError(lastError: Error | undefined): Error {
	const where = daemonTcpAddress() ? `${DAEMON_TCP_ENV}=${process.env[DAEMON_TCP_ENV]}` : daemonEndpoint();
	return new Error(
		`The omp daemon did not answer at ${where} within ${START_TIMEOUT_MS / 1000}s: ` +
			`${lastError?.message ?? "endpoint unavailable"}. Runtime dir: ${daemonDir()}. ` +
			"Run `omp --smoke-test` to verify daemon startup, or `omp ps` to inspect it.",
	);
}

function helloFrame(token: string): string {
	const hello: DaemonHello = {
		v: DAEMON_PROTOCOL_VERSION,
		token,
		client: { pid: process.pid, build: daemonBuildId(), exe: resolveCliEntryCmd() },
	};
	return JSON.stringify(hello);
}

function isWelcome(value: unknown): value is DaemonWelcome {
	if (typeof value !== "object" || value === null || !("daemon" in value) || !("v" in value)) return false;
	const daemon = value.daemon;
	return (
		typeof value.v === "number" &&
		typeof daemon === "object" &&
		daemon !== null &&
		"build" in daemon &&
		typeof daemon.build === "string" &&
		"pid" in daemon &&
		typeof daemon.pid === "number"
	);
}

/** Start `conn`, send the hello and resolve with the welcome; later lines go to `handlers`. */
function handshake(conn: IpcConnection, token: string, handlers: LinkHandlers): Promise<Link> {
	const { promise, resolve, reject } = Promise.withResolvers<Link>();
	const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
	let welcomed = false;
	const timer = setTimeout(() => {
		conn.destroy();
		reject(new DaemonTimeoutError("The omp daemon did not answer the hello"));
	}, HELLO_TIMEOUT_MS);
	conn.start(
		line => {
			if (welcomed) {
				handlers.onLine(line);
				return;
			}
			welcomed = true;
			clearTimeout(timer);
			try {
				const reply: unknown = JSON.parse(line);
				if (typeof reply === "object" && reply !== null && "error" in reply && typeof reply.error === "string") {
					// A daemon on its way out refuses new clients; its successor will not.
					if (reply.error === DAEMON_SHUTTING_DOWN) throw new DaemonTransientError(reply.error);
					throw new DaemonRejectedError(reply.error);
				}
				if (!isWelcome(reply)) throw new Error("Malformed daemon welcome");
				if (reply.v !== DAEMON_PROTOCOL_VERSION) {
					throw new DaemonRejectedError(
						`Daemon protocol ${reply.v} does not match client protocol ${DAEMON_PROTOCOL_VERSION}`,
					);
				}
				resolve({ conn, welcome: reply, closed });
			} catch (error) {
				conn.destroy();
				reject(toError(error));
			}
		},
		reason => {
			markClosed();
			if (!welcomed) {
				clearTimeout(timer);
				// Accepted, then dropped by a daemon that is closing its transport.
				reject(
					new DaemonTransientError(
						`The omp daemon closed the connection during the hello${reason ? `: ${reason}` : ""}`,
					),
				);
				return;
			}
			handlers.onClose(reason);
		},
	);
	conn.send(helloFrame(token));
	return promise;
}

function requestTimeoutMs(operation: DaemonOp): number {
	switch (operation.op) {
		case "open":
			if (operation.awaitReady === false) return DEFAULT_REQUEST_TIMEOUT_MS;
			// The daemon waits up to the unit's own readiness timeout.
			if (operation.proc) return (operation.proc.ready?.timeoutMs ?? 0) + DEFAULT_REQUEST_TIMEOUT_MS;
			return MODULE_OPEN_TIMEOUT_MS;
		case "wait":
		case "stop":
			return operation.timeoutMs + TIMEOUT_SLACK_MS;
		case "logs":
			return operation.follow ? operation.timeoutMs + TIMEOUT_SLACK_MS : DEFAULT_REQUEST_TIMEOUT_MS;
		case "call":
			return CALL_TIMEOUT_MS;
		case "upgrade":
			return UPGRADE_TIMEOUT_MS;
		default:
			return DEFAULT_REQUEST_TIMEOUT_MS;
	}
}

/** Whether `build` (a daemon's) is older than this client's. */
function isOlderBuild(build: string): boolean {
	try {
		return compareDaemonBuilds(build, daemonBuildId()) < 0;
	} catch {
		return false;
	}
}

/** Raw byte stream to one unit over a dedicated, upgraded connection. */
class Tunnel implements DaemonTunnel {
	readonly unit: UnitSnapshot;
	readonly #conn: IpcConnection;
	#buffered: Uint8Array[] = [];
	#onData: ((chunk: Uint8Array) => void) | undefined;
	#onClose: ((reason: string | null) => void) | undefined;
	#ended: { reason: string | null } | undefined;

	constructor(unit: UnitSnapshot, conn: IpcConnection) {
		this.unit = unit;
		this.#conn = conn;
	}

	push(chunk: Uint8Array): void {
		if (this.#onData) this.#onData(chunk);
		else this.#buffered.push(chunk);
	}

	end(reason: string | null): void {
		if (this.#ended) return;
		this.#ended = { reason };
		this.#onClose?.(reason);
	}

	send(data: string | Uint8Array): boolean {
		return this.#conn.send(data);
	}

	drained(): Promise<void> {
		return this.#conn.drained();
	}

	start(onData: (chunk: Uint8Array) => void, onClose: (reason: string | null) => void): void {
		if (this.#onData) throw new Error("Daemon tunnel already started");
		this.#onData = onData;
		this.#onClose = onClose;
		const buffered = this.#buffered;
		this.#buffered = [];
		for (const chunk of buffered) onData(chunk);
		if (this.#ended) onClose(this.#ended.reason);
	}

	close(): void {
		this.#conn.end();
	}

	ref(): void {
		this.#conn.ref();
	}

	unref(): void {
		this.#conn.unref();
	}
}

class DaemonConnection implements DaemonClient {
	readonly #options: ConnectOptions;
	#welcome: DaemonWelcome | undefined;
	#link: Link | undefined;
	#connecting: Promise<void> | undefined;
	#connectedOnce = false;
	#closed = false;
	#reconnectTimer: NodeJS.Timeout | undefined;
	#reconnectDelayMs = RECONNECT_MIN_MS;
	#replayTimer: NodeJS.Timeout | undefined;
	readonly #pending = new Map<string, PendingRequest>();
	/** `open` requests given up on (timeout, abort): a late answer's lease must be released. */
	readonly #abandonedOpens = new Set<string>();
	readonly #completionSinks = new Map<string, (event: DaemonCompletionEvent) => Promise<void> | void>();
	readonly #notifySinks = new Map<string, (event: DaemonNotifyEvent) => void>();
	readonly #unitSinks = new Set<(event: DaemonUnitEvent) => void>();
	readonly #reconnectSinks = new Set<() => void>();
	/** Owners detached with `preservePending`: the daemon keeps their completions for a later replay. */
	readonly #preservedOwners = new Set<string>();
	/** Owners whose pending completions the daemon may drop. */
	readonly #unsubscribes = new Set<string>();
	/**
	 * Owners whose pending completions the daemon should redeliver on this connection, each with
	 * the sequence of its latest request: an answer only clears the requests its `subscribe` carried.
	 */
	readonly #replays = new Map<string, number>();
	#replaySeq = 0;
	readonly #seenCompletionIds = new Set<string>();
	readonly #inFlightCompletionIds = new Set<string>();
	readonly #subscriptionId = crypto.randomUUID();

	constructor(options: ConnectOptions) {
		this.#options = options;
	}

	get welcome(): DaemonWelcome {
		if (!this.#welcome) throw new Error("Daemon client is not connected");
		return this.#welcome;
	}

	/** A live control connection exists right now; requests would not dial (or spawn) first. */
	get connected(): boolean {
		return !this.#closed && this.#link !== undefined && !this.#link.conn.closed;
	}

	/** Establish the first connection; rejects when the daemon cannot be reached. */
	connect(): Promise<void> {
		return this.#ensureConnected();
	}

	async request<O extends DaemonOp>(operation: O, signal?: AbortSignal): Promise<DaemonResult<O["op"]>> {
		try {
			return await this.#request(operation, signal);
		} catch (error) {
			// Another client's `upgrade` (or a shutdown) began: retry once against the successor.
			if (!(error instanceof DaemonRejectedError) || error.message !== DAEMON_RESTARTING) throw error;
			const link = this.#link;
			if (link) await untilAborted(Promise.race([link.closed, Bun.sleep(START_TIMEOUT_MS)]), signal, operation.op);
			return this.#request(operation, signal);
		}
	}

	async #request<O extends DaemonOp>(operation: O, signal?: AbortSignal): Promise<DaemonResult<O["op"]>> {
		if (this.#closed) throw new Error("Daemon client is closed");
		// The connection attempt is shared: an abort stops this request waiting for it, not the attempt.
		await untilAborted(this.#ensureConnected(), signal, operation.op);
		const conn = this.#link?.conn;
		if (!conn || conn.closed) throw new Error("Daemon connection is unavailable");
		if (signal?.aborted) throw abortError(operation.op);
		const id = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timeoutMs = requestTimeoutMs(operation);
		const timer = setTimeout(() => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			if (operation.op === "open") this.#abandonOpen(id);
			this.#updateRef();
			pending.removeAbort?.();
			reject(new DaemonTimeoutError(`Daemon ${operation.op} request timed out`));
		}, timeoutMs);
		const pending: PendingRequest = { op: operation.op, resolve, reject, timer };
		if (signal) {
			const abort = (): void => {
				if (!this.#pending.delete(id)) return;
				if (operation.op === "open") this.#abandonOpen(id);
				this.#updateRef();
				clearTimeout(timer);
				reject(abortError(operation.op));
				// Stop the daemon working on it; only `wait` and follow-`logs` are cancellable server-side.
				if ((operation.op === "wait" || operation.op === "logs") && !conn.closed) {
					conn.send(JSON.stringify({ id: crypto.randomUUID(), op: "cancel", requestId: id }));
				}
			};
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		this.#pending.set(id, pending);
		this.#updateRef();
		conn.send(JSON.stringify({ id, ...operation }));
		return (await promise) as DaemonResult<O["op"]>;
	}

	open(request: OpenRequest, signal?: AbortSignal): Promise<OpenResult> {
		return this.request({ op: "open", ...request }, signal);
	}

	async release(lease: string): Promise<void> {
		await this.request({ op: "release", lease });
	}

	async call<T>(
		module: string,
		method: string,
		params?: unknown,
		options?: { unit?: UnitRef; signal?: AbortSignal },
	): Promise<T> {
		const result = await this.request({ op: "call", module, method, params, unit: options?.unit }, options?.signal);
		return result.result as T;
	}

	async attach(unit: UnitRef, channel?: string, signal?: AbortSignal): Promise<DaemonTunnel> {
		if (this.#closed) throw new Error("Daemon client is closed");
		// The control connection proves (or brings up) a daemon of the right build.
		await untilAborted(this.#ensureConnected(), signal, "attach");
		const token = await untilAborted(readOrCreateToken(), signal, "attach");
		const dialing = dial();
		let conn: IpcConnection;
		try {
			conn = await untilAborted(dialing, signal, "attach");
		} catch (error) {
			// Aborted mid-dial: a connection that still comes up is nobody's.
			void dialing.then(
				late => late.destroy(),
				() => undefined,
			);
			throw error;
		}
		if (signal?.aborted) {
			conn.destroy();
			throw abortError("attach");
		}
		const { promise, resolve, reject } = Promise.withResolvers<DaemonTunnel>();
		const id = crypto.randomUUID();
		let tunnel: Tunnel | undefined;
		let settled = false;
		const settle = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error) {
				conn.destroy();
				reject(error);
			} else if (tunnel) resolve(tunnel);
		};
		const abort = (): void => settle(abortError("attach"));
		// The daemon waits for the unit to be ready before it answers.
		const timer = setTimeout(
			() => settle(new DaemonTimeoutError("Daemon attach request timed out")),
			MODULE_OPEN_TIMEOUT_MS,
		);
		signal?.addEventListener("abort", abort, { once: true });
		handshake(conn, token, {
			onLine: line => {
				if (tunnel || settled) return;
				let response: DaemonResponse;
				try {
					response = JSON.parse(line) as DaemonResponse;
				} catch (error) {
					settle(toError(error));
					return;
				}
				if (response.id !== id) return;
				if (!response.ok) {
					settle(new DaemonRejectedError(response.error));
					return;
				}
				const opened = new Tunnel((response.result as DaemonResult<"attach">).unit, conn);
				tunnel = opened;
				// Synchronously, inside the line callback: every later byte belongs to the unit.
				conn.upgradeRaw(chunk => opened.push(chunk));
				settle();
			},
			onClose: reason => {
				if (tunnel) tunnel.end(reason);
				else settle(new Error(`Daemon attach connection closed${reason ? `: ${reason}` : ""}`));
			},
		}).then(
			() => {
				if (!settled) conn.send(JSON.stringify({ id, op: "attach", unit, channel }));
			},
			(error: unknown) => settle(toError(error)),
		);
		return promise;
	}

	onCompletion(
		owner: string,
		sink: (event: DaemonCompletionEvent) => Promise<void> | void,
	): (options?: DaemonCompletionUnregisterOptions) => void {
		this.#unsubscribes.delete(owner);
		if (this.#preservedOwners.delete(owner)) this.#requestReplay(owner);
		this.#completionSinks.set(owner, sink);
		this.#updateRef();
		this.#publishSubscription();
		return options => {
			if (this.#completionSinks.get(owner) !== sink) return;
			this.#completionSinks.delete(owner);
			this.#replays.delete(owner);
			if (options?.preservePending) {
				this.#preservedOwners.add(owner);
			} else {
				this.#preservedOwners.delete(owner);
				this.#unsubscribes.add(owner);
			}
			this.#updateRef();
			this.#publishSubscription();
		};
	}

	onNotify(owner: string, sink: (event: DaemonNotifyEvent) => void): () => void {
		this.#notifySinks.set(owner, sink);
		this.#updateRef();
		return () => {
			if (this.#notifySinks.get(owner) !== sink) return;
			this.#notifySinks.delete(owner);
			this.#updateRef();
		};
	}

	onUnit(sink: (event: DaemonUnitEvent) => void): () => void {
		this.#unitSinks.add(sink);
		this.#updateRef();
		if (this.#unitSinks.size === 1) this.#watch();
		return () => {
			if (!this.#unitSinks.delete(sink)) return;
			this.#updateRef();
		};
	}

	onReconnect(sink: () => void): () => void {
		this.#reconnectSinks.add(sink);
		return () => {
			this.#reconnectSinks.delete(sink);
		};
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		clearTimeout(this.#replayTimer);
		this.#replayTimer = undefined;
		this.#link?.conn.destroy();
		this.#link = undefined;
		this.#completionSinks.clear();
		this.#notifySinks.clear();
		this.#unitSinks.clear();
		this.#reconnectSinks.clear();
		this.#rejectPending(new Error("Daemon client closed"));
	}

	async #ensureConnected(): Promise<void> {
		if (this.#link && !this.#link.conn.closed) return;
		if (this.#closed) throw new Error("Daemon client is closed");
		if (!this.#connecting) {
			this.#connecting = this.#connectOnce().finally(() => {
				this.#connecting = undefined;
			});
		}
		return this.#connecting;
	}

	async #connectOnce(): Promise<void> {
		let token: string;
		if (this.#options.spawn) {
			// Read per attempt: a deleted runtime dir needs a fresh token before any daemon can start.
			token = await readOrCreateToken();
		} else {
			// Never create anything for a daemon that may not exist.
			const existing = await readToken();
			if (!existing) throw new Error("No omp daemon is running");
			token = existing;
		}
		let link = await this.#establish(token, this.#options.spawn ? "start" : "probe");
		if (this.#options.upgrade && isOlderBuild(link.welcome.daemon.build)) {
			link = await this.#upgrade(link, token);
		}
		const reconnected = this.#connectedOnce;
		this.#connectedOnce = true;
		this.#reconnectDelayMs = RECONNECT_MIN_MS;
		this.#updateRef();
		if (reconnected) this.#afterReconnect();
	}

	/**
	 * Dial and hello until a daemon welcomes this client. Concurrent spawners
	 * race; the daemon's single-instance lock picks one and every client
	 * converges on it. A daemon that refuses new clients while it exits is
	 * waited out, then replaced when `mode` is `start`.
	 */
	async #establish(token: string, mode: DialMode): Promise<Link> {
		const deadline = Date.now() + START_TIMEOUT_MS;
		let spawnedAt: number | undefined;
		let lastError: Error | undefined;
		for (;;) {
			let conn: IpcConnection | undefined;
			try {
				conn = await dial();
			} catch (error) {
				lastError = toError(error);
				if (mode === "probe") throw lastError;
				if (mode === "start" && (spawnedAt === undefined || Date.now() - spawnedAt >= RESPAWN_MS)) {
					spawnDaemon();
					spawnedAt = Date.now();
				}
			}
			if (conn) {
				try {
					return await this.#bind(conn, token);
				} catch (error) {
					if (!(error instanceof DaemonTransientError) || mode === "probe") throw error;
					// The answering daemon was exiting; the next one may need spawning.
					lastError = error;
					spawnedAt = undefined;
				}
			}
			if (Date.now() >= deadline) throw unreachableError(lastError);
			await Bun.sleep(DIAL_RETRY_MS);
		}
	}

	async #bind(conn: IpcConnection, token: string): Promise<Link> {
		const link = await handshake(conn, token, {
			onLine: line => this.#onLine(line),
			onClose: () => this.#onClose(conn),
		});
		if (this.#closed) {
			conn.destroy();
			throw new Error("Daemon client closed");
		}
		this.#link = link;
		this.#welcome = link.welcome;
		this.#updateRef();
		return link;
	}

	/** Ask an older daemon to re-exec into this build, then dial its successor. */
	async #upgrade(link: Link, token: string): Promise<Link> {
		logger.debug("Upgrading the omp daemon", { from: link.welcome.daemon.build, to: daemonBuildId() });
		try {
			const { reexec } = await this.#request({ op: "upgrade" });
			// The daemon does not consider this build newer: it stays, nothing closes.
			if (!reexec) return link;
		} catch (error) {
			// Another client's upgrade is under way, or the daemon dropped the connection before answering.
			logger.debug("Daemon upgrade request ended without an answer", { error: toError(error).message });
		}
		const closed = await Promise.race([link.closed.then(() => true), Bun.sleep(START_TIMEOUT_MS).then(() => false)]);
		if (!closed) {
			logger.warn("The omp daemon did not restart after an upgrade request; keeping the older build", {
				build: link.welcome.daemon.build,
			});
			return link;
		}
		// A re-exec keeps the PID and comes back on the same endpoint; spawning now could
		// win its lock and orphan the units it carries across. Windows has no exec: the
		// old daemon exits and a fresh one must be spawned.
		let next: Link;
		if (process.platform === "win32" || !this.#options.spawn) {
			next = await this.#establish(token, this.#options.spawn ? "start" : "await");
		} else {
			try {
				next = await this.#establish(token, "await");
			} catch {
				next = await this.#establish(token, "start");
			}
		}
		if (isOlderBuild(next.welcome.daemon.build)) {
			logger.warn("The omp daemon is still an older build after an upgrade", {
				build: next.welcome.daemon.build,
				client: daemonBuildId(),
			});
		}
		return next;
	}

	#afterReconnect(): void {
		if (this.#completionSinks.size > 0 || this.#preservedOwners.size > 0) {
			// A new connection: the daemon redelivers every pending completion of the owners.
			this.#publishSubscription();
		}
		if (this.#unitSinks.size > 0) this.#watch();
		for (const sink of this.#reconnectSinks) {
			try {
				sink();
			} catch (error) {
				logger.warn("Daemon reconnect sink failed", { error: toError(error).message });
			}
		}
	}

	#watch(): void {
		void this.request({ op: "watch" }).catch(() => this.#scheduleReconnect());
	}

	/** Send the owner set (with pending unsubscribes and replay requests). */
	#publishSubscription(): void {
		if (this.#closed) return;
		const unsubscribes = [...this.#unsubscribes];
		const requested = [...this.#replays];
		const replays = requested.map(([owner]) => owner);
		void this.request({
			op: "subscribe",
			subscriptionId: this.#subscriptionId,
			owners: [...this.#completionSinks.keys()],
			detachedOwners: [...this.#preservedOwners],
			replays,
			unsubscribes,
		}).then(
			() => {
				for (const owner of unsubscribes) {
					if (!this.#completionSinks.has(owner)) this.#unsubscribes.delete(owner);
				}
				// A replay asked for while this request was in flight still needs its own.
				for (const [owner, seq] of requested) {
					if (this.#replays.get(owner) === seq) this.#replays.delete(owner);
				}
			},
			() => this.#scheduleReconnect(),
		);
	}

	/** Acknowledge handled completions. The daemon treats an ack request as nothing but acks. */
	#ack(completionId: string): void {
		if (this.#closed) return;
		void this.request({
			op: "subscribe",
			subscriptionId: this.#subscriptionId,
			owners: [],
			acks: [completionId],
		}).catch(() => this.#scheduleReconnect());
	}

	/** Ask for `owner`'s pending completions again after a sink failed on one. */
	#scheduleReplay(owner: string): void {
		this.#requestReplay(owner);
		if (this.#replayTimer) return;
		this.#replayTimer = setTimeout(() => {
			this.#replayTimer = undefined;
			this.#publishSubscription();
		}, COMPLETION_RETRY_MS);
		this.#replayTimer.unref();
	}

	#requestReplay(owner: string): void {
		this.#replays.set(owner, ++this.#replaySeq);
	}

	/** Sinks that expect events: while any exists the connection keeps the process alive. */
	#hasEventSinks(): boolean {
		return this.#completionSinks.size > 0 || this.#notifySinks.size > 0 || this.#unitSinks.size > 0;
	}

	/** Ref the connection while a reply or a subscribed event is awaited; an idle one must not hold the process. */
	#updateRef(): void {
		const conn = this.#link?.conn;
		if (!conn) return;
		if (this.#pending.size > 0 || this.#hasEventSinks()) conn.ref();
		else conn.unref();
	}

	#scheduleReconnect(): void {
		if (
			this.#closed ||
			!this.#options.reconnect ||
			this.#reconnectTimer !== undefined ||
			(this.#link !== undefined && !this.#link.conn.closed) ||
			(!this.#hasEventSinks() && this.#reconnectSinks.size === 0)
		) {
			return;
		}
		const delay = this.#reconnectDelayMs;
		this.#reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#ensureConnected().catch(error => {
				logger.debug("Daemon reconnect failed", { error: toError(error).message });
				this.#scheduleReconnect();
			});
		}, delay);
		// Event sinks keep the process waiting for the daemon to come back; leases alone do not.
		if (!this.#hasEventSinks()) this.#reconnectTimer.unref();
	}

	#onClose(conn: IpcConnection): void {
		if (this.#link?.conn !== conn) return;
		this.#link = undefined;
		// Leases die with the connection; nothing left to release.
		this.#abandonedOpens.clear();
		this.#rejectPending(new Error("Daemon connection closed"));
		this.#scheduleReconnect();
	}

	#onLine(line: string): void {
		let message: DaemonResponse | DaemonEvent;
		try {
			message = JSON.parse(line) as DaemonResponse | DaemonEvent;
		} catch (error) {
			logger.warn("Ignoring unreadable daemon line", { error: toError(error).message });
			return;
		}
		if ("ev" in message) {
			this.#onEvent(message);
			return;
		}
		const pending = this.#pending.get(message.id);
		if (!pending) {
			if (!this.#abandonedOpens.delete(message.id)) return;
			// The caller gave up, but the daemon granted the lease: give it back or it lives as long as this connection.
			const lease = message.ok ? (message.result as OpenResult).lease : undefined;
			if (lease !== undefined) {
				void this.release(lease).catch(error =>
					logger.debug("Failed to release an abandoned daemon lease", { error: toError(error).message }),
				);
			}
			return;
		}
		this.#pending.delete(message.id);
		this.#updateRef();
		clearTimeout(pending.timer);
		pending.removeAbort?.();
		if (message.ok) pending.resolve(message.result);
		else pending.reject(new DaemonRejectedError(message.error));
	}

	#onEvent(event: DaemonEvent): void {
		switch (event.ev) {
			case "completed":
				void this.#deliverCompletion(event);
				return;
			case "notify":
				try {
					this.#notifySinks.get(event.owner)?.(event);
				} catch (error) {
					logger.warn("Daemon notify sink failed", {
						owner: event.owner,
						unit: event.unit.key,
						error: toError(error).message,
					});
				}
				return;
			case "unit":
				for (const sink of this.#unitSinks) {
					try {
						sink(event);
					} catch (error) {
						logger.warn("Daemon unit sink failed", { unit: event.unit.id, error: toError(error).message });
					}
				}
				return;
			default:
				// A newer daemon's event kind.
				return;
		}
	}

	async #deliverCompletion(event: DaemonCompletionEvent): Promise<void> {
		// Redelivered after a lost ack (reconnect, replay): acknowledge without running the sink again.
		if (this.#seenCompletionIds.has(event.completionId)) {
			this.#ack(event.completionId);
			return;
		}
		if (this.#inFlightCompletionIds.has(event.completionId)) return;
		const sink = this.#completionSinks.get(event.owner);
		if (!sink) return;
		this.#inFlightCompletionIds.add(event.completionId);
		try {
			await sink(event);
			if (this.#seenCompletionIds.size >= SEEN_COMPLETIONS_LIMIT) {
				const oldest = this.#seenCompletionIds.values().next().value;
				if (oldest !== undefined) this.#seenCompletionIds.delete(oldest);
			}
			this.#seenCompletionIds.add(event.completionId);
			this.#ack(event.completionId);
		} catch (error) {
			logger.warn("Daemon completion sink failed", {
				owner: event.owner,
				completionId: event.completionId,
				error: toError(error).message,
			});
			// Unacked, it stays pending in the daemon; ask for it again later. Dropping the
			// connection instead would drop this process's leases with it.
			this.#scheduleReplay(event.owner);
		} finally {
			this.#inFlightCompletionIds.delete(event.completionId);
		}
	}

	/** Only `open` answers carry something to undo; the connection's close releases the rest. */
	#abandonOpen(id: string): void {
		if (this.#abandonedOpens.size >= ABANDONED_LIMIT) {
			const oldest = this.#abandonedOpens.values().next().value;
			if (oldest !== undefined) this.#abandonedOpens.delete(oldest);
		}
		this.#abandonedOpens.add(id);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

let shared: Promise<DaemonConnection> | undefined;
let cancelExitCleanup: (() => void) | undefined;

/** Process-shared daemon client; spawns the daemon if absent and upgrades an older one. */
export function daemonClient(): Promise<DaemonClient> {
	if (!shared) {
		const client = new DaemonConnection({ spawn: true, upgrade: true, reconnect: true });
		const pending = client.connect().then(() => client);
		shared = pending;
		pending.then(bindBoardEntries, () => {});
		pending.catch(() => {
			client.close();
			if (shared === pending) shared = undefined;
		});
		cancelExitCleanup ??= postmortem.register("daemon-client", () => closeDaemonClient());
	}
	return shared;
}

/** What {@link registerOnBoard} lists: a process this omp process owns and the daemon only displays. */
export interface BoardEntryInit {
	kind: string;
	scope: UnitScope;
	key: string;
	label: string;
	pid: number;
}

/** A board listing from {@link registerOnBoard}. */
export interface BoardEntry {
	/** Take the listing off the board; idempotent. */
	dispose(): void;
}

/** Registrations still wanted on the board, rebound whenever a shared client connects. */
const boardEntries = new Set<BoardRegistration>();

function bindBoardEntries(client: DaemonConnection): void {
	for (const entry of boardEntries) entry.bind(client);
}

class BoardRegistration implements BoardEntry {
	readonly #init: BoardEntryInit;
	#client: DaemonConnection | undefined;
	#unitId: string | undefined;
	#attempt = 0;
	#disposed = false;
	#offReconnect: (() => void) | undefined;

	constructor(init: BoardEntryInit) {
		this.#init = init;
	}

	bind(client: DaemonConnection): void {
		if (this.#disposed || this.#client === client) return;
		this.#offReconnect?.();
		this.#client = client;
		this.#unitId = undefined;
		// The daemon drops registrations with the connection; list the process again on the new one.
		this.#offReconnect = client.onReconnect(() => {
			this.#unitId = undefined;
			this.#register(client);
		});
		this.#register(client);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		boardEntries.delete(this);
		this.#offReconnect?.();
		this.#offReconnect = undefined;
		const client = this.#client;
		const unitId = this.#unitId;
		this.#unitId = undefined;
		if (client && unitId !== undefined) unregisterBoardUnit(client, unitId);
	}

	#register(client: DaemonConnection): void {
		// Never dial: a dropped connection re-registers from `onReconnect`.
		if (!client.connected) return;
		const attempt = ++this.#attempt;
		const { kind, scope, key, label, pid } = this.#init;
		client.request({ op: "register", kind, scope, key, label, pid }).then(
			({ unit }) => {
				if (this.#disposed || this.#client !== client || this.#attempt !== attempt) {
					// The listing is no longer wanted (or was superseded): take it back off.
					unregisterBoardUnit(client, unit.id);
					return;
				}
				this.#unitId = unit.id;
			},
			(error: unknown) => logger.debug("Daemon board register failed", { key, error: toError(error).message }),
		);
	}
}

function unregisterBoardUnit(client: DaemonConnection, unitId: string): void {
	// A closed connection already took its registrations with it.
	if (!client.connected) return;
	client
		.request({ op: "unregister", unit: unitId })
		.catch((error: unknown) =>
			logger.debug("Daemon board unregister failed", { unitId, error: toError(error).message }),
		);
}

/**
 * List a process this omp process owns on the daemon board (an `external`
 * unit) until {@link BoardEntry.dispose}. Fire-and-forget: it never spawns
 * the daemon or waits for it. It uses the shared {@link daemonClient} only
 * once that is connected, now or later in this process, and re-registers
 * after reconnects. Failures are logged at debug level only.
 */
export function registerOnBoard(entry: BoardEntryInit): BoardEntry {
	const registration = new BoardRegistration(entry);
	boardEntries.add(registration);
	shared?.then(
		client => registration.bind(client),
		() => {},
	);
	return registration;
}

/** Close the process-shared daemon connection; its leases end with it. */
export async function closeDaemonClient(): Promise<void> {
	const pending = shared;
	shared = undefined;
	cancelExitCleanup?.();
	cancelExitCleanup = undefined;
	if (!pending) return;
	try {
		(await pending).close();
	} catch {
		// It never connected.
	}
}

/**
 * Connect to a daemon that is already running: no spawn, no upgrade, no
 * reconnect, no token creation. Resolves undefined when none answers; the
 * caller closes the client.
 */
export async function probeDaemon(): Promise<DaemonClient | undefined> {
	const client = new DaemonConnection({ spawn: false, upgrade: false, reconnect: false });
	try {
		await client.connect();
		return client;
	} catch {
		client.close();
		return undefined;
	}
}

/** How long smoke-test cleanup waits for the shut-down daemon to exit before removing its dir. */
const SMOKE_DAEMON_EXIT_MS = 10_000;

/**
 * Point every daemon use of this process at a fresh private runtime dir (and
 * off any `OMP_DAEMON_TCP`), for the distribution smoke test. The returned
 * cleanup closes the shared client, shuts that daemon down, restores the
 * environment, and removes the dir.
 */
export async function isolateDaemonForSmokeTest(): Promise<() => Promise<void>> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-smoke-"));
	const previousDir = process.env[DAEMON_DIR_ENV];
	const previousTcp = process.env[DAEMON_TCP_ENV];
	await closeDaemonClient();
	process.env[DAEMON_DIR_ENV] = root;
	delete process.env[DAEMON_TCP_ENV];
	return async () => {
		await closeDaemonClient();
		// The probe follows the env: once something else repointed it, the daemon
		// it would reach is not this one, and shutting that down is never ours to do.
		if (process.env[DAEMON_DIR_ENV] === root) {
			const probe = await probeDaemon();
			if (probe) {
				const { pid } = probe.welcome.daemon;
				try {
					await probe.request({ op: "shutdown" });
				} catch (error) {
					logger.debug("Smoke-test daemon shutdown failed", { error: toError(error).message });
				} finally {
					probe.close();
				}
				// The daemon acknowledges before it exits; on Windows its open files
				// keep the dir busy until it is gone.
				const deadline = Date.now() + SMOKE_DAEMON_EXIT_MS;
				while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
			}
			if (previousDir === undefined) delete process.env[DAEMON_DIR_ENV];
			else process.env[DAEMON_DIR_ENV] = previousDir;
			if (previousTcp !== undefined) process.env[DAEMON_TCP_ENV] = previousTcp;
		}
		await fs.rm(root, { recursive: true, force: true });
	};
}

/**
 * Start (or reach) the daemon of the current runtime dir, authenticate, and
 * ping it (distribution smoke test). Run under {@link isolateDaemonForSmokeTest}.
 */
export async function smokeTestDaemon(): Promise<void> {
	const client = new DaemonConnection({ spawn: true, upgrade: false, reconnect: false });
	try {
		await client.connect();
		const ping = await client.request({ op: "ping" });
		if (ping.build !== client.welcome.daemon.build || ping.pid !== client.welcome.daemon.pid) {
			throw new Error("daemon ping mismatch");
		}
		if (ping.build !== daemonBuildId()) {
			throw new Error(`daemon build ${ping.build} is not this build ${daemonBuildId()}`);
		}
	} finally {
		client.close();
	}
}
