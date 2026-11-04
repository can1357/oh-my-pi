/**
 * Text whose image markers are kept as structure.
 *
 * An `ask` answer numbers the images a person pasted (`[Image #N]` in their text, and a source
 * notice per image). When several answers share one message, their numbers must be shifted so
 * each marker names one image of that message. A marker is only ever a marker because the prompt
 * that took the answer inserted it there: the composer records the runs it built the field from
 * ({@link AttachmentTextPart}) and they travel here. Nothing searches the person's own words, so
 * a typed `user-[Image #1].png`, a quoted `"[Image #1]"` or a fenced block is delivered byte for
 * byte, whatever the shift.
 */
import type { AttachmentTextPart } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { formatVisionMarkerTail } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import type { ImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { renderAttachmentSourceNoticeText } from "./attachment-source-notice";

/** One run of marked text: literal text, a marker naming an attached image, or that image's source notice. */
export type ImageMarkedPart =
	| string
	| { type: "marker"; index: number; kind: "image" | "video"; tail: string }
	| { type: "notice"; index: number; source: ImageAttachmentSource };

/**
 * The runs a prompt recorded for one answer field as marked text, with the field's own image
 * numbers raised by `offset` so they name images of the whole answer.
 *
 * A marker past `imageCount` cannot name an image of this field — the host that built the runs
 * contradicted the image list it sent — so it stays the text it reads as, at the number the
 * person's own field gave it.
 */
export function markSuppliedParts(
	parts: readonly AttachmentTextPart[],
	offset: number,
	imageCount: number,
): ImageMarkedPart[] {
	const marked: ImageMarkedPart[] = [];
	for (const part of parts) {
		if (typeof part === "string") {
			if (part) marked.push(part);
		} else if (part.n > imageCount) {
			marked.push(formatVisionMarkerTail(part.kind, part.n, part.tail));
		} else {
			marked.push({ type: "marker", index: part.n + offset, kind: part.kind, tail: part.tail });
		}
	}
	return marked;
}

/** Render marked text with every marker and notice number raised by `shift`. */
export function renderImageMarkedText(parts: readonly ImageMarkedPart[], shift = 0): string {
	let out = "";
	for (const part of parts) {
		if (typeof part === "string") {
			out += part;
		} else if (part.type === "marker") {
			out += formatVisionMarkerTail(part.kind, part.index + shift, part.tail);
		} else {
			out += renderAttachmentSourceNoticeText(part.source, part.index + shift, { askAnswer: true });
		}
	}
	return out;
}
