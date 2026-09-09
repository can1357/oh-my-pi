/**
 * Terminal stderr guard: keeps unmanaged fd-2 writes off the terminal while a
 * TUI owns the viewport.
 *
 * On macOS, runtime diagnostics are written by the platform directly to file
 * descriptor 2 at arbitrary times — e.g. libmalloc's "MallocStackLogging:
 * can't turn off malloc stack logging because it was not enabled" when the OS
 * broadcasts a memory-diagnostic event to long-lived processes. Those bytes
 * bypass the renderer and paint straight into the viewport. Stripping the
 * MallocStackLogging* env vars (cli.ts) only protects child processes; it
 * cannot stop libmalloc inside THIS process from logging.
 *
 * Fix (mirrors openai/codex#24459): while the TUI owns the terminal, dup fd 2
 * aside and dup2 a redirect target over it; restore the saved fd whenever
 * terminal ownership is released (external editor, Ctrl+Z suspend, shutdown,
 * crash restore). Unlike codex we redirect to the omp log file — not
 * /dev/null — so the diagnostics stay greppable and Bun native-crash reports
 * (which abort before any JS cleanup can restore fd 2) are preserved.
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

export interface SuppressTerminalStderrOptions {
	/** Redirect target path; defaults to today's omp log file, then /dev/null. */
	redirectPath?: string;
	/** Bypass the macOS + same-terminal gate. Tests only. */
	force?: boolean;
}

/**
 * Redirect fd 2 away from the terminal while the TUI owns the viewport.
 * Returns true when suppression is (already) active. No-op — returning
 * false — off macOS, when stderr does not target the stdout terminal, or
 * when the libc fd ops are unavailable.
 */
export function suppressTerminalStderr(options?: SuppressTerminalStderrOptions): boolean {
	if (savedStderrFd !== null) return true;
	if (!options?.force && (process.platform !== "darwin" || !stderrSharesStdoutTerminal())) {
		return false;
	}
	const libc = libcFdOps();
	if (!libc) return false;

	let redirectFd: number;
	try {
		const redirectPath = options?.redirectPath ?? getLogPath();
		// getLogsDir() only computes the path; the logger creates it lazily, so
		// on a fresh profile ~/.omp/logs may not exist yet. Create it here so
		// diagnostics land in the log instead of falling through to /dev/null.
		fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
		redirectFd = fs.openSync(redirectPath, "a");
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
