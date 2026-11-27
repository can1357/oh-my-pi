/**
 * Markdown → terminal rows at a width under a theme.
 *
 * Blocks are separated by one blank row (none inside list items); paragraphs
 * keep the source's line breaks; code fences keep their fence lines; lists
 * hang wrapped rows under the item text; quotes draw a border and the quote
 * style; tables are fitted grids; display math is typeset in rows. With
 * `textSizing`, a top-level H1 that fits draws at double size (OSC 66) over
 * its row and the blank row reserved below it.
 */
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { listMayContinueAt } from "@oh-my-pi/pi-utils/marked-list";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { Theme } from "../../theme/contract";
import { highlightCode, supportsLanguage } from "../highlight";
import { latexToUnicode } from "../latex";
import { latexToBlock } from "../latex-block";
import { textSized } from "../osc";
import { tokens as ansiTokens } from "../ansi";
import { pieces, spaces, truncate, visibleWidth, wrap } from "../width";
import { FORMATTING_TAGS, type InlineContext, type InlineEnvironment, PLAIN_CONTEXT, renderInline } from "./inline";
import {
	lexInline,
	lexMarkdown,
	lexWithPriorDefinitions,
	type MathToken,
	type RuleToken,
	type Token,
	type Tokens,
	type TokensList,
} from "./lexer";
import { EXTENSION_LINK_ID, extensionLinkTest } from "./links";
import { mermaidRows } from "./mermaid";
import { markdownLook } from "./look";
import { type MarkdownStyles, markdownStyles, stylePrefix } from "./styles";
import { growingTableCell, repairOrphanClosingFence, speculativeStreamingSource } from "./stream";
import { renderTable } from "./table";

/** How a document is drawn. */
export interface MarkdownOptions {
	readonly theme: Theme;
	/** Blank columns left and right of the text (default 0). */
	readonly paddingX?: number;
	/** Blank rows above and below the text (default 0). */
	readonly paddingY?: number;
	/** Palette hues for headings, emphasis, inline code and table headers (default: the host's {@link markdownLook}). */
	readonly colorful?: boolean;
	/** Wrap links in OSC 8 hyperlinks (default false). */
	readonly hyperlinks?: boolean;
	/**
	 * Draw ` (href)` after a link label that is not the href itself (default:
	 * the host's {@link markdownLook}). Only honored with `hyperlinks`: an
	 * unlinked label alone would lose the destination.
	 */
	readonly linkUrls?: boolean;
	/**
	 * Draw top-level H1 headings at double size with OSC 66 text sizing, over
	 * their row and one reserved blank row (default false: the terminal must
	 * draw OSC 66).
	 */
	readonly textSizing?: boolean;
	/** Draw ```mermaid fences as diagrams (default: the host's {@link markdownLook}). */
	readonly mermaid?: boolean;
	/** TSP span tokens every prose run is drawn with (`"muted em"` for thinking traces). */
	readonly textStyle?: string;
	/** The hyperlink target of an href; the href itself when undefined. */
	readonly linkTarget?: (href: string) => string | undefined;
	/**
	 * Link schemes the host routes itself (lowercase, without `:`): such a
	 * link draws its label alone, underlined in `mdExtensionLink`, inside an
	 * extension link marker (`./links`) the host takes out of the rows.
	 */
	readonly linkSchemes?: readonly string[];
	/** Literal runs drawn as these spans wherever they occur in prose. */
	readonly marks?: readonly TspSpan[];
	/**
	 * The source is a prefix of a document still arriving: an open link or
	 * math span in the last block renders closed, and the row being written
	 * at the end of a table keeps the table's layout and height.
	 */
	readonly stream?: boolean;
	/**
	 * Columns code fence bodies are indented by (default 2). 0 draws them and
	 * their ``` fence rows literally: at the row's column 0 whatever quote,
	 * list or padding holds them, wrapped by cells, so copying the rows yields
	 * the code and copying the whole block yields its markdown.
	 */
	readonly codeIndent?: number;
}

/** A code row drawn at column 0 of the full width, outside every container. */
interface LiteralRow {
	readonly literal: string;
}

/** A content row: styled text placed by its containers, or a literal code row. */
type Row = string | LiteralRow;

/** `rows` with `first` before the first text row and `rest` before the others; literal rows pass through. */
function prefixRows(rows: readonly Row[], first: string, rest: string): Row[] {
	return rows.map((row, i) => (typeof row === "string" ? (i === 0 ? first : rest) + row : row));
}

/** Widest a horizontal rule draws. */
const MAX_RULE = 80;
/** Cells a nested list is indented by under its item. */
const NESTED_LIST_INDENT = 2;

interface Renderer {
	readonly options: MarkdownOptions;
	readonly styles: MarkdownStyles;
	readonly inline: InlineEnvironment;
	/** Context of top-level prose. */
	readonly prose: InlineContext;
	/** Context of table header cells: the prose style without its color when headers take a hue. */
	readonly header: InlineContext;
	/** The table whose last row is still being written, and its open cell. */
	readonly growing?: { readonly table: Tokens.Table; readonly cell: number };
	/**
	 * The fenced code block a streaming part consists of, and how many of its rows are final once
	 * drawn ({@link streamingFence}): `renderCode` records the count as it draws them.
	 */
	readonly fence?: { readonly token: Tokens.Code; head: number };
	/** The full row width literal code rows wrap at. */
	readonly fullWidth: number;
}

const ATTRIBUTE_TOKENS: Readonly<Record<string, true>> = {
	strong: true,
	em: true,
	underline: true,
	strike: true,
	faint: true,
	inverse: true,
};

function proseContext(theme: Theme, tokens: string | undefined): InlineContext {
	if (!tokens) return PLAIN_CONTEXT;
	const text = (value: string): string => theme.style(tokens, value);
	return { text, restore: stylePrefix(text) };
}

/** Tokens that draw nothing and take no separator. */
function isBlank(token: Token): boolean {
	if (token.type === "space" || token.type === "checkbox") return true;
	if (token.type === "html") return /^\s*(?:<!--[\s\S]*?-->\s*)+$/.test((token as Tokens.HTML).raw);
	return false;
}

/** Rows of a block list: blocks separated by a blank row, or stacked when `tight`. */
function renderBlocks(r: Renderer, tokens: readonly Token[], width: number, ctx: InlineContext, tight: boolean): Row[] {
	const out: Row[] = [];
	let previous: Token | undefined;
	for (const token of tokens) {
		if (isBlank(token)) {
			previous = token;
			continue;
		}
		// A reference definition draws nothing but still ends the block before it with a blank row.
		const rows = token.type === "def" ? [] : renderBlock(r, token, width, ctx);
		if (rows.length === 0 && token.type !== "def") continue;
		// A list that interrupts a paragraph (no blank source line between them) follows it directly.
		const interrupts = previous?.type === "paragraph" && token.type === "list";
		if (!tight && out.length > 0 && !interrupts) out.push("");
		out.push(...rows);
		previous = token;
	}
	return out;
}

function renderBlock(r: Renderer, token: Token, width: number, ctx: InlineContext): Row[] {
	switch (token.type) {
		case "paragraph":
			return wrap(renderInline(r.inline, (token as Tokens.Paragraph).tokens, ctx), width);
		case "text": {
			const text = token as Tokens.Text;
			const inline = text.tokens ? renderInline(r.inline, text.tokens, ctx) : ctx.text(text.text);
			return wrap(inline, width);
		}
		case "heading":
			return wrap(renderHeading(r, token as Tokens.Heading, ctx), width);
		case "code":
			return renderCode(r, token as Tokens.Code, width);
		case "blockquote":
			return renderQuote(r, token as Tokens.Blockquote, width);
		case "list":
			return renderList(r, token as Tokens.List, width, ctx);
		case "table":
			return renderTable(
				{
					cellText: (cell, header) =>
						renderInline(r.inline, cell.tokens, header ? (ctx === r.prose ? r.header : ctx) : ctx),
					tableHeader: r.styles.tableHeader,
					box: r.options.theme.symbols.sharp,
				},
				token as Tokens.Table,
				width,
				r.growing?.table === token ? r.growing.cell : -1,
			);
		case "hr":
			return [renderRule(r, (token as unknown as RuleToken).char, width)];
		case "html":
			return renderHtmlBlock(r, (token as Tokens.HTML).raw.replace(/\n+$/, ""), width, ctx);
		case "math":
			return renderDisplayMath(r, (token as unknown as MathToken).text, width, ctx);
		default:
			return token.raw.trim() ? wrap(ctx.text(token.raw.replace(/\n+$/, "")), width) : [];
	}
}

const HTML_TAG = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;

/**
 * An HTML block: built only from formatting tags (lists, paragraphs, breaks,
 * code, rules, quotes) it is drawn as that structure; anything else shows as
 * written.
 */
function renderHtmlBlock(r: Renderer, raw: string, width: number, ctx: InlineContext): Row[] {
	// The lexer can run an HTML block on past a blank line; what follows it is Markdown again.
	const blank = /\n[ \t]*\n/.exec(raw);
	if (blank) {
		const head = renderHtmlBlock(r, raw.slice(0, blank.index), width, ctx);
		const rest = renderBlocks(r, lexMarkdown(raw.slice(blank.index + blank[0].length)), width, ctx, false);
		return head.length > 0 && rest.length > 0 ? [...head, "", ...rest] : [...head, ...rest];
	}
	for (const match of raw.matchAll(HTML_TAG)) {
		if (!FORMATTING_TAGS[match[1]!.toLowerCase()]) return wrap(ctx.text(raw), width);
	}
	const trimmed = raw.trim();
	if (/^<hr\s*\/?>$/i.test(trimmed)) return [renderRule(r, undefined, width)];
	const quote = /^<blockquote\b[^>]*>([\s\S]*)<\/blockquote>$/i.exec(trimmed);
	if (quote) {
		const { styles, options } = r;
		const border = styles.quoteBorder(`${options.theme.symbols.symbol("md.quoteBorder") || "▏"} `);
		const inner = renderInline(r.inline, lexInline(quote[1]!.trim()), {
			text: text => text,
			restore: stylePrefix(styles.quote),
		});
		return wrap(inner, Math.max(1, width - visibleWidth(border))).map(row => border + styles.quote(row));
	}
	return wrap(renderInline(r.inline, lexInline(trimmed), ctx), width);
}

function renderHeading(r: Renderer, token: Tokens.Heading, ctx: InlineContext): string {
	const { styles } = r;
	const color = (text: string): string => styles.heading(token.depth, text);
	const inner = renderInline(r.inline, token.tokens, ctx);
	if (token.depth === 1) return color(styles.bold(styles.underline(inner)));
	if (token.depth === 2) return color(styles.bold(inner));
	return color(styles.bold(`${"#".repeat(token.depth)} ${inner}`));
}

/** Scale of a sized H1: rows tall, and cells per cell of its text. */
const HEADING_SCALE = 2;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * A top-level H1 as one OSC 66 row (its text plain, styled as the heading),
 * or undefined when it draws normally: sizing is off, the heading is empty,
 * too wide at scale, or holds an extension link (sized text is plain, so the
 * link's marker would be lost). Links draw their label alone, still linked
 * when hyperlinks are on. ASCII runs share one span; every other grapheme
 * gets its own with an explicit cell count, so the terminal places it in the
 * cells this width accounting gives it.
 */
function sizedHeading(r: Renderer, token: Tokens.Heading, width: number): string | undefined {
	if (token.depth !== 1 || !r.options.textSizing) return undefined;
	const drawn = renderInline({ ...r.inline, linkUrls: false }, token.tokens, PLAIN_CONTEXT);
	if (drawn.includes(EXTENSION_LINK_ID)) return undefined;
	const drawnWidth = visibleWidth(drawn);
	if (drawnWidth === 0 || drawnWidth * HEADING_SCALE > width) return undefined;
	let sized = "";
	let ascii = "";
	const flush = (): void => {
		if (ascii !== "") sized += textSized(ascii, { scale: HEADING_SCALE });
		ascii = "";
	};
	for (const part of ansiTokens(drawn)) {
		if (part.escape) {
			// Hyperlinks stay around the spans of their label; styles give way to the heading's.
			if (part.text.startsWith("\x1b]8;")) {
				flush();
				sized += part.text;
			}
			continue;
		}
		for (const piece of pieces(part.text)) {
			if (PRINTABLE_ASCII.test(piece.text)) {
				ascii += piece.text;
				continue;
			}
			flush();
			sized += textSized(piece.text, { scale: HEADING_SCALE, widthCells: piece.width });
		}
	}
	flush();
	const { styles } = r;
	return styles.heading(1, styles.bold(styles.underline(sized)));
}

/** Padded rows of top-level `token`: a sized H1 over its reserved rows, or the block as `renderBlock` draws it. */
function renderTopBlock(r: Renderer, token: Token, contentWidth: number, width: number, paddingX: number): string[] {
	const sized = token.type === "heading" ? sizedHeading(r, token as Tokens.Heading, contentWidth) : undefined;
	if (sized === undefined) return padRows(renderBlock(r, token, contentWidth, r.prose), width, paddingX);
	const rows = [sized];
	for (let i = 1; i < HEADING_SCALE; i++) rows.push("");
	return padRows(rows, width, paddingX);
}

function ruleChar(theme: Theme, source: string | undefined): string {
	const ascii = theme.symbols.preset === "ascii";
	switch (source) {
		case "=":
			return "=";
		case "═":
			return ascii ? "=" : "═";
		case "━":
		case "─":
		case "–":
		case "—":
			return ascii ? "-" : source;
		default:
			return theme.symbols.symbol("md.hrChar") || "─";
	}
}

function renderRule(r: Renderer, source: string | undefined, width: number): string {
	return r.styles.rule(ruleChar(r.options.theme, source).repeat(Math.max(1, Math.min(width, MAX_RULE))));
}

function fenceLanguage(token: Tokens.Code): string | undefined {
	const lang = token.lang?.trim().split(/\s+/)[0];
	return lang ? lang : undefined;
}

function renderCode(r: Renderer, token: Tokens.Code, width: number): Row[] {
	const { styles, options } = r;
	const lang = fenceLanguage(token);
	if (lang === "mermaid" && options.mermaid !== false) {
		const art = mermaidRows(token.text, width, options.theme);
		if (art) return art.map(row => (visibleWidth(row) > width ? truncate(row, width, "") : row));
	}
	const code = token.text;
	const lines =
		lang !== undefined && supportsLanguage(lang) ? highlightCode(code, lang, options.theme) : code.split("\n");
	const indent = options.codeIndent ?? 2;
	// A literal body takes its fence rows to column 0 with it, so the block stays aligned.
	const border = (text: string): Row[] =>
		indent > 0
			? wrap(styles.codeBorder(text), width)
			: wrap(styles.codeBorder(text), r.fullWidth).map(literal => ({ literal }));
	const out: Row[] = border(`\`\`\`${lang ?? ""}`);
	const fence = r.fence?.token === token ? r.fence : undefined;
	for (let i = 0; i < lines.length; i++) {
		// Every line another line follows is final; the last one can still grow or become the closing fence.
		if (fence && i === lines.length - 1) fence.head = out.length;
		const line = options.hyperlinks ? linkUrls(lines[i]!) : lines[i]!;
		if (indent > 0) out.push(...wrap(spaces(indent) + line, width));
		else if (line === "") out.push({ literal: "" });
		else for (const literal of wrap(line, r.fullWidth)) out.push({ literal });
	}
	out.push(...border("```"));
	return out;
}

/**
 * A fence with an info string whose opening line has ended: later text can
 * neither turn its opener back into prose nor drop it as an orphan closing
 * fence ({@link repairOrphanClosingFence} only drops bare fences).
 */
function opensFence(token: Token | undefined): token is Tokens.Code {
	return (
		token?.type === "code" &&
		(token as Tokens.Code).codeBlockStyle !== "indented" &&
		fenceLanguage(token as Tokens.Code) !== undefined &&
		token.raw.includes("\n")
	);
}

/**
 * The fenced code block that makes up a streaming part on its own, when its
 * finished rows are final: the opening fence and every code line another
 * line already follows. The highlighter reads each line in the state the
 * lines before it leave, and each line wraps on its own. Fences whose
 * finished form draws differently stay out: ```` ```mermaid ```` drawn as a
 * diagram, and ```` ```svg ```` (figure Markdown draws a closed one as a
 * picture).
 */
function streamingFence(tokens: readonly Token[], options: MarkdownOptions): Renderer["fence"] {
	let fence: Token | undefined;
	for (const token of tokens) {
		if (isBlank(token)) continue;
		if (fence) return undefined;
		fence = token;
	}
	if (!opensFence(fence)) return undefined;
	const lang = fenceLanguage(fence);
	if (lang === "svg" || (lang === "mermaid" && options.mermaid !== false)) return undefined;
	return { token: fence, head: 0 };
}

const CODE_URL = /\b(?:https?|ftp):\/\/[^\s<>"'`]+/g;
const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

/** `url` without trailing punctuation and closing brackets it did not open. */
function trimUrl(url: string): string {
	let end = url.length;
	for (;;) {
		const last = url[end - 1]!;
		if (/[.,;:!?'"]/.test(last)) {
			end--;
			continue;
		}
		const opener = CLOSERS[last];
		if (opener === undefined) break;
		const body = url.slice(0, end);
		if (body.split(opener).length >= body.split(last).length) break;
		end--;
	}
	return url.slice(0, end);
}

/** A styled code line with every URL in it wrapped in an OSC 8 hyperlink, across its style changes. */
function linkUrls(line: string): string {
	const parts = pieces(line);
	let visible = "";
	const offsets: number[] = [];
	parts.forEach((part, index) => {
		if (part.escape) return;
		for (let i = 0; i < part.text.length; i++) offsets.push(index);
		visible += part.text;
	});
	const opens = new Map<number, string>();
	const closes = new Set<number>();
	for (const match of visible.matchAll(CODE_URL)) {
		const url = trimUrl(match[0]);
		if (!url.includes("://") || url.endsWith("://")) continue;
		opens.set(offsets[match.index]!, url);
		closes.add(offsets[match.index + url.length - 1]!);
	}
	if (opens.size === 0) return line;
	let out = "";
	parts.forEach((part, index) => {
		const url = opens.get(index);
		if (url !== undefined) out += `\x1b]8;;${url}\x07`;
		out += part.text;
		if (closes.has(index)) out += "\x1b]8;;\x07";
	});
	return out;
}

function renderQuote(r: Renderer, token: Tokens.Blockquote, width: number): Row[] {
	const { styles, options } = r;
	const border = styles.quoteBorder(`${options.theme.symbols.symbol("md.quoteBorder") || "▏"} `);
	const borderWidth = visibleWidth(border);
	const ctx: InlineContext = { text: text => text, restore: stylePrefix(styles.quote) };
	const inner = renderBlocks(r, token.tokens, Math.max(1, width - borderWidth), ctx, false);
	return inner.map(row => (typeof row === "string" ? border + styles.quote(row) : row));
}

function renderDisplayMath(r: Renderer, latex: string, width: number, ctx: InlineContext): string[] {
	const rows = latexToBlock(latex);
	if (rows.length === 0) return wrap(ctx.text(latexToUnicode(latex)), width);
	return rows.flatMap(row => wrap(row, width));
}

function listMarker(token: Tokens.List, index: number): string {
	if (!token.ordered) return "- ";
	const start = token.start === "" ? 1 : token.start;
	return `${start + index}. `;
}

function renderList(r: Renderer, token: Tokens.List, width: number, ctx: InlineContext): Row[] {
	const out: Row[] = [];
	token.items.forEach((item, index) => {
		out.push(...renderListItem(r, item, listMarker(token, index), width, ctx));
	});
	return out;
}

function renderListItem(r: Renderer, item: Tokens.ListItem, marker: string, width: number, ctx: InlineContext): Row[] {
	let markerWidth = visibleWidth(marker);
	const out: Row[] = [];
	let lead = r.styles.bullet(marker);
	if (markerWidth >= width) {
		// The marker alone fills the row: it gets a row of its own and the content goes under it.
		out.push(truncate(lead, width, ""));
		lead = "";
		markerWidth = 0;
	}
	const indent = spaces(markerWidth);
	const checkbox = item.task ? `[${item.checked ? "x" : " "}] ` : "";
	let first = true;
	for (const child of item.tokens) {
		if (isBlank(child)) continue;
		let rows: Row[];
		if (child.type === "list") {
			const nested = renderList(r, child as Tokens.List, Math.max(1, width - NESTED_LIST_INDENT), ctx);
			const pad = spaces(NESTED_LIST_INDENT);
			rows = prefixRows(nested, first ? lead + spaces(Math.max(0, NESTED_LIST_INDENT - markerWidth)) : pad, pad);
		} else if (first && checkbox && (child.type === "text" || child.type === "paragraph")) {
			const hang = markerWidth + checkbox.length;
			rows = prefixRows(renderBlock(r, child, Math.max(1, width - hang), ctx), lead + checkbox, spaces(hang));
		} else {
			const content = renderBlock(r, child, Math.max(1, width - markerWidth), ctx);
			rows = prefixRows(content, first ? lead : indent, indent);
		}
		if (rows.length === 0) continue;
		out.push(...rows);
		first = false;
	}
	if (first) out.push(lead + checkbox);
	return out;
}

/** The innermost last block of a document (the last item's last block, a quote's last block). */
function lastLeaf(tokens: readonly Token[]): Token | undefined {
	for (let i = tokens.length - 1; i >= 0; i--) {
		const token = tokens[i]!;
		if (isBlank(token)) continue;
		if (token.type === "list") {
			const item = (token as Tokens.List).items.at(-1);
			return item ? (lastLeaf(item.tokens) ?? token) : token;
		}
		if (token.type === "blockquote") return lastLeaf((token as Tokens.Blockquote).tokens) ?? token;
		return token;
	}
	return undefined;
}

/** The renderer of top-level `tokens` (a whole document, or a part of one) under `options`. */
function createRenderer(tokens: readonly Token[], fullWidth: number, options: MarkdownOptions): Renderer {
	const colorful = options.colorful ?? true;
	const styles = markdownStyles(options.theme, colorful);
	const prose = proseContext(options.theme, options.textStyle);
	return {
		options,
		styles,
		inline: {
			styles,
			hyperlinks: options.hyperlinks ?? false,
			linkUrls: drawsLinkUrls(options),
			linkTarget: options.linkTarget,
			extensionLink: extensionLinkTest(options.linkSchemes ?? []),
			marks: options.marks,
		},
		prose,
		header:
			colorful && options.textStyle
				? proseContext(
						options.theme,
						options.textStyle
							.split(" ")
							.filter(token => ATTRIBUTE_TOKENS[token])
							.join(" "),
					)
				: prose,
		growing: options.stream ? growingTable(tokens) : undefined,
		fence: options.stream ? streamingFence(tokens, options) : undefined,
		fullWidth,
	};
}

/**
 * Padded rows of top-level blocks of a streaming document, by the block's
 * source under a {@link blockKey}: a block renders the same wherever it sits
 * (the table still being written aside), so each frame of a growing answer
 * only renders the blocks that changed. Bounded by count and total size.
 */
const blockRows = new LRUCache<string, readonly string[]>({
	max: 2048,
	maxSize: 8 * 1024 * 1024,
	sizeCalculation: (rows, key) => {
		let size = key.length;
		for (const row of rows) size += row.length;
		return Math.max(1, size);
	},
});

/**
 * Rows of top-level `tokens` (a whole document, or the settled head or the
 * tail after it), padded to the full width: `renderBlocks` + `padRows`.
 * With a `key` each block's rows come through {@link blockRows}, except the
 * last one when the part is `open` (the block being written changes every
 * frame: caching it would only evict blocks that recur).
 */
function renderPart(
	tokens: readonly Token[],
	inner: number,
	width: number,
	options: MarkdownOptions,
	key: string | undefined | readonly (string | undefined)[],
	open: boolean,
	stable?: { rows: number },
): string[] {
	const r = createRenderer(tokens, width, options);
	const paddingX = options.paddingX ?? 0;
	const contentWidth = Math.max(1, inner);
	// The table still being written is part of the last block: its rows are not the source's alone.
	let uncachedAt = r.growing || open ? tokens.length - 1 : -1;
	while (uncachedAt >= 0 && isBlank(tokens[uncachedAt]!)) uncachedAt--;
	const out: string[] = [];
	let blank: string | undefined;
	let previous: Token | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (isBlank(token)) {
			previous = token;
			continue;
		}
		// A reference definition draws nothing but still ends the block before it with a blank row.
		let rows: readonly string[];
		if (token.type === "def") rows = [];
		else if ((typeof key === "object" ? key[i] : key) === undefined || i === uncachedAt) {
			rows = renderTopBlock(r, token, contentWidth, width, paddingX);
		} else {
			const blockKey = `${typeof key === "object" ? key[i] : key}\0${token.raw}`;
			let cached = blockRows.get(blockKey);
			if (!cached) {
				cached = renderTopBlock(r, token, contentWidth, width, paddingX);
				blockRows.set(blockKey, cached);
			}
			rows = cached;
		}
		if (rows.length === 0 && token.type !== "def") continue;
		// A list that interrupts a paragraph (no blank source line between them) follows it directly.
		const interrupts = previous?.type === "paragraph" && token.type === "list";
		if (out.length > 0 && !interrupts) out.push((blank ??= padRows([""], width, paddingX)[0]!));
		for (const row of rows) out.push(row);
		previous = token;
	}
	if (stable) stable.rows = r.fence?.head ?? 0;
	return out;
}

function growingTable(tokens: readonly Token[]): Renderer["growing"] {
	const leaf = lastLeaf(tokens);
	if (leaf?.type !== "table") return undefined;
	const table = leaf as Tokens.Table;
	const cell = growingTableCell(table.raw);
	return cell >= 0 ? { table, cell } : undefined;
}

/** Expand tabs and unify OSC 8 terminators, as the lexer must see the source; close open spans while streaming. */
function normalizeSource(source: string, stream: boolean): string {
	const tabbed = source.includes("\t") ? source.replaceAll("\t", "   ") : source;
	const unified = tabbed.includes("\x1b") ? tabbed.replace(/(\x1b\]8;[^\x07\x1b]*)\x1b\\/g, "$1\x07") : tabbed;
	return stream ? speculativeStreamingSource(unified) : unified;
}

/** Content rows padded to the full width: `paddingX` blank cells on the left (none for literal rows), spaces to the right edge. */
function padRows(rows: readonly Row[], width: number, paddingX: number): string[] {
	const left = spaces(paddingX);
	return rows.map(row => {
		const line = typeof row === "string" ? left + row : row.literal;
		const free = width - visibleWidth(line);
		return free >= 0 ? line + spaces(free) : truncate(line, width, "");
	});
}

/** Rows of a document still arriving, and how many of them later text can no longer change. */
export interface MarkdownFrame {
	readonly rows: readonly string[];
	/** Leading rows that stay as they are however the source grows (append-only output may retire them). */
	readonly stable: number;
}

/** Blocks that end on their own line: what follows them directly cannot pull them into another block. */
const SELF_TERMINATING: Readonly<Record<string, true>> = { heading: true, hr: true, math: true };

/**
 * How many leading top-level tokens are settled: everything before the last
 * block, when a blank line (or a block that ends itself) separates them and
 * no list before it could take a continuation item.
 */
function settledCount(tokens: readonly Token[], source: string): number {
	let last = tokens.length - 1;
	while (last >= 0 && tokens[last]!.type === "space") last--;
	if (last <= 0) return 0;
	// The head ends before the block being written, or before a display math opener left open: it pairs
	// with a closer arriving later, across blank lines.
	let cut = last;
	let next = 0;
	for (let i = 0; i < last; i++) {
		const token = tokens[i]!;
		if (token.type !== "math" && token.type !== "code" && OPEN_DISPLAY_MATH.test(token.raw)) {
			cut = i;
			break;
		}
		next += token.raw.length;
	}
	for (;;) {
		let settled = cut;
		while (settled > 0 && tokens[settled - 1]!.type === "space") settled--;
		if (settled === 0) return 0;
		const before = tokens[settled - 1]!;
		// A fence that interrupts a paragraph ends it as surely as a blank line.
		const separated =
			settled < cut ||
			SELF_TERMINATING[before.type] === true ||
			isClosedFence(before) ||
			(before.type === "paragraph" && opensFence(tokens[settled]));
		if (!separated) return 0;
		// What the block after the head (past the blank lines) may still turn into decides: a block it may
		// still join stays out of the head too.
		if (!joinsAt(before, source, next)) return settled;
		for (let i = settled - 1; i < cut; i++) next -= tokens[i]!.raw.length;
		cut = settled - 1;
	}
}

/**
 * Whether text from `next` on can still join the block `before` it, after
 * blank lines: a same-marker item or an indented line continues a list
 * (`1. a\n\n2`, then `2.`), an indented line continues indented code.
 */
function joinsAt(before: Token, source: string, next: number): boolean {
	if (before.type === "list")
		return !LIST_ENDED.test(source.slice(next, next + 1)) || listMayContinueAt(source, next, before.raw);
	if (before.type === "code" && (before as Tokens.Code).codeBlockStyle === "indented")
		return !INDENT_ENDED.test(source.slice(next, next + 4));
	return false;
}

/** A line whose text starts at column 0: appends can continue a list above it only with a marker. */
const LIST_ENDED = /^\S/;
/** A line whose text starts within three columns: appends cannot make it continue indented code. */
const INDENT_ENDED = /^ {0,3}\S/;
/** A display math opener at the start of a line (after quote or list indentation). */
const OPEN_DISPLAY_MATH = /(?:^|\n)[ \t>]*(?:\$\$|\\\[|\\begin\{)/;

function isClosedFence(token: Token): boolean {
	return token.type === "code" && /\n[ \t]*(?:`{3,}|~{3,})[ \t]*\n?$/.test(token.raw);
}

/** Rows of the settled heads of streaming documents, by prefix (see `renderMarkdownFrame`). */
const settledHeads = new LRUCache<string, readonly string[]>({ max: 64 });

const kThemeId = Symbol("pi-tui.markdown.theme-id");
let nextThemeId = 0;

interface KeyedTheme extends Theme {
	[kThemeId]?: number;
}

/**
 * A cache key for blocks rendered under `options` at `width` with the
 * document's reference definitions `links`; undefined when options hold
 * callbacks.
 */
function blockKey(width: number, options: MarkdownOptions, links: string): string | undefined {
	if (options.linkTarget || options.marks) return undefined;
	const theme = options.theme as KeyedTheme;
	const id = (theme[kThemeId] ??= ++nextThemeId);
	return [
		id,
		width,
		options.paddingX ?? 0,
		options.colorful ?? true,
		options.hyperlinks ?? false,
		drawsLinkUrls(options),
		options.textSizing ?? false,
		options.mermaid ?? true,
		options.textStyle ?? "",
		options.codeIndent ?? 2,
		options.linkSchemes?.join(",") ?? "",
		links,
	].join("|");
}

/** Whether named links draw their ` (href)` suffix: always without OSC 8, where the label alone loses the target. */
function drawsLinkUrls(options: MarkdownOptions): boolean {
	return options.linkUrls !== false || options.hyperlinks !== true;
}

/** The reference definitions of a lexed document, as a key part ("" when there are none). */
function linksKey(tokens: TokensList): string {
	for (const _ in tokens.links) return JSON.stringify(tokens.links);
	return "";
}

/**
 * A streaming document's settled head, lexed once: the leading top-level
 * tokens that text appended to the document can no longer change
 * ({@link settledCount}). A later frame whose source extends this frame's
 * lexes only what follows the head; the result equals lexing it whole, since
 * the head's tokens are final and every block tokenizer reads only the text
 * from its own start. Two things read across that boundary and keep a head
 * from being kept: reference definitions (they resolve links document-wide)
 * and display math or bare environments (an opener in the head pairs with a
 * closer arriving later).
 */
interface StreamHead {
	/** Source of the stream's latest frame; the next frame reuses the head only when it extends it. */
	source: string;
	/** Concatenated raws of `tokens`: a prefix of every later frame's normalized source. */
	prefix: string;
	tokens: readonly Token[];
}

/** Recent stream heads, most recent first (one per document streaming at once). */
const streamHeads: StreamHead[] = [];
const STREAM_HEADS = 8;
/** What makes a head's tokens depend on text after it: display math openers, bare environments. */
const CROSS_BLOCK = /\$\$|\\\[|\\begin\{/;

/** Tokens of a streaming frame, through the head of an earlier frame `source` extends. */
function lexStream(source: string, normalized: string): { tokens: Token[]; links: string; head?: StreamHead } {
	for (let i = 0; i < streamHeads.length; i++) {
		const head = streamHeads[i]!;
		if (!source.startsWith(head.source) || !normalized.startsWith(head.prefix)) continue;
		const tail = lexMarkdown(normalized.slice(head.prefix.length));
		if (linksKey(tail) !== "") {
			// A definition resolves links document-wide from now on: this stream lexes whole.
			streamHeads.splice(i, 1);
			break;
		}
		if (i > 0) {
			streamHeads.splice(i, 1);
			streamHeads.unshift(head);
		}
		return { tokens: head.tokens.concat(tail), links: "", head };
	}
	const tokens = lexMarkdown(normalized);
	return { tokens, links: linksKey(tokens) };
}

/**
 * Remember the settled head of a streaming frame for the frames after it.
 * {@link settledCount} can call a head settled that the last block, still
 * being written, joins later: a list it asks about where the blank rows
 * before that block start (`1. a\n\n7`, then `7.`), a list or indented code
 * that an indented line continues (`- a\n\n    `, then `    b`). Such a head
 * is not kept; the frames after it lex from the last head kept.
 */
function keepStreamHead(
	source: string,
	tokens: readonly Token[],
	settled: number,
	links: string,
	head: StreamHead | undefined,
): StreamHead | undefined {
	if (links !== "" || source.includes("\r")) return undefined;
	const kept = head?.tokens.length ?? 0;
	if (settled > kept) {
		let added = "";
		for (let i = kept; i < settled; i++) added += tokens[i]!.raw;
		if (!CROSS_BLOCK.test(added)) {
			const prefix = (head?.prefix ?? "") + added;
			if (head) {
				head.prefix = prefix;
				head.tokens = tokens.slice(0, settled);
			} else {
				head = { source, prefix, tokens: tokens.slice(0, settled) };
				streamHeads.unshift(head);
				if (streamHeads.length > STREAM_HEADS) streamHeads.pop();
			}
		}
	}
	if (head) head.source = source;
	return head;
}

/**
 * Rows of a settled head in a document that defines references: each block resolves them against the
 * definitions before it ({@link lexWithPriorDefinitions}), cached per block under those definitions.
 */
function renderPriorDefinitions(
	blocks: readonly Token[],
	from: number,
	inner: number,
	width: number,
	options: MarkdownOptions,
	open: boolean,
	stable?: { rows: number },
): string[] {
	const lexed = lexWithPriorDefinitions(blocks, from);
	const keys = new Map<string, string | undefined>();
	const blockKeys = lexed.keys.map(links => {
		if (!keys.has(links)) keys.set(links, blockKey(width, options, links));
		return keys.get(links);
	});
	return renderPart(lexed.tokens, inner, width, options, blockKeys, open, stable);
}

/** Rows of `source` at `width`, padded to the full width. Empty or blank sources have no rows. */
export function renderMarkdown(source: string, width: number, options: MarkdownOptions): string[] {
	return [...renderMarkdownFrame(source, width, options).rows];
}

/** `options` with the host's look where they leave `colorful`, `mermaid` or `linkUrls` unset. */
function withHostLook(options: MarkdownOptions): MarkdownOptions {
	if (options.colorful !== undefined && options.mermaid !== undefined && options.linkUrls !== undefined)
		return options;
	const look = markdownLook();
	return {
		...options,
		colorful: options.colorful ?? look.colorful,
		mermaid: options.mermaid ?? look.mermaid,
		linkUrls: options.linkUrls ?? look.linkUrls,
	};
}

/**
 * Rows of `source` at `width` and the stable prefix among them: the rows of
 * every block before the last one being written (and the blank row after
 * them), plus the top padding, plus the finished lines when that last block
 * is a fenced code block ({@link streamingFence}). With `stream` off nothing is
 * stable: the caller owns the whole document.
 */
export function renderMarkdownFrame(source: string, width: number, given: MarkdownOptions): MarkdownFrame {
	if (!source.trim()) return { rows: [], stable: 0 };
	const options = withHostLook(given);
	const stream = options.stream ?? false;
	const normalized = normalizeSource(source, stream);
	const inner = Math.max(1, width - 2 * (options.paddingX ?? 0));
	const paddingY = options.paddingY ?? 0;
	if (!stream) {
		const rows = renderPart(
			lexMarkdown(repairOrphanClosingFence(normalized)),
			inner,
			width,
			options,
			undefined,
			false,
		);
		return { rows: paddingY > 0 ? padVertically(rows, width, paddingY, []) : rows, stable: 0 };
	}
	const lexed = lexStream(source, normalized);
	const tokens = lexed.tokens;
	const settled = settledCount(tokens, normalized);
	const head = keepStreamHead(source, tokens, settled, lexed.links, lexed.head);
	const key = blockKey(width, options, lexed.links);
	// With reference definitions every block resolves them against the ones before it, the open tail
	// too: rows are a function of the source up to them, whatever the settled count is.
	const defined = lexed.links !== "";
	if (settled === 0) {
		const fence = { rows: 0 };
		const rows = defined
			? renderPriorDefinitions(tokens, 0, inner, width, options, true, fence)
			: renderPart(tokens, inner, width, options, key, true, fence);
		return {
			rows: paddingY > 0 ? padVertically(rows, width, paddingY, []) : rows,
			stable: fence.rows > 0 ? paddingY + fence.rows : 0,
		};
	}
	// Rows of a settled head are a function of its source alone (each block resolves reference links
	// against the definitions before it), so they never change as the document grows: the terminal may
	// already hold them in history. Drawn once per prefix, options and width.
	let headRows: readonly string[] | undefined;
	const headKey = blockKey(width, options, "");
	let settledKey: string | undefined;
	if (headKey !== undefined) {
		let prefix = head?.tokens.length === settled ? head.prefix : undefined;
		if (prefix === undefined) {
			prefix = "";
			for (let i = 0; i < settled; i++) prefix += tokens[i]!.raw;
		}
		settledKey = `${headKey}|${Bun.hash(prefix).toString(36)}|${prefix.length}`;
		headRows = settledHeads.get(settledKey);
	}
	if (!headRows) {
		headRows =
			lexed.links === ""
				? renderPart(tokens.slice(0, settled), inner, width, options, key, false)
				: renderPriorDefinitions(tokens.slice(0, settled), 0, inner, width, options, false);
		if (settledKey !== undefined) settledHeads.set(settledKey, headRows);
	}
	const fence = { rows: 0 };
	const tailRows = defined
		? renderPriorDefinitions(tokens, settled, inner, width, options, true, fence)
		: renderPart(tokens.slice(settled), inner, width, options, key, true, fence);
	const separator = headRows.length > 0 && tailRows.length > 0;
	const rows: string[] = [];
	for (let i = 0; i < paddingY; i++) rows.push(spaces(width));
	for (const row of headRows) rows.push(row);
	const stable = rows.length + (separator ? 1 : 0) + fence.rows;
	if (separator) rows.push(spaces(width));
	for (const row of tailRows) rows.push(row);
	for (let i = 0; i < paddingY; i++) rows.push(spaces(width));
	return { rows, stable };
}

/** `rows` between `count` blank rows above and below. */
function padVertically(rows: readonly string[], width: number, count: number, out: string[]): string[] {
	for (let i = 0; i < count; i++) out.push(spaces(width));
	for (const row of rows) out.push(row);
	for (let i = 0; i < count; i++) out.push(spaces(width));
	return out;
}
