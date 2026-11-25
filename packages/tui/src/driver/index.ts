/**
 * The process terminal driver: the input half (`process/`: raw mode, input
 * decoding, probes, capabilities, resize) composed with the frame writer
 * (`output/`) and the inline image store (`images/`).
 *
 * Every byte goes through one sink in order: the input half's mode toggles
 * and probes, frames, and raw protocol writes.
 */
import { logger } from "@oh-my-pi/pi-utils";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { restoreTerminalStderr, suppressTerminalStderr } from "@oh-my-pi/pi-utils/stderr-guard";
import { setJamoWidth } from "../text/width";
import { resolveJamoWidth } from "./caps/identity";
import type { FramePlan, InputEvent, TerminalCapabilities, TerminalDriver } from "./contract";
import { kittyPlaceholdersSupported, TerminalImages } from "./images";
import type { CursorShape, MouseTracking, TerminalIdentity, TerminalInput, TerminalPort } from "./io";
import {
	FrameWriter,
	type Invalidation,
	type OutputSink,
	type ResizeScrollback,
	StallWatchdog,
	type StreamSink,
	streamSink,
} from "./output";
import { sendNotification, type TerminalNotification } from "./notify";
import { createProcessInput, type ProcessInputOptions } from "./process";
import { claimTerminal, releaseTerminal } from "./session";
import { type Signal, signal } from "../reactive";

/** How long a hangup raised on a lost terminal may take to reach its handler before the process quits itself. */
const HANGUP_GRACE_MS = 1000;

/** Configuration of {@link createTerminalDriver}. */
export interface TerminalDriverOptions extends ProcessInputOptions {
	/** Where bytes go (a {@link StreamSink} also reports its backlog). Default: `process.stdout`. */
	readonly sink?: OutputSink | StreamSink;
	/** Retained history after a settled resize. Default: `PI_TUI_RESIZE_SCROLLBACK`, else `preserve`. */
	readonly resizeScrollback?: ResizeScrollback;
	/** Repaint in place after resizes. Default: `PI_TUI_RESIZE_IN_PLACE`, else Warp outside multiplexers/ConPTY. */
	readonly inPlaceResize?: boolean;
	/** Quiet window ending a resize burst, in ms. */
	readonly resizeSettleMs?: number;
	/** Images drawn at once (see `TerminalImages`). */
	readonly imageBudget?: number;
	/** The input half (tests). Default: {@link createProcessInput}. */
	readonly input?: (port: TerminalPort) => TerminalInput;
}

/** The full terminal driver plus what the app and painters reach beyond the contract. */
export interface ProcessTerminalDriver extends TerminalDriver, Pick<TerminalInput, "tspExpected" | "onHelloSettled"> {
	readonly identity: TerminalIdentity;
	/** Inline images: painters ask it for rows, frames carry its sequences. */
	readonly images: TerminalImages;
	/**
	 * The display needs the history ledger again (display reset, settled
	 * resize under `rebuild`/`append`): the next frame should carry a
	 * `replay` batch with the complete ledger at the current width under a fresh id.
	 */
	onReplay(listener: () => void): () => void;
	setMouse(tracking: MouseTracking): void;
	refreshAppearance(): void;
	/** `sequence` wrapped so it reaches the outer terminal through a multiplexer. */
	passthrough(sequence: string): string;
	/** Deliver `event` to the input listeners as if the terminal sent it (debug-socket input injection). */
	inject(event: InputEvent): void;
	/** Raise a desktop notification through the terminal (see `notify.ts`). */
	notify(message: string | TerminalNotification): void;
	/** Show or clear the terminal's busy indicator (OSC 9;4 indeterminate progress). */
	setProgress(active: boolean): void;
	/** Set the hardware cursor's shape (a Vim mode's block or bar); stopping hands the user's own back. */
	setCursorShape(shape: CursorShape): void;
	/**
	 * The terminal went away: stdin ended or failed, stdout failed, or output
	 * stopped draining for good. The driver has already handed the terminal
	 * back; on the process's own terminal it then ends the process (SIGHUP).
	 */
	onDisconnect(listener: (reason: string) => void): () => void;
	/**
	 * Hand the terminal back synchronously, for crash paths that cannot await
	 * {@link TerminalDriver.stop}: leave the alternate screen, show the cursor,
	 * restore input modes and raw mode. The sink is not flushed.
	 */
	restoreNow(): void;
}

const SCROLLBACK_MODES: Readonly<Record<string, ResizeScrollback>> = {
	rebuild: "rebuild",
	append: "append",
	preserve: "preserve",
};

/** Backlog above which frames wait for the terminal to drain (a frame is never queued behind more than this). */
const BACKLOG_DEFER_BYTES = 256 * 1024;
/** How often a running stall episode re-samples the backlog. */
const STALL_POLL_MS = 250;
/** Ghostty drops graphics commands sent right after it starts. */
const GHOSTTY_IMAGE_DELAY_MS = 100;

function envFlag(value: string | undefined): boolean | undefined {
	if (value === "1" || value === "true") return true;
	if (value === "0" || value === "false") return false;
	return undefined;
}

/** Compose the process terminal driver. `stopRenderer` releases a host that cannot stop itself on a fatal exit. */
export function createTerminalDriver(
	options: TerminalDriverOptions = {},
	stopRenderer?: () => void,
): ProcessTerminalDriver {
	const env = options.env ?? Bun.env;
	// The process's own terminal (not an injected one): stderr is kept off its viewport while we run,
	// and losing it ends the process. Without a TTY on both ends (tests, pipes) there is no terminal to
	// lose, so a closed stdin must never take the process down.
	const ownsProcessTerminal =
		!options.sink &&
		!options.input &&
		!options.stdout &&
		process.stdin.isTTY === true &&
		process.stdout.isTTY === true;
	// The sink is built before the input half (which writes through it), so its closures reach the half lazily.
	const half: { input?: TerminalInput } = {};
	const stream: StreamSink | undefined = options.sink
		? "pending" in options.sink
			? (options.sink as StreamSink)
			: undefined
		: streamSink(process.stdout, {
				conpty: () => half.input?.identity.conpty ?? false,
				logPath: env.PI_TUI_WRITE_LOG || undefined,
			});
	const base: OutputSink = options.sink ?? stream!;
	// Hosts reset bracketed paste (iTerm2's state toggle, tmux panes): re-assert it with output.
	const sink: OutputSink = {
		write: data => base.write(half.input?.rearmsPaste ? `\x1b[?2004h${data}` : data),
		flush: () => base.flush(),
	};
	const port: TerminalPort = { write: data => sink.write(data) };
	const terminal = options.input?.(port) ?? createProcessInput(port, options);
	half.input = terminal;
	const capabilities: Signal<TerminalCapabilities> = signal(terminal.capabilities);
	const replayListeners = new Set<() => void>();
	const inputListeners = new Set<(event: InputEvent) => void>();
	// DOM dispatch semantics: a listener subscribed while an event is delivered waits for the next
	// one, and one unsubscribed before its turn is skipped. A key that opens a page (Esc Esc's
	// rewind) starts that page's backend mid-dispatch; a live Set would hand it the same key.
	const deliver = (event: InputEvent): void => {
		for (const listener of Array.from(inputListeners)) if (inputListeners.has(listener)) listener(event);
	};
	terminal.onInput(deliver);
	const resizeListeners = new Set<(columns: number, rows: number) => void>();

	const resizeScrollback =
		options.resizeScrollback ?? SCROLLBACK_MODES[env.PI_TUI_RESIZE_SCROLLBACK ?? ""] ?? "preserve";
	const forcedInPlace = options.inPlaceResize ?? envFlag(env.PI_TUI_RESIZE_IN_PLACE);
	const multiplexed = (): boolean => terminal.identity.multiplexer !== null;
	const warp = (): boolean => terminal.identity.id === "warp";

	const kittyReady = signal(true);
	let cancelKittyHold: (() => void) | undefined;
	const images = new TerminalImages({
		capabilities,
		placeholders: () => kittyPlaceholdersSupported(terminal.identity.id, env),
		budget: options.imageBudget,
		kittyReady,
	});
	const tmux = (): boolean => terminal.identity.multiplexer === "tmux";
	const disconnectListeners = new Set<(reason: string) => void>();
	let dead = false;
	const disconnected = (reason: string, error?: unknown): void => {
		if (dead) return;
		dead = true;
		stopStallPoll();
		if (ownsProcessTerminal) postmortem.declareTerminalDead();
		logger.warn("pi-tui: terminal disconnected; stopping", {
			reason,
			error: error === undefined ? undefined : String(error),
		});
		try {
			driver.restoreNow();
		} catch {
			// The terminal is gone; nothing to restore.
		}
		for (const listener of disconnectListeners) listener(reason);
		if (!ownsProcessTerminal) return;
		if (process.platform === "win32") {
			void postmortem.quit(129, { drainStdout: false });
			return;
		}
		try {
			process.kill(process.pid, "SIGHUP");
			// The signal's handler runs on a later turn of the event loop, which the dead terminal may
			// have left with nothing to wait for: hold it open, or the process drains and ends as a
			// plain exit (teardown then records `exit` instead of the hangup).
			setTimeout(() => void postmortem.quit(129), HANGUP_GRACE_MS);
		} catch {
			void postmortem.quit(129);
		}
	};
	// A reader that stopped consuming for good never throws: only the backlog tells.
	const watchdog = new StallWatchdog();
	let stallPoll: ReturnType<typeof setInterval> | undefined;
	const stopStallPoll = (): void => {
		clearInterval(stallPoll);
		stallPoll = undefined;
		watchdog.reset();
	};
	const sampleStall = (pending: number): void => {
		if (dead) return;
		if (watchdog.sample(pending, performance.now())) {
			disconnected("output stalled");
			return;
		}
		if (watchdog.armed && !stallPoll) {
			stallPoll = setInterval(() => sampleStall(stream!.pending()), STALL_POLL_MS);
			stallPoll.unref?.();
		} else if (!watchdog.armed && stallPoll) {
			stopStallPoll();
		}
	};
	// Frames skipped while the terminal is not draining wait for its drain, then repaint.
	let deferred = false;
	const backlogged = (): boolean => {
		if (!stream) return false;
		const pending = stream.pending();
		sampleStall(pending);
		if (pending <= BACKLOG_DEFER_BYTES) return false;
		if (!deferred) {
			deferred = true;
			stream.onDrain(() => {
				deferred = false;
				emitResize();
			});
		}
		return true;
	};

	const emitResize = (): void => {
		for (const listener of resizeListeners) listener(terminal.columns, terminal.rows);
	};
	const writer = new FrameWriter({
		sink,
		columns: terminal.columns,
		rows: terminal.rows,
		synchronizedOutput: () => terminal.capabilities.synchronizedOutput,
		multiplexer: multiplexed,
		// Inside a multiplexer the mux, not conhost, owns the grid and answers the cursor report.
		hostOwnsGrid: () => terminal.identity.conpty && !multiplexed(),
		warp,
		inPlaceResize: () => forcedInPlace ?? (warp() && !multiplexed() && !terminal.identity.conpty),
		resizeAvoidsAlternate: () =>
			forcedInPlace !== false &&
			resizeScrollback === "rebuild" &&
			terminal.capabilities.synchronizedOutput &&
			tmux(),
		renewsSynchronizedOutput: tmux,
		growsBeforeResize: tmux,
		resizeScrollback,
		settleMs: options.resizeSettleMs,
		queryCursor: () => terminal.queryCursor(),
		keyboardScreenModes: () => terminal.keyboardScreenModes(),
		images,
		canReplay: () => replayListeners.size > 0,
		onInvalidate: (request: Invalidation) => {
			if (request === "replay") for (const listener of replayListeners) listener();
			emitResize();
		},
	});

	terminal.onResize((columns, rows) => {
		writer.resize(columns, rows);
		for (const listener of resizeListeners) listener(columns, rows);
	});
	terminal.onCapabilities(next => capabilities.set(next));
	terminal.onDisconnect(reason => disconnected(reason));
	const onStdoutError = (error: unknown): void => disconnected("stdout failed", error);

	let running = false;
	let stopping: Promise<void> | undefined;
	const stopWriter = (): void => {
		cancelKittyHold?.();
		kittyReady.set(true);
		stopStallPoll();
		writer.stop();
	};
	const release = (): void => {
		try {
			terminal.stop();
		} finally {
			releaseTerminal(driver);
			if (ownsProcessTerminal) {
				process.stdout.off("error", onStdoutError);
				restoreTerminalStderr();
			}
		}
	};
	const handBack = async (): Promise<void> => {
		try {
			stopWriter();
		} finally {
			try {
				if (terminal.drainInput) await terminal.drainInput(() => sink.flush());
			} finally {
				release();
			}
			if (!terminal.drainInput) await sink.flush();
		}
	};
	const restoreOwner = async (): Promise<void> => {
		try {
			stopRenderer?.();
		} finally {
			await driver.stop();
		}
	};

	const driver: ProcessTerminalDriver = {
		get columns() {
			return terminal.columns;
		},
		get rows() {
			return terminal.rows;
		},
		get capabilities() {
			return terminal.capabilities;
		},
		get identity() {
			return terminal.identity;
		},
		images,
		async start() {
			if (stopping) await stopping;
			stopping = undefined;
			running = true;
			claimTerminal(driver, restoreOwner);
			dead = false;
			// Keep native fd-2 writes off the viewport while we own the terminal; a failing stdout means it is gone.
			if (ownsProcessTerminal) {
				suppressTerminalStderr();
				process.stdout.on("error", onStdoutError);
			}
			await terminal.start();
			if (!running) return;
			setJamoWidth(resolveJamoWidth(terminal.identity.id, env));
			if (terminal.identity.id === "ghostty" && terminal.capabilities.images === "kitty") {
				kittyReady.set(false);
				const timer = setTimeout(() => kittyReady.set(true), GHOSTTY_IMAGE_DELAY_MS);
				cancelKittyHold = () => clearTimeout(timer);
			}
			writer.resize(terminal.columns, terminal.rows);
			const cursor = await terminal.queryCursor();
			if (running) writer.start(cursor);
		},
		stop() {
			if (stopping) return stopping;
			if (!running) return Promise.resolve();
			running = false;
			stopping = handBack();
			return stopping;
		},
		restoreNow() {
			if (!running && !stopping) return;
			try {
				stopRenderer?.();
			} finally {
				running = false;
				try {
					stopWriter();
				} finally {
					release();
				}
			}
		},
		present: (frame: FramePlan) => {
			if (!backlogged()) return writer.present(frame);
			// Skipped for the backlog; the last one is still written when the driver stops (a shutdown flush).
			writer.hold(frame);
			return undefined;
		},
		viewportRow: row => writer.viewportRow(row),
		replaysOnResize: () => writer.replaysOnWidthChange(),
		writeRaw: (data: string) => {
			if (running) writer.writeRaw(data);
		},
		onInput(listener) {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
		inject: deliver,
		onResize(listener) {
			resizeListeners.add(listener);
			return () => resizeListeners.delete(listener);
		},
		onCapabilities: listener => terminal.onCapabilities(listener),
		onReplay(listener) {
			replayListeners.add(listener);
			return () => replayListeners.delete(listener);
		},
		resetDisplay() {
			images.reset();
			writer.resetDisplay();
		},
		setProgress: active => terminal.setProgress(active),
		setCursorShape: shape => terminal.setCursorShape(shape),
		onDisconnect(listener) {
			disconnectListeners.add(listener);
			return () => disconnectListeners.delete(listener);
		},
		setTitle: title => terminal.setTitle(title),
		get tspExpected() {
			return terminal.tspExpected;
		},
		onHelloSettled: listener => terminal.onHelloSettled(listener),
		setMouse: tracking => terminal.setMouse(tracking),
		refreshAppearance: () => terminal.refreshAppearance(),
		passthrough: sequence => terminal.passthrough(sequence),
		notify(message) {
			const { notify, richNotifications } = terminal.identity;
			sendNotification(message, {
				protocol: notify,
				rich: richNotifications,
				env,
				write: driver.writeRaw,
			});
		},
	};
	return driver;
}

export * from "./contract";
export { FrameWriter, type OutputSink, type ResizeScrollback, streamSink } from "./output";
