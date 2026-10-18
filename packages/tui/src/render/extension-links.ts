/**
 * Links whose scheme an extension registered (`pi.registerLinkScheme`). Markdown draws them
 * without the ` (url)` suffix. While inline mouse routing is on, the rendered row carries an OSC 8
 * marker with the URL so a click's cell can be traced back to it ({@link extensionLinkAt}); the TUI
 * strips that marker from every row it writes ({@link stripExtensionLinkMarkers}), so the terminal
 * never receives the link as a hyperlink it could open.
 */
import { isNativeRendering, onNativeRenderingChange } from "../native/state";
import { visibleWidth } from "../utils";

let schemes: ReadonlySet<string> = new Set();
let routed = false;
let version = 0;
let unroutedListener: (() => void) | undefined;
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
 * Set the registered schemes (lowercase, without `:`) and whether clicks are routed to them.
 * Bumps {@link extensionLinksVersion} on any change so cached markdown renders are redrawn.
 */
export function setExtensionLinks(next: Iterable<string>, clicksRouted: boolean): void {
	const nextSchemes = new Set(next);
	const routedNow = clicksRouted && nextSchemes.size > 0;
	if (routedNow === routed && nextSchemes.size === schemes.size && [...nextSchemes].every(s => schemes.has(s))) return;
	schemes = nextSchemes;
	routed = routedNow;
	version++;
}

/** Changes whenever the scheme set or routing changes; part of the markdown render cache key. */
export function extensionLinksVersion(): number {
	return version;
}

/** Whether a click on a registered-scheme link reaches its extension: routing on, in a plain terminal. */
export function extensionLinkClicksRouted(): boolean {
	return routed && !isNativeRendering();
}

/**
 * Called whenever markdown draws a registered-scheme link while clicks are not routed in a plain
 * terminal, so the product can tell the user how to make it clickable. `undefined` unsubscribes.
 */
export function onUnroutedExtensionLink(listener: (() => void) | undefined): void {
	unroutedListener = listener;
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
 * Draw an extension link's label: wrapped in the OSC 8 marker {@link extensionLinkAt} reads back
 * while clicks are routed in a plain terminal, plain otherwise. Never followed by a ` (url)` suffix.
 */
export function formatExtensionLink(label: string, href: string): string {
	if (isNativeRendering()) return label;
	if (!routed) {
		unroutedListener?.();
		return label;
	}
	const safe = href.replaceAll("\x1b", "").replaceAll("\x07", "");
	return safe ? `${MARKER_OPEN}${safe}\x07${label}\x1b]8;;\x07` : label;
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

/**
 * The extension link drawn at 0-based cell `col` of a rendered row (before
 * {@link stripExtensionLinkMarkers}), or `undefined`. Only registered schemes match, so ordinary
 * hyperlinks and rows drawn for a scheme that is no longer registered never do.
 */
export function extensionLinkAt(line: string, col: number): string | undefined {
	if (schemes.size === 0 || col < 0 || !line.includes("\x1b]8;")) return undefined;
	let x = 0;
	let target = "";
	let cursor = 0;
	for (const match of line.matchAll(OSC8_PATTERN)) {
		x += visibleWidth(line.slice(cursor, match.index));
		if (col < x) return target && extensionLinkScheme(target) ? target : undefined;
		target = match[2]!;
		cursor = match.index + match[0].length;
	}
	x += visibleWidth(line.slice(cursor));
	return col < x && target && extensionLinkScheme(target) ? target : undefined;
}

/**
 * `line` with `style` applied to every label drawn for the registered link `url` (before
 * {@link stripExtensionLinkMarkers}), for a hover highlight. A label wrapped across rows is
 * restyled on each row it reaches; other text and links are untouched.
 */
export function restyleExtensionLink(line: string, url: string, style: (label: string) => string): string {
	if (extensionLinkScheme(url) === undefined || !line.includes("\x1b]8;")) return line;
	let out = "";
	let cursor = 0;
	let labelStart = -1;
	for (const match of line.matchAll(OSC8_PATTERN)) {
		if (labelStart >= 0) {
			out += style(line.slice(labelStart, match.index));
			cursor = match.index;
			labelStart = -1;
		}
		if (match[2] === url) {
			const end = match.index + match[0].length;
			out += line.slice(cursor, end);
			cursor = end;
			labelStart = end;
		}
	}
	if (labelStart >= 0) return out + style(line.slice(labelStart));
	return cursor === 0 ? line : out + line.slice(cursor);
}
