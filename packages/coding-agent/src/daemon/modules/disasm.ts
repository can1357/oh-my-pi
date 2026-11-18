/**
 * `disasm` daemon module: one unit per open disassembler database, shared by every omp process.
 *
 * A unit (global scope, key `<backend>:<db id>`) holds the database file lock, one detached
 * Python worker (`disasm/supervisor.ts`), the tunnel-owned retain references, and the dirty/save
 * state. Clients attach a tunnel and speak NDJSON {@link HostRequest}s (`disasm/protocol.ts`);
 * worker calls from every client are serialized in the worker's queue. The last released
 * reference closes the database (saving when any owner asked to); the core's idle policy and
 * `maxOpen` cap close unreferenced ones. Workers survive daemon re-execs and crashes and are
 * re-adopted in {@link disasmModule.restore}.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { acquireFileLock, type FileLockHandle, logger, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { DISASM_BACKENDS, type DisasmBackend } from "../../disasm/backend";
import {
	DISASM_UNIT_KIND,
	type DisasmUnitParams,
	type DisasmUnitState,
	errorMessage,
	formatDatabaseHandle,
	type HostRequest,
	type HostStatus,
	lineReader,
	parseDisasmUnitParams,
	parseDisasmUnitState,
	parseHostRequest,
} from "../../disasm/protocol";
import { databaseRef, prepareStoreDir } from "../../disasm/store";
import { DisasmWorker, type WorkerFiles } from "../../disasm/supervisor";
import type { DaemonModule, ModuleContext, ModuleTunnel, ModuleUnit } from "../module";
import { unitLogDir } from "../paths";
import type { UnitPolicy } from "../protocol";

/** How long a unit whose open failed keeps answering with the failure before it exits. */
const OPEN_FAILED_LINGER_MS = 10_000;
/** Budget for a `flush` save. */
const FLUSH_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_CLOSE_MS = 900_000;
const DEFAULT_MAX_OPEN = 4;

/**
 * Set once the daemon is stopping or re-exec'ing: its snapshots are taken, so dropped tunnels
 * must no longer release references and close databases the next daemon re-adopts.
 */
let disposing = false;

/** The unit is closing or closed; answered with `gone` so the client opens a fresh unit. */
class UnitGoneError extends ToolError {}

function numberParam(params: unknown, key: string): number | undefined {
	if (typeof params !== "object" || params === null || !(key in params)) return undefined;
	const value = (params as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Socket (Unix) or port file (Windows) and log of the worker behind `unitId`. */
async function workerFiles(context: ModuleContext, unitId: string): Promise<WorkerFiles> {
	await fs.mkdir(context.stateDir, { recursive: true });
	const stem = `worker-${Bun.hash.wyhash(unitId).toString(16)}`;
	return {
		endpoint:
			process.platform === "win32"
				? path.join(context.stateDir, `${stem}.port`)
				: ipcEndpoint(context.stateDir, stem),
		logPath: path.join(unitLogDir(unitId), "worker.log"),
	};
}

/** One tunnel's in-flight calls and owned references. */
interface TunnelSession {
	tunnel: ModuleTunnel;
	calls: Map<number, AbortController>;
	leases: Set<string>;
	open: boolean;
}

/** One open database: lock, worker, references. */
class DisasmUnit implements ModuleUnit {
	readonly label: string;
	/** Tunnels are accepted at once; requests wait for the open themselves. */
	readonly ready = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	readonly #exit = Promise.withResolvers<{ exitCode?: number; reason?: string }>();
	readonly #context: ModuleContext;
	readonly #unitId: string;
	readonly #params: DisasmUnitParams;
	readonly #backend: DisasmBackend;
	readonly #instance: string;
	readonly #handle: string;
	readonly #startedAt: number;
	readonly #references = new Set<string>();
	readonly #tunnels = new Set<TunnelSession>();
	/** Request handlers still running; stop lets them answer before closing tunnels. */
	readonly #inflight = new Set<Promise<void>>();
	/** Settles once the worker is up and the database is open; rejects with the open failure. */
	readonly #opening: Promise<DisasmWorker>;
	#worker: DisasmWorker | undefined;
	#saveOnRelease = false;
	#closing: Promise<void> | undefined;
	#stopping: Promise<void> | undefined;

	constructor(
		context: ModuleContext,
		unitId: string,
		params: DisasmUnitParams,
		instance: string,
		startedAt: number,
		start: (unit: DisasmUnit) => Promise<DisasmWorker>,
	) {
		this.#context = context;
		this.#unitId = unitId;
		this.#params = params;
		this.#backend = DISASM_BACKENDS[params.backend];
		this.#instance = instance;
		this.#startedAt = startedAt;
		this.#handle = formatDatabaseHandle({ backend: params.backend, id: params.loc.id, instance });
		this.label = `${this.#backend.label} ${databaseRef(params.loc)}`;
		this.exited = this.#exit.promise;
		this.#opening = start(this);
		this.#opening.then(
			worker => {
				this.#context.changed(this.#unitId);
				void worker.exited.then(code => this.#finish(code ?? undefined, "worker exited"));
			},
			async (error: unknown) => {
				const reason = errorMessage(error);
				logger.warn(`${this.#backend.label} open failed`, { id: params.loc.id, error: reason });
				this.#context.changed(this.#unitId);
				await Bun.sleep(OPEN_FAILED_LINGER_MS);
				await this.#finish(1, reason);
			},
		);
	}

	/** Called by the start function once the worker process exists, before its database opens. */
	adoptWorker(worker: DisasmWorker): void {
		this.#worker = worker;
		worker.onActivity(() => this.#context.changed(this.#unitId));
		this.#context.changed(this.#unitId);
	}

	pids(): number[] {
		return this.#worker?.running ? [this.#worker.pid] : [];
	}

	/** `stop` was called; a start still in progress must not spawn or keep a worker. */
	get stopRequested(): boolean {
		return this.#stopping !== undefined;
	}

	/** Opening, running requests, or retained: never idle-closed or evicted. */
	busy(): boolean {
		if (this.#stopping || this.#closing) return false;
		const worker = this.#worker;
		return !worker?.opened || worker.busy || this.#references.size > 0;
	}

	attach(tunnel: ModuleTunnel): void {
		const session: TunnelSession = { tunnel, calls: new Map(), leases: new Set(), open: true };
		this.#tunnels.add(session);
		tunnel.start(
			lineReader(line => this.#onLine(session, line)),
			() => this.#onTunnelClosed(session),
		);
	}

	async flush(): Promise<void> {
		const worker = this.#worker;
		if (!worker?.opened || !worker.needsSave || this.#closing || this.#stopping) return;
		await worker.request("save", {}, { timeoutMs: FLUSH_TIMEOUT_MS });
	}

	/** Close the worker (saving unsaved changes; killing it mid-open), let pending requests answer, then close tunnels. */
	stop(reason: string): Promise<void> {
		this.#stopping ??= this.#stop(reason);
		return this.#stopping;
	}

	async #stop(reason: string): Promise<void> {
		const worker = this.#worker;
		if (worker) {
			try {
				if (worker.opened) await worker.close({ save: worker.needsSave });
				else await worker.kill();
			} catch (error) {
				logger.warn(`${this.#backend.label} close failed`, { id: this.#params.loc.id, error: errorMessage(error) });
			}
		}
		await this.#opening.catch(() => undefined);
		await this.#finish(undefined, reason);
	}

	snapshot(): DisasmUnitState | undefined {
		const worker = this.#worker;
		if (!worker) return undefined;
		return { params: this.#params, instance: this.#instance, startedAt: this.#startedAt, worker: worker.state() };
	}

	/**
	 * Let running handlers answer first: the `release`/`close` that closed the worker resolves once the
	 * worker exited, after `worker.exited` already fired, and must not see its own tunnel close as `gone`.
	 */
	async #finish(exitCode: number | undefined, reason: string): Promise<void> {
		await Promise.all(this.#inflight);
		for (const session of this.#tunnels) session.tunnel.close();
		this.#tunnels.clear();
		this.#exit.resolve({ exitCode, reason });
	}

	#status(): HostStatus {
		const { loc } = this.#params;
		const worker = this.#worker;
		if (!worker?.opened) {
			return {
				id: loc.id,
				ref: databaseRef(loc),
				handle: this.#handle,
				references: this.#references.size,
				fat: loc.fat,
				idbPath: loc.openPath,
				info: { module: "", format: "", arch: "", bitness: 0 },
				state: "opening",
				busy: true,
				lastUsed: this.#startedAt,
				current: null,
				dirty: false,
			};
		}
		return {
			id: loc.id,
			ref: worker.ref,
			handle: this.#handle,
			references: this.#references.size,
			fat: loc.fat,
			idbPath: worker.idbPath,
			info: worker.info,
			state: "open",
			busy: worker.busy,
			lastUsed: worker.lastUsed,
			current: worker.current,
			dirty: worker.needsSave,
		};
	}

	#onLine(session: TunnelSession, line: string): void {
		let request: HostRequest;
		try {
			request = parseHostRequest(line);
		} catch (error) {
			logger.warn(`${this.#backend.label} unit received a malformed request`, { error: errorMessage(error) });
			return;
		}
		if (request.op === "cancel") {
			session.calls.get(request.target)?.abort();
			return;
		}
		const handled = this.#dispatch(request, session).then(
			result => {
				if (session.open) session.tunnel.send(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
			},
			error => {
				if (session.open) {
					const gone = error instanceof UnitGoneError || undefined;
					session.tunnel.send(
						`${JSON.stringify({ id: request.id, ok: false, error: errorMessage(error), gone })}\n`,
					);
				}
			},
		);
		this.#inflight.add(handled);
		void handled.finally(() => this.#inflight.delete(handled));
	}

	#onTunnelClosed(session: TunnelSession): void {
		session.open = false;
		this.#tunnels.delete(session);
		// The daemon is going away with this unit snapshotted: leave the worker as it is.
		if (disposing) return;
		for (const controller of session.calls.values()) controller.abort();
		if (session.leases.size === 0) return;
		for (const lease of session.leases) this.#references.delete(lease);
		session.leases.clear();
		this.#saveOnRelease = true;
		this.#context.changed(this.#unitId);
		void this.#closeUnreferenced()?.catch(error => {
			logger.warn("Disassembler orphaned-reference close failed", {
				id: this.#params.loc.id,
				error: errorMessage(error),
			});
		});
	}

	async #dispatch(request: Exclude<HostRequest, { op: "cancel" }>, session: TunnelSession): Promise<unknown> {
		switch (request.op) {
			case "status":
				if (this.#stopping || this.#closing) throw this.#goneError();
				return this.#status();
			case "open": {
				const worker = await this.#opening;
				if (this.#stopping || this.#closing) {
					// Answer once the worker (and its lock) is gone, so the client's next open starts a fresh
					// unit instead of adopting this one. Not `this.exited`: `stop` waits for this handler.
					await worker.exited;
					throw this.#goneError();
				}
				return this.#status();
			}
			case "retain": {
				await this.#liveWorker();
				if (!session.open) throw new ToolError("Disassembler connection closed before retain completed");
				if (request.handle !== this.#handle)
					throw new ToolError("dsm handle has expired; the original database is no longer open");
				const lease = crypto.randomUUID();
				session.leases.add(lease);
				this.#references.add(lease);
				this.#context.changed(this.#unitId);
				return { lease, handle: this.#handle, references: this.#references.size };
			}
			case "release": {
				await this.#liveWorker();
				if (!session.leases.delete(request.lease))
					throw new ToolError("Database reference is not owned by this connection or was already released");
				this.#references.delete(request.lease);
				this.#saveOnRelease ||= request.save;
				this.#context.changed(this.#unitId);
				await this.#closeUnreferenced();
				return { references: this.#references.size };
			}
			case "call": {
				const worker = await this.#liveWorker();
				const controller = new AbortController();
				session.calls.set(request.id, controller);
				try {
					return await worker.request(request.method, request.params, {
						signal: controller.signal,
						timeoutMs: request.timeoutMs,
					});
				} finally {
					session.calls.delete(request.id);
				}
			}
			case "flush": {
				const worker = await this.#liveWorker();
				if (!worker.needsSave) return { saved: false };
				await worker.request("save", {}, { timeoutMs: FLUSH_TIMEOUT_MS });
				return { saved: true };
			}
			case "close": {
				await this.#liveWorker();
				if (this.#references.size > 0) {
					throw new ToolError(
						`Database has ${this.#references.size} active dsm references; each owner must close its own handle`,
					);
				}
				this.#saveOnRelease ||= request.save;
				await this.#closeUnreferenced();
				return { closed: true };
			}
		}
	}

	/** The zero-reference transition starts closing synchronously, before another retain can enter. */
	#closeUnreferenced(): Promise<void> | undefined {
		const worker = this.#worker;
		if (this.#references.size > 0 || !worker?.opened || this.#stopping || disposing) return undefined;
		this.#closing ??= worker.close({ save: this.#saveOnRelease });
		return this.#closing;
	}

	async #liveWorker(): Promise<DisasmWorker> {
		const worker = await this.#opening;
		if (this.#stopping || this.#closing) throw this.#goneError();
		return worker;
	}

	#goneError(): UnitGoneError {
		return new UnitGoneError(`${this.#backend.label} database ${this.#params.loc.id} is closing`);
	}
}

/** Lock, prepare, spawn, and open a new database. */
async function startWorker(
	context: ModuleContext,
	unitId: string,
	params: DisasmUnitParams,
	unit: DisasmUnit,
): Promise<DisasmWorker> {
	const { backend, loc, runtime } = params;
	const label = DISASM_BACKENDS[backend].label;
	if (loc.kind === "store") await fs.mkdir(loc.dir, { recursive: true });
	const lock: FileLockHandle = await acquireFileLock(loc.lockTarget, { retries: 1 }).catch(() => {
		throw new ToolError(`${label} database ${loc.id} is in use by another process`);
	});
	const stopped = () => new ToolError(`${label} database ${loc.id} was stopped while opening`);
	let worker: DisasmWorker;
	try {
		if (unit.stopRequested) throw stopped();
		await prepareStoreDir(DISASM_BACKENDS[backend], loc);
		if (unit.stopRequested) throw stopped();
		worker = await DisasmWorker.spawn(
			DISASM_BACKENDS[backend],
			loc,
			runtime,
			lock,
			await workerFiles(context, unitId),
		);
	} catch (error) {
		lock.release();
		throw error;
	}
	// From here on the worker releases the lock when it exits.
	if (unit.stopRequested) {
		await worker.kill();
		throw stopped();
	}
	unit.adoptWorker(worker);
	await worker.open(loc);
	return worker;
}

export const disasmModule: DaemonModule = {
	kind: DISASM_UNIT_KIND,
	version: 1,

	policy(params: unknown): UnitPolicy {
		const idleMs = Math.max(0, numberParam(params, "idleCloseMs") ?? DEFAULT_IDLE_CLOSE_MS);
		return {
			// 0 keeps databases open until stopped or evicted.
			hold: idleMs > 0 ? "leases" : "persist",
			idleMs,
			onIdle: "flush-stop",
			cap: Math.max(1, numberParam(params, "maxOpen") ?? DEFAULT_MAX_OPEN),
			restart: "no",
			survive: "detached",
		};
	},

	init() {
		disposing = false;
	},

	dispose() {
		disposing = true;
		return Promise.resolve();
	},

	open(context, request) {
		const params = parseDisasmUnitParams(request.params);
		return new DisasmUnit(context, request.unitId, params, crypto.randomUUID(), Date.now(), unit =>
			startWorker(context, request.unitId, params, unit),
		);
	},

	async restore(context, request, state) {
		const snapshot = parseDisasmUnitState(state);
		const { backend, loc } = snapshot.params;
		// The previous daemon image's lock handle died with it.
		const lock = tryAcquireFileLock(loc.lockTarget);
		if (!lock) {
			// Another process opened the database while it had no daemon: the orphan must not save over it.
			logger.warn(`${DISASM_BACKENDS[backend].label} database lock taken across a daemon restart`, { id: loc.id });
			await DisasmWorker.discard(snapshot.worker, { kill: true });
			return undefined;
		}
		const worker = DisasmWorker.adopt(DISASM_BACKENDS[backend], loc, snapshot.worker, lock);
		if (!worker) {
			// The worker exited meanwhile (or its pid was reused): clean up what it left behind.
			lock.release();
			await DisasmWorker.discard(snapshot.worker, { kill: false });
			return undefined;
		}
		return new DisasmUnit(
			context,
			request.unitId,
			snapshot.params,
			snapshot.instance,
			snapshot.startedAt,
			async unit => {
				unit.adoptWorker(worker);
				await worker.resume();
				return worker;
			},
		);
	},
};
