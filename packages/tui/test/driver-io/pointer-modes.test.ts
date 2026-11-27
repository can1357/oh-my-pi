import { describe, expect, it } from "bun:test";
import type { InputEvent } from "../../src/driver/contract";
import { type ProcessInputOptions, ProcessTerminalInput } from "../../src/driver/process";
import { FakeClock } from "./fake-clock";

type Listener = (...args: never[]) => void;

class FakeEmitter {
	readonly listeners = new Map<string, Set<Listener>>();
	on(event: string, listener: Listener): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}
	off(event: string, listener: Listener): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}
	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
	}
}

class FakeStdin extends FakeEmitter {
	readonly isTTY = true;
	isRaw = false;
	setRawMode(mode: boolean): this {
		this.isRaw = mode;
		return this;
	}
	resume(): this {
		return this;
	}
	pause(): this {
		return this;
	}
}

class FakeStdout extends FakeEmitter {
	columns = 100;
	rows = 30;
}

const DA1 = "\x1b[?62;22c";
const KITTY = { KITTY_WINDOW_ID: "1" };
const WEZTERM = { WEZTERM_PANE: "1" };
const ITERM = { TERM_PROGRAM: "iTerm.app" };
/** DECRPM: 1016 known and reset. */
const PIXEL_RESET = "\x1b[?1016;2$y";
/** Cell size reply: 20 px high, 10 px wide. */
const CELL = "\x1b[6;20;10t";
const MOUSE_RESET = "\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

async function started(env: Record<string, string>, replies: string[], options: Partial<ProcessInputOptions> = {}) {
	const stdin = new FakeStdin();
	const writes: string[] = [];
	const input = new ProcessTerminalInput(
		{ write: data => writes.push(data) },
		{
			stdin,
			stdout: new FakeStdout(),
			events: new FakeEmitter(),
			clock: new FakeClock(),
			env,
			platform: "darwin",
			conpty: false,
			tmux: () => null,
			...options,
		},
	);
	const received: InputEvent[] = [];
	input.onInput(event => received.push(event));
	const feed = (...reads: string[]) => {
		for (const read of reads) stdin.emit("data", Buffer.from(read));
	};
	const start = input.start();
	feed(...replies, DA1, DA1, DA1);
	await start;
	const mice = () => received.flatMap(event => (event.type === "mouse" ? [event.mouse] : []));
	return { input, writes, received, feed, mice, out: () => writes.join("") };
}

describe("SGR-pixel mouse reporting", () => {
	it("rides along with tracking on kitty once DECRQM confirmed 1016 and the cell size is known", async () => {
		const h = await started(KITTY, [PIXEL_RESET, CELL]);
		expect(h.input.identity.id).toBe("kitty");
		expect(h.input.capabilities.pixelMouse).toBe(true);
		h.writes.length = 0;
		h.input.setMouse("drag");
		expect(h.writes).toEqual(["\x1b[?1002h\x1b[?1006h\x1b[?1016h"]);
		// kitty numbers pixels from 0: (25, 50) is the middle of cell (2, 2).
		h.feed("\x1b[<32;25;50M", "\x1b[<0;0;0m");
		expect(h.mice()).toEqual([
			{ row: 2, col: 2, rowFraction: 0.5, colFraction: 0.5, button: "left", action: "drag", mods: [] },
			{ row: 0, col: 0, rowFraction: 0, colFraction: 0, button: "left", action: "release", mods: [] },
		]);
		h.writes.length = 0;
		h.input.setMouse("off");
		expect(h.writes).toEqual(["\x1b[?1016l\x1b[?1002l\x1b[?1006l"]);
		h.feed("\x1b[<0;3;2M");
		expect(h.mice().at(-1)).toEqual({ row: 1, col: 2, button: "left", action: "press", mods: [] });
	});

	it("numbers WezTerm's pixels from 1 and clamps a pointer outside the window to the first cell", async () => {
		const h = await started(WEZTERM, [PIXEL_RESET, CELL]);
		expect(h.input.identity.id).toBe("wezterm");
		h.input.setMouse("click");
		h.feed("\x1b[<0;26;51M", "\x1b[<32;-4;-9M");
		expect(h.mice()).toEqual([
			{ row: 2, col: 2, rowFraction: 0.5, colFraction: 0.5, button: "left", action: "press", mods: [] },
			{ row: 0, col: 0, rowFraction: 0, colFraction: 0, button: "left", action: "drag", mods: [] },
		]);
	});

	it("joins tracking that is already on when the confirmation arrives, and re-asserts it across a tracking change", async () => {
		const h = await started(KITTY, [CELL]);
		h.input.setMouse("drag");
		expect(h.out()).not.toContain("\x1b[?1016h");
		h.writes.length = 0;
		h.feed(PIXEL_RESET);
		expect(h.writes).toEqual(["\x1b[?1016h"]);
		h.writes.length = 0;
		// Setting 1006 selects SGR cell reports again, so 1016 follows it.
		h.input.setMouse("any");
		expect(h.writes).toEqual(["\x1b[?1002l\x1b[?1003h\x1b[?1006h\x1b[?1016h"]);
	});

	it("follows a new cell size from an in-band resize report", async () => {
		const h = await started(KITTY, [PIXEL_RESET, CELL]);
		h.input.setMouse("drag");
		// 100 columns of 8 px, 30 rows of 16 px.
		h.feed("\x1b[48;30;100;480;800t", "\x1b[<0;12;24M");
		expect(h.mice().at(-1)).toEqual({
			row: 1,
			col: 1,
			rowFraction: 0.5,
			colFraction: 0.5,
			button: "left",
			action: "press",
			mods: [],
		});
	});

	it("keeps cell reports on a terminal whose pixel units are not verified", async () => {
		const h = await started(ITERM, [PIXEL_RESET, CELL]);
		expect(h.input.identity.id).toBe("iterm2");
		expect(h.input.capabilities.pixelMouse).toBe(false);
		h.input.setMouse("drag");
		h.feed("\x1b[<0;3;2M");
		expect(h.mice()).toEqual([{ row: 1, col: 2, button: "left", action: "press", mods: [] }]);
		expect(h.out()).not.toContain("\x1b[?1016h");
	});

	it("keeps cell reports when DECRQM does not recognize 1016, or never answers", async () => {
		for (const replies of [["\x1b[?1016;0$y", CELL], [CELL]]) {
			const h = await started(KITTY, replies);
			expect(h.input.capabilities.pixelMouse).toBe(false);
			h.input.setMouse("drag");
			h.feed("\x1b[<0;3;2M");
			expect(h.mice()).toEqual([{ row: 1, col: 2, button: "left", action: "press", mods: [] }]);
			expect(h.out()).not.toContain("\x1b[?1016h");
		}
	});

	it("keeps cell reports while the cell size is unknown", async () => {
		const h = await started(KITTY, [PIXEL_RESET]);
		expect(h.input.capabilities.pixelMouse).toBe(false);
		h.input.setMouse("drag");
		expect(h.out()).not.toContain("\x1b[?1016h");
	});

	it("asks for the cell size again after an OS resize while pixel reports are on", async () => {
		const stdout = new FakeStdout();
		const h = await started(KITTY, [PIXEL_RESET, CELL], { stdout });
		h.input.setMouse("drag");
		h.writes.length = 0;
		stdout.columns = 120;
		stdout.emit("resize");
		expect(h.writes).toEqual(["\x1b[16t"]);
	});

	it("forgets the pixel verdict on stop", async () => {
		const h = await started(KITTY, [PIXEL_RESET, CELL]);
		h.input.setMouse("drag");
		h.input.stop();
		expect(h.input.capabilities.pixelMouse).toBe(false);
	});
});

describe("kitty pointer leave", () => {
	it("drops leave reports in cell and pixel mode alike", async () => {
		for (const replies of [[], [PIXEL_RESET, CELL]]) {
			const h = await started(KITTY, replies);
			h.input.setMouse("any");
			h.feed("\x1b[<291;5;5M", "\x1b[<35;5;5M");
			expect(h.mice()).toHaveLength(1);
			expect(h.mice()[0]).toMatchObject({ button: "none", action: "move" });
		}
	});
});

describe("alternate scroll (1007)", () => {
	it("turns it off once and restores the terminal's reported state on stop", async () => {
		for (const [report, restore] of [
			["\x1b[?1007;1$y", "\x1b[?1007h"],
			["\x1b[?1007;2$y", "\x1b[?1007l"],
			["", "\x1b[?1007h"],
		] as const) {
			const h = await started(KITTY, report ? [report] : []);
			h.writes.length = 0;
			h.input.setAlternateScroll(false);
			h.input.setAlternateScroll(false);
			expect(h.writes).toEqual(["\x1b[?1007l"]);
			h.writes.length = 0;
			h.input.stop();
			expect(h.out()).toContain(`${MOUSE_RESET}${restore}`);
		}
	});

	it("gives the terminal its own state back mid-session, leaving a stop nothing to undo", async () => {
		for (const [report, own] of [
			["\x1b[?1007;1$y", "\x1b[?1007h"],
			["\x1b[?1007;2$y", "\x1b[?1007l"],
		] as const) {
			const h = await started(KITTY, [report]);
			h.writes.length = 0;
			h.input.setAlternateScroll(false);
			h.input.setAlternateScroll(undefined);
			h.input.setAlternateScroll(undefined);
			expect(h.writes).toEqual(["\x1b[?1007l", own]);
			h.writes.length = 0;
			h.input.stop();
			expect(h.out()).toContain(MOUSE_RESET);
			expect(h.out()).not.toContain("\x1b[?1007");
		}
	});

	it("leaves 1007 alone on stop when the session never touched it", async () => {
		const h = await started(KITTY, ["\x1b[?1007;2$y"]);
		h.writes.length = 0;
		h.input.stop();
		expect(h.out()).toContain(MOUSE_RESET);
		expect(h.out()).not.toContain("\x1b[?1007");
	});

	it("writes nothing before start", () => {
		const writes: string[] = [];
		const input = new ProcessTerminalInput(
			{ write: data => writes.push(data) },
			{ stdin: new FakeStdin(), stdout: new FakeStdout(), events: new FakeEmitter(), env: {}, platform: "darwin" },
		);
		input.setAlternateScroll(false);
		expect(writes).toEqual([]);
	});
});
