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
}
/** A tokenizer extension callback. */
export type TokenizerExtensionFunction = (
	this: TokenizerThis,
	src: string,
	tokens: Token[] | TokensList,
) => Tokens.Generic | undefined;
/** A tokenizer extension start hint. */
export type TokenizerStartFunction = (this: TokenizerThis, src: string) => number | void;
/** An inline or block tokenizer extension. */
export interface TokenizerExtension {
	name: string;
	level: "block" | "inline";
	start?: TokenizerStartFunction;
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
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function tokenList(links: Links = {}): TokensList {
	const list = [] as unknown as TokensList;
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

function findClosingBracket(src: string, start: number, open: string, close: string): number {
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		if (src[i] === "\\") {
			i++;
			continue;
		}
		if (src[i] === open) depth++;
		else if (src[i] === close) {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

function findDelimiter(src: string, delimiter: string, from: number): number {
	let at = src.indexOf(delimiter, from);
	while (at !== -1) {
		let escapes = 0;
		for (let i = at - 1; i >= 0 && src[i] === "\\"; i--) escapes++;
		if (escapes % 2 === 0) return at;
		at = src.indexOf(delimiter, at + delimiter.length);
	}
	return -1;
}

function canOpenDelimiter(src: string, index: number, width: number, marker: string, previous = "\n"): boolean {
	const before = index === 0 ? previous : src[index - 1]!;
	if (index === 0 && before === marker) return false;
	const after = src[index + width];
	if (after === undefined || /\s/.test(after)) return false;
	if (marker === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return false;
	return true;
}

function canCloseDelimiter(src: string, index: number, marker: string): boolean {
	const before = src[index - 1];
	const after = src[index + 1] ?? "\n";
	if (before === undefined || /\s/.test(before)) return false;
	if (marker === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return false;
	return !PUNCTUATION.test(before) || /\s/.test(after) || PUNCTUATION.test(after);
}
function inlineHtmlPrefix(src: string): string | undefined {
	if (src.startsWith("<!--")) {
		const end = src.indexOf("-->", 4);
		return end === -1 ? undefined : src.slice(0, end + 3);
	}
	if (!/^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s|\/?>)/.test(src)) return undefined;
	let quote = "";
	for (let i = 1; i < src.length; i++) {
		const char = src[i]!;
		if (quote !== "") {
			if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ">") return src.slice(0, i + 1);
	}
	return undefined;
}

function appendText(tokens: Token[], raw: string, text = raw, escaped = false): void {
	if (raw === "") return;
	const previous = tokens.at(-1);
	if (previous?.type === "text" && previous.tokens === undefined && previous.escaped === escaped) {
		previous.raw += raw;
		previous.text += text;
		return;
	}
	tokens.push({ type: "text", raw, text, escaped });
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

function matchLink(src: string, lexer: Lexer): Tokens.Link | Tokens.Image | undefined {
	const image = src.startsWith("![");
	if (!(image || src.startsWith("["))) return undefined;
	const labelStart = image ? 2 : 1;
	const labelEnd = findClosingBracket(src, labelStart, "[", "]");
	if (labelEnd === -1) return undefined;
	const label = src.slice(labelStart, labelEnd);
	if (src[labelEnd + 1] === "(") {
		const destinationEnd = findClosingBracket(src, labelEnd + 2, "(", ")");
		if (destinationEnd === -1) return undefined;
		const inside = src.slice(labelEnd + 2, destinationEnd).trim();
		let href = inside;
		let title: string | null = null;
		const titleMatch = /^(<[^>]*>|\S+?)(?:\s+(?:"([\s\S]*)"|'([\s\S]*)'|\(([\s\S]*)\)))?$/.exec(inside);
		if (!titleMatch) return undefined;
		href = cleanUrl(titleMatch[1]!);
		title = titleMatch[2] ?? titleMatch[3] ?? titleMatch[4] ?? null;
		const raw = src.slice(0, destinationEnd + 1);
		const tokens = lexer.inlineTokens(label);
		return image
			? { type: "image", raw, href, title, text: unescapeMarkdown(label), tokens }
			: { type: "link", raw, href, title, text: label, tokens };
	}
	let rawEnd = labelEnd + 1;
	let ref = label;
	if (src[rawEnd] === "[") {
		const refEnd = findClosingBracket(src, rawEnd + 1, "[", "]");
		if (refEnd === -1) return undefined;
		ref = src.slice(rawEnd + 1, refEnd) || label;
		rawEnd = refEnd + 1;
	}
	const def = lexer.tokens.links[ref.replace(/\s+/g, " ").toLowerCase()];
	if (!def) return undefined;
	const raw = src.slice(0, rawEnd);
	const tokens = lexer.inlineTokens(label);
	return image
		? { type: "image", raw, href: def.href, title: def.title ?? null, text: unescapeMarkdown(label), tokens }
		: { type: "link", raw, href: def.href, title: def.title ?? null, text: label, tokens };
}

function trimBareUrl(candidate: string): string {
	let out = candidate;
	while (/[.,:;!?]$/.test(out)) out = out.slice(0, -1);
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

function inlineTokens(src: string, lexer: Lexer, output: Token[] = []): Token[] {
	let rest = src;
	while (rest !== "") {
		let custom: Tokens.Generic | undefined;
		for (const extension of lexer.extensions.inline) {
			custom = extension.tokenizer.call({ lexer }, rest, output);
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
			const opener = /^`+/.exec(rest)![0];
			const end = findDelimiter(rest, opener, opener.length);
			if (end !== -1) {
				const raw = rest.slice(0, end + opener.length);
				let text = rest.slice(opener.length, end).replace(/\n/g, " ");
				if (/^ .* $/.test(text) && text.trim() !== "") text = text.slice(1, -1);
				output.push({ type: "codespan", raw, text });
				rest = rest.slice(raw.length);
				continue;
			}
		}
		const auto = /^<((?:https?:\/\/|ftp:\/\/)[^ >]+|[^ <>@]+@[^ <>@]+)>/i.exec(rest);
		if (auto) {
			const text = auto[1]!;
			const href = text.includes("@") && !/^[a-z][a-z+.-]*:\/\//i.test(text) ? `mailto:${text}` : text;
			output.push({ type: "link", raw: auto[0], text, href, tokens: [{ type: "text", raw: text, text }] });
			rest = rest.slice(auto[0].length);
			continue;
		}
		const html = inlineHtmlPrefix(rest);
		if (html) {
			output.push({ type: "html", raw: html, inLink: false, inRawBlock: false, block: false, text: html });
			rest = rest.slice(html.length);
			continue;
		}
		const link = matchLink(rest, lexer);
		if (link) {
			output.push(link);
			rest = rest.slice(link.raw.length);
			continue;
		}

		const marker = rest[0];
		const previous = output.at(-1)?.raw.at(-1) ?? "\n";
		if (
			(marker === "*" || marker === "_") &&
			rest.startsWith(marker.repeat(3)) &&
			canOpenDelimiter(rest, 0, 3, marker, previous)
		) {
			const end = findDelimiter(rest, marker.repeat(3), 3);
			if (end !== -1 && canCloseDelimiter(rest, end, marker)) {
				const raw = rest.slice(0, end + 3);
				const inner = rest.slice(3, end);
				const text = `${marker.repeat(2)}${inner}${marker.repeat(2)}`;
				output.push({ type: "em", raw, text, tokens: lexer.inlineTokens(text) });
				rest = rest.slice(raw.length);
				continue;
			}
		}
		if (
			(marker === "*" || marker === "_") &&
			canOpenDelimiter(rest, 0, rest[1] === marker ? 2 : 1, marker, previous)
		) {
			const width = rest[1] === marker ? 2 : 1;
			const delimiter = marker.repeat(width);
			let end = findDelimiter(rest, delimiter, width);
			let nested = 0;
			while (end !== -1) {
				if (!canCloseDelimiter(rest, end, marker) && canOpenDelimiter(rest, end, width, marker)) {
					nested++;
				} else if (canCloseDelimiter(rest, end, marker) && nested > 0) {
					nested--;
				} else if (canCloseDelimiter(rest, end, marker)) {
					break;
				}
				end = findDelimiter(rest, delimiter, end + width);
			}
			if (end !== -1) {
				const raw = rest.slice(0, end + width);
				const text = rest.slice(width, end);
				const tokens = lexer.inlineTokens(text);
				output.push(width === 2 ? { type: "strong", raw, text, tokens } : { type: "em", raw, text, tokens });
				rest = rest.slice(raw.length);
				continue;
			}
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
		let url: Tokens.Link | undefined | false;
		const urlOverride = lexer.tokenizerOverrides.url;
		if (urlOverride) url = urlOverride.call(lexer.tokenizer, rest);
		if (!urlOverride || url === false) {
			const match =
				/^(?:(?:https?:\/\/|ftp:\/\/|www\.)[^\s<]+|[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)/i.exec(
					rest,
				);
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

		let next = rest.length;
		for (const char of ["\\", "`", "<", "[", "!", "*", "_", "~", "\n"]) {
			const at = rest.indexOf(char, 1);
			if (at !== -1 && at < next) next = at;
		}
		const urlAt = /(?:https?:\/\/|ftp:\/\/|www\.|[A-Za-z0-9._+-]+@)/i.exec(rest.slice(1));
		if (urlAt && urlAt.index + 1 < next) next = urlAt.index + 1;
		const hardBreak = /(?: {2,}|\\)\n/.exec(rest.slice(1));
		if (hardBreak && hardBreak.index + 1 < next) next = hardBreak.index + 1;
		for (const extension of lexer.extensions.inline) {
			const at = extension.start?.call({ lexer }, rest);
			if (typeof at === "number" && at > 0 && at < next) next = at;
		}
		if (next === 0) next = 1;
		appendText(output, rest.slice(0, next));
		rest = rest.slice(next);
	}
	return output;
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

function lineArray(src: string): string[] {
	return src.match(/.*(?:\n|$)/g)?.filter((line, index, all) => line !== "" || index < all.length - 1) ?? [];
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
