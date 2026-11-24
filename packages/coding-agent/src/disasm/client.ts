/**
 * omp-side access to disassembler databases hosted by the omp daemon's `disasm` module.
 *
 * Every open database is one global-scope `disasm` unit keyed `<backend>:<id>`, so `omp ps`
 * lists, stops, and tails it, and every omp process shares it. This module opens units on demand
 * (the daemon closes the least recently used idle one beyond `disassembler.maxOpen`), attaches a
 * tunnel to each, and forwards NDJSON requests over it.
 */
import { logger, postmortem, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "../tools/tool-errors";
import { daemonClient } from "../daemon/client";
import { type DaemonTunnel, GLOBAL_SCOPE, type UnitSnapshot } from "../daemon/protocol";
import type { ToolSession } from "../tools";
import { DISASM_BACKEND_IDS, DISASM_BACKENDS, type DisasmBackendId } from "./backend";
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
} from "./store";
import type { DatabaseInfo, WorkerRequestOptions } from "./supervisor";

/** How long release waits for a unit's save; the unit finishes it regardless. */
const FLUSH_WAIT_MS = 8_000;
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
	readonly #unitId: string;
	readonly #tunnel: DaemonTunnel;
	readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
	#nextId = 1;
	#open = true;

	constructor(key: string, tunnel: DaemonTunnel, onClose: () => void) {
		this.#key = key;
		this.#unitId = tunnel.unit.id;
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
		return new HostGoneError(`${unitLabel(this.#key)} ${this.#key} closed; see \`omp ps logs ${this.#unitId}\``);
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

/**
 * An open disassembler database as seen from this omp process: a tunnel to its daemon unit plus the
 * last reported {@link HostStatus}. Shared by every agent in the process.
 */
export class DisasmDatabase {
	/** Unit key `<backend>:<id>`. */
	readonly name: string;
	/** Daemon unit id (`omp ps` row, `omp ps logs <id>`). */
	readonly unitId: string;
	readonly #conn: HostConnection;
	#status: HostStatus;

	constructor(name: string, unitId: string, conn: HostConnection, status: HostStatus) {
		this.name = name;
		this.unitId = unitId;
		this.#conn = conn;
		this.#status = status;
	}

	/**
	 * Attach a tunnel to the unit `key` and fetch its status (`open` waits for the database to open).
	 * Undefined when no such unit runs; throws the unit's open failure.
	 */
	static async attach(key: string, op: "open" | "status"): Promise<DisasmDatabase | undefined> {
		const daemon = await daemonClient();
		let tunnel: DaemonTunnel;
		try {
			tunnel = await daemon.attach(unitRef(key));
		} catch (error) {
			logger.debug(`${unitLabel(key)} attach failed`, { key, error: errorMessage(error) });
			return undefined;
		}
		let db: DisasmDatabase | undefined;
		const conn = new HostConnection(key, tunnel, () => {
			if (db && handles.get(key) === db) handles.delete(key);
		});
		try {
			const status = parseHostStatus(await conn.call({ id: conn.nextId(), op }));
			db = new DisasmDatabase(key, tunnel.unit.id, conn, status);
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

/** Attached units by key. */
const handles = new Map<string, DisasmDatabase>();
/** In-flight opens by key, shared by concurrent callers in this process. */
const pending = new Map<string, Promise<DisasmDatabase>>();
let cleanupRegistered = false;

/** Attach to the unit `key`, reusing this process's live tunnel; undefined when none runs. */
async function attachUnit(key: string, op: "open" | "status"): Promise<DisasmDatabase | undefined> {
	const cached = handles.get(key);
	if (cached?.connected) {
		await cached.refresh(op);
		return cached;
	}
	const db = await DisasmDatabase.attach(key, op);
	if (!db) return undefined;
	// A concurrent attach won; keep one tunnel per unit.
	const winner = handles.get(key);
	if (winner?.connected) {
		db.disconnect();
		return winner;
	}
	handles.set(key, db);
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		postmortem.register("disasm-release", releaseDatabases);
	}
	return db;
}

/** Attach to the unit for `loc`, asking the daemon to start it (and waiting for the open) when none runs. */
async function openDatabase(
	session: ToolSession,
	backend: DisasmBackendId,
	loc: DatabaseLocation,
	key: string,
): Promise<DisasmDatabase> {
	// A unit closing right now answers `gone` once it exited, and is replaced below; open failures surface.
	const attachOpen = () =>
		attachUnit(key, "open").catch(error => {
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
	const daemon = await daemonClient();
	for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
		// Retain references (tunnel-owned) pin the unit; a daemon lease would keep it from ever idling.
		// The daemon may hand back a unit that started closing meanwhile; its tunnel answers `gone`.
		await daemon.open({
			...unitRef(key),
			label: `${DISASM_BACKENDS[backend].label} ${databaseRef(loc)}`,
			params,
			lease: false,
		});
		const db = await attachOpen();
		if (db) return db;
	}
	throw new ToolError(`${unitLabel(key)} ${key} exited right after starting; see \`omp ps\``);
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
	const cached = handles.get(key);
	if (cached?.connected && cached.status.state === "open") return cached;
	let opening = pending.get(key);
	if (!opening) {
		opening = openDatabase(session, backend, loc, key).finally(() => pending.delete(key));
		// Every caller may have stopped waiting; remaining ones still receive the failure.
		opening.catch(error =>
			logger.debug(`${DISASM_BACKENDS[backend].label} database open failed`, {
				id: loc.id,
				error: errorMessage(error),
			}),
		);
		pending.set(key, opening);
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
		const unit = await openingUnit(key);
		const age = unit ? ` for ${Math.round((Date.now() - unit.startedAt) / 60_000)}m` : "";
		const where = unit ? ` in unit \`${unit.id}\`` : "";
		const stop = unit ? `, or stop it with \`omp ps stop ${unit.id}\`` : "";
		throw new ToolError(
			`${label} is still analyzing ${databaseRef(loc)} (opening${age}); the analysis continues${where}. Retry later${stop}`,
		);
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

/** The open database with `locateDatabase` id (or unit key) `ref`, if any. */
export async function findOpenDatabase(backend: DisasmBackendId, ref: string): Promise<DisasmDatabase | undefined> {
	const key = ref.startsWith(`${backend}:`) ? ref : disasmUnitKey(backend, ref);
	const db = await attachUnit(key, "status").catch(() => undefined);
	return db?.status.state === "open" ? db : undefined;
}

/** Resolve a portable reference, rejecting a stopped or replaced database. */
export async function findDatabaseHandle(handle: DatabaseHandle): Promise<DisasmDatabase> {
	const db = await findOpenDatabase(handle.backend, handle.id);
	if (!db || db.handle !== formatDatabaseHandle(handle)) {
		throw new ToolError(
			"dsm handle has expired; the original database is no longer open. Ask its owner for a live handle.",
		);
	}
	return db;
}

/** Every database the daemon hosts for `backend`, including ones other omp processes opened. */
export async function listDatabases(backend: DisasmBackendId): Promise<DisasmDatabase[]> {
	const daemon = await daemonClient();
	const { units } = await daemon.request({ op: "list", kind: DISASM_UNIT_KIND, scope: GLOBAL_SCOPE });
	const keys = units
		.filter(unit => unit.state !== "exited" && unit.state !== "failed" && unit.key.startsWith(`${backend}:`))
		.map(unit => unit.key);
	const dbs = await Promise.all(keys.map(key => attachUnit(key, "status").catch(() => undefined)));
	return dbs.filter(db => db !== undefined);
}

/**
 * Save every attached database with unsaved changes and drop this process's tunnels; the units
 * keep running for other omp processes until the daemon's idle policy closes them. Failures are logged.
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
				logger.warn(`${unitLabel(db.name)} flush on release failed`, { key: db.name, error: errorMessage(error) });
			} finally {
				clearTimeout(timer);
				db.disconnect();
			}
		}),
	);
}
