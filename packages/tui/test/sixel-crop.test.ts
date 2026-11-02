import { describe, expect, it } from "bun:test";
import { cropSixelTop, ensureSixelRasterWidth } from "../src/sixel";

/** Small independent interpreter: keep colors per pixel, never shift SIXEL bands. */
function decode(sequence: string): {
	width: number;
	height: number;
	firstBandWidth: number;
	pixels: (string | null)[][];
} {
	const header = /^\x1bP[0-9;]*q/.exec(sequence);
	const raster = /"\d+;\d+;(\d+);(\d+)/.exec(sequence);
	if (!header || !raster || !sequence.endsWith("\x1b\\")) throw new Error("Invalid SIXEL fixture");
	const width = Number(raster[1]);
	const height = Number(raster[2]);
	const pixels = Array.from({ length: height }, () => Array<string | null>(width).fill(null));
	const palette = new Map<number, string>();
	let color = 0;
	let x = 0;
	let y = 0;
	let firstBandWidth = 0;
	let offset = header[0].length;
	const numbers = (): number[] => {
		const start = offset;
		while (/[0-9;]/.test(sequence[offset] ?? "")) offset++;
		return sequence.slice(start, offset).split(";").map(Number);
	};
	const paint = (character: string, repeat: number): void => {
		const mask = character.charCodeAt(0) - 63;
		if (mask < 0 || mask > 63) throw new Error("Invalid SIXEL pixel");
		if (y === 0) firstBandWidth = Math.max(firstBandWidth, x + repeat);
		for (let column = 0; column < repeat; column++, x++) {
			for (let bit = 0; bit < 6; bit++) {
				if (!(mask & (1 << bit)) || y + bit >= height || x >= width) continue;
				const value = palette.get(color);
				if (!value) throw new Error(`Undefined color ${color}`);
				pixels[y + bit]![x] = value;
			}
		}
	};
	while (offset < sequence.length - 2) {
		const command = sequence[offset++]!;
		if (command === '"') numbers();
		else if (command === "#") {
			const values = numbers();
			color = values[0]!;
			if (values.length > 1) {
				if (values[1] !== 2) throw new Error("Fixture decoder expects RGB palette entries");
				palette.set(color, values.slice(2).join(","));
			}
		} else if (command === "!") {
			const [repeat] = numbers();
			paint(sequence[offset++]!, repeat!);
		} else if (command === "$") x = 0;
		else if (command === "-") {
			x = 0;
			y += 6;
		} else paint(command, 1);
	}
	return { width, height, firstBandWidth, pixels };
}

const RED = "100,0,0";
// Each band uses multiple color passes, transparent columns, and repeated pixels.
// Bit patterns differ across adjacent bands so a band-only crop cannot pass.
const IMAGE = '\x1bP0;1;0q"1;1;5;18#1;2;100;0;0#2;2;0;100;0#3;2;0;0;100#1!2V?$#2??!2i-#3!3j$#1???@-#2!2~$#3??!2T\x1b\\';

describe("cropSixelTop", () => {
	it("leaves a zero-pixel crop byte-for-byte unchanged", () => {
		expect(cropSixelTop(IMAGE, 0)).toBe(IMAGE);
	});

	it("keeps transparent leading bands visible to Zellij without painting their pixels", () => {
		const source = '\x1bP9;1;0q"1;1;5;18#1;2;100;0;0--#1!5~\x1b\\';
		const original = decode(source);
		expect(original.firstBandWidth).toBe(0);
		const result = decode(ensureSixelRasterWidth(source));
		expect(result.firstBandWidth).toBe(5);
		expect(result.pixels).toEqual(original.pixels);
		expect(result.pixels[12]).toEqual(Array<string>(5).fill(RED));
	});

	it("retains image width when cropping exposes a transparent first band", () => {
		const source = '\x1bP9;1;0q"1;1;5;18#1;2;100;0;0#1!5~--#1!5~\x1b\\';
		const result = decode(cropSixelTop(source, 6));
		expect(result.firstBandWidth).toBe(5);
		expect(result.pixels).toEqual(decode(source).pixels.slice(6));
		expect(result.pixels[6]).toEqual(Array<string>(5).fill(RED));
	});

	for (const pixels of [2, 6, 7, 17]) {
		it(`preserves every surviving pixel after removing ${pixels} top pixels`, () => {
			const source = decode(IMAGE);
			const cropped = cropSixelTop(IMAGE, pixels);
			const result = decode(cropped);
			expect(result.width).toBe(source.width);
			expect(result.height).toBe(source.height - pixels);
			expect(result.pixels).toEqual(source.pixels.slice(pixels));
			expect(cropped).toMatch(/^\x1bP0;1;0q/);
		});
	}

	for (const pixels of [18, 19]) {
		it(`emits no DCS for a fully removed image (${pixels} pixels)`, () => {
			expect(cropSixelTop(IMAGE, pixels)).toBe("");
		});
	}

	it("retains palette definitions from removed bands and transparent runs", () => {
		const source = '\x1bP0;1;0q"1;1;40;12#7;2;100;0;0!40~-!10?!20~!10?\x1b\\';
		const cropped = cropSixelTop(source, 6);
		expect(decode(cropped).pixels).toEqual(decode(source).pixels.slice(6));
		expect(decode(cropped).pixels[0]).toEqual([
			...Array<string | null>(10).fill(null),
			...Array<string | null>(20).fill(RED),
			...Array<string | null>(10).fill(null),
		]);
	});

	it("crops a declared partial final band without exposing padding pixels", () => {
		const source = '\x1bP0;1;0q"1;1;2;8#1;2;100;0;0!2~-!2B\x1b\\';
		const cropped = decode(cropSixelTop(source, 3));
		expect(cropped.height).toBe(5);
		expect(cropped.pixels).toEqual(decode(source).pixels.slice(3));
	});

	it("caps a 38-pixel remainder to six safe bands inside two 20-pixel terminal rows", () => {
		const bands = Array.from({ length: 13 }, (_, index) => `#${(index % 2) + 1}!4~`).join("-");
		const source = `\x1bP0;1;0q"1;1;4;78#1;2;100;0;0#2;2;0;100;0${bands}\x1b\\`;
		const exact = decode(cropSixelTop(source, 40));
		expect(exact.height).toBe(38);
		expect(exact.pixels).toEqual(decode(source).pixels.slice(40));

		const capped = cropSixelTop(source, 40, 40);
		const result = decode(capped);
		expect(result.height).toBe(36);
		expect(result.pixels).toEqual(exact.pixels.slice(0, 36));
		const body = capped.slice(capped.indexOf("q") + 1, -2);
		expect(body.split("-").length * 6).toBeLessThanOrEqual(40);
	});
});
