/**
 * Compatibility surface for the terminal stderr guard released in 16.5.1
 * (`suppressTerminalStderr` / `restoreTerminalStderr` and helpers). The
 * unified terminal-output guard (terminal-output-guard.ts) now covers
 * inherited stdout as well and is what the TUI uses; these entry points keep
 * the released names working for external consumers with their original
 * fd-2-only semantics — calling them must never fence fd 1.
 *
 * When the unified guard is active it already owns both descriptors, so the
 * legacy calls report suppression and leave the descriptors alone; the
 * unified release path restores them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireProcessLogTarget, onProcessLogTargetChanged, type ProcessLogTargetLease } from "./logger/process-log";
import {
	isTerminalOutputSuppressed,
	markTerminalFdCloexec,
	onTerminalOutputRestored,
	setTerminalOutputRedirectTarget,
	stderrSharesStdoutTerminal,
	terminalStderrIsGuarded,
	tryLibcFdOps,
} from "./terminal-output-guard";

/**
 * True when fd 2 writes would land on the same terminal the caller prints
 * stdout to: both descriptors are ttys backed by the same device file. A
 * stderr the caller already redirected (`2>file`, `2>/dev/null`, a different
 * tty) must keep flowing untouched — as in 16.5.1.
 */
/** Saved dup of the real stderr while legacy suppression is active, else null. */
let savedStderrFd: number | null = null;

/** Newest log file the legacy guard knows about; see {@link setStderrRedirectTarget}. */
let redirectTarget: string | null = null;
let canonicalLease: ProcessLogTargetLease | undefined;

export interface SuppressTerminalStderrOptions {
	/**
	 * Redirect target path; defaults to an explicitly selected target, then the
	 * canonical process log target.
	 */
	redirectPath?: string;
	/** Bypass the same-terminal gate. Tests only, as in 16.5.1. */
	force?: boolean;
}

/**
 * Redirect fd 2 away from the terminal — fd 1 is never touched. Returns true
 * when suppression is (already) active: via this guard, or because the
 * unified terminal-output guard owns the descriptors. Returns false when
 * stderr does not share the stdout terminal or libc fd operations are
 * unavailable.
 */
export function suppressTerminalStderr(options?: SuppressTerminalStderrOptions): boolean {
	if (isTerminalOutputSuppressed() && terminalStderrIsGuarded()) {
		// Still fenced by the unified guard; a queued release from an earlier
		// restore call is stale now that suppression is being reasserted.
		pendingRelease = false;
		return true;
	}
	if (savedStderrFd !== null) {
		pendingRelease = false;
		return true;
	}
	if (!options?.force && !stderrSharesStdoutTerminal()) return false;
	const libc = tryLibcFdOps();
	if (!libc) return false;

	let redirectFd: number;
	let lease: ProcessLogTargetLease | undefined;
	try {
		const explicitPath = options?.redirectPath ?? redirectTarget;
		if (explicitPath === null) lease = acquireProcessLogTarget();
		const redirectPath = explicitPath ?? lease!.path;
		fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
		redirectFd = fs.openSync(redirectPath, "a");
		if (options?.redirectPath !== undefined) redirectTarget = options.redirectPath;
	} catch {
		lease?.release();
		lease = undefined;
		try {
			redirectFd = fs.openSync("/dev/null", "w");
		} catch {
			return false;
		}
	}

	const saved = libc.dup(2);
	if (saved === -1) {
		fs.closeSync(redirectFd);
		lease?.release();
		return false;
	}
	if (libc.dup2(redirectFd, 2) === -1) {
		fs.closeSync(redirectFd);
		fs.closeSync(saved);
		lease?.release();
		return false;
	}
	fs.closeSync(redirectFd);
	markTerminalFdCloexec(libc, saved);
	savedStderrFd = saved;
	canonicalLease = lease;
	return true;
}

/** Explicitly select a caller-owned sink for both guard APIs. */
export function setStderrRedirectTarget(logPath: string): void {
	setTerminalOutputRedirectTarget(logPath);
	if (repointStderr(logPath)) {
		redirectTarget = logPath;
		canonicalLease?.release();
		canonicalLease = undefined;
	}
}

onProcessLogTargetChanged(logPath => {
	if (canonicalLease && redirectTarget === null && !terminalStderrIsGuarded() && !repointStderr(logPath)) {
		throw new Error("Cannot redirect terminal stderr to the canonical process log");
	}
});

function repointStderr(logPath: string): boolean {
	if (savedStderrFd === null) return true;
	const libc = tryLibcFdOps();
	if (!libc) return false;
	let redirectFd: number;
	try {
		redirectFd = fs.openSync(logPath, "a");
	} catch {
		return false;
	}
	const redirected = libc.dup2(redirectFd, 2) !== -1;
	fs.closeSync(redirectFd);
	return redirected;
}

/**
 * Re-point fd 2 at the saved terminal stderr. Safe to call unconditionally:
 * no-op when this guard is inactive. A release that arrives while the unified
 * guard owns the descriptors is recorded and takes effect when that guard
 * finishes restoring, so a consumer's single restore call still completes.
 */
export function restoreTerminalStderr(): void {
	if (savedStderrFd === null) return;
	if (isTerminalOutputSuppressed()) {
		pendingRelease = true;
		return;
	}
	performLegacyRestore();
}

let pendingRelease = false;

function performLegacyRestore(): void {
	if (savedStderrFd === null) return;
	const saved = savedStderrFd;
	const libc = tryLibcFdOps();
	if (!libc || libc.dup2(saved, 2) === -1) return;
	savedStderrFd = null;
	try {
		fs.closeSync(saved);
	} catch {
		// The dup'ed fd is process-owned; a close failure leaves nothing to recover.
	}
	canonicalLease?.release();
	canonicalLease = undefined;
}

onTerminalOutputRestored(() => {
	if (!pendingRelease) return;
	pendingRelease = false;
	performLegacyRestore();
});

/**
 * Whether fd 2 is currently redirected away from the terminal, by this guard
 * or by the unified terminal-output guard.
 */
export function isTerminalStderrSuppressed(): boolean {
	return savedStderrFd !== null || (isTerminalOutputSuppressed() && terminalStderrIsGuarded());
}
