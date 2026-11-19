import { CString, dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as os from "node:os";

/** Resolve the TTY device path for stdin (fd 0) via POSIX `ttyname(3)`. */
export function getTtyPath(): string | null {
	if (os.platform() === "linux") {
		// Linux: /proc/self/fd/0 is a symlink to /dev/pts/N
		try {
			const ttyPath = fs.readlinkSync("/proc/self/fd/0");
			if (ttyPath.startsWith("/dev/")) {
				return ttyPath;
			}
		} catch {
			return null;
		}
	} else if (os.platform() !== "win32") {
		try {
			const libName = os.platform() === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
			const lib = dlopen(libName, {
				ttyname: { args: [FFIType.i32], returns: FFIType.ptr },
			});
			try {
				const result = lib.symbols.ttyname(0);
				return result ? new CString(result).toString() : null;
			} finally {
				lib.close();
			}
		} catch {
			return null;
		}
	}
	return null;
}
/**
 * Get a stable identifier for the current terminal.
 * Uses the TTY device path (e.g., /dev/pts/3), falling back to environment
 * variables for terminal multiplexers or terminal emulators.
 * Returns null if no terminal can be identified (e.g., piped input).
 */
export function getTerminalId(): string | null {
	// TTY device path — most reliable, unique per terminal tab
	if (process.stdin.isTTY) {
		try {
			const ttyPath = getTtyPath();
			if (ttyPath?.startsWith("/dev/")) {
				return ttyPath.slice(5).replace(/\//g, "-"); // /dev/pts/3 -> pts-3
			}
		} catch {}
	}

	// Fallback to terminal-specific env vars
	// Prefer inner multiplexers over host terminal emulators when stdin has no TTY path.
	const zellijPane = process.env.ZELLIJ_PANE_ID;
	if (zellijPane) {
		// Session names are user-chosen (`zellij -s …`) and the id is used as a
		// breadcrumb filename — normalize path separators like the TTY branch does.
		const zellijSession = process.env.ZELLIJ_SESSION_NAME?.replace(/[\\/]/g, "-");
		return zellijSession ? `zellij-${zellijSession}-${zellijPane}` : `zellij-${zellijPane}`;
	}

	const tmuxPane = process.env.TMUX_PANE;
	if (tmuxPane) return `tmux-${tmuxPane}`;

	const cmuxSurface = process.env.CMUX_SURFACE_ID;
	if (cmuxSurface) return `cmux-${cmuxSurface}`;

	// Kitty before WezTerm/others, matching terminal-capabilities.ts detection
	// order. Inherited env makes either order wrong for some nesting; staying
	// consistent with the capability detector keeps the two answers aligned.
	const kittyId = process.env.KITTY_WINDOW_ID;
	if (kittyId) return `kitty-${kittyId}`;

	const weztermPane = process.env.WEZTERM_PANE;
	if (weztermPane) return `wezterm-${weztermPane}`;

	const terminalSessionId = process.env.TERM_SESSION_ID; // macOS Terminal.app
	if (terminalSessionId) return `apple-${terminalSessionId}`;

	const wtSession = process.env.WT_SESSION; // Windows Terminal
	if (wtSession) return `wt-${wtSession}`;

	return null;
}
