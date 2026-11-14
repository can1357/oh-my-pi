import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Contract: on a terminal without synchronized output (Terminal.app ignores
 * DEC 2026), any prefix of a frame's bytes can be on screen. A streaming
 * viewport shift must never show a row twice, and a history push must never
 * blank the live chrome before repainting it.
 */
withoutTerminalMultiplexer();

const COLUMNS = 24;
const ROWS = 8;
const CURSOR_POSITION = /\x1b\[\d+;\d+H/g;

class Provider implements TerminalFrameProvider {
	constructor(public plan: TerminalFramePlan) {}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return this.plan;
	}

	renderResizeFrame(): readonly string[] {
		return this.plan.viewport;
	}

	acknowledgeHistory(): void {
		this.plan = { viewport: this.plan.viewport };
	}
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const scheduler = {
	now: () => 0,
	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
	},
	scheduleRender(callback: () => void) {
		callback();
		return { cancel() {} };
	},
};

function visible(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map(row => row.trimEnd());
}

/** Every screen the terminal can show while parsing `frame`: one per cursor-addressed step. */
function intermediateScreens(earlier: readonly string[], frame: string): string[][] {
	const shadow = new VirtualTerminal(COLUMNS, ROWS);
	for (const write of earlier) shadow.write(write);
	const screens: string[][] = [];
	let from = 0;
	for (const match of frame.matchAll(CURSOR_POSITION)) {
		shadow.write(frame.slice(from, match.index));
		from = match.index;
		screens.push(visible(shadow));
	}
	shadow.write(frame.slice(from));
	screens.push(visible(shadow));
	return screens;
}

function duplicatedRows(screen: readonly string[]): string[] {
	const seen = new Set<string>();
	return screen.filter(row => row !== "" && (seen.has(row) || !seen.add(row)));
}

/**
 * Paint `first`, then `next`; returns the screens shown while `next` was
 * written, and the screen and scrollback it left.
 */
function paint(
	first: TerminalFramePlan,
	next: TerminalFramePlan,
): { screens: string[][]; screen: string[]; scrollback: string[] } {
	const terminal = new RecordingTerminal(COLUMNS, ROWS);
	const provider = new Provider(first);
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	try {
		expect(tui.synchronizedOutput).toBe(false);
		tui.setFrameProvider(provider);
		const earlier = terminal.writes.length;
		provider.plan = next;
		tui.requestRender();
		const frame = terminal.writes.slice(earlier).join("");
		const baseY = terminal.getBufferPosition().baseY;
		return {
			screens: intermediateScreens(terminal.writes.slice(0, earlier), frame),
			screen: visible(terminal),
			scrollback: terminal
				.getScrollBuffer()
				.slice(0, baseY)
				.map(row => row.trimEnd()),
		};
	} finally {
		tui.stop();
	}
}

const rows = (prefix: string, from: number, to: number): string[] =>
	Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

describe("unsynchronized frames", () => {
	let previous: string | undefined;
	beforeEach(() => {
		previous = Bun.env.PI_NO_SYNC_OUTPUT;
		Bun.env.PI_NO_SYNC_OUTPUT = "1";
	});
	afterEach(() => {
		if (previous === undefined) delete Bun.env.PI_NO_SYNC_OUTPUT;
		else Bun.env.PI_NO_SYNC_OUTPUT = previous;
	});

	it("never shows a row twice while a full viewport's content scrolls under fixed chrome", () => {
		// A streaming block taller than the screen shows its newest rows: each frame
		// shifts every content row up while the status and editor rows stay put.
		const { screens, screen } = paint(
			{ viewport: [...rows("line ", 1, 6), "status", "editor"] },
			{ viewport: [...rows("line ", 4, 9), "status", "editor"] },
		);

		for (const shown of screens) expect(duplicatedRows(shown)).toEqual([]);
		expect(screen).toEqual([...rows("line ", 4, 9), "status", "editor"]);
	});

	for (const { name, first, history } of [
		{
			name: "rows already on screen",
			first: [...rows("a", 1, 6), "status", "editor"],
			history: rows("a", 1, 3),
		},
		{
			name: "rows scrolled out of a clipped viewport",
			first: [...rows("a", 4, 9), "status", "editor"],
			history: rows("a", 1, 5),
		},
	]) {
		it(`keeps the chrome visible and scrollback exact when pushing ${name}`, () => {
			const tail = rows("a", Number(history.at(-1)!.slice(1)) + 1, 12).slice(0, 6);
			const { screens, screen, scrollback } = paint(
				{ viewport: first },
				{ history: { id: 1, rows: history }, viewport: [...tail, "status", "editor"] },
			);

			for (const shown of screens) {
				expect(shown).toContain("status");
				expect(duplicatedRows(shown)).toEqual([]);
			}
			expect(scrollback).toEqual(history);
			expect(screen).toEqual([...tail, "status", "editor"]);
		});
	}
});
