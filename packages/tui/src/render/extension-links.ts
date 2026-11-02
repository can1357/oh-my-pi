/**
 * Links whose scheme an extension registered (`pi.registerLinkScheme`). Markdown draws them
 * without the ` (url)` suffix. In a plain terminal the rendered row carries an OSC 8 marker with the
 * URL so a click's cell or a hint tag can be traced back to it ({@link extensionLinkLabels}); the TUI
 * strips that marker from every row it writes ({@link stripExtensionLinkMarkers}), so the terminal
 * never receives the link as a hyperlink it could open.
 */
import { isNativeRendering, onNativeRenderingChange } from "../native/state";
import { TERMINAL } from "../terminal-capabilities";
import { visibleWidth } from "../utils";

let schemes: ReadonlySet<string> = new Set();
let version = 0;
let pickingProvider: (() => boolean) | undefined;
// Tern's native view routes its own link clicks, so markers are drawn only for a plain terminal.
onNativeRenderingChange(() => {
	version++;
});

/** One OSC 8 sequence (BEL or ST terminated); group 1 is its params, group 2 its URI (empty for a close). */
const OSC8_PATTERN = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * The OSC 8 params tagging omp's own markers, so they are stripped from terminal output even after
 * their scheme is no longer registered. Each drawn link gets its own `-<n>` suffix, derived from the
 * link itself so every render of the same text draws the same bytes; a label wrapped across rows
 * repeats its marker, suffix included, on every row.
 */
const MARKER_ID = "id=omp-extension-link";
const MARKER_PARAMS_PATTERN = /^id=omp-extension-link(?:-\d+)?$/;
const MARKER_OPEN = `\x1b]8;${MARKER_ID}`;

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
 * Set by the interactive product: whether the user has a way to pick a link drawn now (a bound
 * hint key, mouse clicks). `undefined` when nothing in this process can pick one.
 */
export function setExtensionLinkPicking(provider: (() => boolean) | undefined): void {
	pickingProvider = provider;
}

/**
 * Whether a registered-scheme link drawn now can be activated: links are routed and the product
 * offers a way to pick them. Process-wide, so a UI-less extension runner (a subagent's, whose
 * transcript the user may focus) answers like the interactive one.
 */
export function extensionLinkClicksAvailable(): boolean {
	return extensionLinksRouted() && pickingProvider?.() === true;
}

/** The registered scheme `href` uses, or `undefined` for every other link. */
export function extensionLinkScheme(href: string): string | undefined {
	if (schemes.size === 0) return undefined;
	const colon = href.indexOf(":");
	if (colon <= 0) return undefined;
	const scheme = href.slice(0, colon).toLowerCase();
	return schemes.has(scheme) ? scheme : undefined;
}

/** Dotted underline (`4:4`) where the terminal draws styled underlines, else the plain one. */
const UNDERLINE = TERMINAL.styledUnderlines
	? { on: "\x1b[4:4m", off: "\x1b[4:0m" }
	: { on: "\x1b[4m", off: "\x1b[24m" };

/** An SGR sequence; group 1 is its params. */
const SGR_PATTERN = /\x1b\[([0-9:;]*)m/g;

/** Whether an SGR with these params turns underlining off: a full reset, `24` or `4:0`. */
function endsUnderline(params: string): boolean {
	const codes = params.split(";");
	for (let index = 0; index < codes.length; index++) {
		const code = codes[index]!;
		if (code === "" || code === "0" || code === "24" || code === "4:0") return true;
		// Skip a color's arguments: `38;5;n` / `38;2;r;g;b` (also 48 and 58), whose `0`s are no reset.
		if (code === "38" || code === "48" || code === "58") {
			const mode = codes[index + 1];
			index += mode === "5" ? 2 : mode === "2" ? 4 : 0;
		}
	}
	return false;
}

/**
 * Draw an extension link's label: dotted-underlined (plain underline where the terminal has no
 * styled underlines, re-applied after any style reset inside it) and wrapped in the OSC 8 marker
 * {@link extensionLinkLabels} reads back in a plain terminal; as given in Tern's native view. Never
 * followed by a ` (url)` suffix. `key` tells apart links of one URL drawn near each other; it must
 * not change between renders of the same text, or rows rendered twice stop matching.
 */
export function formatExtensionLink(label: string, href: string, key: string): string {
	if (isNativeRendering()) return label;
	const safe = href.replaceAll("\x1b", "").replaceAll("\x07", "");
	if (!safe) return label;
	const body = label.replace(SGR_PATTERN, (sequence, params: string) =>
		endsUnderline(params) ? sequence + UNDERLINE.on : sequence,
	);
	const id = Bun.hash.crc32(`${safe}\0${key}`);
	return `${MARKER_OPEN}-${id};${safe}\x07${UNDERLINE.on}${body}${UNDERLINE.off}\x1b]8;;\x07`;
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
 * `line` without omp's extension-link markers (the OSC 8 open and close around each label), for
 * terminal output. Every other hyperlink is kept as is.
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
		inside = MARKER_PARAMS_PATTERN.test(params);
		return inside ? "" : sequence;
	});
}

/** One extension link label drawn on a rendered row (before {@link stripExtensionLinkMarkers}). */
export interface ExtensionLinkLabel {
	readonly url: string;
	/**
	 * The marker's params, unique to each drawn link and repeated on every row a wrapped label
	 * spans, so a row's parts of one label can be told from an adjacent label of the same URL.
	 */
	readonly id: string;
	/** First 0-based cell the label covers. */
	readonly start: number;
	/** Cell just past the label. */
	readonly end: number;
	/** Whether only blank cells follow the label on its row, so a wrapped label may go on below. */
	readonly endsRow: boolean;
}

/**
 * The extension link labels drawn on a rendered row, left to right. Only omp's own markers with a
 * registered scheme match, so ordinary hyperlinks (even of a registered scheme) and rows drawn for
 * a scheme that is no longer registered never do.
 */
export function extensionLinkLabels(line: string): ExtensionLinkLabel[] {
	if (schemes.size === 0 || !line.includes(MARKER_OPEN)) return [];
	const labels: ExtensionLinkLabel[] = [];
	let x = 0;
	let cursor = 0;
	/** Code-unit index where the last pushed label's text ends. */
	let lastClose = 0;
	let open: { url: string; id: string; start: number } | undefined;
	for (const match of line.matchAll(OSC8_PATTERN)) {
		x += visibleWidth(line.slice(cursor, match.index));
		if (open && x > open.start) {
			labels.push({ ...open, end: x, endsRow: false });
			lastClose = match.index;
		}
		open = undefined;
		const params = match[1]!;
		const uri = match[2]!;
		cursor = match.index + match[0].length;
		if (uri && MARKER_PARAMS_PATTERN.test(params) && extensionLinkScheme(uri)) {
			open = { url: uri, id: params, start: x };
		}
	}
	x += visibleWidth(line.slice(cursor));
	if (open && x > open.start) {
		labels.push({ ...open, end: x, endsRow: true });
	} else {
		const last = labels.at(-1);
		if (last && Bun.stripANSI(line.slice(lastClose)).trim() === "")
			labels[labels.length - 1] = { ...last, endsRow: true };
	}
	return labels;
}
