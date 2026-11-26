/**
 * Inline Markdown → one styled string (may hold `\n` from hard breaks and
 * soft line breaks; the block renderer wraps it).
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { latexToUnicode } from "../latex";
import type { MathToken, Token, Tokens } from "./lexer";
import { extensionLinkMarker } from "./links";
import type { MarkdownStyles } from "./styles";

/** How plain text is drawn where inline content sits. */
export interface InlineContext {
	/** Style of plain text runs. */
	text(text: string): string;
	/** What re-opens the surrounding style after a styled run closed its attributes or color. */
	readonly restore: string;
}

/** Context of unstyled prose. */
export const PLAIN_CONTEXT: InlineContext = { text: text => text, restore: "" };

/** Inputs of inline rendering that do not change per token. */
export interface InlineEnvironment {
	readonly styles: MarkdownStyles;
	/** Wrap links in OSC 8 hyperlinks. */
	readonly hyperlinks: boolean;
	/**
	 * Draw ` (href)` after a link label that is not the href itself (default
	 * true). `false` is the host's setting: on a terminal without OSC 8 the
	 * suffix still draws so the target stays visible. `"never"` is a layout
	 * choice (sized headings, pickers): no suffix whatever the terminal.
	 */
	readonly linkUrls?: boolean | "never";
	/** The hyperlink target of an href (a resolved relative path); the href itself when undefined. */
	readonly linkTarget?: (href: string) => string | undefined;
	/** Whether an href is an extension link (its scheme registered by the host). */
	readonly extensionLink?: (href: string) => boolean;
	/** Literal runs drawn as these spans wherever they occur in prose. */
	readonly marks?: readonly TspSpan[];
}

const ENTITY: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/** Decode HTML character references (`&amp;`, `&#128512;`, `&#x1F600;`). */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (whole, body: string) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITY[body.toLowerCase()] ?? whole;
	});
}

/** A hex color written in prose: 6 digits, or 3 digits with at least one letter; not part of a word. */
const PROSE_HEX = /(^|[^\w#&])(#(?:[\da-f]{6}|(?=[\da-f]{0,2}[a-f])[\da-f]{3}))(?![\w-])/gi;
const CODE_HEX = /^#(?:[\da-f]{6}|(?=[\da-f]{0,2}[a-f])[\da-f]{3})$/i;

function rgbOf(hex: string): [number, number, number] {
	const digits = hex.length === 4 ? hex.slice(1).replace(/./g, "$&$&") : hex.slice(1);
	return [
		Number.parseInt(digits.slice(0, 2), 16),
		Number.parseInt(digits.slice(2, 4), 16),
		Number.parseInt(digits.slice(4, 6), 16),
	];
}

/** A color swatch glyph in the color, then the code on a fill of it with a readable foreground. */
function swatch(env: InlineEnvironment, hex: string): string {
	const [r, g, b] = rgbOf(hex);
	const glyph = env.styles.theme.symbols.symbol("md.colorSwatch") || "■";
	const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
	const ink = light ? "0;0;0" : "255;255;255";
	return `\x1b[38;2;${r};${g};${b}m${glyph}\x1b[39m \x1b[48;2;${r};${g};${b}m\x1b[38;2;${ink}m${hex}\x1b[39m\x1b[49m`;
}

/** Plain text with marks applied. */
function markedText(env: InlineEnvironment, ctx: InlineContext, text: string): string {
	const marks = env.marks;
	if (!marks || marks.length === 0) return ctx.text(text);
	let best: { at: number; mark: TspSpan } | undefined;
	for (const mark of marks) {
		if (mark.t === "") continue;
		const at = text.indexOf(mark.t);
		if (at !== -1 && (best === undefined || at < best.at)) best = { at, mark };
	}
	if (!best) return ctx.text(text);
	const before = text.slice(0, best.at);
	const after = text.slice(best.at + best.mark.t.length);
	const styled = env.styles.theme.style(best.mark.s, best.mark.t);
	return (before ? ctx.text(before) : "") + styled + ctx.restore + (after ? markedText(env, ctx, after) : "");
}

/** A prose text run: entities decoded, hex colors swatched, marks applied. */
function proseText(env: InlineEnvironment, ctx: InlineContext, raw: string): string {
	const text = decodeEntities(raw);
	if (!text.includes("#")) return markedText(env, ctx, text);
	let out = "";
	let last = 0;
	PROSE_HEX.lastIndex = 0;
	for (let match = PROSE_HEX.exec(text); match; match = PROSE_HEX.exec(text)) {
		const start = match.index + match[1]!.length;
		if (start > last) out += markedText(env, ctx, text.slice(last, start));
		out += swatch(env, match[2]!) + ctx.restore;
		last = start + match[2]!.length;
	}
	if (last < text.length) out += markedText(env, ctx, text.slice(last));
	return out;
}

/** An HTML tag: its lowercase name, whether it closes, and its attributes. */
interface Tag {
	readonly name: string;
	readonly closing: boolean;
	readonly attributes: string;
}

const TAG = /^<(\/?)([a-z][a-z0-9]*)\b([^>]*)>$/i;
const COMMENT = /^<!--[\s\S]*?-->$/;

/** Tags drawn as structure (breaks, lists, paragraphs, code); any other tag shows as written. */
export const FORMATTING_TAGS: Readonly<Record<string, true>> = {
	br: true,
	hr: true,
	p: true,
	ul: true,
	ol: true,
	li: true,
	code: true,
	span: true,
	text: true,
	blockquote: true,
};

function parseTag(raw: string): Tag | undefined {
	const match = TAG.exec(raw.trim());
	if (!match) return undefined;
	return { name: match[2]!.toLowerCase(), closing: match[1] === "/", attributes: match[3]! };
}

/** Whether styled text ends at the start of a line. */
function atLineStart(text: string): boolean {
	return text === "" || /\n(?:\x1b\[[\d;]*m)*$/.test(text);
}

/** Trailing spaces before a line break are not drawn. */
function trimLineEnd(text: string): string {
	return text.replace(/ +((?:\x1b\[[\d;]*m)*)$/, "$1");
}

function osc8(target: string, text: string): string {
	return `\x1b]8;;${target}\x07${text}\x1b]8;;\x07`;
}

function renderLink(env: InlineEnvironment, ctx: InlineContext, token: Tokens.Link): string {
	const { styles } = env;
	const href = token.href;
	if (env.extensionLink?.(href)) {
		const label = styles.extensionLink(styles.underline(renderInline(env, token.tokens, ctx)));
		return extensionLinkMarker(href, label) + ctx.restore;
	}
	const label = styles.link(styles.underline(renderInline(env, token.tokens, ctx)));
	const target = env.linkTarget?.(href) ?? href;
	const bare = token.text === href || href === `mailto:${token.text}`;
	let out = env.hyperlinks ? osc8(target, label) : label;
	// Without OSC 8 the label alone loses the destination, so the suffix draws
	// even when the host hides link URLs.
	if (!bare && env.linkUrls !== "never" && (env.linkUrls !== false || !env.hyperlinks)) {
		const url = styles.linkUrl(`(${href})`);
		out += ` ${env.hyperlinks ? osc8(target, url) : url}`;
	}
	return out + ctx.restore;
}

/** Open HTML lists while rendering a run of inline tokens. */
interface HtmlList {
	readonly ordered: boolean;
	next: number;
}

/** Render inline tokens in `ctx`. */
export function renderInline(env: InlineEnvironment, tokens: readonly Token[], ctx: InlineContext): string {
	const { styles } = env;
	let out = "";
	// A line break swallows the spaces around it.
	let afterBreak = false;
	// A closed `<p>` puts what follows on its own line.
	let pendingBreak = false;
	// Right after an `<li>` marker a `<p>` starts no new line.
	let afterMarker = false;
	const lists: HtmlList[] = [];
	const lineBreak = (): void => {
		out = `${trimLineEnd(out)}\n`;
		afterBreak = true;
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		const breakBefore: boolean = afterBreak;
		afterBreak = false;
		if (token.type === "html") {
			const raw = (token as Tokens.HTML).raw;
			const tag = parseTag(raw);
			if (COMMENT.test(raw.trim())) {
				afterBreak = breakBefore;
				continue;
			}
			if (!tag || !FORMATTING_TAGS[tag.name]) {
				if (pendingBreak && !atLineStart(out)) lineBreak();
				pendingBreak = false;
				afterMarker = false;
				out += proseText(env, ctx, raw);
				continue;
			}
			switch (tag.name) {
				case "br":
				case "hr":
					if (!tag.closing) lineBreak();
					break;
				case "span":
				case "text":
				case "blockquote":
					afterBreak = breakBefore;
					break;
				case "code": {
					if (tag.closing) break;
					const close = tokens.findIndex(
						(next, at) => at > index && next.type === "html" && parseTag(next.raw)?.name === "code",
					);
					if (close === -1) break;
					const code = decodeEntities(
						tokens
							.slice(index + 1, close)
							.map(next => next.raw)
							.join(""),
					);
					if (pendingBreak && !atLineStart(out)) lineBreak();
					pendingBreak = false;
					out += styles.code(code) + ctx.restore;
					index = close;
					break;
				}
				case "ul":
				case "ol":
					if (tag.closing) {
						lists.pop();
						pendingBreak = true;
					} else {
						const start = /\bstart\s*=\s*["']?(\d+)/i.exec(tag.attributes);
						lists.push({ ordered: tag.name === "ol", next: start ? Number(start[1]) : 1 });
						if (!atLineStart(out)) lineBreak();
					}
					break;
				case "li": {
					if (tag.closing) break;
					if (!atLineStart(out)) lineBreak();
					const list = lists.at(-1);
					const depth = Math.max(0, lists.length - 1);
					const marker = list?.ordered
						? `${list.next++}. `
						: `${styles.theme.symbols.symbol("md.bullet") || "•"} `;
					out += " ".repeat(depth * 2) + styles.bullet(marker);
					pendingBreak = false;
					afterMarker = true;
					continue;
				}
				case "p":
					if (tag.closing) pendingBreak = true;
					else if (!afterMarker && !atLineStart(out)) lineBreak();
					else afterBreak = breakBefore;
					break;
			}
			afterMarker = afterMarker && tag.name === "p" && !tag.closing;
			continue;
		}
		if (token.type === "text" && !(token as Tokens.Text).tokens && (token as Tokens.Text).text.trim() === "") {
			// Formatting whitespace between structural tags draws nothing.
			if (lists.length > 0 || pendingBreak || afterMarker || breakBefore) {
				afterBreak = breakBefore;
				continue;
			}
		}
		if (pendingBreak && !atLineStart(out)) lineBreak();
		pendingBreak = false;
		afterMarker = false;
		switch (token.type) {
			case "text": {
				const text = token as Tokens.Text;
				if (text.tokens) out += renderInline(env, text.tokens, ctx);
				else out += proseText(env, ctx, breakBefore ? text.text.trimStart() : text.text);
				break;
			}
			case "escape":
				out += ctx.text((token as Tokens.Escape).text);
				break;
			case "strong":
				out += styles.strong(renderInline(env, (token as Tokens.Strong).tokens, ctx)) + ctx.restore;
				break;
			case "em":
				out += styles.em(renderInline(env, (token as Tokens.Em).tokens, ctx)) + ctx.restore;
				break;
			case "del":
				out += styles.strike(renderInline(env, (token as Tokens.Del).tokens, ctx)) + ctx.restore;
				break;
			case "codespan": {
				const code = decodeEntities((token as Tokens.Codespan).text);
				out += (CODE_HEX.test(code) ? swatch(env, code) : styles.code(code)) + ctx.restore;
				break;
			}
			case "link":
				out += renderLink(env, ctx, token as Tokens.Link);
				break;
			case "image":
				out += ctx.text((token as Tokens.Image).text);
				break;
			case "br":
				lineBreak();
				break;
			case "math":
				out += ctx.text(latexToUnicode((token as unknown as MathToken).text));
				break;
			case "checkbox":
				break;
			default:
				out += ctx.text(token.raw);
		}
	}
	return out;
}
