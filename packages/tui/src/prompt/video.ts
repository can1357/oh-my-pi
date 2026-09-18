import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";

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

/**
 * Original local source path stored on a generated contact-sheet image. Symbol
 * metadata stays out of serialized/model-bound image data while traveling with
 * the draft object until AgentSession creates its hidden companion message.
 */
const kVideoPreviewSource = Symbol("video.previewSource");

/** A contact-sheet image tagged with the original local video path. */
export type VideoPreviewImage = ImageContent & {
	readonly [kVideoPreviewSource]: string;
};

/** Create a model-ready contact-sheet image tagged with its original video path. */
export function createVideoPreviewImage(preview: ImageContent, sourcePath: string): VideoPreviewImage {
	return {
		type: "image",
		data: preview.data,
		mimeType: preview.mimeType,
		[kVideoPreviewSource]: sourcePath,
	};
}

/** Return the original video path associated with a generated contact-sheet image. */
export function videoPreviewSource(preview: ImageContent): string | undefined {
	if (!(kVideoPreviewSource in preview)) return undefined;
	const sourcePath = preview[kVideoPreviewSource];
	return typeof sourcePath === "string" ? sourcePath : undefined;
}
