/**
 * Terminal glue: owns the native {@link TerminalEngine} and connects it to an
 * IO port (process stdio, or a test double). The engine holds every piece of
 * terminal logic — input parsing, capability negotiation, frame painting,
 * resize transactions, render scheduling — and, for a process terminal, the
 * stdio itself: raw mode, a stdin reader thread, and a stdout writer thread.
 * It is sans-IO for time: this module passes the host clock in, drains its
 * events after every call, delivers a capture port's output and input, and
 * re-arms one timer at its next deadline.
 */
import { type EngineEvent, type ImageBudget, isTspExpected, TerminalEngine } from "@oh-my-pi/pi-natives";
import { isBunTestRuntime, isTerminalHeadless } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { restoreTerminalStderr, suppressTerminalStderr } from "@oh-my-pi/pi-utils/stderr-guard";
import { TSP_VERSION } from "@oh-my-pi/pi-wire";
import { getActiveTerminal, setActiveTerminal } from "./active-terminal";
import { minFrameIntervalMs } from "./frame-rate";
import { setKittyProtocolActive } from "./keys";
import { decodeTspBody, encodeTspHelloQuery, type TspHello } from "./native/encode";
import { DEFAULT_RENDER_SCHEDULER, type RenderScheduler, type RenderTimer } from "./tui";
import { getCellDimensions, setCellDimensions } from "./inline-image";
import {
	ImageProtocol,
	setOsc99Supported,
	setTerminalBackgroundColor,
	setTerminalGlyphProtocol,
	setTerminalImageProtocol,
	TERMINAL,
} from "./terminal-capabilities";
import { setHangulCompatibilityJamoWidth } from "./utils";

export { writeTerminalSequence, writeThroughActiveTerminal } from "./active-terminal";

let terminalRestoreRegistered = false;

function registerPostmortemTerminalRestore(): void {
	if (terminalRestoreRegistered) return;
	terminalRestoreRegistered = true;
	postmortem.register("terminal-restore", () => {
		emergencyTerminalRestore();
	});
}

/**
 * Emergency terminal restore - call this from signal/crash handlers
 * Resets terminal state without requiring access to the Terminal instance
 */
export function emergencyTerminalRestore(): void {
	try {
		// Crash paths must surface subsequent stderr (fatal reports) on the
		// real terminal; no-op when the stderr guard is inactive.
		restoreTerminalStderr();
		// stop() stops reading stdin and queues the restore the output device
		// derives from its tracked state (alternate screen and keyboard
		// enhancement included) before it retires the bounded output writer and
		// puts stdin's terminal mode back.
		getActiveTerminal()?.stop();
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
	/**
	 * Reports whether the event loop is stalled or just recovered from a
	 * stall. Once the terminal confirms bracketed paste, an unmarked multiline
	 * burst is an input-method commit (IME, dictation) delivered as one paste
	 * on a responsive loop, but keystrokes a stall batched into one read —
	 * replayed as keys so Enter submits — while this returns true. Without a
	 * probe every such burst is treated as an input-method commit.
	 */
	isLoopStalled?: () => boolean;
}
/** Identity of an accepted explicit terminal appearance refresh request. */
export type TerminalAppearanceRequestToken = number;
/**
 * Fired once per DEC private mode when DECRQM support resolves.
 * `confirmed` is false when only the DA1 sentinel arrived.
 * `status` is the DECRPM value (0 unrecognized, 1/2 set/reset, 3 permanently
 * set, 4 permanently reset) when the terminal answered DECRQM.
 */
export type PrivateModeReportHandler = (mode: number, supported: boolean, confirmed?: boolean, status?: number) => void;
/**
 * Fired once when the Glyph Protocol handshake resolves. `supported` is true
 * only after the bundled icons were written and the terminal confirmed (via a
 * `q` coverage query) that a registered codepoint is served from its
 * glossary, so a host can safely repaint — or switch to the nerd preset.
 */
export type GlyphProtocolReportHandler = (supported: boolean) => void;

/**
 * Cursor shapes addressable via DECSCUSR (`CSI <n> SP q`). `"default"` (0) hands the shape back to
 * the terminal's own configuration, which is what teardown restores rather than guessing a shape
 * the user never chose.
 */
export type CursorShape = "default" | "block" | "underline" | "bar";

export const CURSOR_SHAPE_CODES: Record<CursorShape, number> = {
	default: 0,
	block: 2,
	underline: 4,
	bar: 6,
};

/** The `hello` reply a `nativeSurface` event carries (its JSON body), if any. */
function decodeTspHello(body: string | undefined): TspHello | undefined {
	if (body === undefined) return undefined;
	const message = decodeTspBody("r", body);
	return message?.verb === "r" && message.reply.r === "hello" ? message.reply : undefined;
}

/** What a {@link Terminal} tells its owner (the TUI) as engine events arrive. */
export interface TerminalHost {
	/**
	 * One input event for the focused component: a key sequence or text run,
	 * or a complete Tern Surface Protocol message in APC form
	 * (`ESC _ tsp;…  ESC \`).
	 */
	input(data: string): void;
	/**
	 * Pasted text (a bracketed paste, or an input-method commit), markers
	 * stripped and control bytes decoded by the engine. `enter` is an Enter key
	 * that shared the paste's stdin read: the host delivers it as a key right
	 * after the paste, to the component that took the paste.
	 */
	paste(text: string, enter?: string): void;
	/** A frame is due: compose it and present it through {@link Terminal.run}. */
	render(): void;
	/** The effective geometry changed (OS resize or in-band report). */
	resize(): void;
	/** The terminal is gone (stdin ended, output failed or stalled): tear down. */
	disconnect?(): void;
	/** The engine latched a history replay: the frame provider re-offers its finalized history. */
	historyReplay?(): void;
	/** A frame wrote a row containing `text`, one of the watched texts (`setFrameTextWatches`). */
	frameText?(text: string): void;
	/** The terminal reported a different cell size in pixels; image geometry is stale. */
	cellSize?(): void;
	/**
	 * The engine adopted an inline image protocol (`TERMINAL.imageProtocol`, set
	 * before this call) and forced a full repaint: rendered rows are stale.
	 */
	imageProtocol?(): void;
	/**
	 * The engine's Tern Surface Protocol handshake moved the surface. `live`
	 * with `hello` undefined: opened on assumed capabilities (the environment
	 * names Tern) ahead of the reply. `live` with `hello`: opened on the reply,
	 * or — when already live — the reply confirmed the assumed surface. Not
	 * `live`: the unconfirmed surface was revoked (`reason`) and rows repaint.
	 */
	nativeSurface?(live: boolean, hello: TspHello | undefined, reason: string | undefined): void;
}

/** Receiver of an IO port's events; implemented by {@link Terminal}. */
export interface TerminalIoSink {
	/**
	 * Raw input bytes, exactly as read (a read may split a code point or an
	 * escape sequence). Capture ports only: an engine that owns process stdio
	 * reads stdin itself.
	 */
	input(bytes: Uint8Array): void;
	/** The OS reports a new size. */
	resize(columns: number, rows: number): void;
	/** The output stream drained (capture ports only). */
	drained(): void;
	/** The terminal is gone. */
	disconnected(reason: string, err?: unknown): void;
}

/**
 * Where a {@link Terminal}'s bytes come from and go to: process stdio, which
 * the engine owns, for {@link ProcessTerminal}; an in-memory emulator or byte
 * sink (a capture port) for tests and headless tools.
 */
export interface TerminalIo {
	/**
	 * Whether something reads the output and answers on stdin. A
	 * non-interactive port never has its input attached, so no capability
	 * probe is ever sent.
	 */
	readonly interactive: boolean;
	/** Size the OS (or emulator) reports. */
	readonly columns: number;
	readonly rows: number;
	/**
	 * The engine owns this process's stdio: it writes stdout from a writer
	 * thread (no control output when stdout is not a terminal) and, once input
	 * attaches, puts stdin in raw mode and reads it on a thread. Absent or
	 * false (a capture port): the engine captures its output for
	 * {@link write}, and input arrives through the sink.
	 */
	readonly processStdio?: boolean;
	/** Capture ports: bytes {@link write} accepted that the consumer has not taken yet. */
	readonly backlog: number;
	/** Begin delivering resize, drain, input, and disconnect events to `sink`. */
	open(sink: TerminalIoSink): void;
	/** Deliver captured engine output, in order. Throws when the output is gone. */
	write(chunks: readonly Uint8Array[]): void;
	/** Release everything {@link open} took. */
	close(): void;
	/** The terminal was declared gone; runs before the host tears down. */
	dead?(): void;
	/** The host has torn down after a disconnect: end the process the way a hangup would. */
	hangup?(): void;
}

/** Construction-time overrides for a {@link Terminal}. */
export interface TerminalOptions {
	/**
	 * Force ConPTY-hosted behavior on or off. Defaults to live detection via
	 * `isConPTYHosted`. Tests set this so the kitty-flag, write-chunking
	 * and resize-routing paths stay hermetic regardless of the ambient WSL env
	 * (`WSL_DISTRO_NAME` / `WSL_INTEROP`) — the suite must behave identically
	 * on WSL and on CI.
	 */
	conpty?: boolean;
	/**
	 * Whether stdin is a native Windows console handle (win32, not WSL), whose
	 * console host is certain to answer `CSI ? 9001 h` with win32-input-mode key
	 * records. When false (WSL), the keyboard fallback requests modifyOtherKeys
	 * alongside win32-input-mode, since a WSL pty may not be relayed by a console
	 * host. Defaults to `process.platform === "win32"`; only consulted when
	 * `conpty` is also true.
	 */
	nativeWindowsConsole?: boolean;
	/** Force {@link Terminal.tspExpected} (test harnesses). */
	tspExpected?: boolean;
	/**
	 * The environment the engine resolves its terminal and multiplexer facts
	 * from (test harnesses); defaults to `Bun.env` when the engine is created.
	 */
	env?: Record<string, string | undefined>;
}

/** Construction-time overrides for {@link ProcessTerminal}. */
export type ProcessTerminalOptions = TerminalOptions;

/** One render request, as the engine takes it. */
export interface RenderRequest {
	/** Repaint the viewport even when the diff believes nothing changed. */
	force?: boolean;
	/** Erase native scrollback and repaint from row zero (with `force`). */
	clearScrollback?: boolean;
	/** Arm the input-cadence latch for the next frame; requests no frame by itself. */
	input?: boolean;
	/** With `input`: give queued input one frame to drain before an ordinary repaint (Ctrl+C / Esc double-press windows). */
	inputGrace?: boolean;
	/** The frame is due now: the next `tick` announces it. */
	immediate?: boolean;
}

type AppearanceCallback = (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void;

/** Engine frame calls a {@link Terminal.run} callback may issue. */
export type EngineCall<T> = (engine: TerminalEngine, now: number) => T;

/**
 * A terminal: the native engine plus the IO port it talks through.
 *
 * Every engine call goes through {@link run} (or one of the methods below,
 * which use it): the call gets the scheduler's clock, and afterwards the
 * captured output is written, the engine's events are dispatched to
 * subscribers and the {@link TerminalHost}, and the single engine timer is
 * re-armed at its next deadline. The engine outlives stop/start cycles, so a
 * restarted TUI repaints against the screen state it left behind.
 */
export class Terminal {
	readonly #io: TerminalIo;
	readonly #options: TerminalOptions | undefined;
	#engine: TerminalEngine | undefined;
	#scheduler: RenderScheduler = DEFAULT_RENDER_SCHEDULER;
	#host: TerminalHost | undefined;
	/** Shared with the engine once it exists; see {@link attachImageBudget}. */
	#imageBudget: ImageBudget | undefined;
	#isLoopStalled: (() => boolean) | undefined;
	/** The engine timer, and the deadline it was armed for (`null`: none wanted). */
	#timer: RenderTimer | undefined;
	#armedDeadline: number | null = null;
	/**
	 * The engine's clock: the scheduler's reading, never moving backwards, and at
	 * least the deadline of a timer that fired. A fired timer means its delay
	 * elapsed even when the scheduler's clock disagrees (a frozen test clock, a
	 * timer firing a hair early), so the engine must see that deadline as due.
	 */
	#clock = 0;
	/** Invalidates callbacks of timers that could not be cancelled (`scheduleImmediate`). */
	#timerEpoch = 0;
	/** True between a `deferInput` start() and enableInput(). */
	#inputDeferred = false;
	#inputAttached = false;
	#dead = false;
	/** The exit restore was written: nothing more goes out until start(). */
	#outputStopped = false;
	/** Effective geometry (in-band report when active, else OS), refreshed on resize events. */
	#columns: number | undefined;
	#rows: number | undefined;
	#kittyProtocolActive = false;
	#drained: (() => void) | undefined;

	#appearance: TerminalAppearance | undefined;
	#appearanceCallbacks: AppearanceCallback[] = [];
	#appearanceReportCallbacks: AppearanceCallback[] = [];
	#privateModeCallbacks: PrivateModeReportHandler[] = [];
	#programStatusResult: boolean | undefined;
	#programStatusCallbacks = new Set<(supported: boolean) => void>();
	#glyphProtocolResult: boolean | undefined;
	#glyphProtocolCallbacks: GlyphProtocolReportHandler[] = [];

	readonly #sink: TerminalIoSink = {
		input: bytes => {
			if (this.#dead || this.#outputStopped) return;
			const stalled = this.#isLoopStalled?.() ?? false;
			this.run((engine, now) => engine.input(now, bytes, stalled));
		},
		resize: (columns, rows) => {
			if (this.#dead || this.#outputStopped) return;
			this.run((engine, now) => engine.resize(now, columns, rows));
		},
		drained: () => {
			// The engine's own stdout writer reports its drain through the wake-up.
			if (!this.#engine?.capturing || this.#dead || this.#outputStopped) return;
			this.#tick();
		},
		disconnected: (reason, err) => this.#disconnect(reason, err),
	};

	constructor(io: TerminalIo, options?: TerminalOptions) {
		this.#io = io;
		this.#options = options;
	}

	/**
	 * Route engine events to `host` and use `scheduler` as the engine's clock and
	 * timer source. The TUI binds itself at construction, so it can paint before
	 * `start()` and a test that injects a scheduler drives probe timeouts,
	 * resize settling, and render pacing deterministically.
	 */
	bind(host: TerminalHost, scheduler: RenderScheduler = this.#scheduler): void {
		this.#host = host;
		this.#scheduler = scheduler;
	}

	/**
	 * Share the owner's inline-image budget with the engine: every paint drains
	 * its purges and transmits, alternate-buffer entries reset its alternate
	 * surface, and the redraws it asks for are scheduled by the engine.
	 */
	attachImageBudget(budget: ImageBudget): void {
		this.#imageBudget = budget;
		this.#engine?.attachImageBudget(budget);
	}

	/**
	 * The engine, for reading its state (getters, `mutableViewport()`,
	 * `debugPaint()`). Calls that write output, raise events, or move a
	 * deadline go through {@link run}.
	 */
	get engine(): TerminalEngine {
		return this.#ensureEngine();
	}

	/**
	 * Call into the engine with the scheduler's clock, then write its output,
	 * dispatch its events, and re-arm its timer. Events are dispatched before
	 * this returns, so a `beginFrame` that latched a history replay or an
	 * alternate-screen entry has told the host by the time it composes.
	 */
	run<T>(call: EngineCall<T>): T {
		const engine = this.#ensureEngine();
		const result = call(engine, this.#now());
		this.#sync(engine);
		return result;
	}

	/**
	 * Request a frame. `options` are the engine's: `force`, `clearScrollback`,
	 * `input` (arm the input-cadence latch without requesting a frame),
	 * `inputGrace`, `immediate`. A request writes nothing and raises no event,
	 * so only the timer is re-armed.
	 */
	requestRender(options?: RenderRequest): void {
		const engine = this.#ensureEngine();
		engine.requestRender(this.#now(), options);
		this.#armTimer(engine);
	}

	/**
	 * Start the terminal: take ownership of the output and, unless input is
	 * deferred, of stdin. Attaching input sends the capability probes; a
	 * terminal that cannot parse one may leave concealed bytes on the cursor
	 * row, so the caller repaints after starting.
	 */
	start(options?: TerminalStartOptions): void {
		this.#outputStopped = false;
		this.#isLoopStalled = options?.isLoopStalled;
		this.#io.open(this.#sink);
		this.run((engine, now) => engine.start(now));
		if (!this.#io.interactive) return;
		if (options?.deferInput) {
			this.#inputDeferred = true;
			return;
		}
		this.#attachInput();
	}

	/**
	 * Take ownership of stdin after a `deferInput` start: enable raw mode,
	 * attach input handlers, and run the capability probes start() skipped.
	 * Bytes the user typed in cooked mode meanwhile are replayed through
	 * {@link TerminalHost.input}. No-op when input was never deferred. Like
	 * {@link start}, the probes may leave concealed bytes on the cursor row, so
	 * the caller repaints afterwards.
	 */
	enableInput(): void {
		if (!this.#inputDeferred) return;
		this.#inputDeferred = false;
		if (this.#dead) return;
		this.#attachInput();
	}

	/**
	 * Own input and send the capability probes that elicit stdin responses.
	 * With process stdio the engine takes stdin here: raw mode, and a reader
	 * thread that starts with whatever the kernel line-buffered meanwhile.
	 * Split from start() so a `deferInput` prepaint can leave the tty in cooked
	 * mode (kernel echo + line editing) while startup module loading blocks the
	 * event loop, then adopt those keystrokes once the app can process them.
	 * A multiplexer or SSH disconnect can leave stdin a tty after its pty was
	 * revoked; the engine then reports the failed raw mode as a disconnect.
	 */
	#attachInput(): void {
		this.#inputAttached = true;
		// Every probe below starts from "unsupported"; a resumed TUI may own a
		// different terminal than the one that answered last time.
		setOsc99Supported(false);
		setTerminalGlyphProtocol(false);
		this.#glyphProtocolResult = undefined;
		this.#programStatusResult = undefined;
		this.run((engine, now) => engine.attachInput(now));
	}

	/** Stop the terminal and restore the state the session changed. */
	stop(): void {
		if (this.#outputStopped) return;
		this.#cancelTimer();
		this.#inputDeferred = false;
		this.#inputAttached = false;
		this.#isLoopStalled = undefined;
		const engine = this.#engine;
		let modeRestoreError: unknown;
		if (engine) {
			// The engine stops reading stdin, writes the ops still buffered, then
			// the restore its output device derives from the state it tracked
			// (alternate screen, keyboard enhancement, paint-time modes, DECCKM,
			// bracketed paste, cursor shape, mouse tracking, Mode 2031, in-band
			// resize, progress, cursor visibility), retires its output writer with
			// a bounded drain, and puts stdin's terminal mode back. It throws only
			// when that last step fails, after everything else was handed back.
			try {
				engine.stop(this.#now());
			} catch (err) {
				modeRestoreError = err;
			}
			this.#flushOutput(engine);
			// Whatever the teardown raised has no host left to hear it.
			engine.takeEvents();
		}
		// The restore is the last output of this instance until start().
		this.#outputStopped = true;

		this.#appearanceCallbacks = [];
		this.#appearanceReportCallbacks = [];
		this.#appearance = undefined;
		this.#privateModeCallbacks = [];
		setOsc99Supported(false);
		// A resumed TUI may own a different terminal: keep subscribers, but
		// release the previous receiver's support until the next probe answers.
		if (this.#programStatusResult === true) this.#publishProgramStatusSupport(false);
		this.#glyphProtocolResult = undefined;
		this.#glyphProtocolCallbacks = [];
		setTerminalGlyphProtocol(false);
		// The restore above already disabled the keyboard enhancement on the
		// terminal; drop the matching input-side state.
		if (this.#kittyProtocolActive) {
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		const drained = this.#drained;
		this.#drained = undefined;
		drained?.();
		this.#io.close();
		// On a disconnected terminal (pane recycled, ssh dropped) stdin is no
		// longer a tty: there is nothing left to restore, and throwing would abort
		// the disconnect teardown. On a live terminal the failure surfaces:
		// swallowing it would silently leave stdin in raw mode.
		if (modeRestoreError !== undefined && !this.#dead) throw modeRestoreError;
	}

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections. The engine turns
	 * the keyboard enhancement off first, and for a Tern surface waits for a
	 * DA1 sentinel so late frame acknowledgements are read and dropped. Input
	 * arriving meanwhile reaches nobody.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (!this.#inputAttached || this.#dead || this.#outputStopped) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		const previous = this.#drained;
		this.#drained = () => {
			previous?.();
			resolve();
		};
		this.run((engine, now) => engine.drainInput(now, maxMs, idleMs));
		await promise;
	}

	/** Write opaque output (an out-of-band sequence, a TSP message) in order with the engine's own. */
	write(data: string): void {
		if (this.#outputStopped || this.#dead) return;
		this.run(engine => engine.write(data));
	}

	/** Effective terminal width: the in-band report when active, else the OS size. */
	get columns(): number {
		return this.#columns ?? this.#io.columns;
	}

	/** Effective terminal height: the in-band report when active, else the OS size. */
	get rows(): number {
		return this.#rows ?? this.#io.rows;
	}

	/**
	 * Output bytes accepted but not yet delivered to the terminal. The engine
	 * defers frames while this backlog is deep, so a slow terminal receives
	 * only fresh frames instead of a queue of stale ones.
	 */
	get pendingOutputBytes(): number {
		return this.#engine?.pendingOutputBytes ?? 0;
	}

	/** Whether Kitty keyboard protocol is active. */
	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	// Cursor visibility. Same-state calls are deduped against the visibility
	// last written to the terminal; pass force=true to write unconditionally
	// (crash/exit restore paths).
	hideCursor(force = false): void {
		if (this.#outputStopped || this.#dead) return;
		this.run(engine => engine.hideCursor(force));
	}

	showCursor(force = false): void {
		if (this.#outputStopped || this.#dead) return;
		this.run(engine => engine.showCursor(force));
	}

	/**
	 * Set the hardware cursor shape (DECSCUSR). Written whenever it changes,
	 * whether or not the hardware cursor is currently visible: reshaping a
	 * hidden cursor has no visible effect. The engine dedupes against the last
	 * shape written so a per-keystroke mode indicator does not add a sequence
	 * to every frame; {@link stop} restores `"default"` so the user's own
	 * cursor configuration survives exit. Hosts that render a software cursor
	 * simply never call this.
	 */
	setCursorShape(shape: CursorShape): void {
		if (this.#outputStopped || this.#dead) return;
		this.run(engine => engine.setCursorShape(CURSOR_SHAPE_CODES[shape]));
	}

	/** Set the terminal window title. */
	setTitle(title: string): void {
		if (this.#outputStopped || this.#dead) return;
		this.run(engine => engine.setTitle(title));
	}

	/** Progress indicator (OSC 9;4); the engine keeps it alive on terminals that expire it. */
	setProgress(active: boolean): void {
		if (!this.#io.interactive || this.#outputStopped || this.#dead) return;
		this.run((engine, now) => engine.setProgress(now, active));
	}

	/** The last detected terminal appearance, or undefined if not yet known. */
	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	/**
	 * Register a callback for terminal appearance (dark/light) changes.
	 * Detection uses OSC 11 background color query with Mode 2031 as a change trigger.
	 * Fires when the detected appearance changes, including the initial detection.
	 * Subscribers registered after detection are invoked immediately with the
	 * already-detected appearance so late subscribers never miss it.
	 */
	onAppearanceChange(callback: AppearanceCallback): void {
		this.#appearanceCallbacks.push(callback);
		// Replay an already-detected appearance: the startup OSC 11 response can
		// arrive before consumers (e.g. the theme bridge) subscribe, and the
		// dedup of unchanged reports would otherwise suppress the value for
		// them forever (#4731).
		if (this.#appearance) {
			try {
				callback(this.#appearance);
			} catch {
				/* ignore callback errors */
			}
		}
	}

	/**
	 * Register a callback fired for every valid OSC 11 appearance report,
	 * including reports whose classification matches the current appearance.
	 * Unlike onAppearanceChange, this does not replay an earlier report.
	 */
	onAppearanceReport(callback: AppearanceCallback): () => void {
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
	 * Start a bounded OSC 11 background-color refresh cycle, driving appearance
	 * callbacks through the same parse/dedup pipeline used at startup and on Mode
	 * 2031 notifications. Direct terminals need one query; tmux needs a
	 * passthrough query to update its cache followed by one delayed direct cache
	 * read. Invoked on the user's explicit display-reset gesture so terminals
	 * without end-to-end Mode 2031 notifications pick up a light/dark switch
	 * without a restart. No periodic probes are armed.
	 *
	 * A caller-provided token is propagated unchanged to callbacks and returned
	 * when the request is accepted. This lets callers establish ownership before
	 * a cached response is dispatched. Suppressed while input is not attached
	 * and after teardown.
	 */
	refreshAppearance(requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | undefined {
		if (!this.#inputAttached || this.#dead || this.#outputStopped) return undefined;
		return this.run((engine, now) => engine.refreshAppearance(now, requestToken)) ?? undefined;
	}

	/**
	 * Register a callback fired once per DEC private mode when its DECRQM support
	 * status resolves. `confirmed` is false when the terminal answered the DA1
	 * sentinel without answering DECRQM, which proves only that querying support
	 * is unavailable — not that the private mode itself is unsupported.
	 * `status` is the DECRPM value when the terminal answered DECRQM.
	 */
	onPrivateModeReport(callback: PrivateModeReportHandler): void {
		this.#privateModeCallbacks.push(callback);
	}

	/**
	 * Subscribe to OSC 7501 feature-query results across terminal restarts.
	 * A late subscriber receives the current answer; unsubscribe on host teardown.
	 */
	onProgramStatusSupport(callback: (supported: boolean) => void): () => void {
		this.#programStatusCallbacks.add(callback);
		if (this.#programStatusResult !== undefined) callback(this.#programStatusResult);
		return () => this.#programStatusCallbacks.delete(callback);
	}

	/**
	 * Register a callback fired once the startup Glyph Protocol handshake
	 * resolves (see {@link GlyphProtocolReportHandler}). A subscriber that
	 * arrives after the handshake already resolved is called immediately with
	 * the stored outcome.
	 */
	onGlyphProtocolReport(callback: GlyphProtocolReportHandler): void {
		this.#glyphProtocolCallbacks.push(callback);
		// The handshake runs from enableInput(), which can precede the host's
		// subscription during startup; replay so the outcome is never missed.
		if (this.#glyphProtocolResult !== undefined) callback(this.#glyphProtocolResult);
	}

	/** True while the `hello` probe awaits its reply or DA1 sentinel. */
	get tspProbePending(): boolean {
		return this.#engine?.tspProbePending ?? false;
	}

	/**
	 * The environment names a Tern Surface Protocol terminal
	 * (`TERM_PROGRAM=tern`) and the `hello` probe will run: the TUI takes input
	 * at start and opens its surface before the reply, which then confirms or
	 * revokes it.
	 */
	get tspExpected(): boolean {
		return this.#options?.tspExpected ?? isTspExpected(Bun.env, isTerminalHeadless(), isBunTestRuntime());
	}

	#ensureEngine(): TerminalEngine {
		if (this.#engine) return this.#engine;
		const io = this.#io;
		const options = this.#options;
		// The engine resolves terminal identity, multiplexer hosting, env
		// overrides, and which probes run from the environment itself.
		const config = {
			stdio: io.processStdio === true,
			columns: io.columns,
			rows: io.rows,
			env: options?.env ?? Bun.env,
			testRuntime: isBunTestRuntime(),
			headless: isTerminalHeadless(),
			stdinTty: process.stdin.isTTY === true,
			stdoutTty: process.stdout.isTTY === true,
			conpty: options?.conpty,
			nativeWindowsConsole: options?.nativeWindowsConsole,
			tspExpected: options?.tspExpected,
			tspHello: { query: encodeTspHelloQuery(), version: TSP_VERSION },
			frameIntervalMs: minFrameIntervalMs(),
		};
		// The native callback must not root its own engine through the terminal.
		const terminal = new WeakRef(this);
		const onWake = (): void => {
			const owner = terminal.deref();
			if (owner) owner.#wake();
		};
		const engine = new TerminalEngine(config, onWake);
		if (this.#imageBudget) engine.attachImageBudget(this.#imageBudget);
		this.#engine = engine;
		this.#columns = engine.columns;
		this.#rows = engine.rows;
		return engine;
	}

	/**
	 * The stdout writer drained its backlog or its terminal failed, or the
	 * stdin reader queued reads or saw stdin end: let the engine look.
	 */
	#wake(): void {
		if (this.#dead || this.#outputStopped) return;
		this.#tick();
	}

	/** The engine timer fired, the engine woke the host, or the capture stream drained. */
	#tick(): void {
		// The engine feeds the stdin reads queued since the last call with this
		// verdict: a stall-batched multiline burst is keystrokes, not a paste.
		const stalled = this.#isLoopStalled?.() ?? false;
		this.run((engine, now) => {
			// The engine cannot read a Node stream: a capture sink's backlog is
			// sampled for it, which also feeds its stall watchdog between writes.
			if (engine.capturing) engine.noteStreamBacklog(now, this.#io.backlog);
			engine.tick(now, stalled);
		});
	}

	#sync(engine: TerminalEngine): void {
		this.#flushOutput(engine);
		for (const event of engine.takeEvents()) this.#dispatch(engine, event);
		this.#armTimer(engine);
	}

	/**
	 * Deliver what a capture sink encoded. Dropped after stop() and once the
	 * terminal is dead; the process port drops it while headless.
	 */
	#flushOutput(engine: TerminalEngine): void {
		if (!engine.capturing) return;
		const chunks = engine.takeOutput();
		if (chunks.length === 0 || this.#outputStopped || this.#dead) return;
		try {
			this.#io.write(chunks);
		} catch (err) {
			this.#disconnect("stdout failed", err);
			return;
		}
		// A stalled-but-alive consumer never throws: write() just queues the
		// bytes and the port's backlog grows. The engine's stall watchdog bounds a
		// genuinely wedged reader (#6854) without killing a lone oversized frame
		// that is still draining (#10430).
		engine.noteStreamBacklog(this.#now(), this.#io.backlog);
	}

	#armTimer(engine: TerminalEngine): void {
		const deadline = this.#outputStopped || this.#dead ? null : engine.nextDeadline();
		if (deadline === this.#armedDeadline) return;
		this.#cancelTimer();
		this.#armedDeadline = deadline;
		if (deadline === null) return;
		const epoch = this.#timerEpoch;
		const fire = (): void => {
			if (epoch !== this.#timerEpoch) return;
			this.#timer = undefined;
			this.#armedDeadline = null;
			this.#clock = Math.max(this.#clock, deadline);
			this.#tick();
		};
		const delayMs = deadline - this.#now();
		if (delayMs > 0) this.#timer = this.#scheduler.scheduleRender(fire, delayMs);
		else this.#scheduler.scheduleImmediate(fire);
	}

	#now(): number {
		this.#clock = Math.max(this.#clock, this.#scheduler.now());
		return this.#clock;
	}

	#cancelTimer(): void {
		this.#timerEpoch++;
		this.#timer?.cancel();
		this.#timer = undefined;
		this.#armedDeadline = null;
	}

	#dispatch(engine: TerminalEngine, event: EngineEvent): void {
		switch (event.kind) {
			case "key":
				// While draining, late key releases and TSP acknowledgements are read and dropped.
				if (this.#drained === undefined && event.data !== undefined) this.#host?.input(event.data);
				return;
			case "paste":
				// An Enter that shared the paste's stdin read rides along so paste and
				// submit reach the component focused right now, not one the paste
				// itself is about to open.
				if (this.#drained === undefined) this.#host?.paste(event.data ?? "", event.enter);
				return;
			case "render":
				this.#host?.render();
				return;
			case "resize":
				this.#columns = engine.columns;
				this.#rows = engine.rows;
				this.#host?.resize();
				return;
			case "appearance":
				this.#reportAppearance(event);
				return;
			case "privateMode":
				if (event.mode === undefined) return;
				for (const callback of this.#privateModeCallbacks) {
					try {
						callback(event.mode, event.supported === true, event.confirmed === true, event.status);
					} catch {
						/* ignore callback errors */
					}
				}
				return;
			case "imageProtocol":
				// The engine adopted SIXEL (its DA1/XTSMGRAPHICS policy) and forced a
				// full repaint; components render images for the new protocol.
				if (event.data === "sixel") setTerminalImageProtocol(ImageProtocol.Sixel);
				this.#host?.imageProtocol?.();
				return;
			case "programStatus":
				this.#publishProgramStatusSupport(event.supported === true);
				return;
			case "glyph": {
				const supported = event.supported === true;
				this.#glyphProtocolResult = supported;
				setTerminalGlyphProtocol(supported);
				for (const callback of this.#glyphProtocolCallbacks) {
					try {
						callback(supported);
					} catch {
						/* ignore callback errors */
					}
				}
				return;
			}
			case "osc99":
				setOsc99Supported(event.supported === true);
				return;
			case "nativeSurface":
				this.#host?.nativeSurface?.(event.live === true, decodeTspHello(event.data), event.reason);
				return;
			case "tspFallback":
				logger.debug("TSP: Tern pane keeps the classic renderer", { reason: event.reason });
				return;
			case "keyboardProtocol": {
				const kitty = event.kitty === true;
				this.#kittyProtocolActive = kitty;
				setKittyProtocolActive(kitty);
				return;
			}
			case "cellSize": {
				const { widthPx, heightPx } = event;
				if (widthPx === undefined || heightPx === undefined || widthPx <= 0 || heightPx <= 0) return;
				const current = getCellDimensions();
				if (current.widthPx === widthPx && current.heightPx === heightPx) return;
				setCellDimensions({ widthPx, heightPx });
				this.#host?.cellSize?.();
				return;
			}
			case "inputDrained": {
				const drained = this.#drained;
				this.#drained = undefined;
				drained?.();
				return;
			}
			case "disconnected":
				this.#disconnect(event.data ?? "terminal output failed");
				return;
			case "historyReplay":
				this.#host?.historyReplay?.();
				return;
			case "frameText":
				if (event.data !== undefined) this.#host?.frameText?.(event.data);
				return;
		}
	}

	#reportAppearance(event: EngineEvent): void {
		if (event.rgb !== undefined) setTerminalBackgroundColor(event.rgb);
		const mode: TerminalAppearance = event.dark === true ? "dark" : "light";
		const changed = mode !== this.#appearance;
		this.#appearance = mode;
		// oxlint-disable-next-line unicorn/no-useless-spread -- callbacks may unsubscribe while reporting
		for (const callback of [...this.#appearanceReportCallbacks]) {
			try {
				callback(mode, event.token);
			} catch {
				/* ignore callback errors */
			}
		}
		if (!changed) return;
		for (const callback of this.#appearanceCallbacks) {
			try {
				callback(mode, event.token);
			} catch {
				/* ignore callback errors */
			}
		}
	}

	#publishProgramStatusSupport(supported: boolean): void {
		if (this.#programStatusResult === supported) return;
		this.#programStatusResult = supported;
		for (const callback of this.#programStatusCallbacks) {
			try {
				callback(supported);
			} catch {
				// A subscriber must not interrupt terminal input processing.
			}
		}
	}

	#disconnect(reason: string, err?: unknown): void {
		if (this.#dead) return;
		this.#dead = true;
		this.#cancelTimer();
		this.#io.dead?.();
		logger.warn("terminal disconnected; stopping interactive rendering", { reason, err });

		const host = this.#host;
		if (!host?.disconnect) return;
		// The handler tears the TUI down against a terminal that is already gone,
		// so any step in it can fail. Swallow that: the exit below is the whole
		// point of this method and must not be preempted by teardown noise.
		try {
			host.disconnect();
		} catch (handlerErr) {
			logger.error("Terminal disconnect handler failed; exiting anyway", { err: handlerErr });
		}
		this.#io.hangup?.();
	}
}

/**
 * This process's terminal as a {@link TerminalIo}. The engine owns its stdio
 * (raw mode, the stdin reader, the stdout writer); the port reports geometry
 * from `process.stdout`, whose `resize` event Bun raises on SIGWINCH, and
 * ends the process when the terminal is gone. Test harnesses subclass it to
 * stand a capture port in for the engine-owned stdio (see
 * {@link ProcessTerminal}).
 */
export class ProcessIo implements TerminalIo {
	/**
	 * Re-read at every start(): when true, every real terminal side effect
	 * (stdio ownership, raw mode, probes, SIGWINCH, listeners) is suppressed.
	 * Defaults on under `bun test`; see isTerminalHeadless().
	 */
	headless = isTerminalHeadless();
	#sink: TerminalIoSink | undefined;
	#opened = false;
	readonly #resizeListener = (): void => {
		this.#sink?.resize(this.columns, this.rows);
	};

	get interactive(): boolean {
		return !this.headless;
	}

	/** The engine owns stdio unless headless: a headless terminal touches no real stdio. */
	get processStdio(): boolean {
		return !this.headless;
	}

	/** The engine-owned writer reports its own backlog. */
	get backlog(): number {
		return 0;
	}

	get columns(): number {
		return process.stdout.columns || Number(Bun.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(Bun.env.LINES) || 24;
	}

	open(sink: TerminalIoSink): void {
		this.#sink = sink;
		if (this.headless || this.#opened) return;
		this.#opened = true;
		// The OS refreshes process.stdout dimensions before firing `resize`, so
		// it is authoritative for geometry.
		process.stdout.on("resize", this.#resizeListener);
		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}
	}

	/** Headless: what the engine captured reaches no terminal. */
	write(_chunks: readonly Uint8Array[]): void {}

	close(): void {
		this.#sink = undefined;
		if (!this.#opened) return;
		this.#opened = false;
		process.stdout.removeListener("resize", this.#resizeListener);
	}

	dead(): void {
		// The SIGHUP raised by hangup() is this instance's own disconnect, so
		// postmortem must not write a report to fd 2 afterwards: a stalled stdout
		// leaves that descriptor a full, blocking pty, and the write would hang
		// before the exit.
		postmortem.declareTerminalDead();
	}

	hangup(): void {
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
}

/**
 * The real terminal: this process's stdin and stdout, owned by the engine.
 */
export class ProcessTerminal extends Terminal {
	readonly #io: ProcessIo;

	/** `io` is this process's terminal; test harnesses pass a subclass whose stdio is a capture port. */
	constructor(options?: ProcessTerminalOptions, io: ProcessIo = new ProcessIo()) {
		super(io, options);
		this.#io = io;
	}

	override start(options?: TerminalStartOptions): void {
		// Headless (tests): suppress every real-terminal side effect. The engine
		// takes no stdio (no raw mode, no stdin reader, no stdout writer), and
		// skips capability probes, SIGWINCH, and emergency-restore ownership; the
		// port drops the captured output, so frame paints and teardown escapes
		// never reach the developer's terminal during `bun test`.
		const headless = isTerminalHeadless();
		this.#io.headless = headless;
		if (!headless) {
			registerPostmortemTerminalRestore();
			// Own stdout: out-of-band writers route through this terminal, and the
			// emergency restore finds it on crash.
			setActiveTerminal(this);
			// RGB belongs to this ownership session, including deferred-input prepaint.
			setTerminalBackgroundColor(undefined);
			// Keep unmanaged native fd-2 writes off the viewport while we own the
			// terminal; released in stop(). See stderr-guard in pi-utils.
			suppressTerminalStderr();
			setHangulCompatibilityJamoWidth(TERMINAL.hangulJamoWidth);
		}
		super.start(options);
	}

	override stop(): void {
		// Release stdout ownership (out-of-band writers and emergency cleanup)
		// before teardown, without disturbing another owner's RGB.
		if (getActiveTerminal() === this) {
			setActiveTerminal(null);
			setTerminalBackgroundColor(undefined);
		}
		// Release terminal ownership of fd 2 first so external programs,
		// suspend, and shutdown see the real stderr even if a later teardown
		// step throws.
		if (!this.#io.headless) restoreTerminalStderr();
		super.stop();
	}
}
