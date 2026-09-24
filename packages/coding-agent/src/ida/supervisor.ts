/**
 * Process-wide registry of open IDA databases.
 *
 * Each database runs in its own long-lived Python worker (`worker.py`) because idalib
 * supports one kernel and one open database per process. Every agent, subagent, and
 * post-compaction turn in this omp process shares the same live worker; requests to a
 * worker are serialized. Databases are saved on close and on process exit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileLock, type FileLockHandle, logger, postmortem, readLines, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Subprocess } from "bun";
import { killProcessGroup } from "../eval/kernel-base";
import { hostHasInheritableConsole, shouldDetachKernel, shouldHideKernelWindow } from "../eval/py/spawn-options";
import { stageRunnerScript } from "../eval/runner-cache";
import type { ToolSession } from "../tools";
import { type IdaRuntime, resolveIdaRuntime } from "./runtime";
import {
	type FatSelection,
	type IdbLocation,
	type LocateIdbOptions,
	locateIdb,
	prepareStoreDir,
	SLICE_SEPARATOR,
	sanitizeIdbName,
} from "./store";
import IDA_WORKER from "./worker.py" with { type: "text" };

/** How long a worker gets to answer after SIGINT before it is killed. */
const INTERRUPT_GRACE_MS = 5_000;
/** Budget for the worker's `close` (including the final save). */
const CLOSE_TIMEOUT_MS = 120_000;
/** How long to wait for the worker to exit after answering `close`. */
const EXIT_GRACE_MS = 10_000;
/** How long the exit handler waits for stdout/stderr to drain before failing pending requests. */
const STREAM_DRAIN_MS = 1_000;
const STDERR_TAIL_CHARS = 64 * 1024;
const STDERR_TAIL_LINES = 20;

/** RPC methods implemented by the IDA worker. */
export type IdaMethod =
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
export interface IdaDatabaseInfo {
	module: string;
	format: string;
	arch: string;
	bitness: number;
}

/** Per-request cancellation and deadline; either one interrupts the worker (SIGINT, then SIGKILL). */
export interface IdaRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface IdaOpenResult extends IdaDatabaseInfo {
	idb: string;
}

type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; message: string };

type RequestOutcome = { kind: "response"; value: unknown } | { kind: "interrupted" };

const databases = new Map<string, IdaDatabase>();
const pending = new Map<string, Promise<IdaDatabase>>();
let cleanupRegistered = false;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A timer that does not keep the event loop alive; `cancel` clears it. */
function delay(ms: number): { promise: Promise<void>; cancel(): void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref();
	return { promise, cancel: () => clearTimeout(timer) };
}

function parseWorkerResponse(frame: unknown): WorkerResponse | null {
	if (typeof frame !== "object" || frame === null) return null;
	if (!("id" in frame) || typeof frame.id !== "number") return null;
	if (!("ok" in frame) || typeof frame.ok !== "boolean") return null;
	if (frame.ok) return { id: frame.id, ok: true, result: "result" in frame ? frame.result : undefined };
	const error = "error" in frame ? frame.error : undefined;
	const message =
		typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
			? error.message
			: "IDA worker request failed";
	return { id: frame.id, ok: false, message };
}

/** A live IDA database backed by a dedicated worker process; shared by every agent in this omp process. */
export class IdaDatabase {
	/** Registry key from `locateIdb`. */
	readonly id: string;
	/** Absolute path of the binary or `.i64`/`.idb` the database was opened for. */
	readonly sourcePath: string;
	/** For universal binaries: the analyzed slice and its siblings. */
	readonly fat?: FatSelection;
	/** Worker process id. */
	readonly pid: number;
	#idbPath: string;
	#info: IdaDatabaseInfo = { module: "", format: "", arch: "", bitness: 0 };
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

	private constructor(loc: IdbLocation, proc: Subprocess<"pipe", "pipe", "pipe">, lock: FileLockHandle) {
		this.id = loc.id;
		this.sourcePath = loc.sourcePath;
		this.fat = loc.fat;
		this.pid = proc.pid;
		this.#idbPath = loc.openPath;
		this.#proc = proc;
		this.#lock = lock;
		this.#streamsDrained = Promise.all([this.#readStdout(proc.stdout), this.#drainStderr(proc.stderr)]);
		void proc.exited.then(code => this.#onExit(code));
	}

	/**
	 * Spawn a worker for `loc` and open its database. The caller holds `lock` and has run
	 * `prepareStoreDir`; on failure the worker is killed, a half-created store IDB is removed,
	 * and the lock stays with the caller.
	 */
	static async start(
		loc: IdbLocation,
		runtime: IdaRuntime,
		lock: FileLockHandle,
		signal?: AbortSignal,
	): Promise<IdaDatabase> {
		const script = await stageRunnerScript("omp-ida-worker", "py", IDA_WORKER);
		const proc = Bun.spawn([runtime.pythonPath, "-u", script], {
			cwd: loc.dir,
			env: runtime.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			detached: shouldDetachKernel(process.platform),
			windowsHide: shouldHideKernelWindow({
				platform: process.platform,
				hostHasInheritableConsole: hostHasInheritableConsole(),
			}),
		});
		const db = new IdaDatabase(loc, proc, lock);
		try {
			const opened = await db.request<IdaOpenResult>("open", { path: loc.openPath, new: loc.isNew }, { signal });
			if (db.#exitCode !== null) throw db.#exitError();
			db.#idbPath = opened.idb;
			db.#info = { module: opened.module, format: opened.format, arch: opened.arch, bitness: opened.bitness };
			db.#opened = true;
			return db;
		} catch (error) {
			await db.#kill();
			if (loc.kind === "store" && loc.isNew) await removeCreationLeftovers(loc);
			throw error;
		}
	}

	/** Reference `read` and `ida db=` resolve back to this database: the source path plus `:@<arch>` for a universal binary slice. */
	get ref(): string {
		return this.fat ? `${this.sourcePath}${SLICE_SEPARATOR}${this.fat.slice.arch}` : this.sourcePath;
	}

	/** Path of the IDB file as reported by IDA. */
	get idbPath(): string {
		return this.#idbPath;
	}

	/** Loader facts reported when the database opened. */
	get info(): IdaDatabaseInfo {
		return this.#info;
	}

	/**
	 * Send one request to the worker, serialized behind earlier requests. A timeout or abort sends
	 * SIGINT and waits {@link INTERRUPT_GRACE_MS} for the answer; a worker that does not answer is
	 * killed and a {@link ToolError} is thrown. Worker-side failures surface as {@link ToolError}.
	 */
	async request<T>(method: IdaMethod, params: object, options: IdaRequestOptions = {}): Promise<T> {
		if (this.#exitCode !== null) throw this.#exitError();
		const previous = this.#queue;
		const turn = Promise.withResolvers<void>();
		this.#queue = previous.then(() => turn.promise);
		try {
			await untilAborted(options.signal, previous);
			const value = await this.#send(method, params, options);
			// The worker answers with the JSON shape documented for `method`.
			return value as T;
		} finally {
			turn.resolve();
		}
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

	async #send(method: IdaMethod, params: object, options: IdaRequestOptions): Promise<unknown> {
		if (this.#exitCode !== null) throw this.#exitError();
		const id = this.#nextId++;
		const response = Promise.withResolvers<unknown>();
		this.#pending.set(id, response);
		try {
			try {
				this.#proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
				await this.#proc.stdin.flush();
			} catch (error) {
				if (this.#exitCode !== null) throw this.#exitError();
				throw new ToolError(`Failed to send ${method} to the IDA worker for ${this.id}: ${errorMessage(error)}`);
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
				this.#proc.kill("SIGINT");
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
				`IDA ${method} did not stop after interrupt; worker killed, changes since the last save are lost`,
			);
		} finally {
			this.#pending.delete(id);
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
					logger.warn("IDA worker wrote non-JSON to its protocol stream", {
						id: this.id,
						line: line.slice(0, 200),
					});
					continue;
				}
				const response = parseWorkerResponse(frame);
				const entry = response ? this.#pending.get(response.id) : undefined;
				if (!response || !entry) {
					logger.warn("IDA worker sent an unmatched response", { id: this.id, line: line.slice(0, 200) });
					continue;
				}
				this.#pending.delete(response.id);
				if (response.ok) entry.resolve(response.result);
				else entry.reject(new ToolError(response.message));
			}
		} catch (error) {
			logger.warn("IDA worker stdout reader failed", { id: this.id, error: errorMessage(error) });
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
			logger.debug("IDA worker stderr reader failed", { id: this.id, error: errorMessage(error) });
		}
	}

	#appendStderr(text: string): void {
		if (!text) return;
		const tail = this.#stderrTail + text;
		this.#stderrTail = tail.length > STDERR_TAIL_CHARS ? tail.slice(-STDERR_TAIL_CHARS) : tail;
	}

	async #onExit(code: number): Promise<void> {
		this.#exitCode = code;
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
		return new ToolError(`IDA worker for ${this.id} exited (code ${this.#exitCode})${lines ? `: ${lines}` : ""}`);
	}

	/** SIGKILL the worker (and its process group) and wait for it to exit. */
	async #kill(): Promise<void> {
		if (this.#exitCode === null) {
			try {
				this.#proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
			killProcessGroup(this.#proc.pid, "SIGKILL");
		}
		await this.#proc.exited;
	}

	#release(): void {
		if (databases.get(this.id) === this) databases.delete(this.id);
		this.#lock.release();
	}
}

/** Delete everything a failed creation left in the store dir except the staged input and the lock file. */
async function removeCreationLeftovers(loc: IdbLocation): Promise<void> {
	const keep = new Set([sanitizeIdbName(path.basename(loc.sourcePath)), `${path.basename(loc.lockTarget)}.lock`]);
	try {
		const entries = await fs.promises.readdir(loc.dir);
		await Promise.all(
			entries
				.filter(entry => !keep.has(entry))
				.map(entry => fs.promises.rm(path.join(loc.dir, entry), { recursive: true, force: true })),
		);
	} catch (error) {
		logger.warn("IDA cleanup after failed database creation failed", { id: loc.id, error: errorMessage(error) });
	}
}

function registerIdaCleanup(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	postmortem.register("ida-cleanup", closeAllIdaDatabases);
}

async function openIdaDatabase(session: ToolSession, loc: IdbLocation, signal?: AbortSignal): Promise<IdaDatabase> {
	const lock = await acquireFileLock(loc.lockTarget, { retries: 1 }).catch(() => {
		throw new ToolError(`IDB ${loc.id} is in use by another omp process`);
	});
	try {
		await prepareStoreDir(loc);
		const runtime = await resolveIdaRuntime(session);
		registerIdaCleanup();
		const db = await IdaDatabase.start(loc, runtime, lock, signal);
		databases.set(loc.id, db);
		return db;
	} catch (error) {
		lock.release();
		throw error;
	}
}

/** Options for {@link acquireIdaDatabase}. */
export interface AcquireIdaDatabaseOptions extends LocateIdbOptions {
	signal?: AbortSignal;
}

/**
 * Return the live database for a binary (or one slice of a universal binary) or `.i64`/`.idb`,
 * opening (or creating) it on first use. Concurrent callers for the same database share one open.
 */
export async function acquireIdaDatabase(
	session: ToolSession,
	sourcePath: string,
	options: AcquireIdaDatabaseOptions = {},
): Promise<IdaDatabase> {
	const { signal, arch } = options;
	const loc = await locateIdb(sourcePath, { arch });
	const open = databases.get(loc.id);
	if (open) return open;
	const inflight = pending.get(loc.id);
	if (inflight) return untilAborted(signal, inflight);
	const opening = openIdaDatabase(session, loc, signal).finally(() => pending.delete(loc.id));
	pending.set(loc.id, opening);
	return opening;
}

/** The open database registered under `id`, if any. */
export function findOpenIdaDatabase(id: string): IdaDatabase | undefined {
	return databases.get(id);
}

/** Every open database in this process. */
export function listIdaDatabases(): IdaDatabase[] {
	return Array.from(databases.values());
}

/** Close the open database `id` (saving first when `save`); throws when it is not open. */
export async function closeIdaDatabase(id: string, options: { save: boolean }): Promise<void> {
	const db = databases.get(id);
	if (!db) throw new ToolError(`IDA database ${id} is not open`);
	await db.close(options);
}

/** Save and close every open database; failures are logged, not thrown. */
export async function closeAllIdaDatabases(): Promise<void> {
	await Promise.all(
		Array.from(databases.values(), async db => {
			try {
				await db.close({ save: true });
			} catch (error) {
				logger.warn("IDA close on exit failed", { id: db.id, error: errorMessage(error) });
			}
		}),
	);
}
