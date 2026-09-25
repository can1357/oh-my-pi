import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { formatBytes, parseImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

export const SUPPORTED_INPUT_IMAGE_MIME_TYPES = SUPPORTED_IMAGE_MIME_TYPES;

/**
 * Ollama and its local-backend family decode image input through llama.cpp /
 * `stb_image`, which is compiled without WebP support, so a WebP upload fails
 * with an opaque HTTP 400. Detect those models so the resize pipeline encodes
 * to PNG/JPEG instead — the automatic equivalent of `OMP_NO_WEBP=1`.
 */
export function modelLacksWebpSupport(
	model: Pick<Model, "provider" | "api" | "imageInputDecoder"> | undefined,
): boolean {
	if (!model) return false;
	return (
		model.imageInputDecoder === "stb" ||
		model.provider === "ollama" ||
		model.provider === "ollama-cloud" ||
		model.provider === "llama.cpp" ||
		model.provider === "lm-studio" ||
		model.provider === "local-server" ||
		model.api === "ollama-chat"
	);
}

/**
 * `true` when `model` cannot decode WebP, otherwise `undefined` so the
 * `OMP_NO_WEBP` env fallback in {@link resizeImage} still applies. Feed straight
 * into {@link ImageResizeOptions.excludeWebP}.
 */
export function webpExclusionForModel(model: Pick<Model, "provider" | "api"> | undefined): true | undefined {
	return modelLacksWebpSupport(model) ? true : undefined;
}

export class ImageInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Image file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "ImageInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

/**
 * Raised when image bytes cannot be decoded — a truncated stream, a payload
 * with a hole in the middle, or bytes that are not the container they claim.
 * Failing at ingress keeps them out of the transcript, where they would
 * otherwise be persisted and rejected by the provider on every later request,
 * with no way to resume the session.
 */
export class InvalidImageDataError extends Error {
	readonly reason: string;

	constructor(label: string, mimeType: string, reason: string) {
		super(`${label} is not a decodable ${mimeType} image: ${reason}`);
		this.name = "InvalidImageDataError";
		this.reason = reason;
	}
}

/**
 * Smallest raster the decode probe terminates into. The decode is the oracle,
 * so the output size cannot change the verdict — a 1x1 sink keeps the check
 * from allocating a full-size pixel buffer, a full-size PNG, and a base64
 * string for a payload that may be up to {@link MAX_IMAGE_INPUT_BYTES}.
 */
const DECODE_PROBE_EDGE_PX = 1;

/**
 * Why an image cannot be decoded, or `null` when it decodes.
 *
 * A full decode is the only check that matches what vision backends accept: a
 * middle-elided PNG keeps its signature, its header, and even a well-formed
 * `IEND` trailer, so header sniffing and chunk-framing walks both pass it —
 * while real-world images that decoders render happily do have odd framing, so
 * a structural walk rejects payloads providers accept. Decoding is the ground
 * truth on both sides. Callers on hot paths must cache the verdict.
 */
export async function imageDecodeFailureReason(image: ImageContent): Promise<string | null> {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return "invalid base64 image data";
	const normalizedData = image.data.replace(/=+$/, "");
	const bytes = Buffer.from(image.data, "base64");
	if (bytes.length === 0) return "empty image data";
	if (bytes.toString("base64").replace(/=+$/, "") !== normalizedData) return "invalid base64 image data";
	const detected = parseImageMetadata(bytes);
	if (detected && detected.mimeType !== image.mimeType.toLowerCase()) {
		return `declared ${image.mimeType} but contains ${detected.mimeType}`;
	}
	try {
		// Decode in full (that is what catches a hole in the compressed stream),
		// then terminate into a 1x1 raster's bytes instead of re-encoding at the
		// source dimensions and base64-ing a result nobody reads.
		await new Bun.Image(bytes).resize(DECODE_PROBE_EDGE_PX, DECODE_PROBE_EDGE_PX).png().bytes();
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Converts an image to PNG, rejecting when the runtime cannot decode or encode it. */
export async function convertImageToPng(image: ImageContent): Promise<ImageContent> {
	const bytes = Buffer.from(image.data, "base64");
	const data = await new Bun.Image(bytes).png().toBase64();
	return { ...image, data, mimeType: "image/png" };
}

export async function ensureSupportedImageInput(image: ImageContent): Promise<ImageContent | null> {
	if (SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) {
		return image;
	}
	try {
		return await convertImageToPng(image);
	} catch {
		return null;
	}
}
