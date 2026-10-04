import type { ImageContent } from "@oh-my-pi/pi-ai";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";

/**
 * Dimension-based image token estimates shared by the local context counter
 * ({@link Tokenizer.countMessage}) and the native remote-compaction fit probe.
 * Both sides must price the same image the same way: when they disagreed
 * (1.2k flat locally vs a 12k flat worst case remotely) an image-heavy session
 * stayed under the local compaction trigger yet was refused as over-window by
 * the remote probe.
 *
 * Follows OpenAI's patch-based rule (32px patches, a per-detail pixel limit
 * and patch budget, x1.2 multiplier), which is also a close upper estimate for
 * other providers once omp has downscaled the image (≤1568px by default).
 */

/** OpenAI image `detail` values; `undefined` means the provider default (`auto`). */
export type ImageDetail = ImageContent["detail"];

export interface ImageSize {
	width: number;
	height: number;
}

const PATCH_PX = 32;
const PATCH_TOKEN_MULTIPLIER = 1.2;

interface DetailSizing {
	/** Longest side after the pixel-dimension fit. */
	maxDimension: number;
	/** Resizing patch budget, when the detail level defines one. */
	patchBudget?: number;
	/** Patches charged when the image size is unknown. */
	unknownPatches: number;
}

const LOW_SIZING: DetailSizing = { maxDimension: 512, unknownPatches: 16 * 16 };
const HIGH_SIZING: DetailSizing = { maxDimension: 2048, patchBudget: 2_500, unknownPatches: 2_500 };
// `auto` resolves to `original` sizing on current models, so it shares the
// larger budget rather than risk undercounting.
const ORIGINAL_SIZING: DetailSizing = { maxDimension: 6_000, patchBudget: 10_000, unknownPatches: 10_000 };

function sizingFor(detail: ImageDetail): DetailSizing {
	if (detail === "low") return LOW_SIZING;
	if (detail === "high") return HIGH_SIZING;
	return ORIGINAL_SIZING;
}

function countPatches(size: ImageSize, sizing: DetailSizing): number {
	let { width, height } = size;
	const longest = Math.max(width, height);
	if (longest > sizing.maxDimension) {
		const scale = sizing.maxDimension / longest;
		width = Math.max(1, Math.round(width * scale));
		height = Math.max(1, Math.round(height * scale));
	}
	const patches = Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX);
	const budget = sizing.patchBudget;
	if (budget === undefined || patches <= budget) return patches;

	const shrink = Math.sqrt((PATCH_PX * PATCH_PX * budget) / (width * height));
	const scaledW = (width * shrink) / PATCH_PX;
	const scaledH = (height * shrink) / PATCH_PX;
	const adjusted = shrink * Math.min(Math.floor(scaledW) / scaledW, Math.floor(scaledH) / scaledH);
	const resizedW = Math.floor(width * adjusted);
	const resizedH = Math.floor(height * adjusted);
	if (resizedW <= 0 || resizedH <= 0) return budget;
	return Math.min(budget, Math.ceil(resizedW / PATCH_PX) * Math.ceil(resizedH / PATCH_PX));
}

/**
 * Estimated input tokens for one image. Unknown dimensions (undecodable data,
 * remote URLs, provider file ids) charge the detail level's full patch budget.
 */
export function estimateImageTokens(size: ImageSize | null | undefined, detail?: ImageDetail): number {
	const sizing = sizingFor(detail);
	const patches = size && size.width > 0 && size.height > 0 ? countPatches(size, sizing) : sizing.unknownPatches;
	return Math.ceil(patches * PATCH_TOKEN_MULTIPLIER);
}

// Enough decoded bytes to reach a JPEG SOF marker behind typical EXIF/ICC
// segments; PNG/GIF/WebP need only the first 30 bytes. Multiple of 4 so the
// base64 slice decodes cleanly.
const HEADER_BASE64_CHARS = 4 * Math.ceil((64 * 1024) / 3);

/** Pixel size read from the header of base64-encoded image data, or null. */
export function base64ImageSize(base64: string): ImageSize | null {
	if (base64.length === 0) return null;
	const header = Buffer.from(base64.slice(0, HEADER_BASE64_CHARS), "base64");
	const metadata = parseImageMetadata(header);
	if (!metadata?.width || !metadata.height) return null;
	return { width: metadata.width, height: metadata.height };
}

/** Pixel size of a `data:<mime>;base64,` URL, or null for any other URL. */
export function dataUrlImageSize(url: string): ImageSize | null {
	if (!url.startsWith("data:")) return null;
	const comma = url.indexOf(",");
	if (comma < 0 || !url.slice(0, comma).endsWith(";base64")) return null;
	return base64ImageSize(url.slice(comma + 1));
}

/** {@link estimateImageTokens} for an in-memory image block. */
export function estimateImageContentTokens(image: Pick<ImageContent, "data" | "detail">): number {
	return estimateImageTokens(base64ImageSize(image.data), image.detail);
}
