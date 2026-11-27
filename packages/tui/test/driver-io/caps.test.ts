import { describe, expect, it } from "bun:test";
import { isDarkBackground, parseColorSpec } from "../../src/driver/caps/color";
import {
	capabilitiesFromEnv,
	darkFromColorFgBg,
	hyperlinksDefault,
	hyperlinksOverride,
	imageProtocolFromEnv,
	rawBackspaceIsCtrl,
	synchronizedOutputDefault,
	synchronizedOutputOverride,
} from "../../src/driver/caps/env";
import { detectTerminalId, emojiSupportFor, resolveJamoWidth, type TerminalId } from "../../src/driver/caps/identity";
import { classifyMultiplexer, hasMultiplexerSession, insideMultiplexer } from "../../src/driver/mux/detect";
import {
	tmuxAllowsPassthrough,
	tmuxClientNamesFromReport,
	tmuxClientTerminalNames,
	type TmuxRunner,
	wrapPassthrough,
} from "../../src/driver/mux/tmux";

const direct = { platform: "darwin" as const, wsl: false, tmuxPassthrough: true };

describe("terminal identity", () => {
	it.each([
		[{ KITTY_WINDOW_ID: "1", TERM_PROGRAM: "WezTerm" }, "kitty"],
		[{ GHOSTTY_RESOURCES_DIR: "/x" }, "ghostty"],
		[{ WEZTERM_PANE: "0" }, "wezterm"],
		[{ ITERM_SESSION_ID: "w0" }, "iterm2"],
		[{ TERM_PROGRAM: "iTerm.app" }, "iterm2"],
		[{ TERM_PROGRAM: "vscode" }, "vscode"],
		[{ ALACRITTY_WINDOW_ID: "1" }, "alacritty"],
		[{ TERM_PROGRAM: "WarpTerminal", COLORTERM: "truecolor" }, "warp"],
		[{ TERM_PROGRAM: "rio", COLORTERM: "truecolor" }, "rio"],
		[{ TERM_PROGRAM: "tern", TERM: "xterm-256color" }, "tern"],
		[{ TERM_PROGRAM: "otty" }, "otty"],
		[{ TERM: "monstar", COLORTERM: "truecolor" }, "monstar"],
		[{ TERM: "xterm-rex", SSH_CONNECTION: "a 1 b 22" }, "rex"],
		[{ TERM: "xterm-ghostty" }, "ghostty"],
		[{ TERM: "xterm-kitty" }, "base"],
		[{ LC_TERMINAL: "iTerm2", SSH_CONNECTION: "a 1 b 22" }, "iterm2"],
		[{ LC_TERMINAL: "iTerm2", TMUX: "/tmp/t,1,0" }, "base"],
		[{ REX_SESSION: "s1", COLORTERM: "truecolor", VTE_VERSION: "8400" }, "trueColor"],
		[{ COLORTERM: "24bit" }, "trueColor"],
		[{ TERM: "xterm-256color" }, "base"],
		[{ WT_SESSION: "1" }, "windowsTerminal"],
		[{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", COLORTERM: "truecolor" }, "windowsTerminal"],
		[{ WT_SESSION: "1", TERM_PROGRAM: "vscode" }, "vscode"],
		[{ WT_SESSION: "1", WEZTERM_PANE: "0" }, "wezterm"],
		[{ WT_SESSION: "1", TERM_PROGRAM: "Tabby" }, "base"],
		[{ WT_SESSION: "1", SSH_CONNECTION: "a 1 b 22", COLORTERM: "truecolor" }, "trueColor"],
		[{ WT_SESSION: "1", TMUX: "/tmp/t,1,0" }, "base"],
		[{ WT_SESSION: "1", ZELLIJ: "0" }, "base"],
		[{ WT_SESSION: "1", TERM: "screen-256color" }, "base"],
		[{}, "base"],
	] as const)("%j → %s", (env, expected) => {
		expect(detectTerminalId(env)).toBe(expected);
	});

	it("gives a local Windows Terminal the true-color, synchronized-output profile it had through WT_SESSION", () => {
		const env = { WT_SESSION: "1", TERM: "xterm-256color" };
		const caps = capabilitiesFromEnv(env, { ...direct, platform: "win32", id: detectTerminalId(env) });
		expect(caps).toMatchObject({ truecolor: true, synchronizedOutput: true, hyperlinks: false, images: null });
		expect(caps.emoji).toEqual({ vs16Wide: true, bareFits: false });
	});

	it("uses the attached tmux client's identity when the pane says tmux", () => {
		const env = { TMUX: "/tmp/t,1,0", TERM_PROGRAM: "tmux", COLORTERM: "truecolor" };
		expect(detectTerminalId(env, ["WezTerm", "tmux-256color"])).toBe("wezterm");
		expect(detectTerminalId(env, tmuxClientNamesFromReport("tmux 3.4\txterm-kitty"))).toBe("kitty");
		expect(detectTerminalId(env, tmuxClientNamesFromReport("tmux 3.4\txterm-rex"))).toBe("rex");
		expect(detectTerminalId(env, [])).toBe("trueColor");
	});

	it("matches Paradev's two-cell xterm.js jamo width even though Paradev drops TERM_PROGRAM", () => {
		const paradev = { TERM: "xterm-256color", COLORTERM: "truecolor", SUPERSET_TERMINAL_ID: "term-1" };
		expect(resolveJamoWidth(detectTerminalId(paradev), paradev)).toBe(2);
		const renamed = { TERM: "xterm-256color", COLORTERM: "truecolor", PARADEV_TERMINAL_ID: "term-1" };
		expect(resolveJamoWidth(detectTerminalId(renamed), renamed)).toBe(2);
		// tmux inside a Paradev pane owns the cell grid, so Paradev's width does not apply.
		const tmux = { ...paradev, TMUX: "/tmp/tmux-501/default,1,0", TERM: "tmux-256color" };
		expect(resolveJamoWidth("trueColor", tmux)).toBe("platform");
		const plain = { TERM: "xterm-256color", COLORTERM: "truecolor" };
		expect(resolveJamoWidth(detectTerminalId(plain), plain)).toBe("platform");
		expect(resolveJamoWidth("ghostty", {})).toBe(2);
	});
});

describe("emoji support", () => {
	it.each([
		["kitty", { vs16Wide: true, bareFits: true }],
		["rio", { vs16Wide: true, bareFits: false }],
		// Wide only after the driver's Unicode 14 push.
		["wezterm", { vs16Wide: false, bareFits: true }],
		["alacritty", { vs16Wide: false, bareFits: false }],
		// Unknown: conservative until probed.
		["base", { vs16Wide: false, bareFits: false }],
	] as const)("%s → %j", (id, expected) => {
		expect(emojiSupportFor(id, {})).toEqual(expected);
	});

	it("drops U+FE0F forms inside a multiplexer and keeps the outer terminal's bare-glyph fit", () => {
		expect(emojiSupportFor("kitty", { TMUX: "/tmp/t,1,0" })).toEqual({ vs16Wide: false, bareFits: true });
		expect(emojiSupportFor("ghostty", { ZELLIJ: "0" })).toEqual({ vs16Wide: false, bareFits: true });
		expect(emojiSupportFor("rio", { STY: "x" })).toEqual({ vs16Wide: false, bareFits: false });
		// Orca keeps the direct render path.
		expect(emojiSupportFor("kitty", { ORCA_PANE_KEY: "k", ORCA_WORKTREE_ID: "w" })).toEqual({
			vs16Wide: true,
			bareFits: true,
		});
	});

	it("seeds the environment capabilities", () => {
		const env = { TMUX: "/tmp/t,1,0", TERM_PROGRAM: "tmux" };
		expect(capabilitiesFromEnv(env, { ...direct, id: "kitty" }).emoji).toEqual({ vs16Wide: false, bareFits: true });
		expect(capabilitiesFromEnv({}, { ...direct, id: "kitty" }).emoji).toEqual({ vs16Wide: true, bareFits: true });
	});
});

describe("multiplexers", () => {
	it("recognizes session markers, not client-only settings", () => {
		expect(hasMultiplexerSession("herdr", { HERDR_ENV: "1" })).toBe(true);
		expect(hasMultiplexerSession("herdr", { HERDR_PANE_ID: "p" })).toBe(true);
		expect(hasMultiplexerSession("herdr", { HERDR_SOCKET_PATH: "/x" })).toBe(false);
		expect(hasMultiplexerSession("tmux", { TERM: "tmux-256color" })).toBe(false);
		expect(hasMultiplexerSession("cmux", { CMUX_SOCKET_PATH: "/x" })).toBe(false);
		expect(hasMultiplexerSession("wmux", { WMUX: "0" })).toBe(false);
		expect(hasMultiplexerSession("orca", { ORCA_PANE_KEY: "k", ORCA_WORKTREE_ID: " " })).toBe(false);
	});

	it.each([
		[{ HERDR_PANE_ID: "p", TMUX: "s" }, "herdr"],
		[{ TMUX: "s", STY: "x" }, "tmux"],
		[{ STY: "x", ZELLIJ: "0" }, "screen"],
		[{ ZELLIJ: "0" }, "zellij"],
		[{ TERM: "screen-256color" }, "screen"],
		[{ TERM: "tmux-256color" }, "tmux"],
		[{ ORCA_PANE_KEY: "k", ORCA_WORKTREE_ID: "w" }, "orca"],
		[{ ORCA_PANE_KEY: "k", ORCA_WORKTREE_ID: "w", TMUX: "s" }, "tmux"],
		[{ TERM_PROGRAM: "orca" }, null],
		[{}, null],
	] as const)("%j → %s", (env, expected) => {
		expect(classifyMultiplexer(env)).toBe(expected);
	});

	it("keeps Orca on the direct render path", () => {
		expect(insideMultiplexer({ ORCA_PANE_KEY: "k", ORCA_WORKTREE_ID: "w" })).toBe(false);
		expect(insideMultiplexer({ WMUX: "1" })).toBe(true);
	});

	it("asks tmux for the client identity and the pane's passthrough policy", () => {
		const calls: string[] = [];
		const run: TmuxRunner = args => {
			calls.push(args.join(" "));
			if (args[0] === "display-message") return "WezTerm 20260905-175422\ttmux-256color\n";
			return "off\n";
		};
		const env = { TMUX: "/tmp/t,1,0", TMUX_PANE: "%7" };
		expect(tmuxClientTerminalNames(env, run)).toEqual(["WezTerm", "tmux-256color"]);
		expect(tmuxAllowsPassthrough(env, run)).toBe(false);
		expect(tmuxAllowsPassthrough(env, () => "")).toBe(true);
		expect(tmuxClientTerminalNames({}, run)).toEqual([]);
		expect(calls).toEqual([
			"display-message -p #{client_termtype}\t#{client_termname}",
			"show-options -Apqv -t %7 allow-passthrough",
		]);
	});

	it("wraps passthrough for tmux (doubled ESC) and screen (chunked DCS)", () => {
		expect(wrapPassthrough("\x1b_Ga=q\x1b\\", "tmux")).toBe("\x1bPtmux;\x1b\x1b_Ga=q\x1b\x1b\\\x1b\\");
		expect(wrapPassthrough("\x1b]9;hi\x07", "screen")).toBe("\x1bP\x1b]9;hi\x07\x1b\\");
		expect(wrapPassthrough("x".repeat(1000), "screen").split("\x1bP")).toHaveLength(3);
		expect(wrapPassthrough("\x1b]9;hi\x07", null)).toBe("\x1b]9;hi\x07");
		expect(wrapPassthrough("\x1b]9;hi\x07", "zellij")).toBe("\x1b]9;hi\x07");
	});
});

describe("synchronized output", () => {
	it("honors user overrides, opt-out first", () => {
		expect(synchronizedOutputOverride({})).toBeNull();
		expect(synchronizedOutputOverride({ PI_NO_SYNC_OUTPUT: "1", PI_FORCE_SYNC_OUTPUT: "1" })).toBe(false);
		expect(synchronizedOutputOverride({ PI_TUI_SYNC_OUTPUT: "1" })).toBe(true);
	});

	it.each([
		[{}, "kitty", true],
		[{}, "alacritty", true],
		[{}, "trueColor", false],
		[{}, "base", false],
		[{}, "warp", false],
		[{ WT_SESSION: "x" }, "trueColor", true],
		[{ WT_SESSION: "0", TERM_PROGRAM: "Tabby" }, "trueColor", false],
		[{ TERM_FEATURES: "ClSyTc" }, "base", true],
		[{ TERM_FEATURES: "ClSyTc", TMUX: "1" }, "base", false],
		[{ TERM_FEATURES: "ClSyTc", TMUX: "1", PI_FORCE_SYNC_OUTPUT: "1" }, "base", true],
		[{ TERM_FEATURES: "ClTc" }, "base", false],
		[{ SSH_CONNECTION: "1 2 3 4" }, "iterm2", true],
		[{ TMUX: "1" }, "kitty", false],
		[{ ZELLIJ: "0" }, "ghostty", false],
		[{ TERM: "screen-256color" }, "kitty", false],
		[{ HERDR_ENV: "1" }, "base", true],
		[{ HERDR_PANE_ID: "p", TMUX: "1" }, "kitty", true],
		[{ HERDR_ENV: "1", PI_NO_SYNC_OUTPUT: "1" }, "kitty", false],
		[{ PI_FORCE_SYNC_OUTPUT: "1", TMUX: "1" }, "base", true],
	] as const)("%j on %s → %s", (env, id, expected) => {
		expect(synchronizedOutputDefault(env, id as TerminalId)).toBe(expected);
	});
});

describe("hyperlinks", () => {
	const tmux = (version: string) => ({ TMUX: "/tmp/t,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: version });

	it("only takes the literal 1 as an override", () => {
		expect(hyperlinksOverride({ PI_FORCE_HYPERLINKS: "true" })).toBeNull();
		expect(hyperlinksOverride({ PI_NO_HYPERLINKS: "1", PI_FORCE_HYPERLINKS: "1" })).toBe(false);
	});

	it.each([
		[{}, "wezterm", true],
		[{}, "trueColor", false],
		[{}, "warp", false],
		[{ STY: "1.pts" }, "wezterm", false],
		[{ TERM: "screen-256color" }, "kitty", false],
		[tmux("3.4"), "wezterm", true],
		[tmux("3.3a"), "wezterm", false],
		[tmux("3.5a"), "base", false],
		[{ TMUX: "/tmp/t,1,0" }, "wezterm", false],
		[{ ...tmux("3.4"), STY: "1.pts" }, "wezterm", false],
		[{ HERDR_ENV: "1" }, "base", true],
		[{ HERDR_ENV: "1", TMUX: "1" }, "base", false],
		[{ HERDR_ENV: "1", ZELLIJ: "0" }, "base", true],
		[{ ZELLIJ: "0", TERM: "xterm-256color" }, "kitty", true],
		[{ PI_FORCE_HYPERLINKS: "1", STY: "1" }, "base", true],
		[{ PI_NO_HYPERLINKS: "1" }, "kitty", false],
	] as const)("%j on %s → %s", (env, id, expected) => {
		expect(hyperlinksDefault(env, id as TerminalId)).toBe(expected);
	});
});

describe("images from the environment", () => {
	it.each([
		["kitty", {}, direct, "kitty"],
		["iterm2", {}, direct, "iterm"],
		["trueColor", {}, direct, null],
		["warp", {}, { ...direct, platform: "win32" as const }, null],
		["warp", {}, { ...direct, platform: "linux" as const, wsl: true }, null],
		["ghostty", { HERDR_ENV: "1" }, direct, null],
		["kitty", { PASEO_TERMINAL_ID: "t" }, direct, null],
		["base", { TERM: "screen-256color" }, direct, "kitty"],
		["base", { TERM: "screen-256color", PASEO_TERMINAL_ID: "t" }, direct, null],
		["trueColor", { TMUX: "s", TERM: "tmux-256color" }, direct, null],
		["base", { TMUX: "s", TERM: "screen-256color" }, direct, null],
		["base", { STY: "1.x", TERM: "xterm-256color" }, direct, null],
		["iterm2", { STY: "1.x", TERM: "screen" }, direct, "iterm"],
		["vscode", { TERM: "screen-256color" }, direct, null],
		["ghostty", { TMUX: "s" }, direct, "kitty"],
		["ghostty", { TMUX: "s" }, { ...direct, tmuxPassthrough: false }, null],
		["iterm2", { ZELLIJ: "0" }, direct, "iterm"],
		["iterm2", { TMUX: "s" }, direct, "iterm"],
		["base", { PI_FORCE_IMAGE_PROTOCOL: "sixel" }, direct, "sixel"],
		["kitty", { PI_FORCE_IMAGE_PROTOCOL: "none" }, direct, null],
	] as const)("%s with %j → %s", (id, env, context, expected) => {
		expect(imageProtocolFromEnv(id as TerminalId, env, context)).toBe(expected);
	});
});

describe("colors and appearance", () => {
	it("derives color depth", () => {
		expect(capabilitiesFromEnv({ COLORTERM: "truecolor" }, { id: "trueColor", ...direct })).toMatchObject({
			truecolor: true,
			colors: 16_777_216,
		});
		expect(capabilitiesFromEnv({ TERM: "xterm-256color" }, { id: "base", ...direct })).toMatchObject({
			truecolor: false,
			colors: 256,
		});
		expect(capabilitiesFromEnv({ TERM: "xterm" }, { id: "base", ...direct }).colors).toBe(16);
		expect(capabilitiesFromEnv({ TMUX: "s" }, { id: "base", ...direct }).multiplexer).toBe("tmux");
		expect(capabilitiesFromEnv({ HERDR_ENV: "1" }, { id: "base", ...direct }).multiplexer).toBeNull();
	});

	it("reads COLORFGBG", () => {
		expect(darkFromColorFgBg({ COLORFGBG: "15;0" })).toBe(true);
		expect(darkFromColorFgBg({ COLORFGBG: "0;15" })).toBe(false);
		expect(darkFromColorFgBg({ COLORFGBG: "0;default;7" })).toBe(false);
		expect(darkFromColorFgBg({})).toBeNull();
	});

	it("parses X11 color specs of every channel width", () => {
		expect(parseColorSpec("rgb:ffff/ffff/ffff")).toEqual({ r: 255, g: 255, b: 255 });
		expect(parseColorSpec("rgb:1a/1a/1a")).toEqual({ r: 26, g: 26, b: 26 });
		expect(parseColorSpec("rgb:f/0/8")).toEqual({ r: 255, g: 0, b: 136 });
		expect(parseColorSpec("rgba:0000/0000/0000/ffff")).toEqual({ r: 0, g: 0, b: 0 });
		expect(parseColorSpec("#102030")).toEqual({ r: 16, g: 32, b: 48 });
		expect(parseColorSpec("nope")).toBeNull();
		expect(isDarkBackground({ r: 28, g: 28, b: 28 })).toBe(true);
		expect(isDarkBackground({ r: 238, g: 238, b: 238 })).toBe(false);
	});
});

describe("raw 0x08 backspace", () => {
	it.each([
		[{ WT_SESSION: "1" }, true],
		[{}, false],
		[{ WT_SESSION: "1", SSH_CONNECTION: "a" }, false],
		[{ WT_SESSION: "1", TMUX: "s" }, false],
		[{ WT_SESSION: "1", TERM: "screen-256color" }, false],
		[{ WT_SESSION: "1", TMUX: "s", PI_TUI_RAW_BACKSPACE_IS_CTRL: "1" }, true],
		[{ SSH_CONNECTION: "a", PI_TUI_RAW_BACKSPACE_IS_CTRL: "1" }, true],
	] as const)("%j → %s", (env, expected) => {
		expect(rawBackspaceIsCtrl(env)).toBe(expected);
	});
});
