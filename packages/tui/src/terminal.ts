import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { $env, isBunTestRuntime, isTerminalHeadless, logger } from "@pk-nerdsaver-ai/pi-utils";
import { setKittyProtocolActive } from "./keys";
import { StdinBuffer } from "./stdin-buffer";
import {
	isInsideTmux,
	NotifyProtocol,
	setCellDimensions,
	setOsc99Supported,
	TERMINAL,
	wrapTmuxPassthrough,
} from "./terminal-capabilities";
import { type HangulCompatibilityJamoWidth, setHangulCompatibilityJamoWidth } from "./utils";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";
// Hangul Compatibility Jamo (U+3131..=U+318E) render width is terminal-dependent:
// Ghostty follows UAX#11 (2 cells); Terminal.app and iTerm2 render narrow (1),
// matching the macOS platform default. Override only for terminals known to
// disagree — the rest keep the platform default (macOS narrow, otherwise UAX#11),
// so this is a no-op everywhere except Ghostty. A runtime DSR/CPR probe that
// auto-detects the width on unknown terminals is tracked separately.
export function resolveHangulCompatibilityJamoWidthFromTerminalIdentity(
	env: NodeJS.ProcessEnv = Bun.env,
): HangulCompatibilityJamoWidth {
	if (
		env.GHOSTTY_RESOURCES_DIR ||
		env.TERM_PROGRAM?.toLowerCase() === "ghostty" ||
		env.TERM?.toLowerCase().includes("ghostty")
	) {
		return 2;
	}
	return "platform";
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

/** Record alternate-screen state (called by the TUI on `?1049h`/`?1049l` writes). */
export function setAltScreenActive(active: boolean): void {
	altScreenActive = active;
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
		const terminal = activeTerminal;
		if (terminal) {
			terminal.stop();
			// stop() never touches the alternate screen — the TUI owns that
			// state and exits it on the normal shutdown path. Only crash paths
			// with a fullscreen overlay still hold the alt buffer here. The
			// leave sequence is gated on the tracked state because it is NOT a
			// universally safe no-op: Windows' VT dispatcher homes the cursor
			// on DECRST 1049 even when the alt buffer is inactive.
			if (altScreenActive) {
				terminal.write("\x1b[?1049l");
				altScreenActive = false;
			}
			terminal.showCursor();
		} else if (terminalEverStarted && !isTerminalHeadless()) {
			// Blind restore only if we know a terminal was started but lost track of it
			// This avoids writing escape sequences for non-TUI commands (grep, commit, etc.)
			process.stdout.write(
				"\x1b[?2026l" + // End synchronized output
					"\x1b[?7h" + // Restore autowrap
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
					(altScreenActive ? "\x1b[?1049l" : "") +
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
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

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

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// The exact kitty keyboard push sequence in effect ("\x1b[>1u" or "\x1b[>7u"),
	// or null when the protocol is not active. Kitty keyboard flags are per-screen,
	// so the TUI re-pushes this after entering the alternate screen.
	get kittyEnableSequence(): string | null;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

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
	 */
	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void;
	/** The last detected terminal appearance, or undefined if not yet known. */
	get appearance(): TerminalAppearance | undefined;
	/**
	 * Register a callback fired once per DEC private mode when its DECRQM support
	 * status resolves. Optional: only real terminals implement capability probing.
	 */
	onPrivateModeReport?(callback: (mode: number, supported: boolean) => void): void;
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
	if (process.platform === "win32") return true;
	// WSL: stdout still crosses into ConPTY at the `wslhost` boundary.
	return process.platform === "linux" && (!!$env.WSL_DISTRO_NAME || !!$env.WSL_INTEROP);
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

function isXtermScrollToBottomMode(mode: number): boolean {
	return mode === 1010 || mode === 1011;
}

function isPrivateModeSet(status: string): boolean {
	return status === "1" || status === "3";
}

function isPrivateModeSupported(status: string): boolean {
	return status !== "0" && status !== "4";
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	#wasRaw = false;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	#stdoutResizeListener?: () => void;
	#kittyProtocolActive = false;
	#kittyEnableSeq: string | null = null;
	#modifyOtherKeysActive = false;
	#modifyOtherKeysTimeout?: Timer;
	#stdinBuffer?: StdinBuffer;
	#stdinDataHandler?: (data: string) => void;
	#dead = false;
	// Captured at construction and re-read at start(): when true, every real
	// terminal side effect (writes, probes, raw mode, SIGWINCH, timers) is
	// suppressed. Defaults on under `bun test` — see isTerminalHeadless().
	#headless = isTerminalHeadless();
	#writeLogPath = $env.PI_TUI_WRITE_LOG || "";
	#stdoutErrorCleanup?: () => void;
	#stdoutErrorHandler = (err: Error) => {
		this.#markTerminalWriteFailed(err);
	};

	#windowsVTInputRestore?: () => void;
	#xtermScrollToBottomRestoreModes = new Set<number>();
	#appearanceCallbacks: Array<(appearance: TerminalAppearance) => void> = [];
	#appearance: TerminalAppearance | undefined;
	#osc11Pending = false;
	#osc11QueryQueued = false;
	#osc11ResponseBuffer = "";
	#osc99PendingId: string | undefined;
	#osc99ResponseBuffer = "";
	#osc99Capabilities = new Map<string, string>();
	#privateCsiResponseBuffer = "";
	#da1SentinelOwners: Da1SentinelOwner[] = [];
	/** Resolved DECRQM support per private mode (mode → supported). */
	#privateModeSupport = new Map<number, boolean>();
	#privateModeCallbacks: Array<(mode: number, supported: boolean) => void> = [];
	/** Whether DEC 2048 in-band resize notifications are currently enabled. */
	#inBandResizeActive = false;
	/** Reassembly buffer for a DEC 2048 in-band resize report split across stdin reads. */
	#inBandResizeBuffer = "";
	#reportedColumns?: number;
	#reportedRows?: number;
	#mode2031DebounceTimer?: Timer;
	#progressTimer?: Timer;

	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	get kittyEnableSequence(): string | null {
		return this.#kittyProtocolActive ? this.#kittyEnableSeq : null;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceCallbacks.push(callback);
	}

	onPrivateModeReport(callback: (mode: number, supported: boolean) => void): void {
		this.#privateModeCallbacks.push(callback);
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;

		// Headless (tests): suppress every real-terminal side effect. Skip raw
		// mode, stdin listeners, capability probes, SIGWINCH, and emergency-restore
		// ownership; #safeWrite is also a no-op, so frame paints and teardown
		// escapes never reach the developer's terminal during `bun test`.
		this.#headless = isTerminalHeadless();
		if (this.#headless) return;

		// Register for emergency cleanup
		activeTerminal = this;
		terminalEverStarted = true;

		// Save previous state and enable raw mode
		this.#wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		this.#safeWrite("\x1b[?2004h");

		// Set up resize handler immediately. The OS refreshes process.stdout
		// dimensions before firing `resize`, so it is authoritative for geometry:
		// reconcile any stale cached DEC 2048 report before notifying the renderer.
		this.#stdoutResizeListener = () => {
			this.#reconcileInBandGeometryOnResize();
			this.#resizeHandler?.();
		};
		process.stdout.on("resize", this.#stdoutResizeListener);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run after setRawMode(true)
		// since that resets console mode flags.
		this.#enableWindowsVTInput();
		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.#queryAndEnableKittyProtocol();
		setHangulCompatibilityJamoWidth(resolveHangulCompatibilityJamoWidthFromTerminalIdentity());

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
		// user's active text selection on several of them (#3297).

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
		const inBandResizePattern = /^\x1b\[48;(\d+);(\d+);(\d+);(\d+)t$/;

		// Forward individual sequences to the input handler
		this.#stdinBuffer.on("data", (sequence: string) => {
			// Reassemble split private CSI responses (DA1, kitty keyboard, Mode 2031).
			// When the terminal writes the response slowly enough that the StdinBuffer's
			// flush timeout elapses mid-sequence, the prefix `\x1b[?<digits>` arrives as
			// one event and the tail `;...<terminator>` arrives as individual character
			// events that would otherwise leak into the prompt as keystrokes. See #1238.
			if (
				this.#privateCsiResponseBuffer ||
				(privateCsiPartialPattern.test(sequence) && this.#da1SentinelOwners.length > 0)
			) {
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
			const inBandResizePartialPattern = /^\x1b\[4[\d;]*$/;
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
			// earlier capability-specific response already succeeded. Other terminal
			// probes should never see these replies.
			if (da1ResponsePattern.test(sequence) && this.#da1SentinelOwners.length > 0) {
				const owner = this.#da1SentinelOwners.shift()!;
				switch (owner.kind) {
					case "osc11": {
						if (this.#osc11Pending) {
							// DA1 arrived before the OSC 11 reply: terminal does not support OSC 11.
							this.#osc11Pending = false;
							this.#osc11ResponseBuffer = "";
						}
						// Start a queued OSC 11 query once the prior cycle is fully drained.
						if (
							this.#osc11QueryQueued &&
							!this.#osc11Pending &&
							!this.#da1SentinelOwners.some(o => o.kind === "osc11") &&
							!this.#dead
						) {
							this.#osc11QueryQueued = false;
							this.#startOsc11Query();
						}
						break;
					}
					case "privateMode": {
						// DA1 beat the DECRPM reply for this mode → treat as unsupported.
						this.#resolvePrivateMode(owner.mode, false);
						break;
					}
					case "keyboard": {
						// Keyboard probe sentinel: kitty reply never arrived → fall back to modifyOtherKeys.
						if (!this.#kittyProtocolActive && !this.#modifyOtherKeysActive && this.#modifyOtherKeysTimeout) {
							clearTimeout(this.#modifyOtherKeysTimeout);
							this.#modifyOtherKeysTimeout = undefined;
							this.#safeWrite("\x1b[>4;2m");
							this.#modifyOtherKeysActive = true;
						}
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
				if (reportedFlags >= 3) {
					// Already enriched (Ghostty/foot may keep flags from a parent app).
					// Push level-2 to lock in event reporting.
					this.#kittyEnableSeq = "\x1b[>7u";
					this.#safeWrite(this.#kittyEnableSeq);
				} else {
					// Level 1 (disambiguate escape codes) — enough for Shift+Enter
					// without the modifyOtherKeys fallback that caused regression #3259.
					this.#kittyEnableSeq = "\x1b[>1u";
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
					this.#osc11ResponseBuffer = "";
					this.#handleOsc11Response(rHex!, gHex!, bHex!);
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
	#queryBackgroundColor(): void {
		if (this.#dead) return;
		// Queue if an OSC 11 query is in flight or its DA1 sentinel hasn't been
		// consumed yet. Starting a new query while a DA1 is outstanding would
		// increment the sentinel counter, and the old DA1 arrival would then
		// prematurely clear the new query's pending state.
		if (this.#osc11Pending || this.#da1SentinelOwners.some(o => o.kind === "osc11")) {
			this.#osc11QueryQueued = true;
			return;
		}
		this.#startOsc11Query();
	}

	#startOsc11Query(): void {
		this.#osc11Pending = true;
		this.#osc11ResponseBuffer = "";
		this.#da1SentinelOwners.push({ kind: "osc11" });
		this.#safeWrite("\x1b]11;?\x07"); // OSC 11 query (BEL terminated)
		this.#safeWrite("\x1b[c"); // DA1 sentinel
	}

	#shouldQueryOsc99Support(): boolean {
		if (TERMINAL.notifyProtocol !== NotifyProtocol.Osc99) return false;
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
		// Wrap the probe under tmux so terminals behind `allow-passthrough on`
		// can still respond (mirroring how `TerminalInfo.sendNotification`
		// wraps notification deliveries). Without it the probe is swallowed
		// inside tmux even when the outer terminal speaks OSC 99, and rich
		// notifications stay permanently downgraded to the single-line fallback.
		const probe = `\x1b]99;i=${id}:p=?;\x1b\\`;
		const sequence = isInsideTmux() ? wrapTmuxPassthrough(probe) : probe;
		this.#safeWrite(`${sequence}\x1b[c`);
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
	#handleOsc11Response(rHex: string, gHex: string, bHex: string): void {
		const normalize = (hex: string): number => {
			const value = parseInt(hex, 16);
			if (Number.isNaN(value)) return 0;
			const max = 16 ** hex.length - 1;
			return max > 0 ? value / max : 0;
		};
		const luminance = 0.299 * normalize(rHex) + 0.587 * normalize(gHex) + 0.114 * normalize(bHex);
		const mode: TerminalAppearance = luminance < 0.5 ? "dark" : "light";
		if (mode === this.#appearance) return;
		this.#appearance = mode;
		for (const cb of this.#appearanceCallbacks) {
			try {
				cb(mode);
			} catch {
				/* ignore callback errors */
			}
		}
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
			if (this.#kittyProtocolActive || this.#modifyOtherKeysActive) {
				return;
			}
			this.#safeWrite("\x1b[>4;2m");
			this.#modifyOtherKeysActive = true;
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
		this.#resolvePrivateMode(mode, isPrivateModeSupported(status));
		if (isXtermScrollToBottomMode(mode) && isPrivateModeSet(status)) {
			this.#disableXtermScrollToBottomMode(mode);
		}
	}

	/**
	 * Record DECRQM support for a private mode (idempotent — first result wins)
	 * and notify subscribers. Enables DEC 2048 in-band resize when 2048 resolves
	 * supported.
	 */
	#resolvePrivateMode(mode: number, supported: boolean): void {
		if (this.#privateModeSupport.has(mode)) return;
		this.#privateModeSupport.set(mode, supported);
		for (const cb of this.#privateModeCallbacks) {
			try {
				cb(mode, supported);
			} catch {
				// Ignore subscriber errors — capability reporting must not crash input.
			}
		}
		if (mode === 2048 && supported) this.#enableInBandResize();
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
	 * window) or carry `:`-subparameters the parser skips, leaving the getters
	 * pinned to the old size — which freezes the rendered width because the
	 * renderer reflows against {@link columns}/{@link rows}, not the live OS
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
		if (this.#headless) return;
		// Unregister from emergency cleanup
		if (activeTerminal === this) {
			activeTerminal = null;
		}

		if (this.#clearProgressTimer()) {
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Leave paint-time terminal modes even if the process exits between the
		// begin/end halves of a frame. Safe no-ops on terminals that ignored them.
		this.#safeWrite("\x1b[?2026l\x1b[?7h");

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
		this.#appearanceCallbacks = [];
		this.#osc11Pending = false;
		this.#osc11QueryQueued = false;
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
		this.#inputHandler = undefined;
		this.#appearance = undefined;
		if (this.#stdoutResizeListener) {
			process.stdout.removeListener("resize", this.#stdoutResizeListener);
			this.#stdoutResizeListener = undefined;
		}
		this.#resizeHandler = undefined;

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.#wasRaw);
		}
		this.#stdoutErrorCleanup?.();
		this.#stdoutErrorCleanup = undefined;
	}

	#ensureStdoutErrorHandler(): void {
		this.#stdoutErrorCleanup ??= registerStdoutErrorHandler(this.#stdoutErrorHandler);
	}

	#markTerminalWriteFailed(err: unknown): void {
		if (this.#dead) return;
		this.#dead = true;
		logger.warn("terminal write failed; disabling terminal rendering", { err });
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
			if (isConPTYHosted() && Buffer.byteLength(data, "utf8") > MAX_CONPTY_WRITE_CHUNK_BYTES) {
				for (const chunk of chunkForConPTY(data, MAX_CONPTY_WRITE_CHUNK_BYTES)) {
					if (this.#dead) break;
					process.stdout.write(chunk);
				}
			} else {
				process.stdout.write(data);
			}
		} catch (err) {
			this.#markTerminalWriteFailed(err);
		}
	}

	get columns(): number {
		if (this.#inBandResizeActive && this.#reportedColumns) return this.#reportedColumns;
		return process.stdout.columns || Number(Bun.env.COLUMNS) || 80;
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

	hideCursor(): void {
		this.#safeWrite("\x1b[?25l");
	}

	showCursor(): void {
		this.#safeWrite("\x1b[?25h");
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
