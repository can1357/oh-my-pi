/**
 * The attachment band's pictures: an image chip's card shows the image itself. Natively the card
 * holds an `image` node of a registered blob ahead of its size caption (Tern lays the tile out as
 * preview, then caption, and is only sent blobs it can read back); in the terminal the picture
 * sits between the card's borders where images draw as cells of text, else the chip glyph does.
 */
import { describe, expect, test } from "bun:test";
import { type Accessor, createRoot, isUiNode, type JSXNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { maskOverlayImages } from "@oh-my-pi/pi-tui/driver/images/viewport";
import { drawRow } from "@oh-my-pi/pi-tui/driver/output/ansi";
import { getBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { driverImages } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { CONSERVATIVE_EMOJI } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { Composer, ComposerChips } from "../../../src/ui/composer";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const KITTY_PLACEHOLDER = "\u{10EEEE}";

/** A node as the native backend describes it. */
interface NativeNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly NativeNode[];
}

function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).flatMap(nodes)];
}

/** A composer holding an image chip per size (`📷 #1`…, a picture of that size by its marker) and its band. */
function attached(...sizes: string[]): { composer: Composer; band: UiNode } {
	const composer = new Composer();
	for (const [i, size] of (sizes.length > 0 ? sizes : ["640x480"]).entries()) {
		composer.insertAtom(composer.chipLabel("image", i + 1), `[Image #${i + 1}, ${size}]`, {
			kind: "image",
			image: { type: "image", data: PNG_1PX, mimeType: "image/png" },
		});
	}
	const band: JSXNode = ComposerChips({ composer });
	if (!isUiNode(band)) throw new Error("the band is one node");
	return { composer, band };
}

/** A truecolor terminal drawing `images`, with 10×20 px cells. */
function capabilities(images: TerminalCapabilities["images"]): Accessor<TerminalCapabilities> {
	return signal<TerminalCapabilities>({
		truecolor: true,
		colors: 16_777_216,
		synchronizedOutput: true,
		hyperlinks: false,
		images,
		kittyKeyboard: true,
		bracketedPaste: true,
		background: null,
		dark: true,
		cell: { w: 10, h: 20 },
		multiplexer: null,
		textSizing: false,
		tsp: false,
		emoji: CONSERVATIVE_EMOJI,
	});
}

/** The band's chips on a SIXEL terminal whose encoder writes `w×h` as the picture, encodes awaited. */
async function sixelBand(...sizes: string[]): Promise<{ rows: (width: number) => string[]; dispose: () => void }> {
	const { band, dispose } = createRoot(dispose => ({ ...attached(...sizes), dispose }));
	const caps = capabilities("sixel");
	const images = new TerminalImages({
		capabilities: caps,
		placeholders: signal(false),
		encodeSixel: async (_bytes, w, h) => `\x1bPq${w}x${h}\x1b\\`,
	});
	const env = staticEnvironment(currentTheme(), { images: driverImages(images, caps) });
	const rows = (width: number): string[] => [...paintNode(env, band, width).rows];
	rows(40);
	await images.whenEncoded();
	return { rows, dispose };
}

describe("attachment band pictures", () => {
	test("an image chip's card holds its picture before the size caption, under a blob the terminal can be sent", () => {
		createRoot(dispose => {
			const { composer, band } = attached();
			const env = staticEnvironment(currentTheme());
			const [card] = (describeTree(band, env) as NativeNode).c ?? [];
			expect(card?.c?.map(child => child.k)).toEqual(["image", "text"]);
			const picture = card?.c?.[0]?.p;
			expect(picture).toMatchObject({ w: 640, h: 480, alt: composer.chipLabel("image", 1) });
			expect(card?.c?.[1]?.p).toMatchObject({ spans: [{ t: "640x480" }] });
			expect(card?.p?.kind).toBe("image");
			expect(card?.p).not.toHaveProperty("expansion");
			// The bytes are registered: the native backend uploads only blobs it can read back.
			const blob = String(picture?.blob);
			expect(Buffer.from(getBlob(blob)?.bytes ?? []).toString("base64")).toBe(PNG_1PX);
			// The token in the draft names the same blob (copying the token copies the image).
			const field = nodes(describeTree(composer.node, env) as NativeNode).find(node => node.k === "editor");
			expect(field?.p?.decor).toEqual([expect.objectContaining({ blob })]);
			dispose();
		});
	});

	test("the card draws the picture between its borders as cells of text, and the chip glyph where the terminal has none", () => {
		createRoot(dispose => {
			const { composer, band } = attached();
			const caps = capabilities("kitty");
			const placeholders = signal(false);
			const images = new TerminalImages({ capabilities: caps, placeholders });
			const env = staticEnvironment(currentTheme(), { images: driverImages(images, caps) });
			const glyph = composer.chipLabel("image", 1).split(" ")[0]!;
			/** The four rows between the card's top and bottom borders. */
			const interior = (): string[] => paintNode(env, band, 40).rows.slice(1, 5);

			// Placements address the screen and cannot sit between borders: the glyph, and nothing is sent.
			expect(interior().join("\n")).toContain(glyph);
			expect(interior().join("\n")).not.toContain(KITTY_PLACEHOLDER);
			expect(images.takeSequences()).toBe("");

			// 640×480 px on 10×20 cells fits the 12×4 interior as 10×4 cells: every row is the picture's.
			placeholders.set(true);
			const cells = interior().map(row => row.split(KITTY_PLACEHOLDER).length - 1);
			expect(cells).toEqual([10, 10, 10, 10]);
			expect(interior().join("\n")).not.toContain(glyph);
			expect(images.takeSequences()).toContain("a=t");
			dispose();
		});
	});

	test("on SIXEL the card draws the picture over blank cells, as wide as the borders", async () => {
		const band = await sixelBand();
		try {
			const drawn = band.rows(40);
			// 10×4 cells: every interior row holds 10 blank cells for the picture; the last steps back over
			// them, moves up 3 rows, draws and restores the cursor, then steps forward again.
			const interior = drawn.slice(1, 5);
			expect(interior[3]).toMatch(/ {10}\x1b\[10D\x1b7\x1b\[3A\x1bPq\d+x\d+\x1b\\\x1b8\x1b\[10C/);
			expect(interior.filter(row => row.includes("\x1bP"))).toHaveLength(1);
			for (const row of interior) expect(visibleWidth(row)).toBe(visibleWidth(drawn[0]!));
		} finally {
			band.dispose();
		}
	});

	test("on SIXEL a one-row wide picture draws with the cursor saved and restored around it", async () => {
		const band = await sixelBand("1568x200");
		try {
			// 12×1 cells, centred on the second interior row. Drawing a SIXEL moves the cursor, so
			// without the restore the rest of the row (the right border, the next cards) lands elsewhere.
			const interior = band.rows(40).slice(1, 5);
			expect(interior[1]).toMatch(/ {12}\x1b\[12D\x1b7\x1bPq\d+x\d+\x1b\\\x1b8\x1b\[12C/);
			expect(interior.filter(row => row.includes("\x1bP"))).toHaveLength(1);
		} finally {
			band.dispose();
		}
	});

	test("two SIXEL cards filling the terminal keep their borders and are masked one by one under a sheet", async () => {
		const band = await sixelBand("640x480", "640x480");
		try {
			// Two 14-cell cards two cells apart fill 30 columns exactly: no row is short of the width,
			// so the writer adds no erase to the right that would take the last card's right border.
			const rows = band.rows(30);
			for (const row of rows) expect(visibleWidth(row)).toBe(30);
			expect(rows.map(row => drawRow(row, 30)).filter(row => row.includes("\x1b[K"))).toEqual([]);
			const anchor = rows[4]!;
			expect(anchor.match(/\x1bPq/g)).toHaveLength(2);

			// A sheet over the first card: its picture goes, the second is drawn again after composition
			// at its own column, and the text under both stays as wide as before.
			const masked = [...rows];
			const restore = maskOverlayImages(masked, 0, rows.length, 0, 14, 10);
			expect(masked[4]!.match(/\x1bPq/g)).toBeNull();
			expect(visibleWidth(masked[4]!)).toBe(30);
			restore?.();
			expect(masked[4]!.match(/\x1bPq/g)).toHaveLength(1);
			// The second card's left border is column 16; its 10-cell picture is centred one cell in.
			expect(masked[4]).toContain(`\x1b[19G\x1b7\x1b[3A\x1bPq`);
		} finally {
			band.dispose();
		}
	});
});

describe("attachment band paste cards", () => {
	test("a paste card names its kind and carries the full pasted text", () => {
		createRoot(dispose => {
			const composer = new Composer();
			const pasted = "one\ntwo\nthree\nfour\nfive\nsix";
			composer.insertAtom(composer.chipLabel("paste", 1), pasted, { kind: "paste" });
			const band: JSXNode = ComposerChips({ composer });
			if (!isUiNode(band)) throw new Error("the band is one node");
			const [card] = (describeTree(band, staticEnvironment(currentTheme())) as NativeNode).c ?? [];
			expect(card?.p).toMatchObject({ kind: "paste", expansion: pasted });
			dispose();
		});
	});
});
