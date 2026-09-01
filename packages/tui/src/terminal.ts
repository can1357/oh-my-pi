import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { TtyWriter } from "@oh-my-pi/pi-natives";
import {
	$env,
	isBunTestRuntime,
	isTerminalHeadless,
	isWsl,
	logger,
	postmortem,
	restoreTerminalStderr,
	suppressTerminalStderr,
} from "@oh-my-pi/pi-utils";
import { setKittyProtocolActive } from "./keys";
import { StdinBuffer } from "./stdin-buffer";
import {
	isInsideTerminalMultiplexer,
	NotifyProtocol,
	setCellDimensions,
	setOsc99Supported,
	TERMINAL,
} from "./terminal-capabilities";
import { isInsideTmux, wrapTmuxPassthrough } from "./tmux";
import { setHangulCompatibilityJamoWidth } from "./utils";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";
const WINDOWS_TERMINAL_OSC11_POLL_MS = 30_000;
function shouldEnableModifyOtherKeysFallback(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (!env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT) return true;
	return TERMINAL.id !== "base" && TERMINAL.id !== "trueColor";
}

function shouldPollWindowsTerminalAppearance(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (process.platform !== "win32") return false;
	if (!env.WT_SESSION) return false;
	return !env.TERM_PROGRAM || env.TERM_PROGRAM.toLowerCase() === "windows_terminal";
}
/**
 * Maximum encoded UTF-8 bytes per `process.stdout.write` call on Windows.
 *
 * Windows ConPTY ties viewport tracking to per-`WriteFile` boundaries: when a
 * single write exceeds ~32-64 KB, the pseudo-console stops following the
 * cursor and the host UI's viewport stays parked at whatever scroll position
 * the write started from. The visible symptom is that a full-paint of a long
 * session (resume, history rebuild, large permission dialog) shows only the
 * first ~30 lines until any focus event forces the host to re-query the
 * cursor. The data is delivered correctly — it's purely a viewport-sync bug.
 *
 * The cap is on **encoded UTF-8 bytes**, not JS code units, because
 * `process.stdout.write(string)` UTF-8-encodes before handing off to
 * `WriteFile`. A pure-CJK transcript row encodes to ~3 bytes per BMP code
 * unit, so a code-unit-based cap of 16 KiB could land at ~48 KiB of actual
 * `WriteFile` traffic and reintroduce the #2034 parked-viewport bug for
 * non-ASCII content.
 *
 * 16 KiB is half the smallest observed Windows Terminal threshold (32 KiB),
 * which keeps the per-write parked-viewport bug fixed by #2034 while halving
 * the WriteFile count on multi-megabyte paints (a 3 MB session resume splits
 * into ~192 chunks instead of ~384). Fewer WriteFiles means fewer chances for
 * WT's viewport-following logic to lose track of the cursor during the burst,
 * which mitigates the residual mid-paint drift the original 8 KiB cap left
 * behind (#2095). Still well clear of the threshold so the other ConPTY hosts
 * (Tabby, Hyper, VS Code) — where the exact limit is undocumented — keep
 * their safety margin.
 */
const MAX_CONPTY_WRITE_CHUNK_BYTES = 16 * 1024;

/**
 * Split `data` into chunks whose encoded UTF-8 byte length is no greater than
 * `maxChunkBytes`, preferring a line boundary (`\n`) as the cut point so
 * escape sequences (which never contain `\n`) stay intact. The TUI's
 * full-paint buffers are line-structured (`buffer += "\r\n"` between rows),
 * so a newline almost always exists within the window. The fallback for a
 * buffer with no newline in range is a hard cut at the last UTF-8 code-point
 * boundary that still fits — the ConPTY viewport bug from a single oversized
 * write is strictly worse than a one-frame escape-sequence glitch on a
 * buffer the renderer effectively never produces.
 *
 * UTF-16 code units are walked manually rather than measuring with
 * `Buffer.byteLength` per slice candidate: each code unit's UTF-8 width is
 * known from its value (BMP `<0x80` → 1, `<0x800` → 2, surrogate pair → 4
 * bytes across two units, other BMP → 3), and surrogate pairs are kept
 * together so the chunker never splits a non-BMP character.
 *
 * Exported for unit testing of the chunking contract; `#safeWrite` is the
 * sole production caller.
 */
export function chunkForConPTY(data: string, maxChunkBytes: number = MAX_CONPTY_WRITE_CHUNK_BYTES): string[] {
	// Fast path: whole buffer fits in one write.
	if (Buffer.byteLength(data, "utf8") <= maxChunkBytes) return [data];
	const chunks: string[] = [];
	const len = data.length;
	let pos = 0;
	while (pos < len) {
		let bytes = 0;
		// Index just past the most recent `\n` we've consumed inside [pos, i):
		// the natural cut point that leaves escape sequences intact.
		let lastNewlineEnd = -1;
		let i = pos;
		while (i < len) {
			const cu = data.charCodeAt(i);
			let cuLen = 1;
			let cuBytes: number;
			if (cu < 0x80) {
				cuBytes = 1;
			} else if (cu < 0x800) {
				cuBytes = 2;
			} else if (cu >= 0xd800 && cu < 0xdc00) {
				// High surrogate: pair with the following low surrogate (4 bytes
				// across two code units); an unpaired surrogate UTF-8-encodes as
				// the 3-byte U+FFFD replacement character.
				const next = i + 1 < len ? data.charCodeAt(i + 1) : 0;
				if (next >= 0xdc00 && next < 0xe000) {
					cuBytes = 4;
					cuLen = 2;
				} else {
					cuBytes = 3;
				}
			} else {
				// BMP non-surrogate or unpaired low surrogate → 3 bytes.
				cuBytes = 3;
			}
			if (bytes + cuBytes > maxChunkBytes && i > pos) {
				// Would overflow the cap. Cut at the last newline if we found one,
				// otherwise hard-cut at the current code-point boundary.
				const cut = lastNewlineEnd > pos ? lastNewlineEnd : i;
				chunks.push(data.slice(pos, cut));
				pos = cut;
				break;
			}
			bytes += cuBytes;
			i += cuLen;
			if (cu === 0x0a) lastNewlineEnd = i;
		}
		if (i >= len) {
			chunks.push(data.slice(pos));
			pos = len;
		}
	}
	return chunks;
}

/**
 * Backlog ceiling that arms the stall watchdog. A live terminal keeps this
 * near zero; crossing it means either a genuinely wedged PTY reader (#6854) or
 * a single legitimately-huge frame — a `--resume` transcript repaint of many
 * inline images is one multi-tens-of-MiB write (#10430). The two are told
 * apart by {@link StdoutStallWatchdog} (drain progress), not by this number
 * alone: inter-frame production is already gated at 256 KiB
 * (`TUI.#deferRenderForOutputBacklog`), so the only way to reach this cap is a
 * lone oversized frame or a reader that has stopped consuming entirely.
 */
const MAX_STDOUT_BACKLOG_BYTES = 64 * 1024 * 1024;

/**
 * Backlog at or below which stdout is healthy again: the pump has kept up, the
 * TUI resumes composing frames, and a {@link StdoutStallWatchdog} episode ends.
 * The TUI render gate (`TUI.#MAX_PENDING_OUTPUT_BYTES`) is this same value, so
 * the watchdog stays armed across the entire range where frames are deferred —
 * otherwise a consumer that wedges between this level and the arm cap is never
 * re-sampled and the session freezes instead of disconnecting (#10434 review).
 */
export const STDOUT_BACKLOG_CLEAR_BYTES = 256 * 1024;

/**
 * How long an armed backlog may go without any drain progress before the
 * consumer is declared gone. A slow-but-alive terminal keeps reaching new
 * low-water marks (so it never trips); a wedged one that flushes nothing is
 * torn down within this window.
 */
const STDOUT_STALL_TIMEOUT_MS = 2_000;

/** Cadence at which {@link ProcessTerminal} re-samples the backlog while an episode is armed. */
const STDOUT_STALL_POLL_MS = 250;

/**
 * Bounds a never-draining stdout backlog without killing a single large but
 * actively-draining frame.
 *
 * `process.stdout.write()` returns `false` once its buffer exceeds the stream
 * high-water mark, and the off-thread pump's `pending()` climbs the same way;
 * a stalled-but-alive PTY reader never throws, so the byte count is the only
 * signal that output is going nowhere. Tripping on the instantaneous count
 * alone is wrong: a legitimate oversized frame (a resume repaint of dozens of
 * inline screenshots, #10430) briefly exceeds the cap and then drains.
 *
 * An episode starts when the backlog first exceeds `armBytes` and lasts until
 * it drains back to `clearBytes` (healthy). The backlog can fall below
 * `armBytes` while still unhealthy, so the episode must outlive that dip
 * (#10434): during it the watchdog declares the terminal disconnected only when
 * the backlog makes no drain progress (no new low-water mark) for `stallMs` —
 * a draining terminal keeps lowering the mark and never trips, while a wedged
 * one (#6854) still tears down within the window.
 *
 * Exported for unit testing; `ProcessTerminal` is the sole production user.
 */
export class StdoutStallWatchdog {
	#lowWater = Number.POSITIVE_INFINITY;
	#stalledSinceMs = 0;
	#armed = false;

	constructor(
		private readonly armBytes: number = MAX_STDOUT_BACKLOG_BYTES,
		private readonly clearBytes: number = STDOUT_BACKLOG_CLEAR_BYTES,
		private readonly stallMs: number = STDOUT_STALL_TIMEOUT_MS,
	) {}

	/** True while an episode is active and the backlog must be polled to completion. */
	get armed(): boolean {
		return this.#armed;
	}

	/**
	 * Feed the current pending-byte count and clock reading. Returns true once an
	 * armed episode has gone `stallMs` with no drain progress, at which point the
	 * caller treats the terminal as disconnected.
	 */
	sample(pending: number, nowMs: number): boolean {
		if (!this.#armed) {
			// Idle: only an oversized backlog starts an episode.
			if (pending <= this.armBytes) return false;
			this.#armed = true;
			this.#lowWater = pending;
			this.#stalledSinceMs = nowMs;
			return false;
		}
		if (pending <= this.clearBytes) {
			// Drained back to a healthy level: the episode is over.
			this.reset();
			return false;
		}
		if (pending < this.#lowWater) {
			// Drain progress: a new low-water mark restarts the stall clock.
			this.#lowWater = pending;
			this.#stalledSinceMs = nowMs;
			return false;
		}
		// Still unhealthy with no new low-water mark since the clock started.
		return nowMs - this.#stalledSinceMs >= this.stallMs;
	}

	/** Episode ended (drained) or terminal torn down: stop watching. */
	reset(): void {
		this.#armed = false;
		this.#lowWater = Number.POSITIVE_INFINITY;
		this.#stalledSinceMs = 0;
	}
}

/**
 * Minimal terminal interface for TUI
 */

// Track active terminal for emergency cleanup on crash
let activeTerminal: ProcessTerminal | null = null;
// Track if a terminal was ever started (for emergency restore logic)
let terminalEverStarted = false;
// Whether the alternate screen buffer is currently active (mirrors the TUI's
// overlay enter/leave writes). Consulted by emergencyTerminalRestore: DECRST
// 1049 must never be written blindly, because Windows' shared VT dispatcher
// (conhost and Windows Terminal both use AdaptDispatch) executes an
// unconditional cursor restore on it — with no prior DECSC save the cursor
// jumps to the viewport home, dropping the parent shell prompt on top of the
// dead frame after exit.
let altScreenActive = false;
let terminalRestoreRegistered = false;

function registerPostmortemTerminalRestore(): void {
	if (terminalRestoreRegistered) return;
	terminalRestoreRegistered = true;
	postmortem.register("terminal-restore", () => {
		emergencyTerminalRestore();
	});
}

/** Record alternate-screen state (called by the TUI on `?1049h`/`?1049l` writes). */
export function setAltScreenActive(active: boolean): void {
	altScreenActive = active;
}
/**
 * Route an out-of-band escape sequence (e.g. an OSC title update) through the
 * active terminal's output path. While a TUI owns stdout, frame paints go
 * through the off-thread write pump and can split across multiple write(2)
 * calls; a direct main-thread `process.stdout.write` can land between two of
 * them — mid escape sequence — and the host terminal then prints the payload
 * as literal text at the cursor position. Returns false when no terminal has
 * started, in which case the caller owns stdout and may write directly.
 */
export function writeThroughActiveTerminal(data: string): boolean {
	if (!activeTerminal) return false;
	activeTerminal.write(data);
	return true;
}

const stdoutErrorHandlers = new Set<(err: Error) => void>();
let stdoutErrorListenerInstalled = false;

function onStdoutError(err: Error): void {
	for (const handler of stdoutErrorHandlers) handler(err);
}

function registerStdoutErrorHandler(handler: (err: Error) => void): () => void {
	stdoutErrorHandlers.add(handler);
	if (!stdoutErrorListenerInstalled) {
		process.stdout.on("error", onStdoutError);
		stdoutErrorListenerInstalled = true;
	}
	return () => {
		stdoutErrorHandlers.delete(handler);
	};
}

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
/** UTF-8 codepage id for SetConsoleCP/SetConsoleOutputCP. */
const CP_UTF8 = 65001;

/**
 * Lazily-initialized closure re-asserting the UTF-8 console codepage, or
 * `null` when unavailable (non-win32, FFI failure, console detached).
 */
let consoleCodepageGuard: (() => void) | null | undefined;

/**
 * Re-assert the UTF-8 console codepage before writing (win32 only).
 *
 * Bun sets both console codepages to UTF-8 (65001) at startup, and
 * `process.stdout.write(string)` hands UTF-8 bytes to `WriteFile`, which
 * conhost translates using the *current* console output codepage. Child
 * processes spawned by tools (bash commands, MCP/LSP servers, eval kernels)
 * share this console, and some flip the codepage behind our back: PHP >=7.1
 * CLI issues the equivalent of `chcp` whenever `internal_encoding` mismatches
 * the console codepage (php.net request #73716) and skips the restore when
 * killed — and two PHP processes in a pipeline race their restores. Once the
 * codepage falls back to an OEM page (437/850), every non-ASCII glyph the TUI
 * paints is mis-translated: box-drawing borders degrade into `Γöé`/`ΓöÇ`
 * mojibake on the next full repaint (most visibly ctrl+o expand, which
 * rewrites every row).
 *
 * `GetConsoleOutputCP` is one cheap console call per `#safeWrite`; the setter
 * only runs after a foreign flip. A reading of 0 means "no console" — leave
 * that alone. Guarding the write chokepoint (rather than per-spawn cleanup)
 * covers every console-sharing child and long-running processes that flip
 * the codepage mid-session.
 */
function ensureWindowsConsoleUtf8(): void {
	if (consoleCodepageGuard === undefined) consoleCodepageGuard = createConsoleCodepageGuard();
	consoleCodepageGuard?.();
}

let lastWarnedCodepage = 0;

function createConsoleCodepageGuard(): (() => void) | null {
	if (process.platform !== "win32") return null;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			GetConsoleOutputCP: { args: [], returns: FFIType.u32 },
			SetConsoleOutputCP: { args: [FFIType.u32], returns: FFIType.bool },
			GetConsoleCP: { args: [], returns: FFIType.u32 },
			SetConsoleCP: { args: [FFIType.u32], returns: FFIType.bool },
		});
		return () => {
			try {
				const outCp = kernel32.symbols.GetConsoleOutputCP();
				if (outCp !== 0 && outCp !== CP_UTF8) {
					kernel32.symbols.SetConsoleOutputCP(CP_UTF8);
					if (outCp !== lastWarnedCodepage) {
						lastWarnedCodepage = outCp;
						logger.warn("console output codepage changed by a child process; restoring UTF-8", {
							codepage: outCp,
						});
					}
				}
				const inCp = kernel32.symbols.GetConsoleCP();
				if (inCp !== 0 && inCp !== CP_UTF8) {
					kernel32.symbols.SetConsoleCP(CP_UTF8);
				}
			} catch {
				// Console APIs failed (console detached mid-session); disable the guard.
				consoleCodepageGuard = null;
			}
		};
	} catch {
		// bun:ffi unavailable; rendering proceeds without the guard.
		return null;
	}
}
/**
 * Emergency terminal restore - call this from signal/crash handlers
 * Resets terminal state without requiring access to the ProcessTerminal instance
 */
export function emergencyTerminalRestore(): void {
	try {
		// Crash paths must surface subsequent stderr (fatal reports) on the
		// real terminal; no-op when the stderr guard is inactive.
		restoreTerminalStderr();
		const terminal = activeTerminal;
		if (terminal) {
			// Keyboard enhancement state is screen-local: pop the alt-screen
			// frame before leaving it, then let stop() pop omp's main-screen frame.
			if (altScreenActive) {
				const keyboardExit =
					terminal.keyboardEnhancementExitSequence ?? (terminal.kittyEnableSequence ? "\x1b[<u" : "");
				terminal.write(`${keyboardExit}\x1b[?1049l`);
				altScreenActive = false;
			}
			terminal.stop();
			terminal.showCursor(true);
		} else if (terminalEverStarted && !isTerminalHeadless()) {
			// Blind restore only if we know a terminal was started but lost track of it
			// This avoids writing escape sequences for non-TUI commands (grep, commit, etc.)
			process.stdout.write(
				"\x1b[?2026l" + // End synchronized output
					"\x1b[?7h" + // Restore autowrap
					"\x1b[?1l\x1b>" + // Restore normal cursor-key + keypad mode (rmkx, #6374)
					"\x1b[?2004l" + // Disable bracketed paste
					"\x1b[?2031l" + // Disable Mode 2031 appearance notifications
					"\x1b[?2048l" + // Disable in-band resize notifications
					"\x1b[?5522l" + // Disable enhanced paste notifications
					"\x1b[<u" + // Pop kitty keyboard protocol
					"\x1b[>4;0m" + // Disable modifyOtherKeys fallback
					"\x1b[?1006l\x1b[?1003l\x1b[?1000l" + // Disable mouse tracking (fullscreen overlays)
					// Leave the alternate screen only when a fullscreen overlay
					// actually holds it — on Windows, DECRST 1049 on the main
					// buffer homes the cursor (unconditional CursorRestoreState
					// with no prior save), corrupting the shell handoff on exit.
					(altScreenActive ? "\x1b[?1049l\x1b[?1l\x1b>\x1b[<u" : "") + // Leave alt; reset main keyboard
					"\x1b[?25h", // Show cursor
			);
			altScreenActive = false;
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(false);
			}
		}
	} catch {
		// Terminal may already be dead during crash cleanup - ignore errors
	}
}
/** Terminal-reported appearance (dark/light mode). */
export type TerminalAppearance = "dark" | "light";
/** Options for {@link Terminal.start}. */
export interface TerminalStartOptions {
	/**
	 * Paint-only start: skip raw mode, stdin ownership, and every probe that
	 * elicits a response on stdin. The host tty keeps cooked-mode line editing
	 * (kernel echo lands at the hardware cursor), and typed bytes stay queued
	 * in the kernel until {@link Terminal.enableInput} takes ownership and
	 * replays them through `onInput`. Used for the startup prepaint so typing
	 * echoes even while module loading blocks the event loop.
	 */
	deferInput?: boolean;
}
/** Identity of an accepted explicit terminal appearance refresh request. */
export type TerminalAppearanceRequestToken = number;
export interface Terminal {
	// Start the terminal with input, resize, and host-disconnect handlers.
	start(
		onInput: (data: string) => void,
		onResize: () => void,
		onDisconnect?: () => void,
		options?: TerminalStartOptions,
	): void;

	/**
	 * Take ownership of stdin after a `deferInput` start: enable raw mode,
	 * attach input handlers, and run the capability probes start() skipped.
	 * Bytes the user typed in cooked mode meanwhile are replayed through
	 * `onInput`. No-op when input was never deferred. Optional so custom
	 * Terminals built against older pi-tui versions keep working.
	 */
	enableInput?(): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;
	/**
	 * Output bytes accepted but not yet delivered to the terminal, when the
	 * implementation can report it. The renderer skips composing new frames
	 * while this backlog is deep, so a slow terminal receives only fresh
	 * frames instead of a queue of stale ones. Optional so custom Terminals
	 * built against older pi-tui versions keep working.
	 */
	readonly pendingOutputBytes?: number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// The exact kitty keyboard push sequence in effect ("\x1b[>5u" or "\x1b[>7u"),
	// or null when the protocol is not active. Kitty keyboard flags are per-screen,
	// so the TUI re-pushes this after entering the alternate screen.
	get kittyEnableSequence(): string | null;

	// The active modified-key reporting sequence to reassert on alternate-screen
	// entry, or null when no enhanced keyboard mode is active. Optional so custom
	// Terminals built against older pi-tui versions keep working.
	readonly keyboardEnhancementEnterSequence?: string | null;

	// The sequence that cleanly disables the active enhanced keyboard mode on
	// alternate-screen exit, or null when no exit handshake is required. Optional
	// so custom Terminals built against older pi-tui versions keep working.
	readonly keyboardEnhancementExitSequence?: string | null;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility. Same-state calls are deduped against the visibility
	// last written to the terminal; pass force=true to write unconditionally
	// (crash/exit restore paths).
	hideCursor(force?: boolean): void; // Hide the cursor
	showCursor(force?: boolean): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;

	/**
	 * Register a callback for terminal appearance (dark/light) changes.
	 * Detection uses OSC 11 background color query with Mode 2031 as a change trigger.
	 * Fires when the detected appearance changes, including the initial detection.
	 * Subscribers registered after detection are invoked immediately with the
	 * already-detected appearance so late subscribers never miss it.
	 */
	onAppearanceChange(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): void;
	/**
	 * Register a callback fired for every valid OSC 11 appearance report,
	 * including reports whose classification matches the current appearance.
	 * Unlike onAppearanceChange, this does not replay an earlier report.
	 * Optional so custom Terminals built against older pi-tui versions keep working.
	 */
	onAppearanceReport?(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): (() => void) | void;
	/**
	 * Start a bounded OSC 11 background-color refresh cycle, driving appearance
	 * callbacks through the same parse/dedup pipeline used at startup and on Mode
	 * 2031 notifications. Direct terminals need one query; tmux needs a
	 * passthrough query to update its cache followed by one delayed direct cache
	 * read. Invoked on the user's explicit display-reset gesture so terminals
	 * without end-to-end Mode 2031 notifications pick up a light/dark switch
	 * without a restart. No periodic probes are armed.
	 *
	 * A caller-provided token must be propagated unchanged to callbacks and
	 * returned when the request is accepted. This lets callers establish ownership
	 * before implementations synchronously dispatch a cached response. Optional so
	 * custom Terminals built against older pi-tui versions keep working.
	 */
	refreshAppearance?(requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | void;
	/** The last detected terminal appearance, or undefined if not yet known. */
	get appearance(): TerminalAppearance | undefined;
	/**
	 * Register a callback fired once per DEC private mode when its DECRQM support
	 * status resolves. `confirmed` is false when the terminal answered the DA1
	 * sentinel without answering DECRQM, which proves only that querying support
	 * is unavailable — not that the private mode itself is unsupported.
	 */
	onPrivateModeReport?(callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void;
}

/**
 * True when stdout flows through a ConPTY pseudo-console (native win32, or
 * Linux running under WSL where stdout still crosses into ConPTY at the
 * `wslhost` boundary). ConPTY hosts share the per-WriteFile viewport-tracking
 * quirks documented above and on {@link MAX_CONPTY_WRITE_CHUNK_BYTES}, so both
 * `#safeWrite` and the renderer's post-big-paint settle gate hang off this
 * single predicate.
 */
export function isConPTYHosted(): boolean {
	// win32 always hosts through ConPTY; under WSL stdout still crosses into
	// ConPTY at the `wslhost` boundary.
	return process.platform === "win32" || isWsl(process.platform, $env);
}

/** Discriminated owner of an outstanding DA1 sentinel in the unified probe FIFO. */
type Da1SentinelOwner =
	| { kind: "keyboard" }
	| { kind: "osc11" }
	| { kind: "privateMode"; mode: number }
	| { kind: "osc99Probe"; id: string };

let nextOsc99ProbeId = 1;

function parseOsc99KeyValues(section: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const part of section.split(":")) {
		const eq = part.indexOf("=");
		if (eq !== 1) continue;
		values.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return values;
}
const XTERM_SCROLL_TO_BOTTOM_MODES = [1010, 1011] as const;
type Osc11QueryRoute = "direct" | "tmux";
const TMUX_OSC11_CACHE_REFRESH_DELAY_MS = 100;

function isXtermScrollToBottomMode(mode: number): boolean {
	return mode === 1010 || mode === 1011;
}

function isPrivateModeSet(status: string): boolean {
	return status === "1" || status === "3";
}

function isPrivateModeSupported(status: string): boolean {
	return status !== "0" && status !== "4";
}

/** Construction-time overrides for {@link ProcessTerminal}. */
export interface ProcessTerminalOptions {
	/**
	 * Force ConPTY-hosted behavior on or off. Defaults to live detection via
	 * {@link isConPTYHosted}. Tests set this so the kitty-flag and write-chunking
	 * paths stay hermetic regardless of the ambient WSL env (`WSL_DISTRO_NAME` /
	 * `WSL_INTEROP`) — the suite must behave identically on WSL and on CI.
	 */
	conpty?: boolean;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	#wasRaw = false;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	/** True between a `deferInput` start() and enableInput(). */
	#inputDeferred = false;
	#stdoutResizeListener?: () => void;
	#kittyProtocolActive = false;
	#kittyEnableSeq: string | null = null;
	#modifyOtherKeysActive = false;
	#modifyOtherKeysTimeout?: Timer;
	#stdinBuffer?: StdinBuffer;
	#stdinDataHandler?: (data: string) => void;
	#disconnectHandler?: () => void;
	#stdinEndHandler = () => {
		this.#markTerminalDisconnected("stdin ended");
	};
	#stdinCloseHandler = () => {
		this.#markTerminalDisconnected("stdin closed");
	};
	#stdinErrorHandler = (err: Error) => {
		this.#markTerminalDisconnected("stdin failed", err);
	};
	#dead = false;
	#active = false;
	// Last cursor visibility written to the terminal, sniffed from every
	// outgoing sequence (frame buffers embed their own ?25h/?25l), so
	// hideCursor()/showCursor() can skip same-state writes. `undefined` =
	// unknown (fresh start, resize, or an alt-screen switch newer than the
	// last cursor sequence — some hosts keep DECTCEM per buffer).
	#cursorVisible: boolean | undefined;
	// Captured at construction and re-read at start(): when true, every real
	// terminal side effect (writes, probes, raw mode, SIGWINCH, timers) is
	// suppressed. Defaults on under `bun test` — see isTerminalHeadless().
	#headless = isTerminalHeadless();
	// Captured once at construction: whether stdout flows through a ConPTY
	// pseudo-console. Gates the kitty-flag choice (#1216) and large-write
	// chunking (#safeWrite). Live-detected by default; tests inject a fixed
	// value so WSL env does not change behavior. See {@link ProcessTerminalOptions}.
	readonly #conpty: boolean;
	#writeLogPath = $env.PI_TUI_WRITE_LOG || "";
	#stdoutErrorCleanup?: () => void;
	#stdoutErrorHandler = (err: Error) => {
		this.#markTerminalDisconnected("stdout failed", err);
	};
	// Bounds the stdout backlog against a stalled PTY consumer without killing a
	// single large-but-draining frame: a stalled-but-alive reader never throws,
	// so the pending byte count is the only stall signal, and a legitimate
	// oversized frame (a resume repaint of many inline images) must be allowed
	// to drain. See StdoutStallWatchdog, #6854, and #10430.
	#stdoutStall = new StdoutStallWatchdog();
	#stdoutStallTimer?: Timer;
	// Off-thread output pump (unix TTYs): Bun's `process.stdout.write` blocks
	// the event loop until the terminal drains, so a slow/occluded emulator
	// froze the whole TUI for the duration of a multi-MB repaint. The pump
	// enqueues frames and performs the blocking write(2) on its own thread;
	// `pendingOutputBytes` exposes the backlog for render-side frame skipping.
	#outputPump?: TtyWriter;

	#windowsVTInputRestore?: () => void;
	#xtermScrollToBottomRestoreModes = new Set<number>();
	#appearanceCallbacks: Array<
		(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void
	> = [];
	#appearanceReportCallbacks: Array<
		(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void
	> = [];
	#appearance: TerminalAppearance | undefined;
	#osc11Pending = false;
	#osc11ActiveToken?: TerminalAppearanceRequestToken;
	#osc11QueuedQuery?: { route: Osc11QueryRoute; token?: TerminalAppearanceRequestToken };
	#nextAppearanceRequestToken = 1;
	#osc11ResponseBuffer = "";
	#osc11TmuxRefreshTimer?: Timer;
	#osc99PendingId: string | undefined;
	#osc99ResponseBuffer = "";
	#osc99Capabilities = new Map<string, string>();
	#privateCsiResponseBuffer = "";
	#da1SentinelOwners: Da1SentinelOwner[] = [];
	/** Resolved DECRQM support per private mode (mode → supported). */
	#privateModeSupport = new Map<number, boolean>();
	#privateModeCallbacks: Array<(mode: number, supported: boolean, confirmed: boolean) => void> = [];
	/** Whether DEC 2048 in-band resize notifications are currently enabled. */
	#inBandResizeActive = false;
	/** Reassembly buffer for a DEC 2048 in-band resize report split across stdin reads. */
	#inBandResizeBuffer = "";
	#reportedColumns?: number;
	#reportedRows?: number;
	#mode2031DebounceTimer?: Timer;
	#windowsTerminalAppearancePollTimer?: Timer;
	#progressTimer?: Timer;

	constructor(options?: ProcessTerminalOptions) {
		this.#conpty = options?.conpty ?? isConPTYHosted();
	}

	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	get kittyEnableSequence(): string | null {
		return this.#kittyProtocolActive ? this.#kittyEnableSeq : null;
	}

	get keyboardEnhancementEnterSequence(): string | null {
		if (this.#kittyProtocolActive) return this.#kittyEnableSeq;
		return this.#modifyOtherKeysActive ? "\x1b[>4;2m" : null;
	}

	get keyboardEnhancementExitSequence(): string | null {
		// kitty is a stack push (per-screen), so the matching pop balances alt-screen
		// entry. xterm modifyOtherKeys is a single global flag with no per-screen
		// stack — emitting `>4;0m` here would clear it on the normal screen too,
		// breaking the composer between overlays. terminal.stop() still disables it
		// globally on graceful exit; the emergency-restore path mirrors that.
		return this.#kittyProtocolActive ? "\x1b[<u" : null;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	onAppearanceChange(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): void {
		this.#appearanceCallbacks.push(callback);
		// Replay an already-detected appearance: the startup OSC 11 response can
		// arrive before consumers (e.g. the theme bridge) subscribe, and the
		// dedup in #handleOsc11Response would otherwise suppress the value for
		// them forever (#4731).
		if (this.#appearance) {
			try {
				callback(this.#appearance);
			} catch {
				/* ignore callback errors */
			}
		}
	}

	onAppearanceReport(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): () => void {
		this.#appearanceReportCallbacks.push(callback);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			const index = this.#appearanceReportCallbacks.indexOf(callback);
			if (index !== -1) this.#appearanceReportCallbacks.splice(index, 1);
		};
	}

	/**
	 * Re-query the terminal background through the startup DA1-sentinel FIFO,
	 * pending/queued gating, parsing, dedup, and appearance callbacks. Inside
	 * tmux, only this explicit path first passes an OSC 11 query to the outer
	 * terminal, waits briefly for tmux to consume the response into its cache,
	 * then reads that cache with a direct query. The outer query deliberately has
	 * no DA1 sentinel: multiplexers can decode a fragmented DA1 response as a key
	 * sequence and leak the remaining bytes into the editor. Startup and Mode 2031
	 * probes remain direct. Suppressed while inactive, headless, or after teardown.
	 */
	refreshAppearance(requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | void {
		if (!this.#active || this.#headless || this.#dead) return;
		const token = requestToken ?? this.#nextAppearanceRequestToken++;
		if (token >= this.#nextAppearanceRequestToken) {
			this.#nextAppearanceRequestToken = token + 1;
		}
		this.#queryBackgroundColor(isInsideTmux() ? "tmux" : "direct", token);
		return token;
	}

	onPrivateModeReport(callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void {
		this.#privateModeCallbacks.push(callback);
	}

	start(
		onInput: (data: string) => void,
		onResize: () => void,
		onDisconnect?: () => void,
		options?: TerminalStartOptions,
	): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		this.#disconnectHandler = onDisconnect;
		// The host terminal's cursor visibility is unknown until we write it.
		this.#cursorVisible = undefined;

		// Headless (tests): suppress every real-terminal side effect. Skip raw
		// mode, stdin listeners, capability probes, SIGWINCH, and emergency-restore
		// ownership; #safeWrite is also a no-op, so frame paints and teardown
		// escapes never reach the developer's terminal during `bun test`.
		this.#headless = isTerminalHeadless();
		if (this.#headless) return;
		registerPostmortemTerminalRestore();

		// Register for emergency cleanup
		activeTerminal = this;
		terminalEverStarted = true;
		// Own the blocking write(2) on a pump thread (unix TTYs only). A stale
		// prebuilt natives module without the export falls back to direct writes.
		// Test suites spy on `process.stdout.write` with a faked isTTY, so the
		// pump stays off under `bun test` — same philosophy as isTerminalHeadless.
		if (process.platform !== "win32" && process.stdout.isTTY && !isBunTestRuntime() && !this.#outputPump) {
			try {
				this.#outputPump = new TtyWriter(1);
			} catch (err) {
				logger.debug("tty output pump unavailable; using direct stdout writes", { err: String(err) });
			}
		}

		// Keep unmanaged fd-2 writes (macOS libmalloc/framework diagnostics) off
		// the viewport while we own the terminal; released in stop(). See
		// stderr-guard in pi-utils (mirrors openai/codex#24459).
		suppressTerminalStderr();

		// Set up resize handler immediately. The OS refreshes process.stdout
		// dimensions before firing `resize`, so it is authoritative for geometry:
		// reconcile any stale cached DEC 2048 report before notifying the renderer.
		this.#stdoutResizeListener = () => {
			// Conservative: some hosts reset modes across a resize/reattach, so
			// re-establish cursor visibility on the next explicit call.
			this.#cursorVisible = undefined;
			this.#reconcileInBandGeometryOnResize();
			this.#resizeHandler?.();
		};
		process.stdout.on("resize", this.#stdoutResizeListener);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		setHangulCompatibilityJamoWidth(TERMINAL.hangulJamoWidth);

		if (options?.deferInput) {
			this.#inputDeferred = true;
			return;
		}
		this.#attachInput();
	}

	enableInput(): void {
		if (!this.#inputDeferred) return;
		this.#inputDeferred = false;
		if (this.#headless || this.#dead) return;
		this.#attachInput();
	}

	/**
	 * Own stdin: raw mode, input listeners, and the capability probes that
	 * elicit stdin responses. Split from start() so a `deferInput` prepaint can
	 * leave the tty in cooked mode (kernel echo + line editing) while startup
	 * module loading blocks the event loop, then adopt the kernel-buffered
	 * keystrokes here once the app can process them.
	 */
	#attachInput(): void {
		// A multiplexer or SSH disconnect can leave isTTY true after its pty has
		// been revoked. Raw mode is then impossible, so take the normal terminal
		// disconnect path rather than letting Bun abort startup with EIO.
		this.#wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			try {
				process.stdin.setRawMode(true);
			} catch (err) {
				this.#markTerminalDisconnected("stdin raw mode setup failed", err);
				return;
			}
		}
		process.stdin.setEncoding("utf8");
		process.stdin.on("end", this.#stdinEndHandler);
		process.stdin.on("close", this.#stdinCloseHandler);
		process.stdin.on("error", this.#stdinErrorHandler);
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		this.#safeWrite("\x1b[?2004h");

		// Force normal cursor-key (DECCKM) and numeric-keypad mode (terminfo
		// `rmkx` = "\x1b[?1l\x1b>"). omp decodes both CSI ("\x1b[A") and SS3
		// ("\x1bOA") arrow encodings, so it never enables application mode
		// itself — but a prior program that left the TTY in application-cursor-
		// keys mode makes arrows arrive as SS3. Normalizing on entry keeps input
		// in the predictable default state; stop() restores the same on exit.
		// See #6374.
		this.#safeWrite("\x1b[?1l\x1b>");

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run after setRawMode(true)
		// since that resets console mode flags.
		this.#enableWindowsVTInput();
		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.#queryAndEnableKittyProtocol();
		// Explicit probes are safe only after their response parser and stdin
		// data handler are installed. Keep this false throughout temporary stops.
		this.#active = true;
		// Query terminal background color via OSC 11 for dark/light detection.
		// Uses DA1 (Primary Device Attributes) as a sentinel: terminals process
		// sequences in order, so if DA1 arrives before OSC 11 response,
		// the terminal does not support OSC 11. This avoids indefinite hangs.
		// Technique used by Neovim, bat, fish, and terminal-colorsaurus.
		this.#queryBackgroundColor();

		// Query OSC 99 notification capabilities for Kitty. The query uses the
		// same DA1 sentinel FIFO as OSC 11/DECRQM so unsupported terminals resolve
		// without leaking probe bytes to application input.
		this.#queryOsc99Support();

		// Subscribe to Mode 2031 appearance change notifications.
		// When the terminal reports a change, we re-query OSC 11 to get the
		// actual background color (following Neovim convention) with 100ms debounce.
		this.#safeWrite("\x1b[?2031h");

		// Theme detection relies on (1) the startup OSC 11 probe above and
		// (2) DEC Mode 2031 push notifications. Terminals without Mode 2031
		// (macOS Terminal.app, Warp, VS Code's built-in, older Alacritty/
		// WezTerm) detect the appearance once at startup and pick up later OS
		// theme changes on next launch. Earlier builds polled OSC 11 every 30 s
		// here for those terminals, but each poll's OSC 11/DA1 write wiped the
		// user's active text selection on several of them (#3297). Native Windows
		// Terminal gets a scoped fallback after DECRQM confirms 2031 is unsupported.

		// Probe DEC private-mode support via DECRQM. 2026 (synchronized output)
		// gates the renderer's begin/end markers; 2048 (in-band resize) is enabled
		// only after the terminal confirms support; 2031 (appearance change
		// notifications) drives mid-session theme tracking. Xterm ?1010/?1011
		// are disabled while OMP owns the TTY so typing in the editor does not
		// force a reader scrolled into native history back to the tail. Each probe
		// rides the shared DA1 sentinel, so terminals that ignore DECRQM resolve as
		// unsupported when the DA1 reply arrives.
		this.#queryPrivateMode(2026);
		this.#queryPrivateMode(2048);
		this.#queryPrivateMode(2031);
		for (const mode of XTERM_SCROLL_TO_BOTTOM_MODES) {
			this.#queryPrivateMode(mode);
		}
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT to the stdin console mode
	 * so modified keys (for example Shift+Tab) arrive as VT escape sequences.
	 */
	#enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		this.#restoreWindowsVTInput();
		try {
			const kernel32 = dlopen("kernel32.dll", {
				GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
				GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
				SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
			});
			const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			const modePtr = ptr(mode);
			if (!modePtr || !kernel32.symbols.GetConsoleMode(handle, modePtr)) {
				kernel32.close();
				return;
			}
			const originalMode = mode[0]!;
			const vtMode = originalMode | ENABLE_VIRTUAL_TERMINAL_INPUT;
			if (vtMode !== originalMode && !kernel32.symbols.SetConsoleMode(handle, vtMode)) {
				kernel32.close();
				return;
			}
			this.#windowsVTInputRestore = () => {
				try {
					kernel32.symbols.SetConsoleMode(handle, originalMode);
				} finally {
					kernel32.close();
				}
			};
		} catch {
			// bun:ffi unavailable or console API unsupported; keep startup non-fatal.
		}
	}

	#restoreWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		const restore = this.#windowsVTInputRestore;
		this.#windowsVTInputRestore = undefined;
		if (!restore) return;
		try {
			restore();
		} catch {
			// Ignore restore errors during terminal teardown.
		}
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	#setupStdinBuffer(): void {
		// 50ms balances two failure modes: a bare ESC keypress on legacy
		// terminals waits this long before it is delivered, while a CSI key
		// escape split across stdin reads (laggy ssh/tmux links) leaks as
		// literal typed text if the flush fires between the fragments. 10ms
		// proved too tight for split escapes (#1238 covered only probe replies).
		this.#stdinBuffer = new StdinBuffer({ timeout: 50 });

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Mode 2031 DSR response: \x1b[?997;{1=dark,2=light}n
		const appearanceDsrPattern = /^\x1b\[\?997;([12])n$/;

		// OSC 11 response: \x1b]11;rgb:RR/GG/BB or rgba:RR/GG/BB, terminated by BEL or ST.
		const osc11ResponsePattern =
			/^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/;

		// DA1 (Primary Device Attributes) response: \x1b[?...c
		const da1ResponsePattern = /^\x1b\[\?[\d;]*c$/;

		// Private CSI partial: \x1b[?<digits/semicolons>... — incomplete probe response
		// that the StdinBuffer flushed before the terminator arrived (split across
		// stdin reads). Used to reassemble DA1, kitty, and Mode 2031 replies.
		const privateCsiPartialPattern = /^\x1b\[\?[\d;]*[\x20-\x2f]*$/;

		// DECRPM private-mode report (DECRQM reply): \x1b[?<mode>;<status>$y
		const decrpmResponsePattern = /^\x1b\[\?(\d+);(\d+)\$y$/;

		// In-band resize report (DEC mode 2048): \x1b[48;rows;cols;yPixels;xPixels t
		// Any field may carry `:`-separated subparameters, which clients MUST
		// ignore per spec (#4748): capture the leading digits of each field and
		// skip the subparameter tail instead of dropping the whole report.
		const inBandResizePattern = /^\x1b\[48;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?;(\d+)(?::[\d:]*)?t$/;

		this.#stdinBuffer.on("data", (sequence: string) => {
			// Fast path for plain-text bytes: every escape-probe regex below
			// anchors on `^\x1b…`, so a byte that is not ESC can never match. A
			// non-bracketed paste of N printable chars arrives as N per-scalar
			// `data` events; running the full probe suite per event turns a
			// 100 KB paste into ~600K regex executions and blocks the event
			// loop. Skip straight to the input handler when no reassembly
			// buffer is holding state that a non-ESC continuation could feed
			// (issue #4073 case C).
			if (
				(sequence.length === 0 || sequence.charCodeAt(0) !== 0x1b) &&
				this.#privateCsiResponseBuffer.length === 0 &&
				this.#inBandResizeBuffer.length === 0 &&
				this.#osc11ResponseBuffer.length === 0 &&
				this.#osc99ResponseBuffer.length === 0
			) {
				if (this.#inputHandler) {
					this.#inputHandler(sequence);
				}
				return;
			}

			// Reassemble split private CSI responses (DA1, kitty keyboard, Mode 2031).
			// When the terminal writes the response slowly enough that the StdinBuffer's
			// flush timeout elapses mid-sequence, the prefix `\x1b[?<digits>` arrives as
			// one event and the tail `;...<terminator>` arrives as individual character
			// events that would otherwise leak into the prompt as keystrokes. See #1238.
			// A private CSI (`\x1b[?…`) is a terminal->host report, never a keystroke, so
			// reassembly stays armed for the whole session — not just while a probe
			// sentinel is outstanding — otherwise a reply that lands after the sentinel
			// FIFO drains (slow SSH/PTY links) leaks its tail into the composer (#8542).
			if (this.#privateCsiResponseBuffer || privateCsiPartialPattern.test(sequence)) {
				if (this.#privateCsiResponseBuffer && sequence.startsWith("\x1b")) {
					// New escape arrived mid-reassembly — abandon partial and re-process the new sequence.
					this.#privateCsiResponseBuffer = "";
				} else {
					this.#privateCsiResponseBuffer += sequence;
					// Cap accumulator to defend against runaway partials if the terminator never arrives.
					if (this.#privateCsiResponseBuffer.length > 256) {
						this.#privateCsiResponseBuffer = "";
						return;
					}
					const lastChar = this.#privateCsiResponseBuffer.at(-1)!;
					const lastCode = lastChar.charCodeAt(0);
					if (lastCode >= 0x40 && lastCode <= 0x7e) {
						// Terminator byte arrived. Fall through to the pattern checks with the
						// reassembled sequence so the existing DA1/kitty/Mode 2031 handlers run.
						sequence = this.#privateCsiResponseBuffer;
						this.#privateCsiResponseBuffer = "";
					} else if (!privateCsiPartialPattern.test(this.#privateCsiResponseBuffer)) {
						// Diverged from a valid private CSI prefix (unexpected byte). Drop the
						// probe noise we ate; do not forward to the input handler.
						this.#privateCsiResponseBuffer = "";
						return;
					} else {
						// Still accumulating.
						return;
					}
				}
			}

			// In-band resize report (DEC 2048) split across stdin reads. The report
			// is `\x1b[48;rows;cols;yPx;xPx t`; when the StdinBuffer flush timeout
			// elapses mid-sequence — common during a rapid resize that keeps the
			// event loop busy — the `\x1b[48;…` prefix arrives as one event and the
			// tail (`…;xPx t`) arrives as bare character events that would otherwise
			// leak into the prompt as literal keystrokes. Reassemble until the
			// terminator, then fall through to the resize handler below. A
			// reassembled sequence that turns out not to be a resize report (e.g. a
			// split kitty `\x1b[48;…u` for a digit key) is forwarded to the input
			// handler rather than dropped.
			const inBandResizePartialPattern = /^\x1b\[4[\d;:]*$/;
			const isInBandResizePartial = this.#inBandResizeActive && inBandResizePartialPattern.test(sequence);
			if (this.#inBandResizeBuffer && sequence.startsWith("\x1b")) {
				// A new escape interrupted the partial; the stale partial is
				// unrecoverable. If the new escape is itself an in-band prefix,
				// restart reassembly with it; otherwise let it flow through below.
				this.#inBandResizeBuffer = isInBandResizePartial ? sequence : "";
				if (isInBandResizePartial) return;
			} else if (this.#inBandResizeBuffer || isInBandResizePartial) {
				this.#inBandResizeBuffer += sequence;
				if (this.#inBandResizeBuffer.length > 256) {
					this.#inBandResizeBuffer = "";
					return;
				}
				const lastCode = this.#inBandResizeBuffer.charCodeAt(this.#inBandResizeBuffer.length - 1);
				if (lastCode >= 0x40 && lastCode <= 0x7e) {
					// Terminator arrived: let the resize handler below claim it, or
					// fall through to the input handler if it is not a resize report.
					sequence = this.#inBandResizeBuffer;
					this.#inBandResizeBuffer = "";
				} else if (!inBandResizePartialPattern.test(this.#inBandResizeBuffer)) {
					// Diverged from a valid in-band prefix — drop the garbled report.
					this.#inBandResizeBuffer = "";
					return;
				} else {
					// Still accumulating the report.
					return;
				}
			}

			// In-band resize report (DEC mode 2048). Unsolicited and not tied to a
			// sentinel: update reported geometry + cell size, then drive the resize
			// handler so the renderer reflows.
			const resizeMatch = sequence.match(inBandResizePattern);
			if (resizeMatch) {
				this.#handleInBandResizeReport(resizeMatch[1]!, resizeMatch[2]!, resizeMatch[3]!, resizeMatch[4]!);
				return;
			}

			// DECRPM private-mode report. Resolves the matching probe by mode; the
			// owner stays in the FIFO and is drained by its DA1 sentinel (a no-op
			// once resolved). Per DECRPM, status 0 = unrecognized, 1/2 =
			// set/reset, 3 = permanently set, and 4 = permanently reset.
			const decrpmMatch = sequence.match(decrpmResponsePattern);
			if (decrpmMatch) {
				this.#handlePrivateModeReport(parseInt(decrpmMatch[1]!, 10), decrpmMatch[2]!);
				return;
			}

			// DA1 response: swallow our sentinel reply regardless of whether an
			// earlier capability-specific response already succeeded. `CSI ? … c` is
			// exclusively a terminal->host report, so it is swallowed even with no
			// outstanding sentinel — a reply that arrives after the FIFO drains (slow
			// SSH/PTY links) must never reach the composer as literal text (#8542).
			if (da1ResponsePattern.test(sequence)) {
				const owner = this.#da1SentinelOwners.shift();
				if (!owner) {
					// Late/unowned reply: nothing to resolve, just drop the bytes.
					return;
				}
				switch (owner.kind) {
					case "osc11": {
						if (this.#osc11Pending) {
							// DA1 arrived before OSC 11 response: terminal doesn't support OSC 11.
							this.#osc11Pending = false;
							this.#osc11ActiveToken = undefined;
							this.#osc11ResponseBuffer = "";
						}
						// Start a queued OSC 11 query once the prior cycle is fully drained.
						if (
							this.#osc11QueuedQuery !== undefined &&
							!this.#osc11Pending &&
							!this.#da1SentinelOwners.some(o => o.kind === "osc11") &&
							!this.#dead
						) {
							const query = this.#osc11QueuedQuery;
							this.#osc11QueuedQuery = undefined;
							this.#startOsc11Query(query.route, query.token);
						}
						break;
					}
					case "privateMode": {
						// DA1 beat the DECRPM reply. The terminal cannot report this
						// capability, but may still implement it; keep that distinction
						// so static terminal detection is not incorrectly downgraded.
						this.#resolvePrivateMode(owner.mode, false, false);
						break;
					}
					case "keyboard": {
						// Keyboard probe sentinel: kitty reply never arrived → fall back to modifyOtherKeys
						// only where the resolved terminal is known enough to tolerate it.
						if (this.#modifyOtherKeysTimeout) {
							clearTimeout(this.#modifyOtherKeysTimeout);
							this.#modifyOtherKeysTimeout = undefined;
						}
						this.#enableModifyOtherKeysFallback();
						break;
					}
					case "osc99Probe": {
						this.#resolveOsc99Support(owner.id, false);
						break;
					}
				}
				return;
			}

			const match = sequence.match(kittyResponsePattern);
			if (match) {
				if (this.#modifyOtherKeysTimeout) {
					clearTimeout(this.#modifyOtherKeysTimeout);
					this.#modifyOtherKeysTimeout = undefined;
				}
				// A DA1 sentinel that beat the kitty reply may have already
				// engaged the modifyOtherKeys fallback (terminals such as
				// Superset/xterm-on-Electron answer DA1 before `\x1b[?u`).
				// Kitty is strictly preferred — undo the fallback so the two
				// modes do not stack. See #2042.
				if (this.#modifyOtherKeysActive) {
					this.#safeWrite("\x1b[>4;0m");
					this.#modifyOtherKeysActive = false;
				}
				// Any reply to `\x1b[?u` means the terminal speaks the kitty keyboard
				// protocol. The reported flag value is the *current* stack-top — fresh
				// terminals report 0 — so support is implied by the reply itself, not by
				// the flag value. Pick the level we want; `\x1b[>Nu` pushes one frame
				// that shutdown's single `\x1b[<u` pop balances.
				const reportedFlags = parseInt(match[1]!, 10);
				this.#kittyProtocolActive = true;
				setKittyProtocolActive(true);
				if (this.#conpty) {
					// ConPTY (native Windows and WSL) drops Shift+letter keypresses
					// entirely when flag 4 (report alternate keys) is set. Use flag 1
					// (disambiguate only), preserving flag 2 if already active.
					this.#kittyEnableSeq = (reportedFlags & 2) !== 0 ? "\x1b[>3u" : "\x1b[>1u";
					this.#safeWrite(this.#kittyEnableSeq);
				} else if ((reportedFlags & 2) !== 0) {
					// Preserve event-type reporting already enabled by a parent app.
					// Push level-2 to keep its shortcuts reporting consistently.
					this.#kittyEnableSeq = "\x1b[>7u";
					this.#safeWrite(this.#kittyEnableSeq);
				} else {
					// Disambiguate escape codes and report base-layout keys for physical
					// shortcut matching, without event reporting that caused regression #3259.
					this.#kittyEnableSeq = "\x1b[>5u";
					this.#safeWrite(this.#kittyEnableSeq);
				}
				return;
			}

			// OSC 11 replies can be split if the stdin buffer flushes a partial sequence.
			// Accumulate fragments until the BEL/ST terminator arrives, then parse once.
			// If a new escape sequence arrives (not the ST terminator), abort buffering
			// and forward it as normal input so user keystrokes are never swallowed.
			if (this.#osc11Pending && (this.#osc11ResponseBuffer || sequence.startsWith("\x1b]11;"))) {
				if (this.#osc11ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					// New escape sequence arrived mid-buffer — not an OSC 11 continuation.
					this.#osc11ResponseBuffer = "";
					// Fall through to normal input handling below.
				} else {
					this.#osc11ResponseBuffer += sequence;
					const osc11Match = this.#osc11ResponseBuffer.match(osc11ResponsePattern);
					if (!osc11Match) return;
					const [, rHex, gHex, bHex] = osc11Match;
					this.#osc11Pending = false;
					const requestToken = this.#osc11ActiveToken;
					this.#osc11ActiveToken = undefined;
					this.#osc11ResponseBuffer = "";
					this.#handleOsc11Response(rHex!, gHex!, bHex!, requestToken);
					return;
				}
			}

			if (this.#osc99PendingId && (this.#osc99ResponseBuffer || sequence.startsWith("\x1b]99;"))) {
				if (this.#osc99ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					this.#osc99ResponseBuffer = "";
				} else {
					this.#osc99ResponseBuffer += sequence;
					const osc99Match = this.#osc99ResponseBuffer.match(/^\x1b\]99;([^;]*);([\s\S]*?)(?:\x07|\x1b\\)$/u);
					if (!osc99Match) return;
					const [, meta, payload] = osc99Match;
					this.#osc99ResponseBuffer = "";
					this.#handleOsc99CapabilityResponse(meta!, payload!);
					return;
				}
			}

			// Mode 2031 change notification: re-query OSC 11 with 100ms debounce
			// (Neovim convention — coalesces rapid notifications during transitions)
			const appearanceMatch = sequence.match(appearanceDsrPattern);
			if (appearanceMatch) {
				if (this.#mode2031DebounceTimer) clearTimeout(this.#mode2031DebounceTimer);
				this.#mode2031DebounceTimer = setTimeout(() => {
					this.#mode2031DebounceTimer = undefined;
					this.#queryBackgroundColor();
				}, 100);
				return;
			}
			if (this.#inputHandler) {
				this.#inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.#stdinBuffer.on("paste", (content: string) => {
			if (this.#inputHandler) {
				this.#inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.#stdinDataHandler = (data: string) => {
			this.#stdinBuffer!.process(data);
		};
	}

	/**
	 * Send OSC 11 background color query followed by DA1 sentinel.
	 * DA1 avoids indefinite hangs: if DA1 response arrives before OSC 11,
	 * the terminal does not support OSC 11.
	 */
	#queryBackgroundColor(route: Osc11QueryRoute = "direct", token?: TerminalAppearanceRequestToken): void {
		if (this.#dead) return;
		// Queue if an OSC 11 query is in flight or its DA1 sentinel hasn't been
		// consumed yet. Starting a new query while a DA1 is outstanding would
		// increment the sentinel counter, and the old DA1 arrival would then
		// prematurely clear the new query's pending state. Preserve a requested
		// tmux passthrough route when coalescing direct and explicit queries, and
		// retain the latest explicit request identity across automatic queries.
		if (this.#osc11Pending || this.#da1SentinelOwners.some(o => o.kind === "osc11")) {
			const queued = this.#osc11QueuedQuery;
			this.#osc11QueuedQuery = {
				route: queued?.route === "tmux" || route === "tmux" ? "tmux" : "direct",
				token: token ?? queued?.token,
			};
			return;
		}
		this.#startOsc11Query(route, token);
	}

	#startOsc11Query(route: Osc11QueryRoute, token?: TerminalAppearanceRequestToken): void {
		this.#osc11Pending = true;
		this.#osc11ActiveToken = token;
		this.#osc11ResponseBuffer = "";
		if (route === "tmux") {
			this.#safeWrite(wrapTmuxPassthrough("\x1b]11;?\x07"));
			this.#osc11TmuxRefreshTimer = setTimeout(() => {
				this.#osc11TmuxRefreshTimer = undefined;
				if (this.#dead || !this.#osc11Pending) return;
				this.#startDirectOsc11Query();
			}, TMUX_OSC11_CACHE_REFRESH_DELAY_MS);
			return;
		}
		this.#startDirectOsc11Query();
	}

	#startDirectOsc11Query(): void {
		this.#da1SentinelOwners.push({ kind: "osc11" });
		this.#safeWrite("\x1b]11;?\x07"); // OSC 11 query (BEL terminated)
		this.#safeWrite("\x1b[c"); // DA1 sentinel
	}

	#shouldQueryOsc99Support(): boolean {
		if (TERMINAL.notifyProtocol !== NotifyProtocol.Osc99) return false;
		// Never probe inside a terminal multiplexer. tmux/screen forward the
		// passthrough-wrapped `p=?` query to the outer terminal, but cannot route
		// the capability reply back to the pane that sent it (tmux/tmux#4386,
		// tmux/tmux#3964), so the reply leaks into the pane as literal text and
		// its bytes perturb input (issue #5582 — the notification sibling of the
		// graphics-probe leak #5381). Rich notifications fall back to the
		// single-line OSC 99 form until confirmation, and delivery still uses the
		// passthrough/BEL path (#3395).
		if (isInsideTerminalMultiplexer($env)) return false;
		return !isBunTestRuntime() || $env.PI_TUI_OSC99_PROBE === "1";
	}

	#queryOsc99Support(): void {
		setOsc99Supported(false);
		this.#osc99Capabilities.clear();
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		if (this.#dead || !this.#shouldQueryOsc99Support()) return;

		const id = `omp-probe-${nextOsc99ProbeId++}`;
		this.#osc99PendingId = id;
		this.#da1SentinelOwners.push({ kind: "osc99Probe", id });
		// The probe never runs under a multiplexer (see #shouldQueryOsc99Support),
		// so it is always sent directly to the terminal.
		this.#safeWrite(`\x1b]99;i=${id}:p=?;\x1b\\\x1b[c`);
	}

	#handleOsc99CapabilityResponse(metaRaw: string, payload: string): boolean {
		const pendingId = this.#osc99PendingId;
		if (!pendingId) return false;
		const meta = parseOsc99KeyValues(metaRaw);
		if (meta.get("i") !== pendingId || meta.get("p") !== "?") return false;

		const capabilities = parseOsc99KeyValues(payload);
		this.#osc99Capabilities = capabilities;
		const payloadTypes = capabilities.get("p")?.split(",") ?? [];
		this.#resolveOsc99Support(pendingId, payloadTypes.includes("title"));
		return true;
	}

	#resolveOsc99Support(id: string, supported: boolean): void {
		if (this.#osc99PendingId !== id) return;
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		if (!supported) this.#osc99Capabilities.clear();
		setOsc99Supported(supported);
	}

	/**
	 * Parse an OSC 11 background color response and compute BT.601 luminance.
	 * Handles 1-, 2-, 3-, and 4-digit XParseColor hex components.
	 */
	#handleOsc11Response(rHex: string, gHex: string, bHex: string, requestToken?: TerminalAppearanceRequestToken): void {
		const normalize = (hex: string): number => {
			const value = parseInt(hex, 16);
			if (Number.isNaN(value)) return 0;
			const max = 16 ** hex.length - 1;
			return max > 0 ? value / max : 0;
		};
		const luminance = 0.299 * normalize(rHex) + 0.587 * normalize(gHex) + 0.114 * normalize(bHex);
		const mode: TerminalAppearance = luminance < 0.5 ? "dark" : "light";
		const changed = mode !== this.#appearance;
		this.#appearance = mode;
		// oxlint-disable-next-line unicorn/no-useless-spread -- callbacks may unsubscribe while reporting
		for (const cb of [...this.#appearanceReportCallbacks]) {
			try {
				cb(mode, requestToken);
			} catch {
				/* ignore callback errors */
			}
		}
		if (!changed) return;
		for (const cb of this.#appearanceCallbacks) {
			try {
				cb(mode, requestToken);
			} catch {
				/* ignore callback errors */
			}
		}
	}

	#enableModifyOtherKeysFallback(): void {
		if (this.#kittyProtocolActive || this.#modifyOtherKeysActive) return;
		if (!shouldEnableModifyOtherKeysFallback()) return;
		this.#safeWrite("\x1b[>4;2m");
		this.#modifyOtherKeysActive = true;
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable if available.
	 *
	 * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
	 * it supports the protocol and we enable it with CSI > 1 u.
	 *
	 * The response is detected in setupStdinBuffer's data handler, which properly
	 * handles the case where the response arrives split across multiple stdin events.
	 */
	#queryAndEnableKittyProtocol(): void {
		this.#setupStdinBuffer();
		process.stdin.on("data", this.#stdinDataHandler!);
		// Progressive enhancement query: CSI ?u asks the terminal for its current
		// kitty keyboard flags (no side effect on the stack); the DA1 sentinel
		// guarantees a reply even from terminals that ignore CSI ?u.
		this.#da1SentinelOwners.push({ kind: "keyboard" });
		this.#safeWrite("\x1b[?u\x1b[c");
		this.#modifyOtherKeysTimeout = setTimeout(() => {
			this.#modifyOtherKeysTimeout = undefined;
			this.#enableModifyOtherKeysFallback();
		}, 150);
	}

	/**
	 * Probe a DEC private mode via DECRQM (`CSI ? mode $ p`) plus a DA1 sentinel.
	 * The sentinel guarantees resolution even from terminals that ignore DECRQM.
	 * Query and sentinel are fused into one write so the bare-`CSI c` sentinel
	 * accounting used elsewhere stays accurate.
	 */
	#queryPrivateMode(mode: number): void {
		if (this.#dead) return;
		if (this.#privateModeSupport.has(mode)) return;
		this.#da1SentinelOwners.push({ kind: "privateMode", mode });
		this.#safeWrite(`\x1b[?${mode}$p\x1b[c`);
	}

	#handlePrivateModeReport(mode: number, status: string): void {
		this.#resolvePrivateMode(mode, isPrivateModeSupported(status), true);
		if (isXtermScrollToBottomMode(mode) && isPrivateModeSet(status)) {
			this.#disableXtermScrollToBottomMode(mode);
		}
	}

	/**
	 * Record DECRQM support for a private mode (idempotent — first result wins)
	 * and notify subscribers. `confirmed` distinguishes an explicit DECRPM
	 * unsupported response from an absent response followed by the DA1 sentinel.
	 * Enables DEC 2048 in-band resize only after positive confirmation.
	 */
	#resolvePrivateMode(mode: number, supported: boolean, confirmed: boolean): void {
		if (this.#privateModeSupport.has(mode)) return;
		this.#privateModeSupport.set(mode, supported);
		for (const cb of this.#privateModeCallbacks) {
			try {
				cb(mode, supported, confirmed);
			} catch {
				// Ignore subscriber errors — capability reporting must not crash input.
			}
		}
		if (mode === 2048 && supported) this.#enableInBandResize();
		if (mode === 2031) this.#syncWindowsTerminalAppearancePolling(supported);
	}

	#syncWindowsTerminalAppearancePolling(mode2031Supported: boolean): void {
		if (mode2031Supported || !shouldPollWindowsTerminalAppearance() || this.#dead) {
			this.#clearWindowsTerminalAppearancePoll();
			return;
		}
		if (this.#windowsTerminalAppearancePollTimer) return;
		this.#windowsTerminalAppearancePollTimer = setInterval(() => {
			this.#queryBackgroundColor();
		}, WINDOWS_TERMINAL_OSC11_POLL_MS);
	}

	#clearWindowsTerminalAppearancePoll(): void {
		if (!this.#windowsTerminalAppearancePollTimer) return;
		clearInterval(this.#windowsTerminalAppearancePollTimer);
		this.#windowsTerminalAppearancePollTimer = undefined;
	}
	#disableXtermScrollToBottomMode(mode: number): void {
		if (this.#xtermScrollToBottomRestoreModes.has(mode) || this.#dead) return;
		this.#xtermScrollToBottomRestoreModes.add(mode);
		this.#safeWrite(`\x1b[?${mode}l`);
	}

	/**
	 * Enable DEC 2048 in-band resize notifications. The terminal emits an initial
	 * report immediately, seeding reported geometry and cell dimensions.
	 */
	#enableInBandResize(): void {
		if (this.#inBandResizeActive || this.#dead) return;
		this.#inBandResizeActive = true;
		this.#safeWrite("\x1b[?2048h");
	}

	/**
	 * Apply an in-band resize report. Stores reported geometry so `rows`/`columns`
	 * reflect in-band values, derives cell pixel size, and drives the resize
	 * handler only when the report changes the effective row/column geometry.
	 */
	#handleInBandResizeReport(rowsRaw: string, colsRaw: string, yPixelsRaw: string, xPixelsRaw: string): void {
		const previousRows = this.rows;
		const previousColumns = this.columns;
		const rows = parseInt(rowsRaw, 10);
		const cols = parseInt(colsRaw, 10);
		const yPixels = parseInt(yPixelsRaw, 10);
		const xPixels = parseInt(xPixelsRaw, 10);
		if (rows > 0) this.#reportedRows = rows;
		if (cols > 0) this.#reportedColumns = cols;
		if (cols > 0 && xPixels > 0 && rows > 0 && yPixels > 0) {
			setCellDimensions({
				widthPx: Math.max(1, Math.round(xPixels / cols)),
				heightPx: Math.max(1, Math.round(yPixels / rows)),
			});
		}
		if (rows > 0 && cols > 0 && (rows !== previousRows || cols !== previousColumns)) {
			this.#resizeHandler?.();
		}
	}

	/**
	 * Reconcile cached in-band geometry with the OS on an OS-level resize.
	 *
	 * SIGWINCH (POSIX) and ConPTY (Windows) refresh `process.stdout.columns`/
	 * `rows` before the `resize` event fires, so they are authoritative for the
	 * new cell geometry. A cached DEC 2048 report can be stale: the matching
	 * post-resize report may be dropped (split across stdin reads past the flush
	 * window, or interrupted by another escape mid-reassembly), leaving the
	 * getters pinned to the old size — which freezes the rendered width because
	 * the renderer reflows against {@link columns}/{@link rows}, not the live OS
	 * value. Drop a cached dimension that disagrees with the live OS value; the
	 * terminal's next valid in-band report re-seeds pixel sizing.
	 */
	#reconcileInBandGeometryOnResize(): void {
		if (!this.#inBandResizeActive) return;
		const osColumns = process.stdout.columns;
		const osRows = process.stdout.rows;
		if (this.#reportedColumns !== undefined && osColumns > 0 && this.#reportedColumns !== osColumns) {
			this.#reportedColumns = undefined;
		}
		if (this.#reportedRows !== undefined && osRows > 0 && this.#reportedRows !== osRows) {
			this.#reportedRows = undefined;
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this.#headless) return;
		if (this.#kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		const previousHandler = this.#inputHandler;
		this.#inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise(resolve => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.#inputHandler = previousHandler;
		}
	}

	stop(): void {
		// Suppress observer/timer callbacks before any teardown can yield or throw.
		this.#active = false;
		this.#inputDeferred = false;
		if (this.#headless) return;
		// Unregister from emergency cleanup
		if (activeTerminal === this) {
			activeTerminal = null;
		}

		// Release terminal ownership of fd 2 first so external programs,
		// suspend, and shutdown see the real stderr even if a later teardown
		// step throws.
		restoreTerminalStderr();

		if (this.#clearProgressTimer()) {
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Leave paint-time terminal modes even if the process exits between the
		// begin/end halves of a frame. Safe no-ops on terminals that ignored them.
		this.#safeWrite("\x1b[?2026l\x1b[?7h");

		// Restore normal cursor-key (DECCKM) and numeric-keypad mode (terminfo
		// `rmkx`). Symmetric with the normalize in start(): a TTY-sharing child
		// can leave the terminal in application-cursor-keys mode, and without
		// this reset the parent shell inherits SS3 arrows so Up/Down history
		// navigation stays broken after omp exits (#6374).
		this.#safeWrite("\x1b[?1l\x1b>");

		// Disable bracketed paste mode
		this.#safeWrite("\x1b[?2004l");
		this.#safeWrite("\x1b[?5522l");

		// Disable mouse tracking (enabled only by fullscreen overlays; safe
		// no-ops otherwise). Covers crash paths that reach stop() without the
		// TUI's own overlay teardown running.
		this.#safeWrite("\x1b[?1006l\x1b[?1003l\x1b[?1000l");

		// Disable Mode 2031 appearance change notifications
		this.#safeWrite("\x1b[?2031l");

		// Restore xterm scroll-to-bottom modes that were set before startup.
		for (const mode of this.#xtermScrollToBottomRestoreModes) {
			this.#safeWrite(`\x1b[?${mode}h`);
		}
		this.#xtermScrollToBottomRestoreModes.clear();

		if (this.#inBandResizeActive) {
			this.#safeWrite("\x1b[?2048l");
			this.#inBandResizeActive = false;
		}
		if (this.#mode2031DebounceTimer) {
			clearTimeout(this.#mode2031DebounceTimer);
			this.#mode2031DebounceTimer = undefined;
		}
		if (this.#osc11TmuxRefreshTimer) {
			clearTimeout(this.#osc11TmuxRefreshTimer);
			this.#osc11TmuxRefreshTimer = undefined;
		}
		this.#appearanceCallbacks = [];
		this.#appearanceReportCallbacks = [];
		this.#osc11Pending = false;
		this.#osc11ActiveToken = undefined;
		this.#clearWindowsTerminalAppearancePoll();
		this.#osc11QueuedQuery = undefined;
		this.#osc11ResponseBuffer = "";
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		this.#osc99Capabilities.clear();
		setOsc99Supported(false);
		this.#privateCsiResponseBuffer = "";
		this.#inBandResizeBuffer = "";
		this.#da1SentinelOwners.length = 0;
		this.#privateModeCallbacks = [];
		this.#privateModeSupport.clear();
		this.#xtermScrollToBottomRestoreModes.clear();
		this.#reportedColumns = undefined;
		this.#reportedRows = undefined;

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this.#kittyProtocolActive) {
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		this.#restoreWindowsVTInput();
		// Clean up StdinBuffer
		if (this.#stdinBuffer) {
			this.#stdinBuffer.destroy();
			this.#stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.#stdinDataHandler) {
			process.stdin.removeListener("data", this.#stdinDataHandler);
			this.#stdinDataHandler = undefined;
		}
		process.stdin.removeListener("end", this.#stdinEndHandler);
		process.stdin.removeListener("close", this.#stdinCloseHandler);
		process.stdin.removeListener("error", this.#stdinErrorHandler);
		this.#disconnectHandler = undefined;
		this.#inputHandler = undefined;
		this.#appearance = undefined;
		if (this.#stdoutResizeListener) {
			process.stdout.removeListener("resize", this.#stdoutResizeListener);
			this.#stdoutResizeListener = undefined;
		}
		this.#disarmStdoutStallWatchdog();
		this.#resizeHandler = undefined;
		// Flush the restore sequences enqueued above (bounded — a stalled PTY
		// must not wedge exit), then retire the pump. Later writes (emergency
		// restore's showCursor) fall back to direct stdout writes.
		if (this.#outputPump) {
			this.#outputPump.stop(1000);
			this.#outputPump = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state. On a disconnected terminal (pane recycled, ssh
		// dropped) the fd is no longer a tty and Bun's node:tty shim throws; there
		// is nothing left to restore, and throwing would abort the caller. On a
		// live terminal the failure still surfaces - swallowing it would silently
		// leave stdin in raw mode.
		try {
			process.stdin.setRawMode?.(this.#wasRaw);
		} catch (err) {
			if (!this.#dead) throw err;
		}
		this.#stdoutErrorCleanup?.();
		this.#stdoutErrorCleanup = undefined;
		// After stop() the terminal is shared with other writers; visibility
		// tracking is only meaningful while this instance owns the TTY.
		this.#cursorVisible = undefined;
	}

	#ensureStdoutErrorHandler(): void {
		this.#stdoutErrorCleanup ??= registerStdoutErrorHandler(this.#stdoutErrorHandler);
	}

	#markTerminalDisconnected(reason: string, err?: unknown): void {
		if (this.#dead) return;
		this.#dead = true;
		this.#disarmStdoutStallWatchdog();
		logger.warn("terminal disconnected; stopping interactive rendering", { reason, err });

		const disconnectHandler = this.#disconnectHandler;
		this.#disconnectHandler = undefined;
		if (!disconnectHandler) return;
		// The handler tears the TUI down against a terminal that is already gone,
		// so any step in it can fail. Swallow that: the exit below is the whole
		// point of this method and must not be preempted by teardown noise.
		try {
			disconnectHandler();
		} catch (handlerErr) {
			logger.error("Terminal disconnect handler failed; exiting anyway", { err: handlerErr });
		}

		if (process.platform === "win32") {
			void postmortem.quit(129, { drainStdout: false });
			return;
		}
		try {
			process.kill(process.pid, "SIGHUP");
		} catch (signalErr) {
			logger.error("Failed to deliver terminal disconnect signal; exiting directly", { err: signalErr });
			void postmortem.quit(129);
		}
	}

	write(data: string): void {
		this.#safeWrite(data);
		if (this.#writeLogPath) {
			try {
				fs.appendFileSync(this.#writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	#safeWrite(data: string): void {
		if (this.#headless) return;
		if (this.#dead) return;
		// Skip control sequences when stdout isn't a TTY (piped output, tests, log
		// files). They serve no purpose there and would surface as visible noise.
		if (!process.stdout.isTTY) return;
		this.#ensureStdoutErrorHandler();
		this.#trackCursorVisibility(data);
		const pump = this.#outputPump;
		if (pump) {
			if (pump.dead) {
				this.#markTerminalDisconnected("stdout failed; output pump died");
				return;
			}
			try {
				// Feed the live backlog to the stall watchdog rather than tripping on
				// the instantaneous byte count: a single large-but-draining frame (a
				// resume repaint of many inline images) must open normally, while a
				// never-draining reader is still torn down (#6854, #10430).
				this.#trackStdoutBacklog(pump.write(data));
			} catch (err) {
				this.#markTerminalDisconnected("stdout failed", err);
			}
			return;
		}
		// A console-sharing child process may have flipped the console codepage
		// away from UTF-8; repair it before any bytes hit WriteFile so no frame
		// is ever translated through an OEM codepage. See ensureWindowsConsoleUtf8.
		if (process.platform === "win32") ensureWindowsConsoleUtf8();
		try {
			// Windows ConPTY drops viewport tracking when a single write exceeds
			// ~32-64 KB: the host UI's scroll position stays parked at wherever
			// the write began, even though every byte landed in scrollback. Split
			// large paints into newline-aligned chunks so each underlying
			// `WriteFile` stays well below the threshold. The gate also covers
			// WSL — `process.platform === "linux"` there, but stdout still
			// crosses into ConPTY at the `wslhost` boundary, so the same per-
			// WriteFile cap applies. Non-ConPTY PTYs keep the single-write fast
			// path. The cap is on encoded UTF-8 bytes, not JS code units, because
			// `process.stdout.write(string)` UTF-8-encodes before `WriteFile`,
			// and a code-unit cap would let CJK transcript rows expand past the
			// threshold. See #2034 and #2095.
			const bytes = Buffer.byteLength(data, "utf8");
			if (this.#conpty && bytes > MAX_CONPTY_WRITE_CHUNK_BYTES) {
				for (const chunk of chunkForConPTY(data, MAX_CONPTY_WRITE_CHUNK_BYTES)) {
					if (this.#dead) break;
					process.stdout.write(chunk);
				}
			} else {
				process.stdout.write(data);
			}
			// A stalled-but-alive PTY consumer never throws: write() just queues the
			// bytes and writableLength grows. Feed that backlog to the stall watchdog
			// so a genuinely wedged reader is bounded (#6854) without killing a lone
			// oversized frame that is still draining (#10430).
			this.#trackStdoutBacklog(process.stdout.writableLength ?? 0);
		} catch (err) {
			this.#markTerminalDisconnected("stdout failed", err);
		}
	}

	get columns(): number {
		if (this.#inBandResizeActive && this.#reportedColumns) return this.#reportedColumns;
		return process.stdout.columns || Number(Bun.env.COLUMNS) || 80;
	}
	get pendingOutputBytes(): number {
		if (this.#outputPump) return this.#outputPump.pending();
		// Stream fallback: bytes queued past the high-water mark by refused writes.
		return process.stdout.writableLength ?? 0;
	}

	/**
	 * Reconcile the stdout backlog after a write or a poll. The watchdog runs an
	 * episode from the moment the backlog crosses the arm cap until it drains to
	 * a healthy level; while an episode is armed we keep a poll running because,
	 * once the render gate (256 KiB) defers frames, no write is guaranteed to
	 * re-sample the backlog — so a consumer that wedges anywhere above the
	 * healthy threshold, even after the backlog dips below the arm cap, is still
	 * caught. See {@link StdoutStallWatchdog}, #6854, #10430, and #10434.
	 */
	#trackStdoutBacklog(pending: number): void {
		if (this.#stdoutStall.sample(pending, Date.now())) {
			this.#disarmStdoutStallWatchdog();
			this.#markTerminalDisconnected("stdout backlog stalled without draining; PTY consumer stalled");
			return;
		}
		if (!this.#stdoutStall.armed) {
			this.#disarmStdoutStallWatchdog();
			return;
		}
		if (!this.#stdoutStallTimer) {
			this.#stdoutStallTimer = setInterval(() => this.#pollStdoutStall(), STDOUT_STALL_POLL_MS);
			this.#stdoutStallTimer.unref?.();
		}
	}

	#pollStdoutStall(): void {
		if (this.#dead) {
			this.#disarmStdoutStallWatchdog();
			return;
		}
		this.#trackStdoutBacklog(this.pendingOutputBytes);
	}

	#disarmStdoutStallWatchdog(): void {
		this.#stdoutStall.reset();
		if (this.#stdoutStallTimer) {
			clearInterval(this.#stdoutStallTimer);
			this.#stdoutStallTimer = undefined;
		}
	}

	get rows(): number {
		if (this.#inBandResizeActive && this.#reportedRows) return this.#reportedRows;
		return process.stdout.rows || Number(Bun.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.#safeWrite(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.#safeWrite(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(force = false): void {
		if (!force && this.#cursorVisible === false) return;
		this.#safeWrite("\x1b[?25l");
	}

	showCursor(force = false): void {
		if (!force && this.#cursorVisible === true) return;
		this.#safeWrite("\x1b[?25h");
	}

	/**
	 * Sniff outgoing data for the last cursor-visibility change so the tracked
	 * state stays correct for sequences embedded in frame buffers
	 * (TUI#cursorControlSequence appends ?25h/?25l inside the paint write). An
	 * alt-screen switch (DECSET/DECRST 1049) newer than the last cursor
	 * sequence resets tracking to unknown: some hosts keep DECTCEM per buffer.
	 */
	#trackCursorVisibility(data: string): void {
		let idx = data.lastIndexOf("\x1b[?25");
		while (idx !== -1) {
			const final = data.charCodeAt(idx + 5);
			if (final === 0x68 /* h */ || final === 0x6c /* l */) break;
			idx = idx === 0 ? -1 : data.lastIndexOf("\x1b[?25", idx - 1);
		}
		if (data.lastIndexOf("\x1b[?1049") > idx) {
			this.#cursorVisible = undefined;
			return;
		}
		if (idx !== -1) this.#cursorVisible = data.charCodeAt(idx + 5) === 0x68;
	}

	clearLine(): void {
		this.#safeWrite("\x1b[K");
	}

	clearFromCursor(): void {
		this.#safeWrite("\x1b[J");
	}

	clearScreen(): void {
		this.#safeWrite("\x1b[H\x1b[0J"); // Move to home (1,1) and clear from cursor to end
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.#safeWrite(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (this.#headless) return;
		if (active) {
			this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.#progressTimer) {
				this.#progressTimer = setInterval(() => {
					this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
				this.#progressTimer.unref?.();
			}
		} else {
			this.#clearProgressTimer();
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	#clearProgressTimer(): boolean {
		if (!this.#progressTimer) return false;
		clearInterval(this.#progressTimer);
		this.#progressTimer = undefined;
		return true;
	}
}
