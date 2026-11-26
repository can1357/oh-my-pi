import type { ImageContent } from "@oh-my-pi/pi-ai";

/** Converts an image to PNG, rejecting when the runtime cannot decode or encode it. */
export async function convertImageToPng(image: ImageContent): Promise<ImageContent> {
	const bytes = Buffer.from(image.data, "base64");
	const data = await new Bun.Image(bytes).png().toBase64();
	return { ...image, data, mimeType: "image/png" };
}
