import type { ImageContent } from "@oh-my-pi/pi-ai";

export interface ImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	/** Smallest allowed edge length (px). Inputs below this are scaled up. */
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
	get data(): string;
}

// 500KB target — aggressive compression; Anthropic's 5MB per-image cap is rarely the
// binding constraint once images are downsized to 1568px (Anthropic's internal threshold).
const DEFAULT_MAX_BYTES = 500 * 1024;

// Smallest edge length (px) vision backends reliably accept. They tile images into
// fixed patches (Anthropic uses 28px) and reject degenerate sub-patch images — e.g.
// the 1x1 PNG an empty chart render emits — with a hard 400 ("Could not process
// image") that can poison the whole request. 200px is the smallest size Anthropic
// documents as valid (200x200 = 64 visual tokens); undersized images are scaled up.
const DEFAULT_MIN_DIMENSION = 200;

const DEFAULT_OPTIONS: Required<Omit<ImageResizeOptions, "excludeWebP">> = {
	// Anthropic's "internal recommended size" — Claude internally caps images at
	// 1568px on the longest edge before vision processing.
	maxWidth: 1568,
	maxHeight: 1568,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
	minDimension: DEFAULT_MIN_DIMENSION,
};

interface ImageHeaderDimensions {
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

function readImageHeaderDimensions(buffer: Uint8Array): ImageHeaderDimensions | undefined {
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
 * Set OMP_NO_WEBP to exclude WebP from encoding (llama.cpp STB doesn't decode it).
 *
 * Backed by `Bun.Image`: a chainable native pipeline that runs decode/transform/encode
 * off the JS thread when the terminal (`.bytes()`) is awaited.
 */
export async function resizeImage(img: ImageContent, options?: ImageResizeOptions): Promise<ResizedImage> {
	const excludeWebP = options?.excludeWebP ?? isWebPExcluded();
	const opts = { ...DEFAULT_OPTIONS, ...options, excludeWebP };
	const inputBuffer = Buffer.from(img.data, "base64");

	try {
		const { width: originalWidth, height: originalHeight, format } = await new Bun.Image(inputBuffer).metadata();
		// Trust decoded bytes over caller metadata. A mislabeled WebP must not take
		// the fast path when the target decoder explicitly excludes WebP.
		const sourceMime = format ? `image/${format}` : img.mimeType;

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
					return img.data;
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

		// Lift undersized inputs up to the minimum. A uniform scale covers the
		// common case (icons, the 1x1 chart) without distortion; an aspect ratio
		// too extreme to satisfy both floor and cap falls back to stretching the
		// lagging edge up to the floor via the default fit:"fill" resize.
		if (targetWidth < minDimension || targetHeight < minDimension) {
			const shortEdge = Math.min(targetWidth, targetHeight);
			const upscale = Math.min(minDimension / shortEdge, opts.maxWidth / targetWidth, opts.maxHeight / targetHeight);
			if (upscale > 1) {
				targetWidth = Math.round(targetWidth * upscale);
				targetHeight = Math.round(targetHeight * upscale);
			}
			targetWidth = Math.min(opts.maxWidth, Math.max(minDimension, targetWidth));
			targetHeight = Math.min(opts.maxHeight, Math.max(minDimension, targetHeight));
		}

		// First-attempt encoder: try PNG and JPEG (+ WebP if not excluded) — return smallest.
		// PNG wins for line art / few-color UI; JPEG wins for photographic content;
		// WebP usually beats JPEG by 25–35% but is disabled when OMP_NO_WEBP is set
		// because many local inference backends (llama.cpp STB) don't decode it.
		async function encodeSmallest(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: string }> {
			const candidates = await Promise.all([
				new Bun.Image(inputBuffer)
					.resize(width, height)
					.png()
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/png" })),
				new Bun.Image(inputBuffer)
					.resize(width, height)
					.jpeg({ quality })
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/jpeg" })),
				...(opts.excludeWebP
					? []
					: [
							new Bun.Image(inputBuffer)
								.resize(width, height)
								.webp({ quality })
								.bytes()
								.then(b => ({ buffer: b, mimeType: "image/webp" })),
						]),
			]);
			return pickSmallest(...candidates);
		}

		// Lossy encoder for quality/dimension fallback ladders. PNG is excluded since
		// it's lossless and doesn't respond to quality parameters. WebP is included
		// unless OMP_NO_WEBP is set (llama.cpp STB incompatibility).
		async function encodeLossy(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: string }> {
			const candidates = await Promise.all([
				new Bun.Image(inputBuffer)
					.resize(width, height)
					.jpeg({ quality })
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/jpeg" })),
				...(opts.excludeWebP
					? []
					: [
							new Bun.Image(inputBuffer)
								.resize(width, height)
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

		let best: { buffer: Uint8Array; mimeType: string };
		let finalWidth = targetWidth;
		let finalHeight = targetHeight;

		// First attempt: resize to target, try PNG/JPEG (+ WebP), pick smallest
		best = await encodeSmallest(targetWidth, targetHeight, opts.jpegQuality);

		if (best.buffer.length <= opts.maxBytes) {
			return {
				buffer: best.buffer,
				mimeType: best.mimeType,
				originalWidth,
				originalHeight,
				width: finalWidth,
				height: finalHeight,
				wasResized: true,
				get data() {
					return Buffer.from(best.buffer).toBase64();
				},
			};
		}

		// Still too large — lossy JPEG (+ WebP) ladder with decreasing quality
		for (const quality of qualitySteps) {
			best = await encodeLossy(targetWidth, targetHeight, quality);

			if (best.buffer.length <= opts.maxBytes) {
				return {
					buffer: best.buffer,
					mimeType: best.mimeType,
					originalWidth,
					originalHeight,
					width: finalWidth,
					height: finalHeight,
					wasResized: true,
					get data() {
						return Buffer.from(best.buffer).toBase64();
					},
				};
			}
		}

		// Still too large — reduce dimensions progressively with the lossy ladder
		for (const scale of scaleSteps) {
			finalWidth = Math.round(targetWidth * scale);
			finalHeight = Math.round(targetHeight * scale);

			if (finalWidth < 100 || finalHeight < 100) {
				break;
			}

			for (const quality of qualitySteps) {
				best = await encodeLossy(finalWidth, finalHeight, quality);

				if (best.buffer.length <= opts.maxBytes) {
					return {
						buffer: best.buffer,
						mimeType: best.mimeType,
						originalWidth,
						originalHeight,
						width: finalWidth,
						height: finalHeight,
						wasResized: true,
						get data() {
							return Buffer.from(best.buffer).toBase64();
						},
					};
				}
			}
		}

		// Last resort: return smallest version we produced
		return {
			buffer: best.buffer,
			mimeType: best.mimeType,
			originalWidth,
			originalHeight,
			width: finalWidth,
			height: finalHeight,
			wasResized: true,
			get data() {
				return Buffer.from(best.buffer).toBase64();
			},
		};
	} catch {
		const headerDimensions = readImageHeaderDimensions(inputBuffer);
		const fallbackMimeType = img.mimeType ?? headerDimensions?.mimeType ?? "application/octet-stream";
		// Bun.Image rejected the input — we cannot decode/re-encode it.
		// When the caller demanded WebP exclusion AND the source might be WebP,
		// returning the original buffer would silently violate that contract,
		// so surface an explicit error instead.
		if (excludeWebP && (fallbackMimeType === "image/webp" || (!img.mimeType && !headerDimensions))) {
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
				return img.data;
			},
		};
	}
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
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
