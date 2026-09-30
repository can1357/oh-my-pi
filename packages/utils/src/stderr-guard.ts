/**
 * Terminal stderr guard: keeps unmanaged fd-2 writes off the terminal while a
 * TUI owns the viewport.
 *
 * Native runtimes and libraries can write directly to file descriptor 2 at
 * arbitrary times. Examples include macOS libmalloc diagnostics and Bun HTTP
 * decompression diagnostics on Linux. Those bytes bypass the renderer and
 * paint straight into the viewport.
 *
 * While the TUI owns the terminal, dup fd 2 aside and dup2 a redirect target
 * over it; restore the saved fd whenever terminal ownership is released
 * (external editor, Ctrl+Z suspend, shutdown, crash restore). This mirrors
 * openai/codex#24459, but redirects to the omp log file instead of /dev/null
 * so diagnostics stay greppable and Bun native-crash reports (which abort
 * before any JS cleanup can restore fd 2) are preserved.
 *
 * Only dup/dup2 go through bun:ffi. fcntl is deliberately avoided: it is
 * variadic, and the arm64-darwin ABI passes variadic arguments on the stack,
 * so a fixed-arity FFI signature would read garbage for the third argument.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogPath } from "./dirs";

const STDOUT_FILENO = 1;
const STDERR_FILENO = 2;

interface LibcFdOps {
	dup(fd: number): number;
	dup2(oldFd: number, newFd: number): number;
}

let libcFdOpsCache: LibcFdOps | null | undefined;

function libcFdOps(): LibcFdOps | null {
	if (libcFdOpsCache !== undefined) return libcFdOpsCache;
	libcFdOpsCache = null;
	if (process.platform === "win32") return null;
	// Darwin: dyld resolves libSystem from the shared cache. Linux: glibc
	// first, then the generic soname for musl-style layouts.
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		try {
			const libc = dlopen(candidate, {
				dup: { args: [FFIType.i32], returns: FFIType.i32 },
				dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			});
			libcFdOpsCache = libc.symbols;
			return libcFdOpsCache;
		} catch {
			// Try the next candidate; the guard stays inert if none load.
		}
	}
	return libcFdOpsCache;
}

/**
 * True when fd 2 writes would land on the same terminal the TUI paints to:
 * both stdout and stderr are ttys backed by the same device file. A stderr
 * the user already redirected (`2>file`, `2>/dev/null`, a different tty) must
 * keep flowing untouched.
 */
function stderrSharesStdoutTerminal(): boolean {
	if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
	try {
		const stdoutStat = fs.fstatSync(STDOUT_FILENO);
		const stderrStat = fs.fstatSync(STDERR_FILENO);
		return stdoutStat.dev === stderrStat.dev && stdoutStat.ino === stderrStat.ino;
	} catch {
		return false;
	}
}

/** Saved dup of the real stderr while suppression is active, else null. */
let savedStderrFd: number | null = null;

/** Newest log file the guard knows about; see {@link setStderrRedirectTarget}. */
let redirectTarget: string | null = null;

export interface SuppressTerminalStderrOptions {
	/**
	 * Redirect target path; defaults to the log file the rotating sink last
	 * reported (see {@link setStderrRedirectTarget}), then today's omp log
	 * file, then /dev/null.
	 */
	redirectPath?: string;
	/** Bypass the same-terminal gate. Tests only. */
	force?: boolean;
}

/**
 * Redirect fd 2 away from the terminal while the TUI owns the viewport.
 * Returns true when suppression is (already) active. No-op — returning
 * false — when stderr does not target the stdout terminal or when libc fd
 * operations are unavailable.
 */
export function suppressTerminalStderr(options?: SuppressTerminalStderrOptions): boolean {
	if (savedStderrFd !== null) return true;
	if (!options?.force && !stderrSharesStdoutTerminal()) return false;
	const libc = libcFdOps();
	if (!libc) return false;

	let redirectFd: number;
	try {
		const redirectPath = options?.redirectPath ?? redirectTarget ?? getLogPath();
		// getLogsDir() only computes the path; the logger creates it lazily, so
		// on a fresh profile ~/.omp/logs may not exist yet. Create it here so
		// diagnostics land in the log instead of falling through to /dev/null.
		fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
		redirectFd = fs.openSync(redirectPath, "a");
		redirectTarget = redirectPath;
	} catch {
		try {
			redirectFd = fs.openSync("/dev/null", "w");
		} catch {
			return false;
		}
	}

	const saved = libc.dup(STDERR_FILENO);
	if (saved === -1) {
		fs.closeSync(redirectFd);
		return false;
	}
	if (libc.dup2(redirectFd, STDERR_FILENO) === -1) {
		fs.closeSync(redirectFd);
		fs.closeSync(saved);
		return false;
	}
	fs.closeSync(redirectFd);
	savedStderrFd = saved;
	return true;
}

/**
 * Point fd 2 at `logPath`, the log file the rotating sink is currently
 * writing.
 *
 * The logger calls this on every sink rotation. Without it fd 2 keeps the
 * descriptor opened at TUI start, so after local midnight raw stderr — this
 * process's and every child that inherited fd 2 — keeps landing in the
 * previous day's file, which the sink eventually prunes out from under it.
 *
 * The path is recorded even while suppression is inactive, so a later
 * {@link suppressTerminalStderr} redirects to the live file instead of
 * re-deriving a dated name. Best-effort: if the new file cannot be opened,
 * fd 2 keeps its current target.
 */
export function setStderrRedirectTarget(logPath: string): void {
	redirectTarget = logPath;
	if (savedStderrFd === null) return;
	const libc = libcFdOps();
	if (!libc) return;
	let redirectFd: number;
	try {
		redirectFd = fs.openSync(logPath, "a");
	} catch {
		return;
	}
	libc.dup2(redirectFd, STDERR_FILENO);
	fs.closeSync(redirectFd);
}

/**
 * Re-point fd 2 at the saved terminal stderr. Safe to call unconditionally:
 * no-op when suppression is not active. Called at every terminal-ownership
 * release and by the postmortem fatal handlers before they print, so crash
 * reports reach the real terminal.
 */
export function restoreTerminalStderr(): void {
	if (savedStderrFd === null) return;
	const saved = savedStderrFd;
	savedStderrFd = null;
	libcFdOps()?.dup2(saved, STDERR_FILENO);
	try {
		fs.closeSync(saved);
	} catch {
		// The dup'ed fd is process-owned; a close failure leaves nothing to recover.
	}
}

/** Whether fd 2 is currently redirected away from the terminal. */
export function isTerminalStderrSuppressed(): boolean {
	return savedStderrFd !== null;
}

/**
 * Queues text behind output a stopped terminal could not deliver yet (its
 * reader stalled) and returns true, or returns false once nothing is pending.
 */
let terminalHandoffWriter: ((text: string) => boolean) | null = null;

/**
 * Set by the terminal while it holds output a stalled reader has not taken
 * yet; cleared (null) once that output drains or another terminal takes over.
 */
export function setTerminalHandoffWriter(writer: ((text: string) => boolean) | null): void {
	terminalHandoffWriter = writer;
}

/**
 * Queue `text` meant for stderr behind output a stopped terminal still holds,
 * when stderr is that terminal: the text then reaches the terminal after that
 * output instead of ahead of it.
 * Returns false when nothing is pending or stderr goes elsewhere; the caller
 * then writes to stderr itself.
 */
export function queueStderrBehindTerminal(text: string): boolean {
	if (!terminalHandoffWriter || !stderrSharesStdoutTerminal()) return false;
	return terminalHandoffWriter(text);
}
