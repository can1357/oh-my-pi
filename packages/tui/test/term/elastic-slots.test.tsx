/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Conformance of the terminal backend to the Elastic Speculative Slots
 * protocol (https://stencil.so/blog/harness-playbook/elastic-slots.pdf).
 *
 * Tests tagged ES-nn encode a finding of the conformance review: the
 * counterexample it found, which the backend must keep handling.
 */
import { describe, expect, it } from "bun:test";
import { For, type Signal, signal } from "@oh-my-pi/pi-tui";
import type { FramePlan, TerminalCapabilities, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import { createSurface, isSettled, settle } from "@oh-my-pi/pi-tui/surface";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { type MarkdownOptions, renderMarkdownFrame } from "@oh-my-pi/pi-tui/text/markdown/index";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { duplicated, Vt, type VtOptions } from "../driver-output/vt";

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
};

type Listener = (columns: number, rows: number) => void;

/**
 * Records frames. History is the concatenation of acknowledged batches;
 * while `ack` is false batches are offered but not written (what a resize
 * borrow, an anchor probe or a fullscreen frame do in the frame writer).
 */
class FakeDriver implements TerminalDriver {
	columns = 20;
	rows = 6;
	capabilities = CAPABILITIES;
	ack = true;
	readonly frames: FramePlan[] = [];
	history: string[] = [];
	#replay = new Set<() => void>();
	#resize = new Set<Listener>();

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	present(frame: FramePlan): number | undefined {
		this.frames.push(frame);
		if (!frame.history || !this.ack) return undefined;
		if (frame.history.kind === "replay") this.history = [];
		this.history.push(...frame.history.rows.map(row => stripEscapes(row).trimEnd()));
		return frame.history.id;
	}
	writeRaw(): void {}
	onInput(): () => void {
		return () => {};
	}
	onResize(listener: Listener): () => void {
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
	/** The display lost its history (display reset, settled resize under a replaying policy). */
	replay(): void {
		for (const listener of this.#replay) listener();
	}
	/** A settled resize under a policy that does not replay (`preserve`, in-place). */
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		for (const listener of this.#resize) listener(columns, rows);
	}
	resetDisplay(): void {}
	/** False models `preserve` / in-place resize: a width change keeps history at its old width. */
	replays = true;
	replaysOnResize(): boolean {
		return this.replays;
	}
	setTitle(): void {}
	get viewport(): string[] {
		return this.frames.at(-1)!.viewport.map(row => stripEscapes(row).trimEnd());
	}
	/** Every row the user can reach: scrollback, then the screen. */
	get transcript(): string[] {
		return [...this.history, ...this.viewport];
	}
}

/** A backend driver over the real frame writer and a terminal emulator. */
class VtDriver implements TerminalDriver {
	readonly vt: Vt;
	capabilities = CAPABILITIES;
	#replay = new Set<() => void>();
	#resize = new Set<Listener>();

	constructor(options: VtOptions = {}) {
		this.vt = new Vt({
			canReplay: () => true,
			...options,
			onInvalidate: request => {
				if (request === "replay") for (const listener of this.#replay) listener();
				for (const listener of this.#resize) listener(this.columns, this.rows);
			},
		});
	}
	get columns(): number {
		return this.vt.term.columns;
	}
	get rows(): number {
		return this.vt.term.rows;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.vt.writer.stop();
	}
	present(frame: FramePlan): number | undefined {
		return this.vt.present(frame);
	}
	writeRaw(): void {}
	onInput(): () => void {
		return () => {};
	}
	onResize(listener: Listener): () => void {
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
	resize(columns: number, rows: number): void {
		this.vt.resize(columns, rows);
		for (const listener of this.#resize) listener(columns, rows);
	}
	replaysOnResize(): boolean {
		return this.vt.writer.replaysOnWidthChange();
	}
	resetDisplay(): void {
		this.vt.writer.resetDisplay();
	}
	setTitle(): void {}
}

interface SetupOptions {
	readonly separator?: number;
	readonly dock?: () => unknown;
}

function mount<D extends TerminalDriver>(driver: D, main: () => unknown, options: SetupOptions = {}) {
	const surface = createSurface(() => ({
		main: main() as never,
		...(options.dock ? { dock: options.dock() as never } : {}),
	}));
	const backend = new TermBackend({
		surface,
		driver,
		theme: () => PLAIN_THEME,
		separator: () => options.separator ?? 0,
	});
	backend.start();
	return { driver, surface, backend };
}

const setup = (main: () => unknown, options?: SetupOptions) => mount(new FakeDriver(), main, options);

const lines = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

/** A paragraph of 35 cells: two rows at 20 columns, one at 60. */
const paragraph = (n: number): string => `p${n} ${"word ".repeat(7)}`.trim();

/** What `Host.stop()` does (host.ts): flush the transcript, stop the backend, hand the terminal back. */
async function stopLikeHost(backend: TermBackend, driver: VtDriver): Promise<void> {
	backend.flush();
	backend.stop();
	await driver.stop();
}

describe("exactly-once in-order ledger (ECH, Lemma 4.6, Corollary 4.14)", () => {
	// Create extends the block order only at its end (§3.1); the backend takes the committed
	// *prefix* of `main` as the frontier, so a block inserted above committed blocks makes every
	// committed block after it live again, and the retire loop writes them a second time.
	it("ES-01 never writes a committed block twice when a block is inserted above the frontier", () => {
		const inserted = signal(false);
		const { driver, surface, backend } = setup(() => [
			() => (inserted() ? <rows key="x" lines={["x0"]} /> : null),
			<rows key="a" lines={lines("a", 4)} />,
			<rows key="b" lines={lines("b", 4)} />,
			<rows key="c" lines={lines("c", 5)} />,
		]);
		for (const node of surface.main()) settle(node);
		backend.renderNow();
		// `a` retired whole, `b` gave up the rows that do not fit.
		expect(driver.history).toEqual([...lines("a", 4), "b0", "b1", "b2"]);

		inserted.set(true);
		settle(surface.main()[0]!);
		backend.renderNow();
		backend.renderNow();
		expect(duplicated(driver.history)).toEqual([]);
		expect(duplicated(driver.transcript)).toEqual([]);
		backend.stop();
	});

	// The coding agent's header rebuild (`#syncHeaderExtras`): the retired header block is removed
	// (Transcript.remove → replayHistory) and a new one inserted under the welcome card.
	it("ES-01 never writes a committed block twice after a retired block is replaced above the frontier", () => {
		const header = signal("h1");
		const { driver, surface, backend } = setup(() => [
			<rows key="w" lines={["w0"]} />,
			() => <rows key={header()} lines={[`${header()}.0`]} />,
			<rows key="a" lines={lines("a", 4)} />,
			<rows key="b" lines={lines("b", 4)} />,
			<rows key="c" lines={lines("c", 5)} />,
		]);
		for (const node of surface.main().slice(0, 4)) settle(node);
		backend.renderNow();
		expect(driver.history).toEqual(["w0", "h1.0", ...lines("a", 4), "b0", "b1", "b2"]);

		header.set("h2");
		driver.replay();
		settle(surface.main()[1]!);
		backend.renderNow();
		backend.renderNow();
		expect(duplicated(driver.transcript)).toEqual([]);
		backend.stop();
	});

	// Resize logical-neutrality (Theorem 4.16(v)): e is a count of semantic rows. The backend counts
	// rows painted at the emission width and keeps the number when the width changes without a
	// replay (`preserve`, in-place resize): at the new width it skips the wrong rows.
	it("ES-02 keeps a streaming head's emitted prefix exact when the terminal widens without a replay", () => {
		const text = signal([1, 2, 3, 4, 5, 6].map(paragraph).join("\n\n"));
		const driver = new FakeDriver();
		driver.replays = false;
		const { surface, backend } = mount(driver, () => <md key="answer" text={text} stream />);
		backend.renderNow();
		// Two rows per paragraph at 20 columns. History keeps its width on a resize here, so the head
		// goes whole: p1-p5 (its stable blocks) are in history, p6 live.
		expect(driver.history.filter(row => row.startsWith("p")).map(row => row.slice(0, 2))).toEqual([
			"p1",
			"p2",
			"p3",
			"p4",
			"p5",
		]);

		driver.resize(60, 6);
		backend.renderNow();
		text.set(`${text()}\n\n${paragraph(7)}\n\n${paragraph(8)}`);
		backend.renderNow();
		settle(surface.main()[0]!);
		backend.renderNow();
		backend.renderNow();
		const paragraphs = driver.transcript.filter(row => row.startsWith("p")).map(row => row.slice(0, 2));
		expect(paragraphs).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
		backend.stop();
	});

	it("ES-02 keeps a streaming head's emitted prefix exact when the terminal narrows without a replay", () => {
		const text = signal([1, 2, 3, 4, 5, 6].map(paragraph).join("\n\n"));
		const driver = new FakeDriver();
		driver.columns = 60;
		driver.replays = false;
		const { surface, backend } = mount(driver, () => <md key="answer" text={text} stream />);
		backend.renderNow();
		expect(driver.history.filter(row => row.startsWith("p")).length).toBeGreaterThan(0);

		driver.resize(20, 6);
		backend.renderNow();
		settle(surface.main()[0]!);
		backend.renderNow();
		backend.renderNow();
		const paragraphs = driver.transcript.filter(row => row.startsWith("p")).map(row => row.slice(0, 2));
		expect(paragraphs).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
		backend.stop();
	});

	// A history batch is prepared once and offered until acknowledged; nothing re-renders it when
	// the width changes meanwhile, so the writer cuts its rows to the new width.
	it("ES-05 renders a pending history batch at the width it is written at", () => {
		const driver = new FakeDriver();
		driver.columns = 30;
		const { surface, backend } = mount(driver, () => [
			<md key="a" text="alpha beta gamma delta epsilon zeta eta theta" />,
			<rows key="c" lines={lines("c", 6)} />,
		]);
		driver.ack = false;
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(driver.frames.at(-1)!.history?.rows.length).toBe(2);

		driver.resize(12, 6);
		driver.ack = true;
		backend.renderNow();
		expect(driver.history.length).toBeGreaterThan(0);
		expect(driver.history.filter(row => row.length > 12)).toEqual([]);
		backend.stop();
	});
});

describe("append-only contract of the stable head (§2.4, Lemma 4.6(i))", () => {
	const options: MarkdownOptions = { theme: PLAIN_THEME, stream: true };

	/**
	 * The first row reported stable that later text changed, as `document` arrives one character at
	 * a time. A blank separator row that goes away with its tail is tolerated (the backend shows
	 * nothing for it).
	 */
	function firstBrokenStableRow(document: string, width: number): string | undefined {
		const history: string[] = [];
		for (let end = 1; end <= document.length; end++) {
			const frame = renderMarkdownFrame(document.slice(0, end), width, options);
			const rows = frame.rows.map(row => stripEscapes(row).trimEnd());
			for (let row = 0; row < history.length; row++) {
				if (rows[row] === history[row] || (row >= rows.length && history[row] === "")) continue;
				return `row ${row}: ${JSON.stringify(history[row])} became ${JSON.stringify(rows[row])}`;
			}
			for (let row = history.length; row < frame.stable; row++) history.push(rows[row]!);
		}
		return undefined;
	}

	const UNSOUND: Readonly<Record<string, string>> = {
		"a reference definition arriving after its links":
			"See [the docs][1] here.\n\nSecond.\n\n[1]: https://example.com/a/long/url\n\nThird.\n\nFourth.\n",
		"a loose ordered list taking its next item": "1. one\n\n   continued\n\n2. two\n\nEnd\n",
		"display math holding a blank line": "$$\nx = 1\n\ny = 2\n$$\n\nafter\n",
		"indented code continuing after a blank line": "para\n\n    code\n\n    more code\n\nend\n",
	};
	for (const name in UNSOUND) {
		it(`ES-03 never changes a row it reported stable: ${name}`, () => {
			expect(firstBrokenStableRow(UNSOUND[name]!, 40)).toBeUndefined();
		});
	}

	it("ES-03 writes no paragraph twice when a reference definition arrives", () => {
		const head = [
			"See [the docs][1] and [more of the docs][1] for all the details here.",
			"Second paragraph.",
			"Third paragraph.",
			"Fourth paragraph.",
			"Fifth paragraph.",
		].join("\n\n");
		const text = signal(head);
		const { driver, surface, backend } = setup(() => <md key="answer" text={text} stream />);
		driver.rows = 3;
		backend.renderNow();
		expect(driver.history).toContain("Second paragraph.");

		text.set(`${head}\n\n[1]: https://example.com/a/very/long/url\n\nSixth paragraph.\n\nSeventh.`);
		backend.renderNow();
		settle(surface.main()[0]!);
		backend.renderNow();
		backend.renderNow();
		expect(duplicated(driver.transcript.filter(row => row.endsWith("paragraph.")))).toEqual([]);
		backend.stop();
	});

	it("ES-03 loses no list item whose marker was still arriving", () => {
		const text = signal("1. one\n\n   continued\n\n2");
		const { driver, surface, backend } = setup(() => [
			<md key="answer" text={text} stream />,
			<rows key="tool" lines={lines("t", 3)} />,
		]);
		driver.rows = 4;
		backend.renderNow();

		text.set("1. one\n\n   continued\n\n2. two\n\nEnd");
		backend.renderNow();
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(driver.transcript).toContain("2. two");
		backend.stop();
	});

	// AppendStable is enabled only while D > h (§3.4): the separator rows written with the head's
	// first rows relieve pressure too, and are not counted.
	it("ES-11 streams no stable row beyond the row pressure", () => {
		const text = signal("one\n\ntwo\n\nthree\n\nfour\n\nfive");
		const { driver, surface, backend } = setup(
			() => [<rows key="a" lines={lines("a", 2)} />, <md key="answer" text={text} stream />],
			{ separator: 1 },
		);
		settle(surface.main()[0]!);
		backend.renderNow();
		// 2 + 1 + 9 rows in 6: once `a`, the separator and "one", "", "two" left, the rest fits.
		expect(driver.history).toEqual(["a0", "a1", "", "one", "", "two"]);
		expect(driver.viewport.length).toBe(6);
		backend.stop();
	});
});

describe("replay (§3.6, Lemma 4.11, RS)", () => {
	// A resize or reset arriving during an unfinished replay invalidates the prepared frame
	// (prep′ := false). The backend keeps the batch it prepared for the first request.
	it("ES-05 prepares the replay again when the display is lost again before it was written", () => {
		const removed = signal(false);
		const { driver, surface, backend } = setup(() => [
			<md key="a" text="alpha beta gamma delta epsilon zeta eta theta" />,
			() => (removed() ? null : <rows key="b" lines={lines("b", 3)} />),
			<rows key="c" lines={lines("c", 6)} />,
		]);
		for (const node of surface.main().slice(0, 2)) settle(node);
		backend.renderNow();
		expect(driver.history).toEqual(["alpha beta gamma", "delta epsilon zeta", "eta theta", "b0", "b1", "b2"]);

		driver.ack = false;
		driver.replay();
		backend.renderNow();
		expect(driver.frames.at(-1)!.history?.kind).toBe("replay");
		// Not written yet: the terminal gets wider, a retired block is removed, the display is reset again.
		driver.resize(40, 6);
		removed.set(true);
		driver.replay();
		driver.ack = true;
		backend.renderNow();
		expect(driver.history).not.toContain("b0");
		expect(driver.history[0]).toBe("alpha beta gamma delta epsilon zeta eta");
		backend.stop();
	});

	// The replay frame is C(c) followed by the head's emitted prefix (Definition 2.13); the backend
	// forgets the emitted count instead and the prefix is in neither history nor the viewport.
	it("ES-07 replays the emitted prefix of the streaming head", () => {
		const text = signal("one\n\ntwo\n\nthree\n\nfour");
		const { driver, backend } = setup(() => <md key="answer" text={text} stream />);
		driver.rows = 4;
		backend.renderNow();
		expect(driver.history).toEqual(["one", "", "two"]);

		driver.replay();
		backend.renderNow();
		expect(driver.frames.at(-1)!.history?.kind).toBe("replay");
		expect(driver.transcript).toContain("one");
		expect(driver.transcript).toContain("two");
		backend.stop();
	});
});

describe("progress (§4.8: weak fairness of RetireSuccess and AppendStable)", () => {
	// A frame that carries a replay computes no retirement, and nothing schedules a frame after
	// its acknowledgement: finalized rows above the viewport stay out of history until some
	// unrelated event paints again.
	it("ES-06 retires a finalized block under row pressure after a replay was written", async () => {
		const { driver, surface, backend } = setup(() => [
			<rows key="a" lines={lines("a", 5)} />,
			<rows key="b" lines={lines("b", 5)} />,
		]);
		for (const node of surface.main()) settle(node);
		backend.renderNow();
		expect(driver.history).toEqual(lines("a", 4));

		// A settled resize under `rebuild`: fewer rows, history replayed.
		driver.rows = 3;
		driver.replay();
		await Bun.sleep(120);
		expect(driver.transcript).toEqual([...lines("a", 5), ...lines("b", 5)]);
		backend.stop();
	});

	it("ES-06 retires what became eligible while a batch waited for its acknowledgement", async () => {
		const { driver, surface, backend } = setup(() => [
			<rows key="a" lines={lines("a", 5)} />,
			<rows key="b" lines={lines("b", 5)} />,
			<rows key="c" lines={lines("c", 5)} />,
		]);
		const [a, b] = surface.main();
		settle(a!);
		driver.ack = false;
		backend.renderNow();
		settle(b!);
		backend.renderNow();
		driver.ack = true;
		backend.renderNow();
		await Bun.sleep(120);
		expect(driver.transcript).toEqual([...lines("a", 5), ...lines("b", 5), ...lines("c", 5)]);
		backend.stop();
	});
});

describe("shutdown (§3.7)", () => {
	// BeginGracefulShutdown freezes every live block and flushes; GracefulExit needs c = γ.
	it("ES-09 leaves every row of the transcript in the terminal on a graceful stop", async () => {
		const driver = new VtDriver({ rows: 6 });
		const { backend } = mount(driver, () => [<rows key="a" lines={lines("a", 10)} />]);
		backend.renderNow();
		await stopLikeHost(backend, driver);
		expect(driver.vt.transcript()).toEqual(lines("a", 10));
	});

	it("ES-09 writes a pending batch and the viewport when stopped during a resize", async () => {
		const driver = new VtDriver({ rows: 6 });
		const { surface, backend } = mount(driver, () => [
			<rows key="a" lines={lines("a", 4)} />,
			<rows key="b" lines={lines("b", 4)} />,
		]);
		backend.renderNow();
		driver.resize(20, 5);
		settle(surface.main()[0]!);
		backend.renderNow();
		await stopLikeHost(backend, driver);
		const transcript = driver.vt.transcript();
		for (const row of lines("a", 4)) expect(transcript).toContain(row);
		expect(transcript.slice(-2)).toEqual(["b2", "b3"]);
	});
});

describe("live geometry (§2.6, Theorem 4.2)", () => {
	// Definition 2.10(1): a visible active block owns at least one row.
	it("ES-10 gives every active block a row while the blocks do not outnumber the rows", () => {
		const { driver, backend } = setup(() => [
			<rows key="a" lines={lines("a", 2)} />,
			<rows key="b" lines={lines("b", 8)} />,
		]);
		backend.renderNow();
		expect(driver.viewport.length).toBe(6);
		expect(driver.viewport.some(row => row.startsWith("a"))).toBe(true);
		backend.stop();
	});

	// Theorem 4.2(iii): under overflow the first row is the summary of everything older.
	it("ES-10 summarizes the active blocks that do not fit", () => {
		const blocks = ["k0", "k1", "k2", "k3", "k4"];
		const { driver, backend } = setup(() => blocks.map(key => <rows key={key} lines={[key]} />));
		driver.rows = 3;
		backend.renderNow();
		expect(driver.viewport.length).toBe(3);
		expect(driver.viewport.slice(1)).toEqual(["k3", "k4"]);
		expect(blocks).not.toContain(driver.viewport[0]!);
		backend.stop();
	});

	// Theorem 4.2(ii): no room for the transcript at all is still well defined.
	it("degrades to no live rows when the dock takes the whole screen", () => {
		const driver = new FakeDriver();
		driver.rows = 2;
		const { surface, backend } = mount(
			driver,
			() => [<rows key="a" lines={lines("a", 3)} />, <rows key="b" lines={lines("b", 2)} />],
			{ dock: () => <rows key="dock" lines={lines("d", 4)} /> },
		);
		expect(driver.history).toEqual([]);
		expect(driver.viewport).toEqual(lines("d", 4));
		for (const node of surface.main()) settle(node);
		backend.renderNow();
		expect(driver.history).toEqual([...lines("a", 3), ...lines("b", 2)]);
		expect(driver.viewport).toEqual(lines("d", 4));
		backend.stop();
	});
});

interface Scenario {
	readonly sync: boolean;
	readonly policy: "preserve" | "rebuild";
	/** Resize while the session runs: taller, or to another width. */
	readonly resize: "none" | "grow" | "width";
}

interface LiveBlock {
	readonly key: string;
	readonly rows: Signal<string[]>;
}

/**
 * A random session of mutable blocks over the frame writer and an emulator:
 * blocks are added, rewritten and settled in any order, the terminal resizes,
 * and at the end everything settles. Returns what the terminal holds and what
 * the transcript is.
 */
async function session(start: number, scenario: Scenario): Promise<{ actual: string[]; expected: string[] }> {
	let seed = start;
	const random = (n: number): number => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) % n;
	};
	let rows = 4 + (start % 7);
	let columns = 30;
	const driver = new VtDriver({ rows, columns, sync: scenario.sync, resizeScrollback: scenario.policy });
	const blocks = signal<LiveBlock[]>([]);
	const { surface, backend } = mount(
		driver,
		() => <For each={blocks}>{block => <rows key={block.key} lines={block.rows} />}</For>,
		{ dock: () => <rows key="dock" lines={["dock"]} /> },
	);
	for (let step = 0; step < 120; step++) {
		const action = random(10);
		const list = blocks();
		const nodes = surface.main();
		const live = list.filter((_, index) => !isSettled(nodes[index]!));
		if (action < 2 || list.length === 0) {
			const key = `k${list.length}`;
			blocks.set([...list, { key, rows: signal(lines(`${key}.`, 1 + random(4))) }]);
		} else if (action < 6 && live.length > 0) {
			const block = live[random(live.length)]!;
			const current = block.rows();
			if (random(4) === 0 && current.length > 1) block.rows.set(current.slice(0, -1));
			else block.rows.set([...current, `${block.key}.${current.length}+${step}`]);
		} else if (action < 9 && live.length > 0) {
			settle(nodes[list.indexOf(live[random(live.length)]!)]!);
		} else if (action === 9 && scenario.resize !== "none") {
			if (scenario.resize === "grow") rows++;
			else columns = columns === 30 ? 40 : 30;
			driver.resize(columns, rows);
			backend.renderNow();
			await driver.vt.settle();
		}
		backend.renderNow();
	}
	for (const node of surface.main()) settle(node);
	backend.renderNow();
	backend.renderNow();
	await stopLikeHost(backend, driver);
	return {
		actual: driver.vt.transcript().filter(row => row !== ""),
		expected: [...blocks().flatMap(block => block.rows()), "dock"],
	};
}

describe("ordinary retirement through the frame writer (Lemma 4.8, Corollary 4.9)", () => {
	const scenarios: Scenario[] = [
		{ sync: true, policy: "preserve", resize: "none" },
		{ sync: false, policy: "preserve", resize: "none" },
		{ sync: false, policy: "preserve", resize: "grow" },
		{ sync: true, policy: "rebuild", resize: "width" },
		{ sync: false, policy: "rebuild", resize: "width" },
	];
	for (const scenario of scenarios) {
		const mode = scenario.sync ? "synchronized" : "unsynchronized";
		const name = `${mode}, ${scenario.policy}, resize ${scenario.resize}`;
		it(`holds every finalized row exactly once and in order (${name})`, async () => {
			for (const seed of [7919, 15_838, 31_676, 47_514, 104_729, 209_458]) {
				const { actual, expected } = await session(seed, scenario);
				expect(actual).toEqual(expected);
			}
		});
	}
});

// Counterexamples of the re-review (after the ES-01…ES-11 fixes).
describe("re-review", () => {
	// ED: e > 0 only for the head c+1. A block with rows in history (a streaming head, or a settled
	// block retired row by row) is not in the committed set: a block inserted right above it must still
	// replay, or its rows are written in the middle of the other block's. (Fixed while under re-review.)
	it("ES-12 writes a block inserted above a partly retired block before that block's rows", () => {
		const inserted = signal(false);
		const { driver, surface, backend } = setup(() => [
			<rows key="a" lines={lines("a", 4)} />,
			() => (inserted() ? <rows key="x" lines={["x0"]} /> : null),
			<rows key="b" lines={lines("b", 4)} />,
			<rows key="c" lines={lines("c", 5)} />,
		]);
		for (const node of surface.main()) settle(node);
		backend.renderNow();

		inserted.set(true);
		settle(surface.main()[1]!);
		backend.renderNow();
		backend.renderNow();
		expect(driver.transcript).toEqual([...lines("a", 4), "x0", ...lines("b", 4), ...lines("c", 5)]);
		backend.stop();
	});

	it("ES-12 writes a block inserted above a streaming head before the head's rows", () => {
		const inserted = signal(false);
		const text = signal([1, 2, 3, 4, 5, 6].map(paragraph).join("\n\n"));
		const { driver, surface, backend } = setup(() => [
			() => (inserted() ? <rows key="x" lines={["x0"]} /> : null),
			<md key="answer" text={text} stream />,
		]);
		backend.renderNow();
		expect(driver.history.some(row => row.startsWith("p1"))).toBe(true);

		inserted.set(true);
		settle(surface.main()[0]!);
		backend.renderNow();
		backend.renderNow();
		const marks = driver.transcript.filter(row => /^(x|p)\d/.test(row)).map(row => row.slice(0, 2));
		expect(marks).toEqual(["x0", "p1", "p2", "p3", "p4", "p5", "p6"]);
		backend.stop();
	});

	// What `Host.suspend()` does (host.ts) around an external editor: the display is reset while the
	// backend is stopped and listens to nothing, so the cleared history is never replayed.
	it("ES-13 replays history after a suspend", async () => {
		const driver = new VtDriver({ rows: 6 });
		const { surface, backend } = mount(
			driver,
			() => [<rows key="a" lines={lines("a", 8)} />, <rows key="b" lines={lines("b", 3)} />],
			{ dock: () => <rows key="dock" lines={["dock"]} /> },
		);
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(driver.vt.transcript().filter(row => row.startsWith("a"))).toEqual(lines("a", 8));

		backend.renderNow();
		backend.stop();
		await driver.stop();
		driver.vt.term.write("editor output\r\n");
		driver.vt.writer.start({ row: driver.vt.term.cursor.y, col: driver.vt.term.cursor.x });
		driver.resetDisplay();
		backend.start();
		await Bun.sleep(60);
		expect(driver.vt.transcript().filter(row => row.startsWith("a"))).toEqual(lines("a", 8));
		backend.stop();
	});

	// The frontier check sees blocks that left the committed prefix, not ones that changed places in it.
	it("ES-15 replays when committed blocks change places", () => {
		const order = signal(["a", "b", "c"]);
		const nodes: Readonly<Record<string, unknown>> = {
			a: <rows key="a" lines={lines("a", 4)} />,
			b: <rows key="b" lines={lines("b", 4)} />,
			c: <rows key="c" lines={lines("c", 6)} />,
		};
		const { driver, surface, backend } = setup(() => () => order().map(key => nodes[key]));
		for (const node of surface.main()) settle(node);
		backend.renderNow();
		expect(driver.history).toEqual([...lines("a", 4), ...lines("b", 4)]);

		order.set(["b", "a", "c"]);
		backend.renderNow();
		backend.renderNow();
		expect(driver.history).toEqual([...lines("b", 4), ...lines("a", 4)]);
		backend.stop();
	});

	// A definition right under another block (no blank line) drops the settled count to 0: the whole
	// document, the rows reported stable included, is drawn with every reference resolved.
	const SOURCES = "See [ref][1] here.\n\nSecond.\n\nSources:\n[1]: http://one.example\n\nmore\n";
	it("ES-16 never changes a row it reported stable: a definition right under a paragraph", () => {
		const options: MarkdownOptions = { theme: PLAIN_THEME, stream: true };
		const history: string[] = [];
		const changed: string[] = [];
		for (let end = 1; end <= SOURCES.length && changed.length === 0; end++) {
			const frame = renderMarkdownFrame(SOURCES.slice(0, end), 40, options);
			const rows = frame.rows.map(row => stripEscapes(row).trimEnd());
			for (let row = 0; row < history.length; row++) {
				if (rows[row] === history[row] || (row >= rows.length && history[row] === "")) continue;
				changed.push(`row ${row}: ${JSON.stringify(history[row])} became ${JSON.stringify(rows[row])}`);
				break;
			}
			for (let row = history.length; row < frame.stable; row++) history.push(rows[row]!);
		}
		expect(changed).toEqual([]);
	});

	// The backend's own check keeps the ledger exact when a head takes its stable rows back.
	it("ES-16 writes every paragraph once when a stable head changes under history", () => {
		const body = ["See [ref][1] here.", ...[1, 2, 3, 4].map(paragraph)].join("\n\n");
		const tail = "\n\nSources:\n[1]: http://one.example\n";
		const text = signal(body);
		const stream = signal(true);
		const { driver, surface, backend } = setup(() => <md key="answer" text={text} stream={stream} />);
		backend.renderNow();
		expect(driver.history.length).toBeGreaterThan(0);
		for (let end = 1; end <= tail.length; end++) {
			text.set(body + tail.slice(0, end));
			backend.renderNow();
		}
		stream.set(false);
		settle(surface.main()[0]!);
		backend.renderNow();
		backend.renderNow();
		const marks = driver.transcript.filter(row => /^(See|p\d|Sources)/.test(row)).map(row => row.split(" ")[0]);
		expect(marks).toEqual(["See", "p1", "p2", "p3", "p4", "Sources:"]);
		backend.stop();
	});

	// The head always gives up one row, also when the separator written with it already made room.
	it("ES-17 streams no stable row when the separator alone relieves the pressure", () => {
		const text = signal("one\n\ntwo\n\nthree\n\nfour\n\nfive");
		const { driver, surface, backend } = setup(
			() => [<rows key="a" lines={lines("a", 2)} />, <md key="answer" text={text} stream />],
			{ separator: 1 },
		);
		driver.rows = 9;
		settle(surface.main()[0]!);
		backend.renderNow();
		// 2 + 1 + 9 rows in 9: `a` and the separator leave, the nine rows of the answer fit.
		expect(driver.history).not.toContain("one");
		expect(driver.viewport.length).toBe(9);
		backend.stop();
	});

	it("ES-18 counts only blocks with rows in the summary", () => {
		const { driver, backend } = setup(() => [
			<rows key="empty" lines={[]} />,
			<rows key="u" lines={lines("u", 2)} />,
			<rows key="v" lines={lines("v", 2)} />,
		]);
		driver.rows = 1;
		backend.renderNow();
		expect(driver.viewport).toEqual(["⋯ 2 more running"]);
		backend.stop();
	});

	// A block with rows in history no longer matches them at another width, so every frame of a
	// resize the driver has not settled (it takes no history meanwhile) paints the whole ledger anew.
	it("ES-19 does not prepare the ledger again for every frame of an unsettled resize", () => {
		const driver = new FakeDriver();
		driver.columns = 40;
		const { surface, backend } = mount(driver, () => [
			...Array.from({ length: 30 }, (_, i) => <md key={`h${i}`} text={`entry ${i}`} />),
			<md key="last" text={[1, 2, 3, 4, 5, 6].map(paragraph).join("\n\n")} />,
		]);
		for (const node of surface.main()) settle(node);
		backend.renderNow();
		backend.renderNow();

		driver.ack = false;
		const offered = new Set<number>();
		for (let columns = 41; columns <= 50; columns++) {
			driver.resize(columns, 6);
			backend.renderNow();
			const history = driver.frames.at(-1)!.history;
			if (history?.kind === "replay") offered.add(history.id);
		}
		expect(offered.size).toBeLessThanOrEqual(2);
		backend.stop();
	});

	// Resize (Preserve) must not replay (Table 2). Any block with part of its rows in history now
	// forces one on a width change, so `preserve` (and in-place resize) clears scrollback like `rebuild`.
	it("ES-20 preserve: a width change leaves native history alone", async () => {
		const driver = new VtDriver({ rows: 6, columns: 20, shell: ["$ shell"], resizeScrollback: "preserve" });
		const { surface, backend } = mount(
			driver,
			() => [1, 2, 3, 4, 5].map(n => <md key={`p${n}`} text={paragraph(n)} />),
			{ dock: () => <rows key="dock" lines={["dock"]} /> },
		);
		for (const node of surface.main()) settle(node);
		backend.renderNow();
		backend.renderNow();
		expect(driver.vt.scrollback()).toContain("$ shell");

		const mark = driver.vt.writes.length;
		driver.resize(44, 6);
		backend.renderNow();
		await driver.vt.settle();
		backend.renderNow();
		backend.renderNow();
		await stopLikeHost(backend, driver);
		expect(driver.vt.since(mark)).not.toContain("\x1b[3J");
		const transcript = driver.vt.transcript();
		expect(transcript).toContain("$ shell");
		const tokens = transcript.flatMap(row => row.trim().split(/\s+/));
		expect(tokens.filter(token => /^p\d$/.test(token))).toEqual(["p1", "p2", "p3", "p4", "p5"]);
		expect(tokens.filter(token => token === "word").length).toBe(35);
	});
});

// Counterexamples of the final look (after ES-12…ES-20).
describe("final look", () => {
	// A history prefix is carried to another width by its words (`remapEmitted`). A token the old
	// width broke across rows (a URL, a path, a long compound) is two "words" there and one here: the
	// mapping stops at its row, and everything from that row on is shown and written a second time.
	const BROKEN_TOKENS: Readonly<Record<string, string>> = {
		"a URL longer than the row": `See https://example.com/alpha/${"a".repeat(30)}/omega for details.`,
		"a compound word longer than the row": "Use the long-hyphenated-compound-word-here option.",
	};
	for (const name in BROKEN_TOKENS) {
		it(`ES-21 keeps history exact across a width change without replay: ${name}`, () => {
			const text = signal([BROKEN_TOKENS[name]!, ...[1, 2, 3, 4, 5, 6].map(paragraph)].join("\n\n"));
			const stream = signal(true);
			const driver = new FakeDriver();
			driver.replays = false;
			const { surface, backend } = mount(driver, () => <md key="answer" text={text} stream={stream} />);
			backend.renderNow();
			expect(driver.history.some(row => row.startsWith("p1"))).toBe(true);

			driver.resize(60, 6);
			backend.renderNow();
			text.set(`${text()}\n\n${paragraph(7)}\n\n${paragraph(8)}`);
			backend.renderNow();
			stream.set(false);
			settle(surface.main()[0]!);
			backend.renderNow();
			backend.flush();
			const paragraphs = driver.history.filter(row => /^p\d/.test(row)).map(row => row.slice(0, 2));
			expect(paragraphs).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
			backend.stop();
		});
	}

	// Under `rebuild` the writer replays when a burst *ends* at another width. Frames composed at a
	// width the burst only passed through remap the prefix (dropping the row it cuts through); back
	// at the first width nothing replays, and that row, still in scrollback, is written again.
	it("ES-22 writes no row twice when a resize burst returns to its first width", async () => {
		const driver = new VtDriver({ rows: 5, columns: 20, resizeScrollback: "rebuild" });
		const { surface, backend } = mount(
			driver,
			() => <md key="answer" text={[1, 2, 3, 4, 5, 6].map(paragraph).join("\n\n")} />,
			{ dock: () => <rows key="dock" lines={["dock"]} /> },
		);
		settle(surface.main()[0]!);
		backend.renderNow();
		backend.renderNow();

		driver.resize(27, 5);
		backend.renderNow();
		driver.resize(20, 5);
		backend.renderNow();
		await driver.vt.settle();
		backend.renderNow();
		await stopLikeHost(backend, driver);
		const tokens = driver.vt.transcript().flatMap(row => row.trim().split(/\s+/));
		expect(tokens.filter(token => /^p\d$/.test(token))).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
		expect(tokens.filter(token => token === "word").length).toBe(42);
	});
});
