/**
 * Original filesystem source carried on image attachments that entered from a
 * file on disk: path-pasted/drag-and-dropped images and generated video
 * contact-sheet previews. Symbol metadata stays out of serialized/model-bound
 * image data while traveling with the draft object, until AgentSession creates
 * the hidden companion message that tells the model the path (and link
 * materialization prefers it over a blob copy).
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";

/** How an image attachment's backing file entered the session. */
export type ImageAttachmentSourceKind = "image" | "video";

/** Original local file backing an image attachment. */
export interface ImageAttachmentSource {
	readonly path: string;
	readonly kind: ImageAttachmentSourceKind;
}

const kImageAttachmentSource = Symbol("image.attachmentSource");

/** An image attachment tagged with the original local file it came from. */
export type SourceTaggedImage = ImageContent & {
	readonly [kImageAttachmentSource]: ImageAttachmentSource;
};

/** Create a model-ready image tagged with the local file it was loaded from. */
export function tagImageAttachmentSource(
	image: ImageContent,
	path: string,
	kind: ImageAttachmentSourceKind,
): SourceTaggedImage {
	return {
		type: "image",
		data: image.data,
		mimeType: image.mimeType,
		[kImageAttachmentSource]: { path, kind },
	};
}

/** Return the original local source of an image attachment, or undefined for payloads with no source file (clipboard bitmaps). */
export function imageAttachmentSource(image: ImageContent): ImageAttachmentSource | undefined {
	if (!(kImageAttachmentSource in image)) return undefined;
	const source = image[kImageAttachmentSource];
	return isRecord(source) && typeof source.path === "string" && (source.kind === "image" || source.kind === "video")
		? { path: source.path, kind: source.kind }
		: undefined;
}
