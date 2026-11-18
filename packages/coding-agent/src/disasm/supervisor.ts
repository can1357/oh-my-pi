/**
 * Supervisor for one disassembler Python worker, run inside the daemon's `disasm` module
 * (`daemon/modules/disasm.ts`).
 *
 * Each backend keeps one analysis database per Python process, so each database gets its own
 * worker. The worker runs detached in its own session with output to the unit log, listens on
 * a Unix socket (Windows: a loopback TCP port written to a file), and speaks NDJSON over it, so
 * it outlives a daemon crash and is re-adopted by pid and start time ({@link DisasmWorker.adopt}).
 * Requests are serialized; dirty databases autosave when idle.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection, Process, reapChild } from "@oh-my-pi/pi-natives";
import { type FileLockHandle, logger, TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { hostHasInheritableConsole, shouldHideKernelWindow } from "../eval/py/spawn-options";
import { stageRunnerScript } from "../eval/runner-cache";
import type { DisasmBackend, WorkerRuntime } from "./backend";
import { errorMessage, type WorkerState } from "./protocol";
import { type DatabaseLocation, databaseRef, type FatSelection } from "./store";

/** How long a worker gets to answer after an interrupt before it is killed. */
const INTERRUPT_GRACE_MS = 5_000;
/** Budget for the worker's `close` (including the final save). */
const CLOSE_TIMEOUT_MS = 120_000;
/** How long a dirty database must sit idle before it is saved automatically. */
const AUTOSAVE_IDLE_MS = 10_000;
/** How long to wait for the worker to exit after answering `close`. */
const EXIT_GRACE_MS = 10_000;
/** How long the exit handler waits for the socket to drain before failing pending requests. */
const STREAM_DRAIN_MS = 1_000;
/** How long a starting or re-adopted worker may take to accept the protocol connection. */
const CONNECT_TIMEOUT_MS = 30_000;
const CONNECT_RETRY_MS = 100;
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_TAIL_LINES = 20;
/** Environment key carrying the token the worker requires as the first line of every connection. */
const WORKER_TOKEN_ENV = "OMP_DISASM_WORKER_TOKEN";

/** RPC methods shared by disassembler workers. */
export type WorkerMethod =
	| "open"
	| "status"
	| "view"
	| "exec"
	| "rename"
	| "comment"
	| "set_type"
	| "make_function"
	| "save"
	| "close";

/** Loader facts the worker reports when a database opens. */
export interface DatabaseInfo {
	module: string;
	format: string;
	arch: string;
	bitness: number;
}

/** Per-request cancellation and deadline; either one interrupts a running request. */
export interface WorkerRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Where a worker listens and logs; chosen by the module per unit. */
export interface WorkerFiles {
	/** Unix socket path; on Windows the file the worker writes its TCP port to. */
	endpoint: string;
	logPath: string;
}

interface OpenResult extends DatabaseInfo {
	idb: string;
}

type StatusResult = { open: false } | ({ open: true } & OpenResult);

/** The request a worker is currently executing. */
export interface RunningRequest {
	method: WorkerMethod;
	startedAt: number;
}

type WorkerResponse =
	| { id: number; ok: true; result: unknown; dirty?: boolean }
	| { id: number; ok: false; message: string };

type RequestOutcome = { kind: "response"; value: unknown } | { kind: "interrupted" };

/** A timer that does not keep the event loop alive; `cancel` clears it. */
function delay(ms: number): { promise: Promise<void>; cancel(): void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref();
	return { promise, cancel: () => clearTimeout(timer) };
}

function parseWorkerResponse(frame: unknown, label: string): WorkerResponse | null {
	if (typeof frame !== "object" || frame === null) return null;
	if (!("id" in frame) || typeof frame.id !== "number") return null;
	if (!("ok" in frame) || typeof frame.ok !== "boolean") return null;
	if (frame.ok) {
		const result = "result" in frame ? frame.result : undefined;
		const dirty = "dirty" in frame && typeof frame.dirty === "boolean" ? frame.dirty : undefined;
		return { id: frame.id, ok: true, result, dirty };
	}
	const error = "error" in frame ? frame.error : undefined;
	const message =
		typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
			? error.message
			: `${label} worker request failed`;
	return { id: frame.id, ok: false, message };
}

/** Dial the worker's listener once; undefined while it is not listening yet. */
async function dial(endpoint: string): Promise<IpcConnection | undefined> {
	try {
		if (process.platform === "win32") {
			const port = Number.parseInt(await Bun.file(endpoint).text(), 10);
			if (!Number.isInteger(port)) return undefined;
			return await IpcConnection.connectTcp("127.0.0.1", port, {
				framing: "lines",
				timeoutMs: CONNECT_RETRY_MS * 10,
			});
		}
		return await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: CONNECT_RETRY_MS * 10 });
	} catch {
		return undefined;
	}
}

/** Last lines of the worker log, for exit errors. */
async function logTail(logPath: string): Promise<string> {
	try {
		const file = Bun.file(logPath);
		const text = await file.slice(Math.max(0, file.size - LOG_TAIL_BYTES)).text();
		return text.trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n");
	} catch {
		return "";
	}
}

/** One open disassembler database backed by a dedicated, detached Python worker process. */
export class DisasmWorker {
	/** Registry key from `locateDatabase`. */
	readonly id: string;
	readonly #backend: DisasmBackend;
	/** Absolute path of the binary or `.i64`/`.idb` the database was opened for. */
	readonly sourcePath: string;
	/** For universal binaries: the analyzed slice and its siblings. */
	readonly fat?: FatSelection;
	/** Worker process id. */
	readonly pid: number;
	readonly #startedAt: number | null;
	readonly #endpoint: string;
	readonly #token: string;
	readonly #logPath: string;
	readonly #aliasDir: string | undefined;
	readonly #lock: FileLockHandle;
	readonly #exited: Promise<number | null>;
	#idbPath: string;
	#info: DatabaseInfo = { module: "", format: "", arch: "", bitness: 0 };
	/** Resolves once a protocol connection is up; replaced while reconnecting. */
	#connection: Promise<IpcConnection>;
	/** Settles when the current connection closes. */
	#connectionClosed: Promise<void> = Promise.resolve();
	#queue: Promise<void> = Promise.resolve();
	#pending = new Map<number, PromiseWithResolvers<unknown>>();
	/** Unique across daemon restarts, so a late answer from a previous incarnation never matches. */
	#nextId = Date.now() * 1000;
	#logTail = "";
	#gone = false;
	#exitCode: number | null = null;
	/** Set once `open` (or a re-adopted worker's `status`) succeeded. */
	#opened = false;
	/** Re-attached by {@link adopt}: it may hold unsaved edits from before the daemon restart. */
	#adopted = false;
	/** {@link resume} in progress or settled; undefined until it is called. */
	#resumed: Promise<void> | undefined;
	#closing: Promise<void> | null = null;
	/** Whether the worker reported unsaved changes in its last successful response. */
	#dirty = false;
	/** `exec` ran since the last save; its mutations may bypass the dirty hooks. */
	#execSinceSave = false;
	/** Requests queued or in flight. */
	#active = 0;
	#current: RunningRequest | null = null;
	#lastUsed = Date.now();
	#autosaveTimer: Timer | undefined;
	#onActivity: () => void = () => {};

	private constructor(
		backend: DisasmBackend,
		loc: DatabaseLocation,
		lock: FileLockHandle,
		child: { pid: number; startedAt: number | null; exited: Promise<number | null> },
		files: WorkerFiles & { token: string; aliasDir?: string },
	) {
		this.#backend = backend;
		this.id = loc.id;
		this.sourcePath = loc.sourcePath;
		this.fat = loc.fat;
		this.pid = child.pid;
		this.#startedAt = child.startedAt;
		this.#idbPath = loc.openPath;
		this.#lock = lock;
		this.#endpoint = files.endpoint;
		this.#token = files.token;
		this.#logPath = files.logPath;
		this.#aliasDir = files.aliasDir;
		this.#exited = child.exited;
		this.#connection = this.#connect();
		// Connection failures surface on the first request.
		this.#connection.catch(() => undefined);
		void child.exited.then(code => this.#onExit(code));
	}

	/**
	 * Spawn a detached worker for `loc` and connect to it; call {@link open} next. The caller
	 * holds `lock` and has run `prepareStoreDir`; the worker releases the lock once it exits.
	 */
	static async spawn(
		backend: DisasmBackend,
		loc: DatabaseLocation,
		runtime: WorkerRuntime,
		lock: FileLockHandle,
		files: WorkerFiles,
	): Promise<DisasmWorker> {
		const script = await stageRunnerScript(backend.workerStageDir, "py", backend.workerScript);
		const token = crypto.randomUUID();
		await fs.promises.mkdir(path.dirname(files.logPath), { recursive: true });
		// `ipcEndpoint` may fall back to `/tmp/omp-<euid>/` when the state dir is too long for `sun_path`.
		await fs.promises.mkdir(path.dirname(files.endpoint), { recursive: true, mode: 0o700 });
		await fs.promises.rm(files.endpoint, { force: true });
		let pid: number;
		let exited: Promise<number>;
		const log = fs.openSync(files.logPath, "a");
		let alias: TempDir | undefined;
		try {
			alias = backend.projectAlias ? await TempDir.create(`@omp-${backend.id}-project-`) : undefined;
			if (alias) {
				await fs.promises.symlink(
					loc.dir,
					alias.join("project"),
					process.platform === "win32" ? "junction" : "dir",
				);
			}
			const listen = process.platform === "win32" ? "--port-file" : "--socket";
			const proc = Bun.spawn([runtime.pythonPath, "-u", script, listen, files.endpoint], {
				cwd: loc.dir,
				env: { ...runtime.env, [WORKER_TOKEN_ENV]: token },
				stdin: "ignore",
				stdout: log,
				stderr: log,
				// Own session: the worker outlives a daemon crash and is re-adopted; the module
				// saves and closes it with a `close` request instead of a group signal.
				detached: true,
				windowsHide: shouldHideKernelWindow({
					platform: process.platform,
					hostHasInheritableConsole: hostHasInheritableConsole(),
				}),
			});
			pid = proc.pid;
			exited = proc.exited;
		} catch (error) {
			await alias?.remove();
			throw error;
		} finally {
			fs.closeSync(log);
		}
		const startedAt = Process.fromPid(pid)?.startTime() ?? null;
		return new DisasmWorker(
			backend,
			loc,
			lock,
			{ pid, startedAt, exited },
			{ ...files, token, aliasDir: alias?.path() },
		);
	}

	/**
	 * Re-attach to a worker that survived a daemon restart; undefined when it is gone or its pid
	 * was reused. Call {@link resume} next.
	 */
	static adopt(
		backend: DisasmBackend,
		loc: DatabaseLocation,
		state: WorkerState,
		lock: FileLockHandle,
	): DisasmWorker | undefined {
		const proc = Process.fromPid(state.pid);
		if (!proc || (state.startedAt !== null && proc.startTime() !== state.startedAt)) return undefined;
		// Still our child after an in-place re-exec; re-parented to init after a crash.
		const exited = reapChild(state.pid).then(
			result => result.exitCode,
			async () => {
				await proc.waitForExit();
				return null;
			},
		);
		const worker = new DisasmWorker(
			backend,
			loc,
			lock,
			{ pid: state.pid, startedAt: state.startedAt, exited },
			{ endpoint: state.endpoint, logPath: state.logPath, token: state.token, aliasDir: state.aliasDir },
		);
		worker.#idbPath = state.idbPath;
		worker.#info = state.info;
		worker.#adopted = true;
		return worker;
	}

	/**
	 * Clean up after a worker that cannot be re-adopted: with `kill` (its database lock was taken
	 * by someone else meanwhile) SIGKILL it without saving while it is still the same process; then
	 * remove its endpoint and alias dir.
	 */
	static async discard(state: WorkerState, options: { kill: boolean }): Promise<void> {
		const proc = options.kill ? Process.fromPid(state.pid) : null;
		if (proc && (state.startedAt === null || proc.startTime() === state.startedAt)) {
			try {
				if (process.platform === "win32") process.kill(state.pid, "SIGKILL");
				else process.kill(-state.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			// Still our child after an in-place re-exec (reap it); re-parented to init after a crash.
			await reapChild(state.pid).then(
				() => undefined,
				() => proc.waitForExit({ timeoutMs: EXIT_GRACE_MS }),
			);
		}
		await Promise.all([
			fs.promises.rm(state.endpoint, { force: true }),
			state.aliasDir ? fs.promises.rm(state.aliasDir, { recursive: true, force: true }) : undefined,
		]).catch(error =>
			logger.warn("Disassembler worker cleanup failed", { pid: state.pid, error: errorMessage(error) }),
		);
	}

	/**
	 * Open (or create) the database. Opens cannot be cancelled; killing initial analysis could
	 * leave an incomplete database. On failure the worker is killed and a half-created store
	 * database is removed.
	 */
	async open(loc: DatabaseLocation): Promise<void> {
		try {
			const opened = await this.request<OpenResult>("open", {
				path: loc.openPath,
				new: loc.isNew,
				binary: loc.stagedPath,
				project: this.#aliasDir ? path.join(this.#aliasDir, "project") : loc.dir,
			});
			if (this.#gone) throw this.#exitError();
			this.#markOpen(opened);
		} catch (error) {
			await this.kill();
			if (loc.kind === "store" && loc.isNew) await removeCreationLeftovers(this.#backend, loc);
			throw error;
		}
	}

	/**
	 * Recover a re-adopted worker's state: `status` queues behind whatever it is still running
	 * (possibly the initial open). Unsaved `exec` edits cannot be ruled out, so a close saves.
	 */
	resume(): Promise<void> {
		this.#resumed ??= this.#resume();
		return this.#resumed;
	}

	async #resume(): Promise<void> {
		const status = await this.request<StatusResult>("status", {});
		if (!status.open) {
			await this.kill();
			throw new ToolError(`${this.#backend.label} worker for ${this.id} lost its database across a daemon restart`);
		}
		this.#execSinceSave = true;
		this.#markOpen(status);
	}

	/**
	 * Wait for a {@link resume} in progress to settle, bounded by the connect budget: long enough
	 * for the worker to reconnect and answer `status` unless it is still running a long request.
	 */
	async settleResume(): Promise<void> {
		const resumed = this.#resumed;
		if (!resumed) return;
		const budget = delay(CONNECT_TIMEOUT_MS);
		try {
			await Promise.race([resumed.catch(() => undefined), budget.promise]);
		} finally {
			budget.cancel();
		}
	}

	#markOpen(opened: OpenResult): void {
		this.#idbPath = opened.idb;
		this.#info = { module: opened.module, format: opened.format, arch: opened.arch, bitness: opened.bitness };
		this.#opened = true;
		this.#scheduleAutosave();
	}

	/** Serializable handle for {@link adopt}. */
	state(): WorkerState {
		return {
			pid: this.pid,
			startedAt: this.#startedAt,
			endpoint: this.#endpoint,
			token: this.#token,
			logPath: this.#logPath,
			aliasDir: this.#aliasDir,
			idbPath: this.#idbPath,
			info: this.#info,
		};
	}

	/** Called whenever the worker turns busy or idle. */
	onActivity(listener: () => void): void {
		this.#onActivity = listener;
	}

	/** Reference `read` and the backend tool resolve back to this database (see {@link databaseRef}). */
	get ref(): string {
		return databaseRef(this);
	}

	/** Whether the database finished opening. */
	get opened(): boolean {
		return this.#opened;
	}

	/** Whether this worker was re-attached after a daemon restart ({@link adopt}). */
	get adopted(): boolean {
		return this.#adopted;
	}

	/** Whether the worker process has not been seen exiting yet. */
	get running(): boolean {
		return !this.#gone;
	}

	/** Database path reported by the backend. */
	get idbPath(): string {
		return this.#idbPath;
	}

	/** Loader facts reported when the database opened. */
	get info(): DatabaseInfo {
		return this.#info;
	}

	/** Whether a close must save to keep every change: hook-tracked edits, or any `exec` since the last save. */
	get needsSave(): boolean {
		return this.#dirty || this.#execSinceSave;
	}

	/** Resolves with the worker's exit code (null when unknown: a re-adopted orphan) once it is gone. */
	get exited(): Promise<number | null> {
		return this.#exited;
	}

	/** When the last request was issued (epoch ms). */
	get lastUsed(): number {
		return this.#lastUsed;
	}

	/** Whether requests are queued or in flight. */
	get busy(): boolean {
		return this.#active > 0;
	}

	/** The request the worker is executing now, if any. */
	get current(): RunningRequest | null {
		return this.#current;
	}

	/**
	 * Send one request to the worker, serialized behind earlier requests. `timeoutMs` covers the
	 * queue wait too: a request still queued at its deadline fails with a {@link ToolError} naming
	 * the running request, without interrupting it (it belongs to another caller). A timeout or
	 * abort while executing interrupts it (SIGINT, or an `interrupt` frame for Windows and frame
	 * backends) and waits {@link INTERRUPT_GRACE_MS} for the answer; a worker that does not
	 * answer is killed. Worker-side failures surface as {@link ToolError}.
	 */
	async request<T>(method: WorkerMethod, params: object, options: WorkerRequestOptions = {}): Promise<T> {
		if (this.#gone) throw this.#exitError();
		const { signal, timeoutMs } = options;
		const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
		if (this.#active++ === 0) this.#onActivity();
		this.#lastUsed = Date.now();
		this.#clearAutosave();
		const previous = this.#queue;
		const turn = Promise.withResolvers<void>();
		this.#queue = previous.then(() => turn.promise);
		try {
			await this.#waitTurn(previous, signal, timeoutMs);
			const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
			const value = await this.#send(method, params, { signal, timeoutMs: remaining });
			if (method === "exec") this.#execSinceSave = true;
			else if (method === "save") this.#execSinceSave = false;
			// The worker answers with the JSON shape documented for `method`.
			return value as T;
		} finally {
			turn.resolve();
			if (--this.#active === 0) {
				this.#scheduleAutosave();
				this.#onActivity();
			}
		}
	}

	/** Wait for `previous` (the queue ahead), bounded by the signal and `timeoutMs`. */
	async #waitTurn(
		previous: Promise<void>,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
	): Promise<void> {
		const queued = untilAborted(signal, previous);
		if (timeoutMs === undefined) return queued;
		const wait = delay(timeoutMs);
		try {
			const ready = await Promise.race([queued.then(() => true), wait.promise.then(() => false)]);
			if (ready) return;
		} finally {
			wait.cancel();
		}
		const running = this.#current;
		throw new ToolError(
			running
				? `${this.#backend.label} ${this.id} busy: ${running.method} running for ${Math.round((Date.now() - running.startedAt) / 1000)}s; retry later or raise timeout`
				: `${this.#backend.label} ${this.id} busy: queued requests did not finish within ${Math.round(timeoutMs / 1000)}s`,
		);
	}

	/** Arm the idle autosave when dirty; any request disarms it. */
	#scheduleAutosave(): void {
		this.#clearAutosave();
		if (!this.#opened || this.#closing || this.#gone || !this.#dirty) return;
		this.#autosaveTimer = setTimeout(() => {
			if (this.#active > 0 || this.#closing) return;
			this.request("save", {}, { timeoutMs: CLOSE_TIMEOUT_MS }).catch(error => {
				logger.warn(`${this.#backend.label} autosave failed`, { id: this.id, error: errorMessage(error) });
			});
		}, AUTOSAVE_IDLE_MS);
		this.#autosaveTimer.unref();
	}

	#clearAutosave(): void {
		clearTimeout(this.#autosaveTimer);
		this.#autosaveTimer = undefined;
	}

	/** Close the worker (saving first when `save`) and wait for it to exit; the lock is released on exit. */
	close(options: { save: boolean }): Promise<void> {
		this.#closing ??= this.#close(options.save);
		return this.#closing;
	}

	async #close(save: boolean): Promise<void> {
		try {
			await this.request("close", { save }, { timeoutMs: CLOSE_TIMEOUT_MS });
			const grace = delay(EXIT_GRACE_MS);
			const exited = await Promise.race([this.#exited.then(() => true), grace.promise.then(() => false)]);
			grace.cancel();
			if (!exited) await this.kill();
		} catch (error) {
			await this.kill();
			throw error;
		}
	}

	/** Connect to the worker's listener and authenticate; retries until it listens, exits, or times out. */
	async #connect(): Promise<IpcConnection> {
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		for (;;) {
			if (this.#gone) throw this.#exitError();
			const conn = await dial(this.#endpoint);
			if (conn) {
				if (this.#gone) {
					conn.destroy();
					throw this.#exitError();
				}
				this.#attach(conn);
				return conn;
			}
			if (Date.now() > deadline) {
				await this.kill();
				throw new ToolError(
					`${this.#backend.label} worker for ${this.id} did not accept a connection within ${CONNECT_TIMEOUT_MS / 1000}s; see ${this.#logPath}`,
				);
			}
			await Bun.sleep(CONNECT_RETRY_MS);
		}
	}

	#attach(conn: IpcConnection): void {
		const closed = Promise.withResolvers<void>();
		this.#connectionClosed = closed.promise;
		conn.start(
			line => this.#onLine(line),
			reason => {
				closed.resolve();
				if (this.#gone) return;
				// The worker keeps its database across a dropped connection: fail what was in flight
				// (its answers are lost) and reconnect.
				logger.warn(`${this.#backend.label} worker connection dropped`, { id: this.id, reason });
				const error = new ToolError(`${this.#backend.label} worker connection for ${this.id} dropped`);
				for (const entry of this.#pending.values()) entry.reject(error);
				this.#pending.clear();
				this.#connection = this.#connect();
				this.#connection.catch(() => undefined);
			},
		);
		conn.send(JSON.stringify({ token: this.#token }));
	}

	async #writeFrame(frame: string): Promise<void> {
		const conn = await this.#connection;
		if (!conn.send(frame)) await conn.drained();
	}

	async #send(method: WorkerMethod, params: object, options: WorkerRequestOptions): Promise<unknown> {
		if (this.#gone) throw this.#exitError();
		const id = this.#nextId++;
		const response = Promise.withResolvers<unknown>();
		this.#pending.set(id, response);
		this.#current = { method, startedAt: Date.now() };
		try {
			// Serialize first: a non-serializable request is the caller's error and must not kill the worker.
			const frame = JSON.stringify({ id, method, params });
			try {
				await this.#writeFrame(frame);
			} catch (error) {
				if (this.#gone) throw this.#exitError();
				this.#pending.delete(id);
				throw new ToolError(
					`Failed to send ${method} to the ${this.#backend.label} worker for ${this.id}: ${errorMessage(error)}`,
				);
			}

			const { signal, timeoutMs } = options;
			const interrupted = Promise.withResolvers<RequestOutcome>();
			const onInterrupt = () => interrupted.resolve({ kind: "interrupted" });
			const deadline = timeoutMs === undefined ? undefined : delay(timeoutMs);
			void deadline?.promise.then(onInterrupt);
			signal?.addEventListener("abort", onInterrupt, { once: true });
			if (signal?.aborted) onInterrupt();
			try {
				const first = await Promise.race([
					response.promise.then((value): RequestOutcome => ({ kind: "response", value })),
					interrupted.promise,
				]);
				if (first.kind === "response") return first.value;
			} finally {
				deadline?.cancel();
				signal?.removeEventListener("abort", onInterrupt);
			}

			try {
				if (process.platform === "win32" || this.#backend.interrupt === "frame") {
					// Windows has no per-process SIGINT (kill terminates); the worker's reader thread handles this frame.
					await this.#writeFrame(JSON.stringify({ interrupt: id }));
				} else {
					process.kill(this.pid, "SIGINT");
				}
			} catch {
				// Already gone: the exit handler rejects the pending response.
			}
			const grace = delay(INTERRUPT_GRACE_MS);
			try {
				const late = await Promise.race([
					response.promise.then((value): RequestOutcome => ({ kind: "response", value })),
					grace.promise.then((): RequestOutcome => ({ kind: "interrupted" })),
				]);
				if (late.kind === "response") return late.value;
			} finally {
				grace.cancel();
			}
			this.#pending.delete(id);
			await this.kill();
			throw new ToolError(
				`${this.#backend.label} ${method} did not stop after interrupt; worker killed, changes since the last save are lost`,
			);
		} finally {
			this.#pending.delete(id);
			this.#current = null;
		}
	}

	#onLine(line: string): void {
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			logger.warn(`${this.#backend.label} worker wrote non-JSON to its protocol socket`, {
				id: this.id,
				line: line.slice(0, 200),
			});
			return;
		}
		const response = parseWorkerResponse(frame, this.#backend.label);
		const entry = response ? this.#pending.get(response.id) : undefined;
		if (!response || !entry) {
			// Includes late answers to requests a previous daemon incarnation sent.
			logger.debug(`${this.#backend.label} worker sent an unmatched response`, {
				id: this.id,
				line: line.slice(0, 200),
			});
			return;
		}
		this.#pending.delete(response.id);
		if (response.ok) {
			if (response.dirty !== undefined) this.#dirty = response.dirty;
			entry.resolve(response.result);
		} else {
			entry.reject(new ToolError(response.message));
		}
	}

	async #onExit(code: number | null): Promise<void> {
		this.#gone = true;
		this.#exitCode = code;
		this.#clearAutosave();
		this.#lock.release();
		// A response written right before exit (e.g. `close`) must settle before pending requests fail.
		const drain = delay(STREAM_DRAIN_MS);
		await Promise.race([this.#connectionClosed, drain.promise]);
		drain.cancel();
		this.#logTail = await logTail(this.#logPath);
		const error = this.#exitError();
		for (const entry of this.#pending.values()) entry.reject(error);
		this.#pending.clear();
		void this.#connection.then(
			conn => conn.destroy(),
			() => undefined,
		);
		await Promise.all([
			fs.promises.rm(this.#endpoint, { force: true }),
			this.#aliasDir ? fs.promises.rm(this.#aliasDir, { recursive: true, force: true }) : undefined,
		]).catch(error => {
			logger.warn(`${this.#backend.label} worker cleanup failed`, { id: this.id, error: errorMessage(error) });
		});
	}

	#exitError(): ToolError {
		const tail = this.#logTail;
		const code = this.#exitCode === null ? "unknown code" : `code ${this.#exitCode}`;
		return new ToolError(`${this.#backend.label} worker for ${this.id} exited (${code})${tail ? `: ${tail}` : ""}`);
	}

	/** SIGKILL the worker's session and wait for it to exit. */
	async kill(): Promise<void> {
		if (!this.#gone) {
			try {
				if (process.platform === "win32") process.kill(this.pid, "SIGKILL");
				else process.kill(-this.pid, "SIGKILL");
			} catch {
				try {
					process.kill(this.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
		await this.#exited;
	}
}

/** Delete everything a failed creation left in the store dir except the staged input and the lock file. */
async function removeCreationLeftovers(backend: DisasmBackend, loc: DatabaseLocation): Promise<void> {
	const keep = new Set([path.basename(loc.stagedPath), `${path.basename(loc.lockTarget)}.lock`]);
	try {
		const entries = await fs.promises.readdir(loc.dir);
		await Promise.all(
			entries
				.filter(entry => !keep.has(entry))
				.map(entry => fs.promises.rm(path.join(loc.dir, entry), { recursive: true, force: true })),
		);
	} catch (error) {
		logger.warn(`${backend.label} cleanup after failed database creation failed`, {
			id: loc.id,
			error: errorMessage(error),
		});
	}
}
