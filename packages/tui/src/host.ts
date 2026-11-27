/**
 * Host: runs one {@link Surface} on the process terminal.
 *
 * Starts the terminal driver with the TSP `hello` among its startup probes.
 * A terminal that answers (Tern) renders the surface natively through the
 * {@link NativeSurfaces}; any other terminal gets the in-process
 * {@link TermBackend}. Both route input to the same node handlers, so the
 * program never branches on the renderer.
 *
 * Each host runs a {@link LoopWatchdog} from start to stop: it logs
 * `ui.loop-blocked` when the event loop stalls, and the input decoder asks it
 * whether a multi-line burst was typed during a stall.
 *
 * @example
 * ```ignore
 * const surface = createSurface(() => ({ main: transcript.nodes, dock: <Composer model={composer} /> }));
 * const host = await startHost({ surface, theme: currentTheme, title: "omp" });
 * // …
 * await host.stop();
 * ```
 */
import { createTerminalDriver, type ProcessTerminalDriver, type TerminalDriverOptions } from "./driver";
import { LoopWatchdog } from "./diag/loop-watchdog";
import type { KeyEvent } from "./events";
import { encodeHelloQuery, NativeSurfaces, TspConnection } from "./native";
import { isTernPane } from "./driver/caps/identity";
import type { ScrollRequest, UiNode } from "./node";
import type { Surface } from "./surface";
import { driverImages, type ScreenMode, TermBackend } from "./term/backend";
import type { Theme } from "./theme/contract";
import type { FramePlan, InputEvent, TerminalDriver } from "./driver/contract";
import type { MouseTracking } from "./driver/io";
import { CURSOR_HIDE } from "./driver/output/ansi";
import { logger } from "@oh-my-pi/pi-utils";
import { markExpectedCleanupError } from "@oh-my-pi/pi-utils/postmortem";
import { type Accessor, type Reactive, signal } from "./reactive";

/** Configuration of {@link startHost}. */
export interface HostOptions {
	readonly surface: Surface;
	readonly theme: Accessor<Theme>;
	readonly title?: string;
	/** The title native surfaces open with (Tern names the surface by it). Default: {@link title}. */
	readonly surfaceTitle?: string;
	/** The native surface's role (Tern treats `omp.session` as omp's chat session). */
	readonly role?: string;
	/** Program version sent in the TSP hello. */
	readonly version?: string;
	/** Keys nothing on the focus path consumed (global shortcuts). Return true when handled. */
	readonly onKey?: (key: KeyEvent) => boolean;
	/** Sees every decoded input event (keys, pastes, mouse, OSC replies) before routing; true consumes it. */
	readonly intercept?: (event: InputEvent) => boolean;
	/** Render natively when the terminal speaks TSP. Default true. */
	readonly native?: boolean;
	/** Blank rows between two non-empty main blocks in the terminal renderer. Default 1. */
	readonly separator?: (above: UiNode, below: UiNode) => number;
	/** Frame-rate cap of the terminal renderer: shortest gap between frames in ms (may change). Default 16. */
	readonly frameInterval?: Reactive<number>;
	/** Force OSC 8 hyperlinks on or off in the terminal renderer; undefined follows the terminal. */
	readonly hyperlinks?: Accessor<boolean | undefined>;
	/**
	 * Allow OSC 66 sized text (Markdown H1 at double size) in the terminal renderer where the
	 * terminal draws it (Kitty, outside multiplexers). Default: never.
	 */
	readonly textSizing?: Accessor<boolean>;
	/**
	 * The terminal clock painters read, instead of the wall clock advanced on animation ticks
	 * (scripted replays move it themselves). Terminal renderer only.
	 */
	readonly clock?: Accessor<number>;
	/** Driver configuration (resize policy, image budget, test streams). */
	readonly driver?: TerminalDriverOptions;
	/**
	 * Where the terminal renderer draws the session (may change at runtime): `inline` on the normal
	 * screen, or `fullscreen` on the alternate screen with `main` scrolling above a pinned dock.
	 * Native (Tern) rendering ignores it. Default `inline`.
	 */
	readonly screen?: Accessor<ScreenMode>;
	/**
	 * Called synchronously right before the in-process terminal renderer starts
	 * (initial rows launch or optimistic-Tern fallback). Lets callers register
	 * terminal-only painters lazily so native Tern sessions never load them.
	 */
	readonly beforeTerminalRenderer?: () => void;
}

/** A running surface. */
/** A frame the terminal renderer showed, as a screen observer (recorder, live stream) needs it. */
export interface PresentedFrame {
	/** Rows this frame wrote to terminal history (each batch reported once). */
	readonly history: readonly string[];
	/** The history was replaced (a display reset): drop earlier history before adding `history`. */
	readonly reset: boolean;
	/** The live rows: the inline viewport, or the fullscreen layer's. */
	readonly viewport: readonly string[];
	/** `viewport` is a fullscreen layer on the alternate screen (history untouched). */
	readonly alt: boolean;
	readonly cursor: { readonly row: number; readonly col: number } | null;
	readonly columns: number;
	readonly rows: number;
}

export interface Host {
	/**
	 * Whether the terminal renders the surface itself (Tern), reactive: an
	 * optimistic Tern start the terminal does not confirm falls back to the
	 * terminal renderer (see {@link startHost}, {@link Host.onChange}).
	 */
	readonly native: boolean;
	/**
	 * The terminal's clock from the TSP hello (`false`: 24-hour), reactive;
	 * undefined in the terminal renderer, before an optimistic start's reply, or when Tern doesn't say.
	 */
	readonly hour12: boolean | undefined;
	/** `listener` runs after {@link Host.native} or {@link Host.hour12} changed. Returns the removal. */
	onChange(listener: () => void): () => void;
	readonly driver: ProcessTerminalDriver;
	/**
	 * Whether `node` has rows in terminal history a plain terminal cannot
	 * repaint (always false natively, where nothing retires).
	 */
	retired(node: UiNode): boolean;
	/** Redraw terminal history from the current main region (its retired rows changed or went away). */
	replayHistory(): void;
	/**
	 * The settled main block holding `node` changed after it was final: a Tern terminal, which
	 * dropped its description, gets it again (a plain terminal replays history instead).
	 */
	redescribe(node: UiNode): void;
	/** Route `event` to the focused node as if the terminal sent it (a paste the app recovered itself). */
	dispatch(event: InputEvent): void;
	/** Whether the terminal advertises TSP feature `name` (reactive; always false in the terminal renderer). */
	feature(name: string): boolean;
	/**
	 * Whether the terminal reads and shows this session's checkout itself
	 * (Tern's `checkout` event, reactive; always false in the terminal
	 * renderer): the app shows the branch, its changes and its pull request
	 * from it and runs no `git status` or `gh` itself.
	 */
	checkoutShown(): boolean;
	/**
	 * Hand the terminal to `run` (an external editor, a job-control stop): rendering and input pause
	 * and the terminal is restored; once `run` settles the driver starts again and the display is
	 * redrawn whole.
	 */
	suspend<R>(run: () => Promise<R>): Promise<R>;
	/**
	 * Observe every frame the terminal renderer presents (never called natively: Tern draws the
	 * surface itself). Returns the removal.
	 */
	onFrame(listener: (frame: PresentedFrame) => void): () => void;
	/**
	 * Schedule a terminal frame even when nothing it shows changed, so {@link Host.onFrame}
	 * listeners hear one (a no-op natively).
	 */
	requestFrame(): void;
	/**
	 * Set the terminal's mouse reporting (the driver's `setMouse`). Turning it off also forgets
	 * the hovered hit, whose band no report would clear anymore.
	 */
	setMouse(tracking: MouseTracking): void;
	/**
	 * Scroll the fullscreen transcript window (a page, a line, its start or end, or a row count);
	 * the end follows the tail again. False when no such window is on screen (inline mode, a
	 * fullscreen page up, native rendering), so the caller's key can go elsewhere.
	 */
	scroll(by: ScrollRequest["by"] | number): boolean;
	/** Stop rendering, close the native surface, restore the terminal. */
	stop(): Promise<void>;
}

/** `driver` presenting through `notify`: each history batch is reported once, when written. */
function tapFrames(driver: TerminalDriver, notify: (frame: PresentedFrame) => void): TerminalDriver {
	let reported: number | undefined;
	const present = (plan: FramePlan): number | undefined => {
		const written = driver.present(plan);
		const fresh = plan.history !== undefined && plan.history.id !== reported && written === plan.history.id;
		if (fresh) reported = plan.history!.id;
		notify({
			history: fresh ? plan.history!.rows : [],
			reset: fresh && plan.history!.kind === "replay",
			viewport: plan.fullscreen ?? plan.viewport,
			alt: plan.fullscreen !== undefined,
			cursor: plan.cursor,
			columns: driver.columns,
			rows: driver.rows,
		});
		return written;
	};
	return Object.create(driver, { present: { value: present } }) as TerminalDriver;
}

const nativeSurface = signal(false);

/**
 * Whether a host in this process renders its surface natively (Tern) right
 * now (reactive): true from a native start until that host stops.
 */
export const nativeRendering: Accessor<boolean> = () => nativeSurface();

/** Test seam: flip {@link nativeRendering} without starting a native host. */
export function setNativeRenderingForTest(native: boolean): void {
	nativeSurface.set(native);
}

/** The connection of the host rendering natively, when one is. */
let nativeConnection: TspConnection | undefined;

/**
 * Whether the terminal drawing this process's surface natively draws `kind`
 * (reactive). False while a host renders terminal rows, so components can
 * describe a newer kind (`button`, `buttons`) only where it is drawn.
 */
export function nativeSupports(kind: string): boolean {
	return nativeSurface() && (nativeConnection?.supports(kind) ?? true);
}

/**
 * How long an optimistic native start (a Tern pane) waits for the terminal's
 * `hello` reply before it falls back to the terminal renderer.
 */
export const HELLO_CONFIRM_MS = 1000;
/**
 * A confirm deadline that fired later than this ran after an event-loop stall,
 * possibly with the reply already queued on stdin: it re-arms this long so
 * input runs first.
 */
const HELLO_CONFIRM_GRACE_MS = 100;

/** The renderer a host runs: the {@link Host} members that differ between native and terminal rendering. */
type Renderer = Pick<
	Host,
	| "native"
	| "hour12"
	| "retired"
	| "replayHistory"
	| "redescribe"
	| "dispatch"
	| "feature"
	| "checkoutShown"
	| "setMouse"
	| "scroll"
	| "suspend"
	| "requestFrame"
> & {
	/** Stop rendering and release the renderer (not the driver). */
	stop(): void;
};

/**
 * Start the driver, negotiate TSP, and render `surface` with the backend the
 * terminal supports.
 *
 * In a Tern pane (`TERM_PROGRAM=tern`) the surface opens natively right after
 * the driver starts, on an assumed `hello` (`TspConnection.assume`), instead
 * of waiting for the reply: on a loaded machine the reply can come after a
 * fixed wait gave up. The reply then replaces what was assumed. When the
 * terminal answers DA1 without it, answers a version this build does not
 * speak, or stays silent for {@link HELLO_CONFIRM_MS}, the surface closes and
 * the host falls back to the terminal renderer ({@link Host.onChange}).
 */
export async function startHost(options: HostOptions): Promise<Host> {
	const native = options.native ?? true;
	const watchdog = new LoopWatchdog();
	let stopped = false;
	let haltRenderer: (() => void) | undefined;
	let cancelConfirmation: (() => void) | undefined;
	const driver = createTerminalDriver(
		{
			isLoopStalled: () => watchdog.isStalled(),
			...options.driver,
			...(native ? { hello: encodeHelloQuery(options.version ? { ver: options.version } : {}) } : {}),
		},
		() => {
			if (stopped) return;
			stopped = true;
			watchdog.stop();
			cancelConfirmation?.();
			haltRenderer?.();
		},
	);
	// Both read the reply to the driver's `hello` probe, so they exist before it starts.
	const optimistic = native && isTernPane(options.driver?.env ?? Bun.env);
	const assumed = optimistic ? TspConnection.assume(driver) : undefined;
	// A terminal that answers the hello batch's DA1 first speaks no TSP: rows start without waiting out the deadline.
	const connecting =
		native && !optimistic
			? TspConnection.connect(driver, { queried: true, settled: listener => driver.onHelloSettled(listener) })
			: Promise.resolve(null);
	// Keys typed while the driver probes and the renderer is chosen would reach no listener: hold them for it.
	const early: InputEvent[] = [];
	const offEarly = driver.onInput(event => {
		if (event.type === "key" || event.type === "paste") early.push(event);
	});
	watchdog.start();
	try {
		await driver.start();
	} catch (error) {
		offEarly();
		watchdog.stop();
		assumed?.close();
		throw error;
	}
	if (options.title) driver.setTitle(options.title);
	let connection = await connecting;
	if (assumed) {
		// The `hello` never went out (a multiplexer swallows APC), or the terminal already declined it.
		if (driver.tspExpected && assumed.confirmation !== "unsupported") connection = assumed;
		else assumed.close();
	}
	// The repository's `tui` debug tool names a socket here. Imported lazily: hosts without it load none of the server.
	const debugPath = Bun.env.OMP_TUI_DEBUG;
	const debug = debugPath ? new (await import("./debug/server")).DebugServer(debugPath) : undefined;

	// A signal can release the driver while startup is awaiting the handshake.
	// Do not reopen a surface after that release (or report a second fatal error).
	if (stopped) {
		offEarly();
		connection?.close();
		throw markExpectedCleanupError(new Error("terminal stopped during startup"));
	}

	const frameListeners = new Set<(frame: PresentedFrame) => void>();
	const changeListeners = new Set<() => void>();
	/** Bumped when the renderer or what it reports (`hour12`) changes: makes `native`/`hour12` reactive. */
	const revision = signal(0);
	const changed = (): void => {
		revision.set(revision.peek() + 1);
		for (const listener of changeListeners) listener();
	};

	const nativeRenderer = (connection: TspConnection): Renderer => {
		const surfaceTitle = options.surfaceTitle ?? options.title;
		const backend = new NativeSurfaces({
			surface: options.surface,
			...(surfaceTitle ? { title: surfaceTitle } : {}),
			...(options.role ? { role: options.role } : {}),
			...(options.onKey ? { onKey: options.onKey } : {}),
			...(options.intercept ? { intercept: options.intercept } : {}),
			...(debug ? { onFrame: frame => debug.sent(frame) } : {}),
		});
		debug?.start({ surface: options.surface, driver, native: true, theme: options.theme, stop: host.stop });
		const halt = (): void => {
			try {
				backend.stop(false);
			} finally {
				connection.close();
				nativeConnection = undefined;
				nativeSurface.set(false);
			}
		};
		haltRenderer = () => {
			debug?.stop();
			halt();
		};
		/** Open (or adopt) the surface. Tern draws the caret itself: the grid's hardware cursor stays hidden under it. */
		const open = (): void => {
			backend.start(connection);
			driver.writeRaw(CURSOR_HIDE);
		};
		open();
		nativeConnection = connection;
		nativeSurface.set(true);
		return {
			native: true,
			get hour12() {
				return connection.hello.hour12;
			},
			retired: () => false,
			replayHistory: () => {},
			redescribe: node => backend.redescribe(node),
			dispatch: event => backend.dispatch(event),
			feature: name => connection.hasFeature(name),
			checkoutShown: () => connection.checkout(),
			setMouse: tracking => driver.setMouse(tracking),
			scroll: () => false,
			requestFrame: () => {},
			async suspend(run) {
				backend.stop(false);
				await driver.stop();
				try {
					return await run();
				} finally {
					if (!stopped) {
						await driver.start();
						open();
					}
				}
			},
			stop: halt,
		};
	};

	const termRenderer = (): Renderer => {
		options.beforeTerminalRenderer?.();
		const presenting = tapFrames(driver, frame => {
			for (const listener of frameListeners) listener(frame);
		});
		const backend = new TermBackend({
			surface: options.surface,
			driver: debug ? debug.tap(presenting) : presenting,
			theme: options.theme,
			images: driverImages(driver.images, () => driver.capabilities),
			...(options.separator ? { separator: options.separator } : {}),
			...(options.frameInterval === undefined ? {} : { frameInterval: options.frameInterval }),
			...(options.hyperlinks ? { hyperlinks: options.hyperlinks } : {}),
			...(options.textSizing ? { textSizing: options.textSizing } : {}),
			...(options.clock ? { clock: options.clock } : {}),
			...(options.screen ? { screen: options.screen } : {}),
			...(options.onKey ? { onKey: options.onKey } : {}),
			...(options.intercept ? { intercept: options.intercept } : {}),
		});
		debug?.start({
			surface: options.surface,
			driver,
			native: false,
			theme: options.theme,
			environment: backend.environment,
			stop: host.stop,
		});
		haltRenderer = () => {
			debug?.stop();
			backend.stop();
		};
		backend.start();
		return {
			native: false,
			hour12: undefined,
			retired: node => backend.retired(node),
			replayHistory: () => driver.resetDisplay(),
			redescribe: () => {},
			dispatch: event => backend.dispatch(event),
			feature: () => false,
			checkoutShown: () => false,
			requestFrame: () => backend.requestRender(),
			setMouse(tracking) {
				driver.setMouse(tracking);
				if (tracking === "off") backend.clearHover();
			},
			scroll: by => backend.scroll(by),
			async suspend(run) {
				backend.renderNow();
				backend.stop();
				await driver.stop();
				try {
					return await run();
				} finally {
					await driver.start();
					// A fullscreen session that never wrote history has nothing to redraw on the normal
					// screen (a reset would clear it at exit): its next frame paints the alternate screen whole.
					if ((options.screen?.() ?? "inline") === "inline" || backend.wroteHistory) driver.resetDisplay();
					backend.start();
				}
			},
			stop() {
				// Graceful shutdown: the whole transcript goes into terminal history before the terminal is handed back.
				try {
					backend.flush();
				} finally {
					backend.stop();
				}
			},
		};
	};

	let renderer: Renderer;
	const host: Host = {
		get native() {
			revision();
			return renderer.native;
		},
		get hour12() {
			revision();
			return renderer.hour12;
		},
		driver,
		retired: node => renderer.retired(node),
		replayHistory: () => renderer.replayHistory(),
		redescribe: node => renderer.redescribe(node),
		dispatch: event => renderer.dispatch(event),
		feature: name => renderer.feature(name),
		checkoutShown: () => renderer.checkoutShown(),
		suspend: run => renderer.suspend(run),
		requestFrame: () => renderer.requestFrame(),
		onFrame(listener) {
			frameListeners.add(listener);
			return () => frameListeners.delete(listener);
		},
		onChange(listener) {
			changeListeners.add(listener);
			return () => changeListeners.delete(listener);
		},
		setMouse: tracking => renderer.setMouse(tracking),
		scroll: by => renderer.scroll(by),
		async stop() {
			if (stopped) return driver.stop();
			stopped = true;
			watchdog.stop();
			cancelConfirmation?.();
			debug?.stop();
			try {
				renderer.stop();
			} finally {
				await driver.stop();
			}
		},
	};
	renderer = connection ? nativeRenderer(connection) : termRenderer();
	offEarly();
	for (const event of early) if (!options.intercept?.(event)) renderer.dispatch(event);
	if (connection?.confirmation === "assumed") {
		const unconfirmed = connection;
		const fallBack = (reason: string): void => {
			settle();
			if (stopped) return;
			logger.warn("TSP: terminal did not confirm the surface; falling back to rows", { reason });
			renderer.stop();
			renderer = termRenderer();
			changed();
		};
		const offHello = unconfirmed.onHello(confirmed => {
			if (!confirmed) return fallBack("the terminal answered an unsupported TSP version");
			settle();
			if (unconfirmed.hello.hour12 !== undefined) changed();
		});
		const offSettled = driver.onHelloSettled(() => {
			if (unconfirmed.confirmation === "assumed") fallBack("the DA1 sentinel came before a TSP hello reply");
		});
		let cancelDeadline = (): void => {};
		const arm = (delay: number): void => {
			const due = unconfirmed.clock.now() + delay;
			cancelDeadline = unconfirmed.clock.setTimeout(() => {
				if (unconfirmed.clock.now() - due > HELLO_CONFIRM_GRACE_MS) arm(HELLO_CONFIRM_GRACE_MS);
				else fallBack(`no TSP hello reply within ${HELLO_CONFIRM_MS} ms`);
			}, delay);
		};
		const settle = (): void => {
			offHello();
			offSettled();
			cancelDeadline();
			cancelConfirmation = undefined;
		};
		cancelConfirmation = settle;
		arm(HELLO_CONFIRM_MS);
	}
	return host;
}
