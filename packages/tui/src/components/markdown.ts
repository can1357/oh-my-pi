import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import {
	Lexer,
	Marked,
	type Token,
	type TokenizerAndRendererExtension,
	type TokenizerThis,
	type Tokens,
	type TokensList,
} from "@oh-my-pi/pi-utils/marked";
import {
	MathBlockScan,
	type MathBlockOpener,
	mathBlockAt,
	mathBlockCloserIndex,
	mathBlockMayCloseAt,
	mathBlockOpenerAt,
	mathSpanInContext,
	mathStartIndex,
} from "@oh-my-pi/pi-utils/math-delimiters";
import { latexToBlock } from "../latex-block";
import { isBareMathEnvironment, latexToUnicode } from "../latex-to-unicode";
import { plainText } from "../native/spans";
import { md } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import type { SymbolTheme } from "../symbols";
import { TERMINAL } from "../terminal-capabilities";
import { getSymbolTheme } from "../theme/theme";
import type { Component } from "../tui";
import {
	applyBackgroundToLine,
	Ellipsis,
	encodeTextSized,
	getPaddingX,
	getSegmenter,
	isOsc66Line,
	padding,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

// Marked treats the backslash in an ST-terminated OSC 8 sequence (`ESC \\`) as
// Markdown punctuation when it is immediately followed by markup such as a
// codespan backtick. Normalize well-formed OSC 8 prefixes to the equivalent BEL
// terminator before lexing so the control sequence stays opaque to Markdown.
const OSC8_ST_PREFIX_REGEX = /(\x1b\]8;[^\x07\x1b]*)\x1b\\/g;

function normalizeOsc8Terminators(text: string): string {
	return text.replace(OSC8_ST_PREFIX_REGEX, "$1\x07");
}

/** The longest suffix of `text` a future append could still complete into a
 *  full `\x1b]8;[^\x07\x1b]*\x1b\\` match: the last `\x1b]8;` plus clean
 *  body (or that plus the pending ST-ESC `\x1b`), or a strict prefix of the
 *  escape start. Any other suffix is already normalized or uncompletable
 *  (a BEL or an ESC follows it), so this is exactly the region a crossing
 *  match can occupy. */
function trailingOsc8Partial(text: string): string | undefined {
	const start = text.lastIndexOf("\x1b]8;");
	if (start !== -1) {
		const body = text.slice(start + 4);
		const cut = body.search(/[\x07\x1b]/);
		if (cut === -1 || (cut === body.length - 1 && body.charCodeAt(cut) === 0x1b)) {
			return text.slice(start);
		}
	}
	if (text.endsWith("\x1b]8;") || text.endsWith("\x1b]8") || text.endsWith("\x1b]") || text.endsWith("\x1b")) {
		return text.slice(text.lastIndexOf("\x1b"));
	}
	return undefined;
}

const MARKDOWN_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const MARKDOWN_HEADING_LINE = /^ {0,3}#{1,6}[ \t]+\S/;
const FENCED_SOURCE_INTRO = /\b(?:code|example|markdown|output|snippet|source)\s*:?\s*$/i;

function isGfmTableDelimiter(line: string, headerLine: string | undefined): boolean {
	if (!headerLine || !line.includes("|") || !headerLine.includes("|")) return false;
	const delimiterCells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	const headerCells = headerLine.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	return (
		delimiterCells.length >= 2 &&
		headerCells.length === delimiterCells.length &&
		delimiterCells.every(cell => /^:?-{3,}:?$/.test(cell.trim())) &&
		headerCells.every(cell => cell.trim().length > 0)
	);
}

/**
 * Gemini can emit a bare closing fence without its opener, then continue with
 * headings and tables. CommonMark must interpret that lone fence as an opener,
 * which turns the rest of an otherwise valid report into one raw code block.
 *
 * Repair only the unambiguous rich-document shape at final render: one
 * unmatched bare fence after prose, followed by both an ATX heading and a GFM
 * table delimiter. Keep ordinary incomplete code blocks, fenced Markdown
 * examples, and every matched fence untouched.
 */
function repairOrphanClosingFence(text: string): string {
	const lines = text.split("\n");
	let open: { index: number; marker: string; info: string } | undefined;
	for (let index = 0; index < lines.length; index++) {
		const match = MARKDOWN_FENCE_LINE.exec(lines[index]!);
		if (!match) continue;
		const marker = match[1]!;
		const info = match[2]!.trim();
		if (!open) {
			open = { index, marker, info };
			continue;
		}
		if (marker[0] === open.marker[0] && marker.length >= open.marker.length && info === "") {
			open = undefined;
		}
	}
	if (open?.info !== "") return text;

	let previous = "";
	for (let index = open.index - 1; index >= 0; index--) {
		previous = lines[index]!.trim();
		if (previous) break;
	}
	if (!previous || previous.endsWith(":") || FENCED_SOURCE_INTRO.test(previous)) return text;

	let hasHeading = false;
	let hasTableDelimiter = false;
	for (let index = open.index + 1; index < lines.length; index++) {
		const line = lines[index]!;
		hasHeading ||= MARKDOWN_HEADING_LINE.test(line);
		hasTableDelimiter ||= isGfmTableDelimiter(line, lines[index - 1]);
		if (hasHeading && hasTableDelimiter) {
			lines.splice(open.index, 1);
			return lines.join("\n");
		}
	}
	return text;
}

// OSC 66 (Kitty text-sizing) heading spans are emitted as a single indivisible
// unit by the H1 render path. Like image-protocol lines, they bypass ANSI
// wrapping and width padding (see `isOsc66Line` in ../utils): re-wrapping
// splits/normalizes the sized span (recomputing the explicit `w=` cell count
// and hoisting SGR out of the OSC payload), and padding would append trailing
// cells past the doubled glyph.

function normalizeHtmlEntitiesForTerminal(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {
				// Fallback to empty string or original if invalid codepoint
			}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}

interface HtmlListState {
	type: "ol" | "ul";
	next: number;
}

interface HtmlNormalizationState {
	lists: HtmlListState[];
	openItems: boolean[];
	itemHasContent: boolean[];
}

function createHtmlNormalizationState(): HtmlNormalizationState {
	return { lists: [], openItems: [], itemHasContent: [] };
}

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const HTML_TAG_REGEX = /<\/?(?:br|p|ol|ul|li|span|text|code|hr|blockquote)\b(?:\s[^>]*)?\s*\/?>/gi;
// Block-level HTML that needs structural (not just textual) rendering: standalone
// `<hr>` becomes a rule and balanced `<blockquote>…</blockquote>` renders with
// quote styling. Group 1 captures blockquote inner content; it is undefined for hr.
const BLOCK_HTML_REGEX = /<hr\b[^>]*\/?>|<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi;

function htmlTagName(tag: string): string {
	const match = /^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(tag);
	return match ? match[1].toLowerCase() : "";
}

function htmlOlStart(tag: string): number {
	const match = /\bstart\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i.exec(tag);
	if (!match) return 1;
	return Number(match[1] ?? match[2] ?? match[3]);
}

function appendHtmlLineBreak(output: string, force: boolean = false): string {
	const trimmed = output.replace(/[ \t]+$/u, "");
	return !force && trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

function htmlListIndent(state: HtmlNormalizationState): string {
	return "  ".repeat(Math.max(0, state.lists.length - 1));
}

function appendHtmlListBreak(output: string, state: HtmlNormalizationState): string {
	const indent = htmlListIndent(state);
	return output.endsWith(`${indent}\n`) ? output : appendHtmlLineBreak(output);
}

function markCurrentHtmlItemContent(state: HtmlNormalizationState, text: string): void {
	if (text.trim() !== "" && state.itemHasContent.length > 0) {
		state.itemHasContent[state.itemHasContent.length - 1] = true;
	}
}

function isAtEmptyHtmlListItem(state: HtmlNormalizationState): boolean {
	const itemIndex = state.itemHasContent.length - 1;
	return state.openItems[itemIndex] === true && state.itemHasContent[itemIndex] !== true;
}

function normalizeHtmlForTerminal(
	raw: string,
	state: HtmlNormalizationState = createHtmlNormalizationState(),
	codeHook?: (text: string) => string,
): string {
	let output = "";
	let lastIndex = 0;
	let inCode = false;
	const withoutComments = raw.replace(HTML_COMMENT_REGEX, "");

	for (const match of withoutComments.matchAll(HTML_TAG_REGEX)) {
		const tag = match[0];
		const index = match.index ?? 0;
		const textBeforeTag = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex, index));
		const name = htmlTagName(tag);
		// Most tags handled here are block-level. Inline contexts — span, text, and
		// the content inside a `<code>` run — keep their surrounding whitespace
		// verbatim because it is significant. For block-level tags, HTML formatting
		// whitespace between tags (e.g. the newlines and indentation in
		// pretty-printed `<ul>\n  <li>…`) is not rendered content; appending it
		// literally would leak source indentation before bullets and blank rows
		// between items, so a whitespace-only slice is dropped. Text inside a
		// `<code>` run is routed through `codeHook` so the inline-code theme is
		// applied without leaking the raw `<code>`/`</code>` tags.
		const isInlineTag = name === "span" || name === "text";
		if (isInlineTag || inCode || textBeforeTag.trim() !== "") {
			output += inCode && codeHook ? codeHook(textBeforeTag) : textBeforeTag;
			markCurrentHtmlItemContent(state, textBeforeTag);
		}
		lastIndex = index + tag.length;

		const isClosing = tag.startsWith("</");
		const isSelfClosing = /\/\s*>$/.test(tag);

		switch (name) {
			case "span":
			case "text":
				break;
			case "code":
				if (isClosing) inCode = false;
				else if (!isSelfClosing) inCode = true;
				break;
			case "br":
			case "hr":
				output = appendHtmlLineBreak(output, true);
				break;
			case "p":
			case "blockquote":
				if (isClosing) {
					output = appendHtmlLineBreak(output);
				} else if (output.trim() !== "" && !output.endsWith("\n") && !isAtEmptyHtmlListItem(state)) {
					output = appendHtmlLineBreak(output);
				}
				break;
			case "ol":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ol", next: htmlOlStart(tag) });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "ul":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ul", next: 1 });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "li": {
				if (isClosing) {
					output = appendHtmlLineBreak(output);
					break;
				}
				if (state.openItems.length > 0) {
					const itemOpenIndex = state.openItems.length - 1;
					if (state.openItems[itemOpenIndex]) output = appendHtmlListBreak(output, state);
					state.openItems[itemOpenIndex] = true;
					state.itemHasContent[itemOpenIndex] = false;
				} else if (output.trim() !== "" && !output.endsWith("\n")) {
					output = appendHtmlLineBreak(output);
				}
				const list = state.lists[state.lists.length - 1];
				const indent = htmlListIndent(state);
				if (list?.type === "ol") {
					output += `${indent}${list.next}. `;
					list.next++;
				} else {
					output += `${indent}• `;
				}
				break;
			}
			default:
				output += tag;
				break;
		}
	}

	const remainingText = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex));
	markCurrentHtmlItemContent(state, remainingText);
	return output + (inCode && codeHook ? codeHook(remainingText) : remainingText);
}

function splitTerminalLines(text: string): string[] {
	const lines = text.split("\n");
	while (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Tree-guide hanging wrap
//
// Models routinely emit box-drawing trees ("├── item") inside plain
// paragraphs — directory layouts, decision trees. The lexer sees those lines
// as ordinary prose, so the generic wrap pass restarts wrapped continuations
// at column 0 and visually shears the tree apart (doubly fast for CJK text,
// where every glyph is two cells wide). Mirror the guide semantics of
// `tree(1)` / rich.tree instead: wrap the node text within the cells that
// remain after the guide prefix, and indent every continuation row under the
// node text — branch glyphs swap to their pass-through form (`├` → `│`,
// `└` → blank) so the rails of still-open ancestors stay visually joined.
// ---------------------------------------------------------------------------

/** Continuation glyph for each guide character a tree prefix may contain. */
const TREE_GUIDE_CONTINUATION: Record<string, string> = {
	"│": "│",
	"┃": "┃",
	"║": "║",
	"├": "│",
	"┣": "┃",
	"╠": "║",
	"└": " ",
	"┗": " ",
	"╚": " ",
	"╰": " ",
	"─": " ",
	"━": " ",
	"═": " ",
	" ": " ",
};

/** Cheap pre-gate: any guide glyph at all. The structural test is TREE_BRANCH_CONNECTOR_RE. */
const TREE_GUIDE_ANCHOR_RE = /[│┃║├┣╠└┗╚╰]/;

/**
 * A prefix qualifies as tree-shaped only when a branch/corner glyph is
 * immediately followed by a horizontal connector (`├──`, `└─`, `╰──`, …).
 * A lone rail or branch glyph used as prose ("│ is the Unicode vertical box
 * drawing glyph…") never qualifies, so such paragraphs keep the plain wrap.
 */
const TREE_BRANCH_CONNECTOR_RE = /[├┣╠└┗╚╰][─━═]/;

/** Below this many content cells a hanging wrap degenerates; keep the plain wrap. */
const MIN_TREE_CONTENT_WIDTH = 8;

const SGR_SEQUENCE_STICKY = /\x1b\[[0-9;:]*m/y;
const SGR_SEQUENCE_GLOBAL = /\x1b\[[0-9;:]*m/g;

/**
 * Everything before the last full SGR reset is dead state — drop it so the
 * re-played `carry` stays bounded by the paragraph's live style run instead
 * of its whole code history.
 */
function compactSgrCarry(carry: string): string {
	const shortReset = carry.lastIndexOf("\x1b[m");
	const longReset = carry.lastIndexOf("\x1b[0m");
	const cut = Math.max(shortReset === -1 ? -1 : shortReset + 3, longReset === -1 ? -1 : longReset + 4);
	return cut === -1 ? carry : carry.slice(cut);
}

interface TreeGuidePrefix {
	/** Index of the first char past the guide run (start of the node text). */
	end: number;
	/** SGR sequences interleaved with the guides, in order (zero visible width). */
	codes: string;
	/** Guide characters with SGR stripped, exactly as they appear on screen. */
	guides: string;
}

/**
 * Match the leading box-drawing guide run of a rendered line (e.g. `│   ├── `),
 * tolerating interleaved SGR styling. Returns undefined unless the run
 * contains a branch glyph joined to a horizontal connector and node text
 * follows, so dash art, indented prose, and lone glyphs used as prose are
 * never treated as a tree.
 */
function matchTreeGuidePrefix(line: string): TreeGuidePrefix | undefined {
	let codes = "";
	let guides = "";
	let i = 0;
	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			SGR_SEQUENCE_STICKY.lastIndex = i;
			const match = SGR_SEQUENCE_STICKY.exec(line);
			if (!match) break;
			codes += match[0];
			i = SGR_SEQUENCE_STICKY.lastIndex;
			continue;
		}
		const char = line[i]!;
		if (!(char in TREE_GUIDE_CONTINUATION)) break;
		guides += char;
		i++;
	}
	if (i >= line.length || !TREE_BRANCH_CONNECTOR_RE.test(guides)) return undefined;
	return { end: i, codes, guides };
}

/**
 * Hanging wrap for box-drawing tree lines inside prose block text.
 *
 * Returns undefined when no line needs the treatment, so paragraphs without
 * overflowing tree lines keep their exact current render. When a paragraph
 * does hang, its lines are returned pre-split and style-self-contained: the
 * SGR state open at each line start is re-played onto that line (`carry`),
 * because the caller's wrap pass — which normally carries SGR state across
 * the newlines of a single entry — no longer sees them as one entry.
 */
function hangWrapTreeGuideLines(text: string, width: number): string[] | undefined {
	if (width < MIN_TREE_CONTENT_WIDTH || !TREE_GUIDE_ANCHOR_RE.test(text)) return undefined;

	const sourceLines = text.split("\n");
	const hangs = (line: string): TreeGuidePrefix | undefined => {
		if (visibleWidth(line) <= width) return undefined;
		const prefix = matchTreeGuidePrefix(line);
		if (!prefix) return undefined;
		if (width - visibleWidth(prefix.guides) < MIN_TREE_CONTENT_WIDTH) return undefined;
		return prefix;
	};
	if (!sourceLines.some(line => hangs(line) !== undefined)) return undefined;

	const out: string[] = [];
	let carry = "";
	for (const line of sourceLines) {
		const prefix = hangs(line);
		if (!prefix) {
			out.push(carry ? carry + line : line);
			carry = compactSgrCarry(carry + (line.match(SGR_SEQUENCE_GLOBAL)?.join("") ?? ""));
			continue;
		}
		// Re-play the SGR state ahead of the node text so the wrapper carries
		// it onto every continuation row; the codes are zero-width, so measured
		// row widths are unaffected.
		const activeCodes = carry + prefix.codes;
		const rows = wrapTextWithAnsi(activeCodes + line.slice(prefix.end), width - visibleWidth(prefix.guides));
		let hang = "";
		for (const guide of prefix.guides) hang += TREE_GUIDE_CONTINUATION[guide] ?? " ";
		const hangShortfall = visibleWidth(prefix.guides) - visibleWidth(hang);
		if (hangShortfall > 0) hang += padding(hangShortfall);
		out.push(carry + line.slice(0, prefix.end) + rows[0]!.slice(activeCodes.length));
		for (let i = 1; i < rows.length; i++) {
			out.push(activeCodes + hang + rows[i]!);
		}
		carry = compactSgrCarry(carry + (line.match(SGR_SEQUENCE_GLOBAL)?.join("") ?? ""));
	}
	return out;
}

const WHITESPACE = /\s/;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * GFM strikethrough as upstream marked's rule reads it, with `~~` only: an opener not followed by whitespace or `~`,
 * text read in units of one character or a backslash and the character after it (not a line break), and the first
 * `~~` that follows a unit other than whitespace, `~` or a lone `\` and is not followed by another `~`. One scanner
 * serves one inline source and the link labels and emphasis inside it. A scan also answers for every opener it
 * passed, which meets the same closer or none, so a line of unclosed openers is read once, not once per opener.
 */
class StrikethroughScanner {
	readonly #source: string;
	// The last opener whose scan ran, where that scan stopped, and whether a closer stopped it there.
	#open = -1;
	#stop = -1;
	#closed = false;

	constructor(source: string) {
		this.#source = source;
	}

	/** The offset of the `~~` closing the strikethrough opened at `open`, or -1. */
	closeAt(open: number): number {
		const src = this.#source;
		const first = src[open + 2];
		if (!src.startsWith("~~", open) || first === undefined || first === "~" || WHITESPACE.test(first)) return -1;
		// Past the opener's own "~~" its units are the last scan's, so they meet the same closer or stop.
		if (this.#open < open && open < this.#stop) return this.#closed ? this.#stop : -1;
		let at = open + 2;
		let close = -1;
		while (at < src.length) {
			let end: number;
			let final: boolean;
			if (src.charCodeAt(at) === 0x5c /* \ */) {
				if (at + 1 === src.length || LINE_TERMINATOR.test(src[at + 1]!)) break;
				end = at + 2;
				final = true;
			} else {
				end = at + 1;
				final = src[at] !== "~" && !WHITESPACE.test(src[at]!);
			}
			if (final && src.startsWith("~~", end) && src[end + 2] !== "~") {
				close = end;
				break;
			}
			at = end;
		}
		this.#open = open;
		this.#stop = close === -1 ? at : close;
		this.#closed = close !== -1;
		return close;
	}
}

const strikethroughScanners = new WeakMap<TokenizerThis, StrikethroughScanner>();

// Registered after every other inline extension: at a `~~` no built-in rule before marked's `del` can match, so this
// gives the tokens a `del` override would, and the `del` override below keeps marked's own looser rule out.
const strikethroughExtension: TokenizerAndRendererExtension = {
	name: "strictStrikethrough",
	level: "inline",
	// No start hint: inline text already stops at every `~`.
	tokenizer(src) {
		if (!src.startsWith("~~")) return undefined;
		const source = this.source ?? src;
		// Inside a link label or emphasis the text ends at `end`, before its closer (`]`, `*` or `_`), which is not a
		// `~`, so a closer that ends there closes as it would at the end of the text.
		const end = this.end ?? source.length;
		let scanner = strikethroughScanners.get(this);
		if (!scanner) strikethroughScanners.set(this, (scanner = new StrikethroughScanner(source)));
		const open = end - src.length;
		const close = scanner.closeAt(open);
		if (close === -1 || close + 2 > end) return undefined;
		const text = source.slice(open + 2, close);
		return { type: "del", raw: source.slice(open, close + 2), text, tokens: this.lexer.inlineTokens(text) };
	},
};

const markdownParser = new Marked();

// Math spans (`$$…$$`, `\[…\]`, `$…$`, `\(…\)`) are tokenized as a dedicated
// `math` inline token before markdown's escape/emphasis/link rules run, so
// backslash commands (`\frac`, `\alpha`) and intraword underscores (`x_i`)
// survive intact instead of being mangled or split. The `$…$` form uses
// pandoc's anti-currency heuristic (`mathSpanAt`) so "$5 and $10" is
// never math. Inline extensions run before marked's escape tokenizer, so
// `\(…\)` becomes math while a genuinely escaped `\$` is left to `escape` and
// renders as a literal dollar.
const CUSTOM_HR_START_REGEX = /(?:^|\n) {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;
const CUSTOM_HR_TOKENIZER_REGEX = /^ {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;

function getHrChar(char: string, hrChar: string): string {
	const isAscii = hrChar === "-";
	switch (char) {
		case "=":
			return "=";
		case "═":
			return isAscii ? "=" : "═";
		case "━":
			return isAscii ? "-" : "━";
		case "─":
			return isAscii ? "-" : "─";
		case "–":
			return isAscii ? "-" : "–";
		case "—":
			return isAscii ? "-" : "—";
		default:
			return hrChar;
	}
}

const customHrExtension: TokenizerAndRendererExtension = {
	name: "customHr",
	level: "block",
	start(src) {
		const match = CUSTOM_HR_START_REGEX.exec(src);
		if (!match) return undefined;
		let idx = match.index;
		if (src[idx] === "\n") {
			idx += 1;
		}
		return idx;
	},
	tokenizer(src) {
		const match = CUSTOM_HR_TOKENIZER_REGEX.exec(src);
		if (match) {
			return {
				type: "hr",
				raw: match[0],
			};
		}
		return undefined;
	},
	renderer() {
		return "";
	},
};

// Delimiters come from `@oh-my-pi/pi-utils/math-delimiters`; rendering policy stays here.
const mathExtension: TokenizerAndRendererExtension = {
	name: "math",
	level: "inline",
	startFrom: mathStartIndex,
	tokenizer(src) {
		const span = mathSpanInContext(this, src);
		if (!span) return undefined;
		return { type: "math", raw: src.slice(0, span.end), text: span.body, display: span.display };
	},
	renderer(token) {
		return typeof token.text === "string" ? token.text : "";
	},
};

const mathBlockExtension: TokenizerAndRendererExtension = {
	name: "mathBlock",
	level: "block",
	// No `start` hint: marked only probes block extensions at a block boundary
	// here and never consults their hints.
	tokenizer(src) {
		const block = mathBlockAt(src);
		if (!block) return undefined;
		return { type: "math", raw: block.raw, text: block.body, display: true };
	},
	renderer(token) {
		return typeof token.text === "string" ? token.text : "";
	},
};

// Bare (delimiter-less) display-math environments: `\begin{<mathenv>}…\end{…}`
// written without `$$`/`\[` fences (common in raw model output). Captured at the
// block level as a whole unit — including any immediately preceding `lhs =`
// line — so marked never splits it on inline `\\` row breaks. Restricted to math
// environments (isBareMathEnvironment), and the `≤3 leading spaces` + "block
// starts at offset 0" guards keep fenced/indented `\begin{cases}` code blocks
// for marked's own code rules.
const BARE_ENV_BEGIN = /(?:^|\n)[ \t]{0,3}\\begin\{([A-Za-z]+\*?)\}/;
function bareMathEnvBlock(src: string): readonly [number, number] | null {
	const bm = BARE_ENV_BEGIN.exec(src);
	if (!bm || !isBareMathEnvironment(bm[1])) return null;
	// Skip a matched leading `\n`, at offset 0 too: a blank line before the block
	// is a space token of its own, not part of the block.
	const beginLineStart = src[bm.index] === "\n" ? bm.index + 1 : bm.index;
	const endToken = `\\end{${bm[1]}}`;
	const endAt = src.indexOf(endToken, bm.index);
	if (endAt === -1) return null;
	// The `\end` must close before any blank line (i.e. within the same block).
	if (/\n[ \t]*\n/.test(src.slice(beginLineStart, endAt))) return null;
	let blockEnd = endAt + endToken.length;
	while (src[blockEnd] === " " || src[blockEnd] === "\t") blockEnd++;
	if (src[blockEnd] === "\n") blockEnd++;
	// Pull in one immediately-preceding `lhs =`/open-delimiter line (e.g. `f(x) =`).
	let start = beginLineStart;
	if (start > 0 && src[start - 1] === "\n") {
		const prevStart = src.lastIndexOf("\n", start - 2) + 1;
		const prevLine = src.slice(prevStart, start - 1);
		if (/[=([{]\s*$/.test(prevLine)) start = prevStart;
	}
	return [start, blockEnd];
}
const mathEnvBlockExtension: TokenizerAndRendererExtension = {
	name: "mathEnvBlock",
	level: "block",
	start(src) {
		const r = bareMathEnvBlock(src);
		return r ? r[0] : undefined;
	},
	tokenizer(src) {
		const r = bareMathEnvBlock(src);
		if (r?.[0] !== 0) return undefined; // only consume when the block starts at offset 0
		const raw = src.slice(0, r[1]);
		const text = raw.replace(/\n[ \t]*$/, "");
		if (text.trim().length === 0) return undefined;
		return { type: "math", raw, text, display: true };
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};

// GFM's extended autolinks (`www.`, `http://`, `https://`, `ftp://`) may only
// begin at a valid left boundary: start of line, whitespace, or one of `* _ ~ (`
// (https://github.github.com/gfm/#autolinks-extension-). marked's bundled `url`
// tokenizer instead fires after ANY character, so a local path such as
// `~/meta/www.share/blog/index.dj` is mangled into a `http://www.share/...`
// link. This inline extension runs before the built-in tokenizer: when an
// autolink candidate is glued to an invalid preceding character it emits the
// bare scheme prefix as literal text, so the remainder never reaches the `url`
// tokenizer at a valid start. Candidates at a legal boundary fall through
// (return undefined) to marked's own autolink handling unchanged.
const AUTOLINK_SCHEME_REGEX = /^(?:www\.|https?:\/\/|ftp:\/\/)/i;
const VALID_AUTOLINK_LEFT_BOUNDARY = /[\s*_~(]/;
const boundedAutolinkExtension: TokenizerAndRendererExtension = {
	name: "boundedAutolink",
	level: "inline",
	// No start hint: inline text already stops at every `www.`, `http://`, `https://` and `ftp://`, the only places
	// this tokenizer matches.
	tokenizer(src, tokens) {
		const match = AUTOLINK_SCHEME_REGEX.exec(src);
		if (!match) return undefined;
		const prevChar = tokens.at(-1)?.raw?.at(-1);
		// Start of line or a legal delimiter → let marked autolink it.
		if (prevChar === undefined || VALID_AUTOLINK_LEFT_BOUNDARY.test(prevChar)) return undefined;
		// Glued to an invalid character (e.g. `/`, a letter, `.`): consume only
		// the scheme prefix as text so the built-in `url` tokenizer cannot match.
		const raw = match[0];
		return { type: "text", raw, text: raw };
	},
};
markdownParser.use({
	extensions: [
		customHrExtension,
		mathBlockExtension,
		mathEnvBlockExtension,
		mathExtension,
		boundedAutolinkExtension,
		strikethroughExtension,
	],
});

// Setext-underline pre-gate for marked's `lheading` rule. The rule's lazy body
// `((?:.|\n(?!<block-start>))+?)` re-runs its block-start lookahead while
// expanding character by character, so even a FAILING attempt at offset 0
// costs O(len × lookahead) — ~26µs per 200-char list-item body, and marked's
// list tokenizer block-tokenizes every item's content (47.8% of a streaming
// bench profile). A match REQUIRES the setext underline `\n {0,3}(=+|-+)`
// somewhere in src, so this O(n) charCode scan never rejects a src the
// built-in rule would match; single-line srcs (every tight list item) reject
// on the first indexOf.
function lheadingPossible(src: string): boolean {
	let i = src.indexOf("\n");
	while (i !== -1) {
		let j = i + 1;
		const limit = j + 3; // underline allows up to 3 leading spaces
		while (j < limit && src.charCodeAt(j) === 0x20 /* space */) j++;
		const c = src.charCodeAt(j); // NaN past the end fails both comparisons
		if (c === 0x3d /* = */ || c === 0x2d /* - */) return true;
		i = src.indexOf("\n", j);
	}
	return false;
}

// `false` → marked falls back to the built-in tokenizer;
// `undefined` → no token here, built-in never runs.
const perfTokenizerOverrides = {
	lheading(src: string): Tokens.Heading | undefined | false {
		return lheadingPossible(src) ? false : undefined;
	},
	// Strikethrough is `strikethroughExtension`'s: marked's own looser rule never runs.
	del: () => undefined,
};

markdownParser.use({ tokenizer: perfTokenizerOverrides });

// ---------------------------------------------------------------------------
// Literal-math mode
// ---------------------------------------------------------------------------
// Opt-in per component (task brief/context echoes): the same markdown
// typesetting with every payload-mutation path removed. No math extension is
// registered, so `$…$`, `$$…$$`, `\[…\]`, `\(…\)` and bare `\begin{…}` spans
// fall through to plain text — no mathSpanAt consumption, no latexToUnicode,
// no `\(...\)` BRE-group conversion, no `_r`-style subscript mapping, no math
// smart-punct. Headings/lists/code/links (and the escape rule's competition
// below) keep typesetting.
//
// `literalEscapeExtension` additionally runs before marked's escape tokenizer
// so backslash-escaped punctuation (`\(` BRE groups, `\$`) keeps its bytes
// instead of being smartened away (`\(` -> `(`) — the echo must be
// byte-recoverable even mid-paragraph.
const LITERAL_ESCAPE_REGEX = /^\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const literalEscapeExtension: TokenizerAndRendererExtension = {
	name: "literalEscape",
	level: "inline",
	tokenizer(src: string) {
		const match = LITERAL_ESCAPE_REGEX.exec(src);
		if (!match) return undefined;
		return { type: "text", raw: match[0], text: match[0] };
	},
	renderer(token) {
		return typeof token.text === "string" ? token.text : "";
	},
};

const literalMathParser = new Marked();
literalMathParser.use({
	extensions: [customHrExtension, literalEscapeExtension, boundedAutolinkExtension, strikethroughExtension],
});
literalMathParser.use({ tokenizer: perfTokenizerOverrides });

// ---------------------------------------------------------------------------
// Sticky clones of marked's pathological block rules
// ---------------------------------------------------------------------------
// Bun's (JSC) regex engine skips the start-anchor fast-fail for several of
// marked's `^`-anchored block rules — `hr`, `lheading`, `table` and `html` are
// anchored alternations of quantified branches, and a failing `exec`/`test`
// rescans the entire remaining source instead of stopping after offset 0.
// marked's list tokenizer runs `hr.test` and `lheading` per list line against
// the remaining source, so lexing a long list is quadratic (66% of a streaming
// bench profile sat in these two regexes). A sticky (`y`) clone with
// `lastIndex` pinned to 0 attempts the match at offset 0 only.
//
// Equivalence: for a flagless rule whose source is `^`-anchored, a sticky
// clone at `lastIndex = 0` matches exactly when the original matches (same
// match object, same captures) — `^` already restricted matches to offset 0
// (no `m` flag), and stickiness only removes the futile later attempts. The
// flags/anchor guard below skips any rule a future marked version changes.
class AnchoredAtZero extends RegExp {
	override exec(str: string): RegExpExecArray | null {
		this.lastIndex = 0; // sticky matches set lastIndex; rules are shared
		return super.exec(str);
	}
	override test(str: string): boolean {
		this.lastIndex = 0;
		return super.test(str);
	}
}

for (const table of [Lexer.rules.block.normal, Lexer.rules.block.gfm]) {
	for (const name of ["hr", "lheading", "table", "html"] as const) {
		const rule = table[name];
		if (rule.flags === "" && rule.source.startsWith("^")) {
			table[name] = new AnchoredAtZero(rule.source, "y");
		}
	}
}

// ---------------------------------------------------------------------------
// Module-level LRU render cache
// ---------------------------------------------------------------------------
// Each session-tree navigation discards and recreates Markdown component
// instances, so the per-instance #cachedLines field is always cold on first
// render of a fresh component. This module-level cache survives across
// component lifetimes and eliminates redundant marked.lexer + highlightCode
// (Rust FFI) work for content/layout combinations already seen this session.

const RENDER_CACHE_MAX = 256; // sane cap: ~256 distinct message × width combos
const RENDER_CACHE_MAX_SIZE = 4 * 1024 * 1024;
// Entry size counts the key (it embeds the whole normalized source) plus the
// rendered rows, so this admits roughly the same documents a rows-only 256 KiB
// cap did while the aggregate bound covers everything the entry retains.
const RENDER_CACHE_MAX_ENTRY_SIZE = 512 * 1024;
const EMPTY_RENDER_LINES: readonly string[] = [];

interface RenderedLine {
	text: string;
	literalCode?: true;
}

interface RenderedListItemLine extends RenderedLine {
	nested: boolean;
}

function renderedLine(text: string, literalCode?: boolean): RenderedLine {
	return literalCode ? { text, literalCode: true } : { text };
}

const renderCache = new LRUCache<string, readonly string[]>({
	max: RENDER_CACHE_MAX,
	maxSize: RENDER_CACHE_MAX_SIZE,
	maxEntrySize: RENDER_CACHE_MAX_ENTRY_SIZE,
	sizeCalculation: (lines, key) => renderedLinesCacheSize(lines) + key.length,
});

function renderedLinesCacheSize(lines: readonly string[]): number {
	let size = lines.length;
	for (let i = 0; i < lines.length; i++) size += lines[i]!.length;
	return Math.max(1, size);
}

/**
 * Append `src` onto `dst` element-wise. `dst.push(...src)` passes every row as
 * a call argument, which throws past the engine's argument limit on very long
 * documents.
 */
function appendLines(dst: string[], src: readonly string[]): void {
	for (let i = 0; i < src.length; i++) dst.push(src[i]!);
}

// ---------------------------------------------------------------------------
// Fast-tail (B+) hazard gates
// ---------------------------------------------------------------------------
// Tier-1 eligibility: the appended delta is "markdown-inert" — it cannot open
// or close an inline token, change block structure, or shift a swatch
// boundary. A delta carrying a marker is re-lexed through the REAL inline
// pipeline so self-contained marker pairs render styled — exactly what a full
// re-lex of the grown row produces. `_` is included but narrowed: an
// intraword `_` is literal per CommonMark flanking rules, so only FLANKED
// underscores disarm (FAST_ROW_UNDERSCORE_RE on the row text, plus the
// delta-edge trailingDelimiterSeamHazard check).
const FAST_DELTA_RE = /[\n\r\\[`<!*_~$#&@\x1b]/;

// Emphasis delimiters, which can pair across the fast path's seam.
const FAST_EMPHASIS_DELIMITERS = ["*", "_", "~"] as const;

// Disarm when the captured row's RAW tail ends in trailing whitespace (wrap
// trims it, a no-break space included; appending a char moves the trim
// boundary), a trailing backslash (it can become an escape once the delta
// supplies the next char — the `\\` clause covers that escape-completion
// hazard), or a full/partial hex swatch run (a `#` + 3-8 hex is a swatch
// glyph; the byte range may shift).
const FAST_RUN_END_RE = /(?:[\s\\]|#[0-9a-fA-F]{3,8}|#+)$/i;

// A partial `#` + 1-2 hex digits can grow into a 3-8 digit swatch glyph
// across the seam (delta hex digits are inert).
const FAST_SWATCH_SEAM_RE = /#[0-9a-fA-F]{0,2}$/;

// A partial HTML entity at the seam (`&am` + delta `p;`) OR a complete
// numeric entity (`&#35;`, `&#x1f600;`) — which decodes to `#`, a swatch
// lead — would normalize to different bytes than the plain concat.
const FAST_ENTITY_SEAM_RE = /&(?:[A-Za-z0-9#]{0,31}|#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};)$/;

// A bare URL/email anywhere in the delta or across the seam (a URL the regex
// cut at a trailing delimiter can re-link once the delta supplies more chars;
// a protocol head ending at the seam completes in the delta) makes the full
// re-lex autolink while the plain concat would not.
const FAST_URL_ANYWHERE_RE = /(?:https?|ftp):\/\/|www\.[A-Za-z0-9]|[A-Za-z0-9._%+-]+@/i;

// A bare-URL/email PREFIX may end at the seam and complete in the delta
// (`ht` + `tps://x`, `foo@` + `bar.com`).
const FAST_URL_PREFIX_SEAM_RE = /(?:https?|ftp):?\/{0,2}$|www\.$|[A-Za-z0-9._+-]+@[A-Za-z0-9._+-]*$/;

// Inline-markup delimiters that survive into rendered output as LITERAL text
// when unpaired. The fast path detects open constructs by walking the REAL
// inline token stream (capture) and the delta's inline token stream (frame):
// any top-level `text` token still carrying one of these bytes holds an open
// delimiter, so a later delta could close it and a full re-lex would restyle
// the seam. Closed pairs tokenize into styled tokens and never appear here.
// `_` is excluded (intraword `_` is inert); a FLANKED underscore is caught
// by FAST_ROW_UNDERSCORE_RE on the raw text (SGR bytes precede text, so word
// boundaries are invisible after styling).
const FAST_LITERAL_MARKER_RE = /[*~`[\]<>()$&#]/;

// A flanking underscore (start-of-line or preceded by a non-word char) can
// open an emphasis that a future delta closes. Only flanked `_` is a
// delimiter; intraword `_` (a_b) is literal.
const FAST_ROW_UNDERSCORE_RE = /(?:^|[^\w])_/;
// Two distinct CommonMark word-char notions drive the seam re-flank checks.
// For the `_`-underscore seam, "word char" = ASCII `\w` (which includes `_`)
// plus Unicode letters/numbers — `[\w\p{L}\p{N}]`. `\w` alone missed a row
// ending in a Unicode letter (`é`); CM's char class `[^\s\p{P}\p{S}]` would
// wrongly treat `_` (\p{Pc}) as a word char and break the `_..._` intraword
// gate. For `*`/`~` closing emphasis, marked's flanking test uses the full
// class `[^\s\p{P}\p{S}]` (which covers format/combining marks like U+200C and
// U+0301), so branch 2 must use that wider class.
const FAST_UNDERSCORE_WORD_AT_END_RE = /[\w\p{L}\p{N}]$/u;
const FAST_CMARK_WORD_AT_START_RE = /^[^\s\p{P}\p{S}]/u;
// A GFM table delimiter row lets a preceding pipe-header line flip into a
// table when a future inert delta completes it — even a marker-free delta
// (`| col_a | col_b |\n| --` + `--- | -`). The cold render then re-wraps and
// restyles the header, so the splice must disarm. The gate runs on the GROWN
// last line (`recipe.rowRaw`'s last line + deltaTabs) in render().
const FAST_TABLE_DELIM_ROW_RE = /^\s*(?:\|[\s:]*-+\s*(?:\|[\s:]*-+\s*)*|[\s:]*-+\s*(?:\|[\s:]*-+\s*)+)\|?\s*$/;

// A paragraph's LAST line can complete into a different block kind under an
// inert delta (ATX heading, blockquote, bullet marker, HR, ref-def) — disarm
// when the grown line starts one (ref-def grammar: REF_DEF_LINE_RE). A line
// holding `\end{` can also close a bare math environment the paragraph opened
// lines above (`\end{al` + `ign}`), making those lines one display block.
const FAST_LINE_START_HAZARD_RE =
	// `-` is placed LAST so it is a literal, not a range bound. The other
	// chars are in ASCENDING code-point order (no reversed ranges that
	// rely on engine leniency): * + = – — ─ ━ ═ then the literal `-`.
	/^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|\d{1,9}[.)](?:[ \t]|$)|[*+=–—─━═-](?:[ \t]|$)|(?:[*+=–—─━═-][ \t]*){2,}[ \t]*$)/;

/** @internal exported for tests — the grown-line block-kind gate. */
export function fastLineStartHazard(grownLine: string): boolean {
	return FAST_LINE_START_HAZARD_RE.test(grownLine) || REF_DEF_LINE_RE.test(grownLine) || grownLine.includes("\\end{");
}

/** Seam hazards between the captured raw row tail and the delta: the row must
 *  not end in a wrap-trim, escape, swatch, entity, or URL/email prefix, and
 *  must hold no unbalanced bracket an inert delta could close into a link. */
function fastTailSeamSafe(raw: string): boolean {
	if (FAST_RUN_END_RE.test(raw)) return false;
	if (FAST_SWATCH_SEAM_RE.test(raw)) return false;
	if (FAST_ENTITY_SEAM_RE.test(raw)) return false;
	// Entities decode before swatch/whitespace detection (`&#35;ab` → `#ab`,
	// `&nbsp;` → ` `): scan the DECODED tail so an entity-indirected swatch
	// lead OR a decoded trailing space (wrap-trim boundary shifts) disarms.
	// Autolinks are lex-time on RAW text, so URL prefix stays raw.
	const rawTail = raw.length > 32 ? raw.slice(-32) : raw;
	const decodedTail = normalizeHtmlEntitiesForTerminal(rawTail);
	if (decodedTail !== rawTail && (FAST_RUN_END_RE.test(decodedTail) || FAST_SWATCH_SEAM_RE.test(decodedTail))) {
		return false;
	}
	if (FAST_URL_PREFIX_SEAM_RE.test(raw)) return false;
	if (raw.endsWith("]") || raw.lastIndexOf("[") > raw.lastIndexOf("]")) return false;
	if (raw.lastIndexOf("(") > raw.lastIndexOf(")") || raw.lastIndexOf("<") > raw.lastIndexOf(">")) return false;
	return true;
}
// Fast-tail (B+) recipe: captured frame state for the next inert-delta splice.
interface FastTailRecipe {
	readonly lines: readonly string[]; // frame rows at capture
	readonly source: string; // raw #text at capture (append-only predicate)
	readonly width: number; // contentWidth at capture
	rowText: string; // RENDERED last wrap-output row (re-wrap input)
	rowRaw: string; // RAW tail source backing that row (seam scan)
	rowStart: number; // result[] index of the replaced row
	rowEnd: number; // exclusive result[] index
	readonly signature: RenderSignature; // full render signature at capture (bgColor etc.)
}

/** True when the inline token stream holds an OPEN construct: a `text` token
 * that still carries a literal delimiter (an unpaired `*`/`` ` ``/`[`/… or a
 * flanking `_`), or raw HTML. Closed constructs are styled tokens whose
 * delimiters are absent from their text. An open means a FUTURE delta could
 * close it — the fast path disarms so the splice always matches a full lex. */
function inlineHasOpen(tokens: readonly Token[]): boolean {
	for (const token of tokens) {
		if (isMathToken(token)) continue;
		if (token.type === "codespan") continue; // styled leaf; its content cannot re-pair
		if (token.type === "html") return true; // raw HTML — conservative
		if (token.type === "text") {
			const text = "text" in token && typeof token.text === "string" ? token.text : "";
			if (FAST_LITERAL_MARKER_RE.test(text) || FAST_ROW_UNDERSCORE_RE.test(text)) return true;
		}
		if ("tokens" in token && Array.isArray(token.tokens)) {
			if (inlineHasOpen(token.tokens as Token[])) return true;
		}
	}
	return false;
}

/** Isolated inline lex of a same-line delta. A single-line delta has no block
 * structure, so the isolated inline pass equals the full lex's inline pass
 * (marked's paragraph tokens run the same `inlineTokens` entry point). */
function lexInlineTokens(text: string, parser: Marked): Token[] {
	return new Lexer(parser.defaults).inlineTokens(text);
}

// A reference-link definition (`[label]: dest`) resolves across the whole
// document, so a split lex cannot reproduce it — disable the streaming fast path
// when one is present (rare in streamed output). The label may contain
// backslash-escaped characters (`[a\]b]: x`), so escapes are matched explicitly;
// over-matching is safe (it only costs the fast path), under-matching is not.
const REF_DEF_LINE_RE = /^ {0,3}\[(?:\\.|[^\]\\])+\]:/;
const HAS_REF_DEF = new RegExp(REF_DEF_LINE_RE.source, "m");

// marked's list tokenizer (Tokenizer.list, marked v18) continues a list across
// blank lines only when the remaining source matches
// `listItemRegex(marker)` = `^( {0,3}${marker})((?:[\t ][^\n]*)?(?:\n|$))`,
// where `marker` is the exact bullet char for unordered lists (`\${char}`) or
// 1-9 digits plus the exact delimiter for ordered lists (`\d{1,9}\${delim}`).
// The marker is derived from the list's FIRST item (`n = t[1].trim()`), which
// sits at the start of a top-level list token's raw:
const LIST_MARKER_RE = /^ {0,3}(?:([*+-])|\d{1,9}([.)]))/;

// Streaming-freeze equivalence invariant: lex(prefix) ++ lex(tail) must equal
// lex(full text) — for the CURRENT text and for every append-only extension of
// it, because a frozen prefix is sticky (it keeps being reused while the text
// grows). At a blank-line (`\n\n`) cut directly after a top-level `list`
// token, the only construct that can straddle the cut is a continuation item
// of that list: marked consumed the blank line into the last item's raw and
// re-ran `listItemRegex` at exactly `tailStart`, merging a same-marker item
// into one renumbered loose list. The cut is safe only when that regex can
// NEVER match at `tailStart`, no matter what is appended later.
//
// Append-only growth means existing characters are immutable while new ones
// may appear after them, so "closed" may only be concluded from a present
// character that contradicts every possible continuation (e.g. tail "1x" can
// never grow into an ordered item, but tail "1" can become "1. c"). Running
// out of text mid-marker therefore answers "may continue".
//
// Returns true when the tail could still continue the list (or the list's
// marker is unrecognizable) — the conservative "don't freeze" answer. marked
// may break the list anyway when the matching line is also an hr (`- - -`);
// treating that as "may continue" merely skips a freeze, never corrupts one.
function listMayContinueAt(text: string, tailStart: number, listRaw: string): boolean {
	const marker = LIST_MARKER_RE.exec(listRaw);
	if (marker === null) return true; // unrecognized list shape — stay conservative
	const n = text.length;
	let i = tailStart;
	// `listItemRegex` allows up to 3 leading spaces (the caller's next-char
	// guard rejects whitespace at the final cut, but mirror the rule exactly).
	while (i < n && i - tailStart < 3 && text.charCodeAt(i) === 0x20 /* space */) i++;
	if (i >= n) return true;
	const bullet = marker[1];
	if (bullet !== undefined) {
		if (text[i] !== bullet) return false; // wrong marker char — closed forever
		i++;
	} else {
		// Ordered: 1-9 digits, then the same `.`/`)` delimiter.
		let digits = 0;
		while (i < n && digits < 10) {
			const c = text.charCodeAt(i);
			if (c < 0x30 /* 0 */ || c > 0x39 /* 9 */) break;
			digits++;
			i++;
		}
		if (digits === 0 || digits > 9) return false; // no digit run / too long — closed forever
		if (i >= n) return true; // delimiter (or more digits) may still arrive
		if (text[i] !== marker[2]) return false; // wrong delimiter — closed forever
		i++;
	}
	// After the marker: `(?:[\t ][^\n]*)?(?:\n|$)` — tab/space + anything, a
	// bare newline, or end-of-input (which appends can still extend).
	if (i >= n) return true;
	const after = text.charCodeAt(i);
	return after === 0x20 /* space */ || after === 0x09 /* tab */ || after === 0x0a; /* \n */
}

/** A probe window: see {@link stableBlockBoundary}. */
interface ProbeWindow {
	/** Offset in `text` where the window, and so the lex of `tokens`, ends. */
	end: number;
	/** The display-math blocks of the whole of `text`. */
	mathBlocks: MathBlockScan;
}

/** The last stable block boundary of a token run: see {@link stableBlockBoundary}. */
interface BlockBoundary {
	/** Offset just past the boundary token, or 0 when the run holds none. */
	end: number;
	/** Number of tokens up to and including the boundary token, or 0. */
	count: number;
	/** End of the display-math block a probe's scan stopped at, which a later window must reach past; 0 when it stopped at none. */
	blockEnd: number;
}

// A whitespace-only line, capturing its terminator: "\n", or "" at the end of the text.
const WHITESPACE_LINE_RE = /[^\S\n]*(\n|$)/y;

/**
 * A display-math opener in the frozen streaming prefix whose block an append
 * could still close: the first such opener of its kind.
 */
interface PrefixOpener {
	kind: MathBlockOpener;
	/** Offset of the opener's line. */
	at: number;
	/** The stable boundary in front of the opener, as a text length and a token count. */
	rewindEnd: number;
	rewindCount: number;
}

const NO_OPENERS: readonly PrefixOpener[] = [];

/**
 * Offset just past the last token in `tokens` that closes a block on a hard
 * `"\n\n"` break, together with the number of tokens up to and including it.
 * `count === 0` means the run holds no usable boundary.
 *
 * `base` is where `tokens[0]` starts inside `text`. Without `window`, `tokens`
 * lex the rest of `text`, which appends may still extend: the streaming
 * freeze. With it, they lex `text.slice(base, window.end)` of a whole
 * document: a probe. A boundary qualifies only when splitting there is
 * invisible to the lexer, i.e. `lex(head) ++ lex(tail) === lex(text)`:
 *  - In a probe, the token must end before `window.end`. An unclosed fence,
 *    HTML block or comment runs to the end of its input, so a window that
 *    ends just after a blank line inside one hands back a truncated token
 *    whose raw ends in `"\n\n"`.
 *  - The break must sit inside `text`. At end-of-text the next character is
 *    unknown (and, while streaming, may still arrive), so the cut is deferred.
 *  - The next line must start real block content. A leading space or newline
 *    means the block separator straddles the cut — e.g. a fence followed by
 *    `"\n\n\n- list"` — and the two lexes desync. So does a line of any other
 *    whitespace, such as a no-break space: the lexer's blank line is
 *    `/^\s*\n$/`, so it joins the blank run in front of the cut. While
 *    streaming, a whitespace-only last line may still become one.
 *  - A preceding `list` must be provably closed: CommonMark lets a same-marker
 *    item continue the list across the blank line, and marked merges both into
 *    one renumbered loose list (`listMayContinueAt`).
 *  - In a probe, no earlier token may open a display-math block that the
 *    window cut short: a token other than `math` (which is the block itself)
 *    where `window.mathBlocks` finds a block in the whole document. The
 *    one-pass lex makes that block one `math` token across its blank lines,
 *    so the scan stops there and reports the block's end as `blockEnd`. An
 *    opener with no closer, or with a whitespace-only body, is no block in
 *    either lex, so it leaves later boundaries alone.
 *  - While streaming, `tokens` are the one-pass lex of `text` as it stands,
 *    so a block the lex already made is a `math` token, and one that an
 *    append could still close becomes one only once a closer line arrives,
 *    which Markdown#lexTokens watches for. With `settle`, the scan instead
 *    stops at a token whose display-math block an append could still close
 *    (`mathBlockMayCloseAt`), so no append changes the tokens before the
 *    boundary it finds. A pair whose closer line has already ended around a
 *    whitespace-only body (`$$`, ` `, `$$`) is no block whatever follows, so
 *    that scan goes on past it.
 *
 * `startIndex` resumes the scan at `tokens[startIndex]` (positions still
 * accumulate from `base`). The streaming freeze passes the frozen-prefix
 * token count: that prefix's boundary is permanent under append-only growth
 * (re-verified when frozen), so only the mutable tail can hold a new one.
 * `endIndex` ends the scan in front of `tokens[endIndex]`, for the last
 * boundary in front of a given token.
 */
function stableBlockBoundary(
	text: string,
	base: number,
	tokens: Token[],
	{
		startIndex = 0,
		endIndex = tokens.length,
		window,
		settle = false,
	}: { startIndex?: number; endIndex?: number; window?: ProbeWindow; settle?: boolean } = {},
): BlockBoundary {
	let pos = base;
	let end = 0;
	let count = 0;
	let blockEnd = 0;
	for (let i = startIndex; i < endIndex; i++) {
		const token = tokens[i];
		const raw = token.raw;
		const tokenEnd = pos + raw.length;
		if (token.type !== "math") {
			if (window !== undefined) {
				const block = window.mathBlocks.at(pos);
				if (block !== undefined) {
					blockEnd = pos + block.raw.length;
					break;
				}
			} else if (settle && mathBlockMayCloseAt(text, pos)) {
				break;
			}
		}
		if (raw.endsWith("\n\n") && (window === undefined || tokenEnd < window.end)) {
			const prev = i > 0 ? tokens[i - 1] : undefined;
			if (prev === undefined || prev.type !== "list" || !listMayContinueAt(text, tokenEnd, prev.raw)) {
				end = tokenEnd;
				count = i + 1;
			}
		}
		pos = tokenEnd;
	}
	if (count === 0 || end >= text.length) return { end: 0, count: 0, blockEnd };
	const next = text.charCodeAt(end);
	if (next === 0x20 /* space */ || next === 0x0a /* \n */) return { end: 0, count: 0, blockEnd };
	WHITESPACE_LINE_RE.lastIndex = end;
	const blank = WHITESPACE_LINE_RE.exec(text);
	if (blank !== null && (blank[1] === "\n" || window === undefined)) return { end: 0, count: 0, blockEnd };
	return { end, count, blockEnd };
}

// Bun's regex engine skips the start-anchor optimization for several of marked's
// block rules — `hr`, `lheading`, `table` and `html` are `^`-anchored
// alternations of quantified branches — so each failing `exec` rescans the whole
// remaining source instead of stopping at offset 0. Lexing is then quadratic in
// document length: an 800 KB message costs ~41 s under Bun where Node/V8 needs
// ~60 ms, and it runs on the render path, freezing the UI. Bounded windows keep
// every scan short and restore linear behavior (~0.7 s for that same message).
/** @internal exported for tests — the windowed lexer's first-probe window size. */
export const LEX_WINDOW_BYTES = 2 * 1024;
// Under this size a single pass beats probing for window boundaries; the
// crossover measured on pathological Markdown sits around 16 KB.
const WINDOWED_LEX_MIN_BYTES = 16 * 1024;

/**
 * Lex `text` in bounded windows, producing the exact token stream
 * `markdownParser.lexer(text)` would.
 *
 * Window cuts come from marked itself: a throwaway BLOCK-ONLY probe lex of the
 * window reports its last stable block boundary ({@link stableBlockBoundary})
 * and only that confirmed segment is handed to the real lexer; a window
 * holding no boundary grows ({@link nextProbeSize}) until it finds one or
 * reaches the end. Probes never run inline tokenization (their inlineQueue is
 * discarded) — a boundary is a property of block structure alone, and probe
 * inline passes were the dominant cost of an earlier revision. Block
 * tokenization runs per window while inline tokenization is deferred to the
 * end — mirroring `Lexer.lex` — so a `[label]: dest` definition anywhere in
 * the document still resolves for every inline span.
 *
 * Each round's first window reaches just past the next blank line
 * ({@link firstProbeSize}); a tail with no blank line left (e.g. one long
 * tight list) goes to the lexer whole.
 */
function lexWindowed(text: string, parser: Marked): TokensList {
	const lexer = new Lexer(parser.defaults);
	const mathBlocks = new MathBlockScan(text);
	let offset = 0;
	while (offset < text.length) {
		let end = text.length;
		for (let size = firstProbeSize(text, offset); offset + size < text.length;) {
			const boundary = probeBoundary(text, offset, size, mathBlocks, parser);
			if (boundary.end > 0) {
				end = boundary.end;
				break;
			}
			size = nextProbeSize(text, offset, size, boundary.blockEnd);
		}
		lexer.blockTokens(text.slice(offset, end), lexer.tokens);
		offset = end;
	}
	for (const queued of lexer.inlineQueue) lexer.inlineTokens(queued.src, queued.tokens);
	lexer.inlineQueue = [];
	return lexer.tokens;
}

/**
 * Size of the first probe window at `offset`: `LEX_WINDOW_BYTES`, or up to one
 * character past the next blank line when that lies further. A boundary is a
 * token whose raw ends in `"\n\n"` and that ends inside its window, so no
 * smaller window can cut. With no blank line left, it is the rest of the text.
 */
function firstProbeSize(text: string, offset: number): number {
	const nextBlank = text.indexOf("\n\n", offset);
	return nextBlank === -1 ? text.length - offset : Math.max(LEX_WINDOW_BYTES, nextBlank + 3 - offset);
}

/**
 * Size of the next probe window after the one of `size` at `offset` gave no
 * usable cut: at least double, and one character past the first blank line
 * that reaches the window's edge, or `blockEnd` when the probe stopped at a
 * display-math block ending there, since only such a blank line can end a
 * later boundary. Doubling toward a far closer would re-lex the block once
 * per window. With no blank line left, it is the rest of the text.
 */
function nextProbeSize(text: string, offset: number, size: number, blockEnd: number): number {
	const nextBlank = text.indexOf("\n\n", Math.max(offset + size, blockEnd) - 2);
	return nextBlank === -1 ? text.length - offset : Math.max(2 * size, nextBlank + 3 - offset);
}

/**
 * The last stable block boundary ({@link stableBlockBoundary}) in the window
 * `text.slice(offset, offset + size)`, from a throwaway block-only lex of the
 * window. `mathBlocks` holds the display-math blocks of all of `text`.
 */
function probeBoundary(
	text: string,
	offset: number,
	size: number,
	mathBlocks: MathBlockScan,
	parser: Marked,
): BlockBoundary {
	const probe = new Lexer(parser.defaults);
	probe.blockTokens(text.slice(offset, offset + size), probe.tokens);
	return stableBlockBoundary(text, offset, probe.tokens, { window: { end: offset + size, mathBlocks } });
}

/**
 * Lex a whole document, windowing anything large enough for the quadratic scan
 * to bite. `links` holds every reference definition, at any nesting depth.
 */
function lexDocument(text: string, parser: Marked = markdownParser): TokensList {
	// A CR shifts every `raw` span (marked normalizes CRLF before tokenizing), so
	// window offsets would address the wrong characters — lex those in one pass.
	if (text.length < WINDOWED_LEX_MIN_BYTES || text.includes("\r")) return parser.lexer(text);
	return lexWindowed(text, parser);
}

/** A hyperlink as the renderer sees it: inline `[text](href)`, `<autolink>`, bare GFM URL, or reference link. */
export interface MarkdownLink {
	/** Flattened visible label with whitespace collapsed to one row; falls back to `href` when empty. */
	text: string;
	/** Destination exactly as marked resolved it (references resolved, no normalization). */
	href: string;
}

/**
 * Every link token in `text`, in document order, from the same configured
 * lexer the renderer uses — so fenced code, code spans, escapes, reference
 * definitions and the GFM autolink rules agree with what is drawn on screen.
 * Duplicate hrefs are kept; callers decide how to fold them.
 */
export function extractMarkdownLinks(text: string): MarkdownLink[] {
	const links: MarkdownLink[] = [];
	const walk = (tokens: readonly Token[] | undefined): void => {
		if (!tokens) return;
		for (const token of tokens) {
			if (token.type === "link") {
				const link = token as Tokens.Link;
				if (typeof link.href === "string" && link.href.length > 0) {
					const label = plainInlineTokens(link.tokens).replace(/\s+/g, " ").trim();
					links.push({ text: label || link.href, href: link.href });
				}
				continue;
			}
			// Containers: paragraphs, emphasis, lists, blockquotes, table cells.
			const any = token as {
				tokens?: Token[];
				items?: Token[];
				header?: Array<{ tokens?: Token[] }>;
				rows?: Array<Array<{ tokens?: Token[] }>>;
			};
			walk(any.tokens);
			walk(any.items);
			if (any.header) for (const cell of any.header) walk(cell.tokens);
			if (any.rows) for (const row of any.rows) for (const cell of row) walk(cell.tokens);
		}
	};
	walk(lexDocument(text));
	return links;
}

/** Drop all L2 cache entries. Call on theme change to prevent stale styled output. */
export function clearRenderCache(): void {
	renderCache.clear();
}

// Stable numeric IDs for structural theme/style objects (no ID field on type).
// WeakMap-keyed so the ID matches strict object identity and doesn't get copied by spread/cloning.
const themeObjectIds = new WeakMap<object, number>();
let nextObjectId = 0;
function objectId(o: object): number {
	let id = themeObjectIds.get(o);
	if (id === undefined) {
		id = nextObjectId++;
		themeObjectIds.set(o, id);
	}
	return id;
}

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Stateful incremental code highlighter carrying parser state across pushes.
 * Produced per streaming fence by {@link MarkdownTheme.createHighlightStream}.
 */
export interface HighlightStreamSession {
	/** Highlight the next chunk and advance parser state. */
	push(chunk: string): string;
}

/** Collect distinct hyperlink destinations using the renderer's Markdown grammar, excluding images and code. */
export function getMarkdownLinkUrls(text: string): string[] {
	const urls = new Set<string>();
	markdownParser.walkTokens(markdownParser.lexer(text), token => {
		if (token.type === "link" && typeof token.href === "string") urls.add(token.href);
	});
	return [...urls];
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	/** Resolve the OSC 8 destination without changing visible text; undefined preserves the authored URL. */
	resolveLink?: (href: string) => string | undefined;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/**
	 * Create a stateful incremental highlighter for one streaming code fence.
	 * `push` receives newline-terminated complete lines (only the final push
	 * may omit the trailing newline) and must return highlighted ANSI text for
	 * exactly the pushed chunk, byte-identical to highlighting the concatenated
	 * text through `highlightCode`. Return null when `lang` is unsupported.
	 */
	createHighlightStream?: (lang?: string) => HighlightStreamSession | null;
	/**
	 * Resolve a mermaid ASCII rendering by fenced block source text.
	 * Return null to fall back to fenced code rendering.
	 */
	resolveMermaidAscii?: (source: string, maxWidth?: number) => string | null;
	/**
	 * Glyphs for quote borders, rules, tables and color swatches. Optional so themes
	 * built to the upstream pi-tui `MarkdownTheme` shape (which has no `symbols`)
	 * still render; omitted symbols fall back to the active theme's set.
	 */
	symbols?: SymbolTheme;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

type ListToken = Token & { items: Array<{ tokens?: Token[] }>; ordered: boolean; start?: number };
type TableCellToken = { tokens?: Token[] };
type TableToken = Token & { header: TableCellToken[]; rows: TableCellToken[][]; raw?: string };

function formatHyperlink(text: string, target: string): string {
	if (!TERMINAL.hyperlinks || !target) {
		return text;
	}

	const safeTarget = target.replaceAll("\x1b", "").replaceAll("\x07", "");
	if (!safeTarget) {
		return text;
	}

	return `\x1b]8;;${safeTarget}\x07${text}\x1b]8;;\x07`;
}

function isAsciiTextSizingPayload(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

function encodeTextSizedHeading(text: string, scale: 1 | 2 | 3): string {
	let out = "";
	let asciiRun = "";
	const flushAscii = () => {
		if (asciiRun === "") return;
		out += encodeTextSized(asciiRun, { scale });
		asciiRun = "";
	};

	for (const { segment } of getSegmenter().segment(text)) {
		if (isAsciiTextSizingPayload(segment)) {
			asciiRun += segment;
			continue;
		}
		flushAscii();
		out += encodeTextSized(segment, { scale, widthCells: visibleWidth(segment) });
	}
	flushAscii();
	return out;
}

const MATH_NEWLINES = /\n+/g;

/** True for the custom inline `math` token produced by the math extension. */
function isMathToken(token: Token): token is Token & { text: string; display: boolean } {
	return (token as { type: string }).type === "math";
}

/** Convert a `math` token's LaTeX to single-line Unicode for inline rendering. */
function renderMathToken(text: string): string {
	return latexToUnicode(text).replace(MATH_NEWLINES, " ");
}

/**
 * When a paragraph's only meaningful content is a single display math token
 * (`$$…$$` / `\[…\]`), return it so the paragraph can be stacked multi-line
 * instead of flattened inline. Models routinely write display math on one line,
 * which marked captures as an inline `display:true` math token inside a
 * paragraph; without this it would flatten through `renderMathToken`.
 */
function soleDisplayMath(tokens?: Token[]): (Token & { text: string }) | null {
	if (!tokens) return null;
	let math: (Token & { text: string; display: boolean }) | null = null;
	for (const token of tokens) {
		if (isMathToken(token) && token.display) {
			if (math) return null;
			math = token;
		} else if (!(token.type === "text" && typeof token.text === "string" && token.text.trim() === "")) {
			return null;
		}
	}
	return math;
}

function plainInlineTokens(tokens: Token[]): string {
	let result = "";
	for (const token of tokens) {
		if (isMathToken(token)) {
			result += renderMathToken(token.text);
			continue;
		}
		switch (token.type) {
			case "text":
				result += token.tokens && token.tokens.length > 0 ? plainInlineTokens(token.tokens) : token.text;
				break;
			case "strong":
			case "em":
			case "del":
			case "link":
				result += plainInlineTokens(token.tokens || []);
				break;
			case "codespan":
				result += token.text;
				break;
			case "br":
				result += "\n";
				break;
			default:
				if ("text" in token && typeof token.text === "string") result += token.text;
				break;
		}
	}
	return result;
}

/**
 * Classify an inline `html` token by tag name and whether it is a closing tag.
 * Returns null for non-html tokens or raw that isn't a recognizable HTML tag.
 */
function inlineHtmlTag(token: Token): { name: string; closing: boolean } | null {
	if ((token as { type: string }).type !== "html") return null;
	const raw = (token as { raw?: unknown }).raw;
	if (typeof raw !== "string") return null;
	const name = htmlTagName(raw);
	if (!name) return null;
	return { name, closing: /^<\s*\//.test(raw) };
}

/**
 * Collapse inline `<code>…</code>` runs — which marked emits as separate `html`
 * open/close tokens around the literal content — into a single synthetic
 * `codespan` token, so they render with the theme's inline-code styling instead
 * of leaking the raw tags. HTML entities inside the run are decoded. Stray or
 * unmatched code tags are dropped; other inline html tokens pass through for the
 * `html` render path to normalize. Returns the original array when no `<code>`
 * tag is present (the common case).
 */
function collapseInlineHtml(tokens: Token[]): Token[] {
	let hasCode = false;
	for (const token of tokens) {
		if (inlineHtmlTag(token)?.name === "code") {
			hasCode = true;
			break;
		}
	}
	if (!hasCode) return tokens;

	const out: Token[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const tag = inlineHtmlTag(tokens[i]);
		if (tag?.name === "code") {
			if (tag.closing) continue; // stray `</code>` — drop it
			let j = i + 1;
			for (; j < tokens.length; j++) {
				const close = inlineHtmlTag(tokens[j]);
				if (close?.name === "code" && close.closing) break;
			}
			if (j >= tokens.length) continue; // unmatched `<code>` — drop it, render the rest normally
			const text = normalizeHtmlEntitiesForTerminal(plainInlineTokens(tokens.slice(i + 1, j)));
			out.push({ type: "codespan", raw: text, text } as Token);
			i = j;
			continue;
		}
		out.push(tokens[i]);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Inline hex-color swatches
// ---------------------------------------------------------------------------
// When prose/thinking mentions a CSS hex color (e.g. #C5FFD6 or `#C5FFD6`),
// render a small chip painted with that color just before the code. The chip
// glyph comes from the theme's symbol set (ASCII → Unicode → Nerd Font), so it
// degrades gracefully; the color itself is exact 24-bit on truecolor terminals
// and the nearest 256-color cell otherwise (Bun.color quantizes for us).

/** Fallback chip when the theme supplies no `colorSwatch` symbol (Unicode default). */
const DEFAULT_COLOR_SWATCH_GLYPH = "■";

// `#` + 3-8 hex digits, not glued to a surrounding word/`#`/`&` (avoids HTML
// entities like &#9731; and paths like foo#fff), not the start of a canonical
// UUID, and not trailed by another word char (over-long runs and word
// fragments like the "#eac" of "#each" never produce a misleading swatch).
// Length/letter rules are enforced in classifyHexColor since the alternation
// can't express "exactly 3, 6, or 8".
const HEX_COLOR_REGEX = /(?<![\w#&])#(?![0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})([0-9a-fA-F]{3,8})(?!\w)/g;
const HEX_COLOR_EXACT_REGEX = /^#([0-9a-fA-F]{3,8})$/;

/**
 * Decide whether a run of hex digits denotes a renderable CSS color.
 *
 * Only the canonical CSS lengths (#RGB, #RRGGBB, #RRGGBBAA) qualify. The 4-digit
 * #RGBA form is deliberately excluded: it collides with hashline `#TAG` snapshot
 * tags (4 hex digits, e.g. #6C5E), which would otherwise sprout spurious swatches.
 * In `strict` mode (bare prose) a 3-digit run must contain a hex letter, so the
 * far more common short issue/PR references (#123, #1011) don't sprout swatches.
 * Codespans opt out of strictness — the backticks already signal "this is a color".
 */
function classifyHexColor(hex: string, strict: boolean): boolean {
	const n = hex.length;
	if (n !== 3 && n !== 6 && n !== 8) return false;
	if (strict && n === 3 && !/[a-fA-F]/.test(hex)) return false;
	return true;
}

/** Black-or-white foreground legible on `#${hex}` used as a fill. VS Code's
 *  rule (Color.isLighter): YIQ brightness (r·299 + g·587 + b·114)/1000 ≥ 128
 *  → dark text, else light. */
function swatchContrastFg(hex: string): string {
	const rgba = Bun.color(`#${hex}`, "{rgba}");
	if (!rgba) return "";
	const light = (rgba.r * 299 + rgba.g * 587 + rgba.b * 114) / 1000 >= 128;
	if (TERMINAL.trueColor) return light ? "\x1b[38;2;0;0;0m" : "\x1b[38;2;255;255;255m";
	return light ? "\x1b[38;5;16m" : "\x1b[38;5;231m";
}

/** Chip glyph + `text` (the `#hex` mention) painted onto the color itself:
 *  a fg-painted chip, then the token with the color as background and a
 *  YIQ-contrast foreground (VS Code's color-picker rule). Returns "" when the
 *  color can't be encoded. Foreground closes with \x1b[39m and background with
 *  a standalone \x1b[49m so line-level backgrounds re-open themselves via
 *  applyBackgroundToLine / Theme.bgFill. */
function colorSwatch(hex: string, glyph: string, text: string): string {
	const fg = Bun.color(`#${hex}`, TERMINAL.trueColor ? "ansi-16m" : "ansi-256");
	if (!fg) return "";
	const bg = fg.replace("[38;", "[48;");
	return `${fg}${glyph}\x1b[39m ${bg}${swatchContrastFg(hex)}${text}\x1b[39m\x1b[49m`;
}

/**
 * Style a plain-text run, inserting a color swatch before each hex color it
 * mentions. Non-color text (including the matched `#hex` itself) is routed
 * through `applySegment` so the caller's base styling is preserved verbatim.
 */
function renderTextWithSwatches(text: string, applySegment: (t: string) => string, glyph: string): string {
	HEX_COLOR_REGEX.lastIndex = 0;
	let result = "";
	let last = 0;
	for (;;) {
		const match = HEX_COLOR_REGEX.exec(text);
		if (match === null) break;
		if (!classifyHexColor(match[1], true)) continue;
		const swatch = colorSwatch(match[1], glyph, match[0]);
		if (!swatch) continue;
		if (match.index > last) result += applySegment(text.slice(last, match.index));
		result += swatch;
		last = match.index + match[0].length;
	}
	if (last === 0) return applySegment(text);
	if (last < text.length) result += applySegment(text.slice(last));
	return result;
}

/** Swatch for a codespan whose entire content is a single hex color, else "". */
function codespanSwatch(code: string, glyph: string): string {
	const match = HEX_COLOR_EXACT_REGEX.exec(code.trim());
	if (!match || !classifyHexColor(match[1], false)) return "";
	return colorSwatch(match[1], glyph, match[0]);
}

interface RenderSignature {
	width: number;
	paddingX: number;
	paddingY: number;
	codeBlockIndent: number;
	literalMath: boolean;
	themeId: number;
	defaultTextStyleId: number;
	imageProtocol: string;
	hyperlinks: boolean;
	textSizing: boolean;
	bgColorProbe: string;
	headingProbe: string;
	/** Fallback glyphs for themes without `symbols`; their identity alone cannot tell presets apart. */
	symbolsProbe: string;
}

/** A shorter prefix the cached rows grew from: its length, its token count and the row count its rows end at. */
interface PrefixMark {
	textEnd: number;
	tokenCount: number;
	lineEnd: number;
}

interface StreamPrefixLineCache extends RenderSignature {
	text: string;
	tokenCount: number;
	// Private to the cache and never handed to callers (each frame copies it
	// into a fresh output array), so an advancing prefix appends in place.
	lines: string[];
	// The shorter prefixes the rows grew from, oldest first. Each ends on a
	// frozen block boundary, so its rows are a render of its tokens alone,
	// and a rewound prefix keeps the rows of the last one it still covers.
	marks: PrefixMark[];
}

/**
 * `cache` cut back to the rows of its last prefix of at most `tokenCount`
 * tokens, in fresh arrays, or `undefined` when it has none. A put-aside prefix
 * may still hold `cache`, so its arrays are never shared.
 */
function rewoundLineCache(
	cache: StreamPrefixLineCache | undefined,
	tokenCount: number,
): StreamPrefixLineCache | undefined {
	if (cache === undefined) return undefined;
	if (cache.tokenCount <= tokenCount) return { ...cache, lines: cache.lines.slice(), marks: cache.marks.slice() };
	let i = cache.marks.length - 1;
	while (i >= 0 && cache.marks[i]!.tokenCount > tokenCount) i--;
	if (i < 0) return undefined;
	const mark = cache.marks[i]!;
	return {
		...cache,
		text: cache.text.slice(0, mark.textEnd),
		tokenCount: mark.tokenCount,
		lines: cache.lines.slice(0, mark.lineEnd),
		marks: cache.marks.slice(0, i),
	};
}
/**
 * Per-token row cache for the *unfrozen tail* (PoC H). The tail re-lexes every
 * streaming frame, but the token sequence is prefix-stable under append-only
 * growth: only the last block token grows, and a closed block's raw bytes and
 * token type never change once later text arrives (a growing structure — open
 * fence, lazy list, setext underline — is always the last token; when it
 * closes, later appends cannot re-segment it). Cached rows are therefore
 * byte-identical to a fresh render of the same token, and splicing them skips
 * the O(tail) styled-text + wrap cost that remains after the lex is skipped.
 *
 * Validity gates (checked on every reuse):
 *  - signature equality (width, padding, theme probes — same set as the
 *    prefix cache) and token-list alignment (`tokenStart` matches the frozen
 *    prefix count);
 *  - token raw equality against the cached snapshot (string equality, so the
 *    cache works both with reused token objects and with a fresh lex that
 *    re-produces the same raw text);
 *  - `nextTypes[i]`: `#renderToken` decides trailing spacing rows from the
 *    next token's type, so a cached row is only valid while the following
 *    token keeps the type it had when the row was produced;
 *  - token type: `table` tokens are never cached — their layout depends on
 *    the whole token and the width budget, and the splice path is not
 *    covered by the byte-identity suite, so they stay conservative.
 *    `code` tokens are cacheable: the open-fence highlight stream is
 *    deterministic on the cumulative token text, and whole-block highlight
 *    fidelity applies only to fences that already have a closing fence.
 */
interface TailRowCache extends RenderSignature {
	tokenStart: number;
	// Upper bound (exclusive) of absolute token indices covered by `rows`.
	cachedThrough: number;
	// Per-token final content rows (1:1 with the rendered content lines),
	// indexed relative to `tokenStart`; undefined for uncacheable tokens.
	rows: (readonly string[] | undefined)[];
	// Raw snapshot per token (string value gate).
	raws: (string | undefined)[];
	// type of token[i+1] when the rows were produced (blank/spacing gate).
	nextTypes: (string | undefined)[];
}
/**
 * Mutable per-token record collector passed to #renderContentLines while
 * rendering the streaming tail. The render loop fills `raws`/`nextTypes`
 * per token as it goes and stores each token's final content rows into
 * `rows` (relative to the render's `start`), so the tail cache can splice byte-identical
 * rows for every token whose raw text and following-token type match.
 */
interface TailRenderRecorder {
	rows: (readonly string[] | undefined)[];
	raws: (string | undefined)[];
	nextTypes: (string | undefined)[];
}
/**
 * The frozen streaming prefix as it stood before a rewind whose only cause was
 * a closer on the still-growing last line, with the row caches keyed on it.
 */
interface RewoundPrefix {
	text: string;
	tokens: Token[];
	openers: readonly PrefixOpener[];
	lineCache: StreamPrefixLineCache | undefined;
	tailRowCache: TailRowCache | undefined;
}
interface StreamingHighlightCache extends RenderSignature {
	lang: string | undefined;
	text: string;
	// Appended in place as the fence grows. Only ever returned to
	// #renderCodeBodyLines, which reads it synchronously and keeps no reference.
	lines: string[];
	stream: HighlightStreamSession;
}

/**
 * Split a highlight-stream push result (newline-terminated lines) into
 * per-line strings, dropping the empty tail produced by the final newline.
 */
function splitPushedHighlightLines(pushed: string): string[] {
	const lines = pushed.split("\n");
	lines.pop();
	return lines;
}

export class Markdown implements Component {
	#text: string;
	// Suffix of #text a future append could still complete into a match
	// (see trailingOsc8Partial); drives the append-only fast path.
	#oscPartialEscape?: string;
	#paddingX: number; // Left/right padding
	#paddingY: number; // Top/bottom padding
	#defaultTextStyle?: DefaultTextStyle;
	#theme: MarkdownTheme;
	#symbols: SymbolTheme;
	#symbolsProbe: string;
	#defaultStylePrefix?: string;
	/** Number of spaces used to indent code block content. */
	#codeBlockIndent: number;
	/** Literal-math mode: math spans and escape smartening stay byte-literal. */
	#literalMath: boolean;
	/** Mode-selected parser (module-level `markdownParser` unless literal-math). */
	#parser: Marked;

	// Cache for rendered output. Cached arrays are shared and returned by
	// reference (render contract: results are component-owned and immutable to
	// callers); the L2 LRU may hand the same array to multiple instances.
	#cachedText?: string;
	#cachedWidth?: number;
	#cachedLines?: readonly string[];
	#transientRenderCache = false;

	// Streaming-lex cache: the largest blank-line-bounded prefix of #text whose
	// block tokens are frozen, plus those tokens. marked has no resumable lexer,
	// but block tokenization is local across a "\n\n" boundary with balanced
	// fences, so lex(prefix) ++ lex(tail) === lex(prefix+tail). On append-only
	// growth (the streaming path) this re-lexes only the grown tail instead of the
	// whole buffer, turning O(N^2) reveal cost into O(N). Width/theme do not affect
	// tokenization, so this cache is independent of the render caches above.
	#streamPrefixText?: string;
	#streamPrefixTokens?: Token[];
	#streamPrefixLineCache?: StreamPrefixLineCache;
	// The first display-math opener of each kind in the frozen prefix whose
	// block an append could still close. The prefix lexes them as the text
	// stands, which stays right until a tail line could close one of them
	// (mathBlockCloserIndex). Such a line turns the text from its kind's opener
	// on into one math block, so the prefix goes back to the boundary in front
	// of that opener, keeps the openers in front of it, and the rest is re-lexed.
	#streamPrefixOpeners: readonly PrefixOpener[] = NO_OPENERS;
	// The frozen prefix's leading run in front of the first of those openers:
	// no append can change its tokens, so getLastRenderStableText publishes it.
	#streamSettledText?: string;
	// The prefix before a rewind that only a closer on the still-growing last
	// line caused. Once a later text holds no closer line after it, that
	// prefix is right again, so #lexTokens puts it back.
	#streamRewound?: RewoundPrefix;
	// Guard-scan memo (PoC C): the ref-def/CR verdict with the exact text
	// length it was checked on. Reuse is sound only while setText has been
	// append-only since (tracked via the startsWith that setText performs): a
	// FALSE verdict stays valid — appending cannot remove an offending ref or
	// CR; a TRUE verdict can flip only when the delta gains a "[" at a fresh
	// line or a "]" / ":" completing a dangling "[…" that straddles the scan
	// edge, or "\n" / "\r". Byte-identity of the checked region: replaceTabs
	// is a per-char map and normalizeOsc8Terminators changes old bytes only
	// when an OSC8 terminator straddles the boundary (which breaks startsWith
	// — the flag then reads non-append), so transient-mode appends are
	// byte-identical. Non-transient repairOrphanClosingFence can additionally
	// delete a bare fence line; its triggers (heading + table lines) always
	// bring "\n" with them, so such frames take the suspicious-delta path,
	// and a deletion that shortens the text trips the length gate — either
	// way the verdict is re-derived, never reused across the deletion.
	#lastScanLength = -1;
	#lastScanCanStream = false;
	#lastScanValid = false;
	#appendOnlySinceLastScan = true;
	// PoC H: per-token row cache for the unfrozen tail. Invalidated together
	// with the prefix cache (width/signature changes, non-append edits) — see
	// the blank-replacement branch of setText and the fallback branch of
	// #lexTokens.
	#tailRowCache?: TailRowCache;
	// True while #renderStreamingContentLines renders the frozen token range:
	// frozen code blocks highlight even in transient mode so their bytes match
	// the finalized render (they render once into the prefix line cache, so
	// the FFI cost is amortized). In the volatile tail, an open fence
	// incrementally highlights its completed lines through a stateful
	// highlight stream (falling back to per-line highlighting for diff-family
	// fences when the theme lacks one) so completed rows are styled immediately;
	// only the trailing partial line stays unhighlighted.
	#renderingStablePrefix = false;
	#streamingHighlightCache?: StreamingHighlightCache;
	#activeRenderSignature?: RenderSignature;
	#fastTail?: FastTailRecipe; // undefined = disarmed
	// B+ capture plumbing: #renderContentLines records the last rendered paragraph row.
	#lastTailCapture?: { kind: "paragraph"; open: boolean; rowInput: string; rowRaw: string };
	#ignoreTight = false;
	#native?: { text: string; stream: boolean; node: NativeNode };
	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		this.invalidate();
		return this;
	}

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		codeBlockIndent: number = 2,
		options?: { literalMath?: boolean },
	) {
		this.#text = normalizeOsc8Terminators(text);
		this.#oscPartialEscape = trailingOsc8Partial(this.#text);
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#theme = theme;
		this.#symbols = theme.symbols ?? getSymbolTheme();
		const { quoteBorder, hrChar, colorSwatch, table } = this.#symbols;
		this.#symbolsProbe = theme.symbols ? "" : [quoteBorder, hrChar, colorSwatch, ...Object.values(table)].join("");
		this.#defaultTextStyle = defaultTextStyle;
		this.#codeBlockIndent = Math.max(0, Math.floor(codeBlockIndent));
		this.#literalMath = options?.literalMath === true;
		this.#parser = this.#literalMath ? literalMathParser : markdownParser;
	}
	/** Return bounded source text and layout state for debug inspection. */
	debugState(): Record<string, unknown> {
		return {
			textPreview: this.#text.slice(0, 120),
			textLength: this.#text.length,
			previewTruncated: this.#text.length > 120,
			paddingX: this.#paddingX,
			paddingY: this.#paddingY,
			codeBlockIndent: this.#codeBlockIndent,
			literalMath: this.#literalMath,
			ignoreTight: this.#ignoreTight,
		};
	}

	setText(text: string): boolean {
		// Identical re-emit (throttled tick): fully normalized already.
		if (text === this.#text) return false;
		// Streaming path: append-only growth. Only the memoized pending escape
		// suffix plus the delta can hold a not-yet-normalized match (a crossing
		// match starts in the pending suffix; everything else is in the delta).
		// Normalize that region alone and splice it onto the old prefix;
		// String.replace returns the input unchanged when nothing matches, so
		// the common clean-delta frame allocates nothing. Once a match is
		// rewritten (ST → BEL), the caller's raw text no longer aligns with
		// #text (2-byte ST vs 1-byte BEL), so later frames fall back to the
		// cold full-document pass — still byte-correct, just not faster.
		if (text.length > this.#text.length && text.startsWith(this.#text)) {
			const memoized = this.#oscPartialEscape;
			const pending = (memoized ?? "") + text.slice(this.#text.length);
			const normalized = normalizeOsc8Terminators(pending);
			if (normalized !== pending) {
				// A stored byte was rewritten (ST → BEL on a crossing match): the
				// stream-prefix lex caches self-invalidate via startsWith guards
				// against #text, so nothing else needs clearing.
				text = this.#text.slice(0, this.#text.length - (memoized?.length ?? 0)) + normalized;
			}
			this.#oscPartialEscape = trailingOsc8Partial(normalized);
			this.#text = text;
			this.invalidate();
			return true;
		}
		// Non-append edits / cold path: full-document pass.
		text = normalizeOsc8Terminators(text);
		this.#oscPartialEscape = trailingOsc8Partial(text);
		// Equality guard: streaming re-emits identical text on ticks that carried
		// no delta (throttled provider frames, reconciled tool-execution updates).
		// Without this, the caller-side `#cachedLines` gets thrown away and the
		// full lex + wrap runs per re-emit — one of the top CPU hotspots during
		// streaming (issue #4353). Mirrors `Text.setText`'s guard.
		if (text === this.#text) return false;
		if (!text.startsWith(this.#text)) {
			// Non-append edit: the previous frame's guard verdict cannot be
			// reused — the checked region may have changed anywhere. The frozen
			// prefix, or one a rewind set aside, may still start the new text,
			// but the line after it was replaced, and a boundary holds only
			// while that line starts a block of its own.
			this.#appendOnlySinceLastScan = false;
			this.#dropStreamPrefix();
			this.#streamRewound = undefined;
		}
		this.#text = text;
		if (!text.trim()) {
			// Blank replacement: render() early-returns before #lexTokens can see
			// the non-append edit, so drop the frozen stream state here or it
			// outlives the content it indexed.
			this.#dropStreamPrefix();
			// B+: the captured fast-path rows index the replaced content — drop
			// the recipe so a fresh stream cannot splice onto stale rows.
			this.#fastTail = undefined;
		}
		this.invalidate();
		return true;
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
	}

	/**
	 * The unrendered source as an `md` node, `stream` while the streaming
	 * (transient) cache is on. Append-only growth yields a fresh node of the
	 * same kind and key whose text extends the previous one, which the
	 * reconciler sends as `text append`.
	 */
	describe(_cx: DescribeContext): NativeNode {
		const stream = this.#transientRenderCache;
		const cached = this.#native;
		if (cached?.text === this.#text && cached.stream === stream) return cached.node;
		// Sources are model text; OSC 8 / SGR bytes a caller spliced in are the terminal's to style, not ours.
		const source = this.#text.includes("\x1b") ? plainText(this.#text) : this.#text;
		const described = md(source, stream ? { stream: true } : undefined);
		this.#native = { text: this.#text, stream, node: described };
		return described;
	}

	/**
	 * Width-independent source prefix of the last render ending at a frozen
	 * Markdown block boundary that no append can move: it stops in front of a
	 * display-math opener whose block an append could still close. Only
	 * meaningful while streaming (transient render cache on); grows
	 * monotonically under append-only `setText`.
	 */
	getLastRenderStableText(): string {
		return this.#transientRenderCache ? (this.#streamSettledText ?? "") : "";
	}

	get transientRenderCache(): boolean {
		return this.#transientRenderCache;
	}

	set transientRenderCache(value: boolean) {
		const next = value === true;
		if (this.#transientRenderCache === next) return;
		this.#transientRenderCache = next;
		// The mode switch changes which normalization applies to the raw text
		// (transient: replaceTabs; final: repairOrphanClosingFence(replaceTabs)),
		// so a memo computed on the other mode's buffer must not be reused —
		// re-derive on the next frame instead.
		this.#appendOnlySinceLastScan = false;
		// B+ reset site: a transient flip (finalize, or a fresh stream on
		// rewound text) means the next render re-lexes from the current
		// source — drop the fast-path recipe so stale rows cannot be served
		// across the transition.
		this.#fastTail = undefined;
		if (!next) {
			// Finalize: the prefix row cache, tail row cache and open-fence
			// highlight stream are read only by transient renders, and each
			// rebuilds from scratch if the block ever streams again — release
			// them so settled blocks stop pinning rows and a native parser.
			// The frozen lex prefix survives only until the next final-mode
			// render consumes it (see #lexTokens / the L2 hit path).
			this.#streamPrefixLineCache = undefined;
			this.#tailRowCache = undefined;
			this.#streamingHighlightCache = undefined;
			this.#streamRewound = undefined;
		}
		this.invalidate();
	}

	// Lex `text` into block tokens, reusing the frozen stable prefix when the text
	// only grew (the streaming path). Falls back to a full lex whenever the prefix
	// is no longer a prefix (non-append edit), the text carries reference-link
	// definitions, or it contains CR (marked normalizes CRLF, which would desync
	// raw-span offsets). Every fallback is correctness-preserving — only speed
	// differs; the render loop sees the identical token list either way.
	#lexTokens(text: string): Token[] {
		// A prefix is frozen only while canStream holds and its lex registered no
		// definitions, and it ends at a "\n\n" block boundary (stableBlockBoundary),
		// so the tail starts at a fresh line. The scan below then catches a
		// top-level definition or CR in the new text and the tail lex's links catch
		// a nested one, so the grown prefix is never re-scanned (O(n²) → O(n)).
		if (this.#streamRewound !== undefined) this.#restoreRewoundPrefix(text);
		const frozenText = this.#streamPrefixText;
		const frozenTokens = this.#streamPrefixTokens;
		const grewPastPrefix = frozenText !== undefined && text.length > frozenText.length && text.startsWith(frozenText);
		// A tail line that could close a display-math block the prefix holds open
		// makes the text from that block's opener on one `math` token, so the
		// prefix goes back to the boundary in front of the opener, and the rest
		// is lexed again. The check reads only the tail, which is lexed anyway.
		if (grewPastPrefix && frozenTokens !== undefined && this.#streamPrefixOpeners.length > 0) {
			this.#rewindForCloser(text, frozenText, frozenTokens);
		}
		const prefix = this.#streamPrefixText;
		const prefixTokens = this.#streamPrefixTokens;
		const hasPrefix = grewPastPrefix && prefix !== undefined && prefixTokens !== undefined;
		const refDefText = hasPrefix ? text.slice(prefix.length) : text;
		// Guard-scan memo (PoC C): while setText has been append-only and the
		// grown delta introduces no "[", "]", ":", "\n" or "\r", the previous
		// verdict stays valid — the checked region is byte-identical (OSC8/tab
		// normalization is prefix-stable on appends) and none of the chars a
		// ref-def or CR needs crossed the scan edge. A false verdict is monotone
		// (appends cannot delete an existing ref def or CR), so it is reused
		// even when the delta is suspicious; only a true verdict on a suspicious
		// delta re-runs the tail scan (PR #9303). The tail scan is also the
		// cold path after non-append edits, which clear the memo. A FALSE
		// verdict is monotone under appends alone (transient mode: no repair,
		// appends cannot delete a ref-def or CR), so there it is reused even
		// on a suspicious delta. Final mode is the exception: render() detects
		// repairOrphanClosingFence deletions (the normalized buffer shrank)
		// and invalidates the memo on the affected frame, so the re-derive
		// happens exactly when the CR/ref-def trigger behind a false verdict
		// may have been deleted — never left stale, and never re-scanned on
		// frames where the memo is sound.
		const appendGrowth = this.#lastScanValid && this.#appendOnlySinceLastScan && text.length > this.#lastScanLength;
		// Final mode keeps the frozen prefix only while the text keeps growing
		// by appends (a stream rendered without the transient flag). A one-shot
		// or just-finalized render still lexes against any existing prefix but
		// then drops it, so settled blocks do not pin a token tree.
		const retainPrefix = this.#transientRenderCache || appendGrowth;
		let canStream: boolean;
		if (appendGrowth) {
			const delta = text.slice(this.#lastScanLength);
			if (
				!delta.includes("[") &&
				!delta.includes("]") &&
				!delta.includes(":") &&
				!delta.includes("\n") &&
				!delta.includes("\r")
			) {
				canStream = this.#lastScanCanStream;
			} else if (this.#lastScanCanStream) {
				canStream = !HAS_REF_DEF.test(refDefText) && !refDefText.includes("\r");
			} else {
				canStream = false;
			}
		} else {
			canStream = !HAS_REF_DEF.test(refDefText) && !refDefText.includes("\r");
		}
		this.#lastScanLength = text.length;
		this.#lastScanCanStream = canStream;
		this.#lastScanValid = true;
		this.#appendOnlySinceLastScan = true;
		if (canStream && hasPrefix) {
			const tailTokens = lexDocument(refDefText, this.#parser);
			// HAS_REF_DEF sees top-level definition lines only. A definition nested
			// in a quote or list item still registers for the whole document and
			// can resolve a reference in the frozen prefix, which was lexed
			// without it, so any definition in the tail sends the text to a full lex.
			if (Object.keys(tailTokens.links).length === 0) {
				const tokens = [...prefixTokens, ...tailTokens];
				if (retainPrefix) this.#freezeStablePrefix(text, tokens, { preserveExisting: true });
				else this.#dropStreamPrefix();
				return tokens;
			}
		}
		const tokens = lexDocument(text, this.#parser);
		// A definition frozen into the prefix would be missing from every later
		// tail lex, so a full lex that registered any definition freezes nothing.
		if (canStream && retainPrefix && Object.keys(tokens.links).length === 0) {
			this.#freezeStablePrefix(text, tokens, { preserveExisting: false });
		} else {
			this.#dropStreamPrefix();
		}
		return tokens;
	}

	/**
	 * Drop the frozen lex prefix and the transient row caches keyed on it. A
	 * prefix set aside for #restoreRewoundPrefix checks itself against each
	 * later text, so it stays until a non-append edit.
	 */
	#dropStreamPrefix(): void {
		this.#streamPrefixText = undefined;
		this.#streamPrefixTokens = undefined;
		this.#streamPrefixOpeners = NO_OPENERS;
		this.#streamSettledText = undefined;
		this.#streamPrefixLineCache = undefined;
		this.#tailRowCache = undefined;
	}

	/**
	 * Rewind the frozen prefix `prefix` (its tokens `tokens`) for a line of the
	 * tail after it that could close one of its openers: back to the boundary
	 * in front of the first opener whose closer a tail line holds. When that
	 * closer, and no other, is on the still-growing last line, the next chunk
	 * can turn the line into text again, so the prefix is set aside for
	 * #restoreRewoundPrefix.
	 */
	#rewindForCloser(text: string, prefix: string, tokens: Token[]): void {
		let target: PrefixOpener | undefined;
		let lastLineOnly = false;
		for (const opener of this.#streamPrefixOpeners) {
			const closer = mathBlockCloserIndex(text, prefix.length, opener.kind);
			if (closer === undefined) continue;
			lastLineOnly = target === undefined && !text.includes("\n", closer);
			target ??= opener;
		}
		if (target === undefined) return;
		this.#streamRewound = lastLineOnly
			? {
					text: prefix,
					tokens,
					openers: this.#streamPrefixOpeners,
					lineCache: this.#streamPrefixLineCache,
					tailRowCache: this.#tailRowCache,
				}
			: undefined;
		this.#rewindStreamPrefix(target.rewindEnd, target.rewindCount);
	}

	/**
	 * Cut the frozen prefix back to the boundary `end` characters and `count`
	 * tokens in, keeping the openers in front of it and the rows of the prefix
	 * that remains, and dropping the tail row cache keyed on the old prefix.
	 */
	#rewindStreamPrefix(end: number, count: number): void {
		this.#streamPrefixLineCache = rewoundLineCache(this.#streamPrefixLineCache, count);
		this.#tailRowCache = undefined;
		if (count === 0) {
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixOpeners = NO_OPENERS;
			return;
		}
		this.#streamPrefixText = this.#streamPrefixText?.slice(0, end);
		this.#streamPrefixTokens = this.#streamPrefixTokens?.slice(0, count);
		this.#streamPrefixOpeners = this.#streamPrefixOpeners.filter(opener => opener.at < end);
	}

	/**
	 * Put back the prefix #rewindForCloser set aside once no line of `text`
	 * after it could close one of its openers: the last line it rewound for
	 * has grown into text, so the prefix lexes as the text stands again. A
	 * closer line that has ended stays one under every append, so a prefix
	 * with one after it can never come back.
	 */
	#restoreRewoundPrefix(text: string): void {
		const rewound = this.#streamRewound;
		if (rewound === undefined) return;
		if (text.length <= rewound.text.length || !text.startsWith(rewound.text)) {
			this.#streamRewound = undefined;
			return;
		}
		for (const opener of rewound.openers) {
			const closer = mathBlockCloserIndex(text, rewound.text.length, opener.kind);
			if (closer === undefined) continue;
			if (text.includes("\n", closer)) this.#streamRewound = undefined;
			return;
		}
		this.#streamRewound = undefined;
		this.#streamPrefixText = rewound.text;
		this.#streamPrefixTokens = rewound.tokens;
		this.#streamPrefixOpeners = rewound.openers;
		this.#streamPrefixLineCache = rewound.lineCache;
		this.#tailRowCache = rewound.tailRowCache;
	}

	// Freeze the largest run of leading blocks that end on a hard "\n\n" boundary
	// (complete, and immutable under append-only growth until a tail line could
	// close a display-math block it holds open) so the next streaming render
	// re-lexes only the unfrozen tail. Caller guarantees no CR / no reference
	// definitions, so each token's `raw` is a verbatim slice of `text` and the
	// summed offsets address `text` exactly.
	#freezeStablePrefix(text: string, tokens: Token[], opts: { preserveExisting: boolean }): void {
		// On the streaming-concat path (preserveExisting), tokens[0..prefixCount)
		// ARE the previously frozen prefix and the text above it is byte-
		// identical, so its boundary cannot move: re-walking those tokens every
		// frame is pure overhead (O(prefix) per frame, O(n²) over a stream).
		// Skip them and resume at the first tail token; `base` starts at the
		// prefix length so accumulated offsets stay global. The cold full-lex
		// path (preserveExisting: false) re-derives the whole stream, so it
		// must keep walking from 0.
		const skipPrefix = opts.preserveExisting ? (this.#streamPrefixTokens?.length ?? 0) : 0;
		const base = skipPrefix > 0 ? (this.#streamPrefixText?.length ?? 0) : 0;
		const frozen = stableBlockBoundary(text, base, tokens, { startIndex: skipPrefix });
		if (frozen.count === 0) {
			if (!opts.preserveExisting) this.#dropStreamPrefix();
			return;
		}
		let openers = skipPrefix > 0 ? this.#streamPrefixOpeners : NO_OPENERS;
		if (openers.length === 0) {
			// The prefix so far is all settled, so the settled part grows up to the
			// last boundary in front of the first opener an append could close.
			const settled = stableBlockBoundary(text, base, tokens, { startIndex: skipPrefix, settle: true });
			if (settled.count > 0) {
				this.#streamSettledText = text.slice(0, settled.end);
			} else if (skipPrefix === 0) {
				this.#streamSettledText = undefined;
			}
		}
		// Record the first opener of each kind in the newly frozen tokens that an
		// append could still close, with the boundary a closer of its kind
		// rewinds to: the last one in front of it, or the prefix end when the new
		// tokens hold none. It is never in front of an earlier opener's, so the
		// first opener whose closer a tail line holds has the earliest boundary.
		let pos = base;
		for (let i = skipPrefix; i < frozen.count && openers.length < 2; i++) {
			const token = tokens[i];
			if (token.type !== "math") {
				const kind = mathBlockOpenerAt(text, pos);
				if (kind !== undefined && !openers.some(opener => opener.kind === kind) && mathBlockMayCloseAt(text, pos)) {
					const boundary = stableBlockBoundary(text, base, tokens, { startIndex: skipPrefix, endIndex: i });
					let rewindEnd = boundary.count > 0 ? boundary.end : base;
					let rewindCount = boundary.count > 0 ? boundary.count : skipPrefix;
					const earlier = openers.at(-1);
					if (earlier !== undefined && earlier.rewindEnd > rewindEnd) {
						rewindEnd = earlier.rewindEnd;
						rewindCount = earlier.rewindCount;
					}
					openers = [...openers, { kind, at: pos, rewindEnd, rewindCount }];
				}
			}
			pos += token.raw.length;
		}
		this.#streamPrefixText = text.slice(0, frozen.end);
		this.#streamPrefixTokens = tokens.slice(0, frozen.count);
		this.#streamPrefixOpeners = openers;
	}

	render(width: number): readonly string[] {
		// L1: per-instance cache — fastest path for repeated renders of the same
		// instance at the same width (e.g. resize debounce, repeated redraws).
		// Returning the cached reference is load-bearing: parents memoize their
		// concatenation on reference equality.
		if (this.#cachedLines && this.#cachedText === this.#text && this.#cachedWidth === width) {
			return this.#cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Don't render anything if there's no actual text
		if (!this.#text || this.#text.trim() === "") {
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = EMPTY_RENDER_LINES;
			return EMPTY_RENDER_LINES;
		}

		// Fast-path inputs only: signature first, so the append-only branch below
		// can return without scanning the whole document for tabs.
		const signature = this.#renderSignature(width, paddingX);
		// B+ fast path: an append-only, same-line delta re-renders ONLY the
		// last content row (the paragraph's trailing wrapped row) with the
		// grown source, so the new text shows every frame while staying
		// byte-identical to a cold full render (the full re-lex produces the
		// same grown inline tokens and the same wrap). The previous frame's
		// rows live in #fastTail.lines — the L1 #cachedLines was invalidated
		// by setText, so the fast path cannot read it back. An inert delta
		// has no "\n", so the frozen prefix cannot advance and the rows above
		// the spliced span stay byte-identical.
		if (
			this.transientRenderCache &&
			this.#fastTail !== undefined &&
			contentWidth === this.#fastTail.width &&
			this.#text.length > this.#fastTail.source.length &&
			this.#text.startsWith(this.#fastTail.source)
		) {
			// Re-probe signature (pure) and require equality — a bgColor/theme
			// change (width-constant) must not splice rows of the stale recipe.
			const recipe = this.#fastTail;
			if (!this.#signatureEquals(signature, recipe.signature)) {
				this.#fastTail = undefined;
			} else {
				const delta = this.#text.slice(recipe.source.length);
				const deltaTabs = replaceTabs(delta);
				// Seam window contains the delta, so one URL/email scan catches both.
				const seamSafe = fastTailSeamSafe(recipe.rowRaw);
				const seamWindow =
					recipe.rowRaw.slice(Math.max(recipe.rowRaw.lastIndexOf(" "), recipe.rowRaw.lastIndexOf("\t")) + 1) +
					deltaTabs;
				// A paragraph's last line can complete into a different block
				// kind under an inert delta — disarm (single gate helper, kept
				// in sync with the exported test surface).
				const grownLine = recipe.rowRaw.slice(recipe.rowRaw.lastIndexOf("\n") + 1) + deltaTabs;
				const lineStartHazard = fastLineStartHazard(grownLine);
				// Only same-line deltas splice; marker deltas re-lex through the
				// REAL inline pipeline so self-contained pairs render styled.
				const hardDelta = /[\n\r\x1b]/.test(delta);
				const markerDelta = FAST_DELTA_RE.test(delta);
				// A delta starting/ending `_` after a word char pairs in isolation
				// but stays intraword-literal in the full text. Symmetrically, a
				// row ending with a closing delimiter (`_`, `*`, `~`) followed by
				// a word-char delta makes the delimiter intraword / non-flanking in
				// the joined text — the cold render drops the emphasis, but the
				// splice keeps it. A row ending `$` (closed inline math) followed
				// by a digit is invalidated by the anti-currency rule ($x$123 is
				// literal, not math) — disarm.
				const grownLastLine = recipe.rowRaw.slice(recipe.rowRaw.lastIndexOf("\n") + 1) + deltaTabs;
				const trailingDelimiterSeamHazard =
					(markerDelta &&
						(deltaTabs.startsWith("_") || deltaTabs.endsWith("_")) &&
						FAST_UNDERSCORE_WORD_AT_END_RE.test(recipe.rowRaw)) ||
					(!markerDelta && /[*~_]$/.test(recipe.rowRaw) && FAST_CMARK_WORD_AT_START_RE.test(deltaTabs)) ||
					(!markerDelta && recipe.rowRaw.endsWith("$") && /^[0-9]/.test(deltaTabs));
				// A delta opening a pairing char when the captured row ENDS with the
				// same char can re-pair across the seam: cold lex of the joined run
				// makes ONE token (x *a**b* → em("a**b")), the splice keeps two. So
				// can an emphasis delimiter in the delta and the same char anywhere
				// in the row, once the joined text makes the row's one flanking
				// (`a_{3` + `} + b_{` renders `{3} + b` emphasized): the delta lexed
				// alone has nothing to pair with. An image marker (`x!` + `[a](u)`)
				// re-pairs the same way.
				const pairSeamHazard =
					markerDelta &&
					((/^[*~`]/.test(deltaTabs) && /[*~`]$/.test(recipe.rowRaw)) ||
						FAST_EMPHASIS_DELIMITERS.some(c => deltaTabs.includes(c) && recipe.rowRaw.includes(c)) ||
						// "x!" + "[a](u)": cold lexes text("x") + image(alt); the splice would
						// keep "x!" + a styled link byte-run.
						(deltaTabs.startsWith("[") && recipe.rowRaw.endsWith("!")));
				const deltaTokens = markerDelta && !hardDelta ? lexInlineTokens(deltaTabs, this.#parser) : null;
				if (
					seamSafe &&
					!lineStartHazard &&
					!hardDelta &&
					!trailingDelimiterSeamHazard &&
					// A grown GFM delimiter last line flips a preceding pipe-header
					// into a table on a marker-free delta (`| --` + `--- | -`).
					!FAST_TABLE_DELIM_ROW_RE.test(grownLastLine) &&
					(!markerDelta || (!this.#lastTailCapture?.open && !pairSeamHazard && !inlineHasOpen(deltaTokens!))) &&
					!FAST_URL_ANYWHERE_RE.test(seamWindow)
				) {
					// Same text paths a full re-lex applies: real pipeline for marker
					// deltas, plain swatch/entity render for inert deltas.
					const { applyText } = this.#getDefaultInlineStyleContext();
					const grown =
						recipe.rowText +
						(markerDelta
							? this.#renderInlineTokens(deltaTokens!)
							: renderTextWithSwatches(
									normalizeHtmlEntitiesForTerminal(deltaTabs),
									applyText,
									this.#symbols.colorSwatch || DEFAULT_COLOR_SWATCH_GLYPH,
								));
					const wrapped = wrapTextWithAnsi(grown, contentWidth);
					const fastPaddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
					const leftMargin = padding(fastPaddingX);
					const rightMargin = padding(fastPaddingX);
					const bgFn = this.#defaultTextStyle?.bgColor;
					const fastRows: string[] = [];
					for (const row of wrapped) {
						const withMargins = leftMargin + row + rightMargin;
						fastRows.push(
							bgFn
								? applyBackgroundToLine(withMargins, width, bgFn)
								: withMargins + padding(Math.max(0, width - visibleWidth(withMargins))),
						);
					}
					// Splice onto the previous frame's rows (new array — parent may
					// hold the old one). One copy of the head, then the few new and
					// trailing rows, instead of spreading two intermediate slices.
					const prev = recipe.lines;
					const fastResult = prev.slice(0, recipe.rowStart);
					appendLines(fastResult, fastRows);
					for (let i = recipe.rowEnd; i < prev.length; i++) fastResult.push(prev[i]!);
					this.#cachedText = this.#text;
					this.#cachedWidth = width;
					this.#cachedLines = fastResult;
					this.#fastTail = {
						lines: fastResult,
						source: this.#text,
						width: recipe.width,
						rowText: wrapped[wrapped.length - 1] ?? "",
						rowRaw: recipe.rowRaw + deltaTabs,
						rowStart: recipe.rowStart + wrapped.length - 1,
						rowEnd: recipe.rowStart + wrapped.length,
						signature: recipe.signature,
					};
					return fastResult;
				}
			}
			// Hazard → disarm until the next real render re-captures.
			this.#fastTail = undefined;
		}
		// Normalize only after the append-only branch: the fast path above
		// returns without ever reading these, so streaming frames skip the
		// whole-document tab scan/copy (the delta-only replaceTabs inside the
		// branch is the only tab work a streamed frame pays).
		const tabbed = this.#text.includes("\t") ? replaceTabs(this.#text) : this.#text;
		const normalizedText = this.transientRenderCache ? tabbed : repairOrphanClosingFence(tabbed);
		if (!this.transientRenderCache && normalizedText.length < tabbed.length) {
			// repairOrphanClosingFence deleted bytes this frame (orphan fence
			// removed): the guard-scan memo's checked region is no longer
			// byte-identical, and a cached false verdict may have been based
			// on the very CR/ref-def line that was deleted. Invalidate so the
			// next #lexTokens re-derives on the repaired buffer. The text past
			// the frozen prefix is no append of what was frozen against either
			// (a fence line right after the prefix leaves the tail opening on
			// blank lines a one-pass lex joins to the ones above), so drop it,
			// and any prefix a rewind set aside.
			this.#lastScanValid = false;
			this.#dropStreamPrefix();
			this.#streamRewound = undefined;
		}

		// L2: module-level LRU — survives component disposal/recreation across
		// session-tree navigations. Key encodes every dimension that affects the
		// render output so different configurations never collide.
		// Encode terminal capability state and theme/style function output samples
		// so that capability shifts (image protocol changes, hyperlink toggle) or
		// caller-supplied theme/bgColor functions that mutate their output without
		// changing object identity invalidate the cache entry.
		// bgColor probe uses \x01 (single non-printable byte): chalk/ANSI wrappers
		// pass arbitrary bytes through verbatim, so this is safe and minimizes the
		// risk of clashing with a function that returns text verbatim.
		// theme.heading is used as the representative theme probe — it's required
		// by MarkdownTheme and is one of the most styling-sensitive entries.
		let cacheKey: string | undefined;
		if (!this.transientRenderCache) {
			cacheKey = this.#renderCacheKey(normalizedText, signature);
			const cached = renderCache.get(cacheKey);
			if (cached !== undefined) {
				// A final-mode hit right after finalize (or a non-append edit)
				// never reaches #lexTokens, which would otherwise consume and drop
				// the frozen lex prefix — release it here instead.
				if (!this.#appendOnlySinceLastScan) this.#dropStreamPrefix();
				// Populate L1 so subsequent calls from this instance are O(1) map lookup.
				this.#cachedText = this.#text;
				this.#cachedWidth = width;
				this.#cachedLines = cached;
				return cached;
			}
		}

		// Parse markdown to HTML-like tokens
		const tokens = this.#lexTokens(normalizedText);
		let contentLines: string[];
		this.#activeRenderSignature = signature;
		try {
			contentLines = this.transientRenderCache
				? this.#renderStreamingContentLines(tokens, normalizedText, signature, contentWidth)
				: this.#renderContentLines(tokens, 0, tokens.length, contentWidth, signature);
		} finally {
			this.#activeRenderSignature = undefined;
		}
		const emptyLines = this.#renderEmptyPaddingLines(signature);

		// Combine top padding, content, and bottom padding. contentLines is a
		// fresh per-render array (never cache-owned), so without vertical
		// padding it is handed out as-is rather than copied again.
		const rawResult = emptyLines.length === 0 ? contentLines : [...emptyLines, ...contentLines, ...emptyLines];
		const result = rawResult.length > 0 ? rawResult : [""];

		// Update caches and hand the array out by reference. Callers must not
		// mutate it (Component render contract); the L2 entry is shared across
		// instances keyed on identical inputs.
		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedLines = result;

		const fastEligible =
			this.transientRenderCache &&
			contentLines.length > 0 &&
			// B+ invariant: only the FINAL #renderContentLines call captures;
			// the all-cache-hit prefix path clears #lastTailCapture at its top.
			this.#lastTailCapture !== undefined &&
			this.#lastTailCapture.kind === "paragraph" &&
			// Run-level default styling (color/bold/italic/strikethrough/
			// underline) disarms: the splice yields two ANSI runs where a cold
			// render yields one; bgColor is line-level and stays eligible.
			!this.#defaultTextStyle?.color &&
			!this.#defaultTextStyle?.bold &&
			!this.#defaultTextStyle?.italic &&
			!this.#defaultTextStyle?.strikethrough &&
			!this.#defaultTextStyle?.underline;
		if (fastEligible && this.#lastTailCapture !== undefined) {
			const capture = this.#lastTailCapture;
			this.#fastTail = {
				lines: result,
				source: this.#text,
				width: contentWidth,
				rowText: capture.rowInput,
				rowRaw: capture.rowRaw,
				rowStart: signature.paddingY + contentLines.length - 1,
				rowEnd: signature.paddingY + contentLines.length,
				signature,
			};
		} else {
			this.#fastTail = undefined;
		}

		// Update L2 module-level LRU so future instances with the same key skip
		// the marked.lexer + highlightCode (Rust FFI) work entirely.
		if (cacheKey !== undefined) {
			renderCache.set(cacheKey, result);
		}
		return result;
	}

	#renderSignature(width: number, paddingX: number): RenderSignature {
		const bgColorProbe = this.#defaultTextStyle?.bgColor ? this.#defaultTextStyle.bgColor("\x01") : "";
		const headingProbe = this.#theme.heading("");
		return {
			width,
			paddingX,
			paddingY: this.#paddingY,
			codeBlockIndent: this.#codeBlockIndent,
			literalMath: this.#literalMath,
			themeId: objectId(this.#theme),
			defaultTextStyleId: this.#defaultTextStyle ? objectId(this.#defaultTextStyle) : -1,
			imageProtocol: TERMINAL.imageProtocol ?? "",
			hyperlinks: TERMINAL.hyperlinks,
			textSizing: TERMINAL.textSizing,
			bgColorProbe,
			headingProbe,
			symbolsProbe: this.#symbolsProbe,
		};
	}
	// All-primitive signature — compare via the canonical render-cache encoding.
	#signatureEquals(a: RenderSignature, b: RenderSignature): boolean {
		return this.#renderCacheKey("", a) === this.#renderCacheKey("", b);
	}

	#renderCacheKey(normalizedText: string, signature: RenderSignature): string {
		return `${normalizedText}\x00${signature.width}\x00${signature.paddingX}\x00${signature.paddingY}\x00${signature.codeBlockIndent}\x00${signature.literalMath ? 1 : 0}\x00${signature.themeId}\x00${signature.defaultTextStyleId}\x00${signature.imageProtocol}\x00${signature.hyperlinks ? 1 : 0}\x00${signature.textSizing ? 1 : 0}\x00${signature.bgColorProbe}\x00${signature.headingProbe}\x00${signature.symbolsProbe}`;
	}

	#renderStreamingContentLines(
		tokens: Token[],
		normalizedText: string,
		signature: RenderSignature,
		contentWidth: number,
	): string[] {
		const stableText = this.#streamPrefixText;
		const stableTokenCount = this.#streamPrefixTokens?.length ?? 0;
		if (stableText === undefined || stableTokenCount === 0 || !normalizedText.startsWith(stableText)) {
			return this.#renderStreamingTail(tokens, 0, contentWidth, signature);
		}

		// Prefix rows live in #streamPrefixLineCache.lines, which is private to
		// the cache: an advancing prefix appends its newly frozen rows in place
		// instead of re-snapshotting, and each frame's output is one fresh copy
		// of prefix + tail, so no array handed to a caller is ever mutated.
		const reusablePrefix = this.#matchingStreamPrefixLineCache(normalizedText, stableText, signature);
		let prefixLines: string[] = [];
		let marks: PrefixMark[] = [];
		let renderedUntil = 0;
		if (reusablePrefix && reusablePrefix.tokenCount <= stableTokenCount) {
			prefixLines = reusablePrefix.lines;
			marks = reusablePrefix.marks;
			renderedUntil = reusablePrefix.tokenCount;
			if (renderedUntil < stableTokenCount) {
				marks.push({ textEnd: reusablePrefix.text.length, tokenCount: renderedUntil, lineEnd: prefixLines.length });
			}
		}

		if (renderedUntil < stableTokenCount) {
			// Stable tokens render with full fidelity (syntax highlighting on)
			// so these cached rows byte-match the finalized render.
			this.#renderingStablePrefix = true;
			let frozenRows: string[];
			try {
				frozenRows = this.#renderContentLines(tokens, renderedUntil, stableTokenCount, contentWidth, signature);
			} finally {
				this.#renderingStablePrefix = false;
			}
			if (prefixLines.length === 0) prefixLines = frozenRows;
			else appendLines(prefixLines, frozenRows);
			renderedUntil = stableTokenCount;
		}

		this.#streamPrefixLineCache = {
			...signature,
			text: stableText,
			tokenCount: stableTokenCount,
			lines: prefixLines,
			marks,
		};

		if (renderedUntil >= tokens.length) return prefixLines.slice();
		return prefixLines.concat(this.#renderStreamingTail(tokens, renderedUntil, contentWidth, signature));
	}

	#matchingStreamPrefixLineCache(
		normalizedText: string,
		stableText: string,
		signature: RenderSignature,
	): StreamPrefixLineCache | undefined {
		const cache = this.#streamPrefixLineCache;
		if (!cache) return undefined;
		if (!normalizedText.startsWith(cache.text) || !stableText.startsWith(cache.text)) return undefined;
		if (cache.width !== signature.width) return undefined;
		if (cache.paddingX !== signature.paddingX) return undefined;
		if (cache.paddingY !== signature.paddingY) return undefined;
		if (cache.codeBlockIndent !== signature.codeBlockIndent) return undefined;
		if (cache.literalMath !== signature.literalMath) return undefined;
		if (cache.themeId !== signature.themeId) return undefined;
		if (cache.defaultTextStyleId !== signature.defaultTextStyleId) return undefined;
		if (cache.imageProtocol !== signature.imageProtocol) return undefined;
		if (cache.hyperlinks !== signature.hyperlinks) return undefined;
		if (cache.textSizing !== signature.textSizing) return undefined;
		if (cache.bgColorProbe !== signature.bgColorProbe) return undefined;
		if (cache.headingProbe !== signature.headingProbe) return undefined;
		return cache;
	}

	/**
	 * Render the unfrozen tail, splicing byte-identical rows from
	 * {@link #tailRowCache} for every token whose raw text and following-token
	 * type still match the cached snapshot. The splice reuses the exact content
	 * lines a fresh render would produce — the row offsets are implicit in the
	 * array order, so no offset recomputation is needed. The growing last token
	 * is never spliced (its raw text always differs); it renders fresh and is
	 * recorded again, so the cache trails the stream by one token.
	 */
	#renderStreamingTail(tokens: Token[], start: number, contentWidth: number, signature: RenderSignature): string[] {
		const out: string[] = [];
		let spliceEnd = start;
		const cache = this.#tailRowCache;
		if (cache !== undefined) {
			spliceEnd = this.#tailSpliceEnd(cache, start, signature, tokens);
			for (let i = start; i < spliceEnd; i++) {
				appendLines(out, cache.rows[i - start]!);
			}
		}

		const recorder: TailRenderRecorder = {
			// oxlint-disable-next-line unicorn/no-new-array -- render-cache length preallocation
			rows: new Array(tokens.length - spliceEnd).fill(undefined),
			// oxlint-disable-next-line unicorn/no-new-array -- render-cache length preallocation
			raws: new Array(tokens.length - spliceEnd).fill(undefined),
			// oxlint-disable-next-line unicorn/no-new-array -- render-cache length preallocation
			nextTypes: new Array(tokens.length - spliceEnd).fill(undefined),
		};
		const fresh = this.#renderContentLines(tokens, spliceEnd, tokens.length, contentWidth, signature, recorder);
		const result = out.length === 0 ? fresh : out.concat(fresh);

		// Refresh the cache: keep entries for spliced tokens (their raws stay
		// valid), overlay the fresh entries, and re-derive the contiguous
		// covered prefix (splicing stops at the first uncacheable or
		// changed token). All arrays are tail-relative (index 0 = token
		// `start`), so a mostly-frozen document allocates only for the
		// unfrozen tail instead of the whole token list every frame.
		const tailCount = tokens.length - start;
		// oxlint-disable-next-line unicorn/no-new-array -- render-cache length preallocation
		const rows: (readonly string[] | undefined)[] = new Array(tailCount).fill(undefined);
		// oxlint-disable-next-line unicorn/no-new-array -- render-cache length preallocation
		const raws: (string | undefined)[] = new Array(tailCount).fill(undefined);
		// oxlint-disable-next-line unicorn/no-new-array -- render-cache length preallocation
		const nextTypes: (string | undefined)[] = new Array(tailCount).fill(undefined);
		if (cache !== undefined && cache.tokenStart === start) {
			for (let i = start; i < Math.min(cache.cachedThrough, spliceEnd); i++) {
				rows[i - start] = cache.rows[i - start];
				raws[i - start] = cache.raws[i - start];
				nextTypes[i - start] = cache.nextTypes[i - start];
			}
		}
		for (let i = spliceEnd; i < tokens.length; i++) {
			rows[i - start] = recorder.rows[i - spliceEnd];
			raws[i - start] = recorder.raws[i - spliceEnd];
			nextTypes[i - start] = recorder.nextTypes[i - spliceEnd];
		}
		let cachedThrough = start;
		while (cachedThrough < tokens.length && rows[cachedThrough - start] !== undefined) cachedThrough++;
		this.#tailRowCache = {
			...signature,
			tokenStart: start,
			cachedThrough,
			rows,
			raws,
			nextTypes,
		};
		return result;
	}

	// Longest cache-spliceable prefix: every cached row from `start` up to
	// (but not including) the returned index is byte-identical to a fresh
	// render of the same token. Stops at the first uncacheable token (rows
	// undefined), the first token whose raw text changed (the growing tail
	// token), or a following-token type change.
	#tailSpliceEnd(cache: TailRowCache, start: number, signature: RenderSignature, tokens: Token[]): number {
		if (cache.tokenStart !== start) return start;
		if (cache.width !== signature.width) return start;
		if (cache.paddingX !== signature.paddingX) return start;
		if (cache.paddingY !== signature.paddingY) return start;
		if (cache.codeBlockIndent !== signature.codeBlockIndent) return start;
		if (cache.literalMath !== signature.literalMath) return start;
		if (cache.themeId !== signature.themeId) return start;
		if (cache.defaultTextStyleId !== signature.defaultTextStyleId) return start;
		if (cache.imageProtocol !== signature.imageProtocol) return start;
		if (cache.hyperlinks !== signature.hyperlinks) return start;
		if (cache.textSizing !== signature.textSizing) return start;
		if (cache.bgColorProbe !== signature.bgColorProbe) return start;
		if (cache.headingProbe !== signature.headingProbe) return start;
		const limit = Math.min(cache.cachedThrough, tokens.length);
		for (let i = start; i < limit; i++) {
			if (cache.rows[i - start] === undefined) return i; // uncacheable token stops the splice
			const cachedRaw = cache.raws[i - start];
			const token = tokens[i];
			if (cachedRaw === undefined || token === undefined) return start;
			if (token.raw !== cachedRaw) return i; // changed/growing token: fresh-render from here
			if ((tokens[i + 1]?.type ?? undefined) !== cache.nextTypes[i - start]) return i;
		}
		return limit;
	}

	#renderContentLines(
		tokens: Token[],
		start: number,
		end: number,
		contentWidth: number,
		signature: RenderSignature,
		tailRecorder?: TailRenderRecorder,
	): string[] {
		// A non-capturing final call must not serve a stale recipe, so the
		// B+ plumbing is cleared up front; the per-token capture re-fills it.
		if (end === tokens.length) this.#lastTailCapture = undefined;
		const wrappedLines: RenderedLine[] = [];
		// Wrapped-row span per absolute token index. Call-local: stale values
		// are never read across renders.
		const tokenWrappedRowCounts: number[] = [];
		for (let i = start; i < end; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenWrappedRowStart = wrappedLines.length;
			const renderedTokenLines = this.#renderToken(token, contentWidth, nextToken?.type);
			for (const renderedRow of renderedTokenLines) {
				// Lists wrap while their structural prefixes are still available, so
				// continuation rows retain the correct hanging indent. Re-wrapping the
				// flattened rows here would discard that structure.
				if (token.type === "list" || TERMINAL.isImageLine(renderedRow.text) || isOsc66Line(renderedRow.text)) {
					wrappedLines.push(renderedRow);
				} else {
					const wrappedRows = wrapTextWithAnsi(renderedRow.text, contentWidth);
					if (wrappedRows.length === 1 && wrappedRows[0] === renderedRow.text) {
						wrappedLines.push(renderedRow);
					} else {
						for (const wrappedLine of wrappedRows) {
							wrappedLines.push(renderedLine(wrappedLine, renderedRow.literalCode));
						}
					}
				}
			}
			tokenWrappedRowCounts[i] = wrappedLines.length - tokenWrappedRowStart;
			// B+ capture hook: the LAST token of the FINAL call is the frame's
			// true trailing content row — record its rendered last row and raw
			// tail so render() can build the fast-path recipe. The frozen
			// prefix call (end < tokens.length) must never capture.
			if (end === tokens.length && i === end - 1 && token.type === "paragraph") {
				const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
				const lastLine = renderedTokenLines[renderedTokenLines.length - 1];
				// Display math, a newline-terminated paragraph (a fresh line
				// grows next frame — the captured row is not the mutable tail),
				// or a tree-guide/OSC-8/OSC-66 trailing row are not
				// self-contained.
				if (
					soleDisplayMath(token.tokens) ||
					raw.endsWith("\n") ||
					!lastLine ||
					TREE_GUIDE_ANCHOR_RE.test(lastLine.text) ||
					lastLine.text.includes("\x1b]") ||
					TERMINAL.isImageLine(lastLine.text) ||
					isOsc66Line(lastLine.text)
				) {
					continue;
				}
				const wrappedLast = wrappedLines[wrappedLines.length - 1];
				this.#lastTailCapture = {
					kind: "paragraph",
					rowInput: wrappedLast?.text ?? lastLine.text,
					rowRaw: raw.slice(raw.lastIndexOf("\n") + 1),
					open: inlineHasOpen(token.tokens ?? []),
				};
			}
		}

		const leftMargin = padding(signature.paddingX);
		const rightMargin = padding(signature.paddingX);
		const bgFn = this.#defaultTextStyle?.bgColor;
		const contentLines: string[] = [];
		let previousLineWasOsc66 = false;
		for (const renderedLine of wrappedLines) {
			const literalCodeRow = renderedLine.literalCode === true;
			const line = renderedLine.text;
			// The first empty row after a scale>1 OSC 66 heading is structural:
			// it reserves the lower cells occupied by the multicell glyphs. Do
			// not pad or background-fill it, because real spaces on that row can
			// interact with Kitty's multicell overwrite rules during the first
			// paint. Leave it as a cursor-only newline.
			if (previousLineWasOsc66 && line === "") {
				contentLines.push("");
				previousLineWasOsc66 = false;
				continue;
			}

			// Image lines and OSC 66 sized headings must be output raw - no margins or background
			if (TERMINAL.isImageLine(line) || isOsc66Line(line)) {
				contentLines.push(line);
				previousLineWasOsc66 = isOsc66Line(line);
				continue;
			}

			previousLineWasOsc66 = false;
			if (literalCodeRow) {
				contentLines.push(line);
				continue;
			}
			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, signature.width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, signature.width - visibleLen);
				contentLines.push(lineWithMargins + padding(paddingNeeded));
			}
		}

		// PoC H: record per-token row slices for the tail cache. The pad pass
		// maps every wrapped row to exactly one content line (structural blanks
		// after OSC 66 sized headings are pushed unpadded but still present), so
		// slicing by the per-token wrap spans recovers each token's exact rows.
		if (tailRecorder !== undefined) {
			const rows = tailRecorder.rows;
			const raws = tailRecorder.raws;
			const nextTypes = tailRecorder.nextTypes;
			let wrappedStart = 0;
			let contentCursor = 0;
			for (let i = start; i < end; i++) {
				const token = tokens[i]!;
				const wrappedEnd = wrappedStart + tokenWrappedRowCounts[i]!;
				const rowCount = wrappedEnd - wrappedStart;
				raws[i - start] = token.raw;
				nextTypes[i - start] = tokens[i + 1]?.type;
				// Tables are never cached: their layout depends on the whole
				// token and the width budget, and the splice path is not
				// covered by the byte-identity suite. Keep the raw/nextTypes
				// gates but drop rows.
				if (token.type === "table") {
					rows[i - start] = undefined;
				} else {
					rows[i - start] = contentLines.slice(contentCursor, contentCursor + rowCount);
				}
				contentCursor += rowCount;
				wrappedStart = wrappedEnd;
			}
		}

		return contentLines;
	}

	#renderCodeBodyLines(token: Token, codeIndent: string): RenderedLine[] {
		const literalCode = this.#codeBlockIndent === 0;
		const bodyLines: RenderedLine[] = [];
		const tokenText = "text" in token && typeof token.text === "string" ? token.text : "";
		const lang = "lang" in token && typeof token.lang === "string" ? token.lang : undefined;
		const addBodyLine = (line: string): void => {
			bodyLines.push(renderedLine(literalCode ? line : codeIndent + line, literalCode));
		};

		const streaming = this.transientRenderCache && !this.#renderingStablePrefix;
		if (this.#theme.highlightCode && (!streaming || this.#codeTokenHasClosingFence(token))) {
			// Finalized content — or a fence that closed mid-stream, which
			// highlights through the same whole-block call the finalized render
			// uses so cached stable rows byte-match it.
			const highlightedLines = this.#theme.highlightCode(tokenText, lang);
			for (const hlLine of highlightedLines) {
				addBodyLine(hlLine);
			}
			return bodyLines;
		}

		if (streaming && this.#theme.highlightCode) {
			// Open fence: highlight completed lines incrementally so semantic
			// colors reach completed rows immediately; only the trailing partial
			// line stays unhighlighted.
			const lineEnd = tokenText.lastIndexOf("\n");
			const completedLines = lineEnd >= 0 ? this.#highlightStreamingLines(tokenText, lineEnd, lang) : null;
			if (completedLines) {
				for (const hlLine of completedLines) {
					addBodyLine(hlLine);
				}
				for (const codeLine of tokenText.slice(lineEnd + 1).split("\n")) {
					addBodyLine(this.#theme.codeBlock(codeLine));
				}
				return bodyLines;
			}
		}

		for (const codeLine of tokenText.split("\n")) {
			addBodyLine(this.#theme.codeBlock(codeLine));
		}
		return bodyLines;
	}

	#codeTokenHasClosingFence(token: Token): boolean {
		const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
		const firstLineEnd = raw.indexOf("\n");
		if (firstLineEnd < 0) return false;
		const openingLine = raw.slice(0, firstLineEnd);
		const openingTrimmed = openingLine.trimStart();
		const openingIndent = openingLine.length - openingTrimmed.length;
		if (openingIndent > 3) return false;
		const fenceChar = openingTrimmed.charAt(0);
		if (fenceChar !== "`" && fenceChar !== "~") return false;
		let fenceLength = 0;
		while (openingTrimmed.charAt(fenceLength) === fenceChar) fenceLength++;
		if (fenceLength < 3) return false;

		let lineStart = firstLineEnd + 1;
		while (lineStart <= raw.length) {
			const lineEnd = raw.indexOf("\n", lineStart);
			const line = lineEnd >= 0 ? raw.slice(lineStart, lineEnd) : raw.slice(lineStart);
			const trimmed = line.trimStart();
			const indent = line.length - trimmed.length;
			let closingLength = 0;
			while (trimmed.charAt(closingLength) === fenceChar) closingLength++;
			if (indent <= 3 && closingLength >= fenceLength && trimmed.slice(closingLength).trim().length === 0) {
				return true;
			}
			if (lineEnd < 0) break;
			lineStart = lineEnd + 1;
		}
		return false;
	}

	/**
	 * Highlight the completed (newline-terminated) prefix `tokenText[0,
	 * completedEnd)` of a streaming code fence. Uses a stateful per-fence
	 * highlight stream so each render pushes only the newly completed lines,
	 * with output byte-identical to the whole-block `highlightCode` the
	 * finalized render performs. Returns null when no stream is available for
	 * `lang` (caller falls back to plain code-block styling).
	 */
	#highlightStreamingLines(
		tokenText: string,
		completedEnd: number,
		lang: string | undefined,
	): readonly string[] | null {
		const signature = this.#activeRenderSignature;
		const cache = this.#streamingHighlightCache;
		// Cheap cursor/length and signature gates first; the prefix compare
		// (the only O(fence) check, needed because a different fence can reach
		// this cache) runs last.
		if (
			signature &&
			cache &&
			cache.text.length <= completedEnd &&
			(cache.text.length === completedEnd || tokenText.charCodeAt(cache.text.length) === 0x0a) &&
			cache.lang === lang &&
			cache.width === signature.width &&
			cache.paddingX === signature.paddingX &&
			cache.paddingY === signature.paddingY &&
			cache.codeBlockIndent === signature.codeBlockIndent &&
			cache.literalMath === signature.literalMath &&
			cache.themeId === signature.themeId &&
			cache.defaultTextStyleId === signature.defaultTextStyleId &&
			cache.imageProtocol === signature.imageProtocol &&
			cache.hyperlinks === signature.hyperlinks &&
			cache.textSizing === signature.textSizing &&
			cache.bgColorProbe === signature.bgColorProbe &&
			cache.headingProbe === signature.headingProbe &&
			tokenText.startsWith(cache.text)
		) {
			const cachedEnd = cache.text.length;
			if (cachedEnd === completedEnd) return cache.lines;
			// Invariant: the stream has consumed `cache.text + "\n"`, so pushing
			// the added lines with a trailing newline advances it to
			// `completed + "\n"` — every fed line stays newline-terminated. The
			// signature gates above matched, so advancing the cache in place is
			// equivalent to rebuilding it, minus the whole-array copy per frame.
			const pushed = cache.stream.push(`${tokenText.slice(cachedEnd + 1, completedEnd)}\n`);
			appendLines(cache.lines, splitPushedHighlightLines(pushed));
			cache.text = tokenText.slice(0, completedEnd);
			return cache.lines;
		}

		const completedText = tokenText.slice(0, completedEnd);
		const stream = this.#createHighlightStream(lang);
		if (!stream) return null;
		const lines = splitPushedHighlightLines(stream.push(`${completedText}\n`));
		if (signature) {
			this.#streamingHighlightCache = { ...signature, lang, text: completedText, lines, stream };
		}
		return lines;
	}

	/**
	 * Resolve a highlight stream for `lang`. Prefers the theme's stateful
	 * factory; without one, emulates a stream via per-line `highlightCode` for
	 * diff-family fences only — that grammar is line-local, so per-line output
	 * matches the whole-block render (other grammars carry cross-line state
	 * and would diverge).
	 */
	#createHighlightStream(lang: string | undefined): HighlightStreamSession | null {
		const factory = this.#theme.createHighlightStream;
		if (factory) {
			try {
				return factory(lang);
			} catch {
				// Render must not throw: a broken theme factory (stale natives
				// `HighlightStream`, napi error) falls through to the unhighlighted
				// path / diff-family per-line emulation below.
			}
		}
		const highlightCode = this.#theme.highlightCode;
		if (!highlightCode) return null;
		const normalizedLang = lang?.toLowerCase();
		if (normalizedLang !== "diff" && normalizedLang !== "patch" && normalizedLang !== "udiff") return null;
		return {
			push: chunk => {
				const lines = chunk.split("\n");
				const trailing = lines.pop() ?? "";
				let out = "";
				for (const line of lines) out += `${highlightCode(line, lang).join("\n")}\n`;
				return trailing ? out + highlightCode(trailing, lang).join("\n") : out;
			},
		};
	}

	#renderEmptyPaddingLines(signature: RenderSignature): string[] {
		const emptyLine = padding(signature.width);
		const emptyLines: string[] = [];
		const bgFn = this.#defaultTextStyle?.bgColor;
		for (let i = 0; i < signature.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, signature.width, bgFn) : emptyLine;
			emptyLines.push(line);
		}
		return emptyLines;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	#applyDefaultStyle(text: string): string {
		if (!this.#defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.#theme
		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		return styled;
	}

	#getDefaultStylePrefix(): string {
		if (!this.#defaultTextStyle) {
			return "";
		}

		if (this.#defaultStylePrefix !== undefined) {
			return this.#defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.#defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.#defaultStylePrefix;
	}

	#getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	#getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.#applyDefaultStyle(text),
			stylePrefix: this.#getDefaultStylePrefix(),
		};
	}

	#quoteStyle(text: string): string {
		return this.#theme.quote(this.#theme.italic(text));
	}

	#getQuoteStylePrefix(): string {
		return this.#getStylePrefix(text => this.#quoteStyle(text));
	}

	#renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): RenderedLine[] {
		const lines: RenderedLine[] = [];

		// Display math block (own-line `$$…$$` / `\[…\]`): stack `\frac` vertically
		// and keep `\\` row breaks, so fractions and matrices span multiple lines.
		if (isMathToken(token)) {
			for (const mathLine of latexToBlock(token.text)) lines.push(renderedLine(this.#applyDefaultStyle(mathLine)));
			if (nextTokenType && nextTokenType !== "space") lines.push(renderedLine(""));
			return lines;
		}

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;
				const headingText = this.#renderInlineTokens(token.tokens || [], styleContext);
				const headingPlainText = plainInlineTokens(token.tokens || []);
				let styledHeading: string;
				if (headingLevel === 1 && TERMINAL.textSizing) {
					const plainWidth = visibleWidth(headingPlainText);
					if (plainWidth > 0 && 2 * plainWidth <= width) {
						const sizedHeading = encodeTextSizedHeading(headingPlainText, 2);
						lines.push(renderedLine(this.#theme.heading(this.#theme.bold(this.#theme.underline(sizedHeading)))));
						lines.push(renderedLine("")); // reserve the heading's second visual row
						if (nextTokenType && nextTokenType !== "space") {
							lines.push(renderedLine("")); // Add spacing after headings (unless space token follows)
						}
						break;
					}
				}
				if (headingLevel === 1) {
					styledHeading = this.#theme.heading(this.#theme.bold(this.#theme.underline(headingText)));
				} else if (headingLevel === 2) {
					styledHeading = this.#theme.heading(this.#theme.bold(headingText));
				} else {
					styledHeading = this.#theme.heading(this.#theme.bold(headingPrefix + headingText));
				}
				lines.push(renderedLine(styledHeading));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(renderedLine("")); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					for (const mathLine of latexToBlock(displayMath.text))
						lines.push(renderedLine(this.#applyDefaultStyle(mathLine)));
					if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") lines.push(renderedLine(""));
					break;
				}
				const paragraphText = this.#renderInlineTokens(token.tokens || [], styleContext);
				for (const paragraphLine of hangWrapTreeGuideLines(paragraphText, width) ?? [paragraphText]) {
					lines.push(renderedLine(paragraphLine));
				}
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push(renderedLine(""));
				}
				break;
			}

			case "code": {
				// Mermaid diagrams render as ASCII art when the theme supplies a
				// resolver. The art is preformatted, so clip each row to the content
				// width: the later wrap pass would otherwise fragment the box-drawing
				// canvas. truncateToWidth is ANSI- and wide-char-aware, and the
				// resolver picks the shortest orientation that fits this width.
				if (token.lang === "mermaid" && this.#theme.resolveMermaidAscii) {
					const ascii = this.#theme.resolveMermaidAscii(token.text, width);
					if (ascii) {
						for (const asciiLine of ascii.split("\n")) {
							lines.push(
								renderedLine(
									visibleWidth(asciiLine) > width
										? truncateToWidth(asciiLine, width, Ellipsis.Omit)
										: asciiLine,
								),
							);
						}
						if (nextTokenType && nextTokenType !== "space") {
							lines.push(renderedLine(""));
						}
						break;
					}
				}

				const codeIndent = padding(this.#codeBlockIndent);
				lines.push(renderedLine(this.#theme.codeBlockBorder(`\`\`\`${token.lang || ""}`)));
				for (const bodyLine of this.#renderCodeBodyLines(token, codeIndent)) {
					lines.push(bodyLine);
				}
				lines.push(renderedLine(this.#theme.codeBlockBorder("```")));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(renderedLine("")); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.#renderList(token as ListToken, 0, width, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.#renderTable(token as TableToken, width, nextTokenType, styleContext);
				for (const tableLine of tableLines) lines.push(renderedLine(tableLine));
				break;
			}

			case "blockquote": {
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: this.#getQuoteStylePrefix(),
				};
				const quoteContentWidth = Math.max(1, width - 2);
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: RenderedLine[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					const quoteTokenLines = this.#renderToken(
						quoteToken,
						quoteContentWidth,
						nextQuoteToken?.type,
						quoteInlineStyleContext,
					);
					renderedQuoteLines.push(...quoteTokenLines);
				}

				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1]!.text === "") {
					renderedQuoteLines.pop();
				}

				const borderedQuoteLines = this.#applyQuoteBorder(renderedQuoteLines, width);
				lines.push(...borderedQuoteLines);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(renderedLine("")); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr": {
				const raw = "raw" in token && typeof token.raw === "string" ? token.raw.trim() : "";
				lines.push(renderedLine(this.#renderHrLine(width, raw[0] || "")));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(renderedLine("")); // Add spacing after horizontal rules (unless space token follows)
				}
				break;
			}

			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(...this.#renderHtmlBlock(token.raw, width));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push(renderedLine(""));
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(renderedLine(token.text));
				}
		}

		return lines;
	}

	/** Render a horizontal rule line themed to `width`, matching `sourceChar` when given. */
	#renderHrLine(width: number, sourceChar = ""): string {
		const fillChar = getHrChar(sourceChar, this.#symbols.hrChar);
		return this.#theme.hr(fillChar.repeat(Math.min(width, 80)));
	}

	/**
	 * Wrap already-rendered lines in the blockquote border and quote styling.
	 * `width` is the full content width; the border reserves two cells.
	 */
	#applyQuoteBorder(renderedLines: RenderedLine[], width: number): RenderedLine[] {
		const quoteStylePrefix = this.#getQuoteStylePrefix();
		const applyQuoteStyle = (line: string): string => {
			if (!quoteStylePrefix) {
				return this.#quoteStyle(line);
			}
			const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
			return this.#quoteStyle(lineWithReappliedStyle);
		};
		const quoteContentWidth = Math.max(1, width - 2);
		const lines: RenderedLine[] = [];
		for (const quoteLine of renderedLines) {
			if (quoteLine.literalCode) {
				const wrappedLiteralRows = wrapTextWithAnsi(quoteLine.text, quoteContentWidth);
				if (wrappedLiteralRows.length === 0) {
					lines.push(renderedLine("", true));
				} else {
					for (const wrappedLine of wrappedLiteralRows) {
						lines.push(renderedLine(wrappedLine, true));
					}
				}
			} else {
				const styledLine = applyQuoteStyle(quoteLine.text);
				for (const wrappedLine of wrapTextWithAnsi(styledLine, quoteContentWidth)) {
					lines.push(renderedLine(this.#theme.quoteBorder(`${this.#symbols.quoteBorder} `) + wrappedLine));
				}
			}
		}
		return lines;
	}

	/**
	 * Render a block-level `html` token to styled lines. Standalone `<hr>` tags
	 * become rules and balanced `<blockquote>…</blockquote>` regions render with
	 * quote styling; the remaining markup is normalized to terminal text (entities
	 * decoded, `<code>` themed, lists/`<br>`/`<p>` laid out).
	 */
	#renderHtmlBlock(raw: string, width: number): RenderedLine[] {
		const lines: RenderedLine[] = [];
		const state = createHtmlNormalizationState();
		const codeHook = (text: string): string => this.#theme.code(text) + this.#getDefaultStylePrefix();
		const flushText = (chunk: string): void => {
			const cleaned = normalizeHtmlForTerminal(chunk, state, codeHook);
			if (cleaned.trim() === "") return;
			for (const line of splitTerminalLines(cleaned)) {
				const trimmed = line.trimEnd();
				lines.push(renderedLine(trimmed.trim() === "" ? "" : this.#applyDefaultStyle(trimmed)));
			}
		};
		let lastIndex = 0;
		BLOCK_HTML_REGEX.lastIndex = 0;
		for (let match = BLOCK_HTML_REGEX.exec(raw); match !== null; match = BLOCK_HTML_REGEX.exec(raw)) {
			flushText(raw.slice(lastIndex, match.index));
			lastIndex = match.index + match[0].length;
			if (match[1] !== undefined) {
				lines.push(...this.#renderHtmlBlockquote(match[1], width));
			} else {
				lines.push(renderedLine(this.#renderHrLine(width)));
			}
		}
		flushText(raw.slice(lastIndex));
		return lines;
	}

	/** Render the inner content of an HTML `<blockquote>` with quote styling. */
	#renderHtmlBlockquote(inner: string, width: number): RenderedLine[] {
		const quoteStylePrefix = this.#getQuoteStylePrefix();
		const cleaned = normalizeHtmlForTerminal(
			inner,
			createHtmlNormalizationState(),
			text => this.#theme.code(text) + quoteStylePrefix,
		);
		const innerLines = splitTerminalLines(cleaned).map(line => renderedLine(line.trimEnd()));
		while (innerLines.length > 0 && innerLines[innerLines.length - 1].text === "") innerLines.pop();
		return this.#applyQuoteBorder(innerLines, width);
	}

	#renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.#getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => (segment === "" ? "" : applyText(segment))).join("\n");
		};
		const swatchGlyph = this.#symbols.colorSwatch || DEFAULT_COLOR_SWATCH_GLYPH;
		// Set by a line break: the next line's own leading whitespace is dropped.
		// Every token consumes it, so the space after a styled span that starts
		// the line stays; a token that renders nothing passes it on.
		let trimLeadingWhitespace = false;
		const htmlState = createHtmlNormalizationState();
		const markHtmlItemWhenContent = (text: string): void => {
			markCurrentHtmlItemContent(htmlState, text);
		};

		for (const token of collapseInlineHtml(tokens)) {
			const lineStart: boolean = trimLeadingWhitespace;
			trimLeadingWhitespace = false;
			if (isMathToken(token)) {
				markHtmlItemWhenContent(token.text);
				result += applyTextWithNewlines(renderMathToken(token.text));
				continue;
			}
			switch (token.type) {
				case "text": {
					const rawText = lineStart ? token.text.replace(/^\s+/, "") : token.text;
					const text = normalizeHtmlEntitiesForTerminal(rawText);
					markHtmlItemWhenContent(text);
					if (token.tokens) markHtmlItemWhenContent(plainInlineTokens(token.tokens));
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.#renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += renderTextWithSwatches(text, applyTextWithNewlines, swatchGlyph);
					}
					break;
				}

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					result += this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					const boldContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.#theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					result += this.#theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan": {
					markHtmlItemWhenContent(token.text);
					const painted = codespanSwatch(token.text, swatchGlyph);
					result += (painted || this.#theme.code(token.text)) + stylePrefix;
					break;
				}

				case "link": {
					markHtmlItemWhenContent(token.text);
					const linkText = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLinkText = this.#theme.link(this.#theme.underline(linkText));
					const href = typeof token.href === "string" ? token.href : "";
					const target = (href && this.#theme.resolveLink?.(href)) || href;
					const clickableLinkText = formatHyperlink(styledLinkText, target);
					// If link text matches href, only show the link once. A missing
					// href (malformed/partial link token) renders as plain link text
					// instead of crashing the renderer or emitting an empty "()"
					// (issue #10283).
					// Compare raw text (token.text) not styled text (linkText) since linkText has ANSI codes
					// For mailto: links, strip the prefix before comparing (autolinked emails have
					// text="foo@bar.com" but href="mailto:foo@bar.com")
					const hrefForComparison = href.startsWith("mailto:") ? href.slice(7) : href;
					if (!href || token.text === href || token.text === hrefForComparison)
						result += clickableLinkText + stylePrefix;
					else {
						const styledLinkUrl = this.#theme.linkUrl(`(${href})`);
						result += `${clickableLinkText} ${formatHyperlink(styledLinkUrl, target)}${stylePrefix}`;
					}
					break;
				}

				case "br":
					result += "\n";
					trimLeadingWhitespace = true;
					break;

				case "del": {
					const delContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					result += this.#theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					if ("raw" in token && typeof token.raw === "string") {
						const cleaned = normalizeHtmlForTerminal(token.raw, htmlState);
						result += applyTextWithNewlines(cleaned);
						if (cleaned.endsWith("\n")) {
							trimLeadingWhitespace = true;
						} else if (cleaned.length === 0) {
							trimLeadingWhitespace = lineStart;
						}
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						const rawText = lineStart ? token.text.replace(/^\s+/, "") : token.text;
						const text = normalizeHtmlEntitiesForTerminal(rawText);
						markHtmlItemWhenContent(text);
						result += applyTextWithNewlines(text);
					} else {
						trimLeadingWhitespace = lineStart;
					}
			}
		}

		// Strip dangling re-opened-default SGR prefix left over from the last inline
		// token (strong/em/codespan/link/del/etc.) so the emitted line self-terminates
		// at its last styled segment instead of carrying an unmatched SGR open into
		// the next line. Matches upstream behavior.
		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	/**
	 * Render a list with proper nesting support
	 */
	#renderList(token: ListToken, depth: number, width: number, styleContext?: InlineStyleContext): RenderedLine[] {
		const lines: RenderedLine[] = [];
		const indent = "  ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = token.start ?? 1;
		const pushWrapped = (line: RenderedLine, firstPrefix: string, continuationPrefix: string): void => {
			if (line.literalCode) {
				const wrappedLiteralRows = wrapTextWithAnsi(line.text, Math.max(1, width));
				if (wrappedLiteralRows.length === 0) {
					lines.push(renderedLine("", true));
				} else {
					for (const wrappedLine of wrappedLiteralRows) {
						lines.push(renderedLine(wrappedLine, true));
					}
				}
				return;
			}

			const prefixWidth = visibleWidth(firstPrefix);
			if (prefixWidth >= width) {
				lines.push(renderedLine(truncateToWidth(firstPrefix, width, Ellipsis.Omit)));
				for (const wrappedLine of wrapTextWithAnsi(line.text, Math.max(1, width))) {
					lines.push(renderedLine(wrappedLine));
				}
				return;
			}
			const bodyWidth = width - prefixWidth;
			const wrapped = wrapTextWithAnsi(line.text, bodyWidth);
			if (wrapped.length === 0) {
				lines.push(renderedLine(firstPrefix));
				return;
			}
			lines.push(renderedLine(firstPrefix + wrapped[0]));
			for (let lineIndex = 1; lineIndex < wrapped.length; lineIndex++) {
				lines.push(renderedLine(continuationPrefix + wrapped[lineIndex]));
			}
		};

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
			const firstPrefix = indent + this.#theme.listBullet(bullet);
			// Continuation rows align under the item text, so the hang matches the
			// actual bullet width (`10. ` is 4 cells, not 2).
			const continuationIndent = indent + padding(visibleWidth(bullet));

			// Process item tokens; nested-list lines arrive structurally tagged and
			// already carry their own full indent.
			const itemLines = this.#renderListItem(item.tokens || [], depth, width, styleContext);

			if (itemLines.length > 0) {
				const firstLine = itemLines[0]!;
				if (firstLine.nested) {
					lines.push(firstLine);
				} else {
					pushWrapped(firstLine, firstPrefix, continuationIndent);
				}

				for (let j = 1; j < itemLines.length; j++) {
					const line = itemLines[j]!;
					if (line.nested) {
						lines.push(line);
					} else {
						pushWrapped(line, continuationIndent, continuationIndent);
					}
				}
			} else {
				lines.push(renderedLine(firstPrefix));
			}
		}

		return lines;
	}

	/**
	 * Render list item tokens, handling nested lists.
	 * Returns lines WITHOUT the parent indent (renderList adds it); lines that
	 * belong to a nested list are tagged `nested` so the caller never has to
	 * sniff theme-dependent ANSI bytes to recognize them.
	 */
	#renderListItem(
		tokens: Token[],
		parentDepth: number,
		width: number,
		styleContext?: InlineStyleContext,
	): RenderedListItemLine[] {
		const lines: RenderedListItemLine[] = [];

		for (const token of tokens) {
			if (token.type === "list") {
				// Nested list - render with one additional indent level
				// These lines carry their own indent, so tag them for pass-through
				const nestedLines = this.#renderList(token as ListToken, parentDepth + 1, width, styleContext);
				for (const nestedLine of nestedLines) {
					lines.push({ ...nestedLine, nested: true });
				}
			} else if (token.type === "text") {
				// Text content (may have inline tokens, or a sole display-math token)
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
					for (const mathLine of latexToBlock(displayMath.text))
						lines.push({ text: apply(mathLine), nested: false });
				} else {
					const text =
						token.tokens && token.tokens.length > 0
							? this.#renderInlineTokens(token.tokens, styleContext)
							: token.text || "";
					lines.push({ text, nested: false });
				}
			} else if (token.type === "paragraph") {
				// Paragraph in list item
				const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					for (const mathLine of latexToBlock(displayMath.text))
						lines.push({ text: apply(mathLine), nested: false });
				} else {
					lines.push({ text: this.#renderInlineTokens(token.tokens || [], styleContext), nested: false });
				}
			} else if (token.type === "code") {
				// Code block in list item
				const codeIndent = padding(this.#codeBlockIndent);
				lines.push({ text: this.#theme.codeBlockBorder(`\`\`\`${token.lang || ""}`), nested: false });
				for (const bodyLine of this.#renderCodeBodyLines(token, codeIndent)) {
					lines.push({ ...bodyLine, nested: false });
				}
				lines.push({ text: this.#theme.codeBlockBorder("```"), nested: false });
			} else if (isMathToken(token)) {
				// Display math block inside a list item: stack fractions / matrix rows.
				const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
				for (const mathLine of latexToBlock(token.text)) lines.push({ text: apply(mathLine), nested: false });
			} else {
				// Other token types - try to render as inline
				const text = this.#renderInlineTokens([token], styleContext);
				if (text) {
					lines.push({ text, nested: false });
				}
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	#getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter(word => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	#terminalLineWidths(text: string): number[] {
		return splitTerminalLines(text).map(line => visibleWidth(line));
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	#wrapCellText(text: string, maxWidth: number): string[] {
		const cellWidth = Math.max(1, maxWidth);
		// Wrap the whole cell in one call so wrapTextWithAnsi() balances OSC 8
		// hyperlink state across explicit newlines (e.g. `<br>` rendered as \n);
		// per-fragment wrapping would drop the reopened link on later rows.
		const wrapped = wrapTextWithAnsi(text, cellWidth);
		while (wrapped.length > 1 && wrapped[wrapped.length - 1] === "") {
			wrapped.pop();
		}
		// The native wrap deliberately leaves fg color and bold/italic open at
		// line ends so continuation lines can re-open them. Table rows splice
		// every cell line between unstyled border glyphs, so an open style
		// (e.g. mdCode) would bleed into the "│" and the following cells.
		// Terminate each line at default fg, clearing bold/italic but keeping
		// any ambient background (message-bg rendering) intact.
		return wrapped.map(line => `${line}\x1b[22m\x1b[23m\x1b[39m`);
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	#renderTable(
		token: TableToken,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.#renderInlineTokens(token.header[i].tokens || [], styleContext);
			const headerLineWidths = this.#terminalLineWidths(headerText);
			naturalWidths[i] = Math.max(...headerLineWidths, 0);
			minWordWidths[i] = Math.max(1, this.#getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.#renderInlineTokens(row[i].tokens || [], styleContext);
				const cellLineWidths = this.#terminalLineWidths(cellText);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, ...cellLineWidths);
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.#getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			// oxlint-disable-next-line unicorn/no-new-array -- column-width allocation
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map(width => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		const t = this.#symbols.table;
		const h = t.horizontal;
		const v = t.vertical;

		// Render top border
		const topBorderCells = columnWidths.map(w => h.repeat(w));
		lines.push(`${t.topLeft}${h}${topBorderCells.join(`${h}${t.teeDown}${h}`)}${h}${t.topRight}`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.#renderInlineTokens(cell.tokens || [], styleContext);
			return this.#wrapCellText(text, columnWidths[i]);
		});
		const headerLineCount = Math.max(...headerCellLines.map(c => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + padding(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.#theme.bold(padded);
			});
			lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
		}

		// Render separator
		const separatorCells = columnWidths.map(w => h.repeat(w));
		const separatorLine = `${t.teeRight}${h}${separatorCells.join(`${h}${t.cross}${h}`)}${h}${t.teeLeft}`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.#renderInlineTokens(cell.tokens || [], styleContext);
				return this.#wrapCellText(text, columnWidths[i]);
			});
			const rowLineCount = Math.max(...rowCellLines.map(c => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + padding(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map(w => h.repeat(w));
		const bottomBorder = `${t.bottomLeft}${h}${bottomBorderCells.join(`${h}${t.teeUp}${h}`)}${h}${t.bottomRight}`;
		lines.push(bottomBorder);
		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}

/**
 * Render inline markdown (bold, italic, code, links, strikethrough) to a styled string.
 * Unlike the full Markdown component, this produces a single line with no block-level elements.
 */
export function renderInlineMarkdown(text: string, mdTheme: MarkdownTheme, baseColor?: (t: string) => string): string {
	// Guard against undefined/null during streaming — partial JSON can leave fields unpopulated.
	if (typeof text !== "string") return (baseColor ?? (t => t))(text != null ? String(text) : "");
	const tokens = markdownParser.lexer(normalizeOsc8Terminators(text));
	const applyText = baseColor ?? ((t: string) => t);
	let result = "";
	for (const token of tokens) {
		if (isMathToken(token)) {
			result += applyText(renderMathToken(token.text));
			continue;
		}
		if (token.type === "paragraph" && token.tokens) {
			result += renderInlineTokens(token.tokens, mdTheme, applyText);
		} else if (token.type === "list") {
			result += token.items
				.map((item: Tokens.ListItem, index: number) => {
					const prefix = token.ordered ? `${(token.start || 1) + index}. ` : "• ";
					const content = item.tokens ? renderInlineTokens(item.tokens, mdTheme, applyText) : applyText(item.text);
					return `${applyText(prefix)}${content}`;
				})
				.join(applyText(" "));
		} else if ("text" in token && typeof token.text === "string") {
			result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
		}
	}
	return result;
}

function renderInlineTokens(tokens: Token[], mdTheme: MarkdownTheme, applyText: (t: string) => string): string {
	let result = "";
	const styleReset = applyText("");
	for (const token of collapseInlineHtml(tokens)) {
		if (isMathToken(token)) {
			result += applyText(renderMathToken(token.text));
			continue;
		}
		switch (token.type) {
			case "text":
				if (token.tokens && token.tokens.length > 0) {
					result += renderInlineTokens(token.tokens, mdTheme, applyText);
				} else {
					result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
				}
				break;
			case "strong":
				result += mdTheme.bold(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "em":
				result += mdTheme.italic(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "codespan":
				result += mdTheme.code(token.text) + styleReset;
				break;
			case "del":
				result += mdTheme.strikethrough(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "link": {
				const linkText = renderInlineTokens(token.tokens || [], mdTheme, applyText);
				result += mdTheme.link(mdTheme.underline(linkText)) + styleReset;
				break;
			}
			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					result += applyText(normalizeHtmlForTerminal(token.raw));
				}
				break;
			default:
				if ("text" in token && typeof token.text === "string") {
					result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
				}
				break;
		}
	}
	return result;
}
