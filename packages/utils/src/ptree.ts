/**
 * Process tree management utilities for Bun subprocesses.
 *
 * - Track managed child processes for cleanup on shutdown (postmortem).
 * - Drain stdout/stderr to avoid subprocess pipe deadlocks.
 * - Cross-platform tree kill for process groups (Windows taskkill, Unix -pid).
 * - Convenience helpers: captureText / execText, AbortSignal, timeouts.
 */

import { Process } from "@oh-my-pi/pi-natives";
import type { Spawn, Subprocess } from "bun";

type InMask = "pipe" | "ignore" | Buffer | Uint8Array | null;

/** A Bun subprocess with stdout/stderr always piped (stdin may vary). */
type PipedSubprocess<In extends InMask = InMask> = Subprocess<In, "pipe", "pipe">;

const LINUX_SUBREAPER_COMMAND_ENV = "OMP_PTREE_SUBREAPER_COMMAND";
const LINUX_SUBREAPER_BUN_BE_BUN_ENV = "OMP_PTREE_SUBREAPER_BUN_BE_BUN";

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
	// Pipe reads race this cutoff only when attachTimeout() configures a
	// command deadline. Untimed commands preserve complete EOF-based capture.
	#drainCutoff: Promise<void>;
	#resolveDrainCutoff: () => void;
	#timeoutTimer?: NodeJS.Timeout;
	#stderrStream?: ReadableStream<Uint8Array>;
	// Termination in flight after kill(); aborted exits await it before reporting.
	#terminating?: Promise<boolean | void>;
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
		const drainCutoff = Promise.withResolvers<void>();
		this.#drainCutoff = drainCutoff.promise;
		this.#resolveDrainCutoff = drainCutoff.resolve;
		// The cutoff remains pending for untimed commands, preserving complete
		// EOF-based capture. attachTimeout() resolves it at the command deadline.

		const pipeCutoff = this.#drainCutoff;
		this.#stderrDone = (async () => {
			const reader = stderrStream.getReader();
			try {
				for (;;) {
					const chunk = await Promise.race([
						reader.read().then(r => ({ cutoff: false as const, r })),
						pipeCutoff.then(() => ({ cutoff: true as const })),
					]);
					if (chunk.cutoff) {
						await reader.cancel().catch(() => {});
						break;
					}
					if (chunk.r.done) break;
					this.#stderrChunks?.push(chunk.r.value);
					this.#stderrTail += dec.decode(chunk.r.value, { stream: true });
					trim();
				}
			} catch {}
			this.#openPipeReaders--;
			this.#stderrTail += dec.decode();
			trim();
		})();

		proc.exited
			.catch(() => null)
			.then(async exitCode => {
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
		if (gracefulMs !== undefined && gracefulMs < 0 && this.#hardKillTree && this.proc.exitCode === null) {
			// terminate() sends its polite wave to the root before rebuilding the
			// hard-kill tree. A subreaper root can die in that gap and release its
			// adopted descendants, so snapshot and hard-kill the live tree first.
			const root = Process.fromPid(this.proc.pid);
			if (root) {
				root.killTree(9);
				this.#terminating = Promise.resolve();
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
			this.#terminating = (this.#windowsRootProcess ?? Process.fromPid(this.proc.pid))
				?.terminate(options)
				?.catch(e => void e);
		}
	}

	// ── Output helpers ───────────────────────────────────────────────────

	async #throwIfAborted(): Promise<void> {
		const exitReason = this.exitReason;
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
	 * Read a pipe fully, stopping early only at an explicit command deadline.
	 */
	async #readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
		this.#openPipeReaders++;
		const reader = stream.getReader();
		const dec = new TextDecoder();
		let out = "";
		try {
			for (;;) {
				const chunk = await Promise.race([
					reader.read().then(r => ({ cutoff: false as const, r })),
					this.#drainCutoff.then(() => ({ cutoff: true as const })),
				]);
				if (chunk.cutoff) {
					await reader.cancel().catch(() => {});
					break;
				}
				if (chunk.r.done) break;
				out += dec.decode(chunk.r.value, { stream: true });
			}
		} catch {
			// A cancelled or failed read keeps whatever was already collected.
		}
		this.#openPipeReaders--;
		return out + dec.decode();
	}

	async #readBytes(): Promise<Uint8Array> {
		const reader = this.proc.stdout.getReader();
		this.#openPipeReaders++;
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			for (;;) {
				const chunk = await Promise.race([
					reader.read().then(r => ({ cutoff: false as const, r })),
					this.#drainCutoff.then(() => ({ cutoff: true as const })),
				]);
				if (chunk.cutoff) {
					await reader.cancel().catch(() => {});
					break;
				}
				if (chunk.r.done) break;
				chunks.push(chunk.r.value);
				length += chunk.r.value.byteLength;
			}
		} catch {
			// A cancelled or failed read keeps whatever was already collected.
		} finally {
			this.#openPipeReaders--;
			reader.releaseLock();
		}

		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}

	async #readOutputBytes(waitForCleanExit = false): Promise<Uint8Array> {
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
		return (await this.#readOutputBytes()).buffer as ArrayBuffer;
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
		const onAbort = () => this.kill(new AbortError(signal.reason, "<cancelled>"));
		if (signal.aborted) return void onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		this.#exited.catch(() => {}).finally(() => signal.removeEventListener("abort", onAbort));
	}

	#clearTimeout(): void {
		if (!this.#timeoutTimer) return;
		clearTimeout(this.#timeoutTimer);
		this.#timeoutTimer = undefined;
	}

	attachTimeout(ms: number): void {
		if (ms <= 0 || this.proc.killed) return;
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
			this.#resolveDrainCutoff();
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

function spawnInternal<In extends InMask = InMask>(
	cmd: string[],
	opts: ChildSpawnOptions<In> | undefined,
	retainFullStderr: boolean,
): ChildProcess<In> {
	const { timeout = -1, signal, stderr, detached, subreaper = false, ...rest } = opts ?? {};
	const useSubreaper = subreaper && process.platform === "linux";
	const commandEnv = rest.env ?? Bun.env;
	const child = Bun.spawn(useSubreaper ? [process.execPath, "-e", LINUX_SUBREAPER_SCRIPT] : cmd, {
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
			: rest.env,
	});
	const cp = new ChildProcess(child, stderr === "full", retainFullStderr, detached === true, useSubreaper);
	if (signal) cp.attachSignal(signal);
	if (timeout > 0) cp.attachTimeout(timeout);
	return cp;
}

/** Spawn a child process with piped stdout/stderr. */
export function spawn<In extends InMask = InMask>(cmd: string[], opts?: ChildSpawnOptions<In>): ChildProcess<In> {
	return spawnInternal(cmd, opts, opts?.stderr === "full");
}

/** Options for exec. */
export interface ExecOptions extends Omit<ChildSpawnOptions, "stderr" | "stdin">, WaitOptions {
	input?: string | Buffer | Uint8Array;
}

/** Spawn, wait, and return captured output. */
export async function exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
	const { input, stderr, allowAbort, allowNonZero, ...spawnOpts } = opts ?? {};
	const stdin = typeof input === "string" ? Buffer.from(input) : input;
	const resolved: ChildSpawnOptions = stdin === undefined ? spawnOpts : { ...spawnOpts, stdin };
	using child = spawnInternal(cmd, resolved, stderr === "full");
	return await child.wait({ stderr, allowAbort, allowNonZero });
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
