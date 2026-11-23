/** Prompt images: decode what the user pasted, dropped or captured, cap its size, and encode it for the wire. */
import type { ImageContent } from "@oh-my-pi/pi-wire";

/** Longest edge sent to the model; larger images are scaled down (models downsample past this anyway). */
const MAX_EDGE = 1568;

/** A prompt-ready image and its pixel size. */
export interface PreparedImage {
	image: ImageContent;
	width: number;
	height: number;
}

/** Raised for files that are not images or that the browser cannot decode. */
export class NotAnImageError extends Error {
	constructor() {
		super("Not an image");
		this.name = "NotAnImageError";
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	return btoa(binary);
}

function fromBase64(data: string): Uint8Array<ArrayBuffer> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function encode(source: ImageBitmap, width: number, height: number, mimeType: string): Promise<ImageContent> {
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (context === null) throw new Error("Canvas is unavailable");
	context.imageSmoothingQuality = "high";
	context.drawImage(source, 0, 0, width, height);
	const blob = await canvas.convertToBlob({ type: mimeType, quality: 0.9 });
	return { type: "image", mimeType, data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
}

/**
 * Decode `blob` and return it ready for a prompt, scaled so its longest edge is at most `maxEdge`. Images already
 * small enough in a format models take pass through byte for byte.
 * @throws NotAnImageError when the blob is not a decodable image.
 */
export async function prepareImage(blob: Blob, maxEdge = MAX_EDGE): Promise<PreparedImage> {
	if (blob.type !== "" && !blob.type.startsWith("image/")) throw new NotAnImageError();
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(blob);
	} catch {
		throw new NotAnImageError();
	}
	try {
		const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
		const passthrough =
			scale === 1 && (blob.type === "image/png" || blob.type === "image/jpeg" || blob.type === "image/webp");
		if (passthrough) {
			const data = toBase64(new Uint8Array(await blob.arrayBuffer()));
			return { image: { type: "image", mimeType: blob.type, data }, width: bitmap.width, height: bitmap.height };
		}
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const mimeType = blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
		return { image: await encode(bitmap, width, height, mimeType), width, height };
	} finally {
		bitmap.close();
	}
}

/** {@link prepareImage} for an image that is already on the wire (worker captures, Teach screenshots). */
export function prepareWireImage(image: ImageContent, maxEdge = MAX_EDGE): Promise<PreparedImage> {
	return prepareImage(new Blob([fromBase64(image.data)], { type: image.mimeType }), maxEdge);
}

/** Pixel size of a wire image. */
export async function imageSize(image: ImageContent): Promise<{ width: number; height: number }> {
	const bitmap = await createImageBitmap(new Blob([fromBase64(image.data)], { type: image.mimeType }));
	const size = { width: bitmap.width, height: bitmap.height };
	bitmap.close();
	return size;
}
