/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { createTestTerminal, type TestTerminal, type TestTerminalOptions } from "@oh-my-pi/pi-tui/testing/terminal";
import { TranscriptWheel } from "../../src/term/transcript-wheel";

let term: TestTerminal;
let copied: string[];

function mount(lines: readonly string[], options: TestTerminalOptions = {}) {
	copied = [];
	const layer = signal(false);
	term = createTestTerminal(
		() => ({
			main: <rows lines={lines} />,
			dock: <rows lines={["draft"]} />,
			layer: () =>
				layer() ? (
					<overlay modal>
						<rows lines={["dialog"]} />
					</overlay>
				) : undefined,
		}),
		{ columns: 20, rows: 6, screen: () => "fullscreen", copySelection: text => copied.push(text), ...options },
	);
	return layer;
}

function mouse(
	action: MouseEvent["action"],
	row: number,
	col: number,
	button: MouseEvent["button"] = "left",
	mods: MouseEvent["mods"] = [],
): void {
	term.mouse({ action, row, col, button, mods });
}

function click(row: number, col: number): void {
	mouse("press", row, col);
	mouse("release", row, col);
}

const many = Array.from({ length: 20 }, (_, i) => `line ${i}`);

afterEach(() => {
	term?.dispose();
	vi.useRealTimers();
});

describe("fullscreen transcript pointer", () => {
	it("reverse-drags complete graphemes across styled/link boundaries and copies only plain selected rows", () => {
		const link = "\x1b]8;;https://example.test\x1b\\";
		mount([`A${link}👩‍💻\x1b]8;;\x1b\\Z`, "\x1b[33m中é.\x1b[0m"]);
		mouse("press", 1, 2);
		mouse("drag", 0, 2); // the second cell of the ZWJ grapheme
		expect(term.rows()[0]).toContain("\x1b[7m👩‍💻\x1b[27m");
		expect(copied).toEqual([]);
		mouse("release", 0, 2, "none");
		expect(copied).toEqual(["👩‍💻Z\n中é"]);
		expect(term.backend.copySelection()).toBe(true);
		expect(copied.at(-1)).toBe("👩‍💻Z\n中é");
	});

	it("treats repeated clicks on a path as word then row, and a timed-out single click as no selection", () => {
		mount(["see src/a-b.ts now"]);
		click(0, 6);
		click(0, 9); // same path, different physical cell
		click(0, 8);
		expect(copied).toEqual(["src/a-b.ts", "see src/a-b.ts now"]);
		term.tick(501);
		click(0, 9);
		expect(term.backend.copySelection()).toBe(false);
	});

	it("keeps the press word when a double-click drag reverses across it", () => {
		mount(["one two three"], { copyOnSelect: () => false });
		click(0, 5);
		mouse("press", 0, 6);
		mouse("drag", 0, 10);
		mouse("release", 0, 1);
		expect(copied).toEqual([]);
		expect(term.backend.copySelection()).toBe(true);
		expect(copied).toEqual(["one two"]);
	});

	it("moves the selection end by grapheme, line edge and preferred column without moving its anchor", () => {
		mount(["a中bc", "éfg"], { copyOnSelect: () => false });
		expect(term.backend.extendSelection("up")).toBe(false);
		mouse("press", 0, 1);
		mouse("release", 0, 2);
		term.backend.extendSelection("right");
		term.backend.copySelection();
		term.backend.extendSelection("down");
		term.backend.copySelection();
		term.backend.extendSelection("up");
		term.backend.extendSelection("line-start");
		term.backend.copySelection();
		term.backend.extendSelection("line-end");
		term.backend.copySelection();
		expect(copied).toEqual(["中b", "中bc\néfg", "a", "中bc"]);
		expect(term.backend.extendSelection("clear")).toBe(true);
		expect(term.backend.copySelection()).toBe(false);
	});

	it("never copies or adjusts through a modal or after a lost release; width changes invalidate stale endpoints", () => {
		const layer = mount(["transcript"], { copyOnSelect: () => false });
		mouse("press", 0, 0);
		mouse("drag", 0, 4);
		layer.set(true);
		expect(term.backend.copySelection()).toBe(false); // even before the modal paints
		expect(term.backend.extendSelection("right")).toBe(false);
		mouse("release", 0, 5);
		layer.set(false);
		term.render();
		expect(term.backend.copySelection()).toBe(false);
		mouse("press", 0, 0);
		mouse("drag", 0, 2);
		term.backend.dispatch({ type: "focus", focused: false });
		mouse("release", 0, 5);
		expect(term.backend.copySelection()).toBe(false);
		term.backend.dispatch({ type: "focus", focused: true });
		mouse("press", 0, 0);
		mouse("release", 0, 5);
		term.resize(15, 6);
		expect(term.backend.copySelection()).toBe(false);
	});

	it("retains a completed selection across focus changes but never copies replacement content or captures inline input", () => {
		const lines = signal(["old text"]);
		const screen = signal<"fullscreen" | "inline">("fullscreen");
		const clipboard: string[] = [];
		term = createTestTerminal(() => ({ main: <rows lines={lines} /> }), {
			columns: 20,
			rows: 4,
			screen,
			copyOnSelect: () => false,
			copySelection: text => clipboard.push(text),
		});
		mouse("press", 0, 0);
		mouse("release", 0, 2);
		term.backend.dispatch({ type: "focus", focused: false });
		expect(term.backend.copySelection()).toBe(false);
		term.backend.dispatch({ type: "focus", focused: true });
		expect(term.backend.copySelection()).toBe(true);
		lines.set(["new text"]); // The selection is still painted, but no longer denotes this text.
		expect(term.backend.copySelection()).toBe(false);
		screen.set("inline");
		term.render();
		mouse("press", 0, 0);
		mouse("release", 0, 2);
		expect(term.backend.copySelection()).toBe(false);
		expect(clipboard).toEqual(["old"]);
	});

	it("extends a held drag offscreen, including hidden document rows but excluding the dock, then stops", () => {
		vi.useFakeTimers();
		mount(many);
		term.backend.scroll("start");
		term.render();
		mouse("press", 1, 0);
		mouse("drag", 5, 8);
		vi.advanceTimersByTime(51);
		term.render();
		expect(term.screen()[0]).toStartWith("line 1 ");
		mouse("release", 5, 8);
		expect(copied).toEqual(["line 1\nline 2\nline 3\nline 4\nline 5"]);
		const stopped = term.screen();
		vi.advanceTimersByTime(200);
		term.render();
		expect(term.screen()).toEqual(stopped);
	});

	it("maps a track click and a captured drag outside the gutter to absolute positions and resumes following at the bottom", () => {
		mount(many);
		expect(term.screen()[4]).toEndWith("┃");
		mouse("press", 0, 19);
		expect(term.screen()[0]).toStartWith("line 0 ");
		expect(term.screen()[0]).toEndWith("█");
		mouse("drag", 3, 2);
		expect(term.screen()[0]).toStartWith("line 11 ");
		mouse("release", 5, 2);
		expect(term.backend.following).toBe(true);
		expect(term.screen()[4]).toEndWith("┃");
		expect(copied).toEqual([]);
	});

	it("routes the wheel over the dock, supports Alt ×5 and a fixed live override without spending a transcript row on a redundant indicator", () => {
		const fixed = signal(0);
		mount(many, { wheelLines: fixed });
		mouse("press", 5, 0, "wheel-up");
		expect(term.screen()[0]).toStartWith("line 14 ");
		mouse("press", 5, 0, "wheel-up", ["alt"]);
		expect(term.screen()[0]).toStartWith("line 9 ");
		fixed.set(3);
		mouse("press", 5, 0, "wheel-up");
		expect(term.screen()[0]).toStartWith("line 6 ");
		expect(term.screen()[4]).toStartWith("line 10 ");
		click(4, 1);
		expect(term.backend.following).toBe(false);
	});

	it("accelerates discrete notches, not sub-5ms bursts or the first event after reversing direction", () => {
		const wheel = new TranscriptWheel(true);
		expect([0, 50, 52, 72, 400].map(t => wheel.lines(-1, t, 0))).toEqual([1, 2, 1, 2, 1]);
		expect(wheel.lines(1, 420, 0)).toBe(1);
	});

	it("copies the visible OSC 66 payload rather than the terminal sequence or its hyperlink target", () => {
		mount(["A\x1b]66;s=2;Hi\x1b\\Z", ""]);
		mouse("press", 0, 2);
		mouse("release", 0, 5);
		expect(copied).toEqual(["HiZ"]);
	});
});
