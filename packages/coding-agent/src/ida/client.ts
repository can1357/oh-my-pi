/**
 * omp-side access to IDA databases hosted by broker-supervised daemons (`host.ts`).
 *
 * Every open database is one `omp.ida.<id>` daemon in the project's daemon broker, so `omp ps`
 * lists, stops, and tails it, and every omp process in the project shares it. This module starts
 * hosts on demand (evicting the least recently used idle one beyond `ida.maxOpen`), attaches to
 * hosts other processes started, and forwards requests over each host's socket.
 *
 * While the OS sandbox is active for the session's workspace, databases are hosted inside this omp
 * process instead (`LocalScope`): the worker must be spawned contained, which only the process that
 * holds the session's sandbox runtime can do. Those hosts are private to the process and
 * workspace, never visible to the broker or its other clients, and never mix with the daemons.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { logger, postmortem, ptree, untilAborted } from "@oh-my-pi/pi-utils";
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { type DaemonBrokerClient, daemonClientForProject } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { daemonRuntimeDir } from "../launch/paths";
import { withContainedFileAccess } from "../sandbox/file-access";
import type { SandboxRuntime } from "../sandbox/runtime";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import type { ToolSession } from "../tools";
import { containingSandbox } from "../sandbox/file-access";
import { containedIdaWorkerSpawner } from "./contained";
import { connectSocket, HostConnection, IdaDatabase, IdaHostGoneError } from "./database";
import { IdaHost } from "./host";
import { createIdaLink } from "./link";
import {
	errorMessage,
	IDA_DAEMON_PREFIX,
	IDA_HOST_CONFIG_ENV,
	IDA_HOST_READY_PATTERN,
	IDA_HOST_WORKER_ARG,
	type IdaHostConfig,
	idaDaemonName,
	idaHostEndpoint,
} from "./protocol";
import { resolveIdaRuntime } from "./runtime";
import { cfgIdaIdleCloseSec, cfgIdaMaxOpen } from "./settings";
import { type IdbLocation, idbRef, type LocateIdbOptions, locateIdb, prepareStoreDir } from "./store";

const HOST_LABEL = "IDA host";
/** Budget for a host to print its listening banner; the database opens after that. */
const READY_TIMEOUT_MS = 15_000;
/** attach→describe→start rounds; bounds cross-process start races and wedged-host replacement. */
const ENSURE_ATTEMPTS = 3;
/** How long eviction waits for a closed host to leave the broker's live set. */
const EXIT_WAIT_MS = 10_000;
/** How long release waits for a host's save; the host finishes it regardless. */
const FLUSH_WAIT_MS = 8_000;
/** How long release waits for an in-process host to save and close before killing its worker. */
const LOCAL_CLOSE_WAIT_MS = 30_000;
/**
 * How long one caller waits for a database to open. IDA's initial auto-analysis of a large binary
 * can run for hours; it keeps going in the host past this, and a later call picks up the result.
 */
const OPEN_WAIT_MS = 120_000;

/** Attached broker hosts by daemon name. */
const handles = new Map<string, IdaDatabase>();
/** In-flight opens by `locateIdb` id (plus workspace, when contained), shared by concurrent callers in this process. */
const pending = new Map<string, Promise<IdaDatabase>>();
let cleanupRegistered = false;

function registerCleanup(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	postmortem.register("ida-release", releaseIdaDatabases);
}

/** An in-process host and the promise that settles once it is gone. */
interface LocalHost {
	host: IdaHost;
	finished: Promise<void>;
}

/** The databases one workspace hosts inside this omp process while the OS sandbox is active. */
class LocalScope {
	readonly hosts = new Map<string, LocalHost>();
	readonly handles = new Map<string, IdaDatabase>();
}

const localScopes = new Map<string, LocalScope>();

function localScope(cwd: string): LocalScope {
	let scope = localScopes.get(cwd);
	if (!scope) {
		scope = new LocalScope();
		localScopes.set(cwd, scope);
	}
	return scope;
}

/** Where a call's databases live: the project's broker daemons, or this process's {@link LocalScope}. */
interface HostSource {
	/** Names of the hosts that have not exited. */
	liveNames(): Promise<string[]>;
	/** Attach to the host `name`, reusing this process's live connection; undefined when none runs. */
	attach(name: string, op: "open" | "status"): Promise<IdaDatabase | undefined>;
	/** Wait for the host `name` to exit (best effort). */
	waitExit(name: string): Promise<void>;
}

function hostEndpoint(broker: DaemonBrokerClient, name: string): string {
	return idaHostEndpoint(daemonRuntimeDir(broker.projectDir), name);
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
	const db = await IdaDatabase.attach(name, hostEndpoint(broker, name), op, closed => {
		if (closed && handles.get(name) === closed) handles.delete(name);
	});
	if (!db) return undefined;
	// A concurrent attach won; keep one connection per host.
	const winner = handles.get(name);
	if (winner?.connected) {
		db.disconnect();
		return winner;
	}
	handles.set(name, db);
	registerCleanup();
	return db;
}

/** Names of the scope's IDA daemons that have not exited. */
async function liveHostNames(broker: DaemonBrokerClient): Promise<string[]> {
	const result = await broker.request({ op: "list" });
	if (result.op !== "list") return [];
	return result.daemons
		.filter(daemon => daemon.name.startsWith(IDA_DAEMON_PREFIX) && !TERMINAL_STATES[daemon.state])
		.map(daemon => daemon.name);
}

function brokerSource(broker: DaemonBrokerClient): HostSource {
	return {
		liveNames: () => liveHostNames(broker),
		attach: (name, op) => attachHost(broker, name, op),
		waitExit: async name => {
			await broker.request({ op: "wait", name, for: "exit", timeoutMs: EXIT_WAIT_MS }).catch(error => {
				logger.debug("IDA host exit wait failed", { name, error: errorMessage(error) });
			});
		},
	};
}

/**
 * Attach to the in-process host `name`, reusing this process's live connection; undefined when none
 * runs. `fresh` is a host just started by the caller: it is attached even if it already failed, so
 * the caller receives the open failure instead of finding no host.
 */
async function attachLocal(
	scope: LocalScope,
	name: string,
	op: "open" | "status",
	fresh?: LocalHost,
): Promise<IdaDatabase | undefined> {
	const cached = scope.handles.get(name);
	if (cached?.connected) {
		await cached.refresh(op);
		return cached;
	}
	const local = fresh ?? scope.hosts.get(name);
	if (!local || (!fresh && local.host.stopped)) return undefined;
	const db = await connectLocal(scope, local, name, op);
	// A concurrent attach won; keep one connection per host.
	const winner = scope.handles.get(name);
	if (winner?.connected) {
		db.disconnect();
		return winner;
	}
	scope.handles.set(name, db);
	registerCleanup();
	return db;
}

/** A fresh in-process connection to `local`, not registered in `scope.handles`. */
function connectLocal(scope: LocalScope, local: LocalHost, name: string, op: "open" | "status"): Promise<IdaDatabase> {
	const [near, far] = createIdaLink();
	local.host.serve(far);
	return IdaDatabase.connect(name, near, op, {
		local: true,
		onClose: closed => {
			if (closed && scope.handles.get(name) === closed) scope.handles.delete(name);
		},
	});
}

function localSource(scope: LocalScope): HostSource {
	return {
		liveNames: async () => [...scope.hosts].filter(([, local]) => !local.host.stopped).map(([name]) => name),
		attach: (name, op) => attachLocal(scope, name, op),
		waitExit: async name => {
			await scope.hosts.get(name)?.finished;
		},
	};
}

/** Attach to every host in `names` that answers; unreachable ones are skipped. */
async function attachAll(source: HostSource, names: string[]): Promise<IdaDatabase[]> {
	const dbs = await Promise.all(names.map(name => source.attach(name, "status").catch(() => undefined)));
	return dbs.filter(db => db !== undefined);
}

/** Save and close least recently used idle hosts until starting one more stays within `ida.maxOpen`. */
async function makeRoom(session: ToolSession, source: HostSource, name: string): Promise<void> {
	const maxOpen = Math.max(1, cfgIdaMaxOpen.get(session.settings));
	for (;;) {
		const others = (await source.liveNames()).filter(other => other !== name);
		if (others.length < maxOpen) return;
		const victim = (await attachAll(source, others))
			.filter(db => db.status.state === "open" && !db.status.busy)
			.sort((a, b) => a.status.lastUsed - b.status.lastUsed)[0];
		if (!victim) {
			throw new ToolError(
				`IDA database limit reached (${maxOpen} open, all busy: ${others.join(", ")}); close one with ida close or raise ida.maxOpen`,
			);
		}
		await victim.close({ save: true });
		await source.waitExit(victim.name);
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
		await makeRoom(session, brokerSource(broker), name);
		await startHost(session, broker, loc, name);
	}
}

/**
 * Start the in-process host for `loc`, its worker spawned inside `sandbox`'s container. The host
 * outlives the tool call that started it, so its one omp-side read of the source (the staging copy)
 * runs under a contained file access of its own.
 */
async function startLocalHost(
	session: ToolSession,
	sandbox: SandboxRuntime,
	scope: LocalScope,
	loc: IdbLocation,
	name: string,
): Promise<LocalHost | undefined> {
	// A host that is stopping still holds the database's lock; replace it only once it is gone.
	await scope.hosts.get(name)?.finished;
	if (scope.hosts.has(name)) return undefined;
	const runtime = await resolveIdaRuntime(session);
	if (scope.hosts.has(name)) return undefined;
	const host = new IdaHost(
		{ loc, runtime, idleCloseMs: cfgIdaIdleCloseSec.get(session.settings) * 1000 },
		{
			prepare: target => withContainedFileAccess(session, () => prepareStoreDir(target)),
			spawn: containedIdaWorkerSpawner(sandbox),
			onStderr: text => logger.debug("IDA worker output", { id: loc.id, text: text.trimEnd() }),
			// An open that failed (typically a refused access) is retried at once: the user may have granted it.
			openFailedLingerMs: 0,
		},
	);
	const local: LocalHost = {
		host,
		finished: host
			.run()
			.then(
				code => logger.debug("IDA host exited", { id: loc.id, code }),
				error => logger.warn("IDA host failed", { id: loc.id, error: errorMessage(error) }),
			)
			.then(() => {
				if (scope.hosts.get(name) === local) scope.hosts.delete(name);
				scope.handles.get(name)?.disconnect();
			}),
	};
	scope.hosts.set(name, local);
	registerCleanup();
	return local;
}

/** Attach to the in-process host for `loc`, starting it (and waiting for the open) when none runs. */
async function openLocalIdaDatabase(
	session: ToolSession,
	sandbox: SandboxRuntime,
	scope: LocalScope,
	loc: IdbLocation,
): Promise<IdaDatabase> {
	const name = idaDaemonName(loc.id);
	let started: LocalHost | undefined;
	for (let attempt = 0; ; attempt++) {
		const db = await attachLocal(scope, name, "open", started).catch(error => {
			// A host exiting (idle close, eviction) is replaced below; open failures surface.
			if (error instanceof IdaHostGoneError) return undefined;
			throw error;
		});
		if (db) return db;
		if (attempt === ENSURE_ATTEMPTS) throw new ToolError(`IDA host ${name} did not come up`);
		await makeRoom(session, localSource(scope), name);
		started = await startLocalHost(session, sandbox, scope, loc, name);
	}
}

/** Options for {@link acquireIdaDatabase}. */
export interface AcquireIdaDatabaseOptions extends LocateIdbOptions {
	signal?: AbortSignal;
}

/**
 * Return the open database for a binary (or one slice of a universal binary) or `.i64`/`.idb`,
 * starting its host and opening (or creating) it on first use. Concurrent callers share one open;
 * aborting `signal` or exceeding {@link OPEN_WAIT_MS} stops only this caller's wait, the open itself
 * always runs to completion.
 *
 * While the OS sandbox is active the database opens in an in-process host whose worker runs
 * contained; call this inside the tool call's `withContainedFileAccess` so the binary's bytes are
 * read through the sandbox host too.
 *
 * Throws a ToolError when the database is still opening after {@link OPEN_WAIT_MS}.
 */
export async function acquireIdaDatabase(
	session: ToolSession,
	sourcePath: string,
	options: AcquireIdaDatabaseOptions = {},
): Promise<IdaDatabase> {
	const { signal, arch } = options;
	const sandbox = await containingSandbox(session.cwd);
	const scope = sandbox ? localScope(session.cwd) : undefined;
	const loc = await locateIdb(sourcePath, { arch });
	const name = idaDaemonName(loc.id);
	const cached = (scope ? scope.handles : handles).get(name);
	if (cached?.connected && cached.status.state === "open") return cached;
	const pendingKey = scope ? `${session.cwd}\0${loc.id}` : loc.id;
	let opening = pending.get(pendingKey);
	if (!opening) {
		const open =
			sandbox && scope ? openLocalIdaDatabase(session, sandbox, scope, loc) : openIdaDatabase(session, loc);
		opening = open.finally(() => pending.delete(pendingKey));
		// Every caller may have stopped waiting; remaining ones still receive the failure.
		opening.catch(error => logger.debug("IDA database open failed", { id: loc.id, error: errorMessage(error) }));
		pending.set(pendingKey, opening);
	}
	const deadline = AbortSignal.timeout(OPEN_WAIT_MS);
	try {
		return await untilAborted(signal ? AbortSignal.any([signal, deadline]) : deadline, opening);
	} catch (error) {
		if (signal?.aborted || !deadline.aborted) throw error;
		const since = await openingSince(session, name, scope);
		const age = since === undefined ? "" : ` for ${Math.round((Date.now() - since) / 60_000)}m`;
		const where = scope
			? "the analysis continues in this omp process. Retry later"
			: `the analysis continues in \`${name}\`. Retry later, or stop it with \`omp ps stop ${name}\``;
		throw new ToolError(`IDA is still analyzing ${idbRef(loc)} (opening${age}); ${where}`);
	}
}

/** When the host `name` started opening its database; undefined when it is unreachable or already open. */
async function openingSince(
	session: ToolSession,
	name: string,
	scope: LocalScope | undefined,
): Promise<number | undefined> {
	try {
		// A separate connection: caching an `opening` status in `handles` would hand stale status to the pending open.
		let db: IdaDatabase | undefined;
		if (scope) {
			const local = scope.hosts.get(name);
			db = local && !local.host.stopped ? await connectLocal(scope, local, name, "status") : undefined;
		} else {
			const broker = await daemonClientForProject(session.cwd);
			db = await IdaDatabase.attach(name, hostEndpoint(broker, name), "status", () => {});
		}
		if (!db) return undefined;
		db.disconnect();
		return db.status.state === "opening" ? db.status.lastUsed : undefined;
	} catch {
		return undefined;
	}
}

/** The host source of `session`'s databases: in-process while its sandbox is active, else the project broker. */
async function sourceFor(session: ToolSession): Promise<HostSource> {
	if (await containingSandbox(session.cwd)) return localSource(localScope(session.cwd));
	return brokerSource(await daemonClientForProject(session.cwd));
}

/**
 * The open database with `locateIdb` id (or daemon name) `ref` in this project, if any. While the
 * sandbox is active only this process's contained databases are visible, never a broker daemon's.
 */
export async function findOpenIdaDatabase(session: ToolSession, ref: string): Promise<IdaDatabase | undefined> {
	const source = await sourceFor(session);
	const name = ref.startsWith(IDA_DAEMON_PREFIX) ? ref : idaDaemonName(ref);
	const db = await source.attach(name, "status").catch(() => undefined);
	return db?.status.state === "open" ? db : undefined;
}

/**
 * Every database hosted in this project, including ones other omp processes opened; while the
 * sandbox is active, only this process's contained databases.
 */
export async function listIdaDatabases(session: ToolSession): Promise<IdaDatabase[]> {
	const source = await sourceFor(session);
	return attachAll(source, await source.liveNames());
}

/** Save and close an in-process host, killing its worker when that takes longer than {@link LOCAL_CLOSE_WAIT_MS}. */
async function closeLocalHost(name: string, local: LocalHost): Promise<void> {
	const expired = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => expired.resolve(true), LOCAL_CLOSE_WAIT_MS);
	try {
		const timedOut = await Promise.race([local.host.shutdown().then(() => false), expired.promise]);
		if (timedOut) {
			logger.warn("IDA close on release timed out; killing the worker", { name });
			await local.host.terminate();
		}
		await local.finished;
	} catch (error) {
		logger.warn("IDA close on release failed", { name, error: errorMessage(error) });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Save every attached database with unsaved changes and drop this process's connections; broker
 * hosts keep running for other omp processes and exit with the project's broker. In-process
 * (contained) hosts end with this call: each saves if needed and its worker exits. Failures are logged.
 */
export async function releaseIdaDatabases(): Promise<void> {
	const dbs = [...handles.values()];
	handles.clear();
	const locals = [...localScopes.values()].flatMap(scope => [...scope.hosts]);
	await Promise.all([
		...dbs.map(async db => {
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
		...locals.map(([name, local]) => closeLocalHost(name, local)),
	]);
}

/** Exercise worker-host IDA host startup and the ping handshake for distribution smoke tests. */
export async function smokeTestIdaHost(): Promise<void> {
	const dir = path.join(os.tmpdir(), `omp-ida-smoke-${process.pid.toString(36)}`);
	const endpoint = ipcEndpoint(os.tmpdir(), `omp-ida-smoke-${process.pid.toString(36)}`);
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
