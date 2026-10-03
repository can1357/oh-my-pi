import type * as DomNs from "@oh-my-pi/pi-utils/dom";
import type * as ReadabilityNs from "@oh-my-pi/pi-utils/readability";
import { htmlToBasicMarkdown } from "../../web/scrapers/types";

export type ReadableFormat = "text" | "markdown";

/** Options for scoping and reducing readable page extraction. */
export interface ReadableExtractOptions {
	/** Limit extraction to the first element matching this CSS selector. */
	selector?: string;
	/** Return only a compact Markdown-style heading outline. */
	outline?: boolean;
	/** Keep sections whose heading contains this case-insensitive substring. */
	filter?: string;
}

export interface ReadableResult {
	url: string;
	title?: string;
	byline?: string;
	excerpt?: string;
	contentLength: number;
	text?: string;
	markdown?: string;
}

/** Trim to non-empty string or undefined. */
function normalize(text: string | null | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed || undefined;
}

let readabilityModule: typeof ReadabilityNs | undefined;
async function loadReadability(): Promise<typeof ReadabilityNs> {
	if (!readabilityModule) {
		readabilityModule = await import("@oh-my-pi/pi-utils/readability");
	}
	return readabilityModule;
}

let domModule: typeof DomNs | undefined;
async function loadDom(): Promise<typeof DomNs> {
	if (!domModule) {
		domModule = await import("@oh-my-pi/pi-utils/dom");
	}
	return domModule;
}

/**
 * Extract readable content from raw HTML.
 * Tries Readability (article-isolation scoring) first, then falls back to a
 * CSS selector chain over the same pre-parsed DOM. Returns null if neither
 * path yields usable content.
 */
export async function extractReadableFromHtml(
	html: string,
	url: string,
	format: ReadableFormat,
	options: ReadableExtractOptions = {},
): Promise<ReadableResult | null> {
	const [{ parseHTML }, { Readability }] = await Promise.all([loadDom(), loadReadability()]);
	const { document } = parseHTML(html);
	const selected = options.selector ? document.querySelector(options.selector) : null;
	if (options.selector && !selected) return null;

	// --- Primary: Readability article extraction ---
	if (!selected) {
		const article = new Readability(document).parse();
		if (article) {
			const result = await toReadableResult(
				url,
				format,
				article.textContent,
				article.content,
				{
					title: article.title,
					byline: article.byline,
					excerpt: article.excerpt,
					length: article.length,
				},
				options,
			);
			if (result) return result;
		}
	}

	// --- Fallback: CSS selector chain ---
	const candidates = selected
		? [selected]
		: [
				document.querySelector("[data-pagefind-body]"),
				document.querySelector("main article"),
				document.querySelector("article"),
				document.querySelector("main"),
				document.querySelector("[role='main']"),
				document.body,
			];
	for (const el of candidates) {
		if (!el) continue;
		const innerHTML = el.innerHTML?.trim();
		const textContent = el.textContent?.trim();
		if (!innerHTML || !textContent) continue;
		const result = await toReadableResult(
			url,
			format,
			textContent,
			innerHTML,
			{
				title: document.title,
				excerpt: textContent.slice(0, 240),
				length: textContent.length,
			},
			options,
		);
		if (result) return result;
	}

	return null;
}

function markdownHeading(line: string): { level: number; title: string } | null {
	const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
	return match ? { level: match[1]!.length, title: match[2]! } : null;
}

/** Reduce Markdown to heading lines while preserving heading levels. */
export function extractMarkdownOutline(markdown: string): string {
	return markdown
		.split("\n")
		.filter(line => markdownHeading(line) !== null)
		.join("\n");
}

/** Keep complete Markdown sections selected by a heading substring. */
export function filterMarkdownSections(markdown: string, filter: string): string {
	const needle = filter.trim().toLocaleLowerCase();
	if (!needle) return markdown;
	const lines = markdown.split("\n");
	const keep = new Uint8Array(lines.length);
	for (let index = 0; index < lines.length; index++) {
		const heading = markdownHeading(lines[index]!);
		if (!heading || !heading.title.toLocaleLowerCase().includes(needle)) continue;
		let end = index + 1;
		while (end < lines.length) {
			const next = markdownHeading(lines[end]!);
			if (next && next.level <= heading.level) break;
			end++;
		}
		keep.fill(1, index, end);
	}
	return lines
		.filter((_, index) => keep[index] === 1)
		.join("\n")
		.trim();
}

function markdownToPlainText(markdown: string): string {
	return markdown
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/[*_`~]/g, "")
		.trim();
}

/** Shared builder for both extraction paths. */
async function toReadableResult(
	url: string,
	format: ReadableFormat,
	textContent: string | null | undefined,
	htmlContent: string | null | undefined,
	meta: { title?: string | null; byline?: string | null; excerpt?: string | null; length?: number | null },
	options: ReadableExtractOptions,
): Promise<ReadableResult | null> {
	const text = normalize(textContent);
	let processedMarkdown = normalize(await htmlToBasicMarkdown(htmlContent ?? "")) ?? text;
	if (!processedMarkdown) return null;
	if (options.filter) processedMarkdown = normalize(filterMarkdownSections(processedMarkdown, options.filter));
	if (!processedMarkdown) return null;
	if (options.outline) processedMarkdown = normalize(extractMarkdownOutline(processedMarkdown));
	if (!processedMarkdown) return null;
	const content = options.outline
		? processedMarkdown
		: format === "markdown"
			? processedMarkdown
			: options.filter
				? markdownToPlainText(processedMarkdown)
				: text;
	if (!content) return null;
	return {
		url,
		title: normalize(meta.title),
		byline: normalize(meta.byline),
		excerpt: normalize(meta.excerpt),
		contentLength: content.length,
		text: format === "text" ? content : undefined,
		markdown: format === "markdown" ? content : undefined,
	};
}
