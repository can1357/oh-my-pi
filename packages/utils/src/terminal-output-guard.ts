/**
 * Keep unmanaged writes and inherited child stdout/stderr off an owned TUI.
 * The renderer uses the saved stdout descriptor; ordinary fd 1/2 writes go
 * to the process log until the terminal is released. Piped output and a
 * separately redirected stderr are left alone.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tty from "node:tty";
import { acquireProcessLogTarget, onProcessLogTargetChanged, type ProcessLogTargetLease } from "./logger/process-log";

export interface LibcFdOps {
	dup(fd: number): number;
	dup2(oldFd: number, newFd: number): number;
	fcntlSetFd(fd: number, flags: number): number;
}

const F_SETFD = 2;
const FD_CLOEXEC = 1;

/**
 * Mark a saved/render descriptor close-on-exec: dup() clears the flag, and an
 * exec'd child inheriting a writable terminal fd would bypass the isolation.
 * Skipped on Apple arm64: darwin's variadic ABI stack-passes fcntl's third
 * argument while the fixed three-arg FFI declaration passes it in a register,
 * so F_SETFD would read the wrong flags there. Everywhere else the integer
 * triple lands in the regular argument registers.
 */
export function markTerminalFdCloexec(ops: LibcFdOps, fd: number): void {
	if (process.platform === "darwin" && process.arch === "arm64") return;
	ops.fcntlSetFd(fd, FD_CLOEXEC);
}

let libcFdOpsCache: LibcFdOps | null | undefined;
let savedStdoutFd: number | null = null;
let savedStderrFd: number | null = null;
let redirectTarget: string | undefined;
let canonicalLease: ProcessLogTargetLease | undefined;
// Nested acquisitions share one isolated state; only the final release (or a
// forced restore on a fatal path) puts the terminal descriptors back.
let activeSuppressions = 0;

type WriteCallback = (error?: Error | null) => void;

function redirectedWrite(
	fd: number,
	chunk: string | Uint8Array,
	encodingOrCallback?: BufferEncoding | WriteCallback,
	callback?: WriteCallback,
	reportStreamError?: (error: Error) => void,
): boolean {
	const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
	const bytes =
		typeof chunk === "string"
			? Buffer.from(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8")
			: chunk;
	let offset = 0;
	try {
		while (offset < bytes.byteLength) {
			const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
			if (written === 0) throw new Error("Cannot write isolated terminal output");
			offset += written;
		}
	} catch (err) {
		// Deliver log-write failures (ENOSPC/EIO/...) asynchronously like the
		// platform streams do, so completion callbacks see the error instead
		// of a synchronous throw escaping write(). Callback-free callers get
		// the stream error path too: a sync throw from an incidental
		// diagnostic write would trigger fatal teardown exactly when the
		// log storage failed.
		const error = err instanceof Error ? err : new Error(String(err));
		if (done) {
			queueMicrotask(() => done(error));
			return false;
		}
		if (reportStreamError) {
			reportStreamError(error);
			return false;
		}
		throw err;
	}
	if (done) queueMicrotask(() => done(null));
	return true;
}

const REDIRECTED_WRITE_ERROR = Symbol("omp.redirectedWriteError");

/**
 * Whether an error came from the guard's redirected log target rather than
 * the terminal stream itself. Consumers that treat stdout errors as terminal
 * disconnects use this to leave a healthy terminal alone when only the log
 * storage (ENOSPC/EIO) failed.
 */
export function isRedirectedWriteError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { [REDIRECTED_WRITE_ERROR]?: boolean })[REDIRECTED_WRITE_ERROR] === true
	);
}

interface GuardedWrite {
	(chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean;
	__ompGuardProxy?: boolean;
}

/**
 * Replace `stream.write` with a stable proxy once, at module load. Extensions
 * that cache `process.stdout.write.bind(process.stdout)` before the guard
 * activates keep calling this proxy, which routes through the (dup2-redirected)
 * descriptor while suppression is active and defers to the platform writer
 * otherwise. Property swaps at activation time cannot reach those cached
 * bound references.
 */
function installStreamWriteProxy(stream: NodeJS.WriteStream, fd: 1 | 2): void {
	const descriptor = Object.getOwnPropertyDescriptor(stream, "write");
	if (!descriptor || typeof descriptor.value !== "function") return;
	const originalWrite = descriptor.value.bind(stream) as GuardedWrite;
	if (originalWrite.__ompGuardProxy) return;
	const proxy: GuardedWrite = (chunk, encodingOrCallback, callback) => {
		const redirected = fd === 1 ? savedStdoutFd !== null : savedStderrFd !== null;
		if (redirected) {
			return redirectedWrite(fd, chunk, encodingOrCallback, callback, error => {
				// No completion callback: report through the stream's
				// asynchronous error path, as the platform writer would. The
				// marker lets terminal-disconnect consumers tell log-storage
				// failures from a terminal that actually died.
				Object.defineProperty(error, REDIRECTED_WRITE_ERROR, { value: true });
				queueMicrotask(() => stream.emit("error", error));
			});
		}
		return originalWrite(chunk, encodingOrCallback, callback);
	};
	proxy.__ompGuardProxy = true;
	Object.defineProperty(stream, "write", { ...descriptor, value: proxy });
}

installStreamWriteProxy(process.stdout, 1);
installStreamWriteProxy(process.stderr, 2);

/**
 * Load dup/dup2 from libc, or null when no candidate soname resolves.
 * Darwin: dyld resolves libSystem from the shared cache. Linux: glibc
 * first, then the generic soname for musl-style layouts.
 */
export function tryLibcFdOps(): LibcFdOps | null {
	if (libcFdOpsCache !== undefined) return libcFdOpsCache;
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		try {
			const libc = dlopen(candidate, {
				dup: { args: [FFIType.i32], returns: FFIType.i32 },
				dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				// fcntl is variadic in C, but every supported ABI passes the fixed
				// (fd, F_SETFD, flags) integer triple in the regular argument
				// registers, so a three-arg declaration is safe for this use.
				fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			}).symbols;
			libcFdOpsCache = {
				dup: libc.dup,
				dup2: libc.dup2,
				fcntlSetFd: (fd, flags) => libc.fcntl(fd, F_SETFD, flags),
			};
			return libcFdOpsCache;
		} catch {
			// Try the next libc soname.
		}
	}
	libcFdOpsCache = null;
	return null;
}

function libcFdOps(): LibcFdOps {
	const ops = libcFdOpsCache ?? tryLibcFdOps();
	if (!ops) {
		throw new Error("Cannot isolate terminal output: libc descriptor operations are unavailable");
	}
	return ops;
}

/**
 * Whether fd 2 currently writes to the same terminal file as fd 1 — the one
 * predicate both the unified guard and the legacy stderr wrapper consult.
 * Total on purpose: a stat failure or non-tty end means "not shared", never a
 * throw into a suppression entry point.
 */
export function stderrSharesStdoutTerminal(): boolean {
	if (!tty.isatty(1) || !tty.isatty(2)) return false;
	try {
		const stdoutStat = fs.fstatSync(1);
		const stderrStat = fs.fstatSync(2);
		return stdoutStat.dev === stderrStat.dev && stdoutStat.ino === stderrStat.ino;
	} catch {
		return false;
	}
}

/** Return the renderer's private stdout fd, or null for non-Unix/non-TTY output. */
export function suppressTerminalOutput(): number | null {
	if (savedStdoutFd !== null) {
		activeSuppressions++;
		return savedStdoutFd;
	}
	if (process.platform === "win32" || !tty.isatty(1)) return null;
	// Initialize Bun's cached streams before replacing the descriptors. Other
	// TUI code must continue to see a terminal, not lazily construct file streams.
	void process.stdout;
	void process.stderr;
	const redirectStderr = stderrSharesStdoutTerminal();
	const libc = libcFdOps();
	const lease = redirectTarget === undefined ? acquireProcessLogTarget() : undefined;
	const redirectPath = redirectTarget ?? lease!.path;
	let redirectFd = -1;
	let stdoutFd = -1;
	let stderrFd = -1;
	try {
		fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
		redirectFd = fs.openSync(redirectPath, "a", 0o600);
		stdoutFd = libc.dup(1);
		if (stdoutFd === -1) throw new Error("Cannot save terminal stdout");
		markTerminalFdCloexec(libc, stdoutFd);
		if (redirectStderr) {
			stderrFd = libc.dup(2);
			if (stderrFd === -1) throw new Error("Cannot save terminal stderr");
			markTerminalFdCloexec(libc, stderrFd);
			if (libc.dup2(redirectFd, 2) === -1) throw new Error("Cannot redirect terminal stderr");
		}
		if (libc.dup2(redirectFd, 1) === -1) throw new Error("Cannot redirect terminal stdout");
		// Stream writes route through the module-load proxies above: once the
		// descriptors are swapped, both direct and pre-bound stream writers go
		// to the redirect target.
		savedStdoutFd = stdoutFd;
		savedStderrFd = stderrFd === -1 ? null : stderrFd;
		activeSuppressions = 1;
		canonicalLease = lease;
		return stdoutFd;
	} catch (err) {
		if (stdoutFd !== -1) {
			if (libc.dup2(stdoutFd, 1) === -1) savedStdoutFd = stdoutFd;
			else fs.closeSync(stdoutFd);
		}
		if (stderrFd !== -1) {
			if (libc.dup2(stderrFd, 2) === -1) savedStderrFd = stderrFd;
			else fs.closeSync(stderrFd);
		}
		// A failed rollback remains owned and retryable; never retire its sink
		// while a descriptor may still be routed there.
		if (savedStdoutFd !== null || savedStderrFd !== null) canonicalLease = lease;
		else lease?.release();
		throw err;
	} finally {
		if (redirectFd !== -1) fs.closeSync(redirectFd);
	}
}

/** Restore both descriptors before external programs, suspend, or fatal reports. */
export function restoreTerminalOutput(force = false): void {
	if (savedStdoutFd === null && savedStderrFd === null) return;
	if (!force && activeSuppressions > 1) {
		activeSuppressions--;
		return;
	}
	activeSuppressions = 0;
	if (savedStdoutFd === null && savedStderrFd === null) return;
	const libc = libcFdOps();
	// Keep a failed restoration retryable. Restore stderr even if stdout fails.
	const stdoutRestored = savedStdoutFd === null || libc.dup2(savedStdoutFd, 1) !== -1;
	const stderrRestored = savedStderrFd === null || libc.dup2(savedStderrFd, 2) !== -1;
	if (stdoutRestored && savedStdoutFd !== null) {
		fs.closeSync(savedStdoutFd);
		savedStdoutFd = null;
	}
	if (stderrRestored && savedStderrFd !== null) {
		fs.closeSync(savedStderrFd);
		savedStderrFd = null;
	}
	if (!stdoutRestored || !stderrRestored) throw new Error("Cannot restore terminal output descriptors");
	canonicalLease?.release();
	canonicalLease = undefined;
	for (const listener of [...restoreListeners]) {
		try {
			listener();
		} catch {
			// A listener failing must not break the release for others.
		}
	}
}

const restoreListeners = new Set<() => void>();

/**
 * Be notified whenever a restore completes (final refcount release or forced).
 * The compatibility stderr guard uses this to flush a release that arrived
 * while this guard held the descriptors.
 */
export function onTerminalOutputRestored(listener: () => void): void {
	restoreListeners.add(listener);
}

/** Give a private stream its own descriptor; it must never own the guard's saved fd. */
export function duplicateTerminalOutput(): number {
	if (savedStdoutFd === null) throw new Error("Terminal output is not isolated");
	const ops = libcFdOps();
	const fd = ops.dup(savedStdoutFd);
	if (fd === -1) throw new Error("Cannot duplicate private terminal output");
	markTerminalFdCloexec(ops, fd);
	return fd;
}

/** Whether fd 1 is currently redirected away from the terminal. */
export function isTerminalOutputSuppressed(): boolean {
	return savedStdoutFd !== null;
}

/**
 * Whether this guard actually saved and owns fd 2. Suppression can be
 * active while fd 2 was left untouched (stderr did not share the terminal),
 * so callers deciding whether the unified guard fences stderr check this,
 * not `isTerminalOutputSuppressed()`.
 */
export function terminalStderrIsGuarded(): boolean {
	return savedStderrFd !== null;
}

/** Explicitly route output to a caller-owned sink, which manages its own watch. */
export function setTerminalOutputRedirectTarget(logPath: string): void {
	if (repointTerminalOutput(logPath)) {
		redirectTarget = logPath;
		canonicalLease?.release();
		canonicalLease = undefined;
	}
}

onProcessLogTargetChanged(logPath => {
	if (canonicalLease && redirectTarget === undefined && !repointTerminalOutput(logPath)) {
		throw new Error("Cannot redirect terminal output to the canonical process log");
	}
});

function repointTerminalOutput(logPath: string): boolean {
	if (savedStdoutFd === null && savedStderrFd === null) return true;
	let fd: number;
	try {
		fd = fs.openSync(logPath, "a", 0o600);
	} catch {
		return false;
	}
	try {
		const libc = libcFdOps();
		const stdoutRedirected = savedStdoutFd === null || libc.dup2(fd, 1) !== -1;
		const stderrRedirected = savedStderrFd === null || libc.dup2(fd, 2) !== -1;
		return stdoutRedirected && stderrRedirected;
	} finally {
		fs.closeSync(fd);
	}
}
