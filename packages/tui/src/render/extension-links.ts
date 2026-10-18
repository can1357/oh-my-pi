/**
 * Links whose scheme an extension registered (`pi.registerLinkScheme`). Markdown draws them
 * without the ` (url)` suffix. In a plain terminal the rendered row carries an OSC 8 marker with the
 * URL so a click's cell or a hint tag can be traced back to it ({@link extensionLinkLabels}); the TUI
 * strips that marker from every row it writes ({@link stripExtensionLinkMarkers}), so the terminal
 * never receives the link as a hyperlink it could open.
 */
import { isNativeRendering, onNativeRenderingChange } from "../native/state";
import { visibleWidth } from "../utils";

let schemes: ReadonlySet<string> = new Set();
let version = 0;
let drawnListener: (() => void) | undefined;
// Tern's native view routes its own link clicks, so markers are drawn only for a plain terminal.
onNativeRenderingChange(() => {
	version++;
});

/** One OSC 8 sequence (BEL or ST terminated); group 1 is its params, group 2 its URI (empty for a close). */
const OSC8_PATTERN = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * The OSC 8 params tagging omp's own markers, so they are stripped from terminal output even after
 * their scheme is no longer registered.
 */
const MARKER_PARAMS = "id=omp-extension-link";
const MARKER_OPEN = `\x1b]8;${MARKER_PARAMS};`;

/**
 * Set the registered schemes (lowercase, without `:`). Bumps {@link extensionLinksVersion} on any
 * change so cached markdown renders are redrawn.
 */
export function setExtensionLinks(next: Iterable<string>): void {
	const nextSchemes = new Set(next);
	if (nextSchemes.size === schemes.size && [...nextSchemes].every(s => schemes.has(s))) return;
	schemes = nextSchemes;
	version++;
}

/** Changes whenever the scheme set changes; part of the markdown render cache key. */
export function extensionLinksVersion(): number {
	return version;
}

/**
 * Whether activating a registered-scheme link (a click or a hint tag) reaches its extension: a
 * scheme is registered and the terminal is plain.
 */
export function extensionLinksRouted(): boolean {
	return schemes.size > 0 && !isNativeRendering();
}

/**
 * Called whenever markdown draws a registered-scheme link a click or hint tag can reach, so the
 * product can tell the user how to pick it. `undefined` unsubscribes.
 */
export function onExtensionLinkDrawn(listener: (() => void) | undefined): void {
	drawnListener = listener;
}

/** The registered scheme `href` uses, or `undefined` for every other link. */
export function extensionLinkScheme(href: string): string | undefined {
	if (schemes.size === 0) return undefined;
	const colon = href.indexOf(":");
	if (colon <= 0) return undefined;
	const scheme = href.slice(0, colon).toLowerCase();
	return schemes.has(scheme) ? scheme : undefined;
}

/**
 * Draw an extension link's label: wrapped in the OSC 8 marker {@link extensionLinkLabels} reads back
 * in a plain terminal, plain in Tern's native view. Never followed by a ` (url)` suffix.
 */
export function formatExtensionLink(label: string, href: string): string {
	if (isNativeRendering()) return label;
	const safe = href.replaceAll("\x1b", "").replaceAll("\x07", "");
	if (!safe) return label;
	drawnListener?.();
	return `${MARKER_OPEN}${safe}\x07${label}\x1b]8;;\x07`;
}

/** Hint tag letters, home row first. */
const LINK_HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";

/**
 * Tags for `count` links in keyboard link-hint mode: single letters while they suffice, otherwise
 * two letters each, so no tag is a prefix of another. At most the alphabet squared (676) are made;
 * links past that stay untagged.
 */
export function linkHintTags(count: number): string[] {
	if (count <= LINK_HINT_ALPHABET.length) return LINK_HINT_ALPHABET.slice(0, Math.max(0, count)).split("");
	const tags: string[] = [];
	for (const first of LINK_HINT_ALPHABET) {
		for (const second of LINK_HINT_ALPHABET) {
			if (tags.length === count) return tags;
			tags.push(`${first}${second}`);
		}
	}
	return tags;
}

/**
 * `line` without omp's extension-link markers (the OSC 8 open and close around each), for terminal
 * output. Every other hyperlink is kept as is.
 */
export function stripExtensionLinkMarkers(line: string): string {
	if (!line.includes(MARKER_OPEN)) return line;
	let inside = false;
	return line.replace(OSC8_PATTERN, (sequence: string, params: string, uri: string) => {
		if (uri === "") {
			const closesOwn = inside;
			inside = false;
			return closesOwn ? "" : sequence;
		}
		inside = params === MARKER_PARAMS;
		return inside ? "" : sequence;
	});
}

/** One extension link label drawn on a rendered row (before {@link stripExtensionLinkMarkers}). */
export interface ExtensionLinkLabel {
	readonly url: string;
	/** First 0-based cell the label covers. */
	readonly start: number;
	/** Cell just past the label. */
	readonly end: number;
	/** Whether only blank cells follow the label on its row, so a wrapped label may go on below. */
	readonly endsRow: boolean;
	/** Code-unit range of the label's drawn text in the row. */
	readonly from: number;
	readonly to: number;
}

/**
 * The extension link labels drawn on a rendered row, left to right. Only registered schemes
 * match, so ordinary hyperlinks and rows drawn for a scheme that is no longer registered never do.
 */
export function extensionLinkLabels(line: string): ExtensionLinkLabel[] {
	if (schemes.size === 0 || !line.includes("\x1b]8;")) return [];
	const labels: ExtensionLinkLabel[] = [];
	let x = 0;
	let cursor = 0;
	let open: { url: string; start: number; from: number } | undefined;
	for (const match of line.matchAll(OSC8_PATTERN)) {
		x += visibleWidth(line.slice(cursor, match.index));
		if (open && x > open.start) labels.push({ ...open, end: x, endsRow: false, to: match.index });
		open = undefined;
		const uri = match[2]!;
		cursor = match.index + match[0].length;
		if (uri && extensionLinkScheme(uri)) open = { url: uri, start: x, from: cursor };
	}
	x += visibleWidth(line.slice(cursor));
	if (open && x > open.start) labels.push({ ...open, end: x, endsRow: true, to: line.length });
	const last = labels.at(-1);
	if (last && !last.endsRow && Bun.stripANSI(line.slice(last.to)).trim() === "") {
		labels[labels.length - 1] = { ...last, endsRow: true };
	}
	return labels;
}

/** `line` with `style` applied to `label`, one of its {@link extensionLinkLabels}, for a hover highlight. */
export function restyleExtensionLinkLabel(
	line: string,
	label: ExtensionLinkLabel,
	style: (label: string) => string,
): string {
	return `${line.slice(0, label.from)}${style(line.slice(label.from, label.to))}${line.slice(label.to)}`;
}
