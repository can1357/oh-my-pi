import * as os from "node:os";
import * as path from "node:path";

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Writes each image under the OS temp dir and returns the absolute paths in order. */
export async function saveImagesToTemp(images: readonly { data: string; mimeType: string }[]): Promise<string[]> {
	const paths: string[] = [];
	for (const image of images) {
		const bytes = Buffer.from(image.data, "base64");
		const extension = IMAGE_EXTENSIONS[image.mimeType] ?? "png";
		const filepath = path.join(os.tmpdir(), `omp-image-${Bun.hash(bytes).toString(16)}.${extension}`);
		await Bun.write(filepath, bytes);
		paths.push(filepath);
	}
	return paths;
}

/** Model-facing link lines for saved images, one `Image saved: <path>` per line. */
export function imageLinkLines(paths: readonly string[]): string {
	return paths.map(filepath => `Image saved: ${filepath}`).join("\n");
}

/** Saves `images` and appends their link lines to `text`, separated from it by a newline when needed. */
export async function appendImageLinks(
	text: string,
	images: readonly { data: string; mimeType: string }[],
): Promise<string> {
	if (images.length === 0) return text;
	const lines = imageLinkLines(await saveImagesToTemp(images));
	if (text.length === 0) return lines;
	return text.endsWith("\n") ? `${text}${lines}` : `${text}\n${lines}`;
}
