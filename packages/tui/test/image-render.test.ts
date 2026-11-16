import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ImageBudget, rasterizeSvg } from "@oh-my-pi/pi-natives";
import { Image, renderForScrollback } from "@oh-my-pi/pi-tui/components/image";
import { type CellDimensions, getCellDimensions, setCellDimensions } from "@oh-my-pi/pi-tui/inline-image";
import { ImageProtocol, setTerminalBackgroundColor, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { parseSixelPalettePercent } from "./helpers/sixel-palette";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
	kittyUnicodePlaceholders: boolean;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const BASE64_DUMMY = "AA==";
const SQUARE_DIMENSIONS = { widthPx: 100, heightPx: 100 };
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function parseKittyParam(sequence: string, key: "c" | "r"): number | null {
	const match = sequence.match(new RegExp(`${key}=(\\d+)`));
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

/** A uniform translucent image has one SIXEL palette color, in RGB percentages. */
function sixelColor(rows: readonly string[]): [number, number, number] {
	const parsed = parseSixelPalettePercent(rows);
	if (!parsed) throw new Error("missing SIXEL palette");
	return parsed;
}

async function translucentImage(requestRender: () => void): Promise<Image> {
	const png = await rasterizeSvg(
		new TextEncoder().encode(
			'<svg width="16" height="12"><rect width="16" height="12" fill="white" opacity="0.25"/></svg>',
		),
		16,
		12,
		1,
	);
	return new Image(
		png.toBase64(),
		"image/png",
		{ fallbackColor: text => text },
		{ maxWidthCells: 8, maxHeightCells: 2, requestRender },
		{ widthPx: 16, heightPx: 12 },
	);
}

describe("terminal image rendering", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;
	const originalPlaceholders = TERMINAL.kittyUnicodePlaceholders;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = null;
		terminal.kittyUnicodePlaceholders = false;
	});

	afterEach(() => {
		setTerminalBackgroundColor(undefined);
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		terminal.kittyUnicodePlaceholders = originalPlaceholders;
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
		terminal.kittyUnicodePlaceholders = false;
		const budget = new ImageBudget(1);
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ budget, imageKey: "placeholder-cache", maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		const direct = image.render(20).join("");
		expect(direct).toContain("\x1b_Ga=p");

		terminal.kittyUnicodePlaceholders = true;
		const placeholder = image.render(20).join("");

		expect(placeholder).toContain("U=1");
		expect(placeholder).not.toBe(direct);
	});

	it("replays released image rows without replacing graphics or retransmitting image data", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const budget = new ImageBudget(1);
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ budget, imageKey: "released-image", maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		const first = image.render(20);
		expect(first.join("")).toContain("\x1b_Ga=p");
		// The data rides the budget's one-time transmit, never the rows.
		expect(first.join("")).not.toContain(BASE64_ONE_PIXEL_PNG);
		expect(budget.shouldTransmit(budget.acquireId("released-image"))).toBe(false);

		image.releaseRenderCaches();
		expect(image.render(20)).toEqual(first);
	});

	it("keeps a demoted image's drawn height only within a lowered row ceiling", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const budget = new ImageBudget(1);
		const theme = { fallbackColor: (text: string) => text };
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			theme,
			{ budget, imageKey: "shrunk", maxHeightCells: 10 },
			SQUARE_DIMENSIONS,
		);
		const newer = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			theme,
			{ budget, imageKey: "newer", maxHeightCells: 1 },
			SQUARE_DIMENSIONS,
		);
		budget.beginPass();
		expect(image.render(20)).toHaveLength(10);
		budget.endPass();

		image.setMaxHeightCells(2);
		budget.beginPass();
		expect(image.render(20)).toHaveLength(2);
		newer.render(20);
		expect(budget.endPass()).toBe(true);
		budget.beginPass();
		const demoted = image.render(20);
		newer.render(20);
		budget.endPass();
		expect(demoted).toHaveLength(2);
		expect(demoted.at(-1)).toContain("[Image:");
	});

	it("recomposites a cached SIXEL using the latest background after rapid changes", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		setCellDimensions({ widthPx: 2, heightPx: 6 });
		setTerminalBackgroundColor(0);
		let encoded = Promise.withResolvers<void>();
		const image = await translucentImage(() => encoded.resolve());

		image.render(10);
		await encoded.promise;
		expect(sixelColor(image.render(10))).toEqual([25, 25, 25]);

		encoded = Promise.withResolvers<void>();
		setTerminalBackgroundColor(0x202040);
		expect(image.render(10).join("")).not.toContain("\x1bP");
		setTerminalBackgroundColor(0xffffff);
		expect(image.render(10).join("")).not.toContain("\x1bP");
		await encoded.promise;
		expect(sixelColor(image.render(10))).toEqual([100, 100, 100]);
	});

	it("commits SIXEL scrollback pixels against the new background rather than a cached old one", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		setCellDimensions({ widthPx: 2, heightPx: 6 });
		setTerminalBackgroundColor(0);
		const image = await translucentImage(() => {});
		expect(sixelColor(renderForScrollback(() => image.render(10)))).toEqual([25, 25, 25]);
		setTerminalBackgroundColor(0x202040);
		const color = sixelColor(renderForScrollback(() => image.render(10)));
		expect(color[0]).toBeCloseTo(35, 0);
		expect(color[1]).toBeCloseTo(35, 0);
		expect(color[2]).toBeCloseTo(44, 0);
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
