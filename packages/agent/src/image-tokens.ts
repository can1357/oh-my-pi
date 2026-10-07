import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type ImageSize,
	type ImageTokenization,
	imageTokens,
	resolveImageTokenization,
} from "@oh-my-pi/pi-catalog/compat/image-tokenization";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";

/**
 * Dimension-based image token estimates shared by the local context counter
 * ({@link Tokenizer.countMessage}) and the native remote-compaction fit probe.
 * Both sides must price the same image the same way: when they disagreed
 * (1.2k flat locally vs a 12k flat worst case remotely) an image-heavy session
 * stayed under the local compaction trigger yet was refused as over-window by
 * the remote probe.
 *
 * Follows the catalog's image rule for the OpenAI Responses wire (GPT-5.5's
 * 32px patches, a per-detail pixel limit and patch budget, x1.2 multiplier),
 * which is also a close upper estimate for other providers once omp has
 * downscaled the image (≤1568px by default).
 */

/** OpenAI image `detail` values; `undefined` means the provider default (`auto`). */
export type ImageDetail = ImageContent["detail"];

export type { ImageSize };

// Larger than every detail level's pixel limit, so an unknown size charges
// the level's full patch budget.
const UNKNOWN_SIZE: ImageSize = { width: 65_535, height: 65_535 };

let wireRule: ImageTokenization | undefined;

/** The OpenAI Responses wire's image rule, resolved from the catalog once. */
function openAiWireRule(): ImageTokenization {
	if (wireRule) return wireRule;
	const rule = resolveImageTokenization({ api: "openai-responses" });
	if (!rule) throw new Error("The catalog has no image-tokenization rule for the openai-responses wire");
	wireRule = rule;
	return rule;
}

/**
 * Estimated input tokens for one image. Unknown dimensions (undecodable data,
 * remote URLs, provider file ids) charge the detail level's full patch budget.
 */
export function estimateImageTokens(size: ImageSize | null | undefined, detail?: ImageDetail): number {
	return imageTokens(openAiWireRule(), size && size.width > 0 && size.height > 0 ? size : UNKNOWN_SIZE, detail);
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
