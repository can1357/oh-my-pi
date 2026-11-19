/**
 * omp-side access to disassembler databases hosted by the omp daemon's `disasm` module.
 *
 * Every open database is one global-scope `disasm` unit keyed `<backend>:<id>`, so `omp ps`
 * lists, stops, and tails it, and every omp process shares it. This module opens units on demand
 * (the daemon closes the least recently used idle one beyond `disassembler.maxOpen`), attaches a
 * tunnel to each, and forwards NDJSON requests over it.
 *
 * While the OS sandbox is active for the session's workspace, databases are hosted inside this omp
 * process instead (the same unit, `openLocalDisasmUnit`, with its idle close and `maxOpen` cap kept
 * here): the worker must be spawned contained, which only the process that holds the session's
 * sandbox runtime can do. Those units are private to the process and workspace, never visible to
 * the daemon or its other clients, and the daemon's are invisible to a contained session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger, postmortem, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { daemonClient } from "../daemon/client";
import { type DisasmUnit, openLocalDisasmUnit } from "../daemon/modules/disasm";
import { type DaemonTunnel, GLOBAL_SCOPE, type UnitSnapshot } from "../daemon/protocol";
import { containingSandbox, outsideContainedFileAccess, withContainedFileAccess } from "../sandbox/file-access";
import { sandboxCallDenial } from "../sandbox/gate";
import type { SandboxRuntime } from "../sandbox/runtime";
import type { ToolSession } from "../tools";
import { DISASM_BACKEND_IDS, DISASM_BACKENDS, type DisasmBackendId } from "./backend";
import { containedWorkerSpawner, workerEndpointDir } from "./contained";
import { createUnitLink, type UnitLink } from "./link";
import {
	type DatabaseHandle,
	DISASM_UNIT_KIND,
	type DisasmUnitParams,
	disasmUnitKey,
	errorMessage,
	formatDatabaseHandle,
	type HostCallMethod,
	type HostRequest,
	type HostResponse,
	type HostStatus,
	lineReader,
	parseHostResponse,
	parseHostStatus,
	parseRetainedReference,
	type RetainedReference,
} from "./protocol";
import { installStatus, resolveWorkerRuntime } from "./runtime";
import { cfgDisasmIdleCloseSec, cfgDisasmMaxOpen } from "./settings";
import {
	type DatabaseLocation,
	databaseRef,
	type FatSelection,
	type LocateDatabaseOptions,
	locateDatabase,
	prepareStoreDir,
} from "./store";
import type { DatabaseInfo, WorkerRequestOptions } from "./supervisor";

/** How long release waits for a unit's save; the unit finishes it regardless. */
const FLUSH_WAIT_MS = 8_000;
/** How long release waits for an in-process unit to save and close before killing its worker. */
const LOCAL_CLOSE_WAIT_MS = 30_000;
/** Slack after {@link LOCAL_CLOSE_WAIT_MS} for the kill and the wait for the worker's exit, within the exit cleanup's deadline. */
const CLEANUP_GRACE_MS = 5_000;
/** How often an in-process unit's idle close is checked (at most). */
const LOCAL_IDLE_POLL_MS = 5_000;
/**
 * How long one caller waits for a database to open. Initial auto-analysis of a large binary
 * can run for hours; it keeps going in the daemon past this, and a later call picks up the result.
 */
const OPEN_WAIT_MS = 120_000;
/** Find-or-start rounds before giving up on a unit that keeps closing under us. */
const OPEN_ATTEMPTS = 3;

/** Log and error label for the unit keyed `<backend>:<id>`. */
function unitLabel(key: string): string {
	const backend = DISASM_BACKEND_IDS.find(id => key.startsWith(`${id}:`));
	return backend ? `${DISASM_BACKENDS[backend].label} database` : "Disassembler database";
}

function unitRef(key: string): { kind: string; scope: typeof GLOBAL_SCOPE; key: string } {
	return { kind: DISASM_UNIT_KIND, scope: GLOBAL_SCOPE, key };
}

/** The unit tunnel dropped (database closed or closing, or the daemon restarted). */
class HostGoneError extends ToolError {}

/** One tunnel to a unit: numbered requests, responses matched by id. */
class HostConnection {
	readonly #key: string;
	/** Appended to the message when the unit goes: where its logs are. */
	readonly #logsHint: string;
	readonly #tunnel: UnitLink;
	readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
	#nextId = 1;
	#open = true;

	constructor(key: string, tunnel: UnitLink, onClose: () => void, logsHint: string) {
		this.#key = key;
		this.#logsHint = logsHint;
		this.#tunnel = tunnel;
		tunnel.start(
			lineReader(line => this.#onLine(line)),
			reason => {
				if (reason) logger.debug(`${unitLabel(key)} tunnel error`, { key, error: reason });
				this.#open = false;
				const error = this.#goneError();
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

	/** Send `request` and wait for its answer; unit-side failures reject with a {@link ToolError}. */
	call(request: HostRequest): Promise<unknown> {
		if (!this.#open) return Promise.reject(this.#goneError());
		const entry = Promise.withResolvers<unknown>();
		this.#pending.set(request.id, entry);
		this.#tunnel.send(`${JSON.stringify(request)}\n`);
		return entry.promise;
	}

	/** Send a request that has no answer (`cancel`). */
	notify(request: HostRequest): void {
		if (this.#open) this.#tunnel.send(`${JSON.stringify(request)}\n`);
	}

	/** Stop using the tunnel at once (so `open` turns false before the close round-trip) and end it. */
	close(): void {
		this.#open = false;
		this.#tunnel.close();
	}

	#goneError(): HostGoneError {
		return new HostGoneError(`${unitLabel(this.#key)} ${this.#key} closed${this.#logsHint}`);
	}

	#onLine(line: string): void {
		let response: HostResponse;
		try {
			response = parseHostResponse(line);
		} catch (error) {
			logger.warn(`${unitLabel(this.#key)} sent a malformed response`, {
				key: this.#key,
				error: errorMessage(error),
			});
			return;
		}
		const entry = this.#pending.get(response.id);
		if (!entry) return;
		this.#pending.delete(response.id);
		if (response.ok) entry.resolve(response.result);
		else if (response.gone) {
			// The unit is closing: this tunnel is useless, and the next open must start a fresh unit.
			entry.reject(new HostGoneError(response.error));
			this.close();
		} else entry.reject(new ToolError(response.error));
	}
}

/** How {@link DisasmDatabase.connect} tracks a tunnel. */
interface ConnectOptions {
	/** Appended to the message when the unit goes: where its logs are. */
	logsHint: string;
	/** The tunnel ended; `db` is undefined when it dropped before the first status arrived. */
	onClose(db: DisasmDatabase | undefined): void;
}

/**
 * An open disassembler database as seen from this omp process: a tunnel to its unit plus the
 * last reported {@link HostStatus}. Shared by every agent in the process.
 */
export class DisasmDatabase {
	/** Unit key `<backend>:<id>`. */
	readonly name: string;
	readonly #conn: HostConnection;
	#status: HostStatus;

	constructor(name: string, conn: HostConnection, status: HostStatus) {
		this.name = name;
		this.#conn = conn;
		this.#status = status;
	}

	/**
	 * Attach a tunnel to the daemon unit `key` and fetch its status (`open` waits for the database to
	 * open). Undefined when no such unit runs; throws the unit's open failure.
	 */
	static async attach(
		key: string,
		op: "open" | "status",
		onClose: ConnectOptions["onClose"] = () => {},
	): Promise<DisasmDatabase | undefined> {
		const daemon = await daemonClient();
		let tunnel: DaemonTunnel;
		try {
			tunnel = await daemon.attach(unitRef(key));
		} catch (error) {
			logger.debug(`${unitLabel(key)} attach failed`, { key, error: errorMessage(error) });
			return undefined;
		}
		return DisasmDatabase.connect(key, tunnel, op, { onClose, logsHint: `; see \`omp ps logs ${tunnel.unit.id}\`` });
	}

	/** Fetch the status of the unit at the other end of `tunnel`; on failure the tunnel is closed and the error thrown. */
	static async connect(
		key: string,
		tunnel: UnitLink,
		op: "open" | "status",
		options: ConnectOptions,
	): Promise<DisasmDatabase> {
		let db: DisasmDatabase | undefined;
		const conn = new HostConnection(key, tunnel, () => options.onClose(db), options.logsHint);
		try {
			const status = parseHostStatus(await conn.call({ id: conn.nextId(), op }));
			db = new DisasmDatabase(key, conn, status);
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

	/** Last status fetched from the unit. */
	get status(): HostStatus {
		return this.#status;
	}

	/** Whether the tunnel is still up. */
	get connected(): boolean {
		return this.#conn.open;
	}

	/** Refetch the unit's status; `open` first waits for the database to finish opening. */
	async refresh(op: "open" | "status" = "status"): Promise<HostStatus> {
		this.#status = parseHostStatus(await this.#conn.call({ id: this.#conn.nextId(), op }));
		return this.#status;
	}

	/**
	 * Run one worker request, queued behind requests from every omp process.
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

	/** Acquire a tunnel-owned reference; an expected handle rejects stale or foreign incarnations. */
	async retain(expected = this.handle): Promise<RetainedReference> {
		const retained = parseRetainedReference(
			await this.#conn.call({ id: this.#conn.nextId(), op: "retain", handle: expected }),
		);
		this.#status.references = retained.references;
		return retained;
	}

	/** Release one owned reference; the last release closes, honoring any owner's request to save. */
	async release(lease: string, options: { save: boolean }): Promise<void> {
		await this.#conn.call({ id: this.#conn.nextId(), op: "release", lease, save: options.save });
	}

	/** Close an unreferenced database; active owned references reject this operation. */
	async close(options: { save: boolean }): Promise<void> {
		await this.#conn.call({ id: this.#conn.nextId(), op: "close", save: options.save });
	}

	/** Drop this process's tunnel and its owned references; other owners keep the database open. */
	disconnect(): void {
		this.#conn.close();
	}
}

/** Attached units by source key ({@link HostSource.id}). */
const handles = new Map<string, DisasmDatabase>();
/** In-flight opens by source key, shared by concurrent callers in this process. */
const pending = new Map<string, Promise<DisasmDatabase>>();
let cleanupRegistered = false;

function registerCleanup(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	// The deadline outlasts stopLocalUnit's wait, so the kill fallback runs before exit gives up.
	postmortem.register("disasm-release", releaseDatabases, {
		deadlineMs: LOCAL_CLOSE_WAIT_MS + CLEANUP_GRACE_MS,
		waitMessage: "Saving disassembler databases",
	});
}

/** Where databases live: the daemon's units, or this process's in-process ones for a contained workspace. */
interface HostSource {
	/** Registry key of unit `key` in {@link handles} and {@link pending}. */
	id(key: string): string;
	/** Keys of the units of `backend` that are not ending. */
	liveKeys(backend: DisasmBackendId): Promise<string[]>;
	/** A fresh tunnel to unit `key` fetching `op`; undefined when none runs. Throws the unit's open failure. */
	connect(key: string, op: "open" | "status", onClose: ConnectOptions["onClose"]): Promise<DisasmDatabase | undefined>;
	/** Find-or-start unit `key` for `params`. */
	start(key: string, params: DisasmUnitParams, label: string): Promise<void>;
	/** Appended to "<label> <key> exited right after starting". */
	startHint: string;
	/** Tail of the "still analyzing" message: where the analysis continues and how to stop it. */
	analyzing(key: string): Promise<string>;
}

/** The daemon's units, shared by every omp process. */
const daemonSource: HostSource = {
	id: key => key,
	liveKeys: async backend => {
		const daemon = await daemonClient();
		const { units } = await daemon.request({ op: "list", kind: DISASM_UNIT_KIND, scope: GLOBAL_SCOPE });
		return units
			.filter(unit => unit.state !== "exited" && unit.state !== "failed" && unit.key.startsWith(`${backend}:`))
			.map(unit => unit.key);
	},
	connect: (key, op, onClose) => DisasmDatabase.attach(key, op, onClose),
	start: async (key, params, label) => {
		// Retain references (tunnel-owned) pin the unit; a daemon lease would keep it from ever idling.
		// The daemon may hand back a unit that started closing meanwhile; its tunnel answers `gone`.
		const daemon = await daemonClient();
		await daemon.open({ ...unitRef(key), label, params, lease: false });
	},
	startHint: "; see `omp ps`",
	analyzing: async key => {
		const unit = await openingUnit(key);
		const age = unit ? ` for ${Math.round((Date.now() - unit.startedAt) / 60_000)}m` : "";
		const where = unit ? ` in unit \`${unit.id}\`` : "";
		const stop = unit ? `, or stop it with \`omp ps stop ${unit.id}\`` : "";
		return `(opening${age}); the analysis continues${where}. Retry later${stop}`;
	},
};

/** An in-process unit and its use bookkeeping. */
interface LocalUnit {
	unit: DisasmUnit;
	/**
	 * `performance.now()` of the unit's last activity (a request starting or ending, a retain or
	 * release) or start: monotonic, and fine enough to order uses within one millisecond.
	 */
	lastUsed: number;
	/** Settles once the unit exited and its worker's endpoint directory was removed. */
	ended: Promise<void>;
}

/** In-process units by unit key, per workspace, while its OS sandbox is active. */
const localScopes = new Map<string, Map<string, LocalUnit>>();
/** The client every in-process tunnel reports to its unit. */
const LOCAL_CLIENT = { connectionId: "local", pid: process.pid, build: "" };
const LOCAL_PREFIX = "local:";

function localSource(session: ToolSession, sandbox: SandboxRuntime): HostSource {
	const workspace = session.cwd;
	let scope = localScopes.get(workspace);
	if (!scope) {
		scope = new Map();
		localScopes.set(workspace, scope);
	}
	const units = scope;
	const id = (key: string) => `${LOCAL_PREFIX}${workspace}\0${key}`;
	return {
		id,
		liveKeys: async backend =>
			[...units].filter(([key, local]) => !local.unit.ending && key.startsWith(`${backend}:`)).map(([key]) => key),
		connect: async (key, op, onClose) => {
			const local = units.get(key);
			if (!local || local.unit.ending) return undefined;
			// The unit's own failure, never a closed tunnel: a failed open ends the unit at once.
			if (op === "open") await local.unit.opened();
			const [near, far] = createUnitLink(LOCAL_CLIENT);
			local.unit.attach(far);
			return DisasmDatabase.connect(key, near, op, { onClose, logsHint: "" });
		},
		start: async (key, params) => {
			const existing = units.get(key);
			if (existing && !existing.unit.ending) return;
			// An ending unit still holds the database's lock; replace it only once it is gone.
			await existing?.ended;
			if (units.has(key)) return;
			await makeLocalRoom(units, key, params.maxOpen);
			if (units.has(key)) return;
			startLocalUnit(session, sandbox, units, key, params);
		},
		startHint: "",
		analyzing: async () => "(opening); the analysis continues in this omp process. Retry later",
	};
}

/** Save and close least recently used idle units until starting `key` stays within `maxOpen`. */
async function makeLocalRoom(units: Map<string, LocalUnit>, key: string, maxOpen: number): Promise<void> {
	for (;;) {
		const others = [...units].filter(([other, local]) => other !== key && !local.unit.ending);
		if (others.length < maxOpen) return;
		const victim = others
			.map(([, local]) => local)
			.filter(local => !local.unit.busy())
			.sort((a, b) => a.lastUsed - b.lastUsed)[0];
		if (!victim) {
			throw new ToolError(
				`${others.length} disassembler databases are open and in use (disassembler.maxOpen = ${maxOpen}); close one or raise disassembler.maxOpen`,
			);
		}
		// `stop` saves unsaved changes first.
		await victim.unit.stop("evicted");
		await victim.ended;
	}
}

/**
 * Start the in-process unit `key` for `params`, its worker spawned inside `sandbox`'s container and
 * listening in a directory of its own ({@link workerEndpointDir}). The unit outlives the call that
 * started it, so it is built outside that call's contained file access: its one omp-side read of the
 * source (the staging copy) runs under a contained file access of its own.
 */
function startLocalUnit(
	session: ToolSession,
	sandbox: SandboxRuntime,
	units: Map<string, LocalUnit>,
	key: string,
	params: DisasmUnitParams,
): void {
	const label = DISASM_BACKENDS[params.backend].label;
	let endpointDir: string | undefined;
	/** Removes the endpoint directory should omp exit before the unit does. */
	let cancelExitRemoval: (() => void) | undefined;
	// The unit reports activity only once its start awaited, after `local` exists.
	const unit = outsideContainedFileAccess(() =>
		openLocalDisasmUnit(
			`${LOCAL_PREFIX}${key}`,
			params,
			{
				files: async () => {
					endpointDir = await workerEndpointDir(sandbox);
					const dir = endpointDir;
					cancelExitRemoval = postmortem.register(
						`disasm-endpoint:${dir}`,
						() => fs.rmSync(dir, { recursive: true, force: true }),
						{ exitOnly: true },
					);
					return {
						endpoint: path.join(endpointDir, process.platform === "win32" ? "worker.port" : "worker.sock"),
					};
				},
				spawn: { spawn: containedWorkerSpawner(sandbox), aliasRoot: sandbox.tempDir() },
				prepare: (backend, loc) => withContainedFileAccess(session, () => prepareStoreDir(backend, loc)),
				lockDenial: async dir =>
					sandboxCallDenial({
						settings: session.settings,
						workspace: session.cwd,
						name: `${label} database`,
						subjects: () => [{ kind: "write", target: dir }],
						requestTool: () => session.isToolActive?.("sandbox_request") === true,
					}),
			},
			() => {
				local.lastUsed = performance.now();
			},
		),
	);
	const local: LocalUnit = {
		unit,
		lastUsed: performance.now(),
		ended: unit.exited.then(async ({ reason }) => {
			clearInterval(timer);
			if (units.get(key) === local) units.delete(key);
			logger.debug(`${label} in-process database ended`, { key, reason });
			if (endpointDir) {
				// The worker's own exit cleanup may be removing its socket right now; a concurrent recursive
				// `rm` can then skip the directory. Moved aside first, the tree is this call's alone.
				const ended = `${endpointDir}.ended`;
				await fs.promises
					.rename(endpointDir, ended)
					.then(() => fs.promises.rm(ended, { recursive: true, force: true }))
					.catch(() => undefined);
			}
			cancelExitRemoval?.();
		}),
	};
	const idleMs = params.idleCloseMs;
	const timer =
		idleMs > 0
			? setInterval(
					() => {
						if (!unit.busy() && performance.now() - local.lastUsed >= idleMs) void unit.stop("idle");
					},
					Math.min(idleMs, LOCAL_IDLE_POLL_MS),
				)
			: undefined;
	timer?.unref();
	units.set(key, local);
	registerCleanup();
}

/** The host source of `session`'s databases: in-process while its workspace's sandbox is active, else the daemon. */
async function sourceFor(session: ToolSession): Promise<HostSource> {
	const sandbox = await containingSandbox(session.cwd, { settings: session.settings });
	return sandbox ? localSource(session, sandbox) : daemonSource;
}

/**
 * Whether `db` is one of the databases `session` reaches now: false for a daemon database once its
 * workspace's sandbox applies, and for an in-process one once it no longer does.
 */
export async function reachesDatabase(session: ToolSession, db: DisasmDatabase): Promise<boolean> {
	return handles.get((await sourceFor(session)).id(db.name)) === db;
}

/** Attach to the unit `key`, reusing this process's live tunnel; undefined when none runs. */
async function attachUnit(source: HostSource, key: string, op: "open" | "status"): Promise<DisasmDatabase | undefined> {
	const id = source.id(key);
	const cached = handles.get(id);
	if (cached?.connected) {
		await cached.refresh(op);
		return cached;
	}
	const db = await source.connect(key, op, closed => {
		if (closed && handles.get(id) === closed) handles.delete(id);
	});
	if (!db) return undefined;
	// A concurrent attach won; keep one tunnel per unit.
	const winner = handles.get(id);
	if (winner?.connected) {
		db.disconnect();
		return winner;
	}
	handles.set(id, db);
	registerCleanup();
	return db;
}

/** Attach to the unit for `loc`, starting it (and waiting for the open) when none runs. */
async function openDatabase(
	session: ToolSession,
	backend: DisasmBackendId,
	loc: DatabaseLocation,
	key: string,
	source: HostSource,
): Promise<DisasmDatabase> {
	// A unit closing right now answers `gone` once it exited, and is replaced below; open failures surface.
	const attachOpen = () =>
		attachUnit(source, key, "open").catch(error => {
			if (error instanceof HostGoneError) return undefined;
			throw error;
		});
	const existing = await attachOpen();
	if (existing) return existing;
	const params: DisasmUnitParams = {
		backend,
		loc,
		runtime: await resolveWorkerRuntime(session, backend),
		idleCloseMs: cfgDisasmIdleCloseSec.get(session.settings) * 1000,
		maxOpen: Math.max(1, cfgDisasmMaxOpen.get(session.settings)),
	};
	for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
		await source.start(key, params, `${DISASM_BACKENDS[backend].label} ${databaseRef(loc)}`);
		const db = await attachOpen();
		if (db) return db;
	}
	throw new ToolError(`${unitLabel(key)} ${key} exited right after starting${source.startHint}`);
}

/** Options for {@link acquireDatabase}. */
export interface AcquireDatabaseOptions extends LocateDatabaseOptions {
	signal?: AbortSignal;
}

/**
 * Return the open database for a binary (or one slice of a universal binary) or `.i64`/`.idb`,
 * starting its unit and opening (or creating) it on first use. Concurrent callers share one open;
 * aborting `signal` or exceeding {@link OPEN_WAIT_MS} stops only this caller's wait, the open itself
 * always runs to completion.
 *
 * While the OS sandbox is active the database opens in an in-process unit whose worker runs
 * contained; call this inside the call's `withContainedFileAccess` so the binary's bytes are read
 * through the sandbox host too.
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
	const key = disasmUnitKey(backend, loc.id);
	const source = await sourceFor(session);
	const id = source.id(key);
	const cached = handles.get(id);
	if (cached?.connected && cached.status.state === "open") return cached;
	let opening = pending.get(id);
	if (!opening) {
		opening = openDatabase(session, backend, loc, key, source).finally(() => pending.delete(id));
		// Every caller may have stopped waiting; remaining ones still receive the failure.
		opening.catch(error =>
			logger.debug(`${DISASM_BACKENDS[backend].label} database open failed`, {
				id: loc.id,
				error: errorMessage(error),
			}),
		);
		pending.set(id, opening);
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
		throw new ToolError(`${label} is still analyzing ${databaseRef(loc)} ${await source.analyzing(key)}`);
	}
}

/** The board row of unit `key`; undefined when it is not running. */
async function openingUnit(key: string): Promise<UnitSnapshot | undefined> {
	try {
		const daemon = await daemonClient();
		const { unit } = await daemon.request({ op: "describe", unit: unitRef(key) });
		return unit.state !== "exited" && unit.state !== "failed" ? unit : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The open database with `locateDatabase` id (or unit key) `ref`, if any. While the session's
 * sandbox is active only this process's contained databases are visible, never a daemon unit.
 * A unit's own failure means "not open"; failing to reach the daemon at all is thrown.
 */
export async function findOpenDatabase(
	session: ToolSession,
	backend: DisasmBackendId,
	ref: string,
): Promise<DisasmDatabase | undefined> {
	const source = await sourceFor(session);
	const key = ref.startsWith(`${backend}:`) ? ref : disasmUnitKey(backend, ref);
	const db = await attachUnit(source, key, "status").catch(error => {
		if (error instanceof ToolError) return undefined;
		throw error;
	});
	return db?.status.state === "open" ? db : undefined;
}

/** Resolve a portable reference, rejecting a stopped or replaced database. */
export async function findDatabaseHandle(session: ToolSession, handle: DatabaseHandle): Promise<DisasmDatabase> {
	const db = await findOpenDatabase(session, handle.backend, handle.id);
	if (!db || db.handle !== formatDatabaseHandle(handle)) {
		throw new ToolError(
			"dsm handle has expired; the original database is no longer open. Ask its owner for a live handle.",
		);
	}
	return db;
}

/**
 * Every database hosted for `backend`, including ones other omp processes opened; while the
 * session's sandbox is active, only this process's contained databases.
 */
export async function listDatabases(session: ToolSession, backend: DisasmBackendId): Promise<DisasmDatabase[]> {
	const source = await sourceFor(session);
	const keys = await source.liveKeys(backend);
	const dbs = await Promise.all(keys.map(key => attachUnit(source, key, "status").catch(() => undefined)));
	return dbs.filter(db => db !== undefined);
}

/** Save and close an in-process unit, killing its worker when that takes longer than {@link LOCAL_CLOSE_WAIT_MS}. */
async function stopLocalUnit(key: string, { unit, ended }: LocalUnit): Promise<void> {
	const expired = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => expired.resolve(true), LOCAL_CLOSE_WAIT_MS);
	try {
		const timedOut = await Promise.race([unit.stop("released").then(() => false), expired.promise]);
		if (timedOut) {
			logger.warn(`${unitLabel(key)} close on release timed out; killing the worker`, { key });
			await unit.kill();
		}
		await ended;
	} catch (error) {
		logger.warn(`${unitLabel(key)} close on release failed`, { key, error: errorMessage(error) });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Save every attached database with unsaved changes and drop this process's tunnels; daemon units
 * keep running for other omp processes until the daemon's idle policy closes them. In-process
 * (contained) units end with this call: each saves if needed and its worker exits. Failures are logged.
 */
export async function releaseDatabases(): Promise<void> {
	const dbs = [...handles];
	handles.clear();
	const locals = [...localScopes.values()].flatMap(units => [...units]);
	await Promise.all([
		...dbs.map(async ([id, db]) => {
			// An in-process unit saves on its own stop below.
			if (id.startsWith(LOCAL_PREFIX)) {
				db.disconnect();
				return;
			}
			const wait = Promise.withResolvers<void>();
			const timer = setTimeout(wait.resolve, FLUSH_WAIT_MS);
			try {
				await Promise.race([db.flush(), wait.promise]);
			} catch (error) {
				logger.warn(`${unitLabel(db.name)} flush on release failed`, { key: db.name, error: errorMessage(error) });
			} finally {
				clearTimeout(timer);
				db.disconnect();
			}
		}),
		...locals.map(([key, local]) => stopLocalUnit(key, local)),
	]);
}
