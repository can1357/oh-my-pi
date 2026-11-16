/**
 * omp-side access to disassembler databases hosted by broker-supervised daemons (`host.ts`).
 *
 * Every open database is one `omp.<backend>.<id>` daemon in the project's daemon broker, so `omp ps`
 * lists, stops, and tails it, and every omp process in the project shares it. This module starts
 * hosts on demand (evicting the least recently used idle one beyond `disassembler.maxOpen`), attaches to
 * hosts other processes started, and forwards requests over each host's socket.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { logger, postmortem, ptree, untilAborted } from "@oh-my-pi/pi-utils";
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { type DaemonBrokerClient, daemonClientForProject } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { daemonRuntimeDir } from "../launch/paths";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import type { ToolSession } from "../tools";
import { DISASM_BACKENDS, type DisasmBackendId } from "./backend";
import {
	errorMessage,
	daemonPrefix,
	DISASM_DAEMON_PREFIXES,
	DISASM_HOST_CONFIG_ENV,
	hostReadyPattern,
	DISASM_HOST_WORKER_ARG,
	type HostCallMethod,
	type HostConfig,
	type HostRequest,
	type HostResponse,
	type HostStatus,
	daemonName,
	hostEndpoint as databaseHostEndpoint,
	parseHostResponse,
	parseHostStatus,
	formatDatabaseHandle,
	type DatabaseHandle,
	parseRetainedReference,
	type RetainedReference,
} from "./protocol";
import { installStatus, resolveWorkerRuntime } from "./runtime";
import { cfgDisasmIdleCloseSec, cfgDisasmMaxOpen } from "./settings";
import {
	type FatSelection,
	type DatabaseLocation,
	databaseRef,
	type LocateDatabaseOptions,
	locateDatabase,
} from "./store";
import type { DatabaseInfo, WorkerRequestOptions } from "./supervisor";

function backendForHost(name: string): DisasmBackendId {
	return name.startsWith(daemonPrefix("ghidra")) ? "ghidra" : "ida";
}

function hostLabel(name: string): string {
	return `${DISASM_BACKENDS[backendForHost(name)].label} host`;
}
const CONNECT_TIMEOUT_MS = 3_000;
/** Budget for a host to print its listening banner; the database opens after that. */
const READY_TIMEOUT_MS = 15_000;
/** attach→describe→start rounds; bounds cross-process start races and wedged-host replacement. */
const ENSURE_ATTEMPTS = 3;
/** How long eviction waits for a closed host to leave the broker's live set. */
const EXIT_WAIT_MS = 10_000;
/** How long release waits for a host's save; the host finishes it regardless. */
const FLUSH_WAIT_MS = 8_000;
/**
 * How long one caller waits for a database to open. Initial auto-analysis of a large binary
 * can run for hours; it keeps going in the host past this, and a later call picks up the result.
 */
const OPEN_WAIT_MS = 120_000;

/** The host connection dropped (host exited or is exiting). */
class HostGoneError extends ToolError {}

/** Connect to `endpoint`; undefined when nothing listens there. */
function connectSocket(endpoint: string): Promise<IpcConnection | undefined> {
	return IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: CONNECT_TIMEOUT_MS }).catch(() => undefined);
}

/** One connection to a host: numbered requests, responses matched by id. */
class HostConnection {
	readonly #name: string;
	readonly #conn: IpcConnection;
	readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
	#nextId = 1;
	#open = true;

	constructor(name: string, conn: IpcConnection, onClose: () => void) {
		this.#name = name;
		this.#conn = conn;
		conn.start(
			line => this.#onLine(line),
			reason => {
				if (reason) logger.debug(`${hostLabel(name)} connection error`, { name, error: reason });
				this.#open = false;
				const error = new HostGoneError(`${hostLabel(name)} ${name} exited; see \`omp ps logs ${name}\``);
				for (const entry of this.#pending.values()) entry.reject(error);
				this.#pending.clear();
				onClose();
			},
		);
	}

	get open(): boolean {
		return this.#open;
	}

	nextId(): number {
		return this.#nextId++;
	}

	/** Send `request` and wait for its answer; host-side failures reject with a {@link ToolError}. */
	call(request: HostRequest): Promise<unknown> {
		if (!this.#open) {
			return Promise.reject(
				new HostGoneError(`${hostLabel(this.#name)} ${this.#name} exited; see \`omp ps logs ${this.#name}\``),
			);
		}
		const entry = Promise.withResolvers<unknown>();
		this.#pending.set(request.id, entry);
		this.#conn.send(JSON.stringify(request));
		return entry.promise;
	}

	/** Send a request that has no answer (`cancel`). */
	notify(request: HostRequest): void {
		this.#conn.send(JSON.stringify(request));
	}

	close(): void {
		this.#conn.destroy();
	}

	#onLine(line: string): void {
		let response: HostResponse;
		try {
			response = parseHostResponse(line);
		} catch (error) {
			logger.warn(`${hostLabel(this.#name)} sent a malformed response`, {
				name: this.#name,
				error: errorMessage(error),
			});
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
 * An open disassembler database as seen from this omp process: a connection to its host daemon plus the
 * last reported {@link HostStatus}. Shared by every agent in the process.
 */
export class DisasmDatabase {
	/** Broker daemon name (`omp ps` row, `omp ps logs <name>`). */
	readonly name: string;
	readonly #conn: HostConnection;
	#status: HostStatus;

	constructor(name: string, conn: HostConnection, status: HostStatus) {
		this.name = name;
		this.#conn = conn;
		this.#status = status;
	}

	/**
	 * Connect to the host for `name` and fetch its status (`open` waits for the database to open).
	 * Undefined when no host listens; throws the host's open failure.
	 */
	static async attach(name: string, endpoint: string, op: "open" | "status"): Promise<DisasmDatabase | undefined> {
		const socket = await connectSocket(endpoint);
		if (!socket) return undefined;
		let db: DisasmDatabase | undefined;
		const conn = new HostConnection(name, socket, () => {
			if (db && handles.get(endpoint) === db) handles.delete(endpoint);
		});
		try {
			const status = parseHostStatus(await conn.call({ id: conn.nextId(), op }));
			db = new DisasmDatabase(name, conn, status);
			return db;
		} catch (error) {
			conn.close();
			throw error;
		}
	}

	/** Registry key from `locateDatabase`. */
	get id(): string {
		return this.#status.id;
	}

	/** Reference `read` and the backend tool resolve back to this database (see `databaseRef`). */
	get ref(): string {
		return this.#status.ref;
	}

	/** Portable reference to this live incarnation; opening it never creates another database. */
	get handle(): string {
		return this.#status.handle;
	}

	/** For universal binaries: the analyzed slice and its siblings. */
	get fat(): FatSelection | undefined {
		return this.#status.fat;
	}

	/** Database path reported by the backend. */
	get idbPath(): string {
		return this.#status.idbPath;
	}

	/** Loader facts reported when the database opened. */
	get info(): DatabaseInfo {
		return this.#status.info;
	}

	/** Last status fetched from the host. */
	get status(): HostStatus {
		return this.#status;
	}

	/** Whether the host connection is still up. */
	get connected(): boolean {
		return this.#conn.open;
	}

	/** Refetch the host's status; `open` first waits for the database to finish opening. */
	async refresh(op: "open" | "status" = "status"): Promise<HostStatus> {
		this.#status = parseHostStatus(await this.#conn.call({ id: this.#conn.nextId(), op }));
		return this.#status;
	}

	/**
	 * Run one worker request on the host, queued behind requests from every omp process.
	 * `timeoutMs` covers the queue wait; an abort cancels this request only (see `DisasmWorker.request`).
	 */
	async request<T>(method: HostCallMethod, params: object, options: WorkerRequestOptions = {}): Promise<T> {
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

	/** Acquire a connection-owned reference; an expected handle rejects stale or foreign incarnations. */
	async retain(expected = this.handle): Promise<RetainedReference> {
		const retained = parseRetainedReference(await this.#conn.call({ id: this.#conn.nextId(), op: "retain", handle: expected }));
		this.#status.references = retained.references;
		return retained;
	}

	/** Release one owned reference; the last release closes, honoring any owner's request to save. */
	async release(lease: string, options: { save: boolean }): Promise<void> {
		await this.#conn.call({ id: this.#conn.nextId(), op: "release", lease, save: options.save });
	}

	/** Close an unreferenced database for eviction; active owned references reject this operation. */
	async close(options: { save: boolean }): Promise<void> {
		await this.#conn.call({ id: this.#conn.nextId(), op: "close", save: options.save });
	}

	/** Drop this process's connection and its owned references; other owners keep the host alive. */
	disconnect(): void {
		this.#conn.close();
	}
}

/** Attached hosts by project-scoped endpoint; identical daemon names in different projects never alias. */
const handles = new Map<string, DisasmDatabase>();
/** In-flight opens by project-scoped endpoint, shared by concurrent callers in this process. */
const pending = new Map<string, Promise<DisasmDatabase>>();
let cleanupRegistered = false;

function hostEndpoint(broker: DaemonBrokerClient, name: string): string {
	return databaseHostEndpoint(daemonRuntimeDir(broker.projectDir), name);
}

/** Attach to the host `name`, reusing this process's live connection; undefined when none listens. */
async function attachHost(
	broker: DaemonBrokerClient,
	name: string,
	op: "open" | "status",
): Promise<DisasmDatabase | undefined> {
	const endpoint = hostEndpoint(broker, name);
	const cached = handles.get(endpoint);
	if (cached?.connected) {
		await cached.refresh(op);
		return cached;
	}
	const db = await DisasmDatabase.attach(name, endpoint, op);
	if (!db) return undefined;
	// A concurrent attach won; keep one connection per host.
	const winner = handles.get(endpoint);
	if (winner?.connected) {
		db.disconnect();
		return winner;
	}
	handles.set(endpoint, db);
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		postmortem.register("disasm-release", releaseDatabases);
	}
	return db;
}

/** Attach to every host in `names` that answers; unreachable ones are skipped. */
async function attachAll(broker: DaemonBrokerClient, names: string[]): Promise<DisasmDatabase[]> {
	const dbs = await Promise.all(names.map(name => attachHost(broker, name, "status").catch(() => undefined)));
	return dbs.filter(db => db !== undefined);
}

/** Names of the scope's disassembler daemons that have not exited. */
async function liveHostNames(broker: DaemonBrokerClient, backend?: DisasmBackendId): Promise<string[]> {
	const result = await broker.request({ op: "list" });
	if (result.op !== "list") return [];
	return result.daemons
		.filter(
			daemon =>
				(backend
					? daemon.name.startsWith(daemonPrefix(backend))
					: DISASM_DAEMON_PREFIXES.some(prefix => daemon.name.startsWith(prefix))) &&
				!TERMINAL_STATES[daemon.state],
		)
		.map(daemon => daemon.name);
}

/** Save and close least recently used idle hosts until starting one more stays within `disassembler.maxOpen`. */
async function makeRoom(session: ToolSession, broker: DaemonBrokerClient, name: string): Promise<void> {
	const maxOpen = Math.max(1, cfgDisasmMaxOpen.get(session.settings));
	for (;;) {
		const others = (await liveHostNames(broker)).filter(other => other !== name);
		if (others.length < maxOpen) return;
		const victim = (await attachAll(broker, others))
			.filter(db => db.status.state === "open" && !db.status.busy && db.status.references === 0)
			.sort((a, b) => a.status.lastUsed - b.status.lastUsed)[0];
		if (!victim) {
			throw new ToolError(
				`Disassembler database limit reached (${maxOpen} open, all busy or retained: ${others.join(", ")}); release a dsm reference or raise disassembler.maxOpen`,
			);
		}
		await victim.close({ save: true });
		await broker.request({ op: "wait", name: victim.name, for: "exit", timeoutMs: EXIT_WAIT_MS }).catch(error => {
			logger.debug(`${hostLabel(victim.name)} exit wait failed`, { name: victim.name, error: errorMessage(error) });
		});
	}
}

/** Ask the broker to start the host for `loc`; throws when it dies before listening. */
async function startHost(
	session: ToolSession,
	broker: DaemonBrokerClient,
	backend: DisasmBackendId,
	loc: DatabaseLocation,
	name: string,
): Promise<void> {
	const config: HostConfig = {
		backend,
		projectDir: broker.projectDir,
		endpoint: hostEndpoint(broker, name),
		loc,
		runtime: await resolveWorkerRuntime(session, backend),
		idleCloseMs: cfgDisasmIdleCloseSec.get(session.settings) * 1000,
	};
	const spawn = resolveWorkerSpawnCmd(DISASM_HOST_WORKER_ARG);
	let started: DaemonSnapshot;
	try {
		const result = await broker.request({
			op: "start",
			spec: {
				name,
				application: spawn.cmd[0]!,
				// The trailing ref is ignored by the host; it labels the `omp ps` COMMAND column.
				args: [...spawn.cmd.slice(1), databaseRef(loc)],
				env: { [DISASM_HOST_CONFIG_ENV]: JSON.stringify(config) },
				cwd: spawn.cwd ?? broker.projectDir,
				pty: false,
				ready: { log: hostReadyPattern(backend), timeoutMs: READY_TIMEOUT_MS },
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		if (result.op !== "start") return;
		started = result.daemon;
	} catch (error) {
		// Lost a cross-process start race; the next round attaches to the winner.
		logger.debug(`${hostLabel(name)} start contention`, { name, error: errorMessage(error) });
		return;
	}
	if (TERMINAL_STATES[started.state]) {
		const reason = started.exitReason ?? `code ${started.exitCode}`;
		throw new ToolError(`${hostLabel(name)} ${name} exited during startup (${reason}); see \`omp ps logs ${name}\``);
	}
}

/** Attach to the host for `loc`, starting it (and waiting for the open) when none runs. */
async function openDatabase(
	session: ToolSession,
	backend: DisasmBackendId,
	loc: DatabaseLocation,
	broker: DaemonBrokerClient,
): Promise<DisasmDatabase> {
	// The broker connection doubles as the presence lease keeping the host alive.
	await broker.request({ op: "ping" });
	const name = daemonName(backend, loc.id);
	for (let attempt = 0; ; attempt++) {
		const db = await attachHost(broker, name, "open").catch(error => {
			// A host exiting (idle close, eviction) is replaced below; open failures surface.
			if (error instanceof HostGoneError) return undefined;
			throw error;
		});
		if (db) return db;
		if (attempt === ENSURE_ATTEMPTS) {
			throw new ToolError(`${hostLabel(name)} ${name} did not come up; see \`omp ps logs ${name}\``);
		}
		const existing = await describeQuietly(broker, name, hostLabel(name));
		if (existing && !TERMINAL_STATES[existing.state]) {
			// Starting (possibly by another omp process): wait for its banner. Ready yet unreachable: replace it.
			if (existing.readyAt === undefined)
				await waitReady(broker, name, hostLabel(name), undefined, READY_TIMEOUT_MS);
			else await stopQuietly(broker, name, hostLabel(name));
			continue;
		}
		await makeRoom(session, broker, name);
		await startHost(session, broker, backend, loc, name);
	}
}

/** Options for {@link acquireDatabase}. */
export interface AcquireDatabaseOptions extends LocateDatabaseOptions {
	signal?: AbortSignal;
}

/**
 * Return the open database for a binary (or one slice of a universal binary) or `.i64`/`.idb`,
 * starting its host and opening (or creating) it on first use. Concurrent callers share one open;
 * aborting `signal` or exceeding {@link OPEN_WAIT_MS} stops only this caller's wait, the open itself
 * always runs to completion.
 *
 * Throws a ToolError when the database is still opening after {@link OPEN_WAIT_MS}.
 */
export async function acquireDatabase(
	session: ToolSession,
	backend: DisasmBackendId,
	sourcePath: string,
	options: AcquireDatabaseOptions = {},
): Promise<DisasmDatabase> {
	const { signal, arch } = options;
	const loc = await locateDatabase(DISASM_BACKENDS[backend], sourcePath, { arch });
	const name = daemonName(backend, loc.id);
	const broker = await daemonClientForProject(session.cwd);
	const endpoint = hostEndpoint(broker, name);
	const cached = handles.get(endpoint);
	if (cached?.connected && cached.status.state === "open") return cached;
	let opening = pending.get(endpoint);
	if (!opening) {
		opening = openDatabase(session, backend, loc, broker).finally(() => pending.delete(endpoint));
		// Every caller may have stopped waiting; remaining ones still receive the failure.
		opening.catch(error =>
			logger.debug(`${DISASM_BACKENDS[backend].label} database open failed`, {
				id: loc.id,
				error: errorMessage(error),
			}),
		);
		pending.set(endpoint, opening);
	}
	const deadline = AbortSignal.timeout(OPEN_WAIT_MS);
	try {
		return await untilAborted(signal ? AbortSignal.any([signal, deadline]) : deadline, opening);
	} catch (error) {
		if (signal?.aborted || !deadline.aborted) throw error;
		const label = DISASM_BACKENDS[backend].label;
		const status = installStatus(backend);
		if (status !== undefined) {
			throw new ToolError(
				`${label} is still being installed (${status}); it continues in the background. Retry later.`,
			);
		}
		const since = await openingSince(session, name);
		const age = since === undefined ? "" : ` for ${Math.round((Date.now() - since) / 60_000)}m`;
		throw new ToolError(
			`${label} is still analyzing ${databaseRef(loc)} (opening${age}); the analysis continues in \`${name}\`. Retry later, or stop it with \`omp ps stop ${name}\``,
		);
	}
}

/** When the host `name` started opening its database; undefined when it is unreachable or already open. */
async function openingSince(session: ToolSession, name: string): Promise<number | undefined> {
	try {
		const broker = await daemonClientForProject(session.cwd);
		// A separate connection: caching an `opening` status in `handles` would hand stale status to the pending open.
		const db = await DisasmDatabase.attach(name, hostEndpoint(broker, name), "status");
		if (!db) return undefined;
		db.disconnect();
		return db.status.state === "opening" ? db.status.lastUsed : undefined;
	} catch {
		return undefined;
	}
}

/** The open database with `locateDatabase` id (or daemon name) `ref` in this project, if any. */
export async function findOpenDatabase(
	session: ToolSession,
	backend: DisasmBackendId,
	ref: string,
): Promise<DisasmDatabase | undefined> {
	return findOpenDatabaseAt(session.cwd, backend, ref);
}

async function findOpenDatabaseAt(
	project: string,
	backend: DisasmBackendId,
	ref: string,
): Promise<DisasmDatabase | undefined> {
	const broker = await daemonClientForProject(project);
	const name = ref.startsWith(daemonPrefix(backend)) ? ref : daemonName(backend, ref);
	const db = await attachHost(broker, name, "status").catch(() => undefined);
	return db?.status.state === "open" ? db : undefined;
}

/** Find a portable reference in its originating project, rejecting a stopped or replaced host. */
export async function findDatabaseHandle(handle: DatabaseHandle): Promise<DisasmDatabase> {
	const db = await findOpenDatabaseAt(handle.project, handle.backend, handle.id);
	if (!db || db.handle !== formatDatabaseHandle(handle)) {
		throw new ToolError("dsm handle has expired; the original database is no longer open. Ask its owner for a live handle.");
	}
	return db;
}

/** Every database hosted in this project, including ones other omp processes opened. */
export async function listDatabases(session: ToolSession, backend: DisasmBackendId): Promise<DisasmDatabase[]> {
	const broker = await daemonClientForProject(session.cwd);
	return attachAll(broker, await liveHostNames(broker, backend));
}

/**
 * Save every attached database with unsaved changes and drop this process's connections; the hosts
 * keep running for other omp processes and exit with the project's broker. Failures are logged.
 */
export async function releaseDatabases(): Promise<void> {
	const dbs = [...handles.values()];
	handles.clear();
	await Promise.all(
		dbs.map(async db => {
			const wait = Promise.withResolvers<void>();
			const timer = setTimeout(wait.resolve, FLUSH_WAIT_MS);
			try {
				await Promise.race([db.flush(), wait.promise]);
			} catch (error) {
				logger.warn(`${hostLabel(db.name)} flush on release failed`, { name: db.name, error: errorMessage(error) });
			} finally {
				clearTimeout(timer);
				db.disconnect();
			}
		}),
	);
}

/** Exercise disassembler-host startup and ping without requiring a backend install. */
export async function smokeTestDisasmHost(): Promise<void> {
	const dir = path.join(os.tmpdir(), `omp-ida-smoke-${process.pid.toString(36)}`);
	const endpoint = ipcEndpoint(os.tmpdir(), `omp-ida-smoke-${process.pid.toString(36)}`);
	// A missing source makes the open fail after the host listens; `ping` still answers.
	const config: HostConfig = {
		backend: "ida",
		projectDir: dir,
		endpoint,
		loc: {
			id: "smoke",
			dir,
			sourcePath: path.join(dir, "missing"),
			stagedPath: path.join(dir, "missing"),
			kind: "store",
			openPath: path.join(dir, "missing"),
			isNew: true,
			lockTarget: path.join(dir, "db"),
		},
		runtime: { pythonPath: "python3", env: {} },
		idleCloseMs: 0,
	};
	const spawn = resolveWorkerSpawnCmd(DISASM_HOST_WORKER_ARG);
	const proc = ptree.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent({ [DISASM_HOST_CONFIG_ENV]: JSON.stringify(config) }),
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
