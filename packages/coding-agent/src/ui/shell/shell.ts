/**
 * The interactive app's UI shell: one pi-tui surface holding the transcript
 * (main), the dock (composer and live chrome) and the overlay stack (layer),
 * running natively in Tern or in the terminal renderer elsewhere.
 *
 * Controllers never build regions themselves: they append transcript blocks,
 * fill dock slots and open overlays; the shell orders them for the renderer
 * in use.
 *
 * @example
 * ```ignore
 * const shell = new Shell();
 * shell.dock.slot("composer").set(() => <Composer model={composer} />);
 * await shell.start({ theme: currentTheme, title: "omp" });
 * const block = shell.transcript.append(() => <UserMessage message={message} />);
 * shell.transcript.settle(block);
 * ```
 */
import {
	type Accessor,
	createRoot,
	createSurface,
	effect,
	type Host,
	type KeyEvent,
	type Reactive,
	type ScrollRequest,
	type Signal,
	type Surface,
	signal,
	startHost,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import type { InputEvent, TerminalDriverOptions } from "@oh-my-pi/pi-tui/driver/index";
import type { MouseTracking } from "@oh-my-pi/pi-tui/driver/io";
import type { ScreenMode } from "@oh-my-pi/pi-tui/term/backend";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";

let terminalStylesLoaded = false;
/**
 * Register every terminal look on first terminal-renderer start. Native Tern
 * surfaces render in the terminal itself and never consult terminal painters,
 * keeping the ~330 style modules off native startup.
 */
function ensureTerminalStylesLoaded(): void {
	if (terminalStylesLoaded) return;
	terminalStylesLoaded = true;
	require("../styles");
}
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { Dock, type DockSlot, NATIVE_DOCK, NATIVE_TAIL, TERMINAL_DOCK } from "./dock";
import { Overlays } from "./overlays";
import { Transcript } from "./transcript";

/** Configuration of {@link Shell.start}. */
export interface ShellStartOptions {
	readonly theme: Accessor<Theme>;
	readonly title?: string;
	/** The native surface's role (Tern treats `omp.session` as omp's chat session). */
	readonly role?: string;
	readonly version?: string;
	/** Keys nothing on the focus path consumed: the app's global bindings. Return true when handled. */
	readonly onKey?: (key: KeyEvent) => boolean;
	/** Render natively when the terminal speaks TSP. Default true. */
	readonly native?: boolean;
	readonly driver?: TerminalDriverOptions;
	/** Shortest gap between terminal frames, ms (may change at runtime: `tui.maxFps`). */
	readonly frameInterval?: Reactive<number>;
	/** Force OSC 8 hyperlinks on or off in the terminal renderer (`tui.hyperlinks`); undefined follows the terminal. */
	readonly hyperlinks?: Accessor<boolean | undefined>;
	/** Draw headings at their size where the terminal supports text sizing (`tui.textSizing`, OSC 66). */
	readonly textSizing?: Accessor<boolean>;
	/** The terminal clock painters read (scripted replays); default the wall clock. */
	readonly clock?: Accessor<number>;
	/** Where the terminal renderer draws the session (`tui.screen`, may change at runtime). Default inline. */
	readonly screen?: Accessor<ScreenMode>;
}

/**
 * An input interceptor: true consumes the event; an array replaces it (the replacements continue
 * through the older interceptors, then reach the focus path); false passes it on.
 */
export type InputInterceptor = (event: InputEvent) => boolean | readonly InputEvent[];

/** The terminal's size in cells. */
export interface TerminalSize {
	readonly columns: number;
	readonly rows: number;
}

/** See the module docs. */
export class Shell {
	readonly transcript = new Transcript();
	readonly dock = new Dock();
	readonly overlays: Overlays;
	readonly surface: Surface;
	readonly #native: Signal<boolean> = signal(false);
	readonly #hour12: Signal<boolean | undefined> = signal<boolean | undefined>(undefined);
	readonly #size: Signal<TerminalSize> = signal<TerminalSize>({
		columns: process.stdout.columns || 80,
		rows: process.stdout.rows || 24,
	});
	#unwatchResize: (() => void) | undefined;
	#unwatchHost: (() => void) | undefined;
	#unwatchMouse: (() => void) | undefined;
	readonly #inlineMouse = signal<MouseTracking>("off");
	readonly #interceptors: InputInterceptor[] = [];
	readonly #globalKeys: ((key: KeyEvent) => boolean)[] = [];
	#home: UiNode | null = null;
	#host: Host | undefined;
	#theme: Accessor<Theme> | undefined;

	constructor() {
		this.overlays = new Overlays({
			focused: () => this.surface.focused(),
			focus: node => this.surface.focus(node),
			fallback: () => this.#home,
		});
		const terminalDock = this.dock.terminalViews();
		const nativeDock = this.dock.views(NATIVE_DOCK);
		const nativeTail = this.dock.views(NATIVE_TAIL);
		this.surface = createSurface(() => ({
			main: () => (this.#native() ? [this.transcript.nativeNodes, nativeTail] : this.transcript.nodes),
			dock: () => (this.#native() ? nativeDock : terminalDock),
			layer: this.overlays.nodes,
		}));
	}

	/** Whether Tern renders the UI natively (reactive; false until started). */
	readonly native: Accessor<boolean> = () => this.#native();

	/** The terminal's clock (`hour12` from Tern's hello; undefined in a plain terminal or before start). */
	readonly hour12: Accessor<boolean | undefined> = () => this.#hour12();

	/** The terminal's size in cells (reactive; follows resizes once started). */
	readonly size: Accessor<TerminalSize> = () => this.#size();

	/** The running host (driver access, scrollback queries); undefined until started. */
	get host(): Host | undefined {
		return this.#host;
	}

	/**
	 * Resolves once the terminal renderer presents its next frame, which it schedules; at once when
	 * nothing draws to a terminal.
	 */
	nextFrame(): Promise<void> {
		const host = this.#host;
		if (!host || host.native) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const stop = host.onFrame(() => {
			stop();
			resolve();
		});
		// A change only schedules a frame when the last one read it: ask, whatever is on screen.
		host.requestFrame();
		return promise;
	}

	/**
	 * Scroll the fullscreen transcript (a page, a line, its start or end); its end follows the tail
	 * again. False when none is on screen (inline mode, a page up, Tern, not started).
	 */
	scrollTranscript(by: ScrollRequest["by"]): boolean {
		return this.#host?.scroll(by) ?? false;
	}

	/** Set inline mouse reporting; a modal screen's override lasts until it closes. */
	setInlineMouse(tracking: MouseTracking): void {
		this.#inlineMouse.set(tracking);
	}

	/** Start rendering on the process terminal. */
	async start(options: ShellStartOptions): Promise<void> {
		const host = await startHost({
			surface: this.surface,
			theme: options.theme,
			separator: this.transcript.separator,
			...(options.title ? { title: options.title } : {}),
			// Tern names every omp surface "omp"; the terminal title is the session's own business.
			surfaceTitle: "omp",
			...(options.role ? { role: options.role } : {}),
			...(options.version ? { version: options.version } : {}),
			onKey: key => (options.onKey?.(key) ?? false) || this.#globalKeys.toReversed().some(handler => handler(key)),
			intercept: event => this.#intercept(event, this.#interceptors.length - 1),
			...(options.native === undefined ? {} : { native: options.native }),
			...(options.driver ? { driver: options.driver } : {}),
			...(options.frameInterval !== undefined ? { frameInterval: options.frameInterval } : {}),
			...(options.hyperlinks ? { hyperlinks: options.hyperlinks } : {}),
			...(options.textSizing ? { textSizing: options.textSizing } : {}),
			...(options.clock ? { clock: options.clock } : {}),
			...(options.screen ? { screen: options.screen } : {}),
			beforeTerminalRenderer: ensureTerminalStylesLoaded,
		});
		this.#host = host;
		this.#unwatchMouse = createRoot(dispose => {
			effect(() => {
				const inline = this.#inlineMouse();
				// The fullscreen transcript scrolls with the wheel: the terminal must report it.
				const wheel = inline === "off" && !host.native && options.screen?.() === "fullscreen";
				host.setMouse(this.overlays.mouse() ?? (wheel ? "click" : inline));
			});
			return dispose;
		});
		this.#theme = options.theme;
		this.#native.set(host.native);
		this.#hour12.set(host.hour12);
		// An unconfirmed optimistic Tern start falls back to rows; its reply may carry the clock.
		this.#unwatchHost = host.onChange(() => {
			this.#native.set(host.native);
			this.#hour12.set(host.hour12);
		});
		this.#size.set({ columns: host.driver.columns, rows: host.driver.rows });
		this.#unwatchResize = host.driver.onResize((columns, rows) => this.#size.set({ columns, rows }));
		this.transcript.attach(host);
	}

	/**
	 * Rows the terminal dock draws below `slot` at the current width (the composer and the chrome
	 * under it); undefined natively or before start.
	 */
	rowsBelow(slot: DockSlot): number | undefined {
		const theme = this.#theme;
		if (!theme || this.#native.peek()) return undefined;
		ensureTerminalStylesLoaded();
		const env = staticEnvironment(untrack(theme));
		const { columns } = this.#size.peek();
		let rows = 0;
		const measure = (view: unknown): void => {
			if (typeof view === "function") measure(untrack(view as () => unknown));
			else if (Array.isArray(view)) for (const item of view) measure(item);
			else if (typeof view === "object" && view !== null && "kind" in view)
				rows += renderBlock(view as UiNode, columns, { env }).rows.length;
		};
		for (const name of TERMINAL_DOCK.slice(TERMINAL_DOCK.indexOf(slot) + 1)) measure(this.dock.slot(name).view);
		return rows;
	}

	/** Stop rendering and restore the terminal; the surface stays mounted. */
	async stop(): Promise<void> {
		const host = this.#host;
		this.#host = undefined;
		this.#unwatchResize?.();
		this.#unwatchResize = undefined;
		this.#unwatchHost?.();
		this.#unwatchHost = undefined;
		this.#unwatchMouse?.();
		this.#unwatchMouse = undefined;
		this.transcript.attach(undefined);
		await host?.stop();
	}

	/** See every input event before the focused node (see {@link InputInterceptor}). Newest first; returns its removal. */
	interceptInput(handler: InputInterceptor): () => void {
		return register(this.#interceptors, handler);
	}

	/**
	 * Route `event` as if the terminal sent it: every interceptor, then the focus path (no-op
	 * before start). `after` starts at the interceptors older than that one (all of them once it
	 * is gone): an interceptor replaying events it held does not see them again.
	 */
	input(event: InputEvent, options?: { readonly after?: InputInterceptor }): void {
		const at = options?.after ? this.#interceptors.indexOf(options.after) : -1;
		const from = at === -1 ? this.#interceptors.length - 1 : at - 1;
		if (!this.#intercept(event, from)) this.#host?.dispatch(event);
	}

	/**
	 * Offer `event` to the interceptors from index `from` down (newest first); true when one
	 * consumed it. A replacement continues through the older interceptors, then the focus path.
	 */
	#intercept(event: InputEvent, from: number): boolean {
		const list = [...this.#interceptors];
		for (let i = Math.min(from, list.length - 1); i >= 0; i--) {
			const result = list[i]!(event);
			if (result === true) return true;
			if (result === false) continue;
			for (const next of result) if (!this.#intercept(next, i - 1)) this.#host?.dispatch(next);
			return true;
		}
		return false;
	}

	/** Handle keys nothing on the focus path consumed; newest first. Returns its removal. */
	addGlobalKeyHandler(handler: (key: KeyEvent) => boolean): () => void {
		return register(this.#globalKeys, handler);
	}

	/** Deliver `text` to the focused node as a bracketed paste; false while not started. */
	paste(text: string): boolean {
		const host = this.#host;
		if (!host) return false;
		host.dispatch({ type: "paste", paste: { text } });
		return true;
	}

	/** The node holding keyboard focus (reactive). */
	readonly focused: Accessor<UiNode | null> = () => this.surface.focused();

	/** Move keyboard focus; `null` returns it to the home node. */
	focus(node: UiNode | null): void {
		this.surface.focus(node ?? this.#home);
	}

	/** Where focus rests when nothing else holds it (the composer's editor). */
	setHome(node: UiNode | null): void {
		const wasHome = this.surface.focused() === this.#home;
		this.#home = node;
		if (wasHome || this.surface.focused() === null) this.surface.focus(node);
	}
}

function register<T>(list: T[], item: T): () => void {
	list.push(item);
	return () => {
		const at = list.indexOf(item);
		if (at !== -1) list.splice(at, 1);
	};
}
