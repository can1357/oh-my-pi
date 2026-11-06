import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { getMarkdownTheme, setMarkdownColorful, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

const DOC = [
	"# One",
	"",
	"## Two",
	"",
	"###### Six",
	"",
	"**loud `code` tail** and *soft*",
	"",
	"| Head |",
	"| ---- |",
	"| cell |",
].join("\n");

let previous: Theme;
let celestial: Theme;

beforeAll(() => {
	previous = theme;
	const json = getBuiltinThemes()["dark-celestial"];
	if (!json) throw new Error("dark-celestial theme unavailable");
	celestial = createTheme(json, { mode: "truecolor" });
	setThemeInstance(celestial);
});

afterEach(() => setMarkdownColorful(true));

afterAll(() => setThemeInstance(previous));

describe("colorful Markdown", () => {
	it("paints headings by depth, emphasis, inline code and table headers from the theme palette", () => {
		const t = celestial;
		const out = new Markdown(DOC, 0, 0, getMarkdownTheme()).render(60).join("\n");

		expect(out).toContain(t.ansiFg("magenta", t.bold(t.underline("One"))));
		expect(out).toContain(t.ansiFg("yellow", t.bold("Two")));
		// Depths past the ladder reuse its last hue.
		expect(out).toContain(t.ansiFg("blue", t.bold("###### Six")));
		expect(out).toContain(t.ansiFg("magenta", t.italic("soft")));
		// Cell wrapping closes styles after the text, so match the opening color only.
		const yellow = t.ansiFg("yellow", "").replace("\x1b[39m", "");
		expect(out).toContain(`${yellow}${t.bold("Head").replace("\x1b[22m", "")}`);
		// The strong span's color resumes after the nested code span resets the foreground.
		const magenta = t.ansiFg("magenta", "").replace("\x1b[39m", "");
		expect(out).toContain(`${t.ansiFg("green", "code")}${magenta} tail`);
	});

	it("keeps the single heading token and uncolored emphasis when disabled", () => {
		setMarkdownColorful(false);
		const t = celestial;
		const out = new Markdown(DOC, 0, 0, getMarkdownTheme()).render(60).join("\n");

		expect(out).toContain(t.fg("mdHeading", t.bold("Two")));
		expect(out).toContain(t.fg("mdHeading", t.bold("###### Six")));
		expect(out).toContain(t.fg("mdCode", "code"));
		expect(out).not.toContain(t.ansiFg("magenta", ""));
	});

	it("falls back to the terminal's own palette when a theme ships no terminal.ansi", () => {
		const json = getBuiltinThemes()["dark-celestial"];
		if (!json) throw new Error("dark-celestial theme unavailable");
		const bare = createTheme({ ...json, terminal: undefined }, { mode: "truecolor" });

		expect(bare.ansiFg("magenta", "x")).toBe("\x1b[38;5;5mx\x1b[39m");
		expect(celestial.ansiFg("magenta", "x")).not.toBe(bare.ansiFg("magenta", "x"));
	});
});
