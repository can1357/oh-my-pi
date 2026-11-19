/** Behavior-compatible reimplementation of @mozilla/readability's used surface. */

import type { ReadabilityDocument, ReadabilityElement, ReadabilityNode } from "./types";

const UNLIKELY =
	/-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i;
const POSSIBLE = /and|article|body|column|content|main|shadow/i;

/** Options for the inexpensive readerability estimate. */
export interface ReaderableOptions {
	minContentLength?: number;
	minScore?: number;
	visibilityChecker?: (node: ReadabilityNode) => boolean;
}

/** Estimates whether a document contains enough prose for article extraction. */
export function isProbablyReaderable(
	document: ReadabilityDocument,
	options: ReaderableOptions | ((node: ReadabilityNode) => boolean) = {},
): boolean {
	const resolved = typeof options === "function" ? { visibilityChecker: options } : options;
	const minLength = resolved.minContentLength ?? 140;
	const minScore = resolved.minScore ?? 20;
	const visible =
		resolved.visibilityChecker ??
		((node: ReadabilityNode) => {
			const element = node as ReadabilityElement;
			const style = element.getAttribute("style")?.toLowerCase() ?? "";
			return (
				!element.hasAttribute("hidden") &&
				element.getAttribute("aria-hidden") !== "true" &&
				!/display\s*:\s*none/.test(style)
			);
		});
	const candidates = new Set<ReadabilityElement>(Array.from(document.querySelectorAll("p, pre, article")));
	for (const br of Array.from(document.querySelectorAll("div > br"))) {
		if (br.parentNode) candidates.add(br.parentNode as ReadabilityElement);
	}
	let score = 0;
	for (const node of candidates) {
		if (!visible(node)) continue;
		const label = `${node.className} ${node.id}`;
		if (UNLIKELY.test(label) && !POSSIBLE.test(label)) continue;
		if ((node.parentNode as ReadabilityElement | null)?.tagName === "LI" && node.tagName === "P") continue;
		const length = (node.textContent ?? "").trim().length;
		if (length < minLength) continue;
		score += Math.sqrt(length - minLength);
		if (score > minScore) return true;
	}
	return false;
}
