import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Glob } from "bun";
import { anchoredRows, RESERVED_ROW, reservedRows } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { DEFAULT_CELL, fitImage } from "@oh-my-pi/pi-tui/driver/images/fit";
import { itermImage } from "@oh-my-pi/pi-tui/driver/images/iterm";
import {
	KITTY_CHUNK_SIZE,
	KITTY_PLACEHOLDER,
	KITTY_PLACEHOLDER_MAX_CELLS,
	kittyDelete,
	kittyDeletePlacement,
	kittyPlace,
	kittyPlacementRows,
	kittyPlaceholderRows,
	kittyPlaceholdersFit,
	kittyPlaceholdersSupported,
	kittyTransmit,
	kittyTransmitAndDisplay,
	kittyVirtualPlace,
} from "@oh-my-pi/pi-tui/driver/images/kitty";
import { sixelBackground } from "@oh-my-pi/pi-tui/driver/images/sixel";
import { CORPUS_DIR, hasCorpus } from "@oh-my-pi/pi-tui/testing/corpus";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";

const tmux = (payload: string) => `\x1bPtmux;${payload.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;

describe("kitty commands", () => {
	it("transmits small data in one quiet PNG command keyed by id", () => {
		expect(kittyTransmit("AA==", 42)).toBe("\x1b_Ga=t,f=100,q=2,i=42;AA==\x1b\\");
	});

	it("splits large data into 4096-byte chunks continued with q=2,m=1 and ended with m=0", () => {
		const data = "A".repeat(KITTY_CHUNK_SIZE * 2 + 10);
		const commands = [...kittyTransmit(data, 7).matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
		expect(commands.map(m => [m[1], m[2]!.length])).toEqual([
			["a=t,f=100,q=2,i=7,m=1", 4096],
			["q=2,m=1", 4096],
			["q=2,m=0", 10],
		]);
	});

	it("places by id with a stable placement id, an optional source band, and no cursor movement", () => {
		expect(kittyPlace({ id: 9, placement: 9, columns: 3, rows: 2 })).toBe("\x1b_Ga=p,q=2,C=1,i=9,p=9,c=3,r=2\x1b\\");
		expect(kittyPlace({ id: 9, columns: 3, rows: 1, source: { x: 0, y: 5, w: 10, h: 5 } })).toBe(
			"\x1b_Ga=p,q=2,C=1,i=9,x=0,y=5,w=10,h=5,c=3,r=1\x1b\\",
		);
	});

	it("creates virtual placements for Unicode placeholders", () => {
		expect(kittyVirtualPlace({ id: 7, placement: 7, columns: 4, rows: 2 })).toBe(
			"\x1b_Ga=p,U=1,q=2,i=7,p=7,c=4,r=2\x1b\\",
		);
		expect(kittyVirtualPlace({ id: 7, columns: 4, rows: 2 })).toBe("\x1b_Ga=p,U=1,q=2,i=7,c=4,r=2\x1b\\");
	});

	it("deletes an image with its data, or one placement", () => {
		expect(kittyDelete(42)).toBe("\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		expect(kittyDeletePlacement(42, 3)).toBe("\x1b_Ga=d,d=i,i=42,p=3,q=2\x1b\\");
	});

	it("wraps every command, and each chunk separately, for tmux", () => {
		expect(kittyTransmit("AA==", 9, "tmux")).toBe(tmux("\x1b_Ga=t,f=100,q=2,i=9;AA==\x1b\\"));
		expect(kittyPlace({ id: 9, placement: 9, columns: 3, rows: 2 }, "tmux")).toBe(
			tmux("\x1b_Ga=p,q=2,C=1,i=9,p=9,c=3,r=2\x1b\\"),
		);
		expect(kittyVirtualPlace({ id: 9, placement: 9, columns: 3, rows: 2 }, "tmux")).toBe(
			tmux("\x1b_Ga=p,U=1,q=2,i=9,p=9,c=3,r=2\x1b\\"),
		);
		expect(kittyDelete(9, "tmux")).toBe(tmux("\x1b_Ga=d,d=I,i=9,q=2\x1b\\"));
		const chunked = kittyTransmit("A".repeat(4097), 9, "tmux");
		expect(chunked.match(/\x1bPtmux;/g)).toHaveLength(2);
		expect(chunked).toContain("\x1b\x1b_Gq=2,m=0;");
		// Other multiplexers get the bare command.
		expect(kittyDelete(9, "zellij")).toBe("\x1b_Ga=d,d=I,i=9,q=2\x1b\\");
	});
});

describe("kitty direct placement rows", () => {
	it("places one source band per row, under consecutive placement ids, measuring zero cells", () => {
		const rows = kittyPlacementRows({ id: 5, widthPx: 30, heightPx: 20 }, 3, 2, 1);
		expect(rows).toEqual([
			"\x1b_Ga=p,q=2,C=1,i=5,p=1,x=0,y=0,w=30,h=10,c=3,r=1\x1b\\",
			"\x1b_Ga=p,q=2,C=1,i=5,p=2,x=0,y=10,w=30,h=10,c=3,r=1\x1b\\",
		]);
		for (const row of rows) expect(visibleWidth(row)).toBe(0);
	});

	it("covers the source exactly when the height does not divide evenly", () => {
		const rows = kittyPlacementRows({ id: 1, widthPx: 4, heightPx: 10 }, 1, 3, 1);
		const bands = rows.map(row => {
			const m = row.match(/y=(\d+),w=\d+,h=(\d+)/)!;
			return [Number(m[1]), Number(m[2])];
		});
		expect(bands).toEqual([
			[0, 3],
			[3, 3],
			[6, 4],
		]);
	});

	it("never places an empty band when rows outnumber pixel rows", () => {
		const rows = kittyPlacementRows({ id: 1, widthPx: 1, heightPx: 1 }, 2, 3, 1);
		for (const row of rows) expect(row).toContain("y=0,w=1,h=1,");
	});
});

describe("kitty Unicode placeholders", () => {
	it("draws one row per image row: id in the foreground, placement in the underline, exactly `columns` cells", () => {
		const grid = kittyPlaceholderRows({ id: 0x010203, placement: 4, columns: 3, rows: 2 });
		expect(grid).toHaveLength(2);
		for (const row of grid) {
			expect(row.startsWith("\x1b[38;2;1;2;3m\x1b[58:2::0:0:4m")).toBe(true);
			expect(row.endsWith("\x1b[39;59m")).toBe(true);
			expect([...row].filter(ch => ch === KITTY_PLACEHOLDER)).toHaveLength(3);
			expect(visibleWidth(row)).toBe(3);
		}
		expect(grid[0]).not.toBe(grid[1]);
		// Every cell carries row then column diacritics: row 1, column 2 is U+10EEEE U+030D U+030E.
		expect(grid[1]).toContain(`${KITTY_PLACEHOLDER}\u030d\u030e`);
	});

	it("guards the diacritic table capacity", () => {
		expect(kittyPlaceholdersFit(1, 1)).toBe(true);
		expect(kittyPlaceholdersFit(KITTY_PLACEHOLDER_MAX_CELLS, KITTY_PLACEHOLDER_MAX_CELLS)).toBe(true);
		expect(kittyPlaceholdersFit(0, 5)).toBe(false);
		expect(kittyPlaceholdersFit(KITTY_PLACEHOLDER_MAX_CELLS + 1, 1)).toBe(false);
		expect(KITTY_PLACEHOLDER_MAX_CELLS).toBe(297);
	});

	it("is enabled only for terminals that render virtual placements, with env overrides", () => {
		for (const id of ["kitty", "ghostty", "rio", "otty", "tern"])
			expect(kittyPlaceholdersSupported(id, {})).toBe(true);
		for (const id of ["wezterm", "warp", "base", "iterm2", "alacritty"]) {
			expect(kittyPlaceholdersSupported(id, {})).toBe(false);
		}
		expect(kittyPlaceholdersSupported("kitty", { PI_NO_KITTY_PLACEHOLDERS: "1" })).toBe(false);
		expect(kittyPlaceholdersSupported("kitty", { PI_KITTY_PLACEHOLDERS: "off" })).toBe(false);
		expect(kittyPlaceholdersSupported("wezterm", { PI_KITTY_PLACEHOLDERS: "1" })).toBe(true);
		expect(kittyPlaceholdersSupported("kitty", { PI_NO_KITTY_PLACEHOLDERS: "1", PI_KITTY_PLACEHOLDERS: "1" })).toBe(
			false,
		);
	});

	it("follows multiplexer rules: forced kitty uses placeholders, Herdr distrusts leaked identities", () => {
		const tmuxEnv = { TMUX: "/tmp/tmux-1000/default,1,0" };
		expect(kittyPlaceholdersSupported("base", tmuxEnv)).toBe(false);
		expect(kittyPlaceholdersSupported("ghostty", tmuxEnv)).toBe(true);
		expect(kittyPlaceholdersSupported("base", { ...tmuxEnv, PI_FORCE_IMAGE_PROTOCOL: "kitty" })).toBe(true);
		expect(
			kittyPlaceholdersSupported("base", {
				...tmuxEnv,
				PI_FORCE_IMAGE_PROTOCOL: "kitty",
				PI_KITTY_PLACEHOLDERS: "0",
			}),
		).toBe(false);
		expect(kittyPlaceholdersSupported("ghostty", { HERDR_ENV: "1" })).toBe(false);
		expect(kittyPlaceholdersSupported("ghostty", { HERDR_PANE_ID: "p1", TMUX: tmuxEnv.TMUX })).toBe(false);
		expect(kittyPlaceholdersSupported("ghostty", { HERDR_ENV: "1", PI_KITTY_PLACEHOLDERS: "1" })).toBe(true);
		expect(kittyPlaceholdersSupported("ghostty", { HERDR_ENV: "1", PI_FORCE_IMAGE_PROTOCOL: "kitty" })).toBe(true);
	});
});

describe("fitImage", () => {
	const cell = { w: 10, h: 10 };

	it("keeps the intrinsic size without caps", () => {
		expect(fitImage(100, 100, {}, cell)).toEqual({ columns: 10, rows: 10, widthPx: 100, heightPx: 100 });
		expect(fitImage(95, 1, {}, cell)).toMatchObject({ columns: 10, rows: 1 });
	});

	it("scales to the tighter cap, keeping the aspect ratio", () => {
		expect(fitImage(100, 100, { maxColumns: 10, maxRows: 2 }, cell)).toEqual({
			columns: 2,
			rows: 2,
			widthPx: 20,
			heightPx: 20,
		});
		expect(fitImage(900, 220, { maxColumns: 90, maxRows: 11 }, { w: 10, h: 20 })).toEqual({
			columns: 90,
			rows: 11,
			widthPx: 900,
			heightPx: 220,
		});
	});

	it("scales small images up to the caps", () => {
		expect(fitImage(1, 1, { maxColumns: 4, maxRows: 4 }, cell)).toMatchObject({ columns: 4, rows: 4 });
	});

	it("assumes a 9x18 cell until one is reported", () => {
		expect(DEFAULT_CELL).toEqual({ w: 9, h: 18 });
	});
});

describe("anchored sequences", () => {
	it("reserves the rows above and draws from the last row, restoring the cursor", () => {
		expect(anchoredRows("SEQ", 3)).toEqual([RESERVED_ROW, RESERVED_ROW, "\x1b7\x1b[2ASEQ\x1b8"]);
		expect(anchoredRows("SEQ", 1)).toEqual(["SEQ"]);
		expect(reservedRows(2)).toEqual([RESERVED_ROW, RESERVED_ROW]);
	});

	it("encodes iTerm2 inline images with explicit cell width and height", () => {
		expect(itermImage("AA==", 2, 3)).toBe("\x1b]1337;File=inline=1;width=2;height=3:AA==\x07");
		expect(itermImage("AA==", 2, 3, "tmux")).toBe(tmux("\x1b]1337;File=inline=1;width=2;height=3:AA==\x07"));
	});

	it("blends SIXEL transparency against the reported background, else black or white by appearance", () => {
		expect(sixelBackground({ background: { r: 0x20, g: 0x20, b: 0x40 }, dark: true })).toBe(0x202040);
		expect(sixelBackground({ background: null, dark: true })).toBe(0);
		expect(sixelBackground({ background: null, dark: false })).toBe(0xffffff);
	});
});

describe.skipIf(!hasCorpus())("corpus: id-less kitty images", () => {
	const corpus = CORPUS_DIR;
	const IMAGE_ROW = /^(?:\x1b7\x1b\[(\d+)A)?\x1b_Ga=T,f=100,q=2,C=1,c=(\d+),r=(\d+)/;

	it("reproduces every transmit-and-display image the corpus captured", async () => {
		let checked = 0;
		for await (const file of new Glob("**/*.json").scan(corpus)) {
			const capture = (await Bun.file(path.join(corpus, file)).json()) as {
				stages?: { rows?: Record<string, string[]> }[];
			};
			for (const stage of capture.stages ?? []) {
				const byWidth = stage.rows ?? {};
				for (const width in byWidth) {
					const rows = byWidth[width]!;
					rows.forEach((row, index) => {
						const match = row.match(IMAGE_ROW);
						if (!match) return;
						const columns = Number(match[2]);
						const height = Number(match[3]);
						const data = [...row.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map(m => m[1]).join("");
						const expected = rows.slice(index - height + 1, index + 1);
						expect(anchoredRows(kittyTransmitAndDisplay(data, columns, height), height)).toEqual(expected);
						checked++;
					});
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});
});
