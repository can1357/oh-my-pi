/**
 * The attachment band's pictures: an image chip's card shows the image itself. Natively the card
 * holds an `image` node of a registered blob ahead of its size caption (Tern lays the tile out as
 * preview, then caption, and is only sent blobs it can read back); in the terminal the picture
 * sits between the card's borders where images draw as cells of text, else the chip glyph does.
 */
import { describe, expect, test } from "bun:test";
import { createRoot, isUiNode, type JSXNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
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

/** A composer holding one image chip (`📷 #1`, a picture of `size` by its marker) and its band. */
function attached(size = "640x480"): { composer: Composer; band: UiNode } {
	const composer = new Composer();
	composer.insertAtom(composer.chipLabel("image", 1), `[Image #1, ${size}]`, {
		kind: "image",
		image: { type: "image", data: PNG_1PX, mimeType: "image/png" },
	});
	const band: JSXNode = ComposerChips({ composer });
	if (!isUiNode(band)) throw new Error("the band is one node");
	return { composer, band };
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
			const caps = signal<TerminalCapabilities>({
				truecolor: true,
				colors: 16_777_216,
				synchronizedOutput: true,
				hyperlinks: false,
				images: "kitty",
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

	test("on SIXEL the card draws the picture anchored between its borders, stepping over its cells", async () => {
		const { composer, band } = createRoot(() => attached());
		const caps = signal<TerminalCapabilities>({
			truecolor: true,
			colors: 16_777_216,
			synchronizedOutput: true,
			hyperlinks: false,
			images: "sixel",
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
		const images = new TerminalImages({
			capabilities: caps,
			placeholders: signal(false),
			encodeSixel: async (_bytes, w, h) => `\x1bPq${w}x${h}\x1b\\`,
		});
		const env = staticEnvironment(currentTheme(), { images: driverImages(images, caps) });
		const glyph = composer.chipLabel("image", 1).split(" ")[0]!;
		const rows = (): readonly string[] => paintNode(env, band, 40).rows;

		// Encoding: the glyph holds the card.
		expect(rows().slice(1, 5).join("\n")).toContain(glyph);
		await images.whenEncoded();
		const drawn = rows();
		// 10×4 cells: the last interior row moves up 3 rows and draws; every image row steps 10 cells.
		const interior = drawn.slice(1, 5);
		expect(interior.join("\n")).not.toContain(glyph);
		expect(interior[3]).toMatch(/\x1b7\x1b\[3A\x1bPq\d+x\d+\x1b\\\x1b8/);
		for (const row of interior) {
			expect(row).toContain("\x1b[10C");
			// The step stands for the picture's 10 cells: with it the row is as wide as the borders.
			expect(visibleWidth(row) + 10).toBe(visibleWidth(drawn[0]!));
		}
	});

	test("on SIXEL a one-row wide picture draws with the cursor saved and restored around it", async () => {
		const { band } = createRoot(() => attached("1568x200"));
		const caps = signal<TerminalCapabilities>({
			truecolor: true,
			colors: 16_777_216,
			synchronizedOutput: true,
			hyperlinks: false,
			images: "sixel",
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
		const images = new TerminalImages({
			capabilities: caps,
			placeholders: signal(false),
			encodeSixel: async (_bytes, w, h) => `\x1bPq${w}x${h}\x1b\\`,
		});
		const env = staticEnvironment(currentTheme(), { images: driverImages(images, caps) });
		paintNode(env, band, 40);
		await images.whenEncoded();
		// 12×1 cells, centred on the second interior row. Drawing a SIXEL moves the cursor, so
		// without the restore the rest of the row (the right border, the next cards) lands elsewhere.
		const interior = paintNode(env, band, 40).rows.slice(1, 5);
		expect(interior[1]).toMatch(/\x1b7\x1bPq\d+x\d+\x1b\\\x1b8\x1b\[12C/);
		expect(interior.filter(row => row.includes("\x1bP"))).toHaveLength(1);
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
