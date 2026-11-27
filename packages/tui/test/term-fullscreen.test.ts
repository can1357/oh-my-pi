/**
 * The terminal backend's fullscreen presentation: the transcript scrolls inside the program on
 * the alternate screen above the pinned dock, terminal history is never written, and the pointer
 * drives the wheel, the scrollbar, the marks lane and text selection.
 */
import { describe, expect, it } from "bun:test";
import type {
	FramePlan,
	InputEvent,
	MouseEvent,
	TerminalCapabilities,
	TerminalDriver,
} from "@oh-my-pi/pi-tui/driver/contract";
import { jsx } from "@oh-my-pi/pi-tui/element";
import { startHost } from "@oh-my-pi/pi-tui/host";
import type { UiNode } from "@oh-my-pi/pi-tui/node";
import { type Signal, signal } from "@oh-my-pi/pi-tui/reactive";
import { createSurface, settle } from "@oh-my-pi/pi-tui/surface";
import {
	type SelectionClipboardResult,
	TermBackend,
	type TermBackendOptions,
	type TermPresentation,
} from "@oh-my-pi/pi-tui/term/backend";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { Vt } from "./driver-output/vt";

const CAPABILITIES: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: true,
	hyperlinks: false,
	images: null,
	kittyKeyboard: false,
	bracketedPaste: true,
	background: null,
	dark: true,
	cell: null,
	multiplexer: null,
	textSizing: false,
	tsp: false,
	pixelMouse: false,
};

/** Records frames and acknowledges every history batch; a display reset asks for a replay, as the writer does. */
class FakeDriver implements TerminalDriver {
	columns: number;
	rows: number;
	capabilities = CAPABILITIES;
	readonly frames: FramePlan[] = [];
	resets = 0;
	input: ((event: InputEvent) => void) | undefined;
	readonly #replay = new Set<() => void>();
	readonly #resize = new Set<(columns: number, rows: number) => void>();
	readonly #presented: (() => void)[] = [];

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	present(frame: FramePlan): number | undefined {
		this.frames.push(frame);
		for (const resolve of this.#presented.splice(0)) resolve();
		return frame.history?.id;
	}
	/** Resolves once the backend presents its next frame (one it scheduled itself). */
	nextFrame(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#presented.push(resolve);
		return promise;
	}
	writeRaw(): void {}
	onInput(listener: (event: InputEvent) => void): () => void {
		this.input = listener;
		return () => {
			this.input = undefined;
		};
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
		this.resets++;
		for (const listener of this.#replay) listener();
	}
	setTitle(): void {}
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		for (const listener of this.#resize) listener(columns, rows);
	}
}

/** The real frame writer over kitty's VT core: what a terminal shows and keeps in its scrollback. */
class VtDriver implements TerminalDriver {
	readonly vt: Vt;
	capabilities = CAPABILITIES;
	readonly #replay = new Set<() => void>();

	constructor(columns: number, rows: number) {
		this.vt = new Vt({
			columns,
			rows,
			shell: ["$ omp"],
			canReplay: () => true,
			onInvalidate: request => {
				if (request === "replay") for (const listener of this.#replay) listener();
			},
		});
	}

	get columns(): number {
		return this.vt.columns;
	}
	get rows(): number {
		return this.vt.rows;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	present(frame: FramePlan): number | undefined {
		return this.vt.present(frame);
	}
	viewportRow(row: number): number | null {
		return this.vt.writer.viewportRow(row);
	}
	writeRaw(): void {}
	onInput(): () => void {
		return () => {};
	}
	onResize(): () => void {
		return () => {};
	}
	onCapabilities(): () => void {
		return () => {};
	}
	onReplay(listener: () => void): () => void {
		this.#replay.add(listener);
		return () => this.#replay.delete(listener);
	}
	resetDisplay(): void {
		this.vt.writer.resetDisplay();
	}
	setTitle(): void {}
}

const lines = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const block = (prefix: string, count: number): UiNode => jsx("rows", { lines: lines(prefix, count) }) as UiNode;

type PointerEvent = Partial<Omit<MouseEvent, "row" | "col">> & { readonly row: number; readonly col: number };

interface Setup {
	readonly columns?: number;
	readonly rows?: number;
	/** The main region (a reactive accessor for lists that change). */
	readonly main: () => readonly UiNode[];
	readonly options?: Partial<TermBackendOptions>;
}

/** A fullscreen backend over a fake driver: a one-row dock (`> prompt`), the plain theme. */
function setup(init: Setup) {
	const driver = new FakeDriver(init.columns ?? 20, init.rows ?? 8);
	const presentation: Signal<TermPresentation> = signal<TermPresentation>("fullscreen");
	const surface = createSurface(() => ({ main: init.main, dock: jsx("rows", { lines: ["> prompt"] }) }));
	const backend = new TermBackend({
		surface,
		driver,
		theme: () => PLAIN_THEME,
		presentation,
		frameInterval: 0,
		...init.options,
	});
	backend.start();
	const frame = (): FramePlan => driver.frames.at(-1)!;
	const plain = (row: number): string => stripEscapes(frame().fullscreen?.[row] ?? "");
	const width = (): number => driver.columns - 2;
	return {
		driver,
		backend,
		presentation,
		frame,
		render: (): void => backend.renderNow(),
		/** Transcript text of frame row `row` (the lanes cut off). */
		text: (row: number): string => plain(row).slice(0, width()).trimEnd(),
		/** The marks lane cell of frame row `row`. */
		lane: (row: number): string => plain(row)[width()]!,
		/** The scrollbar cell of frame row `row`. */
		bar: (row: number): string => plain(row)[width() + 1]!,
		/** A whole frame row as plain text. */
		line: (row: number): string => plain(row).trimEnd(),
		raw: (row: number): string => frame().fullscreen?.[row] ?? "",
		mouse(event: PointerEvent): void {
			driver.input?.({ type: "mouse", mouse: { button: "left", action: "press", mods: [], ...event } });
			backend.renderNow();
		},
		dispose(): void {
			backend.stop();
			surface.dispose();
		},
	};
}

describe("fullscreen presentation", () => {
	it("paints the transcript tail above the pinned dock and never prepares history", () => {
		const first = block("a", 6);
		const second = block("b", 6);
		const t = setup({ main: () => [first, second] });
		try {
			settle(first);
			settle(second);
			t.render();
			// 20x8: the dock takes the last row, the indicator the one above; a 6-row window of 13 rows.
			expect(Array.from({ length: 6 }, (_, row) => t.text(row))).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);
			expect(t.line(6)).toBe("");
			expect(t.line(7)).toBe("> prompt");
			expect(t.frame().viewport).toEqual([]);
			expect(t.driver.frames.every(frame => frame.history === undefined)).toBe(true);
			// Settled blocks that inline would retire stay out of history.
			expect(t.backend.retired(first)).toBe(false);
			const presented = t.driver.frames.length;
			t.backend.flush();
			expect(t.driver.frames.length).toBe(presented);
		} finally {
			t.dispose();
		}
	});

	it("owes a display reset asked for while fullscreen until the presentation turns inline", () => {
		const t = setup({ main: () => [block("a", 2)] });
		try {
			t.backend.resetDisplay();
			t.render();
			expect(t.driver.resets).toBe(0);
			t.presentation.set("inline");
			t.render();
			expect(t.driver.resets).toBe(1);
			// The reset runs before the first inline frame, which carries the replay.
			expect(t.frame().history?.kind).toBe("replay");
			t.render();
			expect(t.driver.resets).toBe(1);
		} finally {
			t.dispose();
		}
	});

	it("follows the tail, detaches on scroll, flags output below, and resumes following", () => {
		const blocks = signal<UiNode[]>([]);
		const t = setup({ main: () => blocks() });
		try {
			// An empty or fully visible transcript keeps following.
			expect(t.backend.scroller.scrollBy(-1)).toBe(false);
			blocks.set([block("a", 4)]);
			t.render();
			expect(t.backend.scroller.scrollBy(-1)).toBe(false);
			expect(t.backend.scroller.state().following).toBe(true);

			blocks.set([block("a", 10)]);
			t.render();
			expect(t.text(0)).toBe("a4");
			expect(t.backend.scroller.scrollBy(-2)).toBe(true);
			t.render();
			expect(t.text(0)).toBe("a2");
			expect(t.backend.scroller.state()).toMatchObject({ following: false, unseen: false, offset: 2 });
			expect(t.line(6)).toBe("");

			blocks.set([...blocks(), block("b", 2)]);
			t.render();
			// The reading position holds; the new rows below raise the notice.
			expect(t.text(0)).toBe("a2");
			expect(t.backend.scroller.state()).toMatchObject({ following: false, unseen: true });
			expect(t.line(6).trim()).toBe("New output below");

			expect(t.backend.scroller.toBottom()).toBe(true);
			t.render();
			expect(Array.from({ length: 6 }, (_, row) => t.text(row))).toEqual(["a7", "a8", "a9", "", "b0", "b1"]);
			expect(t.backend.scroller.state()).toMatchObject({ following: true, unseen: false });
			expect(t.line(6)).toBe("");
			expect(t.backend.scroller.toBottom()).toBe(false);

			// Following keeps the tail in view as output streams.
			blocks.set([...blocks(), block("c", 1)]);
			t.render();
			expect(t.text(5)).toBe("c0");
		} finally {
			t.dispose();
		}
	});

	it("flags a same-row append only below the visible part of a block", () => {
		const rows = (top: string, glyph: string, output: string) => [top, "1", "2", "3", "4", glyph, output, "7"];
		const content = signal(rows("read", "◐", "partial text"));
		const main = [jsx("rows", { lines: content }) as UiNode];
		const t = setup({ columns: 24, rows: 6, main: () => main });
		try {
			expect(t.backend.scroller.toTop()).toBe(true);
			t.render();
			expect(t.backend.scroller.state()).toMatchObject({ height: 4, totalRows: 8, unseen: false });

			// Visible output, a longer *replacement* glyph offscreen and shrinking text aren't unseen output.
			content.set(rows("read here", "↻\u0301", "partial"));
			t.render();
			expect(t.text(0)).toBe("read here");
			expect(t.backend.scroller.state().unseen).toBe(false);

			content.set(rows("read here", "↻\u0301", "partial!"));
			t.render();
			expect(t.backend.scroller.state()).toMatchObject({ offset: 0, totalRows: 8, unseen: true });
			expect(t.line(4).trim()).toBe("New output below");
		} finally {
			t.dispose();
		}
	});

	it("keeps the anchored text at the top through streaming above and below and a reflow of its framed block", () => {
		const head = signal(lines("head ", 4));
		const tail = signal(lines("tail ", 6));
		const words = [
			"alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike",
			"november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu",
		].join(" ");
		const card = jsx("card", { head: "Notes", children: jsx("text", { text: words }) }) as UiNode;
		const above = jsx("rows", { lines: () => head() }) as UiNode;
		const below = jsx("rows", { lines: () => tail() }) as UiNode;
		const t = setup({ columns: 30, rows: 8, main: () => [above, card, below] });
		try {
			t.backend.scroller.toTop();
			t.render();
			// The card starts below the 4 head rows and a separator: its fourth row is reading row 0.
			expect(t.backend.scroller.scrollBy(8)).toBe(true);
			t.render();
			const top = t.text(0);
			expect(top).toContain("hotel");

			tail.set(lines("tail ", 9));
			t.render();
			expect(t.text(0)).toBe(top);
			head.set(lines("head ", 6));
			t.render();
			expect(t.text(0)).toBe(top);

			// Narrower: the card rewraps; the row holding what the old top row started with comes to the top.
			t.driver.resize(22, 8);
			t.render();
			expect(t.text(0)).not.toBe(top);
			expect(t.text(0)).toContain("hotel");
			expect(t.backend.scroller.state().following).toBe(false);
		} finally {
			t.dispose();
		}
	});

	it("keeps the original source offset through repeated reflows and rebinds it on a scroll", () => {
		const source = Array.from({ length: 140 }, (_, i) => (i % 5 ? String.fromCharCode(0x2801 + i) : "!")).join("");
		const main = [jsx("text", { text: source }) as UiNode];
		const t = setup({ columns: 12, rows: 6, main: () => main });
		const width = (cells: number): void => {
			t.driver.resize(cells + 2, 6);
			t.render();
		};
		try {
			t.backend.scroller.toTop();
			t.backend.scroller.scrollBy(5);
			t.render();
			expect(t.text(0)).toBe(source.slice(50, 60));
			width(11);
			expect(t.text(0)).toBe(source.slice(44, 55)); // the row containing offset 50, not a new anchor at 44
			width(10);
			expect(t.text(0)).toBe(source.slice(50, 60));
			expect(t.backend.scroller.state().unseen).toBe(false);
			width(11);
			expect(t.backend.scroller.scrollBy(2)).toBe(true);
			t.render();
			expect(t.text(0)).toBe(source.slice(66, 77));
			width(10);
			expect(t.text(0)).toBe(source.slice(60, 70));
			width(11);
			expect(t.text(0)).toBe(source.slice(66, 77));
			width(source.length); // everything fits now, but the reader did not ask to follow the tail
			expect(t.text(0)).toBe(source);
			expect(t.backend.scroller.state()).toMatchObject({ offset: 0, following: false });
			width(11);
			expect(t.text(0)).toBe(source.slice(66, 77));
		} finally {
			t.dispose();
		}
	});

	it("keeps an anchored decoration row when the text above it rewraps", () => {
		const main = [
			jsx("col", {
				children: [
					jsx("text", { text: "x".repeat(36) }),
					jsx("rule", {}),
					jsx("rule", {}),
					jsx("text", { text: "after" }),
				],
			}) as UiNode,
			block("tail", 6),
		];
		const t = setup({ columns: 12, rows: 6, main: () => main });
		try {
			t.backend.scroller.toTop();
			t.backend.scroller.scrollBy(4);
			t.render();
			expect(t.text(0)).toBe(PLAIN_THEME.symbols.box.horizontal.repeat(10));
			t.driver.resize(14, 6);
			t.render();
			expect(t.backend.scroller.state().offset).toBe(3);
			expect(t.text(0)).toBe(PLAIN_THEME.symbols.box.horizontal.repeat(12));
			expect(t.text(2)).toBe("after");
		} finally {
			t.dispose();
		}
	});

	it("finds the anchored source run among the disjoint spans of a wrapped table row", () => {
		const left = "ab cd ef gh ij kl mn op";
		const right = `${"r".repeat(119)}Z`;
		const main = [
			jsx("md", { text: `| L | R |\n| --- | --- |\n| ${left} | ${right} |` }) as UiNode,
			block("tail", 8),
		];
		const t = setup({ columns: 151, rows: 6, main: () => main });
		try {
			t.backend.scroller.toTop();
			t.backend.scroller.scrollBy(4);
			t.render();
			expect(t.text(0)).toContain(" Z "); // only the right cell wraps
			t.driver.resize(31, 6);
			t.render();
			// Both cells now wrap. Some of the left cell comes *after* the row carrying the right cell's Z.
			expect(t.text(0)).toContain("Z ");
			expect(t.text(1)).toContain("mn");
		} finally {
			t.dispose();
		}
	});

	it("hands the reading position to a surviving neighbour when its block goes away, keeping unseen", () => {
		const a = block("a", 10);
		const b = block("b", 10);
		const c = block("c", 10);
		const blocks = signal<UiNode[]>([a, b, c]);
		const t = setup({ main: () => blocks() });
		try {
			t.backend.scroller.toTop();
			t.backend.scroller.scrollBy(13);
			t.render();
			expect(t.text(0)).toBe("b2");
			blocks.set([a, b, c, block("d", 2)]);
			t.render();
			expect(t.backend.scroller.state().unseen).toBe(true);

			blocks.set([a, c, blocks()[3]!]);
			t.render();
			expect(t.text(0)).toBe("c0");
			expect(t.backend.scroller.state()).toMatchObject({ following: false, unseen: true });
			expect(t.line(6).trim()).toBe("New output below");
		} finally {
			t.dispose();
		}
	});

	it("draws the scrollbar and marks from the geometry; track, mark, thumb and wheel move the window", () => {
		const names = ["u0", "r0", "u1", "r1", "u2", "r2"];
		const blocks = names.map(name => jsx("rows", { lines: ["a", "b", "c", "d"].map(k => `${name} ${k}`) }) as UiNode);
		const t = setup({
			rows: 12,
			main: () => blocks,
			options: {
				marks: () => [
					{ node: blocks[0]!, kind: "success" },
					{ node: blocks[2]!, kind: "warning" },
					{ node: blocks[4]!, kind: "running" },
				],
			},
		});
		const column = (cell: (row: number) => string): string[] => Array.from({ length: 10 }, (_, row) => cell(row));
		try {
			// 29 rows in a 10-row window: the thumb takes 27/8 cells at the track's end; marks at rows 0, 10, 20.
			expect(t.text(0)).toBe("");
			expect(t.text(1)).toBe("u2 a");
			expect(column(t.bar)).toEqual(["│", "│", "│", "│", "│", "│", "▃", "█", "█", "█"]);
			// Following: the last turn is the one being read.
			expect(column(t.lane)).toEqual(["╶", " ", " ", "╶", " ", " ", "╺", " ", " ", " "]);

			// A press on the track above the thumb pages up.
			t.mouse({ row: 0, col: 19 });
			expect(t.text(0)).toBe("u1 a");
			expect(column(t.bar)).toEqual(["│", "│", "│", "▅", "█", "█", "▂", "│", "│", "│"]);
			// The thumb's lower edge fills the cell's top: the complementary block in inverse video.
			expect(t.raw(6)).toContain("\x1b[7m▂\x1b[27m");
			expect(column(t.lane)).toEqual(["╶", " ", " ", "╺", " ", " ", "╶", " ", " ", " "]);

			// The first mark brings its turn to the top.
			t.mouse({ row: 0, col: 18 });
			expect(t.text(0)).toBe("u0 a");

			t.mouse({ row: 2, col: 3, button: "wheel-down" });
			expect(t.text(0)).toBe("u0 b");
			t.mouse({ row: 2, col: 3, button: "wheel-up" });
			expect(t.text(0)).toBe("u0 a");

			// Dragging the thumb follows the pointer inside the cell: 4.5 of 6.625 cells of travel.
			t.mouse({ row: 1, col: 19, rowFraction: 0.5 });
			t.mouse({ row: 6, col: 19, action: "drag", rowFraction: 0 });
			t.mouse({ row: 6, col: 19, action: "release" });
			expect(t.text(0)).toBe("u1 d");
			expect(t.backend.scroller.state().offset).toBe(13);
		} finally {
			t.dispose();
		}
	});

	it("copies a drag selection across blocks on release, or only on request without copy on release", async () => {
		const copies: string[] = [];
		const copyText = async (text: string): Promise<SelectionClipboardResult> => {
			copies.push(text);
			return "success";
		};
		const copyOnRelease = signal(true);
		const t = setup({
			main: () => [
				jsx("rows", { lines: ["alpha one", "alpha two"] }) as UiNode,
				jsx("rows", { lines: ["bravo one", "bravo two"] }) as UiNode,
			],
			options: { copyText, copyOnRelease, copyShortcutLabel: () => "Alt+C" },
		});
		const drag = (row: number, col: number): void => {
			t.mouse({ row, col });
			t.mouse({ row: 3, col: 4, action: "drag" });
			t.mouse({ row: 3, col: 4, action: "release" });
		};
		try {
			drag(0, 6);
			// Blocks parted by a separator row join with a blank line.
			expect(copies).toEqual(["one\nalpha two\n\nbravo"]);
			expect(t.raw(0)).toContain("\x1b[7mone\x1b[27m");
			// The copy's result schedules the frame that shows it.
			await t.driver.nextFrame();
			expect(t.line(6).trim()).toBe("Selection copied");
			expect(t.backend.scroller.state().highlight).toBe(true);

			copyOnRelease.set(false);
			drag(1, 0);
			expect(copies).toHaveLength(1);
			expect(t.line(6)).toBe("");
			expect(t.backend.scroller.copyHighlight()).toBe(true);
			expect(copies).toEqual(["one\nalpha two\n\nbravo", "alpha two\n\nbravo"]);

			expect(t.backend.scroller.dropHighlight()).toBe(true);
			expect(t.backend.scroller.copyHighlight()).toBe(false);
		} finally {
			t.dispose();
		}
	});

	it("names the copy key when copying fails", async () => {
		const t = setup({
			columns: 40,
			main: () => [jsx("rows", { lines: ["alpha one"] }) as UiNode],
			options: { copyText: async () => "failed", copyShortcutLabel: () => "Alt+C" },
		});
		try {
			t.mouse({ row: 0, col: 0 });
			t.mouse({ row: 0, col: 4, action: "drag" });
			t.mouse({ row: 0, col: 4, action: "release" });
			await t.driver.nextFrame();
			expect(t.line(6).trim()).toBe("Copy failed - retry with Alt+C");
		} finally {
			t.dispose();
		}
	});

	it("lets a click activate a transcript target before selecting when targets are active", () => {
		defineRolePainter("canvas", "test.fullscreen-act", (node, cx) => ({
			rows: ["open the card", "plain text"],
			hits: [{ row: 0, col: 0, width: cx.width, height: 1, node, act: "open" }],
		}));
		const acts: string[] = [];
		const copies: string[] = [];
		const activateTargets = signal(true);
		const target = jsx("canvas", {
			role: "test.fullscreen-act",
			paint: () => [],
			onAction: (act: string) => acts.push(act),
		}) as UiNode;
		const t = setup({
			main: () => [target],
			options: {
				activateTargets,
				copyText: async text => {
					copies.push(text);
					return "success";
				},
			},
		});
		const drag = (): void => {
			t.mouse({ row: 0, col: 0 });
			t.mouse({ row: 0, col: 3, action: "drag" });
			t.mouse({ row: 0, col: 3, action: "release" });
		};
		try {
			drag();
			expect(acts).toEqual(["open"]);
			expect(copies).toEqual([]);
			expect(t.backend.scroller.state().highlight).toBe(false);

			activateTargets.set(false);
			drag();
			expect(acts).toEqual(["open"]);
			expect(copies).toEqual(["open"]);
		} finally {
			t.dispose();
		}
	});

	it("does not dispatch a wheel-only transcript press to a target unless activation is enabled", () => {
		const activateTargets = signal(false);
		const acts: string[] = [];
		const target = jsx("button", { text: "Open record", onAction: (act: string) => acts.push(act) }) as UiNode;
		const t = setup({ main: () => [target], options: { pointer: () => "wheel", activateTargets } });
		try {
			t.mouse({ row: 0, col: 2 });
			expect(acts).toEqual([]);
			activateTargets.set(true);
			t.mouse({ row: 0, col: 2 });
			expect(acts).toEqual(["click"]);
			expect(t.backend.scroller.state().highlight).toBe(false);
		} finally {
			t.dispose();
		}
	});
});

describe("fullscreen presentation on a real terminal", () => {
	/** Settled blocks retire inline in a 20x6 terminal: `a` goes to scrollback, `b` stays on screen. */
	function session() {
		const driver = new VtDriver(20, 6);
		const a = block("a", 4);
		const b = block("b", 4);
		const blocks = signal<UiNode[]>([a, b]);
		const presentation = signal<TermPresentation>("inline");
		const surface = createSurface(() => ({ main: () => blocks(), dock: jsx("rows", { lines: ["> prompt"] }) }));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, presentation });
		settle(a);
		settle(b);
		backend.start();
		return { vt: driver.vt, a, blocks, presentation, backend, surface };
	}

	it("writes neither history nor a scrollback clear, and returns inline to the screen it left", () => {
		const { vt, a, blocks, presentation, backend, surface } = session();
		try {
			expect(backend.retired(a)).toBe(true);
			const inline = vt.transcript();
			const scrollback = vt.scrollback();

			presentation.set("fullscreen");
			backend.renderNow();
			const mark = vt.writes.length;
			expect(vt.term.isMainScreen).toBe(false);
			blocks.set([...blocks(), block("c", 2)]);
			backend.renderNow();
			expect(backend.scroller.toTop()).toBe(true);
			backend.renderNow();
			// The whole transcript reads in the program, history included.
			expect(vt.screen()[0]).toStartWith("a0");
			const flushed = vt.writes.length;
			backend.flush();
			expect(vt.writes.length).toBe(flushed);
			expect(vt.since(mark)).not.toContain("\x1b[3J");
			expect(vt.scrollback()).toEqual(scrollback);
			expect(backend.retired(a)).toBe(true);

			blocks.set(blocks().slice(0, 2));
			presentation.set("inline");
			backend.renderNow();
			expect(vt.term.isMainScreen).toBe(true);
			expect(vt.transcript()).toEqual(inline);
		} finally {
			backend.stop();
			surface.dispose();
		}
	});

	it("runs a display reset asked for while fullscreen once the presentation turns inline", () => {
		const { vt, blocks, presentation, backend, surface } = session();
		try {
			presentation.set("fullscreen");
			backend.renderNow();
			backend.resetDisplay();
			blocks.set([...blocks(), block("c", 2)]);
			backend.renderNow();
			const mark = vt.writes.length;
			backend.renderNow();
			expect(vt.since(mark)).not.toContain("\x1b[3J");

			presentation.set("inline");
			const back = vt.writes.length;
			backend.renderNow();
			expect(vt.since(back)).toContain("\x1b[3J");
			expect(vt.transcript().filter(row => row !== "")).toEqual([
				...lines("a", 4),
				...lines("b", 4),
				...lines("c", 2),
				"> prompt",
			]);
		} finally {
			backend.stop();
			surface.dispose();
		}
	});

	it("keeps scrollback through a fullscreen host: replays wait, the exit writes no transcript", async () => {
		const term = memoryTerminal({ columns: 20, rows: 6 });
		const surface = createSurface(() => ({
			main: jsx("rows", { lines: ["first block"] }),
			dock: jsx("rows", { lines: ["> prompt"] }),
		}));
		const host = await startHost({
			surface,
			theme: () => PLAIN_THEME,
			native: false,
			driver: term.options,
			presentation: () => "fullscreen",
		});
		try {
			// 20x6 with a one-row dock: a 4-row window above the indicator row.
			expect(host.scroller?.state()).toMatchObject({ following: true, height: 4 });
			host.replayHistory();
		} finally {
			await host.stop();
			surface.dispose();
		}
		const output = term.output.join("");
		expect(output).toContain("first block");
		expect(output).not.toContain("\x1b[3J");
		expect(output.slice(output.lastIndexOf("\x1b[?1049l"))).not.toContain("first block");
	});
});
