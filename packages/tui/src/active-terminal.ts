/**
 * Ownership of stdout by a started {@link ProcessTerminal}, kept in a leaf
 * module so writers that `terminal.ts` itself imports (terminal capabilities,
 * notifications) can route through the active terminal without an import cycle.
 */
import type { ProcessTerminal } from "./terminal";

// The started terminal that owns stdout in this thread; also consulted by the
// emergency restore on crash.
let activeTerminal: ProcessTerminal | null = null;

/** The started terminal that owns stdout in this thread, if any. */
export function getActiveTerminal(): ProcessTerminal | null {
	return activeTerminal;
}

/** Record the terminal that owns stdout (`ProcessTerminal.start`), or release it with `null` (`stop`). */
export function setActiveTerminal(terminal: ProcessTerminal | null): void {
	activeTerminal = terminal;
}

let stdoutErrorListenerInstalled = false;

/**
 * Install one `process.stdout` `error` listener for the direct writes below.
 * Its presence alone keeps a stdout error (EPIPE on a closed pipe, EIO on a
 * revoked PTY) from crashing the process as an unhandled `error` event; a
 * terminal's own output never goes through `process.stdout`.
 */
function installStdoutErrorListener(): void {
	if (stdoutErrorListenerInstalled) return;
	process.stdout.on("error", () => {});
	stdoutErrorListenerInstalled = true;
}

/**
 * Hand `data` to the active terminal's ordered output path (`ops.text(data)`
 * plus a flush, behind any ops already buffered). Returns false when
 * no terminal in this thread has started. On the main thread that means the
 * caller owns stdout; a worker thread never sees the main thread's terminal, so
 * there `false` is not permission to write. Prefer {@link writeTerminalSequence}.
 */
export function writeThroughActiveTerminal(data: string): boolean {
	if (!activeTerminal) return false;
	activeTerminal.write(data);
	return true;
}

/**
 * Write an out-of-band escape sequence (window title, OSC 52 clipboard,
 * notification). While a TUI owns stdout, its frames go through the terminal's
 * native output device, whose off-thread pump writes in chunks that ignore
 * escape boundaries; a direct `process.stdout.write` can land between two
 * chunks and split a frame's escape sequence, and the host terminal then prints
 * its tail as text. So the sequence takes the active terminal's ordered output
 * path as one text op, and goes straight to stdout, best-effort, only when no
 * terminal owns it. A worker thread cannot reach the main thread's terminal and
 * would write around its device, so it writes nothing.
 */
export function writeTerminalSequence(data: string): void {
	if (!Bun.isMainThread) return;
	if (writeThroughActiveTerminal(data)) return;
	installStdoutErrorListener();
	try {
		process.stdout.write(data);
	} catch {
		// Best-effort: a closed stdout must not fail the caller.
	}
}
