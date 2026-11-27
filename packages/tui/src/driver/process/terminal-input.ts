/**
 * The input/lifecycle half of the process terminal driver: raw mode, the
 * stdin decoder, terminal modes, startup probes and their typed reply owners,
 * capabilities, resize, title, mouse and cursor queries.
 *
 * Probe batches end in a DA1 query (`CSI c`). Every terminal answers DA1,
 * and answers in order, so each batch's DA1 reply (`CSI ? … c`) is its
 * sentinel: queries of the batch that got no answer by then are unsupported.
 * Sentinels form a FIFO matched to replies in send order; stray DA1 replies
 * are swallowed all the same.
 */
import { enableConsoleVtInput, restoreConsoleInputMode } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { isDarkBackground } from "../caps/color";
import { detectTerminal } from "../caps/detect";
import { rawBackspaceIsCtrl, synchronizedOutputOverride } from "../caps/env";
import type { InputEvent, TerminalCapabilities } from "../contract";
import { type Clock, systemClock } from "../input/clock";
import { GLYPH_CONFIRMATION_CODEPOINT, GLYPH_SUPPORT_QUERY, glyphRegistrations, parseGlyphReply } from "../glyphs";
import { InputDecoder, type InputDecoderOptions } from "../input/decoder";
import type { TerminalReply } from "../input/replies";
import type {
	CursorShape,
	KeyboardScreenModes,
	MouseTracking,
	TerminalIdentity,
	TerminalInput,
	TerminalPort,
} from "../io";
import { isTernPane, TERMINAL_PROFILES, type TerminalId } from "../caps/identity";
import {
	type Env,
	hasMultiplexerSession,
	insideMultiplexer,
	isHerdrDesktopTerminal,
	isSsh,
	type MultiplexerId,
	multiplexerOwnsColorScheme,
} from "../mux/detect";
import {
	setTmuxPaneApcTitles,
	spawnTmux,
	type TmuxRunner,
	tmuxClientRendersSixel,
	tmuxSessionSpeaksTsp,
	wrapPassthrough,
} from "../mux/tmux";

/** The stdin surface the input half needs (process.stdin satisfies it). */
export interface TtyInput {
	readonly isTTY?: boolean;
	readonly isRaw?: boolean;
	setRawMode?(mode: boolean): unknown;
	on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
	off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
	/** The terminal went away (pane closed, SSH dropped). */
	on(event: "end" | "close" | "error", listener: () => void): unknown;
	off(event: "end" | "close" | "error", listener: () => void): unknown;
	resume(): unknown;
	pause(): unknown;
}

/** The stdout surface the input half reads geometry from (process.stdout satisfies it). */
export interface TtyOutput {
	readonly columns?: number;
	readonly rows?: number;
	on(event: "resize", listener: () => void): unknown;
	off(event: "resize", listener: () => void): unknown;
}

/** Process-level events: SIGWINCH and exit. */
export interface ProcessEvents {
	on(event: "SIGWINCH" | "exit", listener: () => void): unknown;
	off(event: "SIGWINCH" | "exit", listener: () => void): unknown;
}

export interface ProcessInputOptions {
	readonly stdin?: TtyInput;
	readonly stdout?: TtyOutput;
	readonly events?: ProcessEvents;
	readonly env?: Env;
	readonly platform?: NodeJS.Platform;
	readonly clock?: Clock;
	/** A Windows pseudoconsole sits between us and the terminal (default: Windows or WSL). */
	readonly conpty?: boolean;
	/** We own a native Windows console (default: Windows and not served by sshd). */
	readonly nativeWindowsConsole?: boolean;
	/** Bounded wait of `start()` for the startup probes. */
	readonly probeTimeoutMs?: number;
	/** A probe batch without its DA1 answer expires after this long. */
	readonly replyTimeoutMs?: number;
	/** An encoded TSP `q hello` to send with the startup probes; its `r hello` answer sets `capabilities.tsp`. */
	readonly hello?: string;
	/** Event-loop stall probe for raw multi-line bursts. */
	readonly isLoopStalled?: () => boolean;
	/** Runs tmux for the client identity and passthrough lookups. */
	readonly tmux?: TmuxRunner;
	/** The Windows console input mode switch (native console only). Default: `@oh-my-pi/pi-natives`. */
	readonly consoleMode?: ConsoleMode;
	readonly decoder?: Omit<InputDecoderOptions, "clock" | "backspaceIsCtrl">;
}

/** Turns on VT input on a native Windows console; returns the previous mode to restore. */
export interface ConsoleMode {
	enable(): number | null;
	restore(mode: number): void;
}

const nativeConsoleMode: ConsoleMode = {
	enable: () => enableConsoleVtInput(),
	restore: mode => {
		restoreConsoleInputMode(mode);
	},
};

const DA1 = "\x1b[c";
/** Bound a shutdown drain even on a silent terminal. After the barrier, wait out one quiet input window. */
const DRAIN_MAX_MS = 1000;
const DRAIN_IDLE_MS = 50;
/**
 * Startup probes go out between these: cursor saved, autowrap off and text
 * concealed, so a reply a terminal echoes instead of answering (or a query it
 * prints) cannot scroll or show, and the cursor comes back where it was.
 */
const PROBE_GUARD_BEGIN = "\x1b7\x1b[?7l\x1b[8m";
const PROBE_GUARD_END = "\x1b[28m\x1b[?7h\x1b8";
/**
 * Normal cursor keys (DECCKM off) and numeric keypad (`rmkx`): a program that
 * left application mode on makes arrows arrive as SS3; reset on entry and on
 * exit so the shell after us does not inherit it either.
 */
const NORMAL_KEYS = "\x1b[?1l\x1b>";
/** OSC 9;4 progress: indeterminate, and cleared. */
const PROGRESS_ACTIVE = "\x1b]9;4;3\x07";
const PROGRESS_CLEAR = "\x1b]9;4;0;\x07";
const PROGRESS_KEEPALIVE_MS = 1000;
/** tmux answers OSC 11 from a cache; an explicit refresh updates it from the outer terminal first. */
const TMUX_BACKGROUND_CACHE_MS = 100;
/** OSC 99 capability query ids: unique per probe within the process. */
let nextNotifyProbe = 1;
/** DECSCUSR parameters (steady shapes; 0 hands the shape back to the terminal's configuration). */
const CURSOR_SHAPES: Readonly<Record<CursorShape, number>> = { default: 0, block: 2, underline: 4, bar: 6 };
const MOUSE_MODES: Readonly<Record<Exclude<MouseTracking, "off">, number>> = { click: 1000, drag: 1002, any: 1003 };
/**
 * Stop and crash restore turn off every mouse mode the driver can set, whoever
 * set it (clearing an unset mode is harmless): SGR-pixel, SGR, any, drag, click.
 */
const MOUSE_RESET = "\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
/**
 * Terminals whose SGR-pixel reports (DECSET 1016) are verified to be device
 * pixels matching the reported cell size. DECRQM confirms the mode, not its
 * units (iTerm2 reports logical points).
 */
const PIXEL_MOUSE_TERMINALS: Readonly<Partial<Record<TerminalId, true>>> = {
	kitty: true,
	ghostty: true,
	wezterm: true,
};
/** Mode 2031 notifications coalesce into one OSC 11 re-query. */
const SCHEME_DEBOUNCE_MS = 100;
/** Windows Terminal has no Mode 2031; its background is polled instead. */
const WINDOWS_APPEARANCE_POLL_MS = 30_000;
const CPR_TIMEOUT_MS = 500;
/**
 * How long, in a Herdr desktop terminal, an applied DEC 2048 report that
 * disagrees with the pty size waits for the SIGWINCH that makes them agree.
 */
const HERDR_INBAND_SETTLE_MS = 500;

interface Sentinel {
	settled: boolean;
	settle(): void;
}

function sameCapabilities(a: TerminalCapabilities, b: TerminalCapabilities): boolean {
	for (const key in a) {
		const field = key as keyof TerminalCapabilities;
		if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) return false;
	}
	return true;
}

export class ProcessTerminalInput implements TerminalInput {
	readonly #port: TerminalPort;
	readonly #stdin: TtyInput;
	readonly #stdout: TtyOutput;
	readonly #events: ProcessEvents;
	readonly #env: Env;
	readonly #platform: NodeJS.Platform;
	readonly #clock: Clock;
	readonly #wsl: boolean;
	readonly #conpty: boolean;
	readonly #nativeConsole: boolean;
	readonly #probeTimeoutMs: number;
	readonly #replyTimeoutMs: number;
	readonly #hello: string | undefined;
	readonly #decoder: InputDecoder;
	readonly #multiplexer: MultiplexerId | null;
	readonly #tmux: TmuxRunner;
	readonly #consoleMode: ConsoleMode;
	/** OSC 11 answers describe the terminal (Zellij on macOS breaks the passthrough). */
	readonly #backgroundTrusted: boolean;
	/** A multiplexer answers CSI ?996n with its own light/dark mode (Zellij); see `multiplexerOwnsColorScheme`. */
	readonly #schemeOwner: boolean;
	/** In-band reports yield to the pty size once they disagree for long (see `#armHerdrSettle`). */
	readonly #ptyOwnsSize: boolean;
	readonly #baseline: TerminalCapabilities;
	readonly #inputListeners = new Set<(event: InputEvent) => void>();
	readonly #resizeListeners = new Set<(columns: number, rows: number) => void>();
	readonly #capabilityListeners = new Set<(capabilities: TerminalCapabilities) => void>();
	readonly #disconnectListeners = new Set<(reason: string) => void>();
	readonly #helloSettledListeners = new Set<() => void>();

	#identity: TerminalIdentity;
	#capabilities: TerminalCapabilities;
	#started = false;
	#drain: { promise: Promise<void>; activity(): void; da1(): void; finish(): void } | undefined;
	#wasRaw = false;
	/** The `hello` went out with this start's mode probes. */
	#helloSent = false;
	#size: { columns: number; rows: number };
	#sentinels: Sentinel[] = [];
	/** Counts sent queries until the actual reply, even if its probe owner already timed out. */
	#unansweredDa1 = 0;
	#cancels = new Set<() => void>();

	// Keyboard negotiation.
	#kittyFlags: number | null = null;
	#modifyOtherKeys = false;
	#win32Input = false;
	// Modes enabled after DECRQM confirmed them, restored on stop.
	#inBandResize = false;
	#colorSchemeReports = false;
	#restoreModes: number[] = [];
	/** The alternate-scroll state (1007) this session set; undefined: untouched. */
	#alternateScroll: boolean | undefined;
	/** The terminal's own 1007 state from DECRQM; null when it did not say. */
	#alternateScrollOriginal: boolean | null = null;
	/** DECRQM answered 1016 as a mode it knows (set or reset). */
	#pixelMouseReported = false;
	/** SGR-pixel reporting is on (only ever with mouse tracking). */
	#pixelMouse = false;
	#mouse: MouseTracking = "off";
	#titlePushed = false;
	/** Re-assert bracketed paste before input and output: some hosts reset it (iTerm2's state toggle, tmux panes). */
	#rearmPaste = false;
	/** Glyph Protocol handshake step awaiting a reply. */
	#glyphPhase: "idle" | "support" | "confirm" = "idle";
	/** tmux pane APC titles were turned off for TSP (restored on stop). */
	#tmuxApcTitlesOff = false;
	/** Console input mode to put back (native Windows console). */
	#savedConsoleMode: number | null = null;
	#progress = false;
	#cancelProgress: (() => void) | null = null;
	/** The cursor shape last written; undefined until one is set (and after a stop restored the user's). */
	#cursorShape: CursorShape | undefined;
	// Appearance.
	#backgroundQuery: Sentinel | null = null;
	#backgroundQueued = false;
	#schemeDebounce: (() => void) | null = null;
	/** Last CSI ?997 report from a multiplexer that owns the color scheme; it outranks OSC 11 luminance. */
	#reportedDark: boolean | null = null;
	// OSC 99 capability query id while it is pending.
	#notifyProbe: string | null = null;
	// Graphics.
	#sixelAdvertised = false;
	#sixelGeometry = false;
	#forcedImages: boolean;
	/** The attached tmux client draws SIXEL (asked once). */
	#tmuxClientSixel: boolean | undefined;
	// Cursor position.
	#cpr: PromiseWithResolvers<{ row: number; col: number } | null> | null = null;
	/** Herdr only: drops an applied in-band report the pty size has not come to match. */
	#cancelHerdrSettle: (() => void) | null = null;

	constructor(port: TerminalPort, options: ProcessInputOptions = {}) {
		this.#port = port;
		this.#stdin = options.stdin ?? process.stdin;
		this.#stdout = options.stdout ?? process.stdout;
		this.#events = options.events ?? process;
		this.#env = options.env ?? Bun.env;
		this.#platform = options.platform ?? process.platform;
		this.#clock = options.clock ?? systemClock;
		this.#probeTimeoutMs = options.probeTimeoutMs ?? 250;
		this.#replyTimeoutMs = options.replyTimeoutMs ?? 5000;
		this.#hello = options.hello;
		const env = this.#env;
		const detected = detectTerminal(env, { platform: this.#platform, conpty: options.conpty, tmux: options.tmux });
		this.#wsl = detected.wsl;
		this.#conpty = detected.identity.conpty;
		this.#nativeConsole = options.nativeWindowsConsole ?? (this.#platform === "win32" && !isSsh(env));
		this.#multiplexer = detected.identity.multiplexer;
		this.#tmux = options.tmux ?? spawnTmux;
		this.#consoleMode = options.consoleMode ?? nativeConsoleMode;
		this.#backgroundTrusted = !(this.#platform === "darwin" && hasMultiplexerSession("zellij", env));
		this.#schemeOwner = multiplexerOwnsColorScheme(env);
		// A grid-owning multiplexer inside the Herdr terminal (one known only by TERM
		// included) owns its own pty, so its reports keep their precedence.
		this.#ptyOwnsSize = isHerdrDesktopTerminal(env) && !insideMultiplexer(env);
		this.#identity = detected.identity;
		this.#baseline = detected.capabilities;
		this.#capabilities = this.#baseline;
		this.#forcedImages = env.PI_FORCE_IMAGE_PROTOCOL !== undefined && env.PI_FORCE_IMAGE_PROTOCOL !== "";
		this.#size = this.#osSize();

		this.#decoder = new InputDecoder(
			{ input: event => this.#onInput(event), reply: reply => this.#onReply(reply) },
			{ ...options.decoder, clock: this.#clock, backspaceIsCtrl: rawBackspaceIsCtrl(env) },
		);
		this.#decoder.isStalled = options.isLoopStalled;
	}

	get columns(): number {
		return this.#size.columns;
	}

	get rows(): number {
		return this.#size.rows;
	}

	get capabilities(): TerminalCapabilities {
		return this.#capabilities;
	}

	get identity(): TerminalIdentity {
		return this.#identity;
	}

	/** Output should re-assert bracketed paste (`CSI ? 2004 h`) ahead of each write. */
	get rearmsPaste(): boolean {
		return this.#started && this.#rearmPaste;
	}

	onInput(listener: (event: InputEvent) => void): () => void {
		this.#inputListeners.add(listener);
		return () => this.#inputListeners.delete(listener);
	}

	onResize(listener: (columns: number, rows: number) => void): () => void {
		this.#resizeListeners.add(listener);
		return () => this.#resizeListeners.delete(listener);
	}

	onCapabilities(listener: (capabilities: TerminalCapabilities) => void): () => void {
		this.#capabilityListeners.add(listener);
		return () => this.#capabilityListeners.delete(listener);
	}

	onDisconnect(listener: (reason: string) => void): () => void {
		this.#disconnectListeners.add(listener);
		return () => this.#disconnectListeners.delete(listener);
	}

	get tspExpected(): boolean {
		return this.#started && this.#helloSent && isTernPane(this.#env);
	}

	onHelloSettled(listener: () => void): () => void {
		this.#helloSettledListeners.add(listener);
		return () => this.#helloSettledListeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#enterRawMode();
		this.#stdin.on("data", this.#onData);
		this.#stdin.on("end", this.#onEnd);
		this.#stdin.on("close", this.#onClose);
		this.#stdin.on("error", this.#onError);
		this.#stdin.resume();
		this.#stdout.on("resize", this.#onOsResize);
		if (this.#platform !== "win32") this.#events.on("SIGWINCH", this.#onOsResize);
		this.#events.on("exit", this.#onExit);
		this.#size = this.#osSize();
		if (this.#nativeConsole) this.#savedConsoleMode = this.#consoleMode.enable();
		// tmux forwards paste markers only while the pane's own 2004 flag is set, and may not answer DECRQM 2004.
		this.#rearmPaste = this.#multiplexer === "tmux";

		this.#port.write(`\x1b[?2004h${NORMAL_KEYS}${PROBE_GUARD_BEGIN}`);
		const keyboard = this.#probe("\x1b[?u", () => {
			if (this.#kittyFlags === null) this.#enableKeyboardFallback();
		});
		const background = this.#queryBackground();
		// A multiplexer that owns the color scheme answers CSI ?996n itself; that
		// CSI ?997 reply then outranks the forwarded OSC 11 background.
		if (this.#schemeOwner) this.#port.write("\x1b[?996n");
		const modes = this.#probe(this.#modeQueries(), () => this.#modesSettled());
		this.#port.write(PROBE_GUARD_END);

		const { promise: timeout, resolve } = Promise.withResolvers<void>();
		const cancel = this.#schedule(this.#probeTimeoutMs, resolve);
		await Promise.race([Promise.all([keyboard, background, modes]), timeout]);
		cancel();
	}

	/**
	 * Leave echo off and keep consuming bytes after the last frame and surface close.
	 * Only TSP has asynchronous frame acks: fence it with DA1, behind all older
	 * probe sentinels. A plain terminal needs no new query (or reply) on exit.
	 */
	drainInput(flush: () => Promise<void>): Promise<void> {
		if (this.#drain) return this.#drain.promise;
		if (!this.#started || !this.#stdin.isTTY) {
			this.stop();
			return flush();
		}
		const fence = this.#capabilities.tsp || this.tspExpected;
		let pending = fence ? this.#unansweredDa1 + 1 : 0;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let flushed = false;
		let finished = false;
		let cancelIdle: (() => void) | undefined;
		const finish = (): void => {
			finished = true;
			cancelIdle?.();
			cancelDeadline();
			resolve();
		};
		const cancelDeadline = this.#clock.schedule(DRAIN_MAX_MS, finish);
		const activity = (): void => {
			if (!flushed || finished || pending > 0) return;
			cancelIdle?.();
			cancelIdle = this.#clock.schedule(DRAIN_IDLE_MS, finish);
		};
		this.#drain = {
			promise,
			activity,
			da1: () => {
				if (pending > 0 && --pending === 0) activity();
			},
			finish,
		};
		this.#quiesce();
		if (fence) this.#port.write(DA1);
		void flush().then(() => {
			flushed = true;
			activity();
		}, reject);
		return promise;
	}

	#quiesce(): void {
		this.#started = false;
		for (const cancel of this.#cancels) cancel();
		this.#cancels.clear();
		this.#schemeDebounce = null;
		this.#reportedDark = null;
		this.#cancelHerdrSettle = null;
		while (this.#sentinels.length) this.#sentinels[0]!.settle();
		this.#unansweredDa1 = 0;
		this.#backgroundQuery = null;
		this.#backgroundQueued = false;
		if (this.#cpr) {
			this.#cpr.resolve(null);
			this.#cpr = null;
			this.#decoder.cprPending = false;
		}

		this.#port.write(this.#restoreSequence());
		this.#cursorShape = undefined;
		this.#progress = false;
		this.#cancelProgress = null;
		this.#rearmPaste = false;
	}

	stop(): void {
		if (!this.#started && !this.#drain) return;
		try {
			if (this.#started) this.#quiesce();
		} finally {
			this.#drain?.finish();
			this.#drain = undefined;
			this.#decoder.clear();
			this.#stdin.off("data", this.#onData);
			this.#stdin.off("end", this.#onEnd);
			this.#stdin.off("close", this.#onClose);
			this.#stdin.off("error", this.#onError);
			this.#stdin.pause();
			this.#stdout.off("resize", this.#onOsResize);
			if (this.#platform !== "win32") this.#events.off("SIGWINCH", this.#onOsResize);
			this.#events.off("exit", this.#onExit);
			try {
				if (this.#tmuxApcTitlesOff) {
					setTmuxPaneApcTitles(true, this.#env, this.#tmux);
					this.#tmuxApcTitlesOff = false;
				}
				if (this.#savedConsoleMode !== null) {
					this.#consoleMode.restore(this.#savedConsoleMode);
					this.#savedConsoleMode = null;
				}
			} finally {
				this.#leaveRawMode();
			}
		}

		this.#kittyFlags = null;
		this.#modifyOtherKeys = false;
		this.#win32Input = false;
		this.#decoder.kitty = false;
		this.#decoder.win32 = false;
		this.#inBandResize = false;
		this.#colorSchemeReports = false;
		this.#restoreModes = [];
		this.#mouse = "off";
		this.#pixelMouse = false;
		this.#pixelMouseReported = false;
		this.#decoder.pixelMouse = null;
		this.#alternateScroll = undefined;
		this.#alternateScrollOriginal = null;
		this.#titlePushed = false;
		this.#sixelAdvertised = false;
		this.#sixelGeometry = false;
		this.#notifyProbe = null;
		this.#glyphPhase = "idle";
		this.#helloSent = false;
		this.#identity = { ...this.#identity, richNotifications: false, glyphs: false };
		// A later start probes afresh; nothing learned from this session's terminal carries over.
		this.#update(this.#baseline);
	}

	setTitle(title: string): void {
		if (!this.#started) return;
		const clean = title.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
		let out = "";
		if (!this.#titlePushed) {
			// Save the terminal's title on its stack so stop() can put it back.
			out += "\x1b[22;0t";
			this.#titlePushed = true;
		}
		this.#port.write(`${out}\x1b]0;${clean}\x07`);
	}

	setMouse(tracking: MouseTracking): void {
		if (!this.#started) return;
		this.#applyMouse(tracking);
	}

	setAlternateScroll(enabled: boolean | undefined): void {
		if (!this.#started) return;
		if (enabled === undefined) {
			// Back to the terminal's own state: a stop then has nothing of this session's to undo.
			if (this.#alternateScroll === undefined) return;
			this.#alternateScroll = undefined;
			this.#port.write((this.#alternateScrollOriginal ?? true) ? "\x1b[?1007h" : "\x1b[?1007l");
			return;
		}
		if (enabled === this.#alternateScroll) return;
		this.#alternateScroll = enabled;
		this.#port.write(enabled ? "\x1b[?1007h" : "\x1b[?1007l");
	}

	refreshAppearance(): void {
		if (!this.#started) return;
		if (this.#multiplexer === "tmux" && this.#backgroundTrusted) {
			this.#port.write(wrapPassthrough("\x1b]11;?\x07", "tmux"));
			this.#schedule(TMUX_BACKGROUND_CACHE_MS, () => void this.#queryBackground());
			return;
		}
		void this.#queryBackground();
	}

	/** Set the hardware cursor's shape (DECSCUSR); an unchanged shape writes nothing. */
	setCursorShape(shape: CursorShape): void {
		if (!this.#started || shape === this.#cursorShape) return;
		this.#cursorShape = shape;
		this.#port.write(`\x1b[${CURSOR_SHAPES[shape]} q`);
	}

	/**
	 * Show (or clear) the terminal's indeterminate progress indicator (OSC 9;4).
	 * Terminals that expire it without a heartbeat get it re-sent every second.
	 */
	setProgress(active: boolean): void {
		if (!this.#started || active === this.#progress) return;
		this.#progress = active;
		this.#cancelProgress?.();
		this.#cancelProgress = null;
		if (!active) {
			this.#port.write(PROGRESS_CLEAR);
			return;
		}
		this.#port.write(PROGRESS_ACTIVE);
		if (!TERMINAL_PROFILES[this.#identity.id].progressKeepalive) return;
		const beat = (): void => {
			this.#cancelProgress = this.#schedule(PROGRESS_KEEPALIVE_MS, () => {
				this.#port.write(PROGRESS_ACTIVE);
				beat();
			});
		};
		beat();
	}

	queryCursor(): Promise<{ readonly row: number; readonly col: number } | null> {
		if (this.#cpr) return this.#cpr.promise;
		const request = Promise.withResolvers<{ row: number; col: number } | null>();
		this.#cpr = request;
		this.#decoder.cprPending = true;
		const cancel = this.#schedule(CPR_TIMEOUT_MS, () => this.#settleCursor(null));
		void request.promise.then(cancel);
		this.#port.write("\x1b[6n");
		return request.promise;
	}

	passthrough(sequence: string): string {
		return wrapPassthrough(sequence, this.#multiplexer);
	}

	keyboardScreenModes(): KeyboardScreenModes {
		if (this.#kittyFlags !== null) {
			// Kitty flags are per screen: push on entry, pop before leaving, and re-assert the main
			// screen's flags after (some Windows Terminal builds drop them on `?1049l`).
			return {
				enterAlt: `\x1b[>${this.#kittyFlags}u`,
				leaveAltBefore: "\x1b[<u",
				leaveAltAfter: `\x1b[=${this.#kittyFlags};1u`,
			};
		}
		// modifyOtherKeys is one global flag: re-assert on entry, never reset on exit.
		return { enterAlt: this.#modifyOtherKeys ? "\x1b[>4;2m" : "", leaveAltBefore: "", leaveAltAfter: "" };
	}

	// ── Lifecycle internals ───────────────────────────────────────────────

	#enterRawMode(): void {
		const stdin = this.#stdin;
		if (!stdin.isTTY || !stdin.setRawMode) return;
		this.#wasRaw = stdin.isRaw ?? false;
		try {
			stdin.setRawMode(true);
		} catch (error) {
			logger.warn("failed to enable raw mode", { error: String(error) });
		}
	}

	#leaveRawMode(): void {
		const stdin = this.#stdin;
		if (!stdin.isTTY || !stdin.setRawMode) return;
		try {
			stdin.setRawMode(this.#wasRaw);
		} catch (error) {
			// A revoked pty (terminal closed) cannot be restored and needs no restoring.
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EIO" || code === "EBADF" || code === "ENXIO" || code === "ENOTTY") return;
			throw error;
		}
	}

	#restoreSequence(): string {
		let out = this.#progress ? PROGRESS_CLEAR : "";
		if (this.#kittyFlags !== null) out += "\x1b[<u";
		if (this.#modifyOtherKeys) out += "\x1b[>4;0m";
		if (this.#win32Input) out += "\x1b[?9001l";
		if (this.#inBandResize) out += "\x1b[?2048l";
		if (this.#colorSchemeReports) out += "\x1b[?2031l";
		for (const mode of this.#restoreModes) out += `\x1b[?${mode}h`;
		// 5522 (enhanced paste) is the app's to turn on; a handoff must never leave it set for the next program.
		out += "\x1b[?2004l\x1b[?5522l";
		// The user's own cursor shape: a Vim Normal-mode block must not outlive the session in their shell.
		if (this.#cursorShape !== undefined && this.#cursorShape !== "default") out += "\x1b[0 q";
		// Mouse reporting off whoever turned it on (a program that shared the terminal may have left it set),
		// then the terminal's own alternate scroll back; unreported, it is on by convention.
		out += MOUSE_RESET;
		if (this.#alternateScroll !== undefined)
			out += (this.#alternateScrollOriginal ?? true) ? "\x1b[?1007h" : "\x1b[?1007l";
		out += NORMAL_KEYS;
		if (this.#titlePushed) out += "\x1b[23;0t";
		return out;
	}

	readonly #onExit = (): void => {
		try {
			this.stop();
		} catch (error) {
			logger.warn("failed to restore raw mode on exit", { error: String(error) });
		}
	};

	#disconnected(reason: string): void {
		if (!this.#started) return;
		for (const listener of this.#disconnectListeners) listener(reason);
	}

	readonly #onEnd = (): void => this.#disconnected("stdin ended");
	readonly #onClose = (): void => this.#disconnected("stdin closed");
	readonly #onError = (): void => this.#disconnected("stdin failed");

	readonly #onData = (chunk: Buffer | string): void => {
		// Recover a mode the host reset before the user's next paste (not mid-paste: one write per read).
		if (this.#drain) this.#drain.activity();
		else if (this.#rearmPaste && !this.#decoder.inPaste) this.#port.write("\x1b[?2004h");
		this.#decoder.process(chunk);
	};

	#osSize(): { columns: number; rows: number } {
		const columns = this.#stdout.columns;
		const rows = this.#stdout.rows;
		return { columns: columns && columns > 0 ? columns : 80, rows: rows && rows > 0 ? rows : 24 };
	}

	readonly #onOsResize = (): void => {
		// A font zoom changes the cell's pixel size; without in-band reports carrying it, ask again.
		if (this.#started && this.#pixelMouse && !this.#inBandResize) this.#port.write("\x1b[16t");
		this.#resize(this.#osSize());
	};

	/** The pty size, keeping the current dimension where stdout reports none. */
	#ptySize(): { columns: number; rows: number } {
		const columns = this.#stdout.columns;
		const rows = this.#stdout.rows;
		return {
			columns: columns && columns > 0 ? columns : this.#size.columns,
			rows: rows && rows > 0 ? rows : this.#size.rows,
		};
	}

	/**
	 * In a Herdr desktop terminal, drop an applied in-band report once it has
	 * disagreed with the pty size for {@link HERDR_INBAND_SETTLE_MS}. Herdr
	 * reports the smaller size of a peek but sends no report when the terminal
	 * returns to its pane. Read after that return's SIGWINCH (or with the peek's
	 * SIGWINCH coalesced away while the event loop was busy), the peek report
	 * pinned rows and columns to the peek until the next OS resize. Herdr keeps
	 * the pty size in step with the pane, so the pty wins there; elsewhere
	 * in-band stays authoritative, as it can be more accurate than the ioctl
	 * under multiplexers. The report's cell pixel size is kept.
	 */
	#armHerdrSettle(): void {
		this.#cancelHerdrSettle?.();
		this.#cancelHerdrSettle = null;
		if (!this.#ptyOwnsSize) return;
		const pty = this.#ptySize();
		if (pty.columns === this.#size.columns && pty.rows === this.#size.rows) return;
		this.#cancelHerdrSettle = this.#schedule(HERDR_INBAND_SETTLE_MS, () => {
			this.#cancelHerdrSettle = null;
			this.#resize(this.#ptySize());
		});
	}

	#resize(size: { columns: number; rows: number }): void {
		if (size.columns === this.#size.columns && size.rows === this.#size.rows) return;
		this.#size = size;
		for (const listener of this.#resizeListeners) listener(size.columns, size.rows);
	}

	#schedule(ms: number, fn: () => void): () => void {
		const cancel = this.#clock.schedule(ms, () => {
			this.#cancels.delete(cancel);
			fn();
		});
		this.#cancels.add(cancel);
		return () => {
			this.#cancels.delete(cancel);
			cancel();
		};
	}

	#update(patch: Partial<TerminalCapabilities>): void {
		const merged = { ...this.#capabilities, ...patch };
		const next = { ...merged, pixelMouse: this.#pixelMouseAvailable(merged.cell) };
		if (sameCapabilities(next, this.#capabilities)) return;
		this.#capabilities = next;
		// A new cell size or a pixel-mode verdict takes effect on running mouse tracking at once.
		if (this.#started) this.#applyMouse(this.#mouse);
		for (const listener of this.#capabilityListeners) listener(next);
	}

	/** SGR-pixel reporting may accompany mouse tracking: verified units, DECRQM confirmed 1016, a known cell size. */
	#pixelMouseAvailable(cell: TerminalCapabilities["cell"]): boolean {
		return (
			PIXEL_MOUSE_TERMINALS[this.#identity.id] === true &&
			this.#pixelMouseReported &&
			cell !== null &&
			cell.w > 0 &&
			cell.h > 0
		);
	}

	/**
	 * Move mouse reporting to `tracking`, with SGR-pixel reporting on top
	 * wherever `pixelMouse` holds. 1006 and 1016 select one coordinate
	 * encoding between them: resetting 1016 falls back to X10, so SGR is
	 * re-asserted, and 1016 goes after every 1006 set.
	 */
	#applyMouse(tracking: MouseTracking): void {
		const cell = this.#capabilities.cell;
		const pixel = tracking !== "off" && this.#capabilities.pixelMouse && cell !== null;
		let out = "";
		if (this.#pixelMouse && !pixel) out += "\x1b[?1016l";
		if (tracking !== this.#mouse) {
			if (this.#mouse !== "off") out += `\x1b[?${MOUSE_MODES[this.#mouse]}l`;
			out += tracking === "off" ? "\x1b[?1006l" : `\x1b[?${MOUSE_MODES[tracking]}h\x1b[?1006h`;
		} else if (this.#pixelMouse && !pixel) {
			out += "\x1b[?1006h";
		}
		if (pixel && (!this.#pixelMouse || tracking !== this.#mouse)) out += "\x1b[?1016h";
		this.#mouse = tracking;
		this.#pixelMouse = pixel;
		// Herdr panes number pixels from 0 as well, whatever terminal hosts them.
		const zeroBased =
			this.#identity.id === "kitty" || this.#identity.id === "ghostty" || this.#identity.multiplexer === "herdr";
		this.#decoder.pixelMouse = pixel && cell ? { w: cell.w, h: cell.h, origin: zeroBased ? 0 : 1 } : null;
		if (out) this.#port.write(out);
	}

	#onInput(event: InputEvent): void {
		if (!this.#started) return;
		if (event.type === "tsp" && event.verb === "r" && !this.#capabilities.tsp) {
			try {
				const reply = JSON.parse(event.body) as { r?: unknown };
				if (reply.r === "hello") this.#update({ tsp: true });
			} catch {
				// Not JSON: not a hello reply.
			}
		}
		for (const listener of this.#inputListeners) listener(event);
	}

	// ── Probes ────────────────────────────────────────────────────────────

	/** Write `queries` followed by a DA1 sentinel; `onSettle` runs once its answer (or the expiry) arrives. */
	#probe(queries: string, onSettle: () => void): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const sentinel: Sentinel = {
			settled: false,
			settle: () => {
				if (sentinel.settled) return;
				sentinel.settled = true;
				cancelExpiry();
				const index = this.#sentinels.indexOf(sentinel);
				if (index >= 0) this.#sentinels.splice(index, 1);
				if (this.#started) onSettle();
				resolve();
			},
		};
		const cancelExpiry = this.#schedule(this.#replyTimeoutMs, () => sentinel.settle());
		this.#sentinels.push(sentinel);
		this.#unansweredDa1++;
		this.#port.write(queries + DA1);
		return promise;
	}

	#modeQueries(): string {
		// DECRQM: synchronized output, in-band resize, color-scheme reports, bracketed paste,
		// xterm scroll-to-bottom on output/keypress, alternate scroll (restored on stop), SGR-pixel mouse.
		let out = "\x1b[?2026$p\x1b[?2048$p\x1b[?2031$p\x1b[?2004$p\x1b[?1010$p\x1b[?1011$p\x1b[?1007$p\x1b[?1016$p";
		// XTVERSION and the cell size in pixels.
		out += "\x1b[>0q\x1b[16t";
		// XTSMGRAPHICS (SIXEL geometry), when no protocol is known: the one image upgrade a probe makes.
		if (this.#capabilities.images === null && !this.#forcedImages) out += "\x1b[?2;1;0S";
		// Structured OSC 99 notifications only once the terminal lists `title` among its payload types.
		// Never behind a multiplexer: it forwards the query but cannot route the reply back to the
		// pane, so the reply would leak into the pane as text.
		if (this.#identity.notify === "osc99" && !insideMultiplexer(this.#env)) {
			this.#notifyProbe = `omp-probe-${nextNotifyProbe++}`;
			out += `\x1b]99;i=${this.#notifyProbe}:p=?;\x1b\\`;
		}
		// Glyph Protocol support; never behind a multiplexer (the APC reply cannot route back to the pane).
		if (this.#env.PI_NO_GLYPH_PROTOCOL !== "1" && !insideMultiplexer(this.#env)) {
			this.#glyphPhase = "support";
			out += GLYPH_SUPPORT_QUERY;
		}
		if (this.#hello) {
			const blocker = this.#tspBlocker();
			if (blocker === null) {
				if (this.#multiplexer === "tmux") {
					setTmuxPaneApcTitles(false, this.#env, this.#tmux);
					this.#tmuxApcTitlesOff = true;
				}
				out += this.#hello;
				this.#helloSent = true;
			} else {
				logger.debug("TSP: hello not sent", { reason: blocker });
			}
		}
		return out;
	}

	/** Why a TSP `hello` cannot reach the terminal from here, or null when it can. */
	#tspBlocker(): string | null {
		const env = this.#env;
		const override = env.PI_TUI_NATIVE;
		if (override === "0") return "PI_TUI_NATIVE=0";
		// tmux makes APC bodies the pane title unless the hosting terminal asked for TSP through `@tern-tsp`.
		if (env.TMUX) {
			return tmuxSessionSpeaksTsp(env, this.#tmux) ? null : "inside a tmux session without the @tern-tsp option";
		}
		if (override === "1") return null;
		// In a Tern pane only a session marker counts (Tern panes often inherit a multiplexer TERM).
		const tern = isTernPane(env);
		const gridOwner = tern
			? (["herdr", "screen", "zellij", "cmux", "wmux"] as const).find(id => hasMultiplexerSession(id, env))
			: insideMultiplexer(env)
				? this.#multiplexer
				: undefined;
		if (gridOwner) return `inside a ${gridOwner} session, which swallows APC`;
		if (env.DEVENV_RELOAD_FILE) return "inside devenv's reloading shell, which redraws the pane and drops APC";
		return null;
	}

	/** Advance the Glyph Protocol handshake; true when `raw` was one of its replies. */
	#onGlyphReply(raw: string): boolean {
		const reply = parseGlyphReply(raw);
		if (!reply) return false;
		if (reply.verb === "s" && this.#glyphPhase === "support") {
			// Every bundled outline is `fmt=glyf`.
			if (!reply.formats.includes("glyf")) {
				this.#glyphPhase = "idle";
				return true;
			}
			this.#glyphPhase = "confirm";
			void this.#probe(glyphRegistrations(), () => {
				this.#glyphPhase = "idle";
			});
		} else if (reply.verb === "q" && this.#glyphPhase === "confirm" && reply.cp === GLYPH_CONFIRMATION_CODEPOINT) {
			this.#glyphPhase = "idle";
			if (reply.coverage.includes("glossary")) this.#identity = { ...this.#identity, glyphs: true };
			else logger.warn("pi-tui: Glyph Protocol registration not served from the glossary");
		}
		return true;
	}

	#modesSettled(): void {
		// The batch's DA1 arrived first: no OSC 99 report is coming.
		this.#notifyProbe = null;
		if (this.#glyphPhase === "support") this.#glyphPhase = "idle";
		// Tern answers the `hello` ahead of DA1; tmux answers DA1 itself, so its DA1 says nothing.
		if (this.#helloSent && this.#multiplexer !== "tmux")
			for (const listener of this.#helloSettledListeners) listener();
		this.#decideSixel();
		const pollable = this.#platform === "win32" && Boolean(this.#env.WT_SESSION);
		if (pollable && !this.#colorSchemeReports) this.#pollAppearance();
	}

	#pollAppearance(): void {
		this.#schedule(WINDOWS_APPEARANCE_POLL_MS, () => {
			void this.#queryBackground();
			this.#pollAppearance();
		});
	}

	#queryBackground(): Promise<void> {
		if (!this.#started || !this.#backgroundTrusted) return Promise.resolve();
		if (this.#backgroundQuery) {
			this.#backgroundQueued = true;
			return Promise.resolve();
		}
		const done = this.#probe("\x1b]11;?\x07", () => {
			this.#backgroundQuery = null;
			if (this.#backgroundQueued) {
				this.#backgroundQueued = false;
				void this.#queryBackground();
			}
		});
		this.#backgroundQuery = this.#sentinels.at(-1) ?? null;
		return done;
	}

	#enableKitty(reported: number): void {
		if (this.#kittyFlags !== null) return;
		let out = "";
		if (this.#modifyOtherKeys) {
			out += "\x1b[>4;0m";
			this.#modifyOtherKeys = false;
		}
		if (this.#win32Input) {
			out += "\x1b[?9001l";
			this.#win32Input = false;
			this.#decoder.win32 = false;
		}
		// Disambiguate (1) + alternate keys (4); ConPTY gets disambiguation only. Event types (2)
		// stay on only when a parent program already enabled them.
		const flags = (this.#conpty ? 1 : 5) | (reported & 2);
		out += `\x1b[>${flags}u`;
		this.#kittyFlags = flags;
		this.#decoder.kitty = true;
		this.#port.write(out);
		this.#update({ kittyKeyboard: true });
	}

	#enableKeyboardFallback(): void {
		let out = "";
		if (this.#nativeConsole || this.#wsl) {
			out += "\x1b[?9001h";
			this.#win32Input = true;
			this.#decoder.win32 = true;
		}
		// modifyOtherKeys keeps Ctrl+H, Shift+Enter… distinct. An unknown terminal behind SSH may
		// print it; a native console has win32-input-mode instead.
		const unknownRemote = this.#identity.ssh && this.#identity.id === "base";
		if (!this.#nativeConsole && !unknownRemote) {
			out += "\x1b[>4;2m";
			this.#modifyOtherKeys = true;
		}
		if (out) this.#port.write(out);
	}

	#decideSixel(): void {
		if (this.#forcedImages || this.#capabilities.images !== null || !this.#sixelAdvertised) return;
		const env = this.#env;
		// Windows Terminal advertises SIXEL in DA1 and draws it, but answers no XTSMGRAPHICS.
		const windowsTerminal = Boolean(env.WT_SESSION) && !this.#identity.ssh && this.#identity.multiplexer === null;
		if (!this.#sixelGeometry && !windowsTerminal) return;
		// tmux answers DA1 and XTSMGRAPHICS for itself; only its record of the client says SIXEL reaches it.
		if (this.#multiplexer === "tmux") {
			this.#tmuxClientSixel ??= tmuxClientRendersSixel(env, this.#tmux);
			if (!this.#tmuxClientSixel) return;
		}
		this.#update({ images: "sixel" });
	}

	#settleCursor(position: { row: number; col: number } | null): void {
		const request = this.#cpr;
		if (!request) return;
		this.#cpr = null;
		this.#decoder.cprPending = false;
		request.resolve(position);
	}

	#onReply(reply: TerminalReply): void {
		if (!this.#started) {
			if (reply.type === "da1") this.#drain?.da1();
			return;
		}
		switch (reply.type) {
			case "da1": {
				if (this.#unansweredDa1 > 0) this.#unansweredDa1--;
				if (reply.attrs.includes(4)) {
					this.#sixelAdvertised = true;
					this.#decideSixel();
				}
				this.#sentinels[0]?.settle();
				return;
			}
			case "kittyKeyboard":
				if (this.#started) this.#enableKitty(reply.flags);
				return;
			case "decrpm":
				if (reply.dec) this.#onModeReport(reply.mode, reply.status);
				return;
			case "color": {
				if (reply.index !== 11 || !reply.rgb || !this.#backgroundTrusted) return;
				// A multiplexer's own CSI ?997 report outranks the host background's luminance.
				this.#update({ background: reply.rgb, dark: this.#reportedDark ?? isDarkBackground(reply.rgb) });
				return;
			}
			case "colorScheme": {
				if (this.#schemeOwner) this.#reportedDark = reply.dark;
				this.#update({ dark: reply.dark });
				this.#schemeDebounce?.();
				this.#schemeDebounce = this.#schedule(SCHEME_DEBOUNCE_MS, () => {
					this.#schemeDebounce = null;
					void this.#queryBackground();
				});
				return;
			}
			case "windowSize": {
				if (reply.unit === "cell" && reply.width > 0 && reply.height > 0) {
					this.#update({ cell: { w: reply.width, h: reply.height } });
				}
				return;
			}
			case "inBandResize": {
				if (reply.cols > 0 && reply.rows > 0 && reply.widthPx > 0 && reply.heightPx > 0) {
					this.#update({
						cell: { w: Math.round(reply.widthPx / reply.cols), h: Math.round(reply.heightPx / reply.rows) },
					});
				}
				if (reply.cols > 0 && reply.rows > 0) {
					this.#resize({ columns: reply.cols, rows: reply.rows });
					this.#armHerdrSettle();
				}
				return;
			}
			case "version":
				this.#identity = { ...this.#identity, version: reply.version };
				return;
			case "graphicsAttribute": {
				if (reply.item !== 2) return;
				const [width = 0, height = 0] = reply.values;
				this.#sixelGeometry = reply.status === 0 && width > 0 && height > 0;
				this.#decideSixel();
				return;
			}
			case "notification": {
				if (this.#notifyProbe === null || reply.meta.get("i") !== this.#notifyProbe) return;
				if (reply.meta.get("p") !== "?") return;
				this.#notifyProbe = null;
				const payloads = reply.payload.get("p")?.split(",") ?? [];
				this.#identity = { ...this.#identity, richNotifications: payloads.includes("title") };
				return;
			}
			case "cpr":
				this.#settleCursor({ row: reply.row - 1, col: reply.col - 1 });
				return;
			case "da2":
			case "dsr":
				return;
			case "other":
				if (this.#onGlyphReply(reply.raw)) return;
				// An OSC the driver has no use for (enhanced paste packets, app protocols): the app may.
				if (reply.raw.startsWith("\x1b]")) this.#onInput({ type: "osc", raw: reply.raw });
				return;
		}
	}

	#onModeReport(mode: number, status: number): void {
		if (!this.#started) return;
		// DECRPM: 1 set, 2 reset, 3 permanently set; 0 unrecognized, 4 permanently reset.
		const on = status >= 1 && status <= 3;
		switch (mode) {
			case 2026: {
				const override = synchronizedOutputOverride(this.#env);
				// Herdr's pane honors 2026 whatever its DECRQM answer says.
				const honored = hasMultiplexerSession("herdr", this.#env);
				this.#update({ synchronizedOutput: override ?? (on || honored) });
				return;
			}
			case 2048:
				if (on && !this.#inBandResize) {
					this.#inBandResize = true;
					this.#port.write("\x1b[?2048h");
				}
				return;
			case 2031:
				if (on && !this.#colorSchemeReports) {
					this.#colorSchemeReports = true;
					this.#port.write("\x1b[?2031h");
				}
				return;
			case 2004:
				this.#update({ bracketedPaste: on });
				if (on) this.#rearmPaste = true;
				return;
			case 1010:
			case 1011:
				// Scroll-to-bottom on output/keypress fights the viewport; off while we run.
				if (status === 1 && !this.#restoreModes.includes(mode)) {
					this.#restoreModes.push(mode);
					this.#port.write(`\x1b[?${mode}l`);
				}
				return;
			case 1007:
				// The state a stop puts back. Asked before any change of ours, so it is the terminal's own.
				if (status >= 1 && status <= 4) this.#alternateScrollOriginal = status === 1 || status === 3;
				return;
			case 1016:
				// Set or reset: the terminal knows SGR-pixel reporting (0 unrecognized, 4 permanently reset).
				this.#pixelMouseReported = on;
				this.#update({});
				return;
		}
	}
}

/** The input half for the current process (or the given streams). */
export function createProcessInput(port: TerminalPort, options?: ProcessInputOptions): TerminalInput {
	return new ProcessTerminalInput(port, options);
}
