import { afterEach, describe, expect, it } from "bun:test";
import { visibleWidth as nativeVisibleWidth } from "@oh-my-pi/pi-natives";
import { SgrState, stripEscapes, tokens } from "@oh-my-pi/pi-tui/text/ansi";
import {
	align,
	padTo,
	pieces,
	replaceTabs,
	setJamoWidth,
	sliceCells,
	sliceColumns,
	TAB_WIDTH,
	truncate,
	truncateMiddle,
	truncateStart,
	visibleWidth,
	widthEpoch,
} from "@oh-my-pi/pi-tui/text/width";

const ESC = "\x1b";
const ST = "\x1b\\";
const BEL = "\x07";

afterEach(() => {
	setJamoWidth("platform");
});

describe("visibleWidth — parity with the native width engine", () => {
	const corpus: [string, string][] = [
		["empty", ""],
		["ascii", "Pending run: passed"],
		["styled", `${ESC}[31mred${ESC}[0m text`],
		["styled-truecolor", `${ESC}[38;2;1;2;3mx${ESC}[0m`],
		["osc8-st", `${ESC}]8;;https://x.com${ST}link${ESC}]8;;${ST}`],
		["osc8-bel", `${ESC}]8;;u${BEL}t${ESC}]8;;${BEL}`],
		["cjk", "日本語のテキスト"],
		["cjk-mixed", "abc中文def"],
		["hangul-syllables", "안녕하세요"],
		["compat-jamo", "ㅁㄴㅇㅂ"],
		["compat-jamo-filler", "ㅁ\u3164ㅁ"],
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
		["osc66-with-tabs", `\t${ESC}]66;s=2;X${ST}\t`],
		["apc-st", `${ESC}_Ga=p,U=1,q=2,i=123,p=123,c=9,r=4${ST}ab`],
		["apc-bel", `x${ESC}_marker${BEL}y`],
		["apc-multi", `${ESC}_Ga=p,i=1${ST}a${ESC}_Ga=p,i=2${ST}b`],
		["tmux-passthrough", `ab${ESC}Ptmux;${ESC}${ESC}_Ga=T,f=100;AAAA${ESC}${ESC}\\${ST}cd`],
		["vs16", "\u26a0\ufe0f now"],
		["keycap", "0\ufe0f\u20e3"],
	];
	for (const [name, input] of corpus) {
		it(name, () => {
			expect(visibleWidth(input)).toBe(nativeVisibleWidth(input, TAB_WIDTH));
		});
	}

	it("strips escapes, counts tabs and scales OSC 66 spans", () => {
		expect(visibleWidth(`${ESC}[31mhello${ESC}[0m`)).toBe(5);
		expect(visibleWidth("a\tb")).toBe(2 + TAB_WIDTH);
		expect(visibleWidth(`${ESC}]66;s=2;big${ST}`)).toBe(6);
		expect(visibleWidth(`${ESC}]66;w=5;Hi${BEL}`)).toBe(5);
		expect(visibleWidth(`${ESC}]66;s=3:w=4;X${ST}`)).toBe(12);
		expect(visibleWidth(`${ESC}]66;;abc${ST}`)).toBe(3);
	});

	it("measures APC payloads as zero cells (placeholder thumbnail rows)", () => {
		const cells = "\u{10eeee}\u0305\u030d".repeat(9);
		const line = `${ESC}_Ga=p,U=1,q=2,i=123,p=123,c=9,r=4${ST}${ESC}[38;2;1;2;3m${cells}${ESC}[39m`;
		expect(visibleWidth(line)).toBe(9);
	});

	it("keeps Bun width semantics for malformed escapes after a styled prefix", () => {
		for (const suffix of [
			"\x1b",
			"\x1b[",
			"\x1b[31",
			"\x1b[2Ktail",
			"\x1b[38:2::255:0:0mred",
			"界",
			"\r\n",
			"\x7f",
		]) {
			const text = `\x1b[31mASCII\x1b[0m${suffix}`;
			expect(visibleWidth(text)).toBe(
				Bun.stringWidth(text, { countAnsiEscapeCodes: false, ambiguousIsNarrow: true }),
			);
		}
		expect(visibleWidth("\x1b[31mASCII\x1b[0m\x1b_payload\x07")).toBe(5);
		expect(visibleWidth("\x1b[31mASCII\x1b[0m\x1b]66;s=2;Hi\x07")).toBe(9);
	});

	it("draws VS16 emoji presentation wide and bare text-presentation symbols narrow", () => {
		expect(visibleWidth("\u26a0\ufe0f")).toBe(2);
		expect(visibleWidth("\u26a0")).toBe(1);
		expect(visibleWidth("\u2705")).toBe(2);
	});
});

describe("Hangul Compatibility Jamo profile", () => {
	it("forces jamo narrow or wide and keeps syllables wide", () => {
		setJamoWidth(1);
		expect(visibleWidth("ㅁㄴㅇㅂ")).toBe(4);
		expect(visibleWidth("\u3164")).toBe(1);
		expect(visibleWidth("안녕")).toBe(4);
		setJamoWidth(2);
		expect(visibleWidth("ㅁㄴㅇㅂ")).toBe(8);
		expect(visibleWidth("\u3164")).toBe(0);
		expect(visibleWidth("ㅁ\u3164ㅁ")).toBe(4);
		expect(visibleWidth("안녕")).toBe(4);
		setJamoWidth("unicode");
		expect(visibleWidth("ㅁ")).toBe(2);
		expect(visibleWidth("\u3164")).toBe(0);
	});

	it("stays in parity with the native engine under every profile, slicing included", () => {
		const input = "ㅁㄴㅇㅂㅈ\u3164";
		for (const profile of [1, 2, "unicode", "platform"] as const) {
			setJamoWidth(profile);
			expect(visibleWidth(input)).toBe(nativeVisibleWidth(input, TAB_WIDTH));
		}
		setJamoWidth(2);
		expect(sliceCells("ㅁ".repeat(8), 0, 16)).toEqual({ text: "ㅁ".repeat(8), width: 16 });
		expect(truncate("ㅁ".repeat(20), 16, "")).toBe("ㅁ".repeat(8));
		setJamoWidth(1);
		expect(truncate("ㅁ".repeat(20), 8, "")).toBe("ㅁ".repeat(8));
	});

	it("bumps the width epoch only on a change", () => {
		const before = widthEpoch();
		expect(setJamoWidth("platform")).toBe(false);
		expect(widthEpoch()).toBe(before);
		expect(setJamoWidth(2)).toBe(true);
		expect(widthEpoch()).toBe(before + 1);
	});
});

describe("escape tokenizing", () => {
	it("treats a tmux-wrapped DCS and a kitty APC as one zero-width escape each", () => {
		const apc = `${ESC}_Ga=T,f=100;AAAA${ST}`;
		const tmux = `${ESC}Ptmux;${apc.replaceAll(ESC, ESC + ESC)}${ST}`;
		expect(tokens(`a${tmux}b${apc}c`).map(t => [t.text, t.escape])).toEqual([
			["a", false],
			[tmux, true],
			["b", false],
			[apc, true],
			["c", false],
		]);
		expect(pieces(`a${tmux}b`).map(p => [p.text, p.width])).toEqual([
			["a", 1],
			[tmux, 0],
			["b", 1],
		]);
		expect(visibleWidth(`a${tmux}b`)).toBe(2);
		expect(stripEscapes(`a${tmux}b${apc}c`)).toBe("abc");
	});

	it("keeps a tmux-wrapped image escape whole when slicing and truncating its row", () => {
		const tmux = `${ESC}Ptmux;${ESC}${ESC}_Ga=p,i=7${ESC}${ESC}\\${ST}`;
		const row = `ab${tmux}cdefgh`;
		expect(sliceCells(row, 1, 2).text).toBe(`b${tmux}c`);
		expect(truncate(row, 4)).toBe(`ab${tmux}c…`);
		expect(sliceColumns(row, 0, 3)).toBe(`ab${tmux}c`);
	});

	it("leaves incomplete escapes as text", () => {
		expect(tokens("a\x1b[31").every(t => !t.escape)).toBe(true);
		expect(tokens("a\x1b]8;;x").every(t => !t.escape)).toBe(true);
	});
});

describe("slicing", () => {
	it("slices visible columns while keeping the styles open at the start", () => {
		const result = sliceCells("\x1b[31mhello\x1b[0m world", 1, 4);
		expect(result.text.startsWith("\x1b[31mello")).toBe(true);
		expect(result.width).toBe(4);
		expect(sliceColumns("\x1b[31mhello world", 0, 3)).toBe("\x1b[31mhel\x1b[0m");
		expect(sliceColumns("plain text", 2, 6)).toBe("ain ");
	});

	it("does not reopen a style closed right before the slice start", () => {
		const row = "ab \x1b[4m\x1b[38;2;1;2;3mx\x1b[39m\x1b[24m   ";
		const slice = sliceColumns(row, 4, 8);
		expect(stripEscapes(slice)).toBe("   ");
		expect(new SgrState().feed(slice).plain).toBe(true);
		expect(sliceCells("\x1b[1mab\x1b[22mcd", 2, 2).text).toBe("\x1b[1m\x1b[22mcd");
	});

	it("drops a wide grapheme straddling the edge when strict", () => {
		expect(sliceCells("日本語", 1, 3)).toEqual({ text: "本", width: 2 });
	});

	it("slices OSC 66 spans atomically", () => {
		const osc66 = "\x1b]66;s=2;Hi\x1b\\";
		expect(sliceCells(`A${osc66}Z`, 1, 4)).toEqual({ text: osc66, width: 4 });
		expect(sliceCells(osc66, 0, 2)).toEqual({ text: "H", width: 1 });
	});
});

describe("truncate", () => {
	it("returns fitting text unchanged, literal ellipses included", () => {
		expect(truncate("a", 2)).toBe("a");
		expect(truncate("界", 2)).toBe("界");
		const text = `\x1b[41mfoo\x1b[0m…bar${"\x1b[38;2;1;2;3m".repeat(20)}`;
		expect(truncate(text, 80)).toBe(text);
		expect(truncate(`\x1b[41mfoo\x1b[0m…bar`, 12, "…", true)).toBe(`\x1b[41mfoo\x1b[0m…bar     `);
	});

	it("cuts styled text, resetting before the ellipsis", () => {
		const result = truncate("\x1b[31mhello world\x1b[0m", 6);
		expect(result).toBe("\x1b[31mhello\x1b[0m…");
		expect(visibleWidth(result)).toBe(6);
		expect(truncate("hello", 1, "...")).toBe(".");
		expect(truncate("hello", 0)).toBe("");
	});

	it("omits the ellipsis with an empty one and still resets", () => {
		const cut = truncate(`\x1b[31m${"hello".repeat(100)}`, 10, "");
		expect(visibleWidth(cut)).toBe(10);
		expect(cut.endsWith("\x1b[0m")).toBe(true);
	});

	it("accepts a custom ellipsis", () => {
		expect(truncate("hello world", 7, "~>")).toBe("hello~>");
		expect(truncate("hello world", 8, "~>", true)).toBe("hello ~>");
		expect(truncate("hi", 4, "~>", true)).toBe("hi  ");
	});

	it("pads to the requested width", () => {
		expect(visibleWidth(truncate("🙂界🙂界🙂界", 8, "…", true))).toBe(8);
		expect(truncate("ab", 5, "…", true)).toBe("ab   ");
	});

	it("keeps the row background under the ellipsis and padding", () => {
		expect(truncate(`\x1b[41m${"界".repeat(7)}`, 12, "…", true)).toContain("\x1b[0m\x1b[41m… \x1b[49m");
		expect(truncate(`\x1b[41m${"界".repeat(8)}`, 14, "...", true)).toContain("\x1b[0m\x1b[41m... \x1b[49m");
		expect(truncate(`\x1b[41m${"界".repeat(6)}`, 11, "", true)).toContain("\x1b[0m\x1b[41m \x1b[49m");
		for (const [open, expected] of [
			["\x1b[1;48;5;236m", "\x1b[48;5;236m"],
			["\x1b[0;41m", "\x1b[41m"],
			["\x1b[31;44m", "\x1b[44m"],
			["\x1b[38;2;1;2;3;48;2;4;5;6m", "\x1b[48;2;4;5;6m"],
		] as const) {
			expect(truncate(`${open}${"A".repeat(20)}`, 8)).toContain(`\x1b[0m${expected}…`);
		}
		for (const reset of ["\x1b[m", "\x1b[22;49m"]) {
			expect(truncate(`\x1b[41mAAAA${reset}${"B".repeat(20)}`, 8)).not.toContain("\x1b[41m…");
		}
	});

	it("truncates OSC 66 spans by their declared width", () => {
		const osc66 = "\x1b]66;s=2;Hi\x1b\\";
		expect(truncate(osc66, 4)).toBe(osc66);
		const partial = truncate(osc66, 3);
		expect(partial.includes("\x1b]")).toBe(false);
		expect(visibleWidth(partial)).toBe(3);
		const huge = truncate("\x1b]66;w=99;a\x1b\\", 40);
		expect(visibleWidth(huge)).toBeLessThanOrEqual(40);
	});

	it("stays within width for very large unicode input", () => {
		expect(visibleWidth(truncate("🙂界".repeat(100_000), 40))).toBeLessThanOrEqual(40);
	});

	it("keeps the end with truncateStart", () => {
		expect(truncateStart("src/components/button.tsx", 12)).toBe("…/button.tsx");
		expect(truncateStart("short", 12)).toBe("short");
		// A wide grapheme straddling the cut is dropped, never split.
		expect(truncateStart("日本語テキスト", 6)).toBe("…スト");
	});

	it("keeps both ends with truncateMiddle, the end taking the odd cell", () => {
		expect(truncateMiddle("abcdefghij", 7)).toBe("abc…hij");
		expect(truncateMiddle("abcdefghij", 6)).toBe("ab…hij");
		expect(truncateMiddle("abc", 1)).toBe("…");
		expect(truncateMiddle("abc", 0)).toBe("");
		expect(truncateMiddle("\x1b[31mabcdefghij", 5)).toBe("\x1b[31mab\x1b[0m…\x1b[31mij");
	});
});

describe("padding", () => {
	it("pads or cuts to an exact width", () => {
		expect(padTo("ab", 4)).toBe("ab  ");
		expect(padTo("abcdef", 4)).toBe("abcd");
		expect(visibleWidth(padTo("日本語", 5))).toBe(5);
	});

	it("aligns within a field", () => {
		expect(align("ab", 6, "left")).toBe("ab    ");
		expect(align("ab", 6, "right")).toBe("    ab");
		expect(align("ab", 7, "center")).toBe("  ab   ");
		expect(align("abcdefgh", 4, "center")).toBe("abc…");
	});

	it("replaces tabs with the tab width", () => {
		expect(replaceTabs("a\tb")).toBe(`a${" ".repeat(TAB_WIDTH)}b`);
	});
});
