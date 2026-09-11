import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-natives";
import {
	detectKittyUnicodePlaceholdersSupport,
	encodeKittyPlaceholderGrid,
	encodeKittyVirtualPlacement,
	getKittyGraphics,
	KITTY_PLACEHOLDER,
	KITTY_PLACEHOLDER_MAX_CELLS,
	kittyPlaceholdersFit,
	renderKittyPlaceholderLines,
	setKittyGraphics,
} from "@oh-my-pi/pi-tui/kitty-graphics";

const ORIGINAL = { ...getKittyGraphics() };
const ORIGINAL_TMUX = Bun.env.TMUX;

beforeEach(() => {
	delete Bun.env.TMUX;
});

afterEach(() => {
	setKittyGraphics(ORIGINAL);
	if (ORIGINAL_TMUX === undefined) delete Bun.env.TMUX;
	else Bun.env.TMUX = ORIGINAL_TMUX;
});

describe("kitty Unicode placeholder encoding", () => {
	it("encodeKittyVirtualPlacement emits a=p with U=1 and the id/placement/geometry", () => {
		expect(encodeKittyVirtualPlacement({ imageId: 7, placementId: 7, columns: 4, rows: 2 })).toBe(
			"\x1b_Ga=p,U=1,q=2,i=7,p=7,c=4,r=2\x1b\\",
		);
		// Placement id is omitted when absent.
		expect(encodeKittyVirtualPlacement({ imageId: 7, columns: 4, rows: 2 })).toBe(
			"\x1b_Ga=p,U=1,q=2,i=7,c=4,r=2\x1b\\",
		);
	});

	it("encodeKittyPlaceholderGrid returns one row per line with explicit row+column cells", () => {
		const grid = encodeKittyPlaceholderGrid({ imageId: 1, placementId: 1, columns: 3, rows: 2 });
		expect(grid).toHaveLength(2);
		for (const row of grid) {
			// Image id in foreground color, placement id in underline color, reset at end.
			expect(row).toContain("\x1b[38;2;0;0;1m");
			expect(row).toContain("\x1b[58:2::0:0:1m");
			expect(row.endsWith("\x1b[39;59m")).toBe(true);
			// Exactly `columns` placeholder base characters.
			expect([...row].filter(ch => ch === KITTY_PLACEHOLDER)).toHaveLength(3);
		}
		// Distinct rows carry distinct row diacritics (robust under slicing).
		expect(grid[0]).not.toBe(grid[1]);
	});

	it("a placeholder row measures exactly `columns` cells wide", () => {
		const grid = encodeKittyPlaceholderGrid({ imageId: 5, placementId: 5, columns: 6, rows: 1 });
		// Each placeholder cell (U+10EEEE + diacritics) is one terminal column; the
		// SGR runs are zero-width. This is what keeps renderer/terminal accounting aligned.
		expect(visibleWidth(grid[0]!, 3)).toBe(6);
	});

	it("renderKittyPlaceholderLines prefixes line 0 with the virtual placement APC", () => {
		const opts = { imageId: 2, placementId: 2, columns: 2, rows: 3 } as const;
		const placement = encodeKittyVirtualPlacement(opts);
		const grid = encodeKittyPlaceholderGrid(opts);
		const lines = renderKittyPlaceholderLines(opts);
		expect(lines).toHaveLength(3);
		// Line 0 is the placement APC + the first grid row; later rows are unchanged.
		expect(lines[0]).toBe(placement + grid[0]);
		expect(lines.slice(1)).toEqual(grid.slice(1));
	});

	it("kittyPlaceholdersFit guards the diacritic table capacity", () => {
		expect(kittyPlaceholdersFit(1, 1)).toBe(true);
		expect(kittyPlaceholdersFit(KITTY_PLACEHOLDER_MAX_CELLS, KITTY_PLACEHOLDER_MAX_CELLS)).toBe(true);
		expect(kittyPlaceholdersFit(0, 5)).toBe(false);
		expect(kittyPlaceholdersFit(5, 0)).toBe(false);
		expect(kittyPlaceholdersFit(KITTY_PLACEHOLDER_MAX_CELLS + 1, 1)).toBe(false);
		expect(kittyPlaceholdersFit(1, KITTY_PLACEHOLDER_MAX_CELLS + 1)).toBe(false);
	});
});

describe("kitty graphics feature state", () => {
	it("getKittyGraphics/setKittyGraphics round-trips overrides", () => {
		setKittyGraphics({ unicodePlaceholders: false });
		expect(getKittyGraphics()).toEqual({ unicodePlaceholders: false });
		setKittyGraphics({ unicodePlaceholders: true });
		expect(getKittyGraphics().unicodePlaceholders).toBe(true);
	});
});

describe("detectKittyUnicodePlaceholdersSupport", () => {
	function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
		return extra as NodeJS.ProcessEnv;
	}

	it("enables for kitty and ghostty by default (the only terminals that render U=1 placement)", () => {
		expect(detectKittyUnicodePlaceholdersSupport("kitty", env())).toBe(true);
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", env())).toBe(true);
	});

	it("disables for wezterm and other Kitty-protocol paths that treat placeholders as literal PUA glyphs (#1877)", () => {
		expect(detectKittyUnicodePlaceholdersSupport("wezterm", env())).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("warp", env())).toBe(false);
		// Tmux/screen fallback: base terminal id with Kitty protocol forced on by
		// `getFallbackImageProtocol`. The outer terminal need not understand U=1.
		expect(detectKittyUnicodePlaceholdersSupport("base", env())).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("iterm2", env())).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("alacritty", env())).toBe(false);
	});

	it("uses scroll-aware placeholders when Kitty is explicitly forced through a multiplexer", () => {
		const forcedTmux = env({ TMUX: "/tmp/tmux-1000/default,1,0", PI_FORCE_IMAGE_PROTOCOL: "kitty" });
		expect(detectKittyUnicodePlaceholdersSupport("base", forcedTmux)).toBe(true);
		expect(detectKittyUnicodePlaceholdersSupport("wezterm", forcedTmux)).toBe(true);
		expect(
			detectKittyUnicodePlaceholdersSupport("ghostty", env({ HERDR_ENV: "1", PI_FORCE_IMAGE_PROTOCOL: "kitty" })),
		).toBe(true);
		// Automatic multiplexer fallback remains conservative when the outer terminal is unknown.
		expect(detectKittyUnicodePlaceholdersSupport("base", env({ TMUX: "/tmp/tmux-1000/default,1,0" }))).toBe(false);
		// A detected capable terminal still needs placeholders because direct placement cannot follow pane reflow.
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", env({ TMUX: "/tmp/tmux-1000/default,1,0" }))).toBe(true);
	});

	it("ignores leaked Kitty-capable terminal identities inside Herdr unless placeholders are explicitly forced", () => {
		const leaked = env({ HERDR_ENV: "1", GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" });
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", leaked)).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", { ...leaked, PI_KITTY_PLACEHOLDERS: "1" })).toBe(true);
		const paneOnly = env({ HERDR_PANE_ID: "p1", GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" });
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", paneOnly)).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", { ...paneOnly, PI_KITTY_PLACEHOLDERS: "1" })).toBe(true);
	});

	it("honors PI_NO_KITTY_PLACEHOLDERS=1 as a hard off override on supporting terminals", () => {
		expect(detectKittyUnicodePlaceholdersSupport("kitty", env({ PI_NO_KITTY_PLACEHOLDERS: "1" }))).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", env({ PI_NO_KITTY_PLACEHOLDERS: "true" }))).toBe(false);
	});

	it("honors PI_KITTY_PLACEHOLDERS=1 as opt-in on otherwise-unsupported terminals", () => {
		expect(detectKittyUnicodePlaceholdersSupport("wezterm", env({ PI_KITTY_PLACEHOLDERS: "1" }))).toBe(true);
	});

	it("PI_NO_KITTY_PLACEHOLDERS beats PI_KITTY_PLACEHOLDERS when both are set", () => {
		const both = env({ PI_NO_KITTY_PLACEHOLDERS: "1", PI_KITTY_PLACEHOLDERS: "1" });
		expect(detectKittyUnicodePlaceholdersSupport("kitty", both)).toBe(false);
	});

	it("PI_KITTY_PLACEHOLDERS=0 forces off on a default-on terminal", () => {
		expect(detectKittyUnicodePlaceholdersSupport("kitty", env({ PI_KITTY_PLACEHOLDERS: "0" }))).toBe(false);
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", env({ PI_KITTY_PLACEHOLDERS: "off" }))).toBe(false);
	});

	it("placeholder opt-out beats forced Kitty under tmux", () => {
		const forcedOff = env({
			TMUX: "/tmp/tmux-1000/default,1,0",
			PI_FORCE_IMAGE_PROTOCOL: "kitty",
			PI_KITTY_PLACEHOLDERS: "0",
		});
		expect(detectKittyUnicodePlaceholdersSupport("base", forcedOff)).toBe(false);
	});
});
