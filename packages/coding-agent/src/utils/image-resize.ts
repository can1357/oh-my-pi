import { inflateSync } from "node:zlib";
import type { BoxEdges, ImageContent } from "@oh-my-pi/pi-ai";
import { JUDGMENT_IMAGE_PATCH_SIDE, judgmentImagePatches } from "@oh-my-pi/pi-catalog/compat/judgment-images";
import { encodeRawPng } from "./png-encode";

export interface ImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	/**
	 * Smallest wanted edge length (px). Inputs below this are scaled up uniformly,
	 * as far as the caps allow; the aspect ratio is never distorted to reach it.
	 */
	minDimension?: number;
	maxBytes?: number;
	jpegQuality?: number;
	excludeWebP?: boolean;
}

export interface ResizedImage {
	buffer: Uint8Array;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
	decodeFailed?: boolean;
	/** Bounds of the source content when an extreme aspect ratio required padding. */
	paddedContent?: BoxEdges;
	get data(): string;
}

/**
 * Raw image bytes for {@link resizeImage}. `mimeType` is the caller's hint when decoding
 * fails; `data` is the base64 of `bytes` when the caller already has it (reused verbatim).
 */
export interface ImageBytesInput {
	bytes: Uint8Array;
	mimeType?: string;
	data?: string;
}

// 500KB target — aggressive compression; Anthropic's 5MB per-image cap is rarely the
// binding constraint once images are downsized to 1568px (Anthropic's internal threshold).
const DEFAULT_MAX_BYTES = 500 * 1024;

/**
 * Smallest edge length (px) vision backends reliably accept. They tile images into
 * fixed patches (Anthropic uses 28px) and reject degenerate sub-patch images — e.g.
 * the 1x1 PNG an empty chart render emits — with a hard 400 ("Could not process
 * image") that can poison the whole request. 200px is the smallest size Anthropic
 * documents as valid (200x200 = 64 visual tokens); {@link resizeImage} scales
 * undersized images up.
 */
export const DEFAULT_MIN_DIMENSION = 200;

const DEFAULT_OPTIONS: Required<Omit<ImageResizeOptions, "excludeWebP">> = {
	// Anthropic's "internal recommended size" — Claude internally caps images at
	// 1568px on the longest edge before vision processing.
	maxWidth: 1568,
	maxHeight: 1568,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
	minDimension: DEFAULT_MIN_DIMENSION,
};

/** An image's size and format as its header declares them. */
export interface ImageHeaderDimensions {
	width: number;
	height: number;
	mimeType: string;
}

function readUint16BE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] << 8) | buffer[offset + 1];
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
}

function readPngHeaderDimensions(buffer: Uint8Array): ImageHeaderDimensions | undefined {
	if (buffer.length < 24) return undefined;
	if (
		buffer[0] !== 0x89 ||
		buffer[1] !== 0x50 ||
		buffer[2] !== 0x4e ||
		buffer[3] !== 0x47 ||
		buffer[4] !== 0x0d ||
		buffer[5] !== 0x0a ||
		buffer[6] !== 0x1a ||
		buffer[7] !== 0x0a
	) {
		return undefined;
	}
	if (readUint32BE(buffer, 8) !== 13) return undefined;
	if (buffer[12] !== 0x49 || buffer[13] !== 0x48 || buffer[14] !== 0x44 || buffer[15] !== 0x52) return undefined;
	const width = readUint32BE(buffer, 16);
	const height = readUint32BE(buffer, 20);
	if (width === 0 || height === 0) return undefined;
	return { width, height, mimeType: "image/png" };
}

/**
 * Whether `input`'s container can hold translucent pixels: anything but a JPEG or a PNG
 * without an alpha channel or `tRNS` transparency.
 */
function mayHaveAlpha(input: Uint8Array): boolean {
	if (input[0] === 0xff && input[1] === 0xd8) return false;
	if (!readPngHeaderDimensions(input)) return true;
	const colorType = input[25];
	if (colorType === 4 || colorType === 6) return true;
	for (let offset = 33; offset + 8 <= input.length; offset += 12 + readUint32BE(input, offset)) {
		const type = String.fromCharCode(...input.subarray(offset + 4, offset + 8));
		if (type === "tRNS") return true;
		if (type === "IDAT") return false;
	}
	return false;
}

/** 8-bit RGBA pixels read back from `Bun.Image`. */
interface RgbaPixels {
	width: number;
	height: number;
	pixels: Uint8Array;
}

export type ImageContentInspection =
	| { width: number; height: number; kind: "transparent" }
	| { width: number; height: number; kind: "solid"; color: string }
	| undefined;

/**
 * Read Bun.Image's unfiltered 8-bit RGB/RGBA PNG output as RGBA. Opaque RGB
 * output gets alpha 255. Other layouts remain inconclusive rather than rejecting content.
 */
async function readRgba(image: Bun.Image): Promise<RgbaPixels | undefined> {
	const png = await image.png({ compressionLevel: 0 }).bytes();
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Uint8Array[] = [];
	for (let offset = 8; offset + 12 <= png.length; offset += 12 + readUint32BE(png, offset)) {
		const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
		const data = png.subarray(offset + 8, offset + 8 + readUint32BE(png, offset));
		if (type === "IHDR") {
			width = readUint32BE(data, 0);
			height = readUint32BE(data, 4);
			// 8-bit RGB or RGBA, not interlaced.
			if (data[8] === 8 && data[12] === 0) channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
	}
	if (!channels) return undefined;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	if (raw.length !== (stride + 1) * height) return undefined;
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const row = y * (stride + 1);
		if (raw[row] !== 0) return undefined;
		if (channels === 4) {
			pixels.set(raw.subarray(row + 1, row + 1 + stride), y * width * 4);
		} else {
			for (let x = 0; x < width; x++) {
				const source = row + 1 + x * 3;
				const target = (y * width + x) * 4;
				pixels.set(raw.subarray(source, source + 3), target);
				pixels[target + 3] = 255;
			}
		}
	}
	return { width, height, pixels };
}

/** GIF, WebP with an `ANIM` chunk, or APNG (`acTL` before the first `IDAT`). */
function mayBeAnimated(bytes: Uint8Array): boolean {
	const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
	if (head.startsWith("GIF8")) return true;
	if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return head.includes("ANIM");
	const idat = head.indexOf("IDAT");
	return head.startsWith("\x89PNG") && head.indexOf("acTL") !== -1 && (idat === -1 || head.indexOf("acTL") < idat);
}

/**
 * Reject empty images only after checking every pixel; sparse content must survive.
 * Accept the full-resolution RGBA allocation: downsampling can erase the only visible pixel.
 */
export async function inspectImageContent(bytes: Uint8Array): Promise<ImageContentInspection> {
	// Decoding yields the first frame only; a later frame of an animation may hold the content.
	if (mayBeAnimated(bytes)) return undefined;
	try {
		const decoded = await readRgba(new Bun.Image(bytes));
		if (!decoded) return undefined;
		const { width, height, pixels } = decoded;
		let firstR = -1;
		let firstG = -1;
		let firstB = -1;
		let firstA = -1;
		let fullyTransparent = true;
		let sameColor = true;
		for (let pixel = 0; pixel < width * height; pixel++) {
			const offset = pixel * 4;
			const r = pixels[offset]!;
			const g = pixels[offset + 1]!;
			const b = pixels[offset + 2]!;
			const a = pixels[offset + 3]!;
			if (a !== 0) fullyTransparent = false;
			if (firstA < 0) {
				firstR = r;
				firstG = g;
				firstB = b;
				firstA = a;
			} else if (r !== firstR || g !== firstG || b !== firstB || a !== firstA) sameColor = false;
			if (!fullyTransparent && !sameColor) return undefined;
		}
		if (fullyTransparent) return { width, height, kind: "transparent" };
		if (!sameColor) return undefined;
		const hex = [firstR, firstG, firstB].map(channel => channel.toString(16).padStart(2, "0")).join("");
		return { width, height, kind: "solid", color: `#${hex}` };
	} catch {
		return undefined;
	}
}

/**
 * `input` with its color premultiplied by alpha, as an uncompressed PNG for `Bun.Image` to
 * resample, when some pixel is translucent; `undefined` when every pixel is opaque.
 */
async function premultipliedPng(input: Uint8Array): Promise<Uint8Array | undefined> {
	const source = await readRgba(new Bun.Image(input));
	if (!source) return undefined;
	const { pixels } = source;
	let translucent = false;
	for (let i = 0; i < pixels.length; i += 4) {
		const alpha = pixels[i + 3];
		if (alpha === 255) continue;
		translucent = true;
		for (let c = i; c < i + 3; c++) pixels[c] = Math.round((pixels[c] * alpha) / 255);
	}
	return translucent ? encodeRawPng(pixels, source.width, source.height, 4, 0) : undefined;
}

/** Undoes premultiplication on resampled RGBA; a channel the kernel's overshoot left above alpha clamps to full. */
function unpremultiply(pixels: Uint8Array): void {
	for (let i = 0; i < pixels.length; i += 4) {
		const alpha = pixels[i + 3];
		if (alpha === 255) continue;
		for (let c = i; c < i + 3; c++) {
			pixels[c] = alpha === 0 ? 0 : Math.min(255, Math.round((pixels[c] * 255) / alpha));
		}
	}
}

function isJpegStartOfFrame(marker: number): boolean {
	return (
		(marker >= 0xc0 && marker <= 0xc3) ||
		(marker >= 0xc5 && marker <= 0xc7) ||
		(marker >= 0xc9 && marker <= 0xcb) ||
		(marker >= 0xcd && marker <= 0xcf)
	);
}

function readJpegHeaderDimensions(buffer: Uint8Array): ImageHeaderDimensions | undefined {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
	let offset = 2;
	while (offset + 3 < buffer.length) {
		if (buffer[offset] !== 0xff) {
			offset++;
			continue;
		}
		while (offset < buffer.length && buffer[offset] === 0xff) offset++;
		if (offset >= buffer.length) return undefined;
		const marker = buffer[offset++];
		if (marker === 0xd9 || marker === 0xda) return undefined;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset + 1 >= buffer.length) return undefined;
		const segmentLength = readUint16BE(buffer, offset);
		if (segmentLength < 2) return undefined;
		if (isJpegStartOfFrame(marker)) {
			if (offset + 7 >= buffer.length) return undefined;
			const height = readUint16BE(buffer, offset + 3);
			const width = readUint16BE(buffer, offset + 5);
			if (width === 0 || height === 0) return undefined;
			return { width, height, mimeType: "image/jpeg" };
		}
		offset += segmentLength;
	}
	return undefined;
}

/** The size a PNG or JPEG header declares, without decoding the image; `undefined` for any other bytes. */
export function readImageHeaderDimensions(buffer: Uint8Array): ImageHeaderDimensions | undefined {
	return readPngHeaderDimensions(buffer) ?? readJpegHeaderDimensions(buffer);
}

/**
 * Read `OMP_NO_WEBP` per-call so runtime toggles take effect.
 * Only `"1"` and `"true"` (case-insensitive) enable exclusion — an empty string
 * or `"0"` MUST be treated as disabled.
 */
function isWebPExcluded(): boolean {
	const raw = Bun.env.OMP_NO_WEBP;
	if (raw === undefined) return false;
	const v = raw.toLowerCase();
	return v === "1" || v === "true";
}

/** Pick the smallest of N encoded buffers. */
function pickSmallest(...candidates: Array<{ buffer: Uint8Array; mimeType: string }>): {
	buffer: Uint8Array;
	mimeType: string;
} {
	return candidates.reduce((best, c) => (c.buffer.length < best.buffer.length ? c : best));
}

/** Polyfill for Buffer.toBase64, technically since it derives from Uint8Array it should exist but Bun reasons... */
Buffer.prototype.toBase64 = function (this: Buffer) {
	return new Uint8Array(this.buffer, this.byteOffset, this.byteLength).toBase64();
};

interface EncodedCandidate {
	buffer: Uint8Array;
	mimeType: string;
}

/** Build a result whose base64 `data` is computed on first access and memoized. */
function encodedResult(
	best: EncodedCandidate,
	originalWidth: number,
	originalHeight: number,
	width: number,
	height: number,
): ResizedImage {
	let data: string | undefined;
	return {
		buffer: best.buffer,
		mimeType: best.mimeType,
		originalWidth,
		originalHeight,
		width,
		height,
		wasResized: true,
		get data() {
			data ??= best.buffer.toBase64();
			return data;
		},
	};
}

/**
 * Resize and recompress an image to fit within the specified max dimensions and file size.
 *
 * Strategy:
 *  1. Probe metadata. If already within all limits, return original.
 *  2. Resize to fit max dimensions and encode at high quality across PNG/JPEG (+ WebP) — return smallest.
 *  3. If still too large, walk a lossy JPEG/WebP quality ladder.
 *  4. If still too large, walk a dimension-scale ladder × quality ladder.
 *  5. If still too large, return the smallest variant produced.
 *
 * The source is decoded and resized once per target size; the format/quality ladder
 * re-encodes from a lossless intermediate at that size.
 *
 * A source with translucent pixels keeps its alpha: it resizes premultiplied (`Bun.Image`
 * resamples straight alpha, bleeding the color under transparent pixels into the edges)
 * and never becomes JPEG (which would show that color, usually black). Without WebP it
 * stays PNG and only the dimension ladder shrinks it.
 *
 * Accepts an `ImageContent` (base64), raw bytes, or {@link ImageBytesInput}; passing
 * bytes avoids a base64 round-trip when the caller already holds them.
 *
 * Set OMP_NO_WEBP to exclude WebP from encoding (llama.cpp STB doesn't decode it).
 *
 * Backed by `Bun.Image`: a chainable native pipeline that runs decode/transform/encode
 * off the JS thread when the terminal (`.bytes()`) is awaited.
 */
export async function resizeImage(
	img: ImageContent | ImageBytesInput | Uint8Array,
	options?: ImageResizeOptions,
): Promise<ResizedImage> {
	const excludeWebP = options?.excludeWebP ?? isWebPExcluded();
	const opts = { ...DEFAULT_OPTIONS, ...options, excludeWebP };
	let inputBuffer: Uint8Array;
	let callerMime: string | undefined;
	let originalData: string | undefined;
	if (img instanceof Uint8Array) {
		inputBuffer = img;
	} else if ("bytes" in img) {
		inputBuffer = img.bytes;
		callerMime = img.mimeType;
		originalData = img.data;
	} else {
		inputBuffer = Buffer.from(img.data, "base64");
		callerMime = img.mimeType;
		originalData = img.data;
	}
	const getOriginalData = (): string => {
		originalData ??= inputBuffer.toBase64();
		return originalData;
	};

	try {
		const { width: originalWidth, height: originalHeight, format } = await new Bun.Image(inputBuffer).metadata();
		// Trust decoded bytes over caller metadata. A mislabeled WebP must not take
		// the fast path when the target decoder explicitly excludes WebP.
		const sourceMime = format ? `image/${format}` : (callerMime ?? "application/octet-stream");

		// Fast path: already within dimensions AND well under budget.
		// Threshold is 1/4 of budget — if already that compact, don't re-encode.
		// Avoids wasted work on tiny icons/diagrams while ensuring larger PNGs
		// still get JPEG-compressed.
		const originalSize = inputBuffer.length;
		const comfortableSize = opts.maxBytes / 4;
		// Clamp the floor to the caps so an unusually small max can't demand an
		// impossible "≥ min and ≤ max" target.
		const minDimension = Math.min(opts.minDimension, opts.maxWidth, opts.maxHeight);
		if (
			originalWidth >= minDimension &&
			originalHeight >= minDimension &&
			originalWidth <= opts.maxWidth &&
			originalHeight <= opts.maxHeight &&
			originalSize <= comfortableSize &&
			!(opts.excludeWebP && sourceMime === "image/webp")
		) {
			return {
				buffer: inputBuffer,
				mimeType: sourceMime,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
				get data() {
					return getOriginalData();
				},
			};
		}

		// Calculate initial dimensions respecting max limits
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		// Lift undersized inputs toward the minimum while keeping their aspect ratio.
		// If a cap stops the short edge below the floor, fitImageBytes pads it instead.
		if (targetWidth < minDimension || targetHeight < minDimension) {
			const shortEdge = Math.min(targetWidth, targetHeight);
			const upscale = Math.min(minDimension / shortEdge, opts.maxWidth / targetWidth, opts.maxHeight / targetHeight);
			if (upscale > 1) {
				targetWidth = Math.min(opts.maxWidth, Math.round(targetWidth * upscale));
				targetHeight = Math.min(opts.maxHeight, Math.round(targetHeight * upscale));
			}
		}
		if (targetWidth < minDimension || targetHeight < minDimension) {
			const fitted = await fitImageBytes(
				inputBuffer,
				{ width: originalWidth, height: originalHeight },
				{ minSide: minDimension, maxSide: Math.min(opts.maxWidth, opts.maxHeight), maxBytes: opts.maxBytes },
			);
			return {
				...encodedResult(
					{ buffer: fitted.buffer, mimeType: fitted.mimeType },
					originalWidth,
					originalHeight,
					fitted.width,
					fitted.height,
				),
				paddedContent: fitted.content,
			};
		}

		const premultiplied = mayHaveAlpha(inputBuffer) ? await premultipliedPng(inputBuffer) : undefined;
		const translucent = premultiplied !== undefined;
		// No lossy format keeps a translucent image's alpha once WebP is excluded.
		const lossy = !(translucent && opts.excludeWebP);

		// The source at `width`×`height` as PNG with straight alpha; `compressionLevel` 0
		// for ladder intermediates.
		async function resizedPng(width: number, height: number, compressionLevel?: number): Promise<Uint8Array> {
			if (!premultiplied) {
				const image = new Bun.Image(inputBuffer).resize(width, height);
				return (compressionLevel === undefined ? image.png() : image.png({ compressionLevel })).bytes();
			}
			const resized = await readRgba(new Bun.Image(premultiplied).resize(width, height));
			if (!resized) throw new Error("resizeImage: a translucent resize lost its alpha channel");
			unpremultiply(resized.pixels);
			return encodeRawPng(resized.pixels, width, height, 4, compressionLevel);
		}

		// Lossy encoder for quality/dimension fallback ladders. PNG is excluded since
		// it's lossless and doesn't respond to quality parameters. WebP is included
		// unless OMP_NO_WEBP is set (llama.cpp STB incompatibility); JPEG unless the
		// image is translucent. Ladder steps pass a lossless PNG already at the target
		// size, so each step only decodes that small intermediate instead of re-decoding
		// and re-resizing the source; when `width`/`height` are given the source is
		// resized first. Call only when `lossy`.
		async function encodeLossy(
			source: Uint8Array,
			quality: number,
			width?: number,
			height?: number,
		): Promise<EncodedCandidate> {
			const pipeline = () => {
				const image = new Bun.Image(source);
				return width === undefined || height === undefined ? image : image.resize(width, height);
			};
			const candidates = await Promise.all([
				...(translucent
					? []
					: [
							pipeline()
								.jpeg({ quality })
								.bytes()
								.then(b => ({ buffer: b, mimeType: "image/jpeg" })),
						]),
				...(opts.excludeWebP
					? []
					: [
							pipeline()
								.webp({ quality })
								.bytes()
								.then(b => ({ buffer: b, mimeType: "image/webp" })),
						]),
			]);
			return pickSmallest(...candidates);
		}

		// Quality ladder — more aggressive steps for tighter budgets
		const qualitySteps = [70, 60, 50, 40];
		const scaleSteps = [1.0, 0.75, 0.5, 0.35, 0.25];

		let finalWidth = targetWidth;
		let finalHeight = targetHeight;

		// First attempt: resize to target and try PNG/JPEG (+ WebP) in parallel, pick the
		// smallest. PNG wins for line art / few-color UI; JPEG wins for photographic
		// content; WebP usually beats JPEG by 25–35% but is disabled when OMP_NO_WEBP is
		// set because many local inference backends (llama.cpp STB) don't decode it.
		// The lossless PNG doubles as the intermediate for the quality ladder below. A
		// translucent image's lossy encode starts from its premultiplied resize, so waits for it.
		let targetPng: Uint8Array;
		let firstLossy: EncodedCandidate | undefined;
		if (translucent) {
			targetPng = await resizedPng(targetWidth, targetHeight);
			firstLossy = lossy ? await encodeLossy(targetPng, opts.jpegQuality) : undefined;
		} else {
			[targetPng, firstLossy] = await Promise.all([
				resizedPng(targetWidth, targetHeight),
				encodeLossy(inputBuffer, opts.jpegQuality, targetWidth, targetHeight),
			]);
		}
		let best: EncodedCandidate = { buffer: targetPng, mimeType: "image/png" };
		if (firstLossy) best = pickSmallest(best, firstLossy);
		if (best.buffer.length <= opts.maxBytes) {
			return encodedResult(best, originalWidth, originalHeight, finalWidth, finalHeight);
		}

		// Still too large — lossy JPEG (+ WebP) ladder with decreasing quality
		for (const quality of lossy ? qualitySteps : []) {
			best = await encodeLossy(targetPng, quality);
			if (best.buffer.length <= opts.maxBytes) {
				return encodedResult(best, originalWidth, originalHeight, finalWidth, finalHeight);
			}
		}

		// Still too large — reduce dimensions progressively with the lossy ladder (PNG
		// alone when nothing lossy applies)
		for (const scale of scaleSteps) {
			// The first PNG candidate was this size.
			if (!lossy && scale === 1) continue;
			const width = Math.round(targetWidth * scale);
			const height = Math.round(targetHeight * scale);
			// Rejected before encoding: the reported size stays the last encoded one.
			if (width < 100 || height < 100) {
				break;
			}
			finalWidth = width;
			finalHeight = height;

			if (!lossy) {
				best = { buffer: await resizedPng(finalWidth, finalHeight), mimeType: "image/png" };
				if (best.buffer.length <= opts.maxBytes) {
					return encodedResult(best, originalWidth, originalHeight, finalWidth, finalHeight);
				}
				continue;
			}
			const resized = scale === 1 ? targetPng : await resizedPng(finalWidth, finalHeight, 0);
			for (const quality of qualitySteps) {
				best = await encodeLossy(resized, quality);
				if (best.buffer.length <= opts.maxBytes) {
					return encodedResult(best, originalWidth, originalHeight, finalWidth, finalHeight);
				}
			}
		}

		// Last resort: return smallest version we produced
		return encodedResult(best, originalWidth, originalHeight, finalWidth, finalHeight);
	} catch {
		const headerDimensions = readImageHeaderDimensions(inputBuffer);
		const fallbackMimeType = callerMime ?? headerDimensions?.mimeType ?? "application/octet-stream";
		// Bun.Image rejected the input — we cannot decode/re-encode it.
		// When the caller demanded WebP exclusion AND the source might be WebP,
		// returning the original buffer would silently violate that contract,
		// so surface an explicit error instead.
		if (excludeWebP && (fallbackMimeType === "image/webp" || (!callerMime && !headerDimensions))) {
			throw new Error("resizeImage: failed to decode image and cannot honor excludeWebP for a WebP source");
		}
		return {
			buffer: inputBuffer,
			mimeType: fallbackMimeType,
			originalWidth: headerDimensions?.width ?? 0,
			originalHeight: headerDimensions?.height ?? 0,
			width: headerDimensions?.width ?? 0,
			height: headerDimensions?.height ?? 0,
			wasResized: false,
			decodeFailed: true,
			get data() {
				return getOriginalData();
			},
		};
	}
}

/** Inclusive bounds {@link fitImage} sizes an image into; an unset field does not constrain. */
export interface ImageFitBounds {
	minSide?: number;
	maxSide?: number;
	minPixels?: number;
	maxPixels?: number;
	/** Encoded bytes. */
	maxBytes?: number;
	/** {@link judgmentImagePatches} of the scaled image. */
	maxPatches?: number;
}

/** An image re-encoded by {@link fitImage}. */
export interface FittedImage {
	image: ImageContent;
	/** The source's edges on `image`, as fractions of its size; padding lies outside them. Maps answers that locate things on `image` back to the source. */
	content: BoxEdges;
}

/** JPEG qualities {@link fitImage} steps through when the PNG exceeds its byte cap. */
const FIT_JPEG_QUALITIES = [90, 80, 70, 60, 50, 40];

/**
 * Re-encode `img` within `bounds` without distorting it, for APIs that reject out-of-bounds images
 * instead of resizing them (TypeSafe Jev). It scales down past a maximum, or up toward a minimum as far
 * as the maximums allow, then pads with its top-left pixel when an extreme aspect ratio still leaves a
 * side or the area short: under 280–1568 px sides, a 401x41 toolbar strip becomes 1568x160 centered on
 * 1568x280, whose content edges are top 60/280 and bottom 220/280. Output is PNG, or JPEG when the PNG
 * exceeds `maxBytes`.
 *
 * @throws when the image cannot be decoded or no encoding fits `maxBytes`.
 */
export async function fitImage(img: ImageContent, bounds: ImageFitBounds): Promise<FittedImage> {
	const input = Buffer.from(img.data, "base64");
	const dimensions = await new Bun.Image(input).metadata();
	const fitted = await fitImageBytes(input, dimensions, bounds);
	return {
		image: { ...img, data: fitted.buffer.toBase64(), mimeType: fitted.mimeType },
		content: fitted.content,
	};
}

async function fitImageBytes(
	input: Uint8Array,
	{ width, height }: { width: number; height: number },
	bounds: ImageFitBounds,
): Promise<{ buffer: Uint8Array; mimeType: string; width: number; height: number; content: BoxEdges }> {
	const {
		minSide = 1,
		maxSide = Infinity,
		minPixels = 1,
		maxPixels = Infinity,
		maxBytes = Infinity,
		maxPatches = Infinity,
	} = bounds;
	const area = width * height;
	const patch = JUDGMENT_IMAGE_PATCH_SIDE;
	const ceiling = Math.min(
		maxSide / Math.max(width, height),
		Math.sqrt(maxPixels / area),
		Math.sqrt((maxPatches * patch * patch) / area),
	);
	const floor = Math.max(minSide / Math.min(width, height), Math.sqrt(minPixels / area));
	// Reaching a minimum never crosses a maximum; padding below covers what scaling leaves short.
	const scale = floor > 1 ? Math.min(floor, ceiling) : Math.min(1, ceiling);
	let scaledWidth = Math.min(maxSide, Math.max(1, Math.round(width * scale)));
	let scaledHeight = Math.min(maxSide, Math.max(1, Math.round(height * scale)));
	// Rounding both sides up can overshoot the area cap by a sliver; trim the longer side.
	if (scaledWidth * scaledHeight > maxPixels) {
		if (scaledWidth >= scaledHeight) scaledWidth = Math.floor(maxPixels / scaledHeight);
		else scaledHeight = Math.floor(maxPixels / scaledWidth);
	}
	// Partial patches count whole, so a size within the patch area can still cover one row or column too
	// many; trim the longer side to the whole patches the shorter side leaves.
	if (judgmentImagePatches(scaledWidth, scaledHeight) > maxPatches) {
		if (scaledWidth >= scaledHeight) {
			scaledWidth = Math.max(1, patch * Math.floor(maxPatches / Math.ceil(scaledHeight / patch)));
		} else {
			scaledHeight = Math.max(1, patch * Math.floor(maxPatches / Math.ceil(scaledWidth / patch)));
		}
	}

	let canvasWidth = Math.max(scaledWidth, minSide);
	let canvasHeight = Math.max(scaledHeight, minSide);
	if (canvasWidth * canvasHeight < minPixels) {
		if (canvasWidth >= canvasHeight) canvasHeight = Math.ceil(minPixels / canvasWidth);
		else canvasWidth = Math.ceil(minPixels / canvasHeight);
	}
	const left = (canvasWidth - scaledWidth) >> 1;
	const top = (canvasHeight - scaledHeight) >> 1;

	const resized = new Bun.Image(input).resize(scaledWidth, scaledHeight);
	let png: Uint8Array;
	if (canvasWidth === scaledWidth && canvasHeight === scaledHeight) {
		png = await resized.png().bytes();
	} else {
		const source = await readRgba(resized);
		if (!source) throw new Error("fitImage: the resized image did not read back as RGBA");
		png = padRgba(source, canvasWidth, canvasHeight, left, top);
	}

	let encoded = png;
	let mimeType = "image/png";
	for (const quality of FIT_JPEG_QUALITIES) {
		if (encoded.length <= maxBytes) break;
		encoded = await new Bun.Image(png).jpeg({ quality }).bytes();
		mimeType = "image/jpeg";
	}
	if (encoded.length > maxBytes) throw new Error(`fitImage: no encoding fits ${maxBytes} bytes`);
	return {
		buffer: encoded,
		mimeType,
		width: canvasWidth,
		height: canvasHeight,
		content: {
			top: top / canvasHeight,
			bottom: (top + scaledHeight) / canvasHeight,
			left: left / canvasWidth,
			right: (left + scaledWidth) / canvasWidth,
		},
	};
}

/** `source` at (`left`, `top`) on a `width`×`height` canvas filled with its top-left pixel, as PNG. */
function padRgba(source: RgbaPixels, width: number, height: number, left: number, top: number): Uint8Array {
	const canvas = new Uint8Array(width * height * 4);
	// Both views use platform byte order, so the fill keeps the pixel's channel order.
	new Uint32Array(canvas.buffer).fill(new Uint32Array(source.pixels.slice(0, 4).buffer)[0]);
	const stride = source.width * 4;
	for (let y = 0; y < source.height; y++) {
		canvas.set(source.pixels.subarray(y * stride, (y + 1) * stride), ((top + y) * width + left) * 4);
	}
	return encodeRawPng(canvas, width, height, 4);
}

/**
 * How to map positions on a padded image to `target`: through `content`, the source's rectangle on it, and
 * `scale`, the source pixels per target pixel. Shared by {@link formatDimensionNote} and browser screenshots.
 */
export function paddedMapping(result: ResizedImage, content: BoxEdges, scale: number, target: string): string {
	const left = Math.round(content.left * result.width);
	const top = Math.round(content.top * result.height);
	const contentWidth = (content.right - content.left) * result.width;
	const contentHeight = (content.bottom - content.top) * result.height;
	const xFactor = (result.originalWidth / contentWidth / scale).toFixed(2);
	const yFactor = (result.originalHeight / contentHeight / scale).toFixed(2);
	return `Subtract padding offset (${left}, ${top}), then multiply x by ${xFactor} and y by ${yFactor} to map to ${target}.`;
}

function paddedCoordinateNote(result: ResizedImage, content: BoxEdges, scale: number, target: string): string {
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height} with padding. ${paddedMapping(result, content, scale, target)}]`;
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}
	if (!result.originalWidth || !result.originalHeight || !result.width || !result.height) {
		return undefined;
	}
	if (result.width === result.originalWidth && result.height === result.originalHeight) {
		return undefined;
	}
	if (result.paddedContent) {
		return paddedCoordinateNote(result, result.paddedContent, 1, "original image coordinates");
	}
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
