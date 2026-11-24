/**
 * Link targets of transcript images: the file an image opens when its
 * `[Image: …]` placeholder (or its undrawable fallback) is a link. An image
 * read from a file opens that file; any other (pasted, tool-produced) opens a
 * blob copy of its bytes the host writes once, the store that backs composer
 * chips. Looks ask only when the terminal draws links, so a terminal without
 * them never writes blobs.
 */
import { getBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { logger } from "@oh-my-pi/pi-utils";
import { blobExtensionForImageMimeType } from "../../utils/image-format";

/**
 * Terminal role (`term.role`) of the result images a tool block appends under its view's body
 * (while images are on); the tool block draws them under the card.
 */
export const RESULT_IMAGE_ROLE = "omp.tool.image";

/** Writes `data` to the host's blob store; `hash` is its SHA-256 hex when known. */
export type ImageBlobWriter = (
	data: Buffer,
	options: { readonly extension?: string; readonly hash?: string },
) => { readonly displayPath: string };

let writer: ImageBlobWriter | undefined;
/** Blob copies already written, by blob id (the bytes' SHA-256). */
const written = new Map<string, string>();
const WRITTEN_LIMIT = 256;

/** Register the host's blob writer; the returned disposer unregisters it unless another replaced it since. */
export function setImageBlobWriter(next: ImageBlobWriter): () => void {
	writer = next;
	written.clear();
	return () => {
		if (writer !== next) return;
		writer = undefined;
		written.clear();
	};
}

/**
 * The file the image registered as `blob` opens: `source` when it was read
 * from one, else a blob copy written through the host. Undefined when neither
 * exists (no writer, unknown blob, a failed write).
 */
export function imageLinkTarget(blob: string | undefined, source?: string): string | undefined {
	if (source) return source;
	if (!blob || !writer) return undefined;
	const cached = written.get(blob);
	if (cached) return cached;
	const entry = getBlob(blob);
	if (!entry) return undefined;
	try {
		const extension = blobExtensionForImageMimeType(entry.mime);
		const { displayPath } = writer(Buffer.from(entry.bytes), { ...(extension ? { extension } : {}), hash: blob });
		if (written.size >= WRITTEN_LIMIT) {
			const oldest = written.keys().next();
			if (!oldest.done) written.delete(oldest.value);
		}
		written.set(blob, displayPath);
		return displayPath;
	} catch (error) {
		logger.warn("Failed to write a transcript image blob", {
			mime: entry.mime,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
