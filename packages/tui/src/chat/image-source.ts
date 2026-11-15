/**
 * Source-level handling of a line that is nothing but a Markdown image:
 * splitting prose around it ({@link splitImageFigures}) and resolving its
 * target to the local file {@link RasterFigure} draws. Only a target naming a
 * local file lifts; a relative path stays prose because the reader's terminal
 * would resolve it against its own cwd, and a URL stays prose because a
 * renderer MUST NOT fetch the network mid-transcript.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FigureSegment } from "./svg-source";

/**
 * A picture larger than this stays the line the model wrote. A transcript entry
 * is read for a glance, and a multi-megabyte file read per repaint is a memory
 * cost the reader never asked for; the reader can still open the path.
 */
export const MAX_PICTURE_BYTES = 32 * 1024 * 1024;

/** The formats {@link getImageDimensions} reads and a terminal can be handed by path. */
const PICTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * Whether `path` names a local picture a renderer may draw: a regular file of
 * one of the four formats, non-empty and within {@link MAX_PICTURE_BYTES}. A
 * terminal that loads the file itself renders without reading it here, so the
 * check is two `stat` calls on the extension instead of a read: a device
 * (`/dev/zero`), a directory or an oversized file stays prose.
 */
export function drawablePictureFile(path: string): boolean {
	if (!PICTURE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
	try {
		const stats = statSync(path);
		return stats.isFile() && stats.size > 0 && stats.size <= MAX_PICTURE_BYTES;
	} catch {
		return false;
	}
}

/** `![alt](target "title")` alone on a line, indented at most three spaces. */
const IMAGE_LINE = /^ {0,3}!\[([^\]\n]*)\]\(\s*<?([^\s()<>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)\s*$/;
/** What an image split produces: prose, or the local file an image line named. */
export type ImageFigureSegment = Extract<FigureSegment, { kind: "markdown" | "image" }>;
/** A fence opener, so an image line inside a code block is not lifted. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Whether `markdown` holds a line {@link splitImageFigures} would lift. Cheap to ask: assistant blocks are prose-sized. */
export function hasImageFigure(markdown: string): boolean {
	return markdown.includes("![") && splitImageFigures(markdown).some(segment => segment.kind === "image");
}

/**
 * Split `markdown` into prose and local-image lines, in order. Fenced code is
 * left alone, as is any line a {@link imageTargetPath} cannot resolve: those
 * are the reader's text, not a figure. Blank prose runs are dropped.
 */
export function splitImageFigures(markdown: string): ImageFigureSegment[] {
	const segments: ImageFigureSegment[] = [];
	let proseStart = 0;
	let lineStart = 0;
	let fence: string | undefined;
	while (lineStart <= markdown.length) {
		let lineEnd = lineStart;
		while (lineEnd < markdown.length && markdown[lineEnd] !== "\n" && markdown[lineEnd] !== "\r") lineEnd++;
		const next =
			lineEnd === markdown.length
				? markdown.length + 1
				: lineEnd + (markdown[lineEnd] === "\r" && markdown[lineEnd + 1] === "\n" ? 2 : 1);
		const line = markdown.slice(lineStart, lineEnd);
		if (fence !== undefined) {
			if (closesFence(line, fence)) fence = undefined;
			lineStart = next;
			continue;
		}
		const open = FENCE_OPEN.exec(line);
		if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
			fence = open[1]!;
			lineStart = next;
			continue;
		}
		const image = IMAGE_LINE.exec(line);
		const path = image ? imageTargetPath(image[2]!) : undefined;
		if (image && path !== undefined) {
			const prose = markdown.slice(proseStart, lineStart);
			if (prose.trim()) segments.push({ kind: "markdown", text: prose });
			segments.push({ kind: "image", path, alt: image[1]!.trim() });
			proseStart = Math.min(next, markdown.length);
		}
		lineStart = next;
	}
	const prose = markdown.slice(proseStart);
	if (prose.trim()) segments.push({ kind: "markdown", text: prose });
	return segments;
}

/**
 * The local file `target` names: an absolute path, a `~/` home path, or a
 * `file://` URL. Every other form — relative paths, `http(s)`, `//host`,
 * `data:`, internal `local://` names — is not a file a transcript may draw.
 */
export function imageTargetPath(target: string): string | undefined {
	if (target.startsWith("file://")) {
		try {
			return fileURLToPath(target);
		} catch {
			return undefined;
		}
	}
	if (target === "~" || target.startsWith("~/")) return join(homedir(), target.slice(1));
	return isAbsolute(target) ? target : undefined;
}

/** Whether `line` closes a fence opened by `marker`: same character, at least as long, nothing after. */
function closesFence(line: string, marker: string): boolean {
	let index = 0;
	while (index < 3 && line[index] === " ") index++;
	let run = 0;
	while (line[index + run] === marker[0]) run++;
	return run >= marker.length && line.slice(index + run).trim() === "";
}
