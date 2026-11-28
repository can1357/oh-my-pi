import { describe, expect, it } from "bun:test";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { type Accessor, computed, createRoot, type Signal, signal } from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { anchoredRows, RESERVED_ROW } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { itermImage } from "@oh-my-pi/pi-tui/driver/images/iterm";
import { kittyDelete, kittyDeleteAll, kittyTransmit, kittyVirtualPlace } from "@oh-my-pi/pi-tui/driver/images/kitty";
import {
	type ImageRequest,
	type ImageRows,
	type ImageSource,
	TerminalImages,
	type TerminalImagesOptions,
} from "@oh-my-pi/pi-tui/driver/images/store";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function capabilities(overrides: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
	return {
		truecolor: true,
		colors: 16_777_216,
		synchronizedOutput: true,
		hyperlinks: true,
		images: "kitty",
		kittyKeyboard: true,
		bracketedPaste: true,
		background: null,
		dark: true,
		cell: { w: 10, h: 10 },
		multiplexer: null,
		textSizing: false,
		tsp: false,
		emoji: { vs16Wide: false, bareFits: false },
		styledUnderlines: false,
		...overrides,
	};
}

function image(key: string, data = PNG_1PX, size = 100): ImageSource {
	return { key, data, mime: "image/png", widthPx: size, heightPx: size };
}

interface Painted {
	readonly block: Accessor<ImageRows>;
	readonly dispose: () => void;
}

/** A painter-like computation drawing one image, cached until its reads change. */
function paint(images: TerminalImages, source: ImageSource, request: ImageRequest): Painted {
	return createRoot(dispose => ({ block: computed(() => images.rows(source, request)), dispose }));
}

interface Rig {
	readonly caps: Signal<TerminalCapabilities>;
	readonly placeholders: Signal<boolean>;
	readonly images: TerminalImages;
}

function rig(overrides: Partial<TerminalCapabilities> = {}, options: Partial<TerminalImagesOptions> = {}): Rig {
	const caps = signal(capabilities(overrides));
	const placeholders = signal(false);
	const images = new TerminalImages({ capabilities: caps, placeholders, ...options });
	return { caps, placeholders, images };
}

/** One frame: paint every block, settle (repainting while the budget moves), then take the sequences. */
function frame(images: TerminalImages, blocks: readonly Painted[]): { rows: ImageRows[]; sequences: string } {
	let rows = blocks.map(b => b.block());
	for (let i = 0; i < 4 && images.settle(); i++) rows = blocks.map(b => b.block());
	return { rows, sequences: images.takeSequences() };
}

const ids = (sequences: string, action: string) =>
	[...sequences.matchAll(new RegExp(`\\x1b_Ga=${action}[^\\x1b]*?i=(\\d+)`, "g"))].map(m => Number(m[1]));

describe("TerminalImages: kitty", () => {
	it("transmits once by id and draws rows of per-row placements", () => {
		const { images } = rig();
		const block = paint(images, image("a"), { maxColumns: 4, maxRows: 2, fallback: "[a]" });
		const first = frame(images, [block]);
		const [id] = ids(first.sequences, "t");
		expect(first.sequences).toBe(kittyTransmit(PNG_1PX, id!));
		expect(first.rows[0]).toEqual({
			rows: [
				`\x1b_Ga=p,q=2,C=1,i=${id},p=1,x=0,y=0,w=100,h=50,c=2,r=1\x1b\\`,
				`\x1b_Ga=p,q=2,C=1,i=${id},p=2,x=0,y=50,w=100,h=50,c=2,r=1\x1b\\`,
			],
			columns: 2,
			state: "image",
		});
		// Later frames, and other painters of the same image, reuse the data.
		const twin = paint(images, image("a"), { maxColumns: 4, maxRows: 4, fallback: "[a]" });
		const second = frame(images, [block, twin]);
		expect(second.sequences).toBe("");
		expect(second.rows[1]!.rows).toHaveLength(4);
		expect(second.rows[1]!.rows[0]).toContain(`i=${id},p=4097,`);
	});

	it("draws Unicode placeholder rows and sends one virtual placement per cell box", () => {
		const { images, placeholders } = rig();
		placeholders.set(true);
		const block = paint(images, image("a"), { maxColumns: 3, maxRows: 2, fallback: "[a]" });
		const { rows, sequences } = frame(images, [block]);
		const [id] = ids(sequences, "t");
		expect(sequences).toBe(
			kittyTransmit(PNG_1PX, id!) + kittyVirtualPlace({ id: id!, placement: 1, columns: 2, rows: 2 }),
		);
		expect(rows[0]!.rows).toHaveLength(2);
		expect(rows[0]!.rows[0]).toContain("\u{10EEEE}");
		expect(frame(images, [block]).sequences).toBe("");
	});

	it("draws a cells-only request as placeholders, and without them shows the fallback and sends the terminal nothing", () => {
		const { images, placeholders } = rig();
		const request = { maxColumns: 3, maxRows: 2, fallback: "[a]", cells: true };
		const block = paint(images, image("a"), request);
		// Placements address the screen: nothing can share their rows, so the caller draws its own fallback.
		const direct = frame(images, [block]);
		expect(direct.rows[0]).toEqual({ rows: ["[a]"], columns: 3, state: "fallback" });
		expect(direct.sequences).toBe("");

		placeholders.set(true);
		const placed = frame(images, [block]);
		expect(placed.rows[0]!.state).toBe("image");
		expect(placed.rows[0]!.rows.every(row => row.includes("\u{10EEEE}"))).toBe(true);
		expect(ids(placed.sequences, "t")).toHaveLength(1);

		// An anchored sequence (iTerm2, SIXEL) is no cell of text either.
		const iterm = rig({ images: "iterm" });
		expect(frame(iterm.images, [paint(iterm.images, image("a"), request)]).rows[0]!.state).toBe("fallback");
	});

	it("switches placement style when placeholder support changes", () => {
		const { images, placeholders } = rig();
		const block = paint(images, image("a"), { maxColumns: 2, maxRows: 2, fallback: "[a]" });
		const direct = frame(images, [block]).rows[0]!.rows.join("");
		expect(direct).toContain("\x1b_Ga=p,q=2,C=1");
		placeholders.set(true);
		const placeholder = frame(images, [block]);
		expect(placeholder.rows[0]!.rows.join("")).toContain("\u{10EEEE}");
		expect(placeholder.sequences).toContain("U=1");
		expect(ids(placeholder.sequences, "t")).toEqual([]);
	});

	it("wraps transmits, placements and deletes for tmux", () => {
		const { images } = rig({ multiplexer: "tmux" });
		const block = paint(images, image("a"), { maxColumns: 1, maxRows: 1, fallback: "[a]" });
		const { rows, sequences } = frame(images, [block]);
		expect(sequences.startsWith("\x1bPtmux;\x1b\x1b_Ga=t,")).toBe(true);
		expect(rows[0]!.rows[0]!.startsWith("\x1bPtmux;\x1b\x1b_Ga=p,")).toBe(true);
		block.dispose();
		expect(images.purge().startsWith("\x1bPtmux;\x1b\x1b_Ga=d,d=I,")).toBe(true);
	});

	it("converts non-PNG data to PNG for kitty, reserving the rows meanwhile", async () => {
		const inputs: string[] = [];
		const { images } = rig(
			{},
			{ convertPng: async bytes => (inputs.push(Buffer.from(bytes).toString("base64")), PNG_1PX) },
		);
		const jpeg = { ...image("j", "/9j/AA=="), mime: "image/jpeg" };
		const block = paint(images, jpeg, { maxColumns: 2, fallback: "[Image: jpeg]" });
		const first = frame(images, [block]);
		expect(first.rows[0]!.state).toBe("pending");
		expect(first.rows[0]!.rows.every(row => row === RESERVED_ROW)).toBe(true);
		expect(first.sequences).toBe("");
		await images.whenEncoded();
		const drawn = frame(images, [block]);
		expect(inputs).toEqual(["/9j/AA=="]);
		expect(drawn.rows[0]!.state).toBe("image");
		const [id] = ids(drawn.sequences, "t");
		expect(drawn.sequences).toBe(kittyTransmit(PNG_1PX, id!));
	});

	it("falls back to the label when the PNG conversion fails", async () => {
		const { images } = rig({}, { convertPng: async () => Promise.reject(new Error("bad")) });
		const block = paint(images, { ...image("j"), mime: "image/webp" }, { maxColumns: 20, fallback: "[webp]" });
		frame(images, [block]);
		await images.whenEncoded();
		const { rows, sequences } = frame(images, [block]);
		expect(rows[0]!.state).toBe("fallback");
		expect(rows[0]!.rows[0]).toBe("[webp]");
		expect(sequences).toBe("");
	});

	it("tracks transmits per screen: the alternate screen starts with an empty store", () => {
		const { images } = rig();
		const block = paint(images, image("a"), { maxColumns: 2, fallback: "[a]" });
		const [id] = ids(frame(images, [block]).sequences, "t");
		const transmit = kittyTransmit(PNG_1PX, id!);
		// Drawn on the alternate screen: sent there once, the main screen keeps its copy.
		expect(images.takeSequences("alternate")).toBe(transmit);
		expect(images.takeSequences("alternate")).toBe("");
		expect(images.takeSequences("main")).toBe("");
		// Every switch to the alternate screen empties its store.
		images.enteredAlternate();
		expect(images.takeSequences("alternate")).toBe(transmit);
		expect(images.takeSequences("main")).toBe("");
	});

	it("after an erase of the main screen deletes everything first, then transmits again", () => {
		const { images } = rig();
		const block = paint(images, image("a"), { maxColumns: 2, fallback: "[a]" });
		const [id] = ids(frame(images, [block]).sequences, "t");
		images.cleared();
		expect(images.takeSequences("main")).toBe(kittyDeleteAll() + kittyDelete(id!) + kittyTransmit(PNG_1PX, id!));
		expect(images.takeSequences("main")).toBe("");
	});

	it("keeps kitty rows reserved and transmits nothing until the terminal is ready", () => {
		const ready = signal(false);
		const { images } = rig({}, { kittyReady: ready });
		const block = paint(images, image("a"), { maxColumns: 2, fallback: "[a]" });
		const held = frame(images, [block]);
		expect(held.rows[0]!.state).toBe("pending");
		expect(held.sequences).toBe("");
		ready.set(true);
		const drawn = frame(images, [block]);
		expect(drawn.rows[0]!.state).toBe("image");
		expect(ids(drawn.sequences, "t")).toHaveLength(1);
	});
	it("re-transmits drawn images after a display reset and frees them on purge", () => {
		const { images } = rig();
		const block = paint(images, image("a"), { maxColumns: 2, fallback: "[a]" });
		const [id] = ids(frame(images, [block]).sequences, "t");
		images.reset();
		expect(frame(images, [block]).sequences).toBe(kittyDelete(id!) + kittyTransmit(PNG_1PX, id!));
		expect(images.purge()).toBe(kittyDelete(id!));
		expect(images.purge()).toBe("");
	});

	it("hands out distinct ids per key, and different id ranges per store", () => {
		const { images } = rig();
		const blocks = ["a", "b", "c"].map(key => paint(images, image(key), { maxColumns: 1, fallback: key }));
		const sent = ids(frame(images, blocks).sequences, "t");
		expect(new Set(sent).size).toBe(3);
		const other = rig().images;
		const otherSent = ids(frame(other, [paint(other, image("a"), { maxColumns: 1, fallback: "a" })]).sequences, "t");
		expect(otherSent[0]).not.toBe(sent[0]);
	});
});

describe("TerminalImages: budget", () => {
	it("draws the newest `budget` images and shows older ones as fallback rows of the same height", () => {
		const { images } = rig({}, { budget: 2 });
		const request = (key: string): ImageRequest => ({ maxColumns: 12, maxRows: 3, fallback: `[Image: ${key}]` });
		const a = paint(images, image("a"), request("a"));
		const b = paint(images, image("b"), request("b"));
		const first = frame(images, [a, b]);
		const [idA] = ids(first.sequences, "t");
		expect(first.rows.map(r => r.state)).toEqual(["image", "image"]);

		const c = paint(images, image("c"), request("c"));
		const second = frame(images, [a, b, c]);
		expect(second.rows.map(r => r.state)).toEqual(["fallback", "image", "image"]);
		expect(second.rows[0]!.rows).toEqual(["[Image: a]", RESERVED_ROW, RESERVED_ROW]);
		// The demoted image is freed before the new one arrives.
		expect(ids(second.sequences, "d")).toEqual([idA!]);
		expect(ids(second.sequences, "t")).toHaveLength(1);
		expect(second.sequences.indexOf("a=d")).toBeLessThan(second.sequences.indexOf("a=t"));

		// Steady state: nothing moves, nothing is sent.
		expect(frame(images, [a, b, c]).sequences).toBe("");
	});

	it("restores a demoted image (re-transmitting it) once a newer one goes away", () => {
		const { images } = rig({}, { budget: 1 });
		const a = paint(images, image("a"), { maxColumns: 2, fallback: "[a]" });
		const b = paint(images, image("b"), { maxColumns: 2, fallback: "[b]" });
		const before = frame(images, [a, b]);
		expect(before.rows.map(r => r.state)).toEqual(["fallback", "image"]);
		const idB = ids(before.sequences, "t").at(-1)!;

		b.dispose();
		const after = frame(images, [a]);
		expect(after.rows[0]!.state).toBe("image");
		// b stays resident for scrollback until the cap needs its slot; a comes back.
		const sentA = ids(after.sequences, "t");
		expect(sentA).toHaveLength(1);
		expect(ids(after.sequences, "d")).toEqual([idB]);
	});

	it("keeps unreferenced (retired) images resident up to the budget, freeing the oldest first", () => {
		const { images } = rig({}, { budget: 2 });
		const painted = ["a", "b"].map(key => paint(images, image(key), { maxColumns: 1, fallback: key }));
		const [idA, idB] = ids(frame(images, painted).sequences, "t");
		for (const block of painted) block.dispose();
		expect(frame(images, []).sequences).toBe("");

		const c = paint(images, image("c"), { maxColumns: 1, fallback: "c" });
		const third = frame(images, [c]);
		expect(ids(third.sequences, "d")).toEqual([idA!]);
		expect(ids(third.sequences, "t")).toHaveLength(1);
		expect(images.purge()).toBe(kittyDelete(idB!) + kittyDelete(ids(third.sequences, "t")[0]!));
	});

	it("treats a budget of 0 as unlimited and applies budget changes on the next settle", () => {
		const { images } = rig({}, { budget: 0 });
		const blocks = ["a", "b", "c", "d"].map(key => paint(images, image(key), { maxColumns: 1, fallback: key }));
		expect(frame(images, blocks).rows.every(r => r.state === "image")).toBe(true);
		images.setBudget(1);
		expect(frame(images, blocks).rows.map(r => r.state)).toEqual(["fallback", "fallback", "fallback", "image"]);
	});

	it("demotes SIXEL and iTerm2 images too", () => {
		const { images } = rig({ images: "iterm" }, { budget: 1 });
		const a = paint(images, image("a"), { maxColumns: 4, maxRows: 2, fallback: "[a]" });
		const b = paint(images, image("b"), { maxColumns: 4, maxRows: 2, fallback: "[b]" });
		const { rows, sequences } = frame(images, [a, b]);
		expect(rows[0]!.rows).toEqual(["[a]", RESERVED_ROW]);
		expect(rows[1]!.rows).toEqual([
			RESERVED_ROW,
			`\x1b7\x1b[1A\x1b]1337;File=inline=1;width=2;height=2:${PNG_1PX}\x07\x1b8`,
		]);
		expect(sequences).toBe("");
	});
});

describe("TerminalImages: fallback and SIXEL", () => {
	it("shows the label alone when the terminal draws no images", () => {
		const { images, caps } = rig({ images: null });
		const block = paint(images, image("a"), { maxColumns: 8, fallback: "[Image: a.png]" });
		expect(block.block()).toEqual({ rows: ["[Image:…"], columns: 8, state: "fallback" });
		caps.set(capabilities());
		expect(block.block().state).toBe("image");
	});

	it("reserves rows while encoding, then draws the SIXEL at the fitted pixel size", async () => {
		const requests: [number, number, number][] = [];
		const { images } = rig(
			{ images: "sixel", cell: { w: 10, h: 20 } },
			{
				encodeSixel: async (_bytes, w, h, bg) => {
					requests.push([w, h, bg]);
					return "\x1bPq#0~\x1b\\";
				},
			},
		);
		const source = { ...image("s"), widthPx: 900, heightPx: 220 };
		const block = paint(images, source, { maxColumns: 90, maxRows: 11, fallback: "[s]" });
		const pending = block.block();
		expect(pending.state).toBe("pending");
		expect(pending.rows).toEqual(Array.from({ length: 11 }, () => RESERVED_ROW));
		await images.whenEncoded();
		const drawn = block.block();
		expect(drawn.state).toBe("image");
		expect(drawn.rows.at(-1)).toBe("\x1b7\x1b[10A\x1bPq#0~\x1b\\\x1b8");
		expect(requests).toEqual([[900, 220, 0]]);
		expect(images.takeSequences()).toBe("");
	});

	it("fits a SIXEL image taller than the screen within the screen's rows, at its natural size once it fits", async () => {
		const requests: [number, number][] = [];
		const screenRows = signal(12);
		const { images } = rig(
			{ images: "sixel", cell: { w: 10, h: 20 } },
			{
				screenRows,
				encodeSixel: async (_bytes, w, h) => {
					requests.push([w, h]);
					return "\x1bPq#0~\x1b\\";
				},
			},
		);
		const block = paint(images, { ...image("s"), widthPx: 500, heightPx: 1000 }, { fallback: "[s]" });
		block.block();
		await images.whenEncoded();
		expect(block.block().rows.at(-1)).toBe("\x1b7\x1b[11A\x1bPq#0~\x1b\\\x1b8");
		screenRows.set(60);
		expect(block.block().rows).toHaveLength(50);
		expect(requests).toEqual([
			[120, 240],
			[500, 1000],
		]);
	});

	it("sends an iTerm2 image taller than the screen at the screen's height, at its natural size once it fits", () => {
		const screenRows = signal(12);
		const { images } = rig({ images: "iterm", cell: { w: 10, h: 20 } }, { screenRows });
		const block = paint(images, { ...image("i"), widthPx: 500, heightPx: 1000 }, { fallback: "[i]" });
		expect(block.block().rows).toEqual(anchoredRows(itermImage(PNG_1PX, 12, 12), 12));
		screenRows.set(60);
		expect(block.block().rows).toEqual(anchoredRows(itermImage(PNG_1PX, 50, 50), 50));
	});

	it("falls back in the image's rows when the encode fails", async () => {
		const { images } = rig({ images: "sixel" }, { encodeSixel: () => Promise.reject(new Error("bad image")) });
		const block = paint(images, image("s"), { maxColumns: 4, maxRows: 2, fallback: "[s]" });
		block.block();
		await images.whenEncoded();
		expect(block.block()).toEqual({ rows: ["[s]", RESERVED_ROW], columns: 3, state: "fallback" });
	});

	it("blends translucent pixels against the OSC 11 background and re-encodes when it changes", async () => {
		const png = await rasterizeSvg(
			new TextEncoder().encode(
				'<svg width="16" height="12"><rect width="16" height="12" fill="white" opacity="0.25"/></svg>',
			),
			16,
			12,
		);
		const { images, caps } = rig({ images: "sixel", cell: { w: 2, h: 6 }, background: { r: 0, g: 0, b: 0 } });
		const source = {
			key: "t",
			data: Buffer.from(png).toString("base64"),
			mime: "image/png",
			widthPx: 16,
			heightPx: 12,
		};
		const block = paint(images, source, { maxColumns: 8, maxRows: 2, fallback: "[t]" });
		const palette = (rows: ImageRows) =>
			rows.rows
				.join("")
				.match(/#0;2;(\d+);(\d+);(\d+)/)
				?.slice(1)
				.map(Number);

		block.block();
		await images.whenEncoded();
		expect(palette(block.block())).toEqual([25, 25, 25]);

		caps.set(capabilities({ images: "sixel", cell: { w: 2, h: 6 }, background: { r: 0x20, g: 0x20, b: 0x40 } }));
		expect(block.block().state).toBe("pending");
		caps.set(capabilities({ images: "sixel", cell: { w: 2, h: 6 }, background: { r: 255, g: 255, b: 255 } }));
		expect(block.block().state).toBe("pending");
		await images.whenEncoded();
		expect(palette(block.block())).toEqual([100, 100, 100]);
	});
});

describe("TerminalImages: contract", () => {
	it("requires a reactive owner", () => {
		const { images } = rig();
		expect(() => images.rows(image("a"), { fallback: "x" })).toThrow(/reactive owner/);
	});
});
