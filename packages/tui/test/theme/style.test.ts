import { describe, expect, it } from "bun:test";
import { builtinThemes, createTheme, presetSymbols, type ThemeJson } from "@oh-my-pi/pi-tui/theme/index";

const dark = createTheme(builtinThemes().dark!);
const light = createTheme(builtinThemes().light!);
/** Unicode status marks: one-cell text glyphs in the theme color, exempt from emoji presentation. */
const STATUS_MARKS = ["status.success", "status.warning", "status.aborted", "status.done"];

describe("fg / bg", () => {
	it("keeps the outer color after a nested color ends", () => {
		const footer = dark.fg("dim", `${dark.fg("success", "+2")} · 3 more lines`);
		const tail = footer.slice(footer.indexOf("+2") + 2);
		expect(tail.startsWith(`\x1b[39m${dark.fgSgr("dim")}`)).toBe(true);
		expect(Bun.stripANSI(footer)).toBe("+2 · 3 more lines");
	});

	it("restores the color after a full reset inside the text", () => {
		const accent = dark.fgSgr("accent");
		expect(dark.fg("accent", "a\x1b[0mb")).toBe(`${accent}a\x1b[0m${accent}b\x1b[39m`);
	});

	it("resets only the background after a background", () => {
		expect(dark.bg("selectedBg", "x")).toBe("\x1b[48;2;49;54;63mx\x1b[49m");
		expect(dark.bgFill("selectedBg", "a\x1b[0mb")).toBe("\x1b[48;2;49;54;63ma\x1b[0m\x1b[48;2;49;54;63mb\x1b[49m");
	});

	it("throws for unknown keys", () => {
		expect(() => dark.fg("nope", "x")).toThrow("Unknown theme color: nope");
		expect(() => dark.bg("accent", "x")).toThrow("Unknown theme background color: accent");
	});

	it("replaces terminal-default colors with the contrast fallback in fgResolved", () => {
		expect(dark.fgResolved("text", "x")).toBe("\x1b[38;2;229;229;231mx\x1b[39m");
		expect(light.fgResolved("text", "x")).toBe("\x1b[38;2;0;0;0mx\x1b[39m");
		expect(dark.fgResolved("accent", "x")).toBe(dark.fg("accent", "x"));
	});

	it("paints terminal.ansi slots, or the terminal's own slot when the theme has none", () => {
		expect(dark.palette(5, "x")).toBe("\x1b[38;2;188;63;188mx\x1b[39m");
		const json: ThemeJson = structuredClone(builtinThemes().dark!);
		delete json.terminal;
		expect(createTheme(json).palette(5, "x")).toBe("\x1b[38;5;5mx\x1b[39m");
	});

	it("falls back to thinkingXhigh for an undeclared thinkingMax", () => {
		expect(dark.fg("thinkingMax", "x")).toBe(dark.fg("thinkingXhigh", "x"));
	});

	it("derives a muted mdExtensionLink between text and mdLink", () => {
		const link = dark.fgSgr("mdExtensionLink");
		expect(link).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
		expect(link).not.toBe(dark.fgSgr("mdLink"));
	});

	it("shifts toolDiffAdded in color-blind mode only", () => {
		const shifted = createTheme(builtinThemes().dark!, { colorBlindMode: true });
		expect(shifted.fgSgr("toolDiffAdded")).not.toBe(dark.fgSgr("toolDiffAdded"));
		expect(shifted.fgSgr("toolDiffRemoved")).toBe(dark.fgSgr("toolDiffRemoved"));
	});
});

describe("style tokens", () => {
	it("passes text through without tokens", () => {
		expect(dark.style(undefined, "x")).toBe("x");
		expect(dark.style("", "x")).toBe("x");
		expect(dark.style("icon mono", "x")).toBe("x");
	});

	it("emits terminal attribute bytes", () => {
		expect(dark.style("strong", "x")).toBe("\x1b[1mx\x1b[22m");
		expect(dark.style("em", "x")).toBe("\x1b[3mx\x1b[23m");
		expect(dark.style("underline", "x")).toBe("\x1b[4mx\x1b[24m");
		expect(dark.style("strike", "x")).toBe("\x1b[9mx\x1b[29m");
		expect(dark.style("inverse", "x")).toBe("\x1b[7mx\x1b[27m");
		expect(dark.style("faint", "x")).toBe("\x1b[2mx\x1b[22m");
		expect(dark.style("strong", "")).toBe("");
	});

	it("re-opens attributes after nested closes and around line breaks", () => {
		expect(dark.style("strong", "a\x1b[22mb")).toBe("\x1b[1ma\x1b[22m\x1b[1mb\x1b[22m");
		expect(dark.style("em", "a\nb")).toBe("\x1b[3ma\x1b[23m\n\x1b[3mb\x1b[23m");
	});

	it("puts the color outside the attributes and the background outermost", () => {
		expect(dark.style("accent strong", "x")).toBe(`${dark.fgSgr("accent")}\x1b[1mx\x1b[22m\x1b[39m`);
		expect(dark.style("strong accent em", "x")).toBe(
			`${dark.fgSgr("accent")}\x1b[1m\x1b[3mx\x1b[23m\x1b[22m\x1b[39m`,
		);
		expect(dark.style("selectedBg accent", "x")).toBe(`\x1b[48;2;49;54;63m${dark.fgSgr("accent")}x\x1b[39m\x1b[49m`);
	});

	it("treats dim as the theme color", () => {
		expect(dark.style("dim", "x")).toBe(dark.fg("dim", "x"));
		expect(dark.style("mono dim", "x")).toBe(dark.fg("dim", "x"));
	});

	it("maps tones onto theme colors", () => {
		expect(dark.style("info", "x")).toBe(dark.fg("accent", "x"));
		expect(dark.style("pending", "x")).toBe(dark.fg("warning", "x"));
		expect(dark.style("user", "x")).toBe(dark.fg("customMessageLabel", "x"));
		expect(dark.style("neutral", "x")).toBe(dark.fg("text", "x"));
	});

	it("lets explicit colors beat semantic tokens, and specific semantics beat general ones", () => {
		expect(dark.style("path", "x")).toBe(dark.fg("accent", "x"));
		expect(dark.style("path dim", "x")).toBe(dark.fg("dim", "x"));
		expect(dark.style("muted path", "x")).toBe(dark.fg("muted", "x"));
		expect(dark.style("ins num", "x")).toBe(dark.fg("toolDiffAdded", "x"));
		expect(dark.style("num del", "x")).toBe(dark.fg("toolDiffRemoved", "x"));
		expect(dark.style("code", "x")).toBe(dark.fg("mdCode", "x"));
		expect(dark.style("link", "x")).toBe(dark.fg("mdLink", "x"));
	});

	it("highlights marks, underlines typos and drops hidden runs", () => {
		expect(dark.style("mark", "x")).toBe(dark.bg("selectedBg", "x"));
		expect(dark.style("typo", "x")).toBe("\x1b[4mx\x1b[24m");
		expect(dark.style("hide accent", "x")).toBe("");
	});
});

describe("symbols", () => {
	it("draws rounded boxes with sharp junctions and sharp tables", () => {
		const { box, sharp } = dark.symbols;
		expect([box.topLeft, box.topRight, box.bottomLeft, box.bottomRight, box.horizontal, box.vertical]).toEqual([
			"╭",
			"╮",
			"╰",
			"╯",
			"─",
			"│",
		]);
		expect([box.teeDown, box.teeUp, box.teeLeft, box.teeRight, box.cross]).toEqual(["┬", "┴", "┤", "├", "┼"]);
		expect([sharp.topLeft, sharp.bottomRight]).toEqual(["┌", "┘"]);
		expect(dark.symbols.ellipsis).toBe("…");
	});

	it("resolves icons by key, icon name and slash-command name", () => {
		const { symbols } = dark;
		expect(symbols.icon("status.success")).toBe("✓");
		expect(symbols.icon("warning")).toBe("⚠️");
		expect(symbols.icon("jobs")).toBe(symbols.symbol("icon.job"));
		expect(symbols.icon("gear")).toBe(symbols.symbol("cmd.gear"));
		expect(symbols.icon("no-such-icon")).toBe("");
		expect(symbols.langIcon("ts")).toBe(symbols.symbol("lang.typescript"));
		expect(symbols.langIcon("weird")).toBe("⌘");
		expect(symbols.symbol("status.done")).toBe(symbols.symbol("status.success"));
	});

	it("gives every emoji-capable unicode icon emoji presentation, so terminals and stringWidth both count 2 cells", () => {
		// Without U+FE0F, emoji-font fallback draws e.g. `✉` two cells wide over a one-cell advance,
		// covering the next character. Layout glyphs (separators, checkbox pair) are not icons.
		const table = presetSymbols("unicode");
		const bare = Object.entries(table).filter(([key, glyph]) => {
			if (!/^(status|icon|cmd|tab|tool|lang|chip)\./.test(key) || STATUS_MARKS.includes(key)) return false;
			const chars = [...glyph];
			return chars.some(
				(char, i) =>
					/\p{Extended_Pictographic}/u.test(char) &&
					!/\p{Emoji_Presentation}/u.test(char) &&
					chars[i + 1] !== "\uFE0F",
			);
		});
		expect(bare).toEqual([]);
	});

	it("keeps unicode status marks one-cell text glyphs that take the theme color", () => {
		// Emoji ignore fg color; status marks sit in aligned columns.
		const table = presetSymbols("unicode");
		const marks = STATUS_MARKS.map(key => ({
			key,
			width: Bun.stringWidth(table[key]!),
			emoji: table[key]!.includes("\uFE0F"),
		}));
		expect(marks).toEqual(STATUS_MARKS.map(key => ({ key, width: 1, emoji: false })));
	});

	it("switches glyphs and spinners with the preset", () => {
		const ascii = createTheme(builtinThemes().dark!, { symbolPreset: "ascii" });
		expect(ascii.symbols.symbol("status.success")).toBe("[+]");
		expect(ascii.symbols.spinnerFrames).toEqual(["[|]", "[/]", "[-]", "[\\]"]);
		expect(dark.symbols.spinnerFrames).toEqual(["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]);
	});

	it("tints language icons with brand colors, else muted", () => {
		expect(dark.langIconStyled("js")).toBe(`\x1b[38;2;247;223;30m${dark.symbols.langIcon("js")}\x1b[39m`);
		expect(dark.langIconStyled("rust")).toBe(dark.fg("muted", dark.symbols.langIcon("rust")));
	});
});
