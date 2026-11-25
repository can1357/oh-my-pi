import { describe, expect, it, vi } from "bun:test";
import type { InputEvent, TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { createTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import type { KeyboardScreenModes, TerminalIdentity, TerminalInput, TerminalPort } from "@oh-my-pi/pi-tui/driver/io";
import type { StreamSink } from "@oh-my-pi/pi-tui/driver/output/sink";
import { jamoWidth, setJamoWidth } from "@oh-my-pi/pi-tui/text/width";

const CAPABILITIES: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: true,
	hyperlinks: true,
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

/** An input half that records its lifecycle and lets the test fire resizes. */
class FakeInput implements TerminalInput {
	columns = 20;
	rows = 6;
	capabilities = CAPABILITIES;
	identity: TerminalIdentity = {
		id: "kitty",
		multiplexer: null,
		ssh: false,
		conpty: false,
		version: null,
		notify: "osc99",
		richNotifications: false,
		glyphs: false,
	};
	readonly log: string[] = [];
	readonly #port: TerminalPort;
	readonly #resize = new Set<(columns: number, rows: number) => void>();
	#input: ((event: InputEvent) => void) | undefined;

	constructor(port: TerminalPort) {
		this.#port = port;
	}

	async start(): Promise<void> {
		this.log.push("start");
		this.#port.write("<modes>");
	}

	async stop(): Promise<void> {
		this.log.push("stop");
		this.#port.write("<restore>");
	}

	onInput(listener: (event: InputEvent) => void): () => void {
		this.#input = listener;
		return () => {
			this.#input = undefined;
		};
	}

	input(event: InputEvent): void {
		this.#input?.(event);
	}

	onResize(listener: (columns: number, rows: number) => void): () => void {
		this.#resize.add(listener);
		return () => this.#resize.delete(listener);
	}

	onCapabilities(_listener: (capabilities: TerminalCapabilities) => void): () => void {
		return () => {};
	}

	rearmsPaste = false;
	readonly #disconnect = new Set<(reason: string) => void>();
	onDisconnect(listener: (reason: string) => void): () => void {
		this.#disconnect.add(listener);
		return () => this.#disconnect.delete(listener);
	}
	disconnect(reason: string): void {
		for (const listener of this.#disconnect) listener(reason);
	}
	readonly tspExpected = false;
	onHelloSettled(): () => void {
		return () => {};
	}
	setTitle(): void {}
	setMouse(): void {}
	refreshAppearance(): void {}
	setProgress(active: boolean): void {
		this.#port.write(active ? "<progress>" : "<no-progress>");
	}
	setCursorShape(): void {}

	keyboardScreenModes(): KeyboardScreenModes {
		return { enterAlt: "<kbd-in>", leaveAltBefore: "<kbd-out>", leaveAltAfter: "<kbd-after>" };
	}

	async queryCursor(): Promise<{ row: number; col: number } | null> {
		return { row: 0, col: 0 };
	}

	passthrough(sequence: string): string {
		return sequence;
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		for (const listener of this.#resize) listener(columns, rows);
	}
}

function setup(
	identity: Partial<TerminalIdentity> = {},
	sink: Partial<StreamSink> = {},
	env: Record<string, string> = {},
) {
	let out = "";
	let input: FakeInput | undefined;
	const driver = createTerminalDriver({
		env,
		sink: {
			write: data => {
				out += data;
			},
			flush: async () => {},
			...sink,
		},
		input: port => {
			input = new FakeInput(port);
			input.identity = { ...input.identity, ...identity };
			return input;
		},
	});
	return { driver, input: input!, output: () => out };
}

describe("createTerminalDriver", () => {
	it("routes the input half's bytes and frames through one sink, in order", async () => {
		const { driver, input, output } = setup();
		await driver.start();
		expect(driver.present({ history: { id: 1, rows: ["done"] }, viewport: ["live"], cursor: null })).toBe(1);
		await driver.stop();
		const bytes = output();
		expect(bytes.indexOf("<modes>")).toBeLessThan(bytes.indexOf("done"));
		expect(bytes.indexOf("done")).toBeLessThan(bytes.indexOf("<restore>"));
		expect(input.log).toEqual(["start", "stop"]);
		expect(driver.images).toBeDefined();
	});

	it("wraps alternate-screen switches in the input half's keyboard bytes", async () => {
		const { driver, output } = setup();
		await driver.start();
		driver.present({ viewport: [], cursor: null, fullscreen: ["modal"] });
		driver.present({ viewport: ["live"], cursor: null });
		expect(output()).toContain("\x1b[?1049h<kbd-in>");
		expect(output()).toContain("<kbd-out>\x1b[?1049l<kbd-after>");
	});

	it("delivers an input event only to listeners subscribed before it and still subscribed at their turn", async () => {
		const { driver, input } = setup();
		await driver.start();
		const seen: string[] = [];
		const label = (event: InputEvent) => (event.type === "osc" ? event.raw : event.type);
		// The first listener opens a page (a new listener) and closes another, as Esc Esc's rewind does.
		let unsubscribeLate: () => void = () => {};
		driver.onInput(event => {
			seen.push(`opener:${label(event)}`);
			if (label(event) !== "first") return;
			driver.onInput(next => seen.push(`page:${label(next)}`));
			unsubscribeLate();
		});
		unsubscribeLate = driver.onInput(event => seen.push(`closed:${label(event)}`));
		input.input({ type: "osc", raw: "first" });
		input.input({ type: "osc", raw: "second" });
		expect(seen).toEqual(["opener:first", "opener:second", "page:second"]);
		await driver.stop();
	});

	it("forwards resizes and asks replay listeners for the ledger after a display reset", async () => {
		const { driver, input } = setup();
		await driver.start();
		const sizes: string[] = [];
		let replays = 0;
		driver.onResize((columns, rows) => sizes.push(`${columns}x${rows}`));
		driver.onReplay(() => replays++);
		input.resize(30, 8);
		expect(sizes).toEqual(["30x8"]);
		driver.resetDisplay();
		expect(replays).toBe(1);
		await driver.stop();
	});
});

describe("createTerminalDriver terminal quirks", () => {
	it.each([
		{ policy: "default", forceInPlace: undefined, borrows: false },
		{ policy: "forced borrow", forceInPlace: "0", borrows: true },
	])("resizes a Herdr pane with $policy without losing the viewport", async ({ forceInPlace, borrows }) => {
		vi.useFakeTimers();
		const env: Record<string, string> = { PI_TUI_RESIZE_SCROLLBACK: "rebuild" };
		if (forceInPlace !== undefined) env.PI_TUI_RESIZE_IN_PLACE = forceInPlace;
		const { driver, input, output } = setup({ multiplexer: "herdr" }, {}, env);
		const rows = ["committed transcript"];
		try {
			await driver.start();
			driver.present({ history: { id: 1, rows }, viewport: ["live at 6 rows"], cursor: null });
			const painted = Promise.withResolvers<void>();
			const mark = output().length;
			let replay = false;
			driver.onReplay(() => (replay = true));
			driver.onResize(() => {
				driver.present({
					history: replay ? { id: 2, rows, kind: "replay" } : undefined,
					viewport: [`live at ${driver.rows} rows`],
					cursor: null,
				});
				if (output().slice(mark).includes("live at 5 rows")) painted.resolve();
			});

			input.resize(20, 5);
			vi.advanceTimersByTime(100);
			await painted.promise;
			const resized = output().slice(mark);
			expect(resized.includes("\x1b[?1049h")).toBe(borrows);
			expect(resized.includes("\x1b[?1049l")).toBe(borrows);
			expect(resized.includes("\x1b[3J")).toBe(borrows);
			expect(resized.includes("committed transcript")).toBe(borrows);
		} finally {
			try {
				await driver.stop();
			} finally {
				vi.useRealTimers();
			}
		}
	});

	it("re-asserts bracketed paste ahead of every write while the input half asks for it", async () => {
		const { driver, input, output } = setup();
		await driver.start();
		input.rearmsPaste = true;
		driver.writeRaw("<x>");
		expect(output().endsWith("\x1b[?2004h<x>")).toBe(true);
	});

	it("forwards progress to the input half", async () => {
		const { driver, output } = setup();
		await driver.start();
		driver.setProgress(true);
		driver.setProgress(false);
		expect(output()).toContain("<progress><no-progress>");
	});

	it("sets the terminal's Hangul jamo width on start", async () => {
		try {
			await setup({ id: "ghostty" }).driver.start();
			expect(jamoWidth()).toBe(2);
			await setup({ id: "warp" }).driver.start();
			expect(jamoWidth()).toBe(1);
			// Paradev drops TERM_PROGRAM but draws jamo at two cells (xterm.js, Unicode 11).
			await setup({ id: "trueColor" }, {}, { SUPERSET_TERMINAL_ID: "term-1" }).driver.start();
			expect(jamoWidth()).toBe(2);
		} finally {
			setJamoWidth("platform");
		}
	});

	it("skips frames while the terminal is not draining and repaints once it drains", async () => {
		let pending = 0;
		let drain: (() => void) | undefined;
		const { driver, output } = setup({}, { pending: () => pending, onDrain: callback => (drain = callback) });
		await driver.start();
		let repaints = 0;
		driver.onResize(() => repaints++);
		pending = 1 << 20;
		const before = output();
		expect(driver.present({ history: { id: 1, rows: ["h"] }, viewport: ["live"], cursor: null })).toBeUndefined();
		expect(driver.present({ history: { id: 1, rows: ["h"] }, viewport: ["live"], cursor: null })).toBeUndefined();
		expect(output()).toBe(before);
		pending = 0;
		drain!();
		expect(repaints).toBe(1);
		expect(driver.present({ history: { id: 1, rows: ["h"] }, viewport: ["live"], cursor: null })).toBe(1);
	});

	// Elastic-slots re-review, ES-14: the shutdown flush is one frame; skipped for a backlog, it is lost.
	it("ES-14 writes the last frame skipped for a backlog when it stops", async () => {
		let pending = 0;
		const { driver, output } = setup({}, { pending: () => pending, onDrain: () => {} });
		await driver.start();
		pending = 1 << 20;
		const flush = { history: { id: 1, rows: ["transcript"] }, viewport: ["dock"], cursor: null };
		expect(driver.present(flush)).toBeUndefined();
		await driver.stop();
		expect(output()).toContain("transcript");
	});

	it("probes the anchor after a resize on ConPTY inside a multiplexer (the mux answers), not outside", async () => {
		vi.useFakeTimers();
		try {
			for (const [multiplexer, probes] of [
				[null, 1],
				["tmux", 2],
			] as const) {
				const { driver, input } = setup({ conpty: true, multiplexer });
				let queries = 0;
				const query = input.queryCursor.bind(input);
				input.queryCursor = () => (queries++, query());
				await driver.start();
				driver.present({ viewport: ["live"], cursor: null });
				input.resize(30, 8);
				driver.present({ viewport: ["live"], cursor: null });
				vi.advanceTimersByTime(100);
				await Promise.resolve();
				expect(queries).toBe(probes);
				await driver.stop();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("hands the terminal back once when it goes away, and reports why", async () => {
		const { driver, input, output } = setup();
		await driver.start();
		const reasons: string[] = [];
		driver.onDisconnect(reason => reasons.push(reason));
		input.disconnect("stdin ended");
		input.disconnect("stdin closed");
		expect(reasons).toEqual(["stdin ended"]);
		expect(input.log).toEqual(["start", "stop"]);
		expect(output()).toContain("<restore>");
	});

	it("declares a terminal whose output stopped draining for good disconnected", async () => {
		vi.useFakeTimers();
		try {
			let pending = 0;
			const { driver } = setup({}, { pending: () => pending, onDrain: () => {} });
			await driver.start();
			const reasons: string[] = [];
			driver.onDisconnect(reason => reasons.push(reason));
			pending = 100 * 1024 * 1024;
			driver.present({ viewport: ["live"], cursor: null });
			vi.advanceTimersByTime(59_000);
			expect(reasons).toEqual([]);
			vi.advanceTimersByTime(2_000);
			expect(reasons).toEqual(["output stalled"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
