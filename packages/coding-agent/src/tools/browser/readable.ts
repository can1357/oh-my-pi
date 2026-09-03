import type * as DomNs from "@oh-my-pi/pi-utils/dom";
import type * as ReadabilityNs from "@oh-my-pi/pi-utils/readability";
import { htmlToBasicMarkdown } from "../../web/scrapers/types";

export type ReadableFormat = "text" | "markdown";

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
): Promise<ReadableResult | null> {
	const [{ parseHTML }, { Readability }] = await Promise.all([loadDom(), loadReadability()]);
	const { document } = parseHTML(html);

	// --- Primary: Readability article extraction ---
	const article = new Readability(document).parse();
	if (article) {
		const result = await toReadableResult(url, format, article.textContent, article.content, {
			title: article.title,
			byline: article.byline,
			excerpt: article.excerpt,
			length: article.length,
		});
		if (result) return result;
	}

	// --- Fallback: CSS selector chain ---
	const candidates = [
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
		const result = await toReadableResult(url, format, textContent, innerHTML, {
			title: document.title,
			excerpt: textContent.slice(0, 240),
			length: textContent.length,
		});
		if (result) return result;
	}

	return null;
}

/** Shared builder for both extraction paths. */
async function toReadableResult(
	url: string,
	format: ReadableFormat,
	textContent: string | null | undefined,
	htmlContent: string | null | undefined,
	meta: { title?: string | null; byline?: string | null; excerpt?: string | null; length?: number | null },
): Promise<ReadableResult | null> {
	const text = normalize(textContent);
	const markdown =
		format === "markdown" ? (normalize(await htmlToBasicMarkdown(htmlContent ?? "")) ?? text) : undefined;
	const normalizedText = format === "text" ? text : undefined;
	if (!normalizedText && !markdown) return null;
	return {
		url,
		title: normalize(meta.title),
		byline: normalize(meta.byline),
		excerpt: normalize(meta.excerpt),
		contentLength: meta.length ?? text?.length ?? markdown?.length ?? 0,
		text: normalizedText,
		markdown,
	};
}
