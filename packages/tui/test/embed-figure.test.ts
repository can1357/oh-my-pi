import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { EmbedFigure } from "@oh-my-pi/pi-tui/chat/embed-figure";
import { setEmbedHost } from "@oh-my-pi/pi-tui/chat/embed-host";
import { type Embed, splitEmbeds } from "@oh-my-pi/pi-tui/chat/embed-source";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import {
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const WIDTH = 120;

/** The one embed `tag` is. */
function embedOf(tag: string): Embed {
	const [segment] = splitEmbeds(tag);
	if (segment?.kind !== "embed") throw new Error(`not an embed: ${tag}`);
	return segment.embed;
}

/** A figure showing `tag`, and a promise of its next change. */
function figureOf(tag: string, showImages = true): { figure: EmbedFigure; changed: () => Promise<void> } {
	let resolve = () => {};
	const figure = new EmbedFigure({ showImages, maxRows: () => 30, onChange: () => resolve() });
	const changed = () => {
		const next = Promise.withResolvers<void>();
		resolve = next.resolve;
		return next.promise;
	};
	figure.update(embedOf(tag));
	return { figure, changed };
}

/** Columns and rows of the Kitty placement in `rows`. */
function placement(rows: readonly string[]): { columns: number; rows: number } | undefined {
	const match = /c=(\d+),r=(\d+)/.exec(rows.join("\n"));
	return match ? { columns: Number(match[1]), rows: Number(match[2]) } : undefined;
}

describe("EmbedFigure", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalCell = { ...getCellDimensions() };
	let png: Uint8Array;
	let captures: string[];

	beforeAll(async () => {
		await initTheme(false);
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#08f"/></svg>`;
		png = await rasterizeSvg(new TextEncoder().encode(svg), 4096, 4096);
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setCellDimensions({ widthPx: 16, heightPx: 36 });
		applyHyperlinkSetting("always");
		captures = [];
		setEmbedHost({
			cwd: () => process.cwd(),
			capturePage: async url => {
				captures.push(url);
				if (url.includes("down")) throw new Error("no Chromium installed");
				return png;
			},
		});
	});

	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		setCellDimensions(originalCell);
		applyHyperlinkSetting("auto");
		setEmbedHost(undefined);
	});

	it("draws an image at its natural size, or fitted to its stated width", async () => {
		const src = `data:image/png;base64,${png.toBase64()}`;
		const natural = figureOf(`<img src="${src}" alt="Bar chart">`);
		const landed = natural.changed();
		expect(natural.figure.render(WIDTH).join("\n")).toContain("Bar chart — loading…");
		expect(natural.figure.pending).toBe(true);
		await landed;
		// 200×100 CSS px: 16 px to the row, cells twice as tall as wide.
		expect(placement(natural.figure.render(WIDTH))).toEqual({ columns: 27, rows: 6 });
		expect(natural.figure.pending).toBe(false);

		const sized = figureOf(`<img src="${src}" width="50%">`);
		await sized.changed();
		expect(placement(sized.figure.render(WIDTH))?.columns).toBe(59);
	});

	it("shows an iframe as one screenshot over a row linking to its page", async () => {
		const { figure, changed } = figureOf(`<iframe src="https://example.com/docs" title="Docs"></iframe>`);
		const landed = changed();
		const loading = figure.render(WIDTH);
		expect(loading).toHaveLength(1);
		expect(loading[0]).toContain("Docs — capturing…");
		await landed;
		const rows = figure.render(WIDTH);
		expect(placement(rows.slice(0, -1))).toBeDefined();
		expect(rows.at(-1)).toContain("[Visit]");
		expect(rows.at(-1)).toContain("https://example.com/docs");
		expect(captures).toEqual(["https://example.com/docs"]);
	});

	it("keeps the link and says why when the page cannot be captured", async () => {
		const { figure, changed } = figureOf(`<iframe src="https://down.example/"></iframe>`);
		await changed();
		const rows = figure.render(WIDTH);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("couldn't capture: no Chromium installed");
		expect(rows[0]).toContain("[Visit]");
		expect(figure.pending).toBe(false);
	});

	it("stands in as a note, loading nothing, where pictures do not show", () => {
		setTerminalImageProtocol(null);
		const { figure } = figureOf(`<iframe src="https://example.com/quiet" title="Quiet"></iframe>`);
		const rows = figure.render(WIDTH);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Quiet");
		expect(rows[0]).toContain("[Visit]");
		expect(figure.pending).toBe(false);
		expect(captures).toEqual([]);
	});
});
