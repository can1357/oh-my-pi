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
 * Elements that end a line of rendered text, which `textContent` runs together. As in `innerText`,
 * `<p>` also leaves a blank line, `<br>` is one line break, and table cells are tab-separated.
 */
const BLOCK_TAGS: Readonly<Record<string, true>> = {
	ADDRESS: true,
	ARTICLE: true,
	ASIDE: true,
	BLOCKQUOTE: true,
	CAPTION: true,
	DD: true,
	DETAILS: true,
	DIALOG: true,
	DIV: true,
	DL: true,
	DT: true,
	FIELDSET: true,
	FIGCAPTION: true,
	FIGURE: true,
	FOOTER: true,
	FORM: true,
	H1: true,
	H2: true,
	H3: true,
	H4: true,
	H5: true,
	H6: true,
	HEADER: true,
	HR: true,
	LI: true,
	MAIN: true,
	NAV: true,
	OL: true,
	P: true,
	PRE: true,
	SECTION: true,
	SUMMARY: true,
	TABLE: true,
	TR: true,
	UL: true,
};
/** Never rendered as text; skipped below the extraction root. */
const SKIP_TAGS: Readonly<Record<string, true>> = { SCRIPT: true, STYLE: true, NOSCRIPT: true, TEMPLATE: true };
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Text of a subtree with line breaks where the document has block boundaries.
 * Whitespace outside `<pre>` is collapsed the way a renderer collapses it;
 * `<pre>` keeps its indentation and blank lines. A raw-text root (`<script>`,
 * `<template>`, …) returns its text as is. Only trailing whitespace is trimmed,
 * so a leading empty-cell tab keeps the first row's columns aligned.
 */
function blockText(root: DomNs.Element): string {
	if (SKIP_TAGS[root.tagName.toUpperCase()]) return (root.textContent ?? "").trimEnd();
	// Parts are never empty, so the last part's last character is the output's.
	// Only the last parts are ever rewritten, which keeps the walk linear.
	const parts: string[] = [];
	let pendingBreaks = 0;
	let cellsInRow = 0;
	const append = (text: string): void => {
		if (pendingBreaks > 0) {
			while (parts.length > 0) {
				const last = parts[parts.length - 1]!.replace(/[ \t]+$/, "");
				if (last) {
					parts[parts.length - 1] = last;
					parts.push("\n".repeat(pendingBreaks));
					break;
				}
				parts.pop();
			}
			pendingBreaks = 0;
		}
		parts.push(text);
	};
	const walk = (node: DomNs.Node, pre: boolean): void => {
		if (node.nodeType === TEXT_NODE) {
			let text = node.textContent ?? "";
			if (!pre) {
				// ASCII whitespace only: `&nbsp;` is not collapsed by renderers either.
				text = text.replace(/[ \t\n\r\f]+/g, " ");
				const last = parts[parts.length - 1];
				if (pendingBreaks > 0 || !last || " \n\t".includes(last.at(-1)!)) text = text.replace(/^ /, "");
			}
			if (text) append(text);
			return;
		}
		if (node.nodeType !== ELEMENT_NODE) return;
		const tag = (node as DomNs.Element).tagName.toUpperCase();
		if (node !== root && SKIP_TAGS[tag]) return;
		if (tag === "BR") {
			if (parts.length > 0) pendingBreaks++;
			return;
		}
		if (tag === "TR") cellsInRow = 0;
		if (tag === "TD" || tag === "TH") {
			// One tab per cell boundary, so empty cells keep later values in their column.
			if (cellsInRow > 0) append("\t");
			cellsInRow++;
		}
		const breaks = tag === "P" ? 2 : BLOCK_TAGS[tag] ? 1 : 0;
		pendingBreaks = Math.max(pendingBreaks, breaks);
		for (const child of node.childNodes) walk(child, pre || tag === "PRE");
		pendingBreaks = Math.max(pendingBreaks, breaks);
	};
	walk(root, root.parentElement?.closest("pre") != null);
	return parts.join("").trimEnd();
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
	const [{ parseHTML, Element }, { Readability }] = await Promise.all([loadDom(), loadReadability()]);
	const { document } = parseHTML(html);
	const selected = options.selector ? document.querySelector(options.selector) : null;
	if (options.selector && !selected) return null;

	// --- Primary: Readability article extraction ---
	if (!selected) {
		// Keep the article element: text mode walks it for block boundaries, which Readability's
		// `textContent` lacks, and markup is serialized only when Markdown is needed.
		const article = new Readability(document, {
			serializer: node => (node instanceof Element ? node : null),
		}).parse();
		if (article) {
			const content = article.content;
			const result = await toReadableResult(
				url,
				format,
				format === "text" && content ? blockText(content) : article.textContent?.trim(),
				() => content?.innerHTML,
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
		const textContent = format === "text" ? blockText(el) : el.textContent?.trim();
		if (!innerHTML || !textContent) continue;
		const result = await toReadableResult(
			url,
			format,
			textContent,
			() => innerHTML,
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

/** Markdown-derived content for Markdown output or a filtered/outlined view; undefined once a step leaves nothing. */
async function markdownContent(
	format: ReadableFormat,
	text: string | undefined,
	htmlContent: string | null | undefined,
	options: ReadableExtractOptions,
): Promise<string | undefined> {
	let processedMarkdown = normalize(await htmlToBasicMarkdown(htmlContent ?? "")) ?? text;
	if (!processedMarkdown) return undefined;
	if (options.filter) processedMarkdown = normalize(filterMarkdownSections(processedMarkdown, options.filter));
	if (!processedMarkdown) return undefined;
	if (options.outline) processedMarkdown = normalize(extractMarkdownOutline(processedMarkdown));
	if (!processedMarkdown) return undefined;
	// Plain text only gets here with a filter.
	return options.outline || format === "markdown" ? processedMarkdown : markdownToPlainText(processedMarkdown);
}

/** Shared builder for both extraction paths. */
async function toReadableResult(
	url: string,
	format: ReadableFormat,
	textContent: string | null | undefined,
	htmlContent: () => string | null | undefined,
	meta: { title?: string | null; byline?: string | null; excerpt?: string | null; length?: number | null },
	options: ReadableExtractOptions,
): Promise<ReadableResult | null> {
	// Text-format content is `blockText` output, already free of leading whitespace except a
	// first-cell tab or `<pre>` indentation, both of which are content.
	const text = format === "text" ? textContent?.trimEnd() || undefined : normalize(textContent);
	// Unfiltered plain text is `text` itself; rendering Markdown would only repeat its emptiness check.
	const content =
		format === "text" && !options.filter && !options.outline
			? text
			: await markdownContent(format, text, htmlContent(), options);
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
