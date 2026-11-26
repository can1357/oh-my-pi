/**
 * Operating-system-command text: OSC 8 hyperlinks and OSC 66 sized text.
 * Whether to emit them is the caller's (capability) decision; these only
 * encode, detect and strip.
 */
import { tokens } from "./ansi";

const OSC8 = "\x1b]8;";
const ST = "\x1b\\";
/** Bytes a terminal would read as the end of an OSC payload (or worse). */
const UNSAFE = /[\x00-\x1f\x7f-\x9f]/;
const UNSAFE_ALL = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * `text` linked to `uri` (OSC 8, ST-terminated). `id` groups the cells of
 * one link split across rows. Text already carrying a link, or a target with
 * control bytes, stays as given.
 */
export function hyperlink(text: string, uri: string, id?: string): string {
	if (text.includes(OSC8) || UNSAFE.test(uri) || (id !== undefined && /[\x00-\x1f\x7f-\x9f:;]/.test(id))) return text;
	const params = id === undefined ? "" : `id=${id}`;
	return `${OSC8}${params};${uri}${ST}${text}${OSC8};${ST}`;
}

/** Whether `text` opens an OSC 8 link. */
export function hasHyperlink(text: string): boolean {
	return text.includes(OSC8);
}

/** The target of the first OSC 8 link in `text`. */
export function hyperlinkTarget(text: string): string | undefined {
	for (const token of tokens(text)) {
		if (!token.escape || !token.text.startsWith(OSC8)) continue;
		const body = token.text.slice(OSC8.length, token.text.endsWith("\x07") ? -1 : -2);
		const uri = body.slice(body.indexOf(";") + 1);
		if (uri !== "") return uri;
	}
	return undefined;
}

/** `text` without its OSC 8 link markers (the linked text stays). */
export function stripHyperlinks(text: string): string {
	if (!text.includes(OSC8)) return text;
	let out = "";
	for (const token of tokens(text)) if (!token.escape || !token.text.startsWith(OSC8)) out += token.text;
	return out;
}

/** OSC 66 text-sizing parameters. */
export interface TextSizing {
	/** Cell scale: the text is `scale` rows tall and each cell `scale` columns wide. */
	scale?: 1 | 2 | 3;
	/** Cells the text occupies (before scaling); the terminal fits the text into them. */
	widthCells?: number;
	verticalAlign?: "top" | "bottom" | "center";
	horizontalAlign?: "left" | "right" | "center";
}

const ALIGN_VALUE: Readonly<Record<string, number>> = { top: 0, left: 0, bottom: 1, right: 1, center: 2 };

/** `text` as an OSC 66 sized span (control bytes become spaces; ST-terminated). */
export function textSized(text: string, sizing: TextSizing = {}): string {
	const fields: string[] = [];
	if (sizing.scale !== undefined) fields.push(`s=${sizing.scale}`);
	if (sizing.widthCells !== undefined && Number.isFinite(sizing.widthCells)) {
		fields.push(`w=${Math.max(0, Math.trunc(sizing.widthCells))}`);
	}
	if (sizing.verticalAlign !== undefined) fields.push(`v=${ALIGN_VALUE[sizing.verticalAlign]}`);
	if (sizing.horizontalAlign !== undefined) fields.push(`h=${ALIGN_VALUE[sizing.horizontalAlign]}`);
	const payload = UNSAFE.test(text) ? text.replace(UNSAFE_ALL, " ") : text;
	return `\x1b]66;${fields.join(":")};${payload}${ST}`;
}

/** Rows a terminal row with OSC 66 spans occupies: the largest scale in it (1 without spans). */
export function textSizedRows(line: string): number {
	if (!line.includes("\x1b]66;")) return 1;
	let rows = 1;
	for (const token of tokens(line)) {
		if (!token.escape || !token.text.startsWith("\x1b]66;")) continue;
		const meta = token.text.slice(5, token.text.indexOf(";", 5));
		for (const field of meta.split(":")) {
			if (field.startsWith("s=")) rows = Math.max(rows, Number(field.slice(2)) || 1);
		}
	}
	return rows;
}
