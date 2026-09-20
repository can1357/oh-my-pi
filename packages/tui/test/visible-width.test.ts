/**
 * `visibleWidth` measures terminal column width via `Bun.stringWidth` (a JSC
 * builtin) instead of the native scanner, to keep the render loop off the
 * N-API number-boxing path that traps under Bun 1.3.x GC pressure.
 *
 * Correctness contract: the result MUST equal the native engine's width for the
 * same input, because `truncateToWidth` / `sliceWithWidth` / `wrapTextWithAnsi`
 * cut text using that native model — any divergence makes padding / cursor math
 * (`width - visibleWidth(...)`) drift. This guards the two corrections layered
 * on top of `Bun.stringWidth` (tabs, OSC 66 scaling) and catches silent
 * `Bun.stringWidth` width-table drift across Bun upgrades.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { visibleWidth as nativeVisibleWidth } from "@oh-my-pi/pi-natives";
import {
	DEFAULT_TAB_WIDTH,
	Ellipsis,
	resetHangulCompatibilityJamoWidthForTests,
	setHangulCompatibilityJamoWidth,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui/utils";

const ESC = "\x1b";
const ST = "\x1b\\";
const BEL = "\x07";
const TAB = DEFAULT_TAB_WIDTH;

afterEach(() => {
	resetHangulCompatibilityJamoWidthForTests();
});

describe("visibleWidth — parity with the native width engine", () => {
	const corpus: [string, string][] = [
		["empty", ""],
		["ascii", "Pending run: passed"],
		["styled", `${ESC}[31mred${ESC}[0m text`],
		["styled-truecolor", `${ESC}[38;2;1;2;3mx${ESC}[0m`],
		["nested-sgr", `${ESC}[1m${ESC}[31mbold${ESC}[0m${ESC}[0m`],
		["osc8-st", `${ESC}]8;;https://x.com${ST}link${ESC}]8;;${ST}`],
		["osc8-bel", `${ESC}]8;;u${BEL}t${ESC}]8;;${BEL}`],
		["cjk", "日本語のテキスト"],
		["cjk-mixed", "abc中文def"],
		["hangul-syllables", "안녕하세요"],
		["compat-jamo", "ㅁㄴㅇㅂ"],
		["compat-jamo-filler", "ㅁ\u3164ㅁ"],
		["styled-cjk", `${ESC}[1m漢字${ESC}[0m`],
		["emoji", "👍 done"],
		["emoji-zwj", "👨‍👩‍👧‍👦"],
		["emoji-flag", "🇯🇵"],
		["styled-zwj", `${ESC}[31m👨‍👩‍👧‍👦${ESC}[0m`],
		["variation-selector", "▶️"],
		["combining", "e\u0301"],
		["ambiguous", "§±×→①②③"],
		["box-drawing", "─│┌┐└┘"],
		["fullwidth", "１２３"],
		["halfwidth-kana", "ｱｲｳ"],
		["rtl-arabic", "مرحبا"],
		["thai", "สวัสดี"],
		["tabs", "name\tvalue\tstatus"],
		["leading-tabs", "\t\tindented"],
		["osc66-scale", `${ESC}]66;s=2;big${ST}`],
		["osc66-explicit-w", `${ESC}]66;w=5;Hi${BEL}`],
		["osc66-scale-and-w", `${ESC}]66;s=3:w=4;X${ST}`],
		["osc66-cjk", `${ESC}]66;s=2;日本${ST}`],
		["osc66-inline", `pre ${ESC}]66;s=2;AB${ST} post`],
		["osc66-multi", `${ESC}]66;s=2;A${ST} ${ESC}]66;s=3;B${ST}`],
		["osc66-with-tabs", `\t${ESC}]66;s=2;X${ST}\t`],
		["apc-st", `${ESC}_Ga=p,U=1,q=2,i=123,p=123,c=9,r=4${ST}ab`],
		["apc-bel", `x${ESC}_marker${BEL}y`],
		["apc-multi", `${ESC}_Ga=p,i=1${ST}a${ESC}_Ga=p,i=2${ST}b`],
	];
	for (const [name, input] of corpus) {
		it(name, () => {
			expect(visibleWidth(input)).toBe(nativeVisibleWidth(input, TAB));
		});
	}

	it("strips ANSI (styled text measures as its plain content)", () => {
		expect(visibleWidth(`${ESC}[31mhello${ESC}[0m`)).toBe(5);
	});

	it("expands each tab to the configured tab width", () => {
		expect(visibleWidth("a\tb")).toBe(2 + TAB);
		expect(visibleWidth("\t\t")).toBe(2 * TAB);
	});

	it("scales OSC 66 text-sizing payloads by `s=`", () => {
		expect(visibleWidth(`${ESC}]66;s=2;big${ST}`)).toBe(6); // 2 * width("big")
		expect(visibleWidth(`${ESC}]66;w=5;Hi${BEL}`)).toBe(5); // explicit width, scale 1
		expect(visibleWidth(`${ESC}]66;s=3:w=4;X${ST}`)).toBe(12); // 3 * 4
	});

	it("measures APC payloads as zero cells (Kitty placement prefix on placeholder rows)", () => {
		// Regression: `Bun.stringWidth` counts APC payloads as printable, which
		// broke centering math for Unicode-placeholder thumbnail rows — the
		// composer attachment chip painted its right border inside the card.
		const cells = "\u{10eeee}\u0305\u030d".repeat(9);
		const line = `${ESC}_Ga=p,U=1,q=2,i=123,p=123,c=9,r=4${ST}${ESC}[38;2;1;2;3m${cells}${ESC}[39m`;
		expect(visibleWidth(line)).toBe(9);
	});
});

describe("visibleWidth — runtime Hangul Compatibility Jamo profile", () => {
	// `Bun.stringWidth` reports Compatibility Jamo (U+3131..U+318E) at 2 cells,
	// but the real width is terminal-dependent and detected at runtime. The
	// profile pushed by the probe must steer `visibleWidth` (and the native
	// width engine) so the hardware cursor and truncation math stay aligned.
	it("forces jamo narrow or wide independent of the OS default", () => {
		setHangulCompatibilityJamoWidth(1);
		expect(visibleWidth("ㅁㄴㅇㅂ")).toBe(4);

		setHangulCompatibilityJamoWidth(2);
		expect(visibleWidth("ㅁㄴㅇㅂ")).toBe(8);
	});

	it("opts back into Unicode width for compatibility jamo", () => {
		setHangulCompatibilityJamoWidth("unicode");
		expect(visibleWidth("ㅁ")).toBe(2);
		expect(visibleWidth("\u3164")).toBe(0);
	});

	it("never widens the zero-width filler (U+3164) past the narrow correction", () => {
		// The probe only measures a visible jamo (ㅁ). The invisible filler must
		// not inherit a wide (2-cell) probe result — a wide terminal renders it
		// at its Unicode width (0). Otherwise IME empty-syllable placeholders
		// overcount the cursor/truncation math by 2 cells.
		setHangulCompatibilityJamoWidth(2);
		expect(visibleWidth("ㅁ")).toBe(2);
		expect(visibleWidth("\u3164")).toBe(0);
		expect(visibleWidth("ㅁ\u3164ㅁ")).toBe(4);

		// The narrow correction (1 cell) still applies to the filler.
		setHangulCompatibilityJamoWidth(1);
		expect(visibleWidth("\u3164")).toBe(1);
	});

	it("leaves composed Hangul syllables at 2 cells under any profile", () => {
		setHangulCompatibilityJamoWidth(1);
		expect(visibleWidth("안녕")).toBe(4);

		setHangulCompatibilityJamoWidth(2);
		expect(visibleWidth("안녕")).toBe(4);
	});

	it("stays in parity with the native width engine under each profile", () => {
		const input = "ㅁㄴㅇㅂㅈ\u3164";
		for (const profile of [1, 2, "unicode"] as const) {
			setHangulCompatibilityJamoWidth(profile);
			expect(visibleWidth(input)).toBe(nativeVisibleWidth(input, TAB));
		}
	});
});

describe("native text helpers — runtime Hangul Compatibility Jamo profile", () => {
	it("sliceWithWidth and truncateToWidth follow the jamo width profile", () => {
		const input = "ㅁ".repeat(8);

		setHangulCompatibilityJamoWidth(2);
		expect(sliceWithWidth(input, 0, 16, true)).toEqual({ text: input, width: 16 });
		expect(truncateToWidth("ㅁ".repeat(20), 16, Ellipsis.Omit)).toBe(input);

		setHangulCompatibilityJamoWidth(1);
		expect(sliceWithWidth(input, 0, 8, true)).toEqual({ text: input, width: 8 });
		expect(truncateToWidth("ㅁ".repeat(20), 8, Ellipsis.Omit)).toBe(input);
	});
});
