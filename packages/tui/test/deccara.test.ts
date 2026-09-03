import { describe, expect, it } from "bun:test";
import {
	analyzeBgFillLine,
	DECSACE_DEFAULT,
	DECSACE_RECT,
	detectRectangularSgrSupport,
	encodeDeccara,
	planDeccaraFills,
} from "@oh-my-pi/pi-tui";

// Truecolor background open token used throughout the integration tests.
const BG_OPEN = "\x1b[48;2;10;20;30m";
const BG_SGR = "48;2;10;20;30";

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return count;
		count++;
		from = at + needle.length;
	}
}

describe("detectRectangularSgrSupport", () => {
	it("enables only kitty, which implements the SGR-background extension", () => {
		expect(detectRectangularSgrSupport("kitty", {})).toBe(true);
		// Ghostty leaves CSI $r unimplemented (ghostty-org/ghostty#632) — excluded.
		expect(detectRectangularSgrSupport("ghostty", {})).toBe(false);
		expect(detectRectangularSgrSupport("wezterm", {})).toBe(false);
		expect(detectRectangularSgrSupport("iterm2", {})).toBe(false);
		expect(detectRectangularSgrSupport("alacritty", {})).toBe(false);
		expect(detectRectangularSgrSupport("base", {})).toBe(false);
		expect(detectRectangularSgrSupport("trueColor", {})).toBe(false);
	});

	it("honors the PI_NO_DECCARA kill switch (truthy values only)", () => {
		expect(detectRectangularSgrSupport("kitty", { PI_NO_DECCARA: "1" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { PI_NO_DECCARA: "true" })).toBe(false);
		// A falsey assignment is not a kill: support stays on.
		expect(detectRectangularSgrSupport("kitty", { PI_NO_DECCARA: "0" })).toBe(true);
		expect(detectRectangularSgrSupport("kitty", { PI_NO_DECCARA: "false" })).toBe(true);
	});

	it("disables under tmux/screen/zellij/cmux multiplexers", () => {
		expect(detectRectangularSgrSupport("kitty", { TMUX: "/tmp/tmux-1000/default,123,0" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { STY: "1234.pts-0" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { ZELLIJ: "0" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { CMUX_SURFACE_ID: "surface" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { TERM: "tmux-256color" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { TERM: "screen.xterm" })).toBe(false);
	});
});

describe("encodeDeccara", () => {
	it("emits the 1-based inclusive DECCARA rectangle form", () => {
		expect(encodeDeccara(1, 1, 4, 40, BG_SGR)).toBe(`\x1b[1;1;4;40;${BG_SGR}$r`);
	});

	it("matches kitty's documented background-fill example", () => {
		// kitty docs/deccara.rst: blue (44) bg over rows 4..11, cols 3..10.
		expect(`${DECSACE_RECT}${encodeDeccara(4, 3, 11, 10, "44")}${DECSACE_DEFAULT}`).toBe(
			"\x1b[2*x\x1b[4;3;11;10;44$r\x1b[*x",
		);
	});
});

describe("analyzeBgFillLine", () => {
	const close = "\x1b[49m\x1b[0m";

	it("treats an all-space background row as a whole-row fill", () => {
		const line = `${BG_OPEN}${" ".repeat(10)}${close}`;
		expect(analyzeBgFillLine(line, 10)).toEqual({ cut: 0, leftCol: 0, bg: BG_SGR });
	});

	it("locates the trailing pad after content under a single background", () => {
		const line = `\x1b[48;5;4mHi${" ".repeat(8)}${close}`;
		const result = analyzeBgFillLine(line, 10);
		expect(result?.leftCol).toBe(2);
		expect(result?.bg).toBe("48;5;4");
		// Cut sits right after "Hi" so the prefix re-closes to a clean reset.
		expect(line.slice(0, result?.cut)).toBe("\x1b[48;5;4mHi");
	});

	it("recognizes 16-color and bright background params", () => {
		expect(analyzeBgFillLine(`\x1b[41m${" ".repeat(6)}${close}`, 6)?.bg).toBe("41");
		expect(analyzeBgFillLine(`\x1b[101m${" ".repeat(6)}${close}`, 6)?.bg).toBe("101");
	});

	it("rejects rows with no trailing padding", () => {
		const line = `${BG_OPEN}${"x".repeat(10)}${close}`;
		expect(analyzeBgFillLine(line, 10)).toBeNull();
	});

	it("rejects default-background trailing spaces (nothing to paint)", () => {
		expect(analyzeBgFillLine(`hello${" ".repeat(5)}`, 10)).toBeNull();
	});

	it("rejects colored trailing fills after default-background gap cells", () => {
		expect(analyzeBgFillLine(`${" ".repeat(2)}${BG_OPEN}${" ".repeat(8)}${close}`, 10)).toBeNull();
		expect(analyzeBgFillLine(`X ${BG_OPEN}${" ".repeat(8)}${close}`, 10)).toBeNull();
	});

	it("allows a colored trailing fill that starts immediately after default content", () => {
		expect(analyzeBgFillLine(`X${BG_OPEN}${" ".repeat(9)}${close}`, 10)).toEqual({
			cut: 1,
			leftCol: 1,
			bg: BG_SGR,
		});
	});

	it("rejects rows narrower than the full width", () => {
		const line = `\x1b[41mab${" ".repeat(3)}${close}`;
		expect(analyzeBgFillLine(line, 10)).toBeNull();
	});

	it("rejects colon-form extended background it cannot reason about", () => {
		const line = `\x1b[48:2:1:2:3m${" ".repeat(5)}${close}`;
		expect(analyzeBgFillLine(line, 5)).toBeNull();
	});

	it("rejects lines carrying OSC sequences (hyperlinks/images)", () => {
		const line = `\x1b[41m\x1b]8;;https://x\x07L\x1b]8;;\x07${" ".repeat(8)}${close}`;
		expect(analyzeBgFillLine(line, 10)).toBeNull();
	});

	it("rejects a background change inside the trailing region", () => {
		// "ab" then default-bg spaces then a different bg — not a single span.
		const line = `\x1b[41mab\x1b[49m   \x1b[42m   \x1b[49m\x1b[0m`;
		expect(analyzeBgFillLine(line, 8)).toBeNull();
	});
});

describe("planDeccaraFills", () => {
	const blank = (width: number, bgOpen = BG_OPEN) => `${bgOpen}${" ".repeat(width)}\x1b[49m\x1b[0m`;

	it("coalesces adjacent identical fills into one rectangle and blanks the rows", () => {
		const lines = [blank(10), blank(10), blank(10)];
		const plan = planDeccaraFills(lines, 10);
		expect(plan.texts).toEqual(["", "", ""]);
		expect(plan.sequence).toBe(`${DECSACE_RECT}${encodeDeccara(1, 1, 3, 10, BG_SGR)}${DECSACE_DEFAULT}`);
	});

	it("respects the screen-row offset for top/bottom coordinates", () => {
		const lines = [blank(10), blank(10)];
		const plan = planDeccaraFills(lines, 10, 3);
		expect(plan.sequence).toBe(`${DECSACE_RECT}${encodeDeccara(4, 1, 5, 10, BG_SGR)}${DECSACE_DEFAULT}`);
	});

	it("splits coalescing when the background differs", () => {
		const other = "\x1b[42m";
		const lines = [blank(8), blank(8), blank(8, other)];
		const plan = planDeccaraFills(lines, 8);
		expect(plan.sequence).toBe(
			`${DECSACE_RECT}${encodeDeccara(1, 1, 2, 8, BG_SGR)}${encodeDeccara(3, 1, 3, 8, "42")}${DECSACE_DEFAULT}`,
		);
	});

	it("does not coalesce non-adjacent fills separated by a non-fill row", () => {
		const lines = [blank(12), "plain text row padded out here", blank(12)];
		const plan = planDeccaraFills(lines, 12);
		// Two rectangles: one per blank row, the middle untouched.
		expect(countOccurrences(plan.sequence, "$r")).toBe(2);
		expect(plan.texts[1]).toBe(lines[1]);
	});

	it("keeps the original line when the rectangle would not save bytes", () => {
		// Width 20, content fills 18 cells, only 2 trailing pad spaces — not worth it.
		const line = `${BG_OPEN}${"x".repeat(18)}  \x1b[49m\x1b[0m`;
		const plan = planDeccaraFills([line], 20);
		expect(plan.texts).toEqual([line]);
		expect(plan.sequence).toBe("");
	});

	it("optimizes a content row with substantial trailing padding", () => {
		const line = `${BG_OPEN}Hi${" ".repeat(38)}\x1b[49m\x1b[0m`;
		const plan = planDeccaraFills([line], 40);
		expect(plan.texts[0]).toBe(`${BG_OPEN}Hi\x1b[0m`);
		expect(plan.sequence).toBe(`${DECSACE_RECT}${encodeDeccara(1, 3, 1, 40, BG_SGR)}${DECSACE_DEFAULT}`);
	});

	it("passes plain rows through untouched with no rectangles", () => {
		const lines = ["hello", "world"];
		const plan = planDeccaraFills(lines, 40);
		expect(plan.texts).toEqual(lines);
		expect(plan.sequence).toBe("");
	});
});
