import {
	CloserIndexes,
	canCloseDelimiter,
	canOpenDelimiter,
	escapedAt,
	InlineClosers,
	PUNCTUATION,
} from "./inline-closers";
import { TextRun, TextStops } from "./inline-text";

/** Token shapes emitted by the Markdown lexer. */
export namespace Tokens {
	/** A block quote. */
	export interface Blockquote {
		type: "blockquote";
		raw: string;
		text: string;
		tokens: Token[];
	}
	/** A hard line break. */
	export interface Br {
		type: "br";
		raw: string;
	}
	/** A task-list checkbox. */
	export interface Checkbox {
		type: "checkbox";
		raw: string;
		checked: boolean;
	}
	/** A code block. */
	export interface Code {
		type: "code";
		raw: string;
		codeBlockStyle?: "indented";
		lang?: string;
		text: string;
		escaped?: boolean;
	}
	/** An inline code span. */
	export interface Codespan {
		type: "codespan";
		raw: string;
		text: string;
	}
	/** A reference-link definition. */
	export interface Def {
		type: "def";
		raw: string;
		tag: string;
		href: string;
		title?: string;
	}
	/** Deleted text. */
	export interface Del {
		type: "del";
		raw: string;
		text: string;
		tokens: Token[];
	}
	/** Emphasized text. */
	export interface Em {
		type: "em";
		raw: string;
		text: string;
		tokens: Token[];
	}
	/** An escaped punctuation character. */
	export interface Escape {
		type: "escape";
		raw: string;
		text: string;
	}
	/** A custom extension token. */
	export interface Generic {
		// Upstream marked deliberately permits arbitrary extension-token fields.
		[key: string]: any;
		type: string;
		raw: string;
		tokens?: Token[];
	}
	/** A heading. */
	export interface Heading {
		type: "heading";
		raw: string;
		depth: number;
		text: string;
		tokens: Token[];
	}
	/** A horizontal rule. */
	export interface Hr {
		type: "hr";
		raw: string;
	}
	/** Raw block or inline HTML. */
	export interface HTML {
		type: "html";
		raw: string;
		pre?: boolean;
		text: string;
		block: boolean;
		inLink?: boolean;
		inRawBlock?: boolean;
	}
	/** An image. */
	export interface Image {
		type: "image";
		raw: string;
		href: string;
		title: string | null;
		text: string;
		tokens: Token[];
	}
	/** A hyperlink. */
	export interface Link {
		type: "link";
		raw: string;
		href: string;
		title?: string | null;
		text: string;
		tokens: Token[];
	}
	/** A list. */
	export interface List {
		type: "list";
		raw: string;
		ordered: boolean;
		start: number | "";
		loose: boolean;
		items: ListItem[];
	}
	/** A list item. */
	export interface ListItem {
		type: "list_item";
		raw: string;
		task: boolean;
		checked?: boolean;
		loose: boolean;
		text: string;
		tokens: Token[];
	}
	/** A paragraph. */
	export interface Paragraph {
		type: "paragraph";
		raw: string;
		pre?: boolean;
		text: string;
		tokens: Token[];
	}
	/** Blank block space. */
	export interface Space {
		type: "space";
		raw: string;
	}
	/** Strongly emphasized text. */
	export interface Strong {
		type: "strong";
		raw: string;
		text: string;
		tokens: Token[];
	}
	/** A GFM table cell. */
	export interface TableCell {
		text: string;
		tokens: Token[];
		header: boolean;
		align: "center" | "left" | "right" | null;
	}
	/** A GFM table. */
	export interface Table {
		type: "table";
		raw: string;
		align: Array<"center" | "left" | "right" | null>;
		header: TableCell[];
		rows: TableCell[][];
	}
	/** Plain text. */
	export interface Text {
		type: "text";
		raw: string;
		text: string;
		tokens?: Token[];
		escaped?: boolean;
	}
}

type KnownToken =
	| Tokens.Blockquote
	| Tokens.Br
	| Tokens.Checkbox
	| Tokens.Code
	| Tokens.Codespan
	| Tokens.Def
	| Tokens.Del
	| Tokens.Em
	| Tokens.Escape
	| Tokens.Heading
	| Tokens.Hr
	| Tokens.HTML
	| Tokens.Image
	| Tokens.Link
	| Tokens.List
	| Tokens.ListItem
	| Tokens.Paragraph
	| Tokens.Space
	| Tokens.Strong
	| Tokens.Table
	| Tokens.Text;

/** A built-in or extension Markdown token. */
export type Token = KnownToken | Tokens.Generic;

function isKnownToken(token: Token): token is KnownToken {
	switch (token.type) {
		case "blockquote":
		case "br":
		case "checkbox":
		case "code":
		case "codespan":
		case "def":
		case "del":
		case "em":
		case "escape":
		case "heading":
		case "hr":
		case "html":
		case "image":
		case "link":
		case "list":
		case "list_item":
		case "paragraph":
		case "space":
		case "strong":
		case "table":
		case "text":
			return true;
		default:
			return false;
	}
}

/** Reference definitions collected while lexing. */
export type Links = Record<string, Pick<Tokens.Link | Tokens.Image, "href" | "title">>;
/** A token array carrying its reference-definition map. */
export type TokensList = Token[] & { links: Links };

/** Context supplied to extension tokenizers. */
export interface TokenizerThis {
	lexer: Lexer;
	/**
	 * For an inline tokenizer, the whole inline source, such as a paragraph's text. The `src` it receives is the part
	 * of it before `end` that starts at `end - src.length`: inside a link label or the text of emphasis, `end` is where
	 * that text ends, right before its closer, and a token there must not reach past it. Inline tokenizers get one
	 * context object per inline source, the same for every call while the lexer works through it and the labels and
	 * emphasis inside it, so a tokenizer can keep state for it in a `WeakMap`.
	 */
	source?: string;
	/** For an inline tokenizer, where the text the lexer works through ends in `source` (see `source`). */
	end?: number;
}
/** A tokenizer extension callback. */
export type TokenizerExtensionFunction = (
	this: TokenizerThis,
	src: string,
	tokens: Token[] | TokensList,
) => Tokens.Generic | undefined;
/** A tokenizer extension start hint. */
export type TokenizerStartFunction = (this: TokenizerThis, src: string) => number | void;
/**
 * An offset form of a start hint: the first index at or after `from` in `src` where the extension's tokenizer could
 * match, or `undefined` (not -1) when there is none; anything else below `from` throws. The test at each index must
 * read `src` only from that index on, so the answer for `from` is also the answer for every later offset up to it,
 * and must still pass where `src` goes on past its end: for a link label or the text of emphasis, the lexer asks on
 * the inline source it lies in, then asks again on the label or text at the index it got, if that lies inside.
 */
export type TokenizerStartFromFunction = (this: TokenizerThis, src: string, from: number) => number | undefined;
/** An inline or block tokenizer extension. */
export interface TokenizerExtension {
	name: string;
	level: "block" | "inline";
	start?: TokenizerStartFunction;
	/**
	 * Replaces `start` for inline text when present. Inline lexing calls it on the whole inline source and reuses
	 * the answer until lexing passes it, inside link labels and emphasis too, instead of calling `start` on the rest
	 * of the source at every text step, so a hint that stops at its answer keeps a long paragraph linear.
	 */
	startFrom?: TokenizerStartFromFunction;
	tokenizer: TokenizerExtensionFunction;
	childTokens?: string[];
}
/** Context supplied to extension renderers. */
export interface RendererThis {
	parser: Parser;
}
/** A custom renderer extension callback. */
export type RendererExtensionFunction = (this: RendererThis, token: Tokens.Generic) => string | false | undefined;
/** A named renderer extension. */
export interface RendererExtension {
	name: string;
	renderer: RendererExtensionFunction;
}
/** A combined tokenizer/renderer extension. */
export type TokenizerAndRendererExtension =
	| TokenizerExtension
	| RendererExtension
	| (TokenizerExtension & RendererExtension);

/** Overrides for built-in tokenizer methods. */
export interface TokenizerObject {
	url?(this: Tokenizer, src: string): Tokens.Link | undefined | false;
	lheading?(this: Tokenizer, src: string): Tokens.Heading | undefined | false;
	del?(this: Tokenizer, src: string, maskedSrc?: string, prevChar?: string): Tokens.Del | undefined | false;
}

interface RendererTokenMap {
	space: Tokens.Space;
	html: Tokens.HTML;
	link: Tokens.Link;
	image: Tokens.Image;
	text: Tokens.Text | Tokens.Escape;
	code: Tokens.Code;
	blockquote: Tokens.Blockquote;
	heading: Tokens.Heading;
	hr: Tokens.Hr;
	list: Tokens.List;
	listitem: Tokens.ListItem;
	paragraph: Tokens.Paragraph;
	strong: Tokens.Strong;
	em: Tokens.Em;
	codespan: Tokens.Codespan;
	br: Tokens.Br;
	del: Tokens.Del;
}

/** Overrides for built-in HTML renderer methods. */
export type RendererObject = {
	[K in keyof RendererTokenMap]?: (this: Renderer, token: RendererTokenMap[K]) => string | false;
};

/** Options supported by the in-house Markdown implementation. */
export interface MarkedOptions {
	async?: boolean;
	breaks?: boolean;
	gfm?: boolean;
	pedantic?: boolean;
	silent?: boolean;
	tokenizer?: Tokenizer | TokenizerObject | null;
	/** Built-in tokenizer overrides composed by Marked.use(). */
	tokenizerOverrides?: TokenizerObject;
	renderer?: Renderer | RendererObject | null;
	walkTokens?: ((token: Token) => void | Promise<void>) | null;
	extensions?: ExtensionRegistry | null;
}

interface ExtensionRegistry {
	block: TokenizerExtension[];
	inline: TokenizerExtension[];
	renderers: Record<string, RendererExtensionFunction>;
	childTokens: Record<string, string[]>;
}

/** Options accepted by Marked.use(). */
export interface MarkedExtension extends Omit<MarkedOptions, "extensions"> {
	extensions?: TokenizerAndRendererExtension[] | null;
}

const DEFAULTS: MarkedOptions = {
	async: false,
	breaks: false,
	gfm: true,
	pedantic: false,
	silent: false,
	tokenizer: null,
	renderer: null,
	walkTokens: null,
	extensions: null,
};

function tokenList(links: Links = Object.create(null)): TokensList {
	const list = [] as unknown as TokensList;
	// The reference-definition map is keyed by user-controlled labels. A plain
	// `{}` inherits `Object.prototype`, so a reference-style link whose label is
	// an inherited member (`[x][constructor]`, `[x][__proto__]`) resolves to a
	// truthy non-definition and yields a link token with `href: undefined`
	// (issue #10283). A null-prototype map makes such lookups miss, so the link
	// correctly falls back to literal text, and label writes cannot pollute the
	// prototype.
	list.links = links;
	return list;
}

function normalizeSource(src: string): string {
	return src.replace(/\r\n|\r/g, "\n").replace(/\t/g, "    ");
}

function unescapeMarkdown(value: string): string {
	return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function cleanUrl(value: string): string {
	return unescapeMarkdown(value.trim().replace(/^<|>$/g, ""));
}

function escapeHtml(value: string, encode = true): string {
	let out = value
		.replace(/&(?!(?:#\d+|#x[\da-f]+|\w+);)/gi, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
	if (!encode) out = out.replace(/&amp;(#\d+|#x[\da-f]+|\w+);/gi, "&$1;");
	return out;
}

function findDelimiter(src: string, delimiter: string, from: number): number {
	let at = src.indexOf(delimiter, from);
	while (at !== -1 && escapedAt(src, at)) at = src.indexOf(delimiter, at + delimiter.length);
	return at;
}

/**
 * The autolink at the start of `src`, a suffix of `closers`' source: "<", a URL or an address, ">". A URL runs from its
 * scheme to the first " " or ">", which must be a ">"; an address holds no " ", "<", ">" or second "@". An address
 * that matches after a scheme ends where the URL does, so only the URL is tried there.
 */
function autolinkPrefix(src: string, closers: InlineClosers): string | undefined {
	const scheme = /^<(?:https?:\/\/|ftp:\/\/)/i.exec(src);
	if (!scheme) return /^<[^ <>@]+@[^ <>@]+>/.exec(src)?.[0];
	const close = closers.closeUrlAutolink(src, scheme[0].length);
	return close === -1 ? undefined : src.slice(0, close + 1);
}

/** The inline HTML (a tag or a comment) at the start of `src`, a suffix of `closers`' source, or `undefined`. */
function inlineHtmlPrefix(src: string, closers: InlineClosers): string | undefined {
	if (src.startsWith("<!--")) {
		const end = closers.closeComment(src);
		return end === -1 ? undefined : src.slice(0, end + 3);
	}
	if (!/^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s|\/?>)/.test(src)) return undefined;
	const end = closers.closeTag(src);
	return end === -1 ? undefined : src.slice(0, end + 1);
}

/** Tokenizes the built-in inline Markdown surface. */
export class Tokenizer {
	options: MarkedOptions;
	lexer!: Lexer;
	/** Creates a tokenizer with the supplied options. */
	constructor(options: MarkedOptions = {}) {
		this.options = options;
	}
	/** Tokenizes GFM deletion. */
	del(src: string): Tokens.Del | undefined {
		if (!src.startsWith("~~") || /\s/.test(src[2] ?? "")) return undefined;
		const end = findDelimiter(src, "~~", 2);
		if (end < 2 || /\s/.test(src[end - 1] ?? "")) return undefined;
		const text = src.slice(2, end);
		return { type: "del", raw: src.slice(0, end + 2), text, tokens: this.lexer.inlineTokens(text) };
	}
}

// A nested inline source (a link label, the text of emphasis) shares the closers, text stops and tokenizer context of
// the source it lies in, which are offered to the next inline lex on that lexer. They are offered for the call that
// lexes the nested source through `lexer.inlineTokens`, which a subclass may override; the first lex that call
// reaches takes them if it lexes exactly that string, or else starts a root source.
let offered: { lexer: Lexer; nested: NestedMatch; outer: InlineLex } | undefined;

/** Starts the lex of `src` on `lexer`: of the nested source offered for it, else of a root source. Clears the offer. */
function openInlineSource(src: string, lexer: Lexer, output: Token[]): InlineLex {
	const offer = offered;
	offered = undefined;
	const shared = offer?.lexer === lexer && offer.nested.src === src ? offer : undefined;
	const closers = shared ? shared.nested.closers : new InlineClosers(new CloserIndexes(src), src.length);
	return {
		src,
		lexer,
		output,
		closers,
		stops: shared ? shared.outer.stops.nested(src, closers.end) : new TextStops(src, lexer),
		textRun: new TextRun(src),
		context: shared ? shared.outer.context : { lexer, source: src, end: src.length },
		rest: src,
	};
}

/**
 * Whether any label can resolve in `links`. The map every lexer starts with has no prototype, so it resolves none
 * until a definition is added.
 */
function hasDefinitions(links: Links): boolean {
	if (Object.getPrototypeOf(links) !== null) return true;
	for (const _label in links) return true;
	return false;
}

/**
 * A link, image, emphasis or strong emphasis token whose `tokens` are still to be lexed from `src`, a part of the
 * source that shares `closers`. `inlineTokens` lexes it once the rule that matched it has returned.
 */
interface NestedMatch {
	token: Tokens.Link | Tokens.Image | Tokens.Em | Tokens.Strong;
	src: string;
	closers: InlineClosers;
}

/** Matches a link or image at the start of `src`, a suffix of `closers`' source. */
function matchLink(src: string, lexer: Lexer, closers: InlineClosers): NestedMatch | undefined {
	const image = src.startsWith("![");
	if (!(image || src.startsWith("["))) return undefined;
	const labelStart = image ? 2 : 1;
	const labelEnd = closers.closeSquare(src, labelStart);
	if (labelEnd === -1) return undefined;
	const label = src.slice(labelStart, labelEnd);
	if (src[labelEnd + 1] === "(") {
		const destinationEnd = closers.closeRound(src, labelEnd + 2);
		if (destinationEnd === -1) return undefined;
		const inside = src.slice(labelEnd + 2, destinationEnd).trim();
		let href = inside;
		let title: string | null = null;
		const titleMatch = /^(<[^>]*>|\S+?)(?:\s+(?:"([\s\S]*)"|'([\s\S]*)'|\(([\s\S]*)\)))?$/.exec(inside);
		if (!titleMatch) return undefined;
		href = cleanUrl(titleMatch[1]!);
		title = titleMatch[2] ?? titleMatch[3] ?? titleMatch[4] ?? null;
		const raw = src.slice(0, destinationEnd + 1);
		// An image's text is its label unescaped. Nested images each unescape their label, so a label without an escape
		// is taken as it is instead of read again.
		return {
			token: image
				? {
						type: "image",
						raw,
						href,
						title,
						text: closers.escapeWithin(src, labelStart, labelEnd) ? unescapeMarkdown(label) : label,
						tokens: [],
					}
				: { type: "link", raw, href, title, text: label, tokens: [] },
			src: label,
			closers: closers.nested(src, labelEnd),
		};
	}
	let rawEnd = labelEnd + 1;
	let refStart = labelStart;
	let refEnd = labelEnd;
	if (src[rawEnd] === "[") {
		const end = closers.closeSquare(src, rawEnd + 1);
		if (end === -1) return undefined;
		if (end > rawEnd + 1) {
			refStart = rawEnd + 1;
			refEnd = end;
		}
		rawEnd = end + 1;
	}
	// Definition labels come from `[^\]]+`, so a reference holding an unescaped "]" names none. Skip normalizing it,
	// and every reference while there are no definitions.
	const links = lexer.tokens.links;
	if (!hasDefinitions(links) || closers.squareCloserWithin(src, refStart, refEnd)) return undefined;
	const def = links[src.slice(refStart, refEnd).replace(/\s+/g, " ").toLowerCase()];
	if (!def) return undefined;
	const raw = src.slice(0, rawEnd);
	return {
		token: image
			? {
					type: "image",
					raw,
					href: def.href,
					title: def.title ?? null,
					text: closers.escapeWithin(src, labelStart, labelEnd) ? unescapeMarkdown(label) : label,
					tokens: [],
				}
			: { type: "link", raw, href: def.href, title: def.title ?? null, text: label, tokens: [] },
		src: label,
		closers: closers.nested(src, labelEnd),
	};
}

/** Matches emphasis or strong emphasis at the start of `rest`, a suffix of `closers`' source, lexed after `output`. */
function matchEmphasis(rest: string, output: Token[], closers: InlineClosers): NestedMatch | undefined {
	const marker = rest[0];
	const previous = output.at(-1)?.raw.at(-1) ?? "\n";
	if (marker !== "*" && marker !== "_") return undefined;
	if (rest.startsWith(marker.repeat(3)) && canOpenDelimiter(rest, 0, 3, marker, previous)) {
		const end = findDelimiter(rest, marker.repeat(3), 3);
		if (end !== -1 && canCloseDelimiter(rest, end, marker)) {
			// The text between the delimiters inside the outer two markers of each: `**inner**`.
			const text = rest.slice(1, end + 2);
			return {
				token: { type: "em", raw: rest.slice(0, end + 3), text, tokens: [] },
				src: text,
				closers: closers.nested(rest, end + 2),
			};
		}
	}
	const width = rest[1] === marker ? 2 : 1;
	if (!canOpenDelimiter(rest, 0, width, marker, previous)) return undefined;
	const end = closers.closeEmphasis(rest, marker, width);
	if (end === -1) return undefined;
	const raw = rest.slice(0, end + width);
	const text = rest.slice(width, end);
	return {
		token: width === 2 ? { type: "strong", raw, text, tokens: [] } : { type: "em", raw, text, tokens: [] },
		src: text,
		closers: closers.nested(rest, end),
	};
}

function trimBareUrl(candidate: string): string {
	let end = candidate.length;
	while (end > 0 && ".,:;!?".includes(candidate[end - 1]!)) end--;
	let out = candidate.slice(0, end);
	let opens = 0;
	let closes = 0;
	for (const char of out) {
		if (char === "(") opens++;
		else if (char === ")") closes++;
	}
	while (closes > opens && out.endsWith(")")) {
		out = out.slice(0, -1);
		closes--;
	}
	return out;
}

/** The lex of one inline source, carried across the nested sources lexed inside it. */
interface InlineLex {
	readonly src: string;
	readonly lexer: Lexer;
	readonly output: Token[];
	readonly closers: InlineClosers;
	readonly stops: TextStops;
	readonly textRun: TextRun;
	readonly context: TokenizerThis;
	/** The part of `src` not lexed yet, always a suffix of it. */
	rest: string;
}

// Each level of nested links or emphasis keeps only this loop's small frame on the stack while the level inside it
// is lexed: the rules run in `lexToNested`, which returns each link, image or emphasis before its content is lexed.
function inlineTokens(src: string, lexer: Lexer, output: Token[]): Token[] {
	const lex = openInlineSource(src, lexer, output);
	for (let nested = lexToNested(lex); nested; nested = lexToNested(lex)) {
		offered = { lexer, nested, outer: lex };
		nested.token.tokens = lexer.inlineTokens(nested.src);
		// An override that returned without lexing the text leaves its offer to no later lex of an equal string.
		offered = undefined;
		output.push(nested.token);
	}
	return output;
}

/** Lexes `lex.rest` up to the next link, image or emphasis, which it returns with `lex.rest` past it, or to its end. */
function lexToNested(lex: InlineLex): NestedMatch | undefined {
	const { src, lexer, output, closers, stops, textRun, context } = lex;
	// The context is shared with the sources nested in this one, which move its end while they are lexed.
	context.end = closers.end;
	let rest = lex.rest;
	while (rest !== "") {
		let custom: Tokens.Generic | undefined;
		for (const extension of lexer.extensions.inline) {
			custom = extension.tokenizer.call(context, rest, output);
			if (custom?.raw) break;
		}
		if (custom?.raw) {
			output.push(custom);
			rest = rest.slice(custom.raw.length);
			continue;
		}

		const escaped = /^\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/.exec(rest);
		if (escaped) {
			output.push({ type: "escape", raw: escaped[0], text: escaped[1]! });
			rest = rest.slice(2);
			continue;
		}
		const br = lexer.options.breaks ? /^(?: {2,}|\\)?\n/.exec(rest) : /^(?: {2,}|\\)\n/.exec(rest);
		if (br) {
			output.push({ type: "br", raw: br[0] });
			rest = rest.slice(br[0].length);
			continue;
		}
		if (rest[0] === "`") {
			const width = closers.codeOpenerWidth(rest);
			const end = closers.closeCode(rest, width);
			if (end !== -1) {
				const raw = rest.slice(0, end + width);
				let text = rest.slice(width, end).replace(/\n/g, " ");
				if (/^ .* $/.test(text) && text.trim() !== "") text = text.slice(1, -1);
				output.push({ type: "codespan", raw, text });
				rest = rest.slice(raw.length);
				continue;
			}
		}
		const auto = autolinkPrefix(rest, closers);
		if (auto) {
			const text = auto.slice(1, -1);
			const href = text.includes("@") && !/^[a-z][a-z+.-]*:\/\//i.test(text) ? `mailto:${text}` : text;
			output.push({ type: "link", raw: auto, text, href, tokens: [{ type: "text", raw: text, text }] });
			rest = rest.slice(auto.length);
			continue;
		}
		const html = inlineHtmlPrefix(rest, closers);
		if (html) {
			output.push({ type: "html", raw: html, inLink: false, inRawBlock: false, block: false, text: html });
			rest = rest.slice(html.length);
			continue;
		}
		const nested = matchLink(rest, lexer, closers) ?? matchEmphasis(rest, output, closers);
		if (nested) {
			lex.rest = rest.slice(nested.token.raw.length);
			return nested;
		}
		if (rest.startsWith("~~")) {
			let del: Tokens.Del | undefined | false;
			const override = lexer.tokenizerOverrides.del;
			if (override) del = override.call(lexer.tokenizer, rest, rest);
			if (del === false || !override) del = lexer.tokenizer.del(rest);
			if (del) {
				output.push(del);
				rest = rest.slice(del.raw.length);
				continue;
			}
		}
		// `rest` is always a suffix of `src`, so its offset follows from the lengths.
		const pos = src.length - rest.length;
		let url: Tokens.Link | undefined | false;
		const urlOverride = lexer.tokenizerOverrides.url;
		if (urlOverride) url = urlOverride.call(lexer.tokenizer, rest);
		if (!urlOverride || url === false) {
			const match = stops.bareUrlCanStart(pos)
				? /^(?:(?:https?:\/\/|ftp:\/\/|www\.)[^\s<]+|[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)/i.exec(
						rest,
					)
				: null;
			if (match) {
				const text = trimBareUrl(match[0]);
				const href =
					text.includes("@") && !text.includes("://")
						? `mailto:${text}`
						: text.startsWith("www.")
							? `http://${text}`
							: text;
				url = { type: "link", raw: text, text, href, tokens: [{ type: "text", raw: text, text }] };
			}
		}
		if (url) {
			output.push(url);
			rest = rest.slice(url.raw.length);
			continue;
		}

		const next = stops.textLength(rest);
		textRun.append(output, pos, pos + next);
		rest = rest.slice(next);
	}
	lex.rest = rest;
	return undefined;
}

function splitTableRow(line: string): string[] {
	let value = line.trim();
	if (value.startsWith("|")) value = value.slice(1);
	if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
	const cells: string[] = [];
	let cell = "";
	for (let i = 0; i < value.length; i++) {
		const char = value[i]!;
		if (char === "|" && value[i - 1] !== "\\") {
			cells.push(cell.trim());
			cell = "";
		} else cell += char;
	}
	cells.push(cell.trim());
	return cells.map(entry => entry.replace(/\\\|/g, "|"));
}

function isFence(line: string): RegExpExecArray | null {
	return /^ {0,3}(`{3,}|~{3,})(.*?)(?:\n|$)$/.exec(line);
}
function isHeading(line: string): boolean {
	return /^ {0,3}#{1,6}(?:\s|$)/.test(line);
}
function isHr(line: string): boolean {
	return /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})(?:\n|$)$/.test(line);
}
function isList(line: string): RegExpExecArray | null {
	return /^( {0,3})((?:[*+-])|(?:\d{1,9}[.)]))(?:[ \t]+|(?=\n|$))(.*?)(?:\n|$)$/.exec(line);
}
function isBlockquote(line: string): boolean {
	return /^ {0,3}>/.test(line);
}
function isDefinition(line: string): boolean {
	return /^ {0,3}\[[^\]]+\]:/.test(line);
}
function isHtmlStart(line: string): boolean {
	return /^ {0,3}(?:<!--|<(?:script|pre|style|textarea|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>))/i.test(
		line,
	);
}
function isBlockStart(lines: string[], index: number): boolean {
	const line = lines[index] ?? "";
	if (/^\n+$/.test(line)) return true;
	if (
		isFence(line) ||
		isHeading(line) ||
		isHr(line) ||
		isList(line) ||
		isBlockquote(line) ||
		isDefinition(line) ||
		isHtmlStart(line) ||
		/^ {4}\S/.test(line)
	)
		return true;
	if (index + 1 < lines.length && /^ {0,3}(?:=+|-+)[ \t]*(?:\n|$)$/.test(lines[index + 1]!)) return true;
	if (
		index + 1 < lines.length &&
		line.includes("|") &&
		splitTableRow(lines[index + 1]!).every(c => /^:?-{1,}:?$/.test(c))
	)
		return true;
	return false;
}

// `[^\n]`, not `.`: `.` stops at U+2028 and U+2029, which end no Markdown line,
// and the match then skips the text in front of them.
function lineArray(src: string): string[] {
	return src.match(/[^\n]*(?:\n|$)/g)?.filter((line, index, all) => line !== "" || index < all.length - 1) ?? [];
}
function stripFinalNewline(value: string): string {
	return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function makeTable(lines: string[], index: number, lexer: Lexer): { token: Tokens.Table; count: number } | undefined {
	if (index + 1 >= lines.length) return undefined;
	const headerValues = splitTableRow(stripFinalNewline(lines[index]!));
	const delimiterValues = splitTableRow(stripFinalNewline(lines[index + 1]!));
	if (
		!lines[index]!.includes("|") ||
		headerValues.length !== delimiterValues.length ||
		!delimiterValues.every(c => /^:?-{1,}:?$/.test(c))
	)
		return undefined;
	const align = delimiterValues.map(cell =>
		cell.startsWith(":") && cell.endsWith(":")
			? ("center" as const)
			: cell.startsWith(":")
				? ("left" as const)
				: cell.endsWith(":")
					? ("right" as const)
					: null,
	);
	let count = 2;
	const body: string[][] = [];
	while (index + count < lines.length && !/^\s*\n?$/.test(lines[index + count]!)) {
		const cells = splitTableRow(stripFinalNewline(lines[index + count]!));
		if (cells.length === 1 && !lines[index + count]!.includes("|")) break;
		while (cells.length < headerValues.length) cells.push("");
		body.push(cells.slice(0, headerValues.length));
		count++;
	}
	const cell = (text: string, column: number, header: boolean): Tokens.TableCell => {
		const tokens: Token[] = [];
		lexer.inline(text, tokens);
		return { text, tokens, header, align: align[column]! };
	};
	return {
		token: {
			type: "table",
			raw: lines.slice(index, index + count).join(""),
			header: headerValues.map((text, column) => cell(text, column, true)),
			align,
			rows: body.map(row => row.map((text, column) => cell(text, column, false))),
		},
		count,
	};
}

function parseList(lines: string[], index: number, lexer: Lexer): { token: Tokens.List; count: number } | undefined {
	const first = isList(lines[index]!);
	if (!first) return undefined;
	const ordered = /^\d/.test(first[2]!);
	const delimiter = ordered ? first[2]!.at(-1)! : first[2]!;
	const start = ordered ? Number.parseInt(first[2]!, 10) : "";
	const rawItems: Array<{ raw: string; text: string; taskRaw?: string; checked?: boolean }> = [];
	let cursor = index;
	while (cursor < lines.length) {
		const match = isList(lines[cursor]!);
		if (
			!match ||
			/^\d/.test(match[2]!) !== ordered ||
			(ordered ? match[2]!.at(-1) !== delimiter : match[2] !== delimiter)
		)
			break;
		const itemStart = cursor;
		const markerWidth = match[1]!.length + match[2]!.length + 1;
		let text = match[3] ?? "";
		if (lines[cursor]!.endsWith("\n")) text += "\n";
		cursor++;
		while (cursor < lines.length) {
			const next = lines[cursor]!;
			const indent = /^ */.exec(next)![0].length;
			if (!/^\s*\n?$/.test(next) && indent <= first[1]!.length && isBlockStart(lines, cursor)) break;
			if (!/^\s/.test(next) && !/^\n$/.test(next)) break;
			if (/^\s*\n$/.test(next)) {
				let lookahead = cursor + 1;
				while (lookahead < lines.length && /^\s*\n$/.test(lines[lookahead]!)) lookahead++;
				// A blank line closes the list unless the next top-level line is a
				// compatible item (same bullet char / ordered delimiter) or indented
				// item content. The blank must stay OUTSIDE the list raw (it becomes
				// a `space` token) so token shape never depends on what follows —
				// real marked does the same, and the TUI's streaming freeze relies
				// on that append-stability. A blank run at end of input closes the
				// list the same way, keeping it tight and its raw blank-free.
				if (lookahead >= lines.length) break;
				const following = lines[lookahead]!;
				const followingIndent = /^ */.exec(following)![0].length;
				if (followingIndent <= first[1]!.length) {
					const followingList = isList(following);
					const compatible =
						followingList !== null &&
						/^\d/.test(followingList[2]!) === ordered &&
						(ordered ? followingList[2]!.at(-1) === delimiter : followingList[2] === delimiter);
					if (!compatible) break;
				}
				text += next;
			} else {
				const remove = Math.min(indent, markerWidth);
				text += next.slice(remove);
			}
			cursor++;
			if (/\n\s*\n$/.test(text) && cursor < lines.length && !/^\s/.test(lines[cursor]!)) break;
		}
		let raw = lines.slice(itemStart, cursor).join("");
		if (cursor === lines.length || (cursor < lines.length && /^\s*\n$/.test(lines[cursor]!)))
			raw = stripFinalNewline(raw);
		let taskRaw: string | undefined;
		let checked: boolean | undefined;
		const task = /^\[([ xX])\][ \t]+/.exec(text);
		if (task) {
			taskRaw = task[0];
			checked = task[1]!.toLowerCase() === "x";
			text = text.slice(task[0].length);
		}
		rawItems.push({ raw, text: stripFinalNewline(text), taskRaw, checked });
	}
	if (rawItems.length === 0) return undefined;
	const raw = lines.slice(index, cursor).join("");
	const loose = rawItems.some(item => /\n\s*\n/.test(item.raw)) || /\n\s*\n/.test(raw);
	const items = rawItems.map(item => {
		let tokens = lexer.blockTokens(item.text, []);
		if (!loose)
			tokens = tokens.map(token =>
				token.type === "paragraph"
					? ({ type: "text", raw: token.raw, text: token.text, tokens: token.tokens } as Tokens.Text)
					: token,
			);
		if (item.taskRaw !== undefined)
			tokens.unshift({ type: "checkbox", raw: item.taskRaw, checked: item.checked === true });
		const listItem: Tokens.ListItem = {
			type: "list_item",
			raw: item.raw,
			task: item.taskRaw !== undefined,
			loose,
			text: item.text,
			tokens,
		};
		if (item.checked !== undefined) listItem.checked = item.checked;
		return listItem;
	});
	return { token: { type: "list", raw, ordered, start, loose, items }, count: cursor - index };
}

function blockTokens(src: string, lexer: Lexer, output: Token[]): Token[] {
	const lines = lineArray(src);
	let i = 0;
	while (i < lines.length) {
		const remaining = lines.slice(i).join("");
		let custom: Tokens.Generic | undefined;
		for (const extension of lexer.extensions.block) {
			custom = extension.tokenizer.call({ lexer }, remaining, output);
			if (custom?.raw) break;
		}
		if (custom?.raw) {
			output.push(custom);
			let consumed = custom.raw.length;
			while (i < lines.length && consumed > 0) {
				consumed -= lines[i]!.length;
				i++;
			}
			continue;
		}
		const line = lines[i]!;
		if (/^\s*\n$/.test(line)) {
			let raw = "";
			while (i < lines.length && /^\s*\n$/.test(lines[i]!)) raw += lines[i++]!;
			if (output.length > 0) {
				const previous = output.at(-1)!;
				if (previous.raw.endsWith("\n")) previous.raw = previous.raw.slice(0, -1);
				raw = `\n${raw}`;
			}
			if (raw.length > 1) output.push({ type: "space", raw });
			continue;
		}
		const fence = isFence(line);
		if (fence) {
			const marker = fence[1]!;
			let raw = line;
			let text = "";
			i++;
			while (i < lines.length) {
				const next = lines[i++]!;
				if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\n|$)$`).test(next)) {
					raw += next;
					break;
				}
				raw += next;
				text += next;
			}
			text = stripFinalNewline(text);
			const rawToken = i < lines.length && /^\s*\n$/.test(lines[i]!) ? stripFinalNewline(raw) : raw;
			output.push({ type: "code", raw: rawToken, lang: fence[2]!.trim(), text });
			continue;
		}
		if (/^ {4}/.test(line)) {
			let raw = "";
			let text = "";
			while (i < lines.length && /^ {4}/.test(lines[i]!)) {
				raw += lines[i]!;
				text += lines[i]!.slice(4);
				i++;
				if (i < lines.length && /^\s*\n$/.test(lines[i]!) && i + 1 < lines.length && /^ {4}/.test(lines[i + 1]!)) {
					raw += lines[i]!;
					text += lines[i]!;
					i++;
				}
			}
			if (i < lines.length && /^\s*\n$/.test(lines[i]!)) {
				raw = stripFinalNewline(raw);
				text = stripFinalNewline(text);
			}
			output.push({ type: "code", raw, codeBlockStyle: "indented", text: text.replace(/\n+$/, "\n") });
			continue;
		}
		const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)(?:\n|$)$/.exec(line);
		if (heading) {
			const text = heading[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
			const raw = i + 1 < lines.length && /^\s*\n$/.test(lines[i + 1]!) ? stripFinalNewline(line) : line;
			const tokens: Token[] = [];
			lexer.inline(text, tokens);
			output.push({ type: "heading", raw, depth: heading[1]!.length, text, tokens });
			i++;
			continue;
		}
		if (isHr(line)) {
			output.push({ type: "hr", raw: line });
			i++;
			continue;
		}
		if (isBlockquote(line)) {
			let raw = "";
			let text = "";
			while (i < lines.length) {
				const next = lines[i]!;
				if (isBlockquote(next)) {
					raw += next;
					text += next.replace(/^ {0,3}>[ \t]?/, "");
					i++;
					continue;
				}
				if (!/^\s*\n$/.test(next) && !isBlockStart(lines, i)) {
					raw += next;
					text += next;
					i++;
					continue;
				}
				break;
			}
			text = stripFinalNewline(text);
			output.push({ type: "blockquote", raw, tokens: lexer.blockTokens(text, []), text });
			continue;
		}
		const list = parseList(lines, i, lexer);
		if (list) {
			output.push(list.token);
			i += list.count;
			continue;
		}
		if (isHtmlStart(line)) {
			let raw = line;
			const tag = /^ {0,3}<([A-Za-z][\w-]*)/.exec(line)?.[1]?.toLowerCase();
			i++;
			if (line.trimStart().startsWith("<!--")) {
				while (!raw.includes("-->") && i < lines.length) raw += lines[i++]!;
			} else if (tag && !new RegExp(`</${tag}>`, "i").test(raw)) {
				while (i < lines.length) {
					raw += lines[i++]!;
					if (new RegExp(`</${tag}>`, "i").test(raw)) break;
				}
			}
			const value = i < lines.length && /^\s*\n$/.test(lines[i]!) ? stripFinalNewline(raw) : raw;
			output.push({
				type: "html",
				block: true,
				raw: value,
				pre: tag === "pre" || tag === "script" || tag === "style",
				text: value,
			});
			continue;
		}
		const def =
			/^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*(?:\n|$)$/.exec(
				line,
			);
		if (def) {
			const tag = def[1]!.replace(/\s+/g, " ").toLowerCase();
			const href = cleanUrl(def[2] ?? def[3] ?? "");
			const title = def[4] ?? def[5] ?? def[6];
			lexer.tokens.links[tag] = { href, title: title ?? null };
			const token: Tokens.Def = { type: "def", tag, raw: line, href };
			if (title !== undefined) token.title = title;
			output.push(token);
			i++;
			continue;
		}
		const table = makeTable(lines, i, lexer);
		if (table) {
			output.push(table.token);
			i += table.count;
			continue;
		}
		if (i + 1 < lines.length && /^ {0,3}(=+|-+)[ \t]*(?:\n|$)$/.test(lines[i + 1]!)) {
			let fallback: Tokens.Heading | undefined | false;
			const override = lexer.tokenizerOverrides.lheading;
			if (override) fallback = override.call(lexer.tokenizer, remaining);
			if (!override || fallback === false) {
				const raw = line + lines[i + 1]!;
				const text = stripFinalNewline(line);
				const tokens: Token[] = [];
				lexer.inline(text, tokens);
				output.push({ type: "heading", raw, depth: lines[i + 1]!.trimStart()[0] === "=" ? 1 : 2, text, tokens });
				i += 2;
				continue;
			}
			if (fallback) {
				output.push(fallback);
				i += Math.max(1, lineArray(fallback.raw).length);
				continue;
			}
		}
		let raw = line;
		i++;
		// An indented code block cannot interrupt a paragraph (CommonMark lazy
		// continuation): a line indented by at least 4 spaces directly attached to
		// paragraph text stays inside the paragraph, bypassing every block-start
		// probe — matching marked's paragraph rule. After a whitespace-padded
		// blank line the indent is no longer attached, so it still opens an
		// indented code block.
		let prevBlankish = false;
		while (i < lines.length) {
			const next = lines[i]!;
			const indented = next.trim() !== "" && /^ {4}/.test(next);
			if (indented ? prevBlankish : isBlockStart(lines, i)) break;
			prevBlankish = next.trim() === "";
			raw += next;
			i++;
		}
		const text = stripFinalNewline(raw);
		const tokens: Token[] = [];
		lexer.inline(text, tokens);
		output.push({ type: "paragraph", raw, text, tokens });
	}
	return output;
}

const BLOCK_RULES = {
	normal: {
		blockquote: /^ {0,3}>/,
		code: /^ {4}/,
		def: /^ {0,3}\[/,
		fences: /^ {0,3}(?:```|~~~)/,
		heading: /^ {0,3}#/,
		hr: /^ {0,3}(?:\*|_|-)/,
		html: /^ {0,3}</,
		lheading: /^/,
		list: /^ {0,3}(?:[*+-]|\d+[.)])/,
		newline: /^\n+/,
		paragraph: /^/,
		table: /^/,
		text: /^[^\n]+/,
	},
	gfm: {} as Record<string, RegExp>,
	pedantic: {} as Record<string, RegExp>,
};
BLOCK_RULES.gfm = { ...BLOCK_RULES.normal };
BLOCK_RULES.pedantic = { ...BLOCK_RULES.normal };
const INLINE_RULES = {
	normal: {
		_backpedal: /^/,
		anyPunctuation: PUNCTUATION,
		autolink: /^</,
		blockSkip: /^/,
		br: /^(?: {2,}|\\)\n/,
		code: /^`+/,
		del: /^~~/,
		delLDelim: /^~~/,
		delRDelim: /^~~/,
		emStrongLDelim: /^[*_]/,
		emStrongRDelimAst: /\*/,
		emStrongRDelimUnd: /_/,
		escape: /^\\/,
		link: /^!?\[/,
		nolink: /^\[/,
		punctuation: PUNCTUATION,
		reflink: /^\[/,
		reflinkSearch: /\[/,
		tag: /^</,
		text: /^[\s\S]/,
		url: /^(?:https?:|ftp:|www\.)/,
	},
	gfm: {} as Record<string, RegExp>,
	breaks: {} as Record<string, RegExp>,
	pedantic: {} as Record<string, RegExp>,
};
INLINE_RULES.gfm = { ...INLINE_RULES.normal };
INLINE_RULES.breaks = { ...INLINE_RULES.normal };
INLINE_RULES.pedantic = { ...INLINE_RULES.normal };

/** Stateful block and inline Markdown lexer. */
export class Lexer {
	tokens: TokensList;
	options: MarkedOptions;
	state = { inLink: false, inRawBlock: false, top: true };
	inlineQueue: Array<{ src: string; tokens: Token[] }> = [];
	tokenizer: Tokenizer;
	tokenizerOverrides: TokenizerObject;
	extensions: ExtensionRegistry;
	/** Creates a lexer. */
	constructor(options: MarkedOptions = {}) {
		this.options = { ...DEFAULTS, ...options };
		this.tokens = tokenList();
		this.extensions = options.extensions ?? { block: [], inline: [], renderers: {}, childTokens: {} };
		this.tokenizer = options.tokenizer instanceof Tokenizer ? options.tokenizer : new Tokenizer(this.options);
		this.tokenizer.lexer = this;
		this.tokenizerOverrides =
			options.tokenizerOverrides ?? (options.tokenizer instanceof Tokenizer ? {} : (options.tokenizer ?? {}));
	}
	/** Exposes rule objects for callers that optimize regular expressions. */
	static get rules() {
		return { block: BLOCK_RULES, inline: INLINE_RULES };
	}
	/** Lexes a complete document. */
	static lex(src: string, options: MarkedOptions = {}): TokensList {
		return new Lexer(options).lex(src);
	}
	/** Lexes inline Markdown. */
	static lexInline(src: string, options: MarkedOptions = {}): Token[] {
		return new Lexer(options).inlineTokens(src);
	}
	/** Lexes and resolves a complete document. */
	lex(src: string): TokensList {
		this.tokens = tokenList();
		this.inlineQueue = [];
		this.blockTokens(normalizeSource(src), this.tokens);
		for (const queued of this.inlineQueue) this.inlineTokens(queued.src, queued.tokens);
		this.inlineQueue = [];
		return this.tokens;
	}
	/** Appends block tokens to an output array. */
	blockTokens(src: string, tokens: Token[] | TokensList = this.tokens): Token[] | TokensList {
		return blockTokens(src, this, tokens);
	}
	/** Queues inline tokenization compatibly with marked. */
	inline(src: string, tokens: Token[] = []): Token[] {
		this.inlineQueue.push({ src, tokens });
		return tokens;
	}
	/** Tokenizes inline Markdown immediately. */
	inlineTokens(src: string, tokens: Token[] = []): Token[] {
		return inlineTokens(src, this, tokens);
	}
}

/** Default HTML renderer. */
export class Renderer {
	options: MarkedOptions;
	parser!: Parser;
	overrides: RendererObject;
	/** Creates an HTML renderer. */
	constructor(options: MarkedOptions = {}, overrides: RendererObject = {}) {
		this.options = options;
		this.overrides = overrides;
	}
	/** Renders blank space. */ space(_token: Tokens.Space): string {
		return "";
	}
	/** Renders a code block. */ code({ text, lang, escaped }: Tokens.Code): string {
		const code = escaped ? text : escapeHtml(text);
		const language = (lang ?? "").match(/^\S*/)?.[0] ?? "";
		return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${code}${text.endsWith("\n") ? "" : "\n"}</code></pre>\n`;
	}
	/** Renders a block quote. */ blockquote({ tokens }: Tokens.Blockquote): string {
		return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
	}
	/** Passes raw HTML through. */ html({ text }: Tokens.HTML): string {
		return text;
	}
	/** Renders a definition as no output. */ def(_token: Tokens.Def): string {
		return "";
	}
	/** Renders a heading. */ heading({ tokens, depth }: Tokens.Heading): string {
		return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
	}
	/** Renders a horizontal rule. */ hr(_token: Tokens.Hr): string {
		return "<hr>\n";
	}
	/** Renders a list. */ list(token: Tokens.List): string {
		const tag = token.ordered ? "ol" : "ul";
		const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : "";
		return `<${tag}${start}>\n${token.items.map(item => this.parser.renderListItem(item)).join("")}</${tag}>\n`;
	}
	/** Renders a list item. */ listitem(item: Tokens.ListItem): string {
		return `<li>${this.parser.parse(item.tokens)}</li>\n`;
	}
	/** Renders a checkbox. */ checkbox({ checked }: Tokens.Checkbox): string {
		return `<input${checked ? ' checked=""' : ""} disabled="" type="checkbox">`;
	}
	/** Renders a paragraph. */ paragraph({ tokens }: Tokens.Paragraph): string {
		return `<p>${this.parser.parseInline(tokens)}</p>\n`;
	}
	/** Renders a table. */ table(token: Tokens.Table): string {
		const row = (cells: Tokens.TableCell[]) => `<tr>\n${cells.map(cell => this.tablecell(cell)).join("")}</tr>\n`;
		return `<table>\n<thead>\n${row(token.header)}</thead>\n${token.rows.length ? `<tbody>${token.rows.map(row).join("")}</tbody>` : ""}</table>\n`;
	}
	/** Renders a table row. */ tablerow(text: string): string {
		return `<tr>\n${text}</tr>\n`;
	}
	/** Renders a table cell. */ tablecell(token: Tokens.TableCell): string {
		const tag = token.header ? "th" : "td";
		return `<${tag}${token.align ? ` align="${token.align}"` : ""}>${this.parser.parseInline(token.tokens)}</${tag}>\n`;
	}
	/** Renders strong text. */ strong({ tokens }: Tokens.Strong): string {
		return `<strong>${this.parser.parseInline(tokens)}</strong>`;
	}
	/** Renders emphasized text. */ em({ tokens }: Tokens.Em): string {
		return `<em>${this.parser.parseInline(tokens)}</em>`;
	}
	/** Renders inline code. */ codespan({ text }: Tokens.Codespan): string {
		return `<code>${escapeHtml(text)}</code>`;
	}
	/** Renders a line break. */ br(_token: Tokens.Br): string {
		return "<br>";
	}
	/** Renders deleted text. */ del({ tokens }: Tokens.Del): string {
		return `<del>${this.parser.parseInline(tokens)}</del>`;
	}
	/** Renders a link. */ link({ href, title, tokens }: Tokens.Link): string {
		const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
		return `<a href="${escapeHtml(encodeURI(href))}"${titleAttr}>${this.parser.parseInline(tokens)}</a>`;
	}
	/** Renders an image. */ image({ href, title, text }: Tokens.Image): string {
		const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
		return `<img src="${escapeHtml(encodeURI(href))}" alt="${escapeHtml(text)}"${titleAttr}>`;
	}
	/** Renders plain text. */ text({ text }: Tokens.Text | Tokens.Escape): string {
		return escapeHtml(text, false);
	}
}

/** Converts token streams into HTML. */
export class Parser {
	options: MarkedOptions;
	renderer: Renderer;
	extensions: ExtensionRegistry;
	/** Creates a parser. */
	constructor(options: MarkedOptions = {}) {
		this.options = options;
		this.extensions = options.extensions ?? { block: [], inline: [], renderers: {}, childTokens: {} };
		const rendererOption = options.renderer;
		this.renderer = rendererOption instanceof Renderer ? rendererOption : new Renderer(options, rendererOption ?? {});
		this.renderer.parser = this;
	}
	/** Parses block tokens. */ static parse(tokens: Token[], options: MarkedOptions = {}): string {
		return new Parser(options).parse(tokens);
	}
	/** Parses inline tokens. */ static parseInline(tokens: Token[], options: MarkedOptions = {}): string {
		return new Parser(options).parseInline(tokens);
	}
	/** Parses block tokens with the configured renderer. */
	parse(tokens: Token[]): string {
		let out = "";
		for (const token of tokens) {
			const extension = this.extensions.renderers[token.type];
			if (extension) {
				const rendered = extension.call({ parser: this }, token);
				if (rendered !== false && rendered !== undefined) {
					out += rendered;
					continue;
				}
			}
			if (!isKnownToken(token)) {
				out += this.parseInline([token]);
				continue;
			}
			switch (token.type) {
				case "space":
					out += this.call("space", token, () => this.renderer.space(token));
					break;
				case "checkbox":
					out += `${this.renderer.checkbox(token)} `;
					break;
				case "hr":
					out += this.call("hr", token, () => this.renderer.hr(token));
					break;
				case "heading":
					out += this.call("heading", token, () => this.renderer.heading(token));
					break;
				case "code":
					out += this.call("code", token, () => this.renderer.code(token));
					break;
				case "blockquote":
					out += this.call("blockquote", token, () => this.renderer.blockquote(token));
					break;
				case "html":
					out += this.call("html", token, () => this.renderer.html(token));
					break;
				case "def":
					out += this.renderer.def(token);
					break;
				case "list":
					out += this.call("list", token, () => this.renderer.list(token));
					break;
				case "paragraph":
					out += this.call("paragraph", token, () => this.renderer.paragraph(token));
					break;
				case "table":
					out += this.renderer.table(token);
					break;
				case "text":
					out += token.tokens ? this.parseInline(token.tokens) : this.renderer.text(token);
					break;
				default:
					out += this.parseInline([token]);
			}
		}
		return out;
	}
	/** Parses inline tokens with the configured renderer. */
	parseInline(tokens: Token[]): string {
		let out = "";
		for (const token of tokens) {
			const extension = this.extensions.renderers[token.type];
			if (extension) {
				const rendered = extension.call({ parser: this }, token);
				if (rendered !== false && rendered !== undefined) {
					out += rendered;
					continue;
				}
			}
			if (!isKnownToken(token)) {
				if (token.tokens) out += this.parseInline(token.tokens);
				else if (typeof token.text === "string") out += escapeHtml(token.text);
				continue;
			}
			switch (token.type) {
				case "escape":
				case "text":
					out += this.call("text", token, () => this.renderer.text(token));
					break;
				case "checkbox":
					out += `${this.renderer.checkbox(token)} `;
					break;
				case "html":
					out += this.call("html", token, () => this.renderer.html(token));
					break;
				case "link":
					out += this.call("link", token, () => this.renderer.link(token));
					break;
				case "image":
					out += this.call("image", token, () => this.renderer.image(token));
					break;
				case "strong":
					out += this.call("strong", token, () => this.renderer.strong(token));
					break;
				case "em":
					out += this.call("em", token, () => this.renderer.em(token));
					break;
				case "codespan":
					out += this.call("codespan", token, () => this.renderer.codespan(token));
					break;
				case "br":
					out += this.call("br", token, () => this.renderer.br(token));
					break;
				case "del":
					out += this.call("del", token, () => this.renderer.del(token));
					break;
				default:
					if ("tokens" in token && token.tokens) out += this.parseInline(token.tokens);
					else if ("text" in token && typeof token.text === "string") out += escapeHtml(token.text);
			}
		}
		return out;
	}
	/** Renders a list item, including custom renderer overrides. */
	renderListItem(item: Tokens.ListItem): string {
		return this.call("listitem", item, () => this.renderer.listitem(item));
	}
	call<K extends keyof RendererTokenMap>(name: K, token: RendererTokenMap[K], fallback: () => string): string {
		const override = this.renderer.overrides[name];
		if (override) {
			const value = override.call(this.renderer, token);
			if (value !== false) return value;
		}
		return fallback();
	}
}

function freshExtensions(): ExtensionRegistry {
	return { block: [], inline: [], renderers: {}, childTokens: {} };
}
function mergeExtensions(
	current: ExtensionRegistry | null | undefined,
	additions: TokenizerAndRendererExtension[] | null | undefined,
): ExtensionRegistry {
	const registry = current ?? freshExtensions();
	for (const extension of additions ?? []) {
		if ("tokenizer" in extension) {
			registry[extension.level].unshift(extension);
			if (extension.childTokens) registry.childTokens[extension.name] = extension.childTokens;
		}
		if ("renderer" in extension) registry.renderers[extension.name] = extension.renderer;
	}
	return registry;
}

function walkTokenTree(
	tokens: Token[],
	callback: (token: Token) => void | Promise<void>,
	registry: ExtensionRegistry,
): Array<void | Promise<void>> {
	const values: Array<void | Promise<void>> = [];
	for (const token of tokens) {
		values.push(callback(token));
		const children: Token[][] = [];
		if ("tokens" in token && token.tokens) children.push(token.tokens);
		if (isKnownToken(token)) {
			if (token.type === "list") for (const item of token.items) children.push([item]);
			if (token.type === "table") {
				for (const cell of token.header) children.push(cell.tokens);
				for (const row of token.rows) for (const cell of row) children.push(cell.tokens);
			}
		}
		for (const key of registry.childTokens[token.type] ?? []) {
			const value: unknown = Reflect.get(token, key);
			if (Array.isArray(value)) children.push(value);
		}
		for (const child of children) values.push(...walkTokenTree(child, callback, registry));
	}
	return values;
}

/** Configurable Markdown lexer and HTML parser. */
export class Marked {
	defaults: MarkedOptions;
	/** Creates an isolated Marked instance. */
	constructor(...extensions: MarkedExtension[]) {
		this.defaults = { ...DEFAULTS, extensions: freshExtensions() };
		if (extensions.length) this.use(...extensions);
	}
	/** Merges default options. */ options(options: MarkedOptions): this {
		return this.setOptions(options);
	}
	/** Merges default options. */ setOptions(options: MarkedOptions): this {
		this.defaults = { ...this.defaults, ...options, extensions: options.extensions ?? this.defaults.extensions };
		return this;
	}
	/** Adds tokenizer, renderer, and walk-token extensions. */
	use(...extensions: MarkedExtension[]): this {
		for (const extension of extensions) {
			this.defaults.extensions = mergeExtensions(this.defaults.extensions, extension.extensions);
			if (extension.tokenizer) {
				if (this.defaults.tokenizer instanceof Tokenizer) {
					this.defaults.tokenizerOverrides = { ...this.defaults.tokenizerOverrides, ...extension.tokenizer };
				} else {
					this.defaults.tokenizer = { ...this.defaults.tokenizer, ...extension.tokenizer };
				}
			}
			if (extension.renderer)
				this.defaults.renderer = {
					...(this.defaults.renderer instanceof Renderer ? {} : this.defaults.renderer),
					...extension.renderer,
				};
			if (extension.walkTokens) {
				const previous = this.defaults.walkTokens;
				this.defaults.walkTokens = previous
					? token => {
							previous(token);
							return extension.walkTokens?.(token);
						}
					: extension.walkTokens;
			}
			for (const key of ["async", "breaks", "gfm", "pedantic", "silent"] as const)
				if (extension[key] !== undefined) this.defaults[key] = extension[key];
		}
		return this;
	}
	/** Lexes Markdown into tokens. */ lexer(src: string, options: MarkedOptions = {}): TokensList {
		return Lexer.lex(src, {
			...this.defaults,
			...options,
			extensions: options.extensions ?? this.defaults.extensions,
		});
	}
	/** Parses a token stream to HTML. */ parser(tokens: Token[], options: MarkedOptions = {}): string {
		return Parser.parse(tokens, {
			...this.defaults,
			...options,
			extensions: options.extensions ?? this.defaults.extensions,
		});
	}
	/** Walks a token tree depth first. */ walkTokens(
		tokens: Token[] | TokensList,
		callback: (token: Token) => void | Promise<void>,
	): Array<void | Promise<void>> {
		return walkTokenTree(tokens, callback, this.defaults.extensions ?? freshExtensions());
	}
	/** Parses Markdown to HTML, synchronously unless async mode is requested. */
	parse(src: string, options: MarkedOptions & { async: true }): Promise<string>;
	parse(src: string, options: MarkedOptions & { async: false }): string;
	parse(src: string, options?: MarkedOptions | null): string | Promise<string>;
	parse(src: string, options: MarkedOptions | null = null): string | Promise<string> {
		const merged = { ...this.defaults, ...options, extensions: options?.extensions ?? this.defaults.extensions };
		const tokens = Lexer.lex(src, merged);
		const walked = merged.walkTokens
			? walkTokenTree(tokens, merged.walkTokens, merged.extensions ?? freshExtensions())
			: [];
		if (merged.async) return Promise.all(walked).then(() => Parser.parse(tokens, merged));
		return Parser.parse(tokens, merged);
	}
	/** Parses inline Markdown to HTML. */ parseInline(src: string, options: MarkedOptions = {}): string {
		const merged = { ...this.defaults, ...options, extensions: options.extensions ?? this.defaults.extensions };
		return Parser.parseInline(Lexer.lexInline(src, merged), merged);
	}
}

const shared = new Marked();
/** Parses Markdown with a shared default instance. */
export function marked(src: string, options: MarkedOptions & { async: true }): Promise<string>;
export function marked(src: string, options: MarkedOptions & { async: false }): string;
export function marked(src: string, options?: MarkedOptions | null): string | Promise<string>;
export function marked(src: string, options: MarkedOptions | null = null): string | Promise<string> {
	return shared.parse(src, options);
}
/** Parses Markdown with a shared default instance. */
export const parse = marked;
/** Lexes Markdown with default options. */
export const lexer = Lexer.lex;
/** Parses inline Markdown with default options. */
export const parseInline = (src: string, options: MarkedOptions = {}): string => shared.parseInline(src, options);
/** Parses a token stream with default options. */
export const parser = Parser.parse;
/** The default option object. */
export const defaults = DEFAULTS;
/** Returns a fresh copy of the default options. */
export function getDefaults(): MarkedOptions {
	return { ...DEFAULTS };
}
