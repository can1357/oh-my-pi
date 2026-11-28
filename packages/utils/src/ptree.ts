/**
 * Process tree management utilities for Bun subprocesses.
 *
 * - Track managed child processes for cleanup on shutdown (postmortem).
 * - Drain stdout/stderr to avoid subprocess pipe deadlocks.
 * - Cross-platform tree kill for process groups (Windows taskkill, Unix -pid).
 * - Convenience helpers: captureText / execText, AbortSignal, timeouts.
 */

import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import { Process, type ProcessTerminateOptions } from "@oh-my-pi/pi-natives";
import type { Spawn, Subprocess } from "bun";
import { TempDir } from "./temp";
import { whichFresh } from "./which";

type InMask = "pipe" | "ignore" | Buffer | Uint8Array | null;

/** A Bun subprocess with stdout/stderr always piped (stdin may vary). */
type PipedSubprocess<In extends InMask = InMask> = Subprocess<In, "pipe", "pipe">;

const LINUX_SUBREAPER_COMMAND_ENV = "OMP_PTREE_SUBREAPER_COMMAND";
const LINUX_SUBREAPER_BUN_BE_BUN_ENV = "OMP_PTREE_SUBREAPER_BUN_BE_BUN";
const SUBREAPER_KILL_WINDOW_MS = 100;
const SUBREAPER_KILL_POLL_MS = 5;

/**
 * The launcher of a tool process (`exec`'s `toolOomScore`, {@link spawnToolProcess}): this build's runtime,
 * run as `-e` without a config file or a `.env` file, and with no environment but `BUN_BE_BUN` (the target's
 * environment could load code into it: `BUN_INSPECT_PRELOAD`, `BUN_OPTIONS`). It reads `{ file, argv, env }` as
 * JSON on its fd 3, sets its own OOM adjustment to 1000 and replaces itself with the file. The program keeps the
 * pid, inherits the adjustment, and starts with exactly that argv and environment, and with every signal the
 * runtime ignores at its default, as `Bun.spawn` starts it. On its fd 4 the launcher writes `R` just before the
 * exec, which closes that fd, and after a failed exec its error as JSON; it then exits 127.
 */
const TOOL_EXEC_SCRIPT = `
const fs = require("node:fs");
const { file, argv, env } = JSON.parse(fs.readFileSync(3, "utf8"));
fs.closeSync(3);
try {
	fs.writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {}
// An exec keeps an ignored signal ignored and resets a handled one.
process.on("SIGPIPE", () => {});
process.on("SIGXFSZ", () => {});
// The experimental execve's warning would otherwise reach the program's stderr, should it print.
process.removeAllListeners("warning");
process.on("warning", () => {});
if (typeof process.execve !== "function") process.exit(127);
fs.writeSync(4, "R");
try {
	process.execve(file, argv, env);
} catch (error) {
	const { code, errno, syscall, path, message } = error;
	fs.writeSync(4, JSON.stringify({ code, errno, syscall, path, message }));
}
process.exit(127);
`;

/** The launcher's own environment: none of the target's ({@link TOOL_EXEC_SCRIPT}). */
const TOOL_LAUNCHER_ENV = { BUN_BE_BUN: "1" };

/**
 * Where `Bun.spawn` looks a bare program name up when the environment's `PATH` is empty or missing (Unix), on a
 * glibc build: glibc's default `PATH`. A musl build of Bun uses musl's, `/usr/local/bin:/bin:/usr/bin`.
 */
const SPAWN_DEFAULT_PATH = "/usr/bin:/bin";

/** What the launcher of a tool process reported by the time it ran the program or ended. */
type ToolLaunchReport =
	/** The program runs in its place. */
	| { kind: "ran" }
	/** It ended before the exec: it could not run here, and the program did not start. */
	| { kind: "unstarted" }
	/** The error of its exec, which failed: the program's spawn fails with it. */
	| { kind: "failed"; error: Error }
	/** Its report could not be read: whether the program started is unknown, so it is never started again. */
	| { kind: "unknown"; error: Error };

/**
 * `payload` in a private file, already removed: a handle open for reading at its start, for the launcher's fd 3.
 * `null` where no such file can be made, or it cannot be removed again (its handle is closed then).
 */
async function toolPayload(payload: string): Promise<FileHandle | null> {
	let dir: TempDir;
	try {
		dir = await TempDir.create("@omp-tool-");
	} catch {
		return null;
	}
	let handle: FileHandle | null = null;
	try {
		// The directory is private (0700): no other user reaches the file.
		const file = dir.join("exec");
		await Bun.write(file, payload);
		handle = await fs.promises.open(file, "r");
	} catch {
		handle = null;
	}
	try {
		// Not its disposal, which ignores a failed removal.
		await dir.remove();
	} catch {
		// The payload, the target's environment, would stay readable at a path.
		await handle?.close();
		return null;
	}
	return handle;
}

/** What the launcher wrote on `report`, this process's end of its fd 4 (closed here), until that end closed. */
async function toolLaunchReport(report: number): Promise<ToolLaunchReport> {
	let said: string;
	try {
		said = await new Response(Bun.file(report).stream()).text();
	} catch (error) {
		const cause = error instanceof Error ? error : new Error(String(error));
		return {
			kind: "unknown",
			error: new Error(`tool process launch report unreadable: ${cause.message}`, { cause }),
		};
	} finally {
		fs.closeSync(report);
	}
	if (!said.startsWith("R")) return { kind: "unstarted" };
	if (said.length === 1) return { kind: "ran" };
	let failure: { code?: string; errno?: number; syscall?: string; path?: string; message?: string } = {};
	try {
		failure = JSON.parse(said.slice(1));
	} catch {
		failure = { message: `tool process exec failed: ${said.slice(1)}` };
	}
	const { code, errno, syscall, path: file, message } = failure;
	const error = Object.assign(new Error(message ?? "tool process exec failed"), { code, errno, syscall, path: file });
	return { kind: "failed", error };
}

/**
 * The file `Bun.spawn` runs for `name` with `options`: a name holding `/` as written (the exec resolves it against
 * the working directory); else the first match on the `PATH` of `options.env` (of `Bun.env` without one), and
 * where that is empty or missing on {@link SPAWN_DEFAULT_PATH}. `null` where there is none.
 */
function spawnFile(name: string, options: { env?: Record<string, string | undefined>; cwd?: string }): string | null {
	if (name.includes("/")) return name;
	const searched = (options.env ? options.env.PATH : Bun.env.PATH) || SPAWN_DEFAULT_PATH;
	return whichFresh(name, { PATH: searched, cwd: options.cwd });
}

/**
 * Spawn the launcher of tool process `cmd` (Linux) under Bun `options`, which it runs `cmd` with: the argv
 * (`options.argv0` in place of `cmd[0]`) and the environment (its own keys, `__proto__` included) `Bun.spawn`
 * would give it. `null` where it cannot start: no file for `cmd[0]` where `Bun.spawn` looks it up, no private
 * file for the payload, or a spawn that throws (no `/proc/<pid>/exe` to run). Else the launcher, which becomes
 * `cmd` in place, and its report.
 */
async function spawnToolLauncher<In extends Spawn.Writable, Out extends Spawn.Readable, Err extends Spawn.Readable>(
	cmd: string[],
	options: Spawn.SpawnOptions<In, Out, Err>,
): Promise<{ proc: Subprocess<In, Out, Err>; report: Promise<ToolLaunchReport> } | null> {
	const { argv0, env: givenEnv, ...launcherOptions } = options;
	const file = cmd[0] ? spawnFile(cmd[0], options) : null;
	if (!file) return null;
	// `Object.fromEntries` defines each key as its own property: assigning `__proto__` would set the prototype.
	const env = Object.fromEntries(
		Object.entries(givenEnv ?? Bun.env).flatMap(([name, value]): [string, string][] =>
			value === undefined ? [] : [[name, String(value)]],
		),
	);
	const argv = [argv0 ?? cmd[0], ...cmd.slice(1)];
	const payload = await toolPayload(JSON.stringify({ file, argv, env }));
	if (payload === null) return null;
	let proc: Subprocess<In, Out, Err>;
	try {
		// This process's image, which `/proc/self/exe` then names in the launcher too.
		proc = Bun.spawn<In, Out, Err>(
			[`/proc/${process.pid}/exe`, "--config=/dev/null", "--no-env-file", "-e", TOOL_EXEC_SCRIPT],
			{
				...launcherOptions,
				env: TOOL_LAUNCHER_ENV,
				stdio: [options.stdin, options.stdout, options.stderr, payload.fd, "pipe"] as [
					In,
					Out,
					Err,
					number,
					"pipe",
				],
			},
		);
	} catch {
		return null;
	} finally {
		await payload.close();
	}
	return { proc, report: toolLaunchReport(proc.stdio[4] as number) };
}

/** A launcher of a tool process, as {@link endToolLauncher} ends it. */
interface ToolLauncher {
	readonly pid: number;
	kill(signal?: NodeJS.Signals): void;
	readonly exited: Promise<unknown>;
}

/** End `proc`, a launcher whose program's start is unknown or abandoned, and what it leads (`detached`), and reap it. */
async function endToolLauncher(proc: ToolLauncher, detached: boolean | undefined): Promise<void> {
	try {
		if (detached) process.kill(-proc.pid, "SIGKILL");
		else proc.kill("SIGKILL");
	} catch {
		// It exited already.
	}
	await proc.exited;
}

/**
 * Settle the launch of `launcher` (leading a group, `detached`) on its `report`: `"ran"` where the program runs in
 * its place; else, once `exited()` (its exit) settles, `"unstarted"` where it ended before its exec. Throws the error
 * of the program's exec; or, once the launcher is ended, the error of a report that could not be read: the program
 * may have run, and is never started again.
 */
async function settleToolLaunch(
	report: ToolLaunchReport,
	launcher: ToolLauncher,
	detached: boolean | undefined,
	exited: () => Promise<unknown>,
): Promise<"ran" | "unstarted"> {
	switch (report.kind) {
		case "ran":
			return "ran";
		case "unknown":
			await endToolLauncher(launcher, detached);
			await exited();
			throw report.error;
		case "failed":
			await exited();
			throw report.error;
		case "unstarted":
			await exited();
			return "unstarted";
	}
}

/** `report`, or `"aborted"` once `signal` aborts first. */
async function untilLaunched(
	report: Promise<ToolLaunchReport>,
	signal: AbortSignal | undefined,
): Promise<ToolLaunchReport | "aborted"> {
	if (!signal) return await report;
	if (signal.aborted) return "aborted";
	const aborted = Promise.withResolvers<"aborted">();
	const onAbort = () => aborted.resolve("aborted");
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([report, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** {@link spawnToolProcess}'s control of the launch itself. */
export interface ToolLaunchOptions {
	/**
	 * Ends the launch: where it aborts before the program runs, the launcher is killed and reaped, and the spawn fails
	 * with the signal's reason; nothing is spawned in its place. A program already running is not affected.
	 */
	signal?: AbortSignal;
}

/**
 * `Bun.spawn(cmd, options)` of a tool process: on Linux it runs with OOM adjustment 1000 from its first
 * instruction (its startup hooks included: Python's `sitecustomize`), which what it starts inherits, so the
 * kernel prefers to kill it over this process when it picks one to kill for lack of memory; this process keeps
 * its own value. The launcher ({@link TOOL_EXEC_SCRIPT}), this build's runtime, sets the value and execs the
 * program in its place: one runtime start per spawn, before this resolves. A program that cannot exec fails with
 * the error of that exec, and is never spawned again; nor is one whose launcher's report cannot be read, which
 * fails with that error once the launcher is ended. Where the launcher cannot start or ends before its exec (no
 * `/proc`), `cmd` is spawned itself, unless `launch.signal` or `options.signal` aborted. Elsewhere `Bun.spawn` as it
 * is.
 */
export async function spawnToolProcess<
	const In extends Spawn.Writable = "ignore",
	const Out extends Spawn.Readable = "pipe",
	const Err extends Spawn.Readable = "inherit",
>(
	cmd: string[],
	options: Spawn.SpawnOptions<In, Out, Err> = {},
	launch: ToolLaunchOptions = {},
): Promise<Subprocess<In, Out, Err>> {
	launch.signal?.throwIfAborted();
	const launched = process.platform === "linux" ? await spawnToolLauncher(cmd, options) : null;
	if (!launched) {
		launch.signal?.throwIfAborted();
		// Aborted while the launcher was to start: the program's spawn was aborted, and nothing starts.
		options.signal?.throwIfAborted();
		return Bun.spawn<In, Out, Err>(cmd, options);
	}
	const report = await untilLaunched(launched.report, launch.signal);
	if (report === "aborted") {
		await endToolLauncher(launched.proc, options.detached);
		throw launch.signal?.reason ?? new Error("tool process launch aborted");
	}
	if ((await settleToolLaunch(report, launched.proc, options.detached, () => launched.proc.exited)) === "ran") {
		return launched.proc;
	}
	launch.signal?.throwIfAborted();
	// Ended before the exec by `options.signal`: the program's spawn was aborted.
	if (options.signal?.aborted) return launched.proc;
	return Bun.spawn<In, Out, Err>(cmd, options);
}

/**
 * Build the Linux child-subreaper entrypoint.
 *
 * @internal Exported so tests can force a missing first libc soname and verify
 * the loader continues to the next candidate.
 */
export function createLinuxSubreaperScript(libcCandidates: readonly string[] = ["libc.so.6", "libc.so"]): string {
	return `
import { dlopen, FFIType } from "bun:ffi";

let libc;
for (const soname of ${JSON.stringify(libcCandidates)}) {
	try {
		libc = dlopen(soname, {
			prctl: {
				args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
				returns: FFIType.i32,
			},
			waitpid: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		break;
	} catch {}
}
if (!libc) throw new Error("failed to load libc for Linux child supervision");

if (libc.symbols.prctl(36, 1, 0, 0, 0) !== 0) {
	throw new Error("failed to become a Linux child subreaper");
}

const commandJson = Bun.env.${LINUX_SUBREAPER_COMMAND_ENV};
if (!commandJson) throw new Error("missing supervised command");
const callerBunBeBun = Bun.env.${LINUX_SUBREAPER_BUN_BE_BUN_ENV};
delete Bun.env.${LINUX_SUBREAPER_COMMAND_ENV};
delete Bun.env.${LINUX_SUBREAPER_BUN_BE_BUN_ENV};
if (callerBunBeBun === undefined) delete Bun.env.BUN_BE_BUN;
else Bun.env.BUN_BE_BUN = callerBunBeBun;
const command = JSON.parse(commandJson);
const child = Bun.spawn(command, {
	stdin: "inherit",
	stdout: "pipe",
	stderr: "pipe",
	windowsHide: true,
	env: Bun.env,
});

async function relay(stream, destination) {
	const writer = destination.writer();
	for await (const chunk of stream) writer.write(chunk);
	await writer.flush();
}

function hasLiveChildren() {
	let childPid;
	do {
		childPid = libc.symbols.waitpid(-1, null, 1);
	} while (childPid > 0);
	return childPid === 0;
}

const [exitCode] = await Promise.all([
	child.exited,
	relay(child.stdout, Bun.stdout),
	relay(child.stderr, Bun.stderr),
]);
while (hasLiveChildren()) await Bun.sleep(10);
process.exit(exitCode ?? 1);
`;
}

const LINUX_SUBREAPER_SCRIPT = createLinuxSubreaperScript();

// ── Exceptions ───────────────────────────────────────────────────────────────

/**
 * Base for all exceptions representing child process nonzero exit, killed, or
 * cancellation.
 */
export abstract class Exception extends Error {
	constructor(
		message: string,
		public readonly exitCode: number,
		public readonly stderr: string,
	) {
		super(message);
		this.name = this.constructor.name;
	}
	abstract readonly aborted: boolean;
}

/** Exception for nonzero exit codes (not cancellation). */
export class NonZeroExitError extends Exception {
	static readonly MAX_TRACE = 32 * 1024;

	constructor(exitCode: number, stderr: string) {
		super(`Process exited with code ${exitCode}:\n${stderr}`, exitCode, stderr);
	}
	get aborted() {
		return false;
	}
}

/** Exception for explicit process abortion (via signal). */
export class AbortError extends Exception {
	constructor(
		public readonly reason: unknown,
		stderr: string,
	) {
		const msg = reason instanceof Error ? reason.message : String(reason ?? "aborted");
		super(`Operation cancelled: ${msg}`, -1, stderr);
	}
	get aborted() {
		return true;
	}
}

/** Exception for process timeout. */
export class TimeoutError extends AbortError {
	constructor(timeout: number, stderr: string) {
		super(new Error(`Timed out after ${Math.round(timeout / 1000)}s`), stderr);
	}
}

// ── Wait / Exec types ────────────────────────────────────────────────────────

/** Options for waiting for process exit and capturing output. */
export interface WaitOptions {
	allowNonZero?: boolean;
	allowAbort?: boolean;
	/** `full` requires upfront capture; `exec` enables it, while direct `spawn` callers pass `stderr: "full"`. */
	stderr?: "full" | "buffer";
}

/** Result from wait and exec. */
export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	ok: boolean;
	exitError?: Exception;
}

// ── ChildProcess ─────────────────────────────────────────────────────────────

/**
 * ChildProcess wraps a managed subprocess, capturing stderr tail, providing
 * cross-platform kill/detach logic plus AbortSignal integration.
 *
 * Stdout is exposed directly from the underlying Bun subprocess; consumers
 * must read it (via text(), wait(), etc.) to prevent pipe deadlock.
 * Stderr is eagerly drained into an internal buffer.
 */
export class ChildProcess<In extends InMask = InMask> {
	#nothrow = false;
	#stderrTail = "";
	#stderrChunks?: Uint8Array[];
	#exitReason?: Exception;
	#exitReasonPending?: Exception;
	#stderrDone: Promise<void>;
	#exited: Promise<number>;
	#openPipeReaders = 1;
	// Set at the command deadline or on abort; otherwise commands keep complete
	// EOF-based capture. Active pipe readers are cancelled at cutoff so their
	// pending read() settles as done and partial output is kept.
	#cutoff = false;
	/** Readers of piped stdio; timeout and abort cancel them so pending reads settle. */
	#pipeReaders = new Set<{ cancel(reason?: unknown): Promise<void> }>();
	// Each registration reconciles its listener with root-exit and reader activity.
	// Keeping the registration after idle lets a later output read re-arm the signal.
	#abortRegistrations?: Set<() => void>;
	#timeoutTimer?: NodeJS.Timeout;
	#stderrStream?: ReadableStream<Uint8Array>;
	// Termination in flight after kill(); aborted exits await it before reporting.
	#terminating?: Promise<boolean | void>;
	// The one stop sequence of a subreaper-supervised command; a later hard
	// kill request ends its grace period, and any other later request is a no-op.
	#subreaperStop?: { escalate: () => void };
	#terminateGroup: boolean;
	#hardKillTree: boolean;
	// Windows has no process groups. Retaining the root's native handle pins
	// its PID after exit so killTree() can still enumerate its original children.
	#windowsRootProcess?: Process;
	constructor(
		readonly proc: PipedSubprocess<In>,
		readonly exposeStderr: boolean,
		retainFullStderr = exposeStderr,
		terminateGroup = false,
		hardKillTree = false,
	) {
		this.#terminateGroup = terminateGroup;
		this.#hardKillTree = hardKillTree;
		this.#windowsRootProcess = process.platform === "win32" ? (Process.fromPid(proc.pid) ?? undefined) : undefined;
		if (retainFullStderr) this.#stderrChunks = [];
		// Eagerly drain stderr into a truncated tail, retaining raw chunks only for explicit full capture.
		const dec = new TextDecoder();
		const trim = () => {
			if (this.#stderrTail.length > NonZeroExitError.MAX_TRACE)
				this.#stderrTail = this.#stderrTail.slice(-NonZeroExitError.MAX_TRACE);
		};
		let stderrStream = proc.stderr;
		if (exposeStderr) {
			const [teeStream, drainStream] = stderrStream.tee();
			this.#stderrStream = teeStream;
			stderrStream = drainStream;
		}
		// Normalize Bun's exited promise into our exitReason / exitedCleanly model.
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		this.#exited = promise;

		this.#stderrDone = (async () => {
			const reader = stderrStream.getReader();
			this.#pipeReaders.add(reader);
			try {
				for (;;) {
					if (this.#cutoff) {
						await reader.cancel().catch(() => {});
						break;
					}
					const r = await reader.read();
					if (r.done) break;
					this.#stderrChunks?.push(r.value);
					this.#stderrTail += dec.decode(r.value, { stream: true });
					trim();
				}
			} catch {}
			this.#pipeReaders.delete(reader);
			this.#openPipeReaders--;
			this.#stderrTail += dec.decode();
			trim();
			this.#syncAbortListeners();
		})();

		proc.exited
			.catch(() => null)
			.then(async exitCode => {
				this.#syncAbortListeners();
				if (this.#exitReasonPending) {
					this.#exitReason = this.#exitReasonPending;
					reject(this.#exitReasonPending);
					return;
				}
				if (exitCode === 0) {
					resolve(0);
					return;
				}

				await this.#stderrDone;
				if (this.#exitReasonPending) {
					this.#exitReason = this.#exitReasonPending;
					reject(this.#exitReasonPending);
					return;
				}

				if (exitCode !== null) {
					this.#exitReason = new NonZeroExitError(exitCode, this.#stderrTail);
					resolve(exitCode);
					return;
				}

				const ex = this.proc.killed
					? new AbortError(new Error("process killed"), this.#stderrTail)
					: new NonZeroExitError(-1, this.#stderrTail);
				this.#exitReason = ex;
				reject(ex);
			});
	}

	// ── Properties ───────────────────────────────────────────────────────

	get pid() {
		return this.proc.pid;
	}
	get exited() {
		return this.#exited;
	}
	get exitCode() {
		return this.proc.exitCode;
	}
	get exitReason() {
		return this.#exitReason;
	}
	get killed() {
		return this.proc.killed;
	}
	get stdin(): Bun.SpawnOptions.WritableToIO<In> {
		return this.proc.stdin;
	}

	/** Raw stdout stream. Must be consumed to prevent pipe deadlock. */
	get stdout() {
		return this.proc.stdout;
	}

	/** Optional stderr stream (only when requested in spawn options). */
	get stderr() {
		return this.#stderrStream;
	}

	get exitedCleanly(): Promise<number> {
		if (this.#nothrow) return this.#exited;
		return this.#exited.then(code => {
			if (code !== 0) throw new NonZeroExitError(code, this.#stderrTail);
			return code;
		});
	}

	/** Returns the truncated stderr tail (last 32KB). */
	peekStderr() {
		return this.#stderrTail;
	}

	nothrow(): this {
		this.#nothrow = true;
		return this;
	}

	kill(reason?: Exception, gracefulMs?: number) {
		if (reason && !this.#exitReasonPending) {
			this.#exitReasonPending = reason;
			// The normalized exit promise may already have resolved from a dead
			// group leader; wait() still needs to report the later deadline.
			if (this.proc.exitCode !== null) this.#exitReason = reason;
		}
		// A command under the Linux subreaper is stopped without ever signalling
		// the subreaper politely: SIGTERM would end it, its orphaned descendants
		// would reparent to init, and the SIGKILL that follows would not find a
		// descendant that ignored SIGTERM. One stop sequence serves every kill
		// request; a hard request during its grace period ends the grace early.
		if (this.#subreaperStop) {
			if (gracefulMs !== undefined && gracefulMs < 0) this.#subreaperStop.escalate();
			return;
		}
		if (this.#hardKillTree && this.proc.exitCode === null && this.proc.signalCode === null) {
			let root: Process | null = null;
			try {
				root = Process.fromPid(this.proc.pid);
			} catch {
				// No usable native handle: the direct-signal fallback below still ends the subreaper.
			}
			if (root) {
				const { promise: escalated, resolve: escalate } = Promise.withResolvers<void>();
				const graceMs = gracefulMs === undefined ? 1000 : gracefulMs;
				if (graceMs < 0) escalate();
				// A stop that fails part-way (a native handle that cannot be used)
				// must not count as a finished termination: signal the subreaper directly.
				const stop = this.#stopSubreaperTree(root, graceMs, escalated).catch(() => this.#signalChild(graceMs));
				this.#subreaperStop = { escalate };
				this.#terminating = stop;
				return;
			}
		}
		if (
			this.proc.exitCode !== null &&
			this.#terminateGroup &&
			this.#openPipeReaders > 0 &&
			process.platform !== "win32"
		) {
			// Bun detached children are POSIX session/process-group leaders. If
			// the leader has exited, the native Process handle cannot rediscover
			// its PGID, but a pipe-holding descendant keeps that exact group alive.
			try {
				process.kill(-this.proc.pid, "SIGKILL");
			} catch {}
			this.#terminating = Promise.resolve();
			return;
		}
		if (this.proc.exitCode !== null && this.#windowsRootProcess && this.#openPipeReaders > 0) {
			// The retained handle keeps the dead root PID reserved, making the
			// Windows Toolhelp descendant walk identity-safe after root exit.
			this.#windowsRootProcess.killTree();
			this.#terminating = Promise.resolve();
			return;
		}
		if (!this.proc.killed) {
			const options =
				gracefulMs === undefined
					? this.#terminateGroup
						? { group: true }
						: undefined
					: { gracefulMs, group: this.#terminateGroup };
			this.#terminating = this.#terminateTree(options);
		}
	}

	/**
	 * Native tree termination. A native handle that cannot be resolved or used
	 * — the PID left the process table, or a `bun test --isolate` realm whose
	 * napi classes another realm superseded ("Value is not an instance of class
	 * `Process`") — must not leave the child running, so signal it directly.
	 */
	#terminateTree(options: ProcessTerminateOptions | undefined): Promise<boolean | void> {
		const gracefulMs = options?.gracefulMs ?? 1000;
		try {
			const root = this.#windowsRootProcess ?? Process.fromPid(this.proc.pid);
			if (root) return root.terminate(options).catch(() => this.#signalChild(gracefulMs));
		} catch {}
		return this.#signalChild(gracefulMs);
	}

	/** SIGTERM the child (its group when it leads one), then SIGKILL if it outlives `gracefulMs`. */
	async #signalChild(gracefulMs: number): Promise<void> {
		const signal = (name: NodeJS.Signals) => {
			try {
				if (this.#terminateGroup && process.platform !== "win32") process.kill(-this.proc.pid, name);
				else this.proc.kill(name);
			} catch {}
		};
		if (gracefulMs >= 0) {
			signal("SIGTERM");
			await Promise.race([this.proc.exited, Bun.sleep(gracefulMs)]);
		}
		if (this.proc.exitCode === null && this.proc.signalCode === null) signal("SIGKILL");
	}

	/**
	 * Stop a subreaper-supervised command: SIGTERM to each of the subreaper's
	 * children and their trees (never the subreaper itself), then, after
	 * `gracefulMs`, the subreaper's own exit, or `escalated`, the hard sweep.
	 * A negative `gracefulMs` skips the SIGTERM; zero sends it and sweeps at once.
	 * The subreaper stays alive through the grace period, so a descendant
	 * orphaned in it is still the subreaper's child when the sweep runs.
	 *
	 * A subreaper with no child has not launched the command yet (or the
	 * command has ended). It is looked at again while frozen with SIGSTOP and,
	 * when still childless, killed, so a command cancelled before its launch
	 * never starts. Freeze, kill and resume all go through `root`, the native
	 * handle pinned to the subreaper's identity, never through the numeric pid:
	 * once the subreaper has been reaped and its pid reused, they signal
	 * nothing. The resume runs on every way out of the frozen section,
	 * including a throw; it is a no-op on a killed subreaper. The grace timer is
	 * cleared as soon as the sequence moves on, so a finished stop never keeps
	 * the caller's process alive.
	 */
	async #stopSubreaperTree(root: Process, gracefulMs: number, escalated: Promise<void>): Promise<void> {
		let children = root.children();
		if (children.length === 0) {
			try {
				root.killTree(os.constants.signals.SIGSTOP);
				children = root.children();
				if (children.length === 0) {
					root.killTree(9);
					return;
				}
				// It launched the command just before the freeze: the first wave
				// goes to the snapshot taken while it cannot fork.
				for (const child of children) child.killTree(gracefulMs < 0 ? 9 : 15);
			} finally {
				root.killTree(os.constants.signals.SIGCONT);
			}
		} else {
			// The subreaper launches one command; once it has a child, no later launch can escape the snapshot.
			for (const child of children) child.killTree(gracefulMs < 0 ? 9 : 15);
		}
		if (gracefulMs >= 0) {
			const { promise: graceOver, resolve: endGrace } = Promise.withResolvers<void>();
			const graceTimer = setTimeout(endGrace, gracefulMs);
			try {
				await Promise.race([this.proc.exited, graceOver, escalated]);
			} finally {
				clearTimeout(graceTimer);
			}
		}
		await this.#hardKillSubreaperTree(root);
	}

	async #hardKillSubreaperTree(root: Process): Promise<void> {
		try {
			const deadline = Date.now() + SUBREAPER_KILL_WINDOW_MS;
			let emptySweeps = 0;
			while (emptySweeps < 2 && Date.now() < deadline) {
				const children = root.children();
				if (children.length === 0) {
					emptySweeps++;
				} else {
					emptySweeps = 0;
					for (const child of children) child.killTree(9);
				}
				if (emptySweeps < 2) await Bun.sleep(SUBREAPER_KILL_POLL_MS);
			}
		} finally {
			root.killTree(9);
		}
	}

	// ── Output helpers ───────────────────────────────────────────────────

	async #throwIfAborted(): Promise<void> {
		// A kill() issued before Bun reports the root's exit only records the
		// reason as pending; output readers that do not wait for exit must still see it.
		const exitReason = this.#exitReason ?? this.#exitReasonPending;
		if (!exitReason?.aborted) return;
		if (this.#terminating) await this.#terminating;
		throw exitReason;
	}

	async text(): Promise<string> {
		const p = this.#readStream(this.proc.stdout);
		if (this.#nothrow) return p;
		const [text] = await Promise.all([p, this.exitedCleanly]);
		await this.#throwIfAborted();
		return text;
	}

	/**
	 * Read a pipe fully, stopping early only at an explicit command deadline or abort.
	 */
	async #readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
		const reader = stream.getReader();
		this.#openPipeReaders++;
		this.#pipeReaders.add(reader);
		this.#syncAbortListeners();
		const dec = new TextDecoder();
		let out = "";
		try {
			for (;;) {
				if (this.#cutoff) {
					await reader.cancel().catch(() => {});
					break;
				}
				const r = await reader.read();
				if (r.done) break;
				out += dec.decode(r.value, { stream: true });
			}
		} catch {
			// A cancelled or failed read keeps whatever was already collected.
		}
		const tail = dec.decode();
		this.#pipeReaders.delete(reader);
		this.#openPipeReaders--;
		this.#syncAbortListeners();
		return out + tail;
	}

	async #readBytes(): Promise<Uint8Array<ArrayBuffer>> {
		const reader = this.proc.stdout.getReader();
		this.#openPipeReaders++;
		this.#pipeReaders.add(reader);
		this.#syncAbortListeners();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			for (;;) {
				if (this.#cutoff) {
					await reader.cancel().catch(() => {});
					break;
				}
				const r = await reader.read();
				if (r.done) break;
				chunks.push(r.value);
				length += r.value.byteLength;
			}
		} catch {
			// A cancelled or failed read keeps whatever was already collected.
		} finally {
			this.#pipeReaders.delete(reader);
			this.#openPipeReaders--;
			reader.releaseLock();
			this.#syncAbortListeners();
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}

	async #readOutputBytes(waitForCleanExit = false): Promise<Uint8Array<ArrayBuffer>> {
		const p = this.#readBytes();
		if (this.#nothrow) return p;
		const bytes = waitForCleanExit ? (await Promise.all([p, this.exitedCleanly]))[0] : await p;
		await this.#throwIfAborted();
		return bytes;
	}

	async blob(): Promise<Blob> {
		return new Blob([await this.#readOutputBytes(true)]);
	}

	async json(): Promise<unknown> {
		return JSON.parse(new TextDecoder().decode(await this.#readOutputBytes()));
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return (await this.#readOutputBytes()).buffer;
	}

	async bytes(): Promise<Uint8Array> {
		return this.#readOutputBytes();
	}

	// ── Wait ─────────────────────────────────────────────────────────────

	async wait(opts?: WaitOptions): Promise<ExecResult> {
		const { allowNonZero = false, allowAbort = false, stderr: stderrMode = "buffer" } = opts ?? {};
		const stderrChunks = this.#stderrChunks;
		if (stderrMode === "full" && !stderrChunks) {
			throw new Error('Full stderr capture must be requested when spawning the process (pass stderr: "full")');
		}

		const stdoutP = this.#readStream(this.proc.stdout);
		const stderrP =
			stderrMode === "full" && stderrChunks
				? this.#stderrDone.then(() => new TextDecoder().decode(Buffer.concat(stderrChunks)))
				: this.#stderrDone.then(() => this.#stderrTail);

		const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);

		let exitError: Exception | undefined;
		try {
			await this.#exited;
		} catch (err) {
			if (err instanceof Exception) exitError = err;
			else throw err;
		}
		this.#clearTimeout();
		if (!exitError) exitError = this.exitReason;
		if (!exitError && this.exitCode !== null && this.exitCode !== 0) {
			exitError = new NonZeroExitError(this.exitCode, this.#stderrTail);
		}

		// On abort/timeout, hold the result until the tree is actually gone: the
		// native terminate() is graceful-first, and reporting before it finishes
		// would leave timed-out descendants alive past the caller's budget.
		if (exitError?.aborted && this.#terminating) await this.#terminating;

		const exitCode = this.exitCode ?? (exitError && !exitError.aborted ? exitError.exitCode : null);
		const ok = exitCode === 0;

		if (exitError) {
			if ((exitError.aborted && !allowAbort) || (!exitError.aborted && !allowNonZero)) throw exitError;
		}

		return { stdout, stderr, exitCode, ok, exitError };
	}

	// ── Signal / timeout ─────────────────────────────────────────────────

	attachSignal(signal: AbortSignal): void {
		this.#exited.catch(() => {});
		let attached = false;
		const onAbort = () => {
			// The { once: true } listener has removed itself at this point.
			attached = false;
			const rootRunning = this.proc.exitCode === null && this.proc.signalCode === null;
			if (rootRunning || this.#openPipeReaders > 0) {
				this.#abortRegistrations?.delete(sync);
			}
			this.kill(new AbortError(signal.reason, "<cancelled>"));
			this.#cutoffOutput();
		};
		const sync = () => {
			const rootRunning = this.proc.exitCode === null && this.proc.signalCode === null;
			const active = rootRunning || this.#openPipeReaders > 0;
			if (signal.aborted) {
				if (active) onAbort();
				return;
			}
			if (active === attached) return;
			if (active) signal.addEventListener("abort", onAbort, { once: true });
			else signal.removeEventListener("abort", onAbort);
			attached = active;
		};
		(this.#abortRegistrations ??= new Set()).add(sync);
		if (signal.aborted) onAbort();
		else sync();
	}

	#syncAbortListeners(): void {
		if (!this.#abortRegistrations) return;
		for (const sync of this.#abortRegistrations) sync();
	}

	#cutoffOutput(): void {
		this.#cutoff = true;
		for (const reader of this.#pipeReaders) reader.cancel().catch(() => {});
	}

	#clearTimeout(): void {
		if (!this.#timeoutTimer) return;
		clearTimeout(this.#timeoutTimer);
		this.#timeoutTimer = undefined;
	}

	attachTimeout(ms: number): void {
		// Not skipped for a root Bun already reports as exited (`proc.killed`): it can
		// exit before spawn() returns, while a descendant still holds its pipes.
		if (ms <= 0) return;
		this.#exited.catch(() => {});
		// One unref'd deadline controls both termination and pipe collection.
		// A clean command clears it in wait(), so fast invocations do not hold
		// the event loop for the unused remainder.
		const timer = setTimeout(() => {
			// A detached group can remain alive after its leader exits. Only use
			// the dead-leader fallback while an inherited pipe proves that exact
			// group still has a live member; this avoids stale-PGID reuse.
			if (
				this.proc.exitCode === null ||
				(this.#openPipeReaders > 0 && (this.#terminateGroup || this.#windowsRootProcess))
			) {
				this.kill(new TimeoutError(ms, this.#stderrTail), -1);
			}
			this.#cutoffOutput();
		}, ms);
		timer.unref?.();
		this.#timeoutTimer = timer;
	}

	[Symbol.dispose](): void {
		if (this.proc.exitCode !== null) return;
		this.kill(new AbortError("process disposed", this.#stderrTail));
	}
}

// ── Spawn / exec ─────────────────────────────────────────────────────────────

/** Options for child spawn. Always pipes stdout/stderr. */
type ChildSpawnOptions<In extends InMask = InMask> = Omit<
	Spawn.SpawnOptions<In, "pipe", "pipe">,
	"stdout" | "stderr" | "detached"
> & {
	signal?: AbortSignal;
	detached?: boolean;
	/**
	 * On Linux, supervise the command from a child subreaper so descendants
	 * remain reachable after changing session and reparenting. Other platforms
	 * ignore this option. macOS process groups cannot retain a daemonized
	 * descendant that creates a new session and reparents to launchd.
	 */
	subreaper?: boolean;
	/** Expose and retain complete stderr for a later `wait({ stderr: "full" })`. */
	stderr?: "full" | null;
};

/**
 * How {@link spawnInternal} runs `cmd`: the argv and the options of its `Bun.spawn`, and the {@link ChildProcess} it
 * makes of the subprocess, with the deadline and the abort of `opts` attached.
 */
function spawnPlan<In extends InMask = InMask>(
	cmd: string[],
	opts: ChildSpawnOptions<In> | undefined,
	retainFullStderr: boolean,
): {
	argv: string[];
	options: Spawn.SpawnOptions<In, "pipe", "pipe">;
	start: (child: PipedSubprocess<In>) => ChildProcess<In>;
} {
	const { timeout = -1, signal, stderr, detached, subreaper = false, ...rest } = opts ?? {};
	const useSubreaper = subreaper && process.platform === "linux";
	// Bun.spawn's own default is the startup environment, which misses values
	// omp loads from its `.env` files into `Bun.env` afterwards.
	const commandEnv = rest.env ?? Bun.env;
	const options = {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		detached,
		...rest,
		env: useSubreaper
			? {
					...commandEnv,
					BUN_BE_BUN: "1",
					[LINUX_SUBREAPER_COMMAND_ENV]: JSON.stringify(cmd),
					[LINUX_SUBREAPER_BUN_BE_BUN_ENV]: commandEnv.BUN_BE_BUN,
				}
			: commandEnv,
	} as Spawn.SpawnOptions<In, "pipe", "pipe">;
	return {
		argv: useSubreaper ? [process.execPath, "-e", LINUX_SUBREAPER_SCRIPT] : cmd,
		options,
		start: child => {
			const cp = new ChildProcess(child, stderr === "full", retainFullStderr, detached === true, useSubreaper);
			if (signal) cp.attachSignal(signal);
			if (timeout > 0) cp.attachTimeout(timeout);
			return cp;
		},
	};
}

function spawnInternal<In extends InMask = InMask>(
	cmd: string[],
	opts: ChildSpawnOptions<In> | undefined,
	retainFullStderr: boolean,
): ChildProcess<In> {
	const plan = spawnPlan(cmd, opts, retainFullStderr);
	return plan.start(Bun.spawn(plan.argv, plan.options));
}

/** Spawn a child process with piped stdout/stderr. */
export function spawn<In extends InMask = InMask>(cmd: string[], opts?: ChildSpawnOptions<In>): ChildProcess<In> {
	return spawnInternal(cmd, opts, opts?.stderr === "full");
}

/** Options for exec. */
export interface ExecOptions extends Omit<ChildSpawnOptions, "stderr" | "stdin">, WaitOptions {
	input?: string | Buffer | Uint8Array;
	/**
	 * On Linux, run `cmd` as a tool process ({@link spawnToolProcess}): with OOM adjustment 1000 from its first
	 * instruction, which what it starts inherits, so the kernel prefers to kill it over this process when it picks one
	 * to kill for lack of memory; this process keeps its own value. One runtime start per call. A program that cannot
	 * exec fails with the error of that exec. Ignored elsewhere.
	 */
	toolOomScore?: boolean;
}

/** Spawn, wait, and return captured output. */
export async function exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
	const { toolOomScore, input, stderr, allowAbort, allowNonZero, ...spawnOpts } = opts ?? {};
	const stdin = typeof input === "string" ? Buffer.from(input) : input;
	const resolved: ChildSpawnOptions = stdin === undefined ? spawnOpts : { ...spawnOpts, stdin };
	const plan = spawnPlan(cmd, resolved, stderr === "full");
	const waitOptions: WaitOptions = { stderr, allowAbort, allowNonZero };
	const launched =
		toolOomScore && process.platform === "linux" ? await spawnToolLauncher(plan.argv, plan.options) : null;
	if (!launched) {
		using child = plan.start(Bun.spawn(plan.argv, plan.options));
		return await child.wait(waitOptions);
	}
	// The launcher's deadline and abort are the program's: it becomes the program.
	using launcher = plan.start(launched.proc);
	const settled = await settleToolLaunch(await launched.report, launched.proc, plan.options.detached, () =>
		launcher.exited.catch(() => {}),
	);
	// Ended before the exec by this call's deadline or abort: the call ends with that.
	if (settled === "ran" || launcher.exitReason?.aborted) return await launcher.wait(waitOptions);
	// It cannot run here.
	using child = plan.start(Bun.spawn(plan.argv, plan.options));
	return await child.wait(waitOptions);
}

// ── Signal combinators ───────────────────────────────────────────────────────

type SignalValue = AbortSignal | number | null | undefined;

/** Combine AbortSignals and timeout values into a single signal. */
export function combineSignals(...signals: SignalValue[]): AbortSignal | undefined {
	let timeout: number | undefined;

	let n = 0;
	for (let i = 0; i < signals.length; i++) {
		const s = signals[i];
		if (s instanceof AbortSignal) {
			if (s.aborted) return s;
			if (i !== n) signals[n] = s;
			n++;
		} else if (typeof s === "number" && s > 0) {
			timeout = timeout === undefined ? s : Math.min(timeout, s);
		}
	}
	if (timeout !== undefined) {
		signals[n] = AbortSignal.timeout(timeout);
		n++;
	}
	switch (n) {
		case 0:
			return undefined;
		case 1:
			return signals[0] as AbortSignal;
		default:
			return AbortSignal.any(signals.slice(0, n) as AbortSignal[]);
	}
}
