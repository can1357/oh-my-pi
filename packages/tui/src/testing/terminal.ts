/**
 * A scripted terminal for tests: runs a {@link Surface} on the real
 * {@link TermBackend} over an in-memory driver, so key, paste and mouse
 * dispatch, focus, layers, history retirement and painting are exactly what
 * users get.
 *
 * @example
 * ```ignore
 * const term = createTestTerminal(() => ({ dock: <Composer model={composer} /> }), { columns: 80, rows: 24 });
 * term.type("hello");
 * term.press("ctrl+a");
 * expect(term.screen()).toEqual([...]);
 * term.dispose();
 * ```
 */
import type { FramePlan, InputEvent, MouseEvent, TerminalCapabilities, TerminalDriver } from "../driver/contract";
import type { KeyEvent } from "../events";
import type { UiNode } from "../node";
import { batch, signal, type Signal } from "../reactive";
import { createSurface, type Surface, type SurfaceTemplate } from "../surface";
import { TermBackend, type TermBackendOptions } from "../term/backend";
import { stripEscapes } from "../text/ansi";
import type { Theme } from "../theme/contract";
import { PLAIN_THEME } from "../theme/plain";

/** Configuration of {@link createTestTerminal}. */
export interface TestTerminalOptions {
	readonly columns?: number;
	readonly rows?: number;
	readonly theme?: Theme;
	/** Terminal clock (ms) painters read; {@link TestTerminal.tick} advances it. */
	readonly now?: number;
	readonly capabilities?: Partial<TerminalCapabilities>;
	readonly separator?: TermBackendOptions["separator"];
	readonly onKey?: TermBackendOptions["onKey"];
	readonly intercept?: TermBackendOptions["intercept"];
	readonly textSizing?: TermBackendOptions["textSizing"];
	/** Drive this surface (an app shell's) instead of one built from the template. */
	readonly surface?: Surface;
}

/** See the module docs. */
export interface TestTerminal {
	readonly surface: Surface;
	readonly backend: TermBackend;
	/** The last frame's viewport rows, with escapes. */
	rows(): readonly string[];
	/** The last frame's viewport as plain text, trailing blanks trimmed. */
	screen(): string[];
	/** Rows written to history so far, with escapes (a replay replaces them). */
	history(): readonly string[];
	/** The last frame's hardware cursor, or null when hidden. */
	cursor(): { readonly row: number; readonly col: number } | null;
	/** The last frame's fullscreen (alternate screen) rows, when a fullscreen layer is up. */
	fullscreen(): readonly string[] | undefined;
	/** Press a key by id (`enter`, `ctrl+c`, `shift+tab`, `a`); printable ids carry their text. */
	press(id: string, options?: { text?: string; kind?: KeyEvent["kind"] }): void;
	/** Type text one key per grapheme. */
	type(text: string): void;
	paste(text: string): void;
	/** Mouse event at a viewport (or fullscreen) cell. */
	mouse(event: MouseEvent): void;
	/** Advance the terminal clock and paint. */
	tick(ms: number): void;
	resize(columns: number, rows: number): void;
	/** Paint now (input already paints). */
	render(): void;
	/** Focus a node directly. */
	focus(node: UiNode | null): void;
	dispose(): void;
}

const BASE_CAPABILITIES: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: true,
	hyperlinks: false,
	images: null,
	kittyKeyboard: true,
	bracketedPaste: true,
	background: null,
	dark: true,
	cell: null,
	multiplexer: null,
	textSizing: false,
	tsp: false,
	pixelMouse: false,
};

/** Printable text of a bare key id (`a`, `space`, `shift+a`), if it produces any. */
function keyText(id: string): string | undefined {
	const parts = id.split("+");
	const key = parts.at(-1)!;
	const mods = parts.slice(0, -1);
	if (mods.some(mod => mod !== "shift")) return undefined;
	if (key === "space") return " ";
	if ([...key].length !== 1) return undefined;
	return mods.includes("shift") ? key.toUpperCase() : key;
}

class MemoryDriver implements TerminalDriver {
	columns: number;
	rows: number;
	capabilities: TerminalCapabilities;
	last: FramePlan = { viewport: [], cursor: null };
	written: string[] = [];
	readonly #input = new Set<(event: InputEvent) => void>();
	readonly #resize = new Set<(columns: number, rows: number) => void>();
	readonly #replay = new Set<() => void>();

	constructor(columns: number, rows: number, capabilities: TerminalCapabilities) {
		this.columns = columns;
		this.rows = rows;
		this.capabilities = capabilities;
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	present(frame: FramePlan): number | undefined {
		this.last = frame;
		if (!frame.history) return undefined;
		if (frame.history.kind === "replay") this.written = [];
		this.written.push(...frame.history.rows);
		return frame.history.id;
	}
	writeRaw(): void {}
	onInput(listener: (event: InputEvent) => void): () => void {
		this.#input.add(listener);
		return () => this.#input.delete(listener);
	}
	onResize(listener: (columns: number, rows: number) => void): () => void {
		this.#resize.add(listener);
		return () => this.#resize.delete(listener);
	}
	onCapabilities(): () => void {
		return () => {};
	}
	onReplay(listener: () => void): () => void {
		this.#replay.add(listener);
		return () => this.#replay.delete(listener);
	}
	resetDisplay(): void {
		for (const listener of this.#replay) listener();
	}
	setTitle(): void {}

	emit(event: InputEvent): void {
		for (const listener of this.#input) listener(event);
	}
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		for (const listener of this.#resize) listener(columns, rows);
	}
}

/** Run `template` on the terminal backend over an in-memory terminal; the first frame is painted. */
export function createTestTerminal(template: () => SurfaceTemplate, options: TestTerminalOptions = {}): TestTerminal {
	const driver = new MemoryDriver(options.columns ?? 80, options.rows ?? 24, {
		...BASE_CAPABILITIES,
		...options.capabilities,
	});
	const surface = options.surface ?? createSurface(template);
	const theme = options.theme ?? PLAIN_THEME;
	const clock: Signal<number> = signal(options.now ?? 0);
	const backend = new TermBackend({
		surface,
		driver,
		theme: () => theme,
		clock,
		frameInterval: 0,
		...(options.separator ? { separator: options.separator } : {}),
		...(options.onKey ? { onKey: options.onKey } : {}),
		...(options.intercept ? { intercept: options.intercept } : {}),
		...(options.textSizing ? { textSizing: options.textSizing } : {}),
	});
	backend.start();
	const input = (event: InputEvent): void => {
		driver.emit(event);
		backend.renderNow();
	};
	return {
		surface,
		backend,
		rows: () => driver.last.fullscreen ?? driver.last.viewport,
		screen: () => (driver.last.fullscreen ?? driver.last.viewport).map(row => stripEscapes(row).trimEnd()),
		history: () => driver.written,
		cursor: () => driver.last.cursor,
		fullscreen: () => driver.last.fullscreen,
		press(id, keyOptions) {
			const text = keyOptions?.text ?? keyText(id);
			input({
				type: "key",
				key: { id, kind: keyOptions?.kind ?? "press", raw: text ?? "", ...(text === undefined ? {} : { text }) },
			});
		},
		type(text) {
			for (const { segment } of new Intl.Segmenter().segment(text)) {
				const id =
					segment === " "
						? "space"
						: segment.length === 1 && /[A-Z]/.test(segment)
							? `shift+${segment.toLowerCase()}`
							: segment;
				input({ type: "key", key: { id, kind: "press", raw: segment, text: segment } });
			}
		},
		paste: text => input({ type: "paste", paste: { text } }),
		mouse: event => input({ type: "mouse", mouse: event }),
		tick(ms) {
			batch(() => clock.set(clock.peek() + ms));
			backend.renderNow();
		},
		resize(columns, rows) {
			driver.resize(columns, rows);
			backend.renderNow();
		},
		render: () => backend.renderNow(),
		focus(node) {
			surface.focus(node);
			backend.renderNow();
		},
		dispose() {
			backend.stop();
			surface.dispose();
		},
	};
}
