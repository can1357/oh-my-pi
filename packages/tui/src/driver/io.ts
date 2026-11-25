/**
 * The seam between the two halves of the process terminal driver.
 *
 * The input half (`driver/process`) owns raw mode, stdin decoding, probes,
 * capabilities, resize, title and the keyboard/mouse/paste modes. The writer
 * half (`driver/output`) owns frames, history and the screen buffers. The
 * writer composes both into a {@link TerminalDriver}: it hands the input half
 * a {@link TerminalPort} (every mode toggle and probe the input half emits goes
 * through the writer's queue, so ordering with frames is preserved) and
 * forwards the shared members of {@link TerminalInput} verbatim.
 */
import type { NotifyProtocol, TerminalId } from "./caps/identity";
import type { InputEvent, TerminalCapabilities, TerminalDriver } from "./contract";
import type { MultiplexerId } from "./mux/detect";

/** Where the input half writes its mode toggles and probe queries. */
export interface TerminalPort {
	write(data: string): void;
}

/** The terminal's identity: what environment detection and probes concluded. */
export interface TerminalIdentity {
	/** Identity-table id (`kitty`, `ghostty`, `iterm2`, …; `trueColor`/`base` when unknown). */
	readonly id: TerminalId;
	/** Innermost multiplexer layer, including ones the contract does not name (`herdr`, `cmux`, …). */
	readonly multiplexer: MultiplexerId | null;
	readonly ssh: boolean;
	/** A Windows pseudoconsole (native Windows or WSL) sits between us and the terminal. */
	readonly conpty: boolean;
	/** XTVERSION reply (`kitty(0.39.1)`, `tmux 3.5a`), once received. */
	readonly version: string | null;
	/** The emulator's in-band notification sequence. */
	readonly notify: NotifyProtocol;
	/** The terminal confirmed structured OSC 99 notifications (title/body) to the startup probe. */
	readonly richNotifications: boolean;
	/** The terminal took the bundled private-use icons over the Glyph Protocol (they render without a patched font). */
	readonly glyphs: boolean;
}

/** Bytes the writer must emit around alternate-screen switches so key reporting survives them. */
export interface KeyboardScreenModes {
	/** Append right after `CSI ? 1049 h`. */
	readonly enterAlt: string;
	/** Emit right before `CSI ? 1049 l`. */
	readonly leaveAltBefore: string;
	/** Emit right after `CSI ? 1049 l`. */
	readonly leaveAltAfter: string;
}

/** Mouse reporting granularity (SGR encoding is always requested). */
export type MouseTracking = "off" | "click" | "drag" | "any";

/** Hardware cursor shape (DECSCUSR); `default` is the one the user configured. */
export type CursorShape = "default" | "block" | "underline" | "bar";

/** The input/lifecycle half of a {@link TerminalDriver}. */
export interface TerminalInput extends Pick<
	TerminalDriver,
	"columns" | "rows" | "capabilities" | "start" | "onInput" | "onResize" | "onCapabilities" | "setTitle"
> {
	readonly identity: TerminalIdentity;
	/** Quiesce input and consume trailing replies in raw mode before a graceful or fatal handoff. */
	drainInput?(flush: () => Promise<void>): Promise<void>;
	/** Relinquish stdin synchronously (also works when a drain is in progress). */
	stop(): void;
	/** Current alternate-screen keyboard bytes (they change once the keyboard probe settles). */
	keyboardScreenModes(): KeyboardScreenModes;
	setMouse(tracking: MouseTracking): void;
	/** Re-query the background color (OSC 11); the answer arrives through `onCapabilities`. */
	refreshAppearance(): void;
	/** Ask for the cursor position (CPR); null when the terminal does not answer in time. */
	queryCursor(): Promise<{ readonly row: number; readonly col: number } | null>;
	/** `sequence` wrapped so it reaches the outer terminal through the multiplexer. */
	passthrough(sequence: string): string;
	/** Show or clear the terminal's progress indicator (OSC 9;4). */
	setProgress(active: boolean): void;
	/** Set the hardware cursor's shape; a stop hands the user's own back. */
	setCursorShape(shape: CursorShape): void;
	/** Output must re-assert bracketed paste ahead of each write (the host may reset it). */
	readonly rearmsPaste: boolean;
	/** The terminal went away (stdin ended, closed or failed) while started. */
	onDisconnect(listener: (reason: string) => void): () => void;
	/**
	 * A Tern pane (`TERM_PROGRAM=tern`) got the TSP `hello` with the startup
	 * probes: a host may render natively before the reply arrives. False
	 * before `start()` and where the `hello` was not sent.
	 */
	readonly tspExpected: boolean;
	/**
	 * `listener` runs when the startup batch that carried the TSP `hello`
	 * settles (its DA1 answer, or the reply deadline): a `hello` reply not seen
	 * by then is not coming. Never under tmux, which answers DA1 itself.
	 */
	onHelloSettled(listener: () => void): () => void;
}

export type { InputEvent, TerminalCapabilities };
