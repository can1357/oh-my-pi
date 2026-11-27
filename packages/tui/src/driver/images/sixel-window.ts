/** Vertical slices of our native encoder's SIXEL (sixel_codec.rs), without decoding or requantizing pixels. */
const HEADER = /^(\x1bP9;1;0q"1;1;(\d+);)(\d+)((?:#\d+;2;\d+;\d+;\d+)*)/;

export interface SixelBands {
	readonly header: string;
	readonly width: number;
	readonly height: number;
	readonly palette: string;
	readonly bands: readonly string[];
}

/** Each band starts with its own palette selections and each color pass ends with `$` (carriage return). */
export function sixelBands(sequence: string): SixelBands | undefined {
	const header = HEADER.exec(sequence);
	if (!header || !sequence.endsWith("-\x1b\\")) return undefined;
	const height = Number(header[3]);
	const bands = sequence.slice(header[0].length, -3).split("-");
	if (bands.length !== Math.ceil(height / 6)) return undefined;
	return { header: header[1]!, width: Number(header[2]), height, palette: header[4]!, bands };
}

/**
 * SIXEL packs six vertical pixels into each data character. At an unaligned top, the low part of one
 * source band and the high part of the next are two transparent color passes over the same row. The
 * color selectors, repeat counts and `$` are all ASCII below `?` and survive unchanged. Drop a partial
 * final band: some terminals allocate its six pixels even with a shorter declared raster height.
 */
export function sliceSixel(image: SixelBands, top: number, room: number): string {
	const count = Math.floor(Math.min(room, image.height - top) / 6);
	if (count <= 0) return "";
	const shift = top % 6;
	const first = Math.floor(top / 6);
	const parts = [image.header, String(count * 6), image.palette];
	// Zellij infers the width of a transparent raster from its first pixel row, not its declaration.
	parts.push(`!${image.width}?$`);
	for (let i = first; i < first + count; i++) {
		const band = image.bands[i]!;
		if (shift === 0) parts.push(band);
		else {
			parts.push(band.replace(/[?-~]/g, c => String.fromCharCode(63 + ((c.charCodeAt(0) - 63) >> shift))));
			const lower = image.bands[i + 1];
			if (lower)
				parts.push(
					lower.replace(/[?-~]/g, c => String.fromCharCode(63 + (((c.charCodeAt(0) - 63) << (6 - shift)) & 63))),
				);
		}
		parts.push("-");
	}
	parts.push("\x1b\\");
	return parts.join("");
}
