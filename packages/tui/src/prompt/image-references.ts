import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { span } from "../native/describe";
import { isNativeRendering } from "../native/state";
import { fileHyperlink, fileLinkSpan, isHyperlinkEnabled, isNativeLinkEnabled } from "../render/hyperlink";
import { blobExtensionForImageMimeType } from "./image-format";

/** Materialized image destination returned by the host blob writer. */
interface ImageBlobResult {
	displayPath: string;
}
/** Probed pixel dimensions riding on the draft image object itself; `null` records a failed
 *  probe so the chips band never re-decodes a corrupt header every frame. */
const kImageDims = Symbol("omp.imageDimensions");

interface ImageContentWithDims extends ImageContent {
	[kImageDims]?: { width: number; height: number } | null;
}

/** Cached probe result for a draft image: dimensions, `null` (probe failed), or `undefined`
 *  (never probed). */
export function cachedImageDimensions(image: ImageContent): { width: number; height: number } | null | undefined {
	return (image as ImageContentWithDims)[kImageDims];
}

/** Record a probe result for a draft image (see {@link cachedImageDimensions}). */
export function setCachedImageDimensions(image: ImageContent, dims: { width: number; height: number } | null): void {
	(image as ImageContentWithDims)[kImageDims] = dims;
}

type ImageBlobWriter = (data: Buffer, options?: { extension?: string }) => Promise<ImageBlobResult>;
type ImageBlobWriterSync = (data: Buffer, options?: { extension?: string }) => ImageBlobResult;

export function imageReferenceHyperlink(
	label: string,
	index: number,
	imageLinks: readonly (string | undefined)[] | undefined,
	renderLabel: (text: string) => string,
): string {
	const rendered = renderLabel(label);
	const target = imageLinks?.[index - 1];
	return target ? fileHyperlink(target, rendered) : rendered;
}

async function materializeImageReferenceLinkAsync(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriter,
): Promise<string | undefined> {
	try {
		const result = await putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function materializeImageReferenceLink(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriterSync,
): string | undefined {
	try {
		const result = putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export async function materializeImageReferenceLinks(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriter,
): Promise<(string | undefined)[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const links = await Promise.all(
		images.map((image, index) => materializeImageReferenceLinkAsync(image, index + 1, putBlob)),
	);
	return links.some(link => link !== undefined) ? links : undefined;
}

export function materializeImageReferenceLinksSync(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriterSync,
): (string | undefined)[] | undefined {
	if (!images || images.length === 0) return undefined;
	const links = images.map((image, index) => materializeImageReferenceLink(image, index + 1, putBlob));
	return links.some(link => link !== undefined) ? links : undefined;
}

let hostBlobWriter: ImageBlobWriterSync | undefined;
/** Blob paths already written for an image payload, keyed by mime type and content hash. */
const blobLinks = new Map<string, string>();
const BLOB_LINK_CACHE_LIMIT = 256;

/**
 * Register the host's blob writer that backs links for images without a file of their
 * own. Returns a disposer that unregisters it unless another writer replaced it since.
 */
export function setImageBlobWriter(next: ImageBlobWriterSync): () => void {
	hostBlobWriter = next;
	blobLinks.clear();
	return () => {
		if (hostBlobWriter !== next) return;
		hostBlobWriter = undefined;
		blobLinks.clear();
	};
}

/**
 * Whether transcript images carry links under the current `tui.hyperlinks` policy: a
 * native surface honours only an explicit `off`, text mode the resolved OSC 8 support.
 * Renderers caching a linked image key their cache on it.
 */
export function imageLinksEnabled(): boolean {
	return isNativeRendering() ? isNativeLinkEnabled() : isHyperlinkEnabled();
}

/**
 * The file a transcript image opens: `sourcePath` when it was read from one, else a
 * blob copy of its bytes written through the host. Undefined when links are disabled
 * or no file exists, so a disabled policy never writes blobs.
 */
export function transcriptImageLink(
	image: Pick<ImageContent, "data" | "mimeType">,
	sourcePath?: string,
): string | undefined {
	if (!imageLinksEnabled()) return undefined;
	if (sourcePath) return sourcePath;
	if (!hostBlobWriter || !image.data) return undefined;
	const key = `${image.mimeType}:${Bun.hash(image.data)}`;
	const cached = blobLinks.get(key);
	if (cached) return cached;
	const link = materializeImageReferenceLink({ type: "image", ...image }, 1, hostBlobWriter);
	if (!link) return undefined;
	if (blobLinks.size >= BLOB_LINK_CACHE_LIMIT) {
		const oldest = blobLinks.keys().next();
		if (!oldest.done) blobLinks.delete(oldest.value);
	}
	blobLinks.set(key, link);
	return link;
}

/** `text` (an image's placeholder) as an OSC 8 link to the image's file; plain when hyperlinks are off or no file exists. */
export function linkedImageText(
	text: string,
	image: Pick<ImageContent, "data" | "mimeType">,
	sourcePath?: string,
): string {
	if (!isHyperlinkEnabled()) return text;
	const target = transcriptImageLink(image, sourcePath);
	return target ? fileHyperlink(target, text) : text;
}

/** Native counterpart of {@link linkedImageText}: a span linking to the image's file when one exists. */
export function linkedImageSpan(
	text: string,
	image: Pick<ImageContent, "data" | "mimeType">,
	sourcePath: string | undefined,
	s?: string,
): TspSpan {
	const target = transcriptImageLink(image, sourcePath);
	return target ? fileLinkSpan(target, text, s) : span(text, s);
}
