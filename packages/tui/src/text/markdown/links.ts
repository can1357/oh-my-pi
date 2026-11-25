/**
 * Extension links: links whose scheme the host registered (an extension owns
 * them, `pi.registerLinkScheme`). Markdown draws their label alone, underlined
 * in `mdExtensionLink`, wrapped in an OSC 8 marker carrying the href under the
 * reserved id {@link EXTENSION_LINK_ID}; wrapping repeats the marker on every
 * row the label spans. The marker is for the renderer's host only: whoever
 * draws the rows takes the markers out ({@link takeExtensionLinks}) and keeps
 * the label cells (the `md` painter turns them into mouse hits), so the
 * terminal never receives a hyperlink it would try to open itself.
 */
import { tokens } from "../ansi";
import { visibleWidth } from "../width";

/** OSC 8 `id` of extension link markers. */
export const EXTENSION_LINK_ID = "pi-extension-link";

const MARKER_OPEN = `\x1b]8;id=${EXTENSION_LINK_ID};`;
const OSC8 = "\x1b]8;";
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** The registered scheme set's test: whether `href` uses one of `schemes` (lowercase, without `:`). */
export function extensionLinkTest(schemes: Iterable<string>): ((href: string) => boolean) | undefined {
	const set = new Set(schemes);
	if (set.size === 0) return undefined;
	return href => {
		const colon = href.indexOf(":");
		return colon > 0 && set.has(href.slice(0, colon).toLowerCase());
	};
}

/** `label` (already styled) inside the extension link marker of `href`. */
export function extensionLinkMarker(href: string, label: string): string {
	return `${MARKER_OPEN}${href.replace(CONTROL, "")}\x07${label}\x1b]8;;\x07`;
}

/** An extension link label's cells on one row. */
export interface ExtensionLinkSpan {
	readonly href: string;
	/** First cell of the label on the row. */
	readonly start: number;
	/** Cell just past it. */
	readonly end: number;
	/** Only blank cells follow it on the row: a wrapped label may go on below. */
	readonly endsRow: boolean;
}

/** `row` without its extension link markers (other hyperlinks stay), and the label spans they marked. */
export function takeExtensionLinks(row: string): { readonly row: string; readonly links: ExtensionLinkSpan[] } {
	if (!row.includes(MARKER_OPEN)) return { row, links: [] };
	const links: { href: string; start: number; end: number; endsRow: boolean }[] = [];
	let out = "";
	let col = 0;
	let open: { href: string; start: number } | undefined;
	let afterLast = "";
	for (const token of tokens(row)) {
		if (token.escape && token.text.startsWith(OSC8)) {
			if (token.text.startsWith(MARKER_OPEN)) {
				const body = token.text.slice(MARKER_OPEN.length, token.text.endsWith("\x07") ? -1 : -2);
				open = { href: body, start: col };
				continue;
			}
			if (open && /^\x1b\]8;[^;]*;(?:\x07|\x1b\\)$/.test(token.text)) {
				if (col > open.start) links.push({ ...open, end: col, endsRow: false });
				open = undefined;
				afterLast = "";
				continue;
			}
		}
		out += token.text;
		// Escapes are zero-width except OSC 66 sized text.
		col += visibleWidth(token.text);
		if (!open && !token.escape) afterLast += token.text;
	}
	if (open && col > open.start) links.push({ ...open, end: col, endsRow: true });
	else if (links.length > 0 && afterLast.trim() === "") links[links.length - 1]!.endsRow = true;
	return { row: out, links };
}
