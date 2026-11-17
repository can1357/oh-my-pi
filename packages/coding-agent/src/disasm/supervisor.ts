/**
 * Supervisor for one disassembler Python worker, run inside its broker-supervised
 * host daemon (`host.ts`).
 *
 * Each backend keeps one analysis database per Python process, so each database gets its own
 * worker. The worker speaks NDJSON over stdin/stdout; requests are serialized, dirty databases
 * autosave when idle, and idle databases save and close themselves.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type FileLockHandle, logger, readLines, TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Subprocess } from "bun";
import { hostHasInheritableConsole, shouldHideKernelWindow } from "../eval/py/spawn-options";
import { stageRunnerScript } from "../eval/runner-cache";
import type { DisasmBackend, WorkerRuntime } from "./backend";
import { type FatSelection, type DatabaseLocation, databaseRef } from "./store";
import { errorMessage } from "./protocol";

/** How long a worker gets to answer after SIGINT before it is killed. */
const INTERRUPT_GRACE_MS = 5_000;
/** Budget for the worker's `close` (including the final save). */
const CLOSE_TIMEOUT_MS = 120_000;
/** How long a dirty database must sit idle before it is saved automatically. */
const AUTOSAVE_IDLE_MS = 10_000;
/** How long to wait for the worker to exit after answering `close`. */
const EXIT_GRACE_MS = 10_000;
/** How long the exit handler waits for stdout/stderr to drain before failing pending requests. */
const STREAM_DRAIN_MS = 1_000;
const STDERR_TAIL_CHARS = 64 * 1024;
const STDERR_TAIL_LINES = 20;

/** RPC methods shared by disassembler workers. */
export type WorkerMethod =
	| "open"
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

/** Per-request cancellation and deadline; either one interrupts a running request (SIGINT, then SIGKILL). */
export interface WorkerRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface OpenResult extends DatabaseInfo {
	idb: string;
}

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

/** One open disassembler database backed by a dedicated Python worker process. */
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
	#idbPath: string;
	#info: DatabaseInfo = { module: "", format: "", arch: "", bitness: 0 };
	readonly #proc: Subprocess<"pipe", "pipe", "pipe">;
	readonly #lock: FileLockHandle;
	readonly #streamsDrained: Promise<unknown>;
	#queue: Promise<void> = Promise.resolve();
	#pending = new Map<number, PromiseWithResolvers<unknown>>();
	#nextId = 1;
	#stderrTail = "";
	#exitCode: number | null = null;
	/** Set once `open` succeeded; from then on the worker's exit releases the lock. */
	#opened = false;
	#closing: Promise<void> | null = null;
	/** Whether the worker reported unsaved changes in its last successful response. */
	#dirty = false;
	/** `exec` ran since the last save; its mutations may bypass the dirty hooks. */
	#execSinceSave = false;
	/** Requests queued or in flight. */
	#active = 0;
	#current: RunningRequest | null = null;
	#lastUsed = Date.now();
	/** Idle time after which the database is saved and closed; 0 disables. */
	readonly #idleCloseMs: number;
	#references = 0;
	#autosaveTimer: Timer | undefined;
	#idleTimer: Timer | undefined;

	constructor(
		backend: DisasmBackend,
		loc: DatabaseLocation,
		proc: Subprocess<"pipe", "pipe", "pipe">,
		lock: FileLockHandle,
		idleCloseMs: number,
	) {
		this.#backend = backend;
		this.id = loc.id;
		this.sourcePath = loc.sourcePath;
		this.fat = loc.fat;
		this.pid = proc.pid;
		this.#idbPath = loc.openPath;
		this.#proc = proc;
		this.#lock = lock;
		this.#idleCloseMs = idleCloseMs;
		this.#streamsDrained = Promise.all([this.#readStdout(proc.stdout), this.#drainStderr(proc.stderr)]);
		void proc.exited.then(code => this.#onExit(code));
	}

	/**
	 * Spawn a worker for `loc` and open its database. The caller holds `lock` and has run
	 * `prepareStoreDir`; on failure the worker is killed, a half-created store database is removed,
	 * and the lock stays with the caller. Opens cannot be cancelled; killing initial analysis
	 * could leave an incomplete database.
	 */
	static async start(
		backend: DisasmBackend,
		loc: DatabaseLocation,
		runtime: WorkerRuntime,
		lock: FileLockHandle,
		idleCloseMs: number,
	): Promise<DisasmWorker> {
		const script = await stageRunnerScript(backend.workerStageDir, "py", backend.workerScript);
		const alias = backend.projectAlias ? await TempDir.create(`@omp-${backend.id}-project-`) : undefined;
		const project = alias?.join("project") ?? loc.dir;
		let proc: Subprocess<"pipe", "pipe", "pipe">;
		try {
			if (alias) {
				await fs.promises.symlink(loc.dir, project, process.platform === "win32" ? "junction" : "dir");
			}
			proc = Bun.spawn([runtime.pythonPath, "-u", script], {
				cwd: loc.dir,
				env: runtime.env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				// Stay in the host's process group: the broker's stop/kill signals the whole group.
				// worker.py ignores SIGTERM so the host can save and close it first.
				detached: false,
				windowsHide: shouldHideKernelWindow({
					platform: process.platform,
					hostHasInheritableConsole: hostHasInheritableConsole(),
				}),
			});
		} catch (error) {
			await alias?.remove();
			throw error;
		}
		void proc.exited
			.then(() => alias?.remove())
			.catch(error => {
				logger.warn(`${backend.label} project alias cleanup failed`, { id: loc.id, error: errorMessage(error) });
			});
		const db = new DisasmWorker(backend, loc, proc, lock, idleCloseMs);
		try {
			const opened = await db.request<OpenResult>("open", {
				path: loc.openPath,
				new: loc.isNew,
				binary: loc.stagedPath,
				project,
			});
			if (db.#exitCode !== null) throw db.#exitError();
			db.#idbPath = opened.idb;
			db.#info = { module: opened.module, format: opened.format, arch: opened.arch, bitness: opened.bitness };
			db.#opened = true;
			db.#scheduleIdleWork();
			return db;
		} catch (error) {
			await db.#kill();
			if (loc.kind === "store" && loc.isNew) await removeCreationLeftovers(backend, loc);
			throw error;
		}
	}

	/** Reference `read` and the backend tool resolve back to this database (see {@link databaseRef}). */
	get ref(): string {
		return databaseRef(this);
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

	/** Resolves with the worker's exit code once the process is gone. */
	get exited(): Promise<number> {
		return this.#proc.exited;
	}

	/** When the last request was issued (epoch ms); LRU eviction closes the oldest idle database first. */
	get lastUsed(): number {
		return this.#lastUsed;
	}

	/** Whether requests are queued or in flight; busy databases are never evicted. */
	get busy(): boolean {
		return this.#active > 0;
	}

	/** Pin idle-close while host-owned database references exist; autosave stays enabled. */
	setReferenceCount(count: number): void {
		this.#references = count;
		this.#scheduleIdleWork();
	}

	/** The request the worker is executing now, if any. */
	get current(): RunningRequest | null {
		return this.#current;
	}

	/**
	 * Send one request to the worker, serialized behind earlier requests. `timeoutMs` covers the
	 * queue wait too: a request still queued at its deadline fails with a {@link ToolError} naming
	 * the running request, without interrupting it (it belongs to another caller). A timeout or
	 * abort while executing interrupts it (SIGINT; on Windows an `interrupt` frame on stdin) and
	 * waits {@link INTERRUPT_GRACE_MS} for the answer; a worker that does not answer is killed.
	 * Worker-side failures surface as {@link ToolError}.
	 */
	async request<T>(method: WorkerMethod, params: object, options: WorkerRequestOptions = {}): Promise<T> {
		if (this.#exitCode !== null) throw this.#exitError();
		const { signal, timeoutMs } = options;
		const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
		this.#active++;
		this.#lastUsed = Date.now();
		this.#clearIdleTimers();
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
			this.#active--;
			if (this.#active === 0) this.#scheduleIdleWork();
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

	/** Arm the idle autosave (when dirty) and idle close (when enabled); any request disarms both. */
	#scheduleIdleWork(): void {
		this.#clearIdleTimers();
		if (!this.#opened || this.#closing || this.#exitCode !== null) return;
		if (this.#dirty) {
			this.#autosaveTimer = setTimeout(() => {
				if (this.#active > 0 || this.#closing) return;
				this.request("save", {}, { timeoutMs: CLOSE_TIMEOUT_MS }).catch(error => {
					logger.warn(`${this.#backend.label} autosave failed`, { id: this.id, error: errorMessage(error) });
				});
			}, AUTOSAVE_IDLE_MS);
			this.#autosaveTimer.unref();
		}
		if (this.#idleCloseMs > 0 && this.#references === 0) {
			this.#idleTimer = setTimeout(() => {
				if (this.#active > 0 || this.#closing || this.#references > 0) return;
				this.close({ save: true }).catch(error => {
					logger.warn(`${this.#backend.label} idle close failed`, { id: this.id, error: errorMessage(error) });
				});
			}, this.#idleCloseMs);
			this.#idleTimer.unref();
		}
	}

	#clearIdleTimers(): void {
		clearTimeout(this.#autosaveTimer);
		clearTimeout(this.#idleTimer);
		this.#autosaveTimer = undefined;
		this.#idleTimer = undefined;
	}

	/** Close the worker (saving first when `save`), wait for it to exit, then release the lock and unregister. */
	close(options: { save: boolean }): Promise<void> {
		this.#closing ??= this.#close(options.save);
		return this.#closing;
	}

	async #close(save: boolean): Promise<void> {
		try {
			await this.request("close", { save }, { timeoutMs: CLOSE_TIMEOUT_MS });
			const grace = delay(EXIT_GRACE_MS);
			const exited = await Promise.race([this.#proc.exited.then(() => true), grace.promise.then(() => false)]);
			grace.cancel();
			if (!exited) await this.#kill();
		} catch (error) {
			await this.#kill();
			throw error;
		} finally {
			this.#release();
		}
	}

	async #writeFrame(line: string): Promise<void> {
		const write = Promise.resolve(this.#proc.stdin.write(line));
		void write.catch(() => {});
		await Promise.all([write, this.#proc.stdin.flush()]);
	}

	async #send(method: WorkerMethod, params: object, options: WorkerRequestOptions): Promise<unknown> {
		if (this.#exitCode !== null) throw this.#exitError();
		const id = this.#nextId++;
		const response = Promise.withResolvers<unknown>();
		this.#pending.set(id, response);
		this.#current = { method, startedAt: Date.now() };
		try {
			// Serialize first: a non-serializable request is the caller's error and must not kill the worker.
			const line = `${JSON.stringify({ id, method, params })}\n`;
			try {
				await this.#writeFrame(line);
			} catch (error) {
				if (this.#exitCode !== null) throw this.#exitError();
				// A broken stdin pipe is terminal; killing the worker runs the normal exit path and frees the lock.
				this.#pending.delete(id);
				await this.#kill();
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
					// Windows has no per-process SIGINT (kill terminates); worker.py reads this frame on its stdin thread.
					await this.#writeFrame(`${JSON.stringify({ interrupt: id })}\n`);
				} else {
					this.#proc.kill("SIGINT");
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
			await this.#kill();
			throw new ToolError(
				`${this.#backend.label} ${method} did not stop after interrupt; worker killed, changes since the last save are lost`,
			);
		} finally {
			this.#pending.delete(id);
			this.#current = null;
		}
	}

	async #readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const bytes of readLines(stream)) {
				const line = decoder.decode(bytes).trim();
				if (!line) continue;
				let frame: unknown;
				try {
					frame = JSON.parse(line);
				} catch {
					logger.warn(`${this.#backend.label} worker wrote non-JSON to its protocol stream`, {
						id: this.id,
						line: line.slice(0, 200),
					});
					continue;
				}
				const response = parseWorkerResponse(frame, this.#backend.label);
				const entry = response ? this.#pending.get(response.id) : undefined;
				if (!response || !entry) {
					logger.warn(`${this.#backend.label} worker sent an unmatched response`, {
						id: this.id,
						line: line.slice(0, 200),
					});
					continue;
				}
				this.#pending.delete(response.id);
				if (response.ok) {
					if (response.dirty !== undefined) this.#dirty = response.dirty;
					entry.resolve(response.result);
				} else {
					entry.reject(new ToolError(response.message));
				}
			}
		} catch (error) {
			logger.warn(`${this.#backend.label} worker stdout reader failed`, { id: this.id, error: errorMessage(error) });
		}
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of stream) {
				this.#appendStderr(decoder.decode(chunk, { stream: true }));
			}
			this.#appendStderr(decoder.decode());
		} catch (error) {
			logger.debug(`${this.#backend.label} worker stderr reader failed`, {
				id: this.id,
				error: errorMessage(error),
			});
		}
	}

	#appendStderr(text: string): void {
		if (!text) return;
		// The host's output is the daemon log (`omp ps logs`).
		process.stderr.write(text);
		const tail = this.#stderrTail + text;
		this.#stderrTail = tail.length > STDERR_TAIL_CHARS ? tail.slice(-STDERR_TAIL_CHARS) : tail;
	}

	async #onExit(code: number): Promise<void> {
		this.#exitCode = code;
		this.#clearIdleTimers();
		if (this.#opened) this.#release();
		// A response written right before exit (e.g. `close`) must settle before pending requests fail.
		const drain = delay(STREAM_DRAIN_MS);
		await Promise.race([this.#streamsDrained, drain.promise]);
		drain.cancel();
		const error = this.#exitError();
		for (const entry of this.#pending.values()) entry.reject(error);
		this.#pending.clear();
	}

	#exitError(): ToolError {
		const tail = this.#stderrTail.trimEnd();
		const lines = tail ? tail.split("\n").slice(-STDERR_TAIL_LINES).join("\n") : "";
		return new ToolError(
			`${this.#backend.label} worker for ${this.id} exited (code ${this.#exitCode})${lines ? `: ${lines}` : ""}`,
		);
	}

	/** SIGKILL the worker and wait for it to exit. */
	async #kill(): Promise<void> {
		if (this.#exitCode === null) {
			try {
				this.#proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
		await this.#proc.exited;
	}

	#release(): void {
		this.#lock.release();
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
