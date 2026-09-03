import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image, ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	isWindowsTerminalPreviewSixelSupported,
	renderImage,
	setCellDimensions,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const BASE64_DUMMY = "AA==";
const SQUARE_DIMENSIONS = { widthPx: 100, heightPx: 100 };
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const ORIGINAL_TMUX = Bun.env.TMUX;

function parseKittyParam(sequence: string, key: "c" | "r" | "C"): number | null {
	const match = sequence.match(new RegExp(`${key}=(\\d+)`));
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

function parseITermWidth(sequence: string): string | null {
	const match = sequence.match(/width=([^;:]+)/);
	return match?.[1] ?? null;
}

describe("terminal image rendering", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;
	const originalGraphics = { ...getKittyGraphics() };

	beforeEach(() => {
		delete Bun.env.TMUX;
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = null;
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		setKittyGraphics(originalGraphics);
		if (ORIGINAL_TMUX === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = ORIGINAL_TMUX;
	});

	it("fits Kitty images within max width and max height while preserving aspect ratio", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(2);
	});

	it("anchors Kitty display commands before renderer-managed cursor movement", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(parseKittyParam(result?.sequence ?? "", "C")).toBe(1);
	});

	it("re-renders a cached fallback once an image protocol becomes available", () => {
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		expect(image.render(20).join("")).toContain("[Image:");

		terminal.imageProtocol = ImageProtocol.Kitty;
		const rerendered = image.render(20).join("");

		expect(rerendered).toContain("\x1b_Ga=T");
		expect(rerendered).toContain("C=1");
	});

	it("re-renders a cached image when cell dimensions change", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 10 },
			SQUARE_DIMENSIONS,
		);

		const first = image.render(20).join("");
		expect(parseKittyParam(first, "c")).toBe(10);

		setCellDimensions({ widthPx: 20, heightPx: 10 });
		const second = image.render(20).join("");

		expect(parseKittyParam(second, "c")).toBe(5);
	});

	it("re-renders a cached Kitty image when Unicode placeholder support changes", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: false });
		const budget = new ImageBudget(1, () => {});
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ budget, imageKey: "placeholder-cache", maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		const direct = image.render(20).join("");
		expect(direct).toContain("\x1b_Ga=p");

		setKittyGraphics({ unicodePlaceholders: true });
		const placeholder = image.render(20).join("");

		expect(placeholder).toContain("U=1");
		expect(placeholder).not.toBe(direct);
	});

	it("uses intrinsic image size when no bounds are provided", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS);

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(10);
	});

	it("transmits stable Kitty images in-band before placement", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			imageId: 42,
			includeTransmit: true,
		});

		expect(result).not.toBeNull();
		expect(result?.transmit).toBe(`\x1b_Ga=t,f=100,q=2,i=42;${BASE64_ONE_PIXEL_PNG}\x1b\\`);
		expect(result?.transmit).not.toContain("t=t");
	});

	it("reduces iTerm2 width when max height is the limiting bound", () => {
		terminal.imageProtocol = ImageProtocol.Iterm2;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseITermWidth(result?.sequence ?? "")).toBe("2");
		expect(result?.sequence).toContain("height=auto");
	});

	it("encodes SIXEL output when protocol is SIXEL", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const result = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		// SIXEL height is rounded DOWN to a multiple of 6 (band size) so it
		// never exceeds the caller's maxHeightCells cap. With 10px cells and
		// maxHeightCells=2, targetHeightPx=18 (not 20), rows=2 — within cap.
		expect(result?.rows).toBe(2);
		expect((result?.sequence ?? "").startsWith("\x1bP")).toBe(true);
	});

	it("moves back up before multi-row direct Kitty output and restores the cursor below it", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 3 },
			SQUARE_DIMENSIONS,
		);

		const lines = image.render(20);
		const imageLine = lines.at(-1) ?? "";

		expect(lines).toHaveLength(3);
		expect(lines.slice(0, -1)).toEqual(["\x1b[0m", "\x1b[0m"]);
		expect(imageLine.startsWith("\x1b7\x1b[2A")).toBe(true);
		expect(imageLine).toContain("\x1b_Ga=T");
		expect(imageLine).toContain("C=1");
		expect(imageLine).toContain("c=3");
		expect(imageLine).toContain("r=3");
		expect(imageLine.endsWith("\x1b8")).toBe(true);
	});

	it("does not emit cursor movement around single-row direct Kitty output", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 1 },
			SQUARE_DIMENSIONS,
		);

		const lines = image.render(20);
		const imageLine = lines.at(-1) ?? "";

		expect(lines).toHaveLength(1);
		expect(imageLine.startsWith("\x1b_Ga=T")).toBe(true);
		expect(imageLine).toContain("C=1");
		expect(imageLine).toContain("c=1");
		expect(imageLine).toContain("r=1");
		expect(imageLine.endsWith("\x1b\\")).toBe(true);
		expect(imageLine).not.toContain("\x1b[0A");
		expect(imageLine).not.toContain("\x1b[0B");
		expect(imageLine).not.toMatch(/\x1b\[\d+[AB]/);
	});
});

describe("Windows Terminal Preview SIXEL detection", () => {
	it("requires Windows platform, WT session, and known version 1.22+", () => {
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"win32",
			),
		).toBe(true);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.21.0.0" },
				"win32",
			),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported({ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal" }, "win32"),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"linux",
			),
		).toBe(false);
	});
});

describe("isImageLine — composed placeholder rows", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
	});

	it("keeps deeply prefixed Kitty placeholder rows on the verbatim image-line path", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		// Composer attachment chip interior row: border SGR + │ + reset + pad +
		// image-id fg + placement-id underline put the first placeholder cell at
		// code unit 63 — past the old 64-unit needle window, which silently sent
		// the row through SGR coalescing/truncation instead of verbatim output.
		const cells = "\u{10eeee}\u030d\u0305".repeat(9);
		const chipRow = `\x1b[38;2;255;179;102m│\x1b[39m \x1b[38;2;122;231;55m\x1b[58:2::122:231:55m${cells}\x1b[39;59m  \x1b[38;2;255;179;102m│\x1b[39m`;
		expect(TERMINAL.isImageLine(chipRow)).toBe(true);
		// Second card in the band: the needle sits hundreds of units in.
		const secondCard = `${chipRow}  ${chipRow}`;
		expect(TERMINAL.isImageLine(secondCard.slice(chipRow.length + 2))).toBe(true);
		expect(TERMINAL.isImageLine(secondCard)).toBe(true);
	});

	it("still rejects plain styled text rows", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		expect(TERMINAL.isImageLine("\x1b[38;2;255;179;102m│\x1b[39m plain text row")).toBe(false);
	});
});
