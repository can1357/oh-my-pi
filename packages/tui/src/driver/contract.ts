/**
 * The driver contract: what the backends need from the terminal.
 *
 * `driver/*` implements it from scratch (raw mode, input decoding, probes,
 * the frame writer, images); the terminal backend (`term/*`) and the native
 * backend (`native/*`) only talk to these interfaces.
 */
import type { KeyEvent, PasteEvent } from "../events";
import type { EmojiSupport } from "../theme/contract";

/** A mouse report (SGR), in screen cells (0-based). */
export interface MouseEvent {
	readonly row: number;
	readonly col: number;
	readonly button: "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "wheel-left" | "wheel-right" | "none";
	readonly action: "press" | "release" | "move" | "drag";
	readonly mods: readonly ("shift" | "alt" | "ctrl")[];
}

/** Everything the driver decodes from stdin. */
export type InputEvent =
	| { readonly type: "key"; readonly key: KeyEvent }
	| { readonly type: "paste"; readonly paste: PasteEvent }
	| { readonly type: "mouse"; readonly mouse: MouseEvent }
	| { readonly type: "focus"; readonly focused: boolean }
	/** An OSC sequence the driver does not consume itself (raw, terminator included). */
	| { readonly type: "osc"; readonly raw: string }
	/** A Tern Surface Protocol message from the terminal (APC `tsp;…`), body still encoded. */
	| {
			readonly type: "tsp";
			readonly verb: string;
			readonly params: Readonly<Record<string, string>>;
			readonly body: string;
	  };

/** What the driver knows about the terminal (probed or from the environment); fields fill in as replies arrive. */
export interface TerminalCapabilities {
	readonly truecolor: boolean;
	readonly colors: 16 | 256 | 16_777_216;
	readonly synchronizedOutput: boolean;
	readonly hyperlinks: boolean;
	/** Draws Kitty's OSC 66 sized text (multicell glyphs); never through a multiplexer. */
	readonly textSizing: boolean;
	readonly images: "kitty" | "sixel" | "iterm" | null;
	readonly kittyKeyboard: boolean;
	readonly bracketedPaste: boolean;
	/** Background color reported by OSC 11, if trusted. */
	readonly background: { readonly r: number; readonly g: number; readonly b: number } | null;
	readonly dark: boolean;
	/** Cell size in pixels, when reported. */
	readonly cell: { readonly w: number; readonly h: number } | null;
	/** The multiplexer the program runs in, if any. */
	readonly multiplexer: "tmux" | "zellij" | "screen" | null;
	/** A Tern terminal answered the TSP hello: native rendering is possible. */
	readonly tsp: boolean;
	/** How emoji-capable glyphs advance and draw (profile, refined by the DECRQM 2027 reply or a width probe). */
	readonly emoji: EmojiSupport;
}

/** Control sequences that must bracket one newly committed history row in the same write. */
export interface HistoryRowMark {
	readonly row: number;
	readonly before: string;
	readonly after: string;
}

/** A frame the terminal backend asks the writer to show. */
export interface FramePlan {
	/**
	 * Rows to append to terminal history exactly once, with a monotonic id the
	 * writer acknowledges after writing (`replay` replaces history after a
	 * clear, see the renderer contract in docs/tui-core-renderer.md).
	 */
	readonly history?: {
		readonly id: number;
		readonly rows: readonly string[];
		readonly kind?: "append" | "replay";
		/** Marks for new rows only; omitted from the portion that replays old history. */
		readonly marks?: readonly HistoryRowMark[];
	};
	/** The complete mutable screen image anchored below history (no row wider than the screen). */
	readonly viewport: readonly string[];
	/** Hardware cursor inside the viewport, or null to hide it. */
	readonly cursor: { readonly row: number; readonly col: number } | null;
	/** A fullscreen layer drawn on the alternate screen instead of the inline viewport. */
	readonly fullscreen?: readonly string[];
}

/** The inline-image side of a driver, as the frame loop needs it. */
export interface FrameImageSettler {
	/**
	 * After painting a frame: true when the image budget demoted or restored
	 * images, so the frame must be painted again before it is presented.
	 */
	settle(): boolean;
}

/** The terminal a backend renders to. */
export interface TerminalDriver {
	readonly columns: number;
	readonly rows: number;
	readonly capabilities: TerminalCapabilities;
	/** Start raw mode, probes and input; resolves once the initial probes settled (bounded wait). */
	start(): Promise<void>;
	/** Restore the terminal (modes, cursor, title) and flush. */
	stop(): Promise<void>;
	/** Show a frame; returns the history id it wrote, if any (the acknowledgement). */
	present(frame: FramePlan): number | undefined;
	/**
	 * Hold every write: frames, resize transactions and the probes they start.
	 * The release repaints in place at the geometry the terminal settled on.
	 * `notice` paints one hint row on the last screen row without scrolling.
	 */
	setOutputHold?(hold: boolean, notice?: string): void;
	/** Screen row mapped into the displayed viewport; null outside it or when its anchor is unknown. Omitted by screen-origin drivers. */
	viewportRow?(screenRow: number): number | null;
	/** Write raw bytes (protocol messages, images); bypasses frame diffing. */
	writeRaw(data: string): void;
	onInput(listener: (event: InputEvent) => void): () => void;
	onResize(listener: (columns: number, rows: number) => void): () => void;
	/** Capabilities changed (late probe replies, appearance switch). */
	onCapabilities(listener: (capabilities: TerminalCapabilities) => void): () => void;
	/**
	 * The display lost its history (display reset, settled resize under a
	 * replaying policy): the next frame must carry a `replay` history batch
	 * with the whole ledger at the current width, under a fresh id.
	 */
	onReplay(listener: () => void): () => void;
	/** Inline images, when the driver draws them (painters reach the store through the driver's own type). */
	readonly images?: FrameImageSettler;
	/** Clear terminal history and the screen (explicit display resets only). */
	resetDisplay(): void;
	/**
	 * Whether a width change replays history at the new width (the `rebuild`
	 * and `append` scrollback policies); false when history keeps its old
	 * width (`preserve`, in-place resize). Absent: true.
	 */
	replaysOnResize?(): boolean;
	setTitle(title: string): void;
}
