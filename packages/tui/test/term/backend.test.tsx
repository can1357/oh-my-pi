/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, it, vi } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import type { FramePlan, InputEvent, TerminalCapabilities, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import { anchoredRows, RESERVED_ROW } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { createSurface, settle } from "@oh-my-pi/pi-tui/surface";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";

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

/** Records frames; acknowledges every history batch; history is the concatenation of acknowledged batches. */
class FakeDriver implements TerminalDriver {
	columns = 20;
	rows = 6;
	capabilities = CAPABILITIES;
	readonly frames: FramePlan[] = [];
	history: string[] = [];
	#replay = new Set<() => void>();

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	present(frame: FramePlan): number | undefined {
		this.frames.push(frame);
		if (!frame.history) return undefined;
		if (frame.history.kind === "replay") this.history = [];
		this.history.push(...frame.history.rows.map(row => stripEscapes(row).trimEnd()));
		return frame.history.id;
	}
	writeRaw(): void {}
	/** The backend's input listener, for tests that send input. */
	input: ((event: InputEvent) => void) | undefined;
	onInput(listener: (event: InputEvent) => void): () => void {
		this.input = listener;
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
	replay(): void {
		for (const listener of this.#replay) listener();
	}
	resetDisplay(): void {}
	setTitle(): void {}
	get viewport(): string[] {
		return this.frames.at(-1)!.viewport.map(row => stripEscapes(row).trimEnd());
	}
}

function setup(main: () => unknown) {
	const driver = new FakeDriver();
	const surface = createSurface(() => ({ main: main() as never }));
	const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, separator: () => 0 });
	backend.start();
	return { driver, surface, backend };
}

const lines = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe("TermBackend animation", () => {
	it("keeps ticking past identical output and presents cursor-only changes", () => {
		vi.useFakeTimers();
		const start = Date.now();
		const active = signal(false);
		defineRolePainter("rows", "test.clock-caret", (_node, cx) => {
			const elapsed = active() ? cx.now() - start : 0;
			return { rows: ["spin"], cursor: { row: 0, col: Math.floor(elapsed / 160) % 4 } };
		});
		const driver = new FakeDriver();
		const surface = createSurface(() => ({ dock: <rows role="test.clock-caret" lines={[]} /> }));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, tickInterval: 80 });
		try {
			backend.start();
			active.set(true); // Starts reading the clock, but the caret is still at 0.
			vi.advanceTimersByTime(80);
			expect(driver.frames.length).toBe(1);
			vi.advanceTimersByTime(80);
			expect(driver.frames.length).toBe(2);
			expect(driver.frames.at(-1)?.cursor).toEqual({ row: 0, col: 1 });
		} finally {
			backend.stop();
			surface.dispose();
			vi.useRealTimers();
		}
	});

	it("carries the current animation in a content frame instead of drawing the old tick immediately after it", () => {
		vi.useFakeTimers();
		const start = Date.now();
		defineRolePainter("rows", "test.running-clock", (_node, cx) => ({ rows: [String(cx.now() - start)] }));
		const driver = new FakeDriver();
		const surface = createSurface(() => ({ dock: <rows role="test.running-clock" lines={[]} /> }));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, tickInterval: 80 });
		try {
			backend.start();
			vi.advanceTimersByTime(79);
			backend.renderNow();
			expect(driver.viewport).toEqual(["79"]);
			vi.advanceTimersByTime(1);
			expect(driver.frames.length).toBe(2);
			vi.advanceTimersByTime(79);
			expect(driver.viewport).toEqual(["159"]);
		} finally {
			backend.stop();
			surface.dispose();
			vi.useRealTimers();
		}
	});
});

describe("TermBackend main surface", () => {
	it("moves settled rows into history exactly once, only the rows the live tail cannot fit", () => {
		const a = signal(lines("a", 4));
		const b = signal(lines("b", 4));
		const { driver, surface, backend } = setup(() => [<rows key="a" lines={a} />, <rows key="b" lines={b} />]);
		backend.renderNow();
		// 8 rows in a 6-row viewport, nothing settled: the tail shows, nothing retires.
		expect(driver.history).toEqual([]);
		expect(driver.viewport).toEqual(["a2", "a3", "b0", "b1", "b2", "b3"]);

		// Settled: the two rows that scroll away go into history, the rest of `a` stays live.
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(driver.history).toEqual(["a0", "a1"]);
		expect(driver.viewport).toEqual(["a2", "a3", "b0", "b1", "b2", "b3"]);
		backend.renderNow();
		expect(driver.history).toEqual(["a0", "a1"]);

		// Its live rows still repaint (a tool card collapsing below the rows already in history).
		a.set(["a0", "a1", "A2"]);
		backend.renderNow();
		expect(driver.history).toEqual(["a0", "a1"]);
		expect(driver.viewport).toEqual(["A2", "b0", "b1", "b2", "b3"]);

		// Once nothing of it fits, the rest retires, exactly once.
		b.set(lines("b", 6));
		backend.renderNow();
		expect(driver.history).toEqual(["a0", "a1", "A2"]);
		expect(driver.viewport).toEqual(lines("b", 6));
		backend.stop();
	});

	it("moves a streaming answer's stable rows into history before it settles", () => {
		const text = signal("one\n\ntwo\n\nthree\n\nfour");
		const { driver, surface, backend } = setup(() => <md key="answer" text={text} stream />);
		driver.rows = 4;
		backend.renderNow();
		// "one", "", "two", "", "three", "", "four": stable through "three"'s paragraph break.
		expect(driver.history).toEqual(["one", "", "two"]);
		expect(driver.viewport).toEqual(["", "three", "", "four"]);

		text.set("one\n\ntwo\n\nthree\n\nfour\n\nfive");
		backend.renderNow();
		expect(driver.history).toEqual(["one", "", "two", "", "three"]);
		expect(driver.viewport).toEqual(["", "four", "", "five"]);

		// Settled, it still gives up only the rows that do not fit, after those already in history.
		text.set("one\n\ntwo\n\nthree\n\nfour\n\nfive\n\nsix");
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(driver.history).toEqual(["one", "", "two", "", "three", "", "four"]);
		expect(driver.viewport).toEqual(["", "five", "", "six"]);
		backend.stop();
	});

	it("keeps the dock at the bottom once the viewport filled the screen", () => {
		const driver = new FakeDriver();
		const tool = signal(lines("t", 5));
		const sheet = signal(false);
		const surface = createSurface(() => ({
			main: [<rows key="a" lines={lines("a", 2)} />, <rows key="tool" lines={tool} />],
			dock: <rows key="dock" lines={["dock"]} />,
			layer: () =>
				sheet() ? (
					<overlay key="sheet" size="full">
						<rows key="body" lines={["sheet"]} />
					</overlay>
				) : null,
		}));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, separator: () => 0 });
		backend.start();
		// 7 live rows in 5: both blocks still run, each keeps a row and the newer the rest.
		expect(driver.viewport).toEqual(["a1", "t1", "t2", "t3", "t4", "dock"]);

		// The tool's output collapses: blank rows hold the dock where it was.
		tool.set(["t0"]);
		backend.renderNow();
		expect(driver.viewport).toEqual(["a0", "a1", "t0", "", "", "dock"]);
		// The padding is no live content: a settled block does not retire for it.
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(driver.history).toEqual([]);
		// A fullscreen layer leaves the normal screen as it was: closing it keeps the dock in place.
		sheet.set(true);
		backend.renderNow();
		expect(driver.frames.at(-1)!.fullscreen).toBeDefined();
		sheet.set(false);
		backend.renderNow();
		expect(driver.viewport).toEqual(["a0", "a1", "t0", "", "", "dock"]);

		// A display replay lets the viewport shrink again; so does a resize.
		driver.replay();
		backend.renderNow();
		expect(driver.viewport).toEqual(["a0", "a1", "t0", "dock"]);
		tool.set(lines("t", 5));
		backend.renderNow();
		tool.set(["t0"]);
		backend.renderNow();
		expect(driver.viewport.length).toBe(6);
		driver.rows = 8;
		backend.renderNow();
		expect(driver.viewport).toEqual(["t0", "dock"]);
		backend.stop();
	});

	it("hides live rows under a covering dock popup instead of retiring them", () => {
		// A composer whose completion popup (its last rows) draws over the transcript.
		defineRolePainter("rows", "test.covering", node => {
			const props = node.props() as { lines: readonly string[]; term: { covering: number } };
			return { rows: props.lines, covering: props.term.covering };
		});
		const driver = new FakeDriver();
		const popup = signal(false);
		const surface = createSurface(() => ({
			main: [<rows key="a" lines={lines("a", 3)} />, <rows key="b" lines={lines("b", 2)} />],
			dock: () => (
				<rows
					key="composer"
					role="test.covering"
					lines={popup() ? ["> /x", "p0", "p1"] : ["> /x"]}
					term={{ covering: popup() ? 2 : 0 }}
				/>
			),
		}));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, separator: () => 0 });
		backend.start();
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(driver.viewport).toEqual([...lines("a", 3), "b0", "b1", "> /x"]);

		// The popup draws over the transcript: nothing retires, the rows under it come back when it closes.
		popup.set(true);
		backend.renderNow();
		expect(driver.history).toEqual([]);
		expect(driver.viewport).toEqual(["a2", "b0", "b1", "> /x", "p0", "p1"]);
		popup.set(false);
		backend.renderNow();
		expect(driver.history).toEqual([]);
		expect(driver.viewport).toEqual([...lines("a", 3), "b0", "b1", "> /x"]);
		backend.stop();
	});

	it("leaves out a live image whose first row the viewport cuts off, until that row fits again", () => {
		defineRolePainter("rows", "test.anchored-image", node => {
			const props = node.props() as { lines: readonly string[] };
			return { rows: props.lines };
		});
		const image = anchoredRows("\x1b]1337;File=inline=1;width=2;height=3:AA==\x07", 3);
		const dock = signal(lines("d", 3));
		const driver = new FakeDriver();
		const surface = createSurface(() => ({
			main: <rows key="reply" role="test.anchored-image" lines={["a0", ...image, "a1"]} />,
			dock: <rows key="dock" lines={dock} />,
		}));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, separator: () => 0 });
		backend.start();
		const main = () => driver.frames.at(-1)!.viewport.slice(0, -dock().length);
		// Three rows for five: the tail shows, and its last image row would move up into the dock.
		expect(main()).toEqual([RESERVED_ROW, RESERVED_ROW, "a1"]);
		dock.set(lines("d", 2));
		backend.renderNow();
		expect(main()).toEqual([...image, "a1"]);
		backend.stop();
	});

	it("leaves out a live image whose head went to history and scrolled off the screen", () => {
		defineRolePainter("rows", "test.streamed-image", node => {
			const props = node.props() as { lines: readonly string[] };
			// A streaming head: its first three rows are final.
			return { rows: props.lines, stable: 3 };
		});
		const image = anchoredRows("\x1b]1337;File=inline=1;width=2;height=3:AA==\x07", 3);
		const driver = new FakeDriver();
		const surface = createSurface(() => ({
			main: <rows key="reply" role="test.streamed-image" lines={["h0", "h1", ...image, "t0", "t1", "t2"]} />,
			dock: <rows key="dock" lines={["dock"]} />,
		}));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, separator: () => 0 });
		backend.start();
		// The stable head (its image's first row included) went to history over a full screen: that row is off
		// the screen, so the image's last row would draw it from the top row, over the tail.
		expect(driver.history).toEqual(["h0", "h1", ""]);
		expect(driver.frames.at(-1)!.viewport).toEqual([RESERVED_ROW, RESERVED_ROW, "t0", "t1", "t2", "dock"]);
		backend.stop();
	});

	it("keeps leaving out that image once the tail shrinks under a viewport with no dock to hold it down", () => {
		defineRolePainter("rows", "test.streamed-image-4", node => {
			const props = node.props() as { lines: readonly string[] };
			return { rows: props.lines, stable: 4 };
		});
		const image = anchoredRows("\x1b]1337;File=inline=1;width=2;height=3:AA==\x07", 3);
		const tail = signal(lines("t", 4));
		const { driver, backend } = setup(() => (
			<rows key="reply" role="test.streamed-image-4" lines={() => ["h0", "h1", "h2", ...image, ...tail()]} />
		));
		expect(driver.history).toEqual(["h0", "h1", "h2", ""]);
		expect(driver.frames.at(-1)!.viewport.slice(0, 2)).toEqual([RESERVED_ROW, RESERVED_ROW]);
		// The viewport shrinks in place: its top stays, so the image's first row is still off the screen.
		tail.set(["t0"]);
		backend.renderNow();
		expect(driver.frames.at(-1)!.viewport).toEqual([RESERVED_ROW, RESERVED_ROW, "t0"]);
		backend.stop();
	});

	/**
	 * A transcript (`a` settled, `b` live) over a dock of an optional cover (a docked report, a
	 * waiting ask: every row of it draws over the transcript) and a one-row composer.
	 */
	function covered(options: { rows?: number; main?: () => unknown } = {}) {
		defineRolePainter("rows", "test.cover", node => {
			const rows = (node.props() as { lines: readonly string[] }).lines;
			return { rows, covering: rows.length };
		});
		const driver = new FakeDriver();
		if (options.rows) driver.rows = options.rows;
		const cover = signal<string[] | undefined>(undefined);
		const surface = createSurface(() => ({
			main: (options.main?.() ?? [
				<rows key="a" lines={lines("a", 3)} />,
				<rows key="b" lines={lines("b", 2)} />,
			]) as never,
			dock: () => [
				cover() ? <rows key="cover" role="test.cover" lines={cover()!} /> : null,
				<rows key="composer" lines={[">"]} />,
			],
		}));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, separator: () => 0 });
		backend.start();
		settle(surface.main()[0]!);
		backend.renderNow();
		const show = (rows: string[] | undefined): void => {
			cover.set(rows);
			backend.renderNow();
		};
		/** What the terminal shows: the frame's last rows (a taller frame scrolls its top away). */
		const screen = (): string[] => driver.viewport.slice(-driver.rows);
		return { driver, surface, backend, show, screen };
	}

	it("keeps the transcript drawn above a covering dock block, clipped off the top", () => {
		const { driver, backend, show, screen } = covered();
		expect(screen()).toEqual([...lines("a", 3), "b0", "b1", ">"]);

		// The cover takes no room from the transcript: its rows stay live, the top ones clipped.
		show(lines("c", 2));
		expect(driver.history).toEqual([]);
		expect(screen()).toEqual(["a2", "b0", "b1", "c0", "c1", ">"]);
		// A cover that grows clips more; nothing retires.
		show(lines("c", 4));
		expect(driver.history).toEqual([]);
		expect(screen()).toEqual(["b1", ...lines("c", 4), ">"]);
		backend.stop();
	});

	it("leaves room above a cover shorter than the screen to the transcript", () => {
		const { driver, backend, show, screen } = covered({ rows: 10 });
		show(lines("c", 2));
		expect(driver.history).toEqual([]);
		expect(screen()).toEqual([...lines("a", 3), "b0", "b1", "c0", "c1", ">"]);
		backend.stop();
	});

	it("shows the bottom of a cover taller than the screen, and brings every row back when it closes", () => {
		const { driver, backend, show, screen } = covered();
		show(lines("c", 8));
		expect(driver.history).toEqual([]);
		expect(screen()).toEqual([...lines("c", 8).slice(3), ">"]);

		show(undefined);
		expect(driver.history).toEqual([]);
		expect(screen()).toEqual([...lines("a", 3), "b0", "b1", ">"]);
		backend.stop();
	});

	it("retires under a cover only what the screen without it cannot fit", () => {
		const b = signal(lines("b", 2));
		const { driver, backend, show, screen } = covered({
			main: () => [<rows key="a" lines={lines("a", 3)} />, <rows key="b" lines={b} />],
		});
		show(lines("c", 2));
		// The transcript outgrows the rows the composer leaves it: the settled head retires as it would uncovered.
		b.set(lines("b", 4));
		backend.renderNow();
		expect(driver.history).toEqual(["a0", "a1"]);
		expect(screen()).toEqual(["b1", "b2", "b3", "c0", "c1", ">"]);

		show(undefined);
		expect(driver.history).toEqual(["a0", "a1"]);
		expect(screen()).toEqual(["a2", ...lines("b", 4), ">"]);
		backend.stop();
	});

	it("follows a resize while covered", () => {
		const { driver, backend, show, screen } = covered();
		show(lines("c", 2));
		// Shorter: the rows the screen no longer fits beside the composer retire, the cover still clips the rest.
		driver.rows = 4;
		backend.renderNow();
		expect(driver.history).toEqual(["a0", "a1"]);
		expect(screen()).toEqual(["b1", "c0", "c1", ">"]);
		// Taller: the live rows show whole again above the cover.
		driver.rows = 8;
		backend.renderNow();
		expect(driver.history).toEqual(["a0", "a1"]);
		expect(screen()).toEqual(["a2", "b0", "b1", "c0", "c1", ">"]);

		show(undefined);
		expect(screen()).toEqual(["a2", "b0", "b1", ">"]);
		backend.stop();
	});

	it("counts a block retiring in the same batch as retired when separating the next one", () => {
		const driver = new FakeDriver();
		driver.rows = 3;
		const surface = createSurface(() => ({
			main: [<rows key="w" lines={["w"]} />, <rows key="a" lines={["a"]} />, <rows key="b" lines={lines("b", 3)} />],
		}));
		const [w] = surface.main();
		// A gap under `w` only once it is in history (the coding agent's welcome block).
		const backend: TermBackend = new TermBackend({
			surface,
			driver,
			theme: () => PLAIN_THEME,
			separator: above => (above === w && backend.retired(above) ? 1 : 0),
		});
		backend.start();
		for (const node of surface.main().slice(0, 2)) settle(node);
		backend.renderNow();
		expect(driver.history).toEqual(["w", "", "a"]);
		backend.stop();
	});

	it("separates blocks by the separator rule, also across the history boundary", () => {
		const driver = new FakeDriver();
		driver.rows = 4;
		const compact = new Set(["c1", "c2"]);
		const surface = createSurface(() => ({
			main: [
				<rows key="a" lines={["a"]} />,
				<rows key="c1" lines={["c1"]} />,
				<rows key="empty" lines={[]} />,
				<rows key="c2" lines={["c2"]} />,
				<rows key="b" lines={["b"]} />,
			],
		}));
		const name = (node: { key(): string | undefined }) => node.key() ?? "";
		const backend = new TermBackend({
			surface,
			driver,
			theme: () => PLAIN_THEME,
			separator: (above, below) => (compact.has(name(above)) && compact.has(name(below)) ? 0 : 1),
		});
		backend.start();
		// a · c1 c2 (packed across the empty block) · b = 6 rows; 4 fit. `a` and the separator under it
		// leave; that is room enough, so `c1` stays live.
		for (const node of surface.main().slice(0, 2)) settle(node);
		backend.renderNow();
		expect(driver.history).toEqual(["a", ""]);
		expect(driver.viewport).toEqual(["c1", "c2", "", "b"]);
		backend.stop();
	});

	it("schedules a frame when anything the last frame read changes", async () => {
		const label = signal("one");
		const { driver, backend } = setup(() => <text text={label} />);
		expect(driver.viewport).toEqual(["one"]);
		const frames = driver.frames.length;
		label.set("two");
		await Bun.sleep(40);
		expect(driver.frames.length).toBe(frames + 1);
		expect(driver.viewport).toEqual(["two"]);
		backend.stop();
	});

	it("keeps ticking an animation that starts between frames", async () => {
		// The welcome intro: a cached block repaints, reading the clock, the moment its start is set.
		let clockReads = 0;
		defineRolePainter("canvas", "test.intro", (node, cx) => {
			const running = (node.props() as { term?: { running?: boolean } }).term?.running === true;
			if (!running) return { rows: ["still"], width: 5 };
			clockReads++;
			return { rows: [`t${cx.now()}`], width: 20 };
		});
		const running = signal(false);
		const driver = new FakeDriver();
		const surface = createSurface(() => ({
			main: <canvas role="test.intro" paint={() => []} term={() => ({ running: running() })} />,
		}));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, tickInterval: 5 });
		backend.start();
		running.set(true);
		await Bun.sleep(100);
		backend.stop();
		expect(clockReads).toBeGreaterThan(3);
		expect(new Set(driver.frames.map(frame => frame.viewport.join("\n"))).size).toBeGreaterThan(3);
	});

	it("follows a hyperlinks override changed at runtime", () => {
		const driver = new FakeDriver();
		const override = signal<boolean | undefined>(true);
		const surface = createSurface(() => ({ main: <md text="see [docs](https://example.com)" /> }));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, hyperlinks: override });
		backend.start();
		const linked = () => driver.frames.at(-1)!.viewport.some(row => row.includes("\x1b]8;"));
		expect(linked()).toBe(true);
		override.set(undefined); // the terminal (FakeDriver) has no hyperlinks
		backend.renderNow();
		expect(linked()).toBe(false);
		backend.stop();
	});

	it("applies a frame-rate cap changed at runtime", async () => {
		const driver = new FakeDriver();
		const interval = signal(10_000);
		const label = signal("a");
		const surface = createSurface(() => ({ main: <text text={label} /> }));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, frameInterval: interval });
		backend.start();
		const frames = driver.frames.length;
		label.set("b");
		await Bun.sleep(20);
		expect(driver.frames.length).toBe(frames);
		backend.stop();
		interval.set(0);
		backend.start();
		label.set("c");
		await Bun.sleep(20);
		expect(driver.viewport).toEqual(["c"]);
		backend.stop();
	});

	it("tells painters which hit the pointer is over and repaints as it moves", () => {
		const driver = new FakeDriver();
		defineRolePainter("canvas", "test.hover", (node, cx) => {
			const props = node.props() as { paint: (width: number) => string[] };
			const hover = cx.hovered(node)?.item;
			return {
				rows: props.paint(cx.width).map((row, i) => (hover === `r${i}` ? `> ${row}` : row)),
				hits: [0, 1].map(i => ({ row: i, col: 0, width: cx.width, height: 1, node, item: `r${i}` })),
			};
		});
		const surface = createSurface(() => ({ main: <canvas role="test.hover" paint={() => ["a", "b"]} /> }));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, frameInterval: 0 });
		backend.start();
		const move = (row: number) =>
			driver.input!({ type: "mouse", mouse: { row, col: 0, button: "none", action: "move", mods: [] } });
		move(1);
		backend.renderNow();
		expect(driver.viewport).toEqual(["a", "> b"]);
		move(0);
		backend.renderNow();
		expect(driver.viewport).toEqual(["> a", "b"]);
		move(5);
		backend.renderNow();
		expect(driver.viewport).toEqual(["a", "b"]);
		backend.stop();
	});

	it("forgets the hovered hit when asked (pointer tracking turned off)", () => {
		const driver = new FakeDriver();
		defineRolePainter("canvas", "test.hover-clear", (node, cx) => {
			const hover = cx.hovered(node)?.item;
			return {
				rows: ["a", "b"].map((row, i) => (hover === `r${i}` ? `> ${row}` : row)),
				hits: [0, 1].map(i => ({ row: i, col: 0, width: cx.width, height: 1, node, item: `r${i}` })),
			};
		});
		const surface = createSurface(() => ({ main: <canvas role="test.hover-clear" paint={() => []} /> }));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME, frameInterval: 0 });
		backend.start();
		driver.input!({ type: "mouse", mouse: { row: 1, col: 0, button: "none", action: "move", mods: [] } });
		backend.renderNow();
		expect(driver.viewport).toEqual(["a", "> b"]);
		backend.clearHover();
		backend.renderNow();
		expect(driver.viewport).toEqual(["a", "b"]);
		backend.stop();
	});

	it("spans a sheet across the screen when its terminal look asks for full width", () => {
		const driver = new FakeDriver();
		const surface = createSurface(() => ({
			main: <rows lines={["base"]} />,
			layer: (
				<overlay anchor="bottom" term={{ width: "full" }}>
					<canvas paint={width => ["=".repeat(width)]} />
				</overlay>
			),
		}));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME });
		backend.start();
		// The sheet's frame spans every column (a `size` fraction would leave margins).
		expect(driver.viewport.at(-1)).toBe(`╰${"─".repeat(driver.columns - 2)}╯`);
		backend.stop();
	});

	it("anchors a sheet to the screen's bottom rows, under a transcript that leaves room", () => {
		const driver = new FakeDriver();
		const open = signal(true);
		const surface = createSurface(() => ({
			main: <rows lines={["base"]} />,
			dock: <rows lines={["dock"]} />,
			layer: () =>
				open() && (
					<overlay anchor="bottom" term={{ width: "full" }}>
						<canvas paint={() => ["sheet"]} />
					</overlay>
				),
		}));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME });
		backend.start();
		// Six screen rows: the transcript keeps its place at the top, the framed sheet takes the last three.
		expect(driver.viewport.map(row => row.trimEnd())).toEqual([
			"base",
			"dock",
			"",
			`╭${"─".repeat(18)}╮`,
			`│ sheet${" ".repeat(12)}│`,
			`╰${"─".repeat(18)}╯`,
		]);

		open.set(false);
		backend.renderNow();
		expect(driver.viewport).toEqual(["base", "dock"]);
		backend.stop();
	});

	it("places a screen by its terminal-only anchor", () => {
		const driver = new FakeDriver();
		const surface = createSurface(() => ({
			main: <rows lines={["base"]} />,
			layer: <rows term={{ anchor: "bottom" }} cols={20} lines={["box"]} />,
		}));
		const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME });
		backend.start();
		expect(driver.viewport.map(row => row.trimEnd())).toEqual(["base", "", "", "", "", "box"]);
		backend.stop();
	});

	it("replays the committed ledger after the driver lost history", () => {
		const { driver, surface, backend } = setup(() => [
			<rows key="a" lines={lines("a", 5)} />,
			<rows key="b" lines={lines("b", 6)} />,
		]);
		// `b` takes the whole screen: every row of settled `a` leaves, so `a` is committed.
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(driver.history).toEqual(lines("a", 5));

		driver.replay();
		backend.renderNow();
		const frame = driver.frames.at(-1)!;
		expect(frame.history?.kind).toBe("replay");
		expect(driver.history).toEqual(lines("a", 5));
		expect(driver.viewport).toEqual(lines("b", 6));

		backend.renderNow();
		expect(driver.frames.at(-1)!.history).toBeUndefined();
		backend.stop();
	});
});
