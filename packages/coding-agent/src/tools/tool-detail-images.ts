/**
 * Detail-image payload access shared by the TUI (inline rendering) and session
 * image stripping.
 *
 * Tools that would bloat model context (`generate_image`, `eval`) carry image
 * payloads on `details.images` instead of `content`. An `xd://` device dispatch
 * nests the wrapped tool's details under `details.xdev.inner` (see
 * `tools/xdev.ts`), so both shapes must resolve to the one object that owns the
 * array — readers get the images and strippers can write back.
 */

/** Image payload carried on tool-result details. */
export interface ToolDetailImage {
	data?: string;
	mimeType?: string;
}

/** Recognize a detail entry with non-empty string image data and an optional string MIME type. */
export function isToolDetailImage(value: unknown): value is ToolDetailImage {
	if (
		!value ||
		typeof value !== "object" ||
		!("data" in value) ||
		typeof value.data !== "string" ||
		value.data.length === 0
	) {
		return false;
	}
	return !("mimeType" in value) || value.mimeType === undefined || typeof value.mimeType === "string";
}

/** Owner of the `images` array on a tool result's details; `undefined` when absent. */
export function toolDetailImagesOwner(details: unknown): { images: ToolDetailImage[] } | undefined {
	const direct = imagesArrayOwner(details);
	if (direct) return direct;
	if (!details || typeof details !== "object") return undefined;
	return imagesArrayOwner((details as { xdev?: { inner?: unknown } }).xdev?.inner);
}

function imagesArrayOwner(value: unknown): { images: ToolDetailImage[] } | undefined {
	if (!value || typeof value !== "object") return undefined;
	return Array.isArray((value as { images?: unknown }).images) ? (value as { images: ToolDetailImage[] }) : undefined;
}
