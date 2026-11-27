import { describe, expect, it } from "bun:test";
import { scheduler } from "node:timers/promises";
import { jsx } from "@oh-my-pi/pi-tui/element";
import type { UiNode } from "@oh-my-pi/pi-tui/node";
import { createOwnedPaint, paintForMeasurement, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { builtinThemes, createTheme } from "@oh-my-pi/pi-tui/theme/index";
import { FullscreenTranscript } from "../src/term/fullscreen";
import "../src/term/painters";
import { type Cell, cellRow } from "../src/testing/cells";

const theme = createTheme(builtinThemes().dark!);

/** Real layout, measurement, window paint and selection; the test chooses when to present the next frame. */
function reader(main: readonly UiNode[], width: number, height: number) {
	const env = staticEnvironment(theme);
	const owned: UiNode[] = [];
	const measured: UiNode[] = [];
	const copies: string[] = [];
	let active = true;
	const transcript = new FullscreenTranscript({
		theme: () => theme,
		active: () => active,
		cellHeight: () => 16,
		requestRender: () => {},
		paint(node, columns) {
			owned.push(node);
			return createOwnedPaint(node, columns, env);
		},
		measure(node, columns) {
			measured.push(node);
			return paintForMeasurement(node, columns, env);
		},
		separator: () => 0,
		copyOnRelease: () => false,
		copyText: async text => {
			copies.push(text);
			return "success";
		},
	});
	const frame = (columns = width) => {
		const { rows } = transcript.compose(main, columns + 2, height + 1, height + 1, false);
		transcript.publish();
		return rows.slice(0, height).map(row => cellRow(row).slice(0, columns));
	};
	frame();
	return {
		transcript,
		scroll: transcript.scroller,
		copies,
		owned,
		measured,
		frame,
		inline() {
			active = false;
			transcript.leave();
		},
	};
}

/** Rows of marked text, not the escape sequence spelling or number of style wrappers. */
function marks(frame: readonly (readonly Cell[])[]): string[] {
	return frame.map(row =>
		row
			.filter(cell => cell.underline)
			.map(cell => cell.ch)
			.join(""),
	);
}

describe("fullscreen transcript find", () => {
	it("starts at the reading row and wraps both ways through repeated literal matches on the same line", async () => {
		const main = [
			jsx("rows", { lines: ["A.B in older text", "one", "two", "-- a.b A.B", "four", "tail a.b"] }) as UiNode,
		];
		const t = reader(main, 20, 2);
		try {
			const { scroll } = t;
			expect(scroll.scrollBy(-1)).toBe(true);
			t.frame();
			expect(scroll.state().offset).toBe(3);
			for (const [direction, row, start] of [
				[1, 3, 3],
				[1, 3, 7],
				[1, 4, 5],
				[1, 0, 0],
				[-1, 4, 5],
				[-1, 3, 7],
				[-1, 3, 3],
			] as const) {
				expect(await scroll.findText("a.b", direction)).toBe(true);
				const frame = t.frame();
				expect(scroll.state().offset).toBe(row);
				const match = frame[row === 4 ? 1 : 0]!;
				expect(match.flatMap((cell, col) => (cell.underline ? [col] : []))).toEqual([start, start + 1, start + 2]);
			}
			expect(await scroll.findText("a*b", 1)).toBe(false);
			expect(marks(t.frame())).toEqual(["", ""]);
			expect(scroll.state().offset).toBe(3);
			expect(await scroll.findText("", -1)).toBe(false);
		} finally {
			t.transcript.stop();
		}
	});

	it("starts inside the current soft-wrapped line in both directions and keeps overlapping matches reachable", async () => {
		const t = reader([jsx("text", { text: "aAaAaAaAa" }) as UiNode], 3, 1);
		try {
			expect(t.scroll.scrollBy(-1)).toBe(true);
			t.frame();
			expect(t.scroll.state().offset).toBe(1);
			expect(await t.scroll.findText("aa", 1)).toBe(true);
			expect(t.frame()[0]!.findIndex(cell => cell.underline > 0)).toBe(0);
			expect(await t.scroll.findText("aa", 1)).toBe(true);
			expect(t.frame()[0]!.findIndex(cell => cell.underline > 0)).toBe(1);
			expect(await t.scroll.findText("aa", -1)).toBe(true);
			expect(t.frame()[0]!.findIndex(cell => cell.underline > 0)).toBe(0);
			expect(t.scroll.state().offset).toBe(1);
			t.scroll.clearFind();
			expect(await t.scroll.findText("aa", -1)).toBe(true);
			expect(t.frame()[0]!.findIndex(cell => cell.underline > 0)).toBe(2);
			expect(t.scroll.state().offset).toBe(1);
		} finally {
			t.transcript.stop();
		}
	});

	it("highlights across soft wraps in source coordinates, not across hard breaks or through chrome", async () => {
		const main = [
			jsx("rule", {}),
			jsx("text", { text: "head ALPHA beta tail" }),
			jsx("text", { text: "abc\ndef" }),
			jsx("rows", { lines: ["other", "tail", "last"] }),
		] as UiNode[];
		const t = reader(main, 8, 2);
		try {
			expect(await t.scroll.findText("PhA Be", -1)).toBe(true);
			expect(marks(t.frame())).toEqual(["PHA", "be"]);
			expect(marks(t.frame(16)).join("")).toBe("PHA be");
			const spot = t.scroll.state().offset;
			for (const absent of ["abc def", "──"]) {
				expect(await t.scroll.findText(absent, 1)).toBe(false);
				expect(marks(t.frame(16))).toEqual(["", ""]);
				expect(t.scroll.state().offset).toBe(spot);
			}
		} finally {
			t.transcript.stop();
		}
	});

	it("layers a themed match over colored and wide glyphs without changing the selection or copied text", async () => {
		const main = [jsx("text", { text: "a界\x1b[31mBE\x1b[0mta!" }) as UiNode];
		const t = reader(main, 14, 2);
		try {
			const pointer = (action: "press" | "release", col: number) =>
				t.transcript.mouse({ row: 0, col, action, button: "left", mods: [] }, 0, false, () => false);
			pointer("press", 3);
			pointer("release", 4);
			expect(await t.scroll.findText("界beta", 1)).toBe(true);
			const row = t.frame()[0]!;
			const background = cellRow(theme.bg("selectedBg", "x"))[0]!.bg;
			expect(row.slice(1, 7).every(cell => cell.underline && cell.bg === background)).toBe(true);
			expect(row.flatMap((cell, col) => (cell.inverse ? [col] : []))).toEqual([3, 4]);
			expect(row[3]!.fg).toBe("p1");
			expect(row[7]!.underline).toBe(0);
			t.scroll.clearFind();
			const cleared = t.frame()[0]!;
			expect(cleared.some(cell => cell.underline)).toBe(false);
			expect(cleared.flatMap((cell, col) => (cell.inverse ? [col] : []))).toEqual([3, 4]);
			expect(t.scroll.copyHighlight()).toBe(true);
			expect(t.copies).toEqual(["BE"]);
		} finally {
			t.transcript.stop();
		}
	});

	it("yields during a cold scan, owns no offscreen paints and ignores superseded, closed or hidden finds", async () => {
		const main = Array.from({ length: 300 }, (_, i) => jsx("rows", { lines: [`entry ${i}`] }) as UiNode);
		const t = reader(main, 18, 3);
		try {
			const { scroll } = t;
			expect(scroll.state().offset).toBe(297);
			const owned = t.owned.length;
			const measured = t.measured.length;
			const old = scroll.findText("entry 250", 1);
			expect(t.measured.length).toBe(measured);
			await scheduler.yield();
			expect(t.measured.length - measured).toBeGreaterThan(0);
			expect(t.measured.length - measured).toBeLessThan(50);
			const next = scroll.findText("entry 17", 1);
			expect(await old).toBe(false);
			expect(await next).toBe(true);
			expect(t.owned).toHaveLength(owned);
			expect(marks(t.frame())).toEqual(["entry 17", "", ""]);
			expect(scroll.state().offset).toBe(17);
			const closed = scroll.findText("entry 250", 1);
			scroll.clearFind();
			expect(await closed).toBe(false);
			expect(marks(t.frame())).toEqual(["", "", ""]);
			expect(scroll.state().offset).toBe(17);
			const covered = scroll.findText("entry 250", 1);
			t.transcript.hide();
			t.frame(); // Even a layer closed before the next slice must cancel that search.
			expect(await covered).toBe(false);
			expect(scroll.state().offset).toBe(17);
			const switched = scroll.findText("entry 250", 1);
			t.inline();
			expect(await switched).toBe(false);
			expect(await scroll.findText("entry 250", 1)).toBe(false);
		} finally {
			t.transcript.stop();
		}
	});

	it("does not navigate or advertise a hit after stop, even if the configured presentation is still fullscreen", async () => {
		const main = [jsx("text", { text: "target" }), jsx("text", { text: "tail" })] as UiNode[];
		const t = reader(main, 12, 1);
		const before = t.scroll.state();
		const pending = t.scroll.findText("target", -1);
		t.transcript.stop();
		expect(await pending).toBe(false);
		expect(await t.scroll.findText("target", -1)).toBe(false);
		expect(t.scroll.state()).toBe(before);
	});
});
