declare module "gifenc" {
	/** Opaque RGB palette shared by quantization and the encoder. */
	type Palette = number[][];

	/** Incrementally writes a GIF with a palette for each composed frame. */
	export function GIFEncoder(): {
		writeFrame(index: Uint8Array, width: number, height: number, options: { palette: Palette; delay: number }): void;
		finish(): void;
		bytesView(): Uint8Array<ArrayBuffer>;
	};

	/** Reduce an RGBA canvas buffer to at most `maxColors` palette entries. */
	export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number): Palette;

	/** Convert RGBA pixels to GIF color indices using a quantized palette. */
	export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette): Uint8Array;
}
