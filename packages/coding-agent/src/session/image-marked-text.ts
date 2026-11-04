/**
 * Text whose image markers are kept as structure.
 *
 * An `ask` answer numbers the images a person pasted (`[Image #N]` in their text, and a source
 * notice per image). When several answers share one message, their numbers must be shifted so
 * each marker names one image of that message. Shifting by searching the rendered text would also
 * rewrite file names, code spans and the person's own words that only look like a marker, so the
 * answer keeps the markers it inserted as parts and is rendered again with a shift.
 */
import type { ImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { VISION_MARKER_REGEX } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { renderAttachmentSourceNoticeText } from "./attachment-source-notice";

/** One run of marked text: literal text, a marker naming an attached image, or that image's source notice. */
export type ImageMarkedPart =
	| string
	| { type: "marker"; index: number; kind: "Image" | "Video"; tail: string; attachmentRef: boolean }
	| { type: "notice"; index: number; source: ImageAttachmentSource };

/**
 * Split `text` into literal runs and the markers that name its own `imageCount` images, numbered
 * from `offset + 1`. A marker past `imageCount` or inside a code span stays literal text.
 */
export function markOwnImages(text: string, offset: number, imageCount: number): ImageMarkedPart[] {
	if (imageCount === 0) return text ? [text] : [];
	const parts: ImageMarkedPart[] = [];
	let literal = "";
	for (const { text: run, code } of codeSpanRuns(text)) {
		if (code) {
			literal += run;
			continue;
		}
		let last = 0;
		for (const match of run.matchAll(VISION_MARKER_REGEX)) {
			const index = Number(match[2]);
			if (index > imageCount) continue;
			literal += run.slice(last, match.index);
			if (literal) parts.push(literal);
			literal = "";
			parts.push({
				type: "marker",
				index: index + offset,
				kind: match[1] === "Video" ? "Video" : "Image",
				tail: match[3] ?? "",
				attachmentRef: match[4] !== undefined,
			});
			last = match.index + match[0].length;
		}
		literal += run.slice(last);
	}
	if (literal) parts.push(literal);
	return parts;
}

/** Render marked text with every marker and notice number raised by `shift`. */
export function renderImageMarkedText(parts: readonly ImageMarkedPart[], shift = 0): string {
	let out = "";
	for (const part of parts) {
		if (typeof part === "string") {
			out += part;
		} else if (part.type === "marker") {
			const index = part.index + shift;
			out += `[${part.kind} #${index}${part.tail}]${part.attachmentRef ? ` attachment://${index}` : ""}`;
		} else {
			out += renderAttachmentSourceNoticeText(part.source, part.index + shift, { askAnswer: true });
		}
	}
	return out;
}

/** Markdown code spans: a run of N backticks up to the next run of exactly N; an unclosed run is text. */
function* codeSpanRuns(text: string): Generator<{ text: string; code: boolean }> {
	let start = 0;
	let cursor = 0;
	while (cursor < text.length) {
		const open = text.indexOf("`", cursor);
		if (open === -1) break;
		let width = 1;
		while (text[open + width] === "`") width++;
		const close = findBacktickRun(text, open + width, width);
		if (close === -1) {
			cursor = open + width;
			continue;
		}
		if (open > start) yield { text: text.slice(start, open), code: false };
		yield { text: text.slice(open, close + width), code: true };
		start = cursor = close + width;
	}
	if (start < text.length) yield { text: text.slice(start), code: false };
}

function findBacktickRun(text: string, from: number, width: number): number {
	for (let at = text.indexOf("`", from); at !== -1; at = text.indexOf("`", at)) {
		let run = 1;
		while (text[at + run] === "`") run++;
		if (run === width) return at;
		at += run;
	}
	return -1;
}
