import type { ImageContent } from "@oh-my-pi/pi-ai";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { prompt } from "@oh-my-pi/pi-utils";
import imageAttachmentPrompt from "../prompts/system/image-attachment.md" with { type: "text" };
import videoAttachmentPrompt from "../prompts/system/video-attachment.md" with { type: "text" };
import { IMAGE_ATTACHMENT_TYPE, VIDEO_ATTACHMENT_TYPE } from "./queued-messages";

/** Structured copy of the notice's attachment index and source path for transcript renderers. */
export interface AttachmentSourceNoticeDetails {
	index: number;
	path: string;
}

/** Model-facing notice naming the file behind an image or video attachment. */
export interface AttachmentSourceNotice {
	customType: typeof IMAGE_ATTACHMENT_TYPE | typeof VIDEO_ATTACHMENT_TYPE;
	content: string;
	details: AttachmentSourceNoticeDetails;
}

/**
 * Render the notice for attachment `[Image #index]` / `[Video #index]` so the model can `read`,
 * copy, or upload its file. Undefined when no file backs the attachment.
 */
export function renderAttachmentSourceNotice(
	image: ImageContent,
	index: number,
	options?: { askAnswer?: boolean },
): AttachmentSourceNotice | undefined {
	const source = imageAttachmentSource(image);
	if (!source) return undefined;
	const isVideo = source.kind === "video";
	return {
		customType: isVideo ? VIDEO_ATTACHMENT_TYPE : IMAGE_ATTACHMENT_TYPE,
		content: prompt.render(isVideo ? videoAttachmentPrompt : imageAttachmentPrompt, {
			index: String(index),
			path: source.path,
			askAnswer: options?.askAnswer,
		}),
		details: { index, path: source.path },
	};
}
