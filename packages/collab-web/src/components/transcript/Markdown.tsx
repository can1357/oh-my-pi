import type { Token } from "@oh-my-pi/pi-utils/marked";
import { Marked } from "@oh-my-pi/pi-utils/marked";
import { listMayContinueAt } from "@oh-my-pi/pi-utils/marked-list";
import type { ReactNode } from "react";
import { memo, useMemo, useRef } from "react";
import { escapeHtml } from "../../lib/format";
import { mathExtension } from "./math";

function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {}
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
function safeHref(href: string): string | null {
	const trimmed = href.trim();
	let protocol: string;
	try {
		// Resolve the scheme exactly as the browser will: the URL parser strips leading
		// C0 controls and embedded tab/newline that a text check would carry through.
		({ protocol } = new URL(trimmed, "https://relative.invalid/"));
	} catch {
		return null;
	}
	if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") return trimmed;
	return null; // unknown scheme (javascript:, data:, …)
}

const md = new Marked({
	gfm: true,
	renderer: {
		// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
		html({ text }) {
			const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			if (cleaned === "") return "";
			return escapeHtml(unescapeHtml(cleaned));
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
		},
	},
	breaks: true,
});
md.use(mathExtension);

function renderMarkdown(text: string): string {
	try {
		return md.parse(text, { async: false });
	} catch {
		return escapeHtml(text);
	}
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * Rendered leading blocks of a streaming text: `source` is the (tab-expanded)
 * text they cover, ending on a stable block boundary, and `html` their markup.
 */
export interface FrozenMarkdownPrefix {
	readonly source: string;
	readonly html: string;
}

const NO_PREFIX: FrozenMarkdownPrefix = { source: "", html: "" };

/**
 * An own-line display-math opener. A closer appended later turns the text from
 * it on into one block across blank lines, so nothing at or past it freezes.
 */
const MATH_OPENER_LINE = /^ {0,3}(?:\$\$|\\\[)[ \t]*$/m;
/** A whitespace-only line from the sticky offset, capturing its terminator ("\n", or "" at end of text). */
const WHITESPACE_LINE = /[^\S\n]*(\n|$)/y;

/**
 * Number of leading `tokens` (lexed from `src`) that end on a stable block
 * boundary: a blank-line break that no append to `src` can move, so that
 * `lex(src) = lex(head) ++ lex(tail)` for the current text and every
 * append-only extension of it. 0 when there is none.
 */
function stableTokenCount(src: string, tokens: readonly Token[]): { count: number; end: number } {
	const opener = MATH_OPENER_LINE.exec(src);
	const mathLimit = opener === null ? src.length : opener.index;
	let pos = 0;
	let count = 0;
	let end = 0;
	for (let i = 0; i < tokens.length; i++) {
		const raw = tokens[i]!.raw;
		const tokenEnd = pos + raw.length;
		if (tokenEnd > mathLimit) break;
		// The break must be followed by real block content: at end of text the
		// next line is unknown; a leading space or newline, or a line of other
		// whitespace, joins the blank run in front of the cut.
		if (raw.endsWith("\n\n") && tokenEnd < src.length) {
			const next = src.charCodeAt(tokenEnd);
			WHITESPACE_LINE.lastIndex = tokenEnd;
			const prev = i > 0 ? tokens[i - 1] : undefined;
			if (
				next !== 0x20 &&
				next !== 0x0a &&
				WHITESPACE_LINE.exec(src) === null &&
				(prev?.type !== "list" || !listMayContinueAt(src, tokenEnd, prev.raw))
			) {
				count = i + 1;
				end = tokenEnd;
			}
		}
		pos = tokenEnd;
	}
	return { count, end };
}

/**
 * Renders streaming Markdown `text`, reusing `prefix` (the result of the
 * previous call for an earlier version of the text) when `text` extends it.
 * Only the text after the prefix is lexed and parsed; blocks of it that end on
 * a stable boundary join the returned prefix. The markup equals
 * `md.parse(text)` byte for byte: anything the split cannot reproduce exactly
 * (reference definitions, carriage returns) renders the whole text instead.
 */
export function renderStreamingMarkdown(
	text: string,
	prefix: FrozenMarkdownPrefix,
): { html: string; prefix: FrozenMarkdownPrefix } {
	// `\r` rewrites line structure under marked's normalization; bail out.
	if (text.includes("\r")) return { html: renderMarkdown(text), prefix: NO_PREFIX };
	// Tabs expand to four spaces (as marked's own normalization does), so token
	// raws tile `src` exactly.
	const src = text.includes("\t") ? text.replaceAll("\t", "    ") : text;
	const base = src.length > prefix.source.length && src.startsWith(prefix.source) ? prefix : NO_PREFIX;
	const rest = base.source.length === 0 ? src : src.slice(base.source.length);
	try {
		const tokens = md.lexer(rest);
		// A reference definition resolves links anywhere, including the frozen
		// prefix, which was lexed without it; with no prefix, `tokens` already
		// lexed the whole text with its definitions.
		for (const _label in tokens.links) {
			return { html: base === NO_PREFIX ? md.parser(tokens) : renderMarkdown(text), prefix: NO_PREFIX };
		}
		const { count, end } = stableTokenCount(rest, tokens);
		if (count === 0) return { html: base.html + md.parser(tokens), prefix: base };
		const frozen: FrozenMarkdownPrefix = {
			source: src.slice(0, base.source.length + end),
			html: base.html + md.parser(tokens.slice(0, count)),
		};
		return { html: frozen.html + md.parser(tokens.slice(count)), prefix: frozen };
	} catch {
		return { html: renderMarkdown(text), prefix: NO_PREFIX };
	}
}

/**
 * {@link Markdown} for a block that is still streaming: settled leading
 * blocks are rendered once and reused, so each token re-parses only the open
 * tail instead of the whole growing block. Output is identical to
 * {@link Markdown} for the same text.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }): ReactNode {
	const prefixRef = useRef(NO_PREFIX);
	const html = useMemo(() => {
		const rendered = renderStreamingMarkdown(text, prefixRef.current);
		prefixRef.current = rendered.prefix;
		return rendered.html;
	}, [text]);
	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: html }} />;
});
