import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type SourceTaggedImage, imageAttachmentSource, tagImageAttachmentSource } from "./image-source";

/** Container extensions treated as video. Mirrors the video subset of the local-protocol binary list. */
const VIDEO_EXTENSION_LOOKUP: Record<string, true> = {
	".mp4": true,
	".mov": true,
	".mkv": true,
	".webm": true,
	".m4v": true,
	".avi": true,
	".wmv": true,
};

/** True when the path names a video container we handle through ffmpeg. */
export function isVideoPath(filePath: string): boolean {
	return VIDEO_EXTENSION_LOOKUP[path.extname(filePath).toLowerCase()] === true;
}

/** A contact-sheet image tagged with the original local video path. */
export type VideoPreviewImage = SourceTaggedImage;

/** Create a model-ready contact-sheet image tagged with its original video path. */
export function createVideoPreviewImage(preview: ImageContent, sourcePath: string): VideoPreviewImage {
	return tagImageAttachmentSource(preview, sourcePath, "video");
}

/**
 * Return the original video path associated with a generated contact-sheet
 * image, via the shared attachment-source tag (see {@link tagImageAttachmentSource}).
 * Returns undefined for untagged images and for image-file (non-video) sources.
 */
export function videoPreviewSource(preview: ImageContent): string | undefined {
	const source = imageAttachmentSource(preview);
	return source?.kind === "video" ? source.path : undefined;
}
