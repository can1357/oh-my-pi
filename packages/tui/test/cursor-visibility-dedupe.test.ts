import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { type FakeTty, fakeProcessTty, NOOP_HOST } from "./helpers/process-tty";

// hideCursor()/showCursor() skip the ?25l/?25h escape when the terminal already
// holds that state; crash/exit restore paths pass force=true and must always
// write. The dedupe itself is the engine's output device (covered in Rust by
// `cursor_visibility_dedupes_until_it_becomes_unknown`); this guards that the
// glue hands `force` through to it end to end.

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

describe("ProcessTerminal cursor-visibility dedupe", () => {
	let tty: FakeTty;
	let terminal: ProcessTerminal | undefined;

	beforeEach(() => {
		tty = fakeProcessTty();
	});

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		tty.dispose();
	});

	it("skips same-state repeats and always writes forced changes", () => {
		terminal = tty.terminal({ conpty: false });
		terminal.bind(NOOP_HOST);
		terminal.start({ deferInput: true });
		// Starting hides the hardware cursor (the renderer parks it hidden);
		// show it so the first hide below is a real change.
		terminal.showCursor(true);
		tty.clear();

		terminal.hideCursor();
		terminal.hideCursor();
		terminal.hideCursor();
		expect(tty.output()).toBe(HIDE);

		terminal.showCursor();
		terminal.showCursor();
		expect(tty.output()).toBe(HIDE + SHOW);

		terminal.showCursor(true);
		terminal.showCursor(true);
		expect(tty.output()).toBe(HIDE + SHOW + SHOW + SHOW);

		terminal.hideCursor();
		terminal.hideCursor(true);
		expect(tty.output()).toBe(HIDE + SHOW + SHOW + SHOW + HIDE + HIDE);
	});
});
