import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import {
	Lexer,
	Marked,
	type Token,
	Tokenizer,
	type TokenizerAndRendererExtension,
	type Tokens,
} from "@oh-my-pi/pi-utils/marked";
import { mathBlockAt, mathSpanAt, mathStartIndex } from "@oh-my-pi/pi-utils/math-delimiters";
import { latexToBlock } from "../latex-block";
import { isBareMathEnvironment, latexToUnicode } from "../latex-to-unicode";
import type { SymbolTheme } from "../symbols";
import { TERMINAL } from "../terminal-capabilities";
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

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

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
			} catch (_) {
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

		const isClosing = /^<\//.test(tag);
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

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

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
	start: mathStartIndex,
	tokenizer(src) {
		const span = mathSpanAt(src, 0);
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
	const beginLineStart = bm.index === 0 ? 0 : bm.index + 1; // skip the matched leading `\n`
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
// Case-insensitive scheme scan replacing /www\.|https?:\/\/|ftp:\/\//i in
// boundedAutolinkExtension.start — like `mathStartIndex`, this runs on the
// remaining source at every inline position (part of a ~4.3% CPU start() scan
// tail in profiles). charCode-only: no allocation, no toLowerCase copies.
// `| 32` lower-cases ASCII letters; `.`/`:`/`/` are compared exactly, matching
// the regex's ASCII-only `i` semantics. charCodeAt past the end returns NaN,
// which fails every comparison, so no explicit bounds checks are needed.
function isAutolinkSchemeAt(src: string, i: number): boolean {
	const c = src.charCodeAt(i) | 32;
	if (c === 119 /* w */) {
		// www.
		return (
			(src.charCodeAt(i + 1) | 32) === 119 &&
			(src.charCodeAt(i + 2) | 32) === 119 &&
			src.charCodeAt(i + 3) === 46 /* . */
		);
	}
	if (c === 104 /* h */) {
		// http:// | https://
		if (
			(src.charCodeAt(i + 1) | 32) !== 116 /* t */ ||
			(src.charCodeAt(i + 2) | 32) !== 116 /* t */ ||
			(src.charCodeAt(i + 3) | 32) !== 112 /* p */
		) {
			return false;
		}
		let j = i + 4;
		if ((src.charCodeAt(j) | 32) === 115 /* s */) j++;
		return src.charCodeAt(j) === 58 /* : */ && src.charCodeAt(j + 1) === 47 /* / */ && src.charCodeAt(j + 2) === 47;
	}
	if (c === 102 /* f */) {
		// ftp://
		return (
			(src.charCodeAt(i + 1) | 32) === 116 /* t */ &&
			(src.charCodeAt(i + 2) | 32) === 112 /* p */ &&
			src.charCodeAt(i + 3) === 58 /* : */ &&
			src.charCodeAt(i + 4) === 47 /* / */ &&
			src.charCodeAt(i + 5) === 47 /* / */
		);
	}
	return false;
}

/** @internal exported for tests — must stay index-identical to the old regex scan. */
export function autolinkSchemeScanIndex(src: string): number | undefined {
	for (let i = 0; i < src.length; i++) {
		const c = src.charCodeAt(i) | 32;
		if ((c === 119 || c === 104 || c === 102) && isAutolinkSchemeAt(src, i)) return i;
	}
	return undefined;
}
const VALID_AUTOLINK_LEFT_BOUNDARY = /[\s*_~(]/;
const boundedAutolinkExtension: TokenizerAndRendererExtension = {
	name: "boundedAutolink",
	level: "inline",
	start(src) {
		return autolinkSchemeScanIndex(src);
	},
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
	extensions: [customHrExtension, mathBlockExtension, mathEnvBlockExtension, mathExtension, boundedAutolinkExtension],
});

// ---------------------------------------------------------------------------
// GFM `url` tokenizer gate
// ---------------------------------------------------------------------------
// marked tries the bundled GFM `url` tokenizer at every inline tokenization
// step, and its regex is expensive to FAIL: the email alternative
// `^[A-Za-z0-9._+-]+(@)…` linearly consumes an identifier run, then backtracks
// it one character at a time when no `@` follows. A 71414-sample / 1ms CPU
// profile of the TUI put 73.3% of total CPU (74.9s of a 102s capture) inside
// this single regex. The override below runs an O(bounded) charCode gate first
// and only falls through to the built-in tokenizer — by returning `false`,
// marked's tokenizer-override fallback contract — when a match is possible.
//
// Conservativeness argument. The built-in rule (no flags) is
//   /^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*
//    |^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/
// Both alternatives are anchored, so any match constrains the head of src:
//  • Branch 1 requires src to start with `http://`, `https://`, `ftp://`
//    (scheme letters in any case) or lowercase `www.`. The gate accepts all of
//    these via isAutolinkSchemeAt(src, 0); it also over-accepts `WWW.`, a
//    harmless false positive (the built-in regex simply fails to match).
//  • Branch 2 requires src to start with one-or-more chars from
//    `[A-Za-z0-9._+-]` immediately followed by `@`. The gate scans that exact
//    class: if the run ends within URL_GATE_EMAIL_SCAN_LIMIT chars it accepts
//    iff the terminator is `@`; a run reaching the limit is accepted
//    unconditionally. Every src branch 2 can match is therefore accepted —
//    the gate never rejects a src the built-in regex would match.
const URL_GATE_EMAIL_SCAN_LIMIT = 320;

/** @internal exported for tests — must never return false for a src the built-in url regex matches. */
export function urlTokenPossible(src: string): boolean {
	if (isAutolinkSchemeAt(src, 0)) return true;
	let i = 0;
	while (i < URL_GATE_EMAIL_SCAN_LIMIT) {
		const c = src.charCodeAt(i);
		const isLocalChar =
			(c >= 97 && c <= 122) /* a-z */ ||
			(c >= 65 && c <= 90) /* A-Z */ ||
			(c >= 48 && c <= 57) /* 0-9 */ ||
			c === 46 /* . */ ||
			c === 95 /* _ */ ||
			c === 43 /* + */ ||
			c === 45; /* - */
		if (!isLocalChar) break;
		i++;
	}
	if (i === 0) return false;
	if (i >= URL_GATE_EMAIL_SCAN_LIMIT) return true; // over-long run: give up conservatively
	return src.charCodeAt(i) === 64 /* @ */;
}

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

markdownParser.use({
	tokenizer: {
		// `false` → marked falls back to the built-in tokenizer;
		// `undefined` → no token here, built-in never runs.
		url(src: string): Tokens.Link | undefined | false {
			return urlTokenPossible(src) ? false : undefined;
		},
		lheading(src: string): Tokens.Heading | undefined | false {
			return lheadingPossible(src) ? false : undefined;
		},
	},
});

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
const RENDER_CACHE_MAX_ENTRY_SIZE = 256 * 1024;
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
	sizeCalculation: renderedLinesCacheSize,
});

function renderedLinesCacheSize(lines: readonly string[]): number {
	let size = lines.length;
	for (let i = 0; i < lines.length; i++) size += lines[i]!.length;
	return Math.max(1, size);
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

// Disarm when the captured row's RAW tail ends in trailing whitespace (wrap
// trims it; appending a char moves the trim boundary), a trailing backslash
// (it can become an escape once the delta supplies the next char — the `\\`
// clause covers that escape-completion hazard), or a full/partial hex swatch
// run (a `#` + 3-8 hex is a swatch glyph; the byte range may shift).
const FAST_RUN_END_RE = /(?:[ \t\\]|#[0-9a-fA-F]{3,8}|#+)$/i;

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
// when the grown line starts one (ref-def grammar: REF_DEF_LINE_RE).
const FAST_LINE_START_HAZARD_RE =
	// `-` is placed LAST so it is a literal, not a range bound. The other
	// chars are in ASCENDING code-point order (no reversed ranges that
	// rely on engine leniency): * + = – — ─ ━ ═ then the literal `-`.
	/^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|\d{1,9}[.)](?:[ \t]|$)|[*+=–—─━═-](?:[ \t]|$)|(?:[*+=–—─━═-][ \t]*){2,}[ \t]*$)/;
/** @internal exported for tests — counts fast-tail splice frames. A future
 *  regression that silently disarms the fast path (e.g. an over-broad gate)
 *  leaves byte-identity intact but drops the counter to zero. */
export let fastTailSplices = 0;
/** @internal exported for tests — resets the splice counter. */
export function resetFastTailSplices(): void {
	fastTailSplices = 0;
}

/** @internal exported for tests — the grown-line-start block-kind gate. */
export function fastLineStartHazard(grownLine: string): boolean {
	return FAST_LINE_START_HAZARD_RE.test(grownLine) || REF_DEF_LINE_RE.test(grownLine);
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
function lexInlineTokens(text: string): Token[] {
	return new Lexer(markdownParser.defaults).inlineTokens(text);
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
	return after === 0x20 /* space */ || after === 0x09 /* tab */ || after === 0x0a /* \n */;
}

const NO_BLOCK_BOUNDARY = { end: 0, count: 0 } as const;

/**
 * Offset just past the last token in `tokens` that closes a block on a hard
 * `"\n\n"` break, together with the number of tokens up to and including it.
 * `count === 0` means the run holds no usable boundary.
 *
 * `base` is where `tokens[0]` starts inside `text`. A boundary qualifies only
 * when splitting there is invisible to the lexer, i.e. `lex(head) ++ lex(tail)
 * === lex(text)`:
 *  - The break must sit inside `text`. At end-of-text the next character is
 *    unknown (and, while streaming, may still arrive), so the cut is deferred.
 *  - The next character must start real block content. Whitespace means the
 *    block separator straddles the cut — e.g. a fence followed by
 *    `"\n\n\n- list"` — and the two lexes desync.
 *  - A preceding `list` must be provably closed: CommonMark lets a same-marker
 *    item continue the list across the blank line, and marked merges both into
 *    one renumbered loose list (`listMayContinueAt`).
 *
 * `startIndex` resumes the scan at `tokens[startIndex]` (positions still
 * accumulate from `base`). The streaming freeze passes the frozen-prefix
 * token count: that prefix's boundary is permanent under append-only growth
 * (re-verified when frozen), so only the mutable tail can hold a new one.
 */
function stableBlockBoundary(
	text: string,
	base: number,
	tokens: Token[],
	startIndex = 0,
): { end: number; count: number } {
	let pos = base;
	let end = 0;
	let count = 0;
	for (let i = startIndex; i < tokens.length; i++) {
		const raw = tokens[i].raw;
		const tokenEnd = pos + raw.length;
		if (raw.endsWith("\n\n")) {
			const prev = i > 0 ? tokens[i - 1] : undefined;
			if (prev === undefined || prev.type !== "list" || !listMayContinueAt(text, tokenEnd, prev.raw)) {
				end = tokenEnd;
				count = i + 1;
			}
		}
		pos = tokenEnd;
	}
	if (count === 0 || end >= text.length) return NO_BLOCK_BOUNDARY;
	const next = text.charCodeAt(end);
	if (next === 0x20 /* space */ || next === 0x0a /* \n */) return NO_BLOCK_BOUNDARY;
	return { end, count };
}

// Bun's regex engine skips the start-anchor optimization for several of marked's
// block rules — `hr`, `lheading`, `table` and `html` are `^`-anchored
// alternations of quantified branches — so each failing `exec` rescans the whole
// remaining source instead of stopping at offset 0. Lexing is then quadratic in
// document length: an 800 KB message costs ~41 s under Bun where Node/V8 needs
// ~60 ms, and it runs on the render path, freezing the UI. Bounded windows keep
// every scan short and restore linear behavior (~0.7 s for that same message).
const LEX_WINDOW_BYTES = 2 * 1024;
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
 * holding no boundary doubles until it finds one or reaches the end. Probes
 * never run inline tokenization (their inlineQueue is discarded) — a boundary
 * is a property of block structure alone, and probe inline passes were the
 * dominant cost of an earlier revision. Block tokenization runs per window
 * while inline tokenization is deferred to the end — mirroring `Lexer.lex` —
 * so a `[label]: dest` definition anywhere in the document still resolves for
 * every inline span.
 *
 * A boundary requires some top-level token whose raw ends in `"\n\n"`, so a
 * window that contains no blank line cannot cut: each round starts at the next
 * `"\n\n"` (skipping straight to the end when there is none — e.g. a tail
 * that is one long tight list) instead of probing sizes that cannot succeed.
 */
function lexWindowed(text: string): Token[] {
	const lexer = new Lexer(markdownParser.defaults);
	let offset = 0;
	while (offset < text.length) {
		let segment = "";
		const nextBlank = text.indexOf("\n\n", offset);
		if (nextBlank === -1) {
			segment = text.slice(offset);
		} else {
			const minSize = Math.max(LEX_WINDOW_BYTES, nextBlank + 2 - offset);
			for (let size = minSize; segment.length === 0; size *= 2) {
				if (offset + size >= text.length) {
					segment = text.slice(offset);
					break;
				}
				const probe = new Lexer(markdownParser.defaults);
				probe.blockTokens(text.slice(offset, offset + size), probe.tokens);
				const boundary = stableBlockBoundary(text, offset, probe.tokens);
				if (boundary.count > 0) segment = text.slice(offset, boundary.end);
			}
		}
		lexer.blockTokens(segment, lexer.tokens);
		offset += segment.length;
	}
	for (const queued of lexer.inlineQueue) lexer.inlineTokens(queued.src, queued.tokens);
	lexer.inlineQueue = [];
	return lexer.tokens;
}

/** Lex a whole document, windowing anything large enough for the quadratic scan to bite. */
function lexDocument(text: string): Token[] {
	// A CR shifts every `raw` span (marked normalizes CRLF before tokenizing), so
	// window offsets would address the wrong characters — lex those in one pass.
	if (text.length < WINDOWED_LEX_MIN_BYTES || text.includes("\r")) return markdownParser.lexer(text);
	return lexWindowed(text);
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

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
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
	symbols: SymbolTheme;
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
	themeId: number;
	defaultTextStyleId: number;
	imageProtocol: string;
	hyperlinks: boolean;
	textSizing: boolean;
	bgColorProbe: string;
	headingProbe: string;
}

interface StreamPrefixLineCache extends RenderSignature {
	text: string;
	tokenCount: number;
	lines: readonly string[];
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
interface StreamingHighlightCache extends RenderSignature {
	lang: string | undefined;
	text: string;
	lines: readonly string[];
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
	#defaultStylePrefix?: string;
	/** Number of spaces used to indent code block content. */
	#codeBlockIndent: number;

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
	) {
		this.#text = normalizeOsc8Terminators(text);
		this.#oscPartialEscape = trailingOsc8Partial(this.#text);
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#theme = theme;
		this.#defaultTextStyle = defaultTextStyle;
		this.#codeBlockIndent = Math.max(0, Math.floor(codeBlockIndent));
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
			// reused — the checked region may have changed anywhere.
			this.#appendOnlySinceLastScan = false;
		}
		this.#text = text;
		if (!text.trim()) {
			// Blank replacement: render() early-returns before #lexTokens can see
			// the non-append edit, so drop the frozen stream state here or it
			// outlives the content it indexed.
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixLineCache = undefined;
			this.#tailRowCache = undefined;
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
	 * Width-independent source prefix of the last render ending at a frozen
	 * Markdown block boundary. Only meaningful while streaming (transient
	 * render cache on); grows monotonically under append-only `setText`.
	 */
	getLastRenderStableText(): string {
		return this.#transientRenderCache ? (this.#streamPrefixText ?? "") : "";
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
		this.invalidate();
	}

	// Lex `text` into block tokens, reusing the frozen stable prefix when the text
	// only grew (the streaming path). Falls back to a full lex whenever the prefix
	// is no longer a prefix (non-append edit), the text carries reference-link
	// definitions, or it contains CR (marked normalizes CRLF, which would desync
	// raw-span offsets). Every fallback is correctness-preserving — only speed
	// differs; the render loop sees the identical token list either way.
	#lexTokens(text: string): Token[] {
		// When a frozen prefix exists, it was already verified ref-def-free when
		// frozen (#freezeStablePrefix only runs when canStream was true). The prefix
		// ends at a "\n\n" block boundary (stableBlockBoundary), so the tail starts
		// at a fresh line — scanning only the tail for ref defs is sufficient and
		// avoids re-scanning the grown prefix every frame (O(n²) → O(n) overall).
		const prefix = this.#streamPrefixText;
		const prefixTokens = this.#streamPrefixTokens;
		const hasPrefix =
			prefix !== undefined && prefixTokens !== undefined && text.length > prefix.length && text.startsWith(prefix);
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
		let canStream: boolean;
		if (this.#lastScanValid && this.#appendOnlySinceLastScan && text.length > this.#lastScanLength) {
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
			const tailTokens = lexDocument(refDefText);
			const tokens = [...prefixTokens, ...tailTokens];
			this.#freezeStablePrefix(text, tokens, { preserveExisting: true });
			return tokens;
		}
		const tokens = lexDocument(text);
		if (canStream) {
			this.#freezeStablePrefix(text, tokens, { preserveExisting: false });
		} else {
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixLineCache = undefined;
			this.#tailRowCache = undefined;
		}
		return tokens;
	}

	// Freeze the largest run of leading blocks that end on a hard "\n\n" boundary
	// (complete and immutable under append-only growth) so the next streaming
	// render re-lexes only the unfrozen tail. Caller guarantees no CR / no
	// reference definitions, so each token's `raw` is a verbatim slice of `text`
	// and the summed offsets address `text` exactly.
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
		const frozen = stableBlockBoundary(
			text,
			skipPrefix > 0 ? (this.#streamPrefixText?.length ?? 0) : 0,
			tokens,
			skipPrefix,
		);
		if (frozen.count > 0) {
			this.#streamPrefixText = text.slice(0, frozen.end);
			this.#streamPrefixTokens = tokens.slice(0, frozen.count);
			return;
		}

		if (!opts.preserveExisting) {
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixLineCache = undefined;
			this.#tailRowCache = undefined;
		}
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

		// Replace tabs with spaces, then repair orphan fences in final mode.
		const tabbed = replaceTabs(this.#text);
		const normalizedText = this.transientRenderCache ? tabbed : repairOrphanClosingFence(tabbed);
		if (!this.transientRenderCache && normalizedText.length < tabbed.length) {
			// repairOrphanClosingFence deleted bytes this frame (orphan fence
			// removed): the guard-scan memo's checked region is no longer
			// byte-identical, and a cached false verdict may have been based
			// on the very CR/ref-def line that was deleted. Invalidate so the
			// next #lexTokens re-derives on the repaired buffer.
			this.#lastScanValid = false;
		}
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
				// makes ONE token (x *a**b* → em("a**b")), the splice keeps two.
				// An image marker (`x!` + `[a](u)`) re-pairs the same way.
				const pairSeamHazard =
					markerDelta &&
					((/^[*~`]/.test(deltaTabs) && /[*~`]$/.test(recipe.rowRaw)) ||
						// "x!" + "[a](u)": cold lexes text("x") + image(alt); the splice would
						// keep "x!" + a styled link byte-run.
						(deltaTabs.startsWith("[") && recipe.rowRaw.endsWith("!")));
				const deltaTokens = markerDelta && !hardDelta ? lexInlineTokens(deltaTabs) : null;
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
									this.#theme.symbols.colorSwatch || DEFAULT_COLOR_SWATCH_GLYPH,
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
					// hold the old one).
					const prev = recipe.lines;
					const fastResult = [...prev.slice(0, recipe.rowStart), ...fastRows, ...prev.slice(recipe.rowEnd)];
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
					fastTailSplices++;
					return fastResult;
				}
			}
			// Hazard → disarm until the next real render re-captures.
			this.#fastTail = undefined;
		}
		// Replace tabs with 3 spaces for consistent rendering

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

		// Combine top padding, content, and bottom padding
		const rawResult = [...emptyLines, ...contentLines, ...emptyLines];
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
			themeId: objectId(this.#theme),
			defaultTextStyleId: this.#defaultTextStyle ? objectId(this.#defaultTextStyle) : -1,
			imageProtocol: TERMINAL.imageProtocol ?? "",
			hyperlinks: TERMINAL.hyperlinks,
			textSizing: TERMINAL.textSizing,
			bgColorProbe,
			headingProbe,
		};
	}
	// All-primitive signature — compare via the canonical render-cache encoding.
	#signatureEquals(a: RenderSignature, b: RenderSignature): boolean {
		return this.#renderCacheKey("", a) === this.#renderCacheKey("", b);
	}

	#renderCacheKey(normalizedText: string, signature: RenderSignature): string {
		return `${normalizedText}\x00${signature.width}\x00${signature.paddingX}\x00${signature.paddingY}\x00${signature.codeBlockIndent}\x00${signature.themeId}\x00${signature.defaultTextStyleId}\x00${signature.imageProtocol}\x00${signature.hyperlinks ? 1 : 0}\x00${signature.textSizing ? 1 : 0}\x00${signature.bgColorProbe}\x00${signature.headingProbe}`;
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

		const contentLines: string[] = [];
		const reusablePrefix = this.#matchingStreamPrefixLineCache(normalizedText, stableText, signature);
		let renderedUntil = 0;
		if (reusablePrefix && reusablePrefix.tokenCount <= stableTokenCount) {
			contentLines.push(...reusablePrefix.lines);
			renderedUntil = reusablePrefix.tokenCount;
		}

		if (renderedUntil < stableTokenCount) {
			// Stable tokens render with full fidelity (syntax highlighting on)
			// so these cached rows byte-match the finalized render.
			this.#renderingStablePrefix = true;
			try {
				contentLines.push(
					...this.#renderContentLines(tokens, renderedUntil, stableTokenCount, contentWidth, signature),
				);
			} finally {
				this.#renderingStablePrefix = false;
			}
			renderedUntil = stableTokenCount;
		}

		this.#streamPrefixLineCache = {
			...signature,
			text: stableText,
			tokenCount: stableTokenCount,
			lines: contentLines.slice(),
		};

		if (renderedUntil < tokens.length) {
			contentLines.push(...this.#renderStreamingTail(tokens, renderedUntil, contentWidth, signature));
		}

		return contentLines;
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
				out.push(...cache.rows[i - start]!);
			}
		}

		const recorder: TailRenderRecorder = {
			rows: new Array(tokens.length - spliceEnd).fill(undefined),
			raws: new Array(tokens.length - spliceEnd).fill(undefined),
			nextTypes: new Array(tokens.length - spliceEnd).fill(undefined),
		};
		const fresh = this.#renderContentLines(tokens, spliceEnd, tokens.length, contentWidth, signature, recorder);
		out.push(...fresh);

		// Refresh the cache: keep entries for spliced tokens (their raws stay
		// valid), overlay the fresh entries, and re-derive the contiguous
		// covered prefix (splicing stops at the first uncacheable or
		// changed token). All arrays are tail-relative (index 0 = token
		// `start`), so a mostly-frozen document allocates only for the
		// unfrozen tail instead of the whole token list every frame.
		const tailCount = tokens.length - start;
		const rows: (readonly string[] | undefined)[] = new Array(tailCount).fill(undefined);
		const raws: (string | undefined)[] = new Array(tailCount).fill(undefined);
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
		return out;
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
			const completedLines = lineEnd >= 0 ? this.#highlightStreamingLines(tokenText.slice(0, lineEnd), lang) : null;
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
	 * Highlight the completed (newline-terminated) prefix of a streaming code
	 * fence. Uses a stateful per-fence highlight stream so each render pushes
	 * only the newly completed lines, with output byte-identical to the
	 * whole-block `highlightCode` the finalized render performs. Returns null
	 * when no stream is available for `lang` (caller falls back to plain
	 * code-block styling).
	 */
	#highlightStreamingLines(completedText: string, lang: string | undefined): readonly string[] | null {
		const signature = this.#activeRenderSignature;
		const cache = this.#streamingHighlightCache;
		if (
			signature &&
			cache &&
			completedText.startsWith(cache.text) &&
			(cache.text.length === completedText.length || completedText.charCodeAt(cache.text.length) === 0x0a) &&
			cache.lang === lang &&
			cache.width === signature.width &&
			cache.paddingX === signature.paddingX &&
			cache.paddingY === signature.paddingY &&
			cache.codeBlockIndent === signature.codeBlockIndent &&
			cache.themeId === signature.themeId &&
			cache.defaultTextStyleId === signature.defaultTextStyleId &&
			cache.imageProtocol === signature.imageProtocol &&
			cache.hyperlinks === signature.hyperlinks &&
			cache.textSizing === signature.textSizing &&
			cache.bgColorProbe === signature.bgColorProbe &&
			cache.headingProbe === signature.headingProbe
		) {
			if (completedText.length === cache.text.length) return cache.lines;
			// Invariant: the stream has consumed `cache.text + "\n"`, so pushing
			// the added lines with a trailing newline advances it to
			// `completedText + "\n"` — every fed line stays newline-terminated.
			const addedText = completedText.slice(cache.text.length + 1);
			const lines = cache.lines.concat(splitPushedHighlightLines(cache.stream.push(`${addedText}\n`)));
			this.#streamingHighlightCache = { ...signature, lang, text: completedText, lines, stream: cache.stream };
			return lines;
		}

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
				// resolver already re-fits over-wide horizontal graphs top-down.
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
					stylePrefix: "",
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
		const fillChar = getHrChar(sourceChar, this.#theme.symbols.hrChar);
		return this.#theme.hr(fillChar.repeat(Math.min(width, 80)));
	}

	/**
	 * Wrap already-rendered lines in the blockquote border and quote styling.
	 * `width` is the full content width; the border reserves two cells.
	 */
	#applyQuoteBorder(renderedLines: RenderedLine[], width: number): RenderedLine[] {
		const quoteStyle = (text: string) => this.#theme.quote(this.#theme.italic(text));
		const quoteStylePrefix = this.#getStylePrefix(quoteStyle);
		const applyQuoteStyle = (line: string): string => {
			if (!quoteStylePrefix) {
				return quoteStyle(line);
			}
			const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
			return quoteStyle(lineWithReappliedStyle);
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
					lines.push(renderedLine(this.#theme.quoteBorder(`${this.#theme.symbols.quoteBorder} `) + wrappedLine));
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
		const cleaned = normalizeHtmlForTerminal(inner, createHtmlNormalizationState(), text => this.#theme.code(text));
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
		const swatchGlyph = this.#theme.symbols.colorSwatch || DEFAULT_COLOR_SWATCH_GLYPH;
		let trimLeadingWhitespace = false;
		const htmlState = createHtmlNormalizationState();
		const markHtmlItemWhenContent = (text: string): void => {
			markCurrentHtmlItemContent(htmlState, text);
		};

		for (const token of collapseInlineHtml(tokens)) {
			if (isMathToken(token)) {
				markHtmlItemWhenContent(token.text);
				result += applyTextWithNewlines(renderMathToken(token.text));
				continue;
			}
			switch (token.type) {
				case "text": {
					const rawText = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
					const text = normalizeHtmlEntitiesForTerminal(rawText);
					trimLeadingWhitespace = false;
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
					const clickableLinkText = formatHyperlink(styledLinkText, href);
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
						result += `${clickableLinkText} ${formatHyperlink(styledLinkUrl, href)}${stylePrefix}`;
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
						} else if (cleaned.length > 0) {
							trimLeadingWhitespace = false;
						}
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						const rawText = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
						const text = normalizeHtmlEntitiesForTerminal(rawText);
						trimLeadingWhitespace = false;
						markHtmlItemWhenContent(text);
						result += applyTextWithNewlines(text);
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

		const t = this.#theme.symbols.table;
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
