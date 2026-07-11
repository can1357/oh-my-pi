import { Marked } from "marked";
import type { ReactNode } from "react";
import { memo, useMemo } from "react";

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch (_) {}
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
	if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // unknown scheme (javascript:, data:, …)
	return trimmed; // relative / fragment
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

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const html = useMemo(() => {
		try {
			return md.parse(text, { async: false });
		} catch {
			return escapeHtml(text);
		}
	}, [text]);
	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: html }} />;
});
