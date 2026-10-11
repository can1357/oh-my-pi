import type { ImageContent } from "@oh-my-pi/pi-ai";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";

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

		// Lift undersized inputs toward the minimum with a uniform scale that never
		// crosses a cap (icons, the 1x1 chart). A strip too wide or tall for both
		// (a toolbar crop) keeps its aspect ratio and ends with its short edge below
		// the floor; stretching it would distort what the model sees.
		if (targetWidth < minDimension || targetHeight < minDimension) {
			const shortEdge = Math.min(targetWidth, targetHeight);
			const upscale = Math.min(minDimension / shortEdge, opts.maxWidth / targetWidth, opts.maxHeight / targetHeight);
			if (upscale > 1) {
				targetWidth = Math.min(opts.maxWidth, Math.round(targetWidth * upscale));
				targetHeight = Math.min(opts.maxHeight, Math.round(targetHeight * upscale));
			}
		}

		// Lossy encoder for quality/dimension fallback ladders. PNG is excluded since
		// it's lossless and doesn't respond to quality parameters. WebP is included
		// unless OMP_NO_WEBP is set (llama.cpp STB incompatibility). Ladder steps pass a
		// lossless PNG already at the target size, so each step only decodes that small
		// intermediate instead of re-decoding and re-resizing the source; when
		// `width`/`height` are given the source is resized first.
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
				pipeline()
					.jpeg({ quality })
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/jpeg" })),
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
		// The lossless PNG doubles as the intermediate for the quality ladder below.
		const [targetPng, firstLossy] = await Promise.all([
			new Bun.Image(inputBuffer).resize(targetWidth, targetHeight).png().bytes(),
			encodeLossy(inputBuffer, opts.jpegQuality, targetWidth, targetHeight),
		]);
		let best = pickSmallest({ buffer: targetPng, mimeType: "image/png" }, firstLossy);
		if (best.buffer.length <= opts.maxBytes) {
			return encodedResult(best, originalWidth, originalHeight, finalWidth, finalHeight);
		}

		// Still too large — lossy JPEG (+ WebP) ladder with decreasing quality
		for (const quality of qualitySteps) {
			best = await encodeLossy(targetPng, quality);
			if (best.buffer.length <= opts.maxBytes) {
				return encodedResult(best, originalWidth, originalHeight, finalWidth, finalHeight);
			}
		}

		// Still too large — reduce dimensions progressively with the lossy ladder
		for (const scale of scaleSteps) {
			finalWidth = Math.round(targetWidth * scale);
			finalHeight = Math.round(targetHeight * scale);

			if (finalWidth < 100 || finalHeight < 100) {
				break;
			}

			const resized =
				scale === 1
					? targetPng
					: await new Bun.Image(inputBuffer).resize(finalWidth, finalHeight).png({ compressionLevel: 0 }).bytes();
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

/** What a browser screenshot covers, which sets the CSS pixel space its image coordinates map to. */
export type ScreenshotArea = "viewport" | "page" | "element";

const SCREENSHOT_AREA_TARGET: Record<ScreenshotArea, string> = {
	viewport: "viewport CSS pixels for tab.clickAt",
	page: "CSS pixels from the page's top-left corner (tab.clickAt takes viewport pixels)",
	element: "CSS pixels from the element's top-left corner",
};

/**
 * Map displayed screenshot coordinates to the CSS pixels the page and `tab.clickAt` use: the capture
 * holds `scale` image pixels per CSS pixel before any resize, or `undefined` when it could not be read.
 */
function formatScreenshotCoordinateNote(
	resized: ResizedImage,
	capture: { area: ScreenshotArea; scale: number | undefined },
): string | undefined {
	if (!resized.originalWidth || !resized.width) return undefined;
	if (capture.scale === undefined || !(capture.scale > 0)) {
		return `[Image: original ${resized.originalWidth}x${resized.originalHeight}, displayed at ${resized.width}x${resized.height}. Its scale to CSS pixels could not be read; target elements by selector or id rather than tab.clickAt.]`;
	}
	const factor = (resized.originalWidth / resized.width / capture.scale).toFixed(2);
	if (factor === "1.00") return undefined;
	const scale = `capture scale ${Number(capture.scale.toFixed(2))}`;
	const size = resized.wasResized
		? `original ${resized.originalWidth}x${resized.originalHeight} at ${scale}, displayed at ${resized.width}x${resized.height}`
		: `${resized.width}x${resized.height} at ${scale}`;
	return `[Image: ${size}. Multiply image coordinates by ${factor} to get ${SCREENSHOT_AREA_TARGET[capture.area]}.]`;
}

/** Format browser screenshot metadata and the image-to-CSS-pixel mapping for tool output. */
export function formatScreenshot(opts: {
	saveFullRes: boolean;
	savedMimeType: string;
	savedByteLength: number;
	dest: string;
	resized: ResizedImage;
	capture: { area: ScreenshotArea; scale: number | undefined };
}): string[] {
	const lines = ["Screenshot captured"];
	if (opts.saveFullRes) {
		lines.push(
			`Saved: ${opts.savedMimeType} (${(opts.savedByteLength / 1024).toFixed(2)} KB) to ${shortenPath(opts.dest)}`,
		);
		lines.push(
			`Model: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB, ${opts.resized.width}x${opts.resized.height})`,
		);
	} else {
		lines.push(`Format: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB)`);
		lines.push(`Dimensions: ${opts.resized.width}x${opts.resized.height}`);
	}
	if (opts.resized.decodeFailed) {
		lines.push("Resize: image decoder failed; using original image bytes");
	}
	const coordinateNote = formatScreenshotCoordinateNote(opts.resized, opts.capture);
	if (coordinateNote) {
		lines.push(coordinateNote);
	}
	return lines;
}
