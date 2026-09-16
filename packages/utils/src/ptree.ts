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
const SUBREAPER_KILL_WINDOW_MS = 100;
const SUBREAPER_KILL_POLL_MS = 5;

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

/**
 * Exception for a command whose captured output reached `maxOutputBytes`.
 *
 * Counted as an abort: the command was stopped rather than allowed to finish,
 * so its output is not a result, and `wait()` holds the report until the tree
 * is gone like any other termination.
 */
export class OutputLimitError extends AbortError {
	constructor(limit: number, stderr: string) {
		super(new Error(`Captured output reached the ${limit} byte limit`), stderr);
	}
}

/**
 * The longest prefix of `text` that fits `budget` UTF-8 bytes, cut only between
 * whole code points.
 *
 * Slicing by string index would split a surrogate pair, and slicing the encoded
 * bytes would leave a partial sequence that decodes back to a replacement
 * character — larger than the byte it replaced.
 */
function truncateToUtf8Bytes(text: string, budget: number): string {
	if (budget <= 0) return "";
	if (Buffer.byteLength(text) <= budget) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char);
		if (bytes + size > budget) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}

// ── Wait / Exec types ────────────────────────────────────────────────────────

/** Options for waiting for process exit and capturing output. */
export interface WaitOptions {
	allowNonZero?: boolean;
	allowAbort?: boolean;
	/** `full` requires upfront capture; `exec` enables it, while direct `spawn` callers pass `stderr: "full"`. */
	stderr?: "full" | "buffer";
	/**
	 * Hard cap on captured stdout, in bytes.
	 *
	 * Enforced while reading, not after: past the cap the read stops and the
	 * process tree is terminated, so a command that streams without end cannot
	 * grow this process's memory first. The result then carries an
	 * `OutputLimitError` and stdout holds no more than `maxOutputBytes` bytes.
	 * Stderr needs no cap — it is drained into a bounded tail as it arrives.
	 */
	maxOutputBytes?: number;
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
	// Released once the command is finished with and the root is gone, not at root
	// exit: a pipe-holding descendant is precisely when an abort still has work to do.
	#signalDetach?: () => void;
	// Collection state, deliberately not folded into #openPipeReaders. That counter
	// means "a read is in flight", which is what proves a pipe's write end is still
	// held -- it says nothing about which process holds it, so it can never stand in
	// for the identity of a dead root's process group. These mean "this output has
	// been dealt with", which is what decides when the caller's abort listener may
	// go. Stdout counts as outstanding from spawn, because a caller can abort before
	// it ever starts reading: the root's exit is not the end of the command, and a
	// descendant can still hold stdout with stderr already closed.
	#stdoutCollected = false;
	#stderrCollected = false;
	#stderrStream?: ReadableStream<Uint8Array>;
	// Termination in flight after kill(); aborted exits await it before reporting.
	#terminating?: Promise<boolean | void>;
	// A hard subreaper sweep must remain authoritative across overlapping kill requests.
	#hardKillSweep?: Promise<void>;
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
			this.#stderrCollected = true;
			this.#releaseSignalIfDone();
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
		// An AbortSignal can race a timeout after its hard subreaper sweep has
		// started. Do not replace that sweep with a normal root termination: the
		// root must stay alive until adopted descendants have been collected.
		if (this.#hardKillSweep) return;
		if (gracefulMs !== undefined && gracefulMs < 0 && this.#hardKillTree && this.proc.exitCode === null) {
			// Keep the subreaper alive while descendants are killed. A single
			// killTree() snapshot can miss a worker whose parent exits during the
			// walk and reparents it to the subreaper after that root was enumerated.
			const root = Process.fromPid(this.proc.pid);
			if (root) {
				const sweep = this.#hardKillSubreaperTree(root).catch(e => void e);
				this.#hardKillSweep = sweep;
				this.#terminating = sweep;
				void sweep.finally(() => {
					if (this.#hardKillSweep === sweep) this.#hardKillSweep = undefined;
				});
				return;
			}
		}
		if (this.proc.exitCode !== null && this.#windowsRootProcess && this.#openPipeReaders > 0) {
			// The retained handle keeps the dead root PID reserved, making the
			// Windows Toolhelp descendant walk identity-safe after root exit.
			this.#windowsRootProcess.killTree();
			this.#terminating = Promise.resolve();
			return;
		}
		// Everything below signals a pid, so it may only run while that pid is still
		// the process we spawned. A root whose exit has been observed was reaped, and
		// from that moment its pid names nothing: the kernel may hand it to a stranger,
		// and `terminate()` would sweep that stranger's tree.
		//
		// A POSIX detached root is also its group's leader, so the group id was that
		// same pid, and the group outlives the leader while a descendant holds it. An
		// open pipe read does not make that id verifiable: it proves some writer still
		// holds the write end, not that the writer is still IN the original group. A
		// descendant that calls setsid (or setpgid) keeps the pipe while leaving the
		// group, which can leave the group empty, its id free and reusable by an
		// unrelated group -- so `kill(-pid)` after the root is gone can SIGKILL a
		// foreign group. Nothing available here distinguishes the two, so a dead root
		// signals nothing at all on POSIX.
		//
		// The caller is still released: the abort listener and the command deadline
		// resolve the drain cutoff, which ends the reads a descendant is holding open.
		// What is given up is reaping that descendant, and only where no ownership is
		// tracked -- `subreaper: true` retains it on Linux, the retained handle retains
		// it on Windows, and a live root is swept through its own tree below.
		if (!this.proc.killed && (this.proc.exitCode === null || this.#windowsRootProcess)) {
			const options =
				gracefulMs === undefined
					? this.#terminateGroup
						? { group: true }
						: undefined
					: { gracefulMs, group: this.#terminateGroup };
			const terminated = (this.#windowsRootProcess ?? Process.fromPid(this.proc.pid))
				?.terminate(options)
				?.catch(e => void e);
			// A group signal sent while the root is alive is the one that is provably
			// ours: the pid it names is still unreaped, so the group id cannot yet have
			// been recycled. `terminate()` resolves on the root's own exit, though, and
			// `wait()` promises the caller a signalled tree is gone before it reports,
			// so hold until the group has emptied.
			this.#terminating =
				terminated && this.#terminateGroup && process.platform !== "win32"
					? terminated.then(() => this.#awaitGroupTeardown(this.proc.pid))
					: terminated;
		}
	}

	/**
	 * Wait until a group signalled through a live root has no member left, bounded.
	 *
	 * Terminating the root only queues the signal its group members still have to be
	 * torn down by, and `wait()` promises the caller that an aborted tree is gone
	 * before it reports. Resolving on the root's own exit broke that promise: on a
	 * loaded machine the descendant was still scheduled when the caller looked.
	 *
	 * Probing at all is safe only because the group was signalled while its leader
	 * was still unreaped, so the id is this command's own group and not a recycled
	 * one. `kill(-pgid, 0)` is the only portable probe, and a zombie still answers
	 * it, so the wait ends on the bound rather than hanging on a descendant nobody
	 * has reaped yet. Reaching the bound is still correct: by then the kill has been
	 * delivered, and a zombie has already exited.
	 */
	async #awaitGroupTeardown(pgid: number): Promise<void> {
		const deadline = Date.now() + SUBREAPER_KILL_WINDOW_MS;
		for (;;) {
			try {
				process.kill(-pgid, 0);
			} catch {
				return;
			}
			if (Date.now() >= deadline) return;
			await Bun.sleep(SUBREAPER_KILL_POLL_MS);
		}
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
	 * Read a pipe, stopping early at an explicit command deadline or at
	 * `maxOutputBytes` of captured output.
	 *
	 * The cap is measured on the decoded result, not on the bytes that arrived:
	 * invalid input expands to three-byte replacement characters, so counting
	 * input would let a hostile stream return three times the promised bound. A
	 * sequence the cap cuts in half is likewise never flushed as a replacement
	 * character past the budget — the trailing partial code point is dropped
	 * instead, so the returned string always re-encodes to at most the cap.
	 *
	 * Dropping it is not silent. The decoder's leftover at EOF counts toward the
	 * limit like any other byte, so output that only fits once that remainder is
	 * discarded is reported with an `OutputLimitError` rather than returned as a
	 * whole answer that happens to be short.
	 *
	 * Reaching the cap releases the pipe reads as a deadline does. The kill
	 * cannot always reach a descendant holding stderr, and the command may have
	 * no deadline behind it, so nothing else would end that read.
	 */
	async #readStream(stream: ReadableStream<Uint8Array>, maxOutputBytes?: number): Promise<string> {
		this.#openPipeReaders++;
		const reader = stream.getReader();
		const dec = new TextDecoder();
		let out = "";
		let captured = 0;
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
				// One chunk at a time, so the decode is bounded by the pipe buffer
				// rather than by however much the command decides to send.
				const piece = dec.decode(chunk.r.value, { stream: true });
				if (maxOutputBytes === undefined) {
					out += piece;
					continue;
				}
				const pieceBytes = Buffer.byteLength(piece);
				if (captured + pieceBytes <= maxOutputBytes) {
					out += piece;
					captured += pieceBytes;
					continue;
				}
				// Keep the allowance exactly, then stop the command rather than the
				// buffer: whatever is still coming would only grow this heap.
				out += truncateToUtf8Bytes(piece, maxOutputBytes - captured);
				captured = maxOutputBytes;
				await reader.cancel().catch(() => {});
				// Same hard path a deadline takes, so a descendant that left the
				// original group is swept rather than left running.
				this.kill(new OutputLimitError(maxOutputBytes, this.#stderrTail), -1);
				// A descendant the kill cannot reach still holds stderr, and this
				// command may have no deadline behind it, so nothing else would ever
				// end that read: release the pipes here as a deadline would.
				this.#resolveDrainCutoff();
				break;
			}
		} catch {
			// A cancelled or failed read keeps whatever was already collected.
		}
		this.#openPipeReaders--;
		if (stream === this.proc.stdout) this.#stdoutCollected = true;
		this.#releaseSignalIfDone();
		const tail = dec.decode();
		if (maxOutputBytes === undefined || captured + Buffer.byteLength(tail) <= maxOutputBytes) return out + tail;
		// The decoder was still holding an incomplete sequence at EOF and flushing
		// it as U+FFFD crosses the cap. Dropping it quietly would report a bounded
		// read as a complete one, so the tail reaches the limit like any other
		// byte: the caller is told the output was cut, not handed a short answer
		// that looks whole.
		const bounded = out + truncateToUtf8Bytes(tail, maxOutputBytes - captured);
		this.kill(new OutputLimitError(maxOutputBytes, this.#stderrTail), -1);
		this.#resolveDrainCutoff();
		return bounded;
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
			this.#stdoutCollected = true;
			this.#releaseSignalIfDone();
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
		const { allowNonZero = false, allowAbort = false, stderr: stderrMode = "buffer", maxOutputBytes } = opts ?? {};
		const stderrChunks = this.#stderrChunks;
		if (stderrMode === "full" && !stderrChunks) {
			throw new Error('Full stderr capture must be requested when spawning the process (pass stderr: "full")');
		}

		const stdoutP = this.#readStream(this.proc.stdout, maxOutputBytes);
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

	/**
	 * Honor `signal` for as long as this command is still being collected.
	 *
	 * The listener deliberately outlives the root's exit: a detached group
	 * survives its leader while a descendant still holds the pipes, and that is
	 * exactly when an abort still has work to do. Detaching at root exit left the
	 * abort with nothing to cancel, so the caller waited out the command deadline
	 * — or, with no deadline configured, never returned at all. It is released
	 * once the output has been collected and the root is gone, so nothing keeps
	 * listening on the caller's signal.
	 *
	 * No escalation belongs here: a live root keeps the graceful termination an
	 * abort has always given it, and a root that is already gone is not signalled
	 * at all -- releasing the pipe reads is the whole of what an abort can do to a
	 * descendant whose ownership can no longer be proven.
	 */
	attachSignal(signal: AbortSignal): void {
		const onAbort = () => {
			this.kill(new AbortError(signal.reason, "<cancelled>"));
			// Nothing else ends reads a descendant is holding open, so a tree the
			// kill could not reach would strand the caller here.
			this.#resolveDrainCutoff();
		};
		if (signal.aborted) return void onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		this.#signalDetach = () => {
			this.#signalDetach = undefined;
			signal.removeEventListener("abort", onAbort);
		};
		this.#exited.catch(() => {}).finally(() => this.#releaseSignalIfDone());
	}

	/**
	 * Release the caller's abort listener once nothing an abort could act on is
	 * left: the root is gone and both streams have been dealt with.
	 *
	 * Root exit alone is not enough. A descendant can hold stdout open with stderr
	 * already closed, and a caller that has not started collecting yet can abort
	 * after that -- which is exactly the case a reader-count test mistook for a
	 * finished command.
	 */
	#releaseSignalIfDone(): void {
		if (this.#stdoutCollected && this.#stderrCollected && this.proc.exitCode !== null) this.#signalDetach?.();
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
			// A pipe-holding descendant can outlive its root, and the deadline is
			// then the only thing that ends the command: record it as the reason
			// even though a reaped root's tree can no longer be signalled safely.
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
		// Disposal ends the command whether or not anything read it, so a handle
		// whose stdout was never collected cannot leave a listener on the signal.
		this.#stdoutCollected = true;
		this.#stderrCollected = true;
		if (this.proc.exitCode !== null) return void this.#signalDetach?.();
		this.kill(new AbortError("process disposed", this.#stderrTail));
		this.#signalDetach?.();
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
	 *
	 * It is also the only way a descendant that outlives its root is reaped on
	 * POSIX. Once the root has exited it has been reaped, so neither its pid nor
	 * the group id that pid named can be shown to still be this command's, and a
	 * kill aimed at either could reach a stranger that inherited the number. Such
	 * a command is ended by releasing its pipe reads and nothing is signalled, so
	 * a descendant holding them is left running unless a subreaper adopted it.
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
	const { input, stderr, allowAbort, allowNonZero, maxOutputBytes, ...spawnOpts } = opts ?? {};
	const stdin = typeof input === "string" ? Buffer.from(input) : input;
	const resolved: ChildSpawnOptions = stdin === undefined ? spawnOpts : { ...spawnOpts, stdin };
	using child = spawnInternal(cmd, resolved, stderr === "full");
	return await child.wait({ stderr, allowAbort, allowNonZero, maxOutputBytes });
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
