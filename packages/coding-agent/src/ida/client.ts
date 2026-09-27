/**
 * omp-side access to IDA databases hosted by broker-supervised daemons (`host.ts`).
 *
 * Every open database is one `omp.ida.<id>` daemon in the project's daemon broker, so `omp ps`
 * lists, stops, and tails it, and every omp process in the project shares it. This module starts
 * hosts on demand (evicting the least recently used idle one beyond `ida.maxOpen`), attaches to
 * hosts other processes started, and forwards requests over each host's socket.
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logger, postmortem, ptree, untilAborted } from "@oh-my-pi/pi-utils";
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { type DaemonBrokerClient, daemonClientForProject } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { daemonRuntimeDir } from "../launch/paths";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import type { ToolSession } from "../tools";
import {
	errorMessage,
	IDA_DAEMON_PREFIX,
	IDA_HOST_CONFIG_ENV,
	IDA_HOST_READY_PATTERN,
	IDA_HOST_WORKER_ARG,
	type IdaCallMethod,
	type IdaHostConfig,
	type IdaHostRequest,
	type IdaHostResponse,
	type IdaHostStatus,
	idaDaemonName,
	idaHostEndpoint,
	parseIdaHostResponse,
	parseIdaHostStatus,
	readSocketLines,
	writeFrame,
} from "./protocol";
import { resolveIdaRuntime } from "./runtime";
import { cfgIdaIdleCloseSec, cfgIdaMaxOpen } from "./settings";
import { type FatSelection, type IdbLocation, idbRef, type LocateIdbOptions, locateIdb } from "./store";
import type { IdaDatabaseInfo, IdaRequestOptions } from "./supervisor";

const HOST_LABEL = "IDA host";
const CONNECT_TIMEOUT_MS = 3_000;
/** Budget for a host to print its listening banner; the database opens after that. */
const READY_TIMEOUT_MS = 15_000;
/** attach→describe→start rounds; bounds cross-process start races and wedged-host replacement. */
const ENSURE_ATTEMPTS = 3;
/** How long eviction waits for a closed host to leave the broker's live set. */
const EXIT_WAIT_MS = 10_000;
/** How long release waits for a host's save; the host finishes it regardless. */
const FLUSH_WAIT_MS = 8_000;

/** The host connection dropped (host exited or is exiting). */
class IdaHostGoneError extends ToolError {}

/** Connect to `endpoint`; undefined when nothing listens there. */
function connectSocket(endpoint: string): Promise<net.Socket | undefined> {
	const { promise, resolve } = Promise.withResolvers<net.Socket | undefined>();
	const socket = net.createConnection(endpoint);
	const timer = setTimeout(() => {
		socket.destroy();
		resolve(undefined);
	}, CONNECT_TIMEOUT_MS);
	socket.once("connect", () => {
		clearTimeout(timer);
		socket.removeAllListeners("error");
		resolve(socket);
	});
	socket.once("error", () => {
		clearTimeout(timer);
		socket.destroy();
		resolve(undefined);
	});
	return promise;
}

/** One socket to a host: numbered requests, responses matched by id. */
class HostConnection {
	readonly #name: string;
	readonly #socket: net.Socket;
	readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
	#nextId = 1;
	#open = true;

	constructor(name: string, socket: net.Socket, onClose: () => void) {
		this.#name = name;
		this.#socket = socket;
		socket.on("error", error => logger.debug("IDA host connection error", { name, error: errorMessage(error) }));
		socket.on("close", () => {
			this.#open = false;
			const error = new IdaHostGoneError(`IDA host ${name} exited; see \`omp ps logs ${name}\``);
			for (const entry of this.#pending.values()) entry.reject(error);
			this.#pending.clear();
			onClose();
		});
		readSocketLines(socket, line => this.#onLine(line));
	}

	get open(): boolean {
		return this.#open;
	}

	nextId(): number {
		return this.#nextId++;
	}

	/** Send `request` and wait for its answer; host-side failures reject with a {@link ToolError}. */
	call(request: IdaHostRequest): Promise<unknown> {
		if (!this.#open) {
			return Promise.reject(
				new IdaHostGoneError(`IDA host ${this.#name} exited; see \`omp ps logs ${this.#name}\``),
			);
		}
		const entry = Promise.withResolvers<unknown>();
		this.#pending.set(request.id, entry);
		writeFrame(this.#socket, request);
		return entry.promise;
	}

	/** Send a request that has no answer (`cancel`). */
	notify(request: IdaHostRequest): void {
		writeFrame(this.#socket, request);
	}

	close(): void {
		this.#socket.destroy();
	}

	#onLine(line: string): void {
		let response: IdaHostResponse;
		try {
			response = parseIdaHostResponse(line);
		} catch (error) {
			logger.warn("IDA host sent a malformed response", { name: this.#name, error: errorMessage(error) });
			return;
		}
		const entry = this.#pending.get(response.id);
		if (!entry) return;
		this.#pending.delete(response.id);
		if (response.ok) entry.resolve(response.result);
		else entry.reject(new ToolError(response.error));
	}
}

/**
 * An open IDA database as seen from this omp process: a connection to its host daemon plus the
 * last reported {@link IdaHostStatus}. Shared by every agent in the process.
 */
export class IdaDatabase {
	/** Broker daemon name (`omp ps` row, `omp ps logs <name>`). */
	readonly name: string;
	readonly #conn: HostConnection;
	#status: IdaHostStatus;

	private constructor(name: string, conn: HostConnection, status: IdaHostStatus) {
		this.name = name;
		this.#conn = conn;
		this.#status = status;
	}

	/**
	 * Connect to the host for `name` and fetch its status (`open` waits for the database to open).
	 * Undefined when no host listens; throws the host's open failure.
	 */
	static async attach(name: string, endpoint: string, op: "open" | "status"): Promise<IdaDatabase | undefined> {
		const socket = await connectSocket(endpoint);
		if (!socket) return undefined;
		let db: IdaDatabase | undefined;
		const conn = new HostConnection(name, socket, () => {
			if (db && handles.get(name) === db) handles.delete(name);
		});
		try {
			const status = parseIdaHostStatus(await conn.call({ id: conn.nextId(), op }));
			db = new IdaDatabase(name, conn, status);
			return db;
		} catch (error) {
			conn.close();
			throw error;
		}
	}

	/** Registry key from `locateIdb`. */
	get id(): string {
		return this.#status.id;
	}

	/** Reference `read` and `ida db=` resolve back to this database (see `idbRef`). */
	get ref(): string {
		return this.#status.ref;
	}

	/** For universal binaries: the analyzed slice and its siblings. */
	get fat(): FatSelection | undefined {
		return this.#status.fat;
	}

	/** Path of the IDB file as reported by IDA. */
	get idbPath(): string {
		return this.#status.idbPath;
	}

	/** Loader facts reported when the database opened. */
	get info(): IdaDatabaseInfo {
		return this.#status.info;
	}

	/** Last status fetched from the host. */
	get status(): IdaHostStatus {
		return this.#status;
	}

	/** Whether the host connection is still up. */
	get connected(): boolean {
		return this.#conn.open;
	}

	/** Refetch the host's status; `open` first waits for the database to finish opening. */
	async refresh(op: "open" | "status" = "status"): Promise<IdaHostStatus> {
		this.#status = parseIdaHostStatus(await this.#conn.call({ id: this.#conn.nextId(), op }));
		return this.#status;
	}

	/**
	 * Run one worker request on the host, queued behind requests from every omp process.
	 * `timeoutMs` covers the queue wait; an abort cancels this request only (see `IdaWorker.request`).
	 */
	async request<T>(method: IdaCallMethod, params: object, options: IdaRequestOptions = {}): Promise<T> {
		const { signal, timeoutMs } = options;
		signal?.throwIfAborted();
		const id = this.#conn.nextId();
		const answer = this.#conn.call({ id, op: "call", method, params, timeoutMs });
		const onAbort = () => this.#conn.notify({ id: this.#conn.nextId(), op: "cancel", target: id });
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// The worker answers with the JSON shape documented for `method`.
			return (await untilAborted(signal, answer)) as T;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Save when the database has unsaved changes. */
	async flush(): Promise<void> {
		await this.#conn.call({ id: this.#conn.nextId(), op: "flush" });
	}

	/** Close the database (saving first when `save`); its host exits afterwards. */
	async close(options: { save: boolean }): Promise<void> {
		await this.#conn.call({ id: this.#conn.nextId(), op: "close", save: options.save });
	}

	/** Drop this process's connection; the host keeps running. */
	disconnect(): void {
		this.#conn.close();
	}
}

/** Attached hosts by daemon name. */
const handles = new Map<string, IdaDatabase>();
/** In-flight opens by `locateIdb` id, shared by concurrent callers in this process. */
const pending = new Map<string, Promise<IdaDatabase>>();
let cleanupRegistered = false;

function hostEndpoint(broker: DaemonBrokerClient, name: string): string {
	return idaHostEndpoint(broker.projectDir, daemonRuntimeDir(broker.projectDir), name);
}

/** Attach to the host `name`, reusing this process's live connection; undefined when none listens. */
async function attachHost(
	broker: DaemonBrokerClient,
	name: string,
	op: "open" | "status",
): Promise<IdaDatabase | undefined> {
	const cached = handles.get(name);
	if (cached?.connected) {
		await cached.refresh(op);
		return cached;
	}
	const db = await IdaDatabase.attach(name, hostEndpoint(broker, name), op);
	if (!db) return undefined;
	// A concurrent attach won; keep one connection per host.
	const winner = handles.get(name);
	if (winner?.connected) {
		db.disconnect();
		return winner;
	}
	handles.set(name, db);
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		postmortem.register("ida-release", releaseIdaDatabases);
	}
	return db;
}

/** Attach to every host in `names` that answers; unreachable ones are skipped. */
async function attachAll(broker: DaemonBrokerClient, names: string[]): Promise<IdaDatabase[]> {
	const dbs = await Promise.all(names.map(name => attachHost(broker, name, "status").catch(() => undefined)));
	return dbs.filter(db => db !== undefined);
}

/** Names of the scope's IDA daemons that have not exited. */
async function liveHostNames(broker: DaemonBrokerClient): Promise<string[]> {
	const result = await broker.request({ op: "list" });
	if (result.op !== "list") return [];
	return result.daemons
		.filter(daemon => daemon.name.startsWith(IDA_DAEMON_PREFIX) && !TERMINAL_STATES[daemon.state])
		.map(daemon => daemon.name);
}

/** Save and close least recently used idle hosts until starting one more stays within `ida.maxOpen`. */
async function makeRoom(session: ToolSession, broker: DaemonBrokerClient, name: string): Promise<void> {
	const maxOpen = Math.max(1, cfgIdaMaxOpen.get(session.settings));
	for (;;) {
		const others = (await liveHostNames(broker)).filter(other => other !== name);
		if (others.length < maxOpen) return;
		const victim = (await attachAll(broker, others))
			.filter(db => db.status.state === "open" && !db.status.busy)
			.sort((a, b) => a.status.lastUsed - b.status.lastUsed)[0];
		if (!victim) {
			throw new ToolError(
				`IDA database limit reached (${maxOpen} open, all busy: ${others.join(", ")}); close one with ida close or raise ida.maxOpen`,
			);
		}
		await victim.close({ save: true });
		await broker.request({ op: "wait", name: victim.name, for: "exit", timeoutMs: EXIT_WAIT_MS }).catch(error => {
			logger.debug("IDA host exit wait failed", { name: victim.name, error: errorMessage(error) });
		});
	}
}

/** Ask the broker to start the host for `loc`; throws when it dies before listening. */
async function startHost(
	session: ToolSession,
	broker: DaemonBrokerClient,
	loc: IdbLocation,
	name: string,
): Promise<void> {
	const config: IdaHostConfig = {
		endpoint: hostEndpoint(broker, name),
		loc,
		runtime: await resolveIdaRuntime(session),
		idleCloseMs: cfgIdaIdleCloseSec.get(session.settings) * 1000,
	};
	const spawn = resolveWorkerSpawnCmd(IDA_HOST_WORKER_ARG);
	let started: DaemonSnapshot;
	try {
		const result = await broker.request({
			op: "start",
			spec: {
				name,
				application: spawn.cmd[0]!,
				// The trailing ref is ignored by the host; it labels the `omp ps` COMMAND column.
				args: [...spawn.cmd.slice(1), idbRef(loc)],
				env: { [IDA_HOST_CONFIG_ENV]: JSON.stringify(config) },
				cwd: spawn.cwd ?? broker.projectDir,
				pty: false,
				ready: { log: IDA_HOST_READY_PATTERN, timeoutMs: READY_TIMEOUT_MS },
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		if (result.op !== "start") return;
		started = result.daemon;
	} catch (error) {
		// Lost a cross-process start race; the next round attaches to the winner.
		logger.debug("IDA host start contention", { name, error: errorMessage(error) });
		return;
	}
	if (TERMINAL_STATES[started.state]) {
		const reason = started.exitReason ?? `code ${started.exitCode}`;
		throw new ToolError(`IDA host ${name} exited during startup (${reason}); see \`omp ps logs ${name}\``);
	}
}

/** Attach to the host for `loc`, starting it (and waiting for the open) when none runs. */
async function openIdaDatabase(session: ToolSession, loc: IdbLocation): Promise<IdaDatabase> {
	const broker = await daemonClientForProject(session.cwd);
	// The broker connection doubles as the presence lease keeping the host alive.
	await broker.request({ op: "ping" });
	const name = idaDaemonName(loc.id);
	for (let attempt = 0; ; attempt++) {
		const db = await attachHost(broker, name, "open").catch(error => {
			// A host exiting (idle close, eviction) is replaced below; open failures surface.
			if (error instanceof IdaHostGoneError) return undefined;
			throw error;
		});
		if (db) return db;
		if (attempt === ENSURE_ATTEMPTS) {
			throw new ToolError(`IDA host ${name} did not come up; see \`omp ps logs ${name}\``);
		}
		const existing = await describeQuietly(broker, name, HOST_LABEL);
		if (existing && !TERMINAL_STATES[existing.state]) {
			// Starting (possibly by another omp process): wait for its banner. Ready yet unreachable: replace it.
			if (existing.readyAt === undefined) await waitReady(broker, name, HOST_LABEL, undefined, READY_TIMEOUT_MS);
			else await stopQuietly(broker, name, HOST_LABEL);
			continue;
		}
		await makeRoom(session, broker, name);
		await startHost(session, broker, loc, name);
	}
}

/** Options for {@link acquireIdaDatabase}. */
export interface AcquireIdaDatabaseOptions extends LocateIdbOptions {
	signal?: AbortSignal;
}

/**
 * Return the open database for a binary (or one slice of a universal binary) or `.i64`/`.idb`,
 * starting its host and opening (or creating) it on first use. Concurrent callers share one open;
 * aborting `signal` stops only this caller's wait, the open itself always runs to completion.
 */
export async function acquireIdaDatabase(
	session: ToolSession,
	sourcePath: string,
	options: AcquireIdaDatabaseOptions = {},
): Promise<IdaDatabase> {
	const { signal, arch } = options;
	const loc = await locateIdb(sourcePath, { arch });
	const cached = handles.get(idaDaemonName(loc.id));
	if (cached?.connected && cached.status.state === "open") return cached;
	let opening = pending.get(loc.id);
	if (!opening) {
		opening = openIdaDatabase(session, loc).finally(() => pending.delete(loc.id));
		// Every caller may have stopped waiting; remaining ones still receive the failure.
		opening.catch(error => logger.debug("IDA database open failed", { id: loc.id, error: errorMessage(error) }));
		pending.set(loc.id, opening);
	}
	return untilAborted(signal, opening);
}

/** The open database with `locateIdb` id (or daemon name) `ref` in this project, if any. */
export async function findOpenIdaDatabase(session: ToolSession, ref: string): Promise<IdaDatabase | undefined> {
	const broker = await daemonClientForProject(session.cwd);
	const name = ref.startsWith(IDA_DAEMON_PREFIX) ? ref : idaDaemonName(ref);
	const db = await attachHost(broker, name, "status").catch(() => undefined);
	return db?.status.state === "open" ? db : undefined;
}

/** Every database hosted in this project, including ones other omp processes opened. */
export async function listIdaDatabases(session: ToolSession): Promise<IdaDatabase[]> {
	const broker = await daemonClientForProject(session.cwd);
	return attachAll(broker, await liveHostNames(broker));
}

/**
 * Save every attached database with unsaved changes and drop this process's connections; the hosts
 * keep running for other omp processes and exit with the project's broker. Failures are logged.
 */
export async function releaseIdaDatabases(): Promise<void> {
	const dbs = [...handles.values()];
	handles.clear();
	await Promise.all(
		dbs.map(async db => {
			const wait = Promise.withResolvers<void>();
			const timer = setTimeout(wait.resolve, FLUSH_WAIT_MS);
			try {
				await Promise.race([db.flush(), wait.promise]);
			} catch (error) {
				logger.warn("IDA flush on release failed", { name: db.name, error: errorMessage(error) });
			} finally {
				clearTimeout(timer);
				db.disconnect();
			}
		}),
	);
}

/** Exercise worker-host IDA host startup and the ping handshake for distribution smoke tests. */
export async function smokeTestIdaHost(): Promise<void> {
	const dir = path.join(os.tmpdir(), `omp-ida-smoke-${process.pid.toString(36)}`);
	const endpoint =
		process.platform === "win32" ? `\\\\.\\pipe\\omp-ida-smoke-${process.pid.toString(16)}` : `${dir}.sock`;
	// A missing source makes the open fail after the host listens; `ping` still answers.
	const config: IdaHostConfig = {
		endpoint,
		loc: {
			id: "smoke",
			dir,
			sourcePath: path.join(dir, "missing"),
			kind: "store",
			openPath: path.join(dir, "missing"),
			isNew: true,
			lockTarget: path.join(dir, "db"),
		},
		runtime: { pythonPath: "python3", env: {} },
		idleCloseMs: 0,
	};
	const spawn = resolveWorkerSpawnCmd(IDA_HOST_WORKER_ARG);
	const proc = ptree.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent({ [IDA_HOST_CONFIG_ENV]: JSON.stringify(config) }),
	});
	try {
		const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS;
		let alive = false;
		while (!alive && Date.now() < deadline && proc.exitCode === null) {
			const socket = await connectSocket(endpoint);
			if (socket) {
				const conn = new HostConnection("smoke", socket, () => {});
				alive = (await conn.call({ id: conn.nextId(), op: "ping" }).catch(() => undefined)) === "pong";
				conn.close();
			}
			if (!alive) await Bun.sleep(200);
		}
		if (!alive) {
			throw new Error(`ida host smoke failed: no ping response (${proc.peekStderr().slice(-500) || "no stderr"})`);
		}
	} finally {
		proc.kill();
		await proc.exited.catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
		if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
	}
}
