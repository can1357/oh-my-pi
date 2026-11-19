/**
 * Read the Docs handler for web-fetch
 */
import type { Element } from "@oh-my-pi/pi-utils/dom";
import { buildResult, htmlToBasicMarkdown, loadPage, type RenderResult, type SpecialHandler } from "./types";

/** Builders name output files `.html`; a dirhtml page ends in a directory whose name may contain dots. */
const OUTPUT_EXTENSION = /\.html?$/i;
const SOURCE_EXTENSION = /\.[^.]+$/;
/** Directories a docs root lives in (`docs/`, `doc/source/`, …); the root page's index sits directly under them. */
const DOCS_ROOT_DIR = /^(?:docs?|documentation|source|src|content)$/i;

export const handleReadTheDocs: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	// Check if URL matches Read the Docs patterns
	const urlObj = new URL(url);
	const isReadTheDocs =
		urlObj.hostname.endsWith(".readthedocs.io") ||
		urlObj.hostname === "readthedocs.org" ||
		urlObj.hostname === "www.readthedocs.org";

	if (!isReadTheDocs) {
		return null;
	}

	const notes: string[] = [];
	const fetchedAt = new Date().toISOString();

	// Fetch the page
	const result = await loadPage(url, { timeout, signal });
	if (!result.ok) {
		return {
			url,
			finalUrl: result.finalUrl,
			contentType: result.contentType,
			method: "readthedocs",
			content: `Failed to fetch Read the Docs page (status: ${result.status ?? "unknown"})`,
			fetchedAt,
			truncated: false,
			notes,
		};
	}

	// Parse HTML
	const { parseHTML } = await import("@oh-my-pi/pi-utils/dom");
	const root = parseHTML(result.content).document;

	// Extract main content from common Read the Docs selectors
	let mainContent =
		root.querySelector(".document") ||
		root.querySelector('[role="main"]') ||
		root.querySelector("main") ||
		root.querySelector(".rst-content") ||
		root.querySelector(".body");

	if (!mainContent) {
		// Fallback to body if no main content found
		mainContent = root.querySelector("body");
		notes.push("Using full body content (no main content div found)");
	}

	// Remove navigation, sidebar, footer elements
	mainContent
		?.querySelectorAll(
			".headerlink, .viewcode-link, nav, .sidebar, footer, .related, .sphinxsidebar, .toctree-wrapper",
		)
		.forEach((el: Element) => {
			el.remove();
		});

	// The requested docs version is the second path segment (/<lang>/<slug>/...).
	// Only follow an Edit link to raw source when its repo ref matches that
	// version: otherwise a versioned page would serve another branch's file
	// (e.g. /en/v3.18.5/ with an Edit link to blob/main). `latest` and
	// `stable` float, so any ref is acceptable for them.
	const finalPath = new URL(result.finalUrl).pathname;
	const versionSlug = finalPath.match(/^\/[^/]+\/([^/]+)\//)?.[1] ?? null;
	const pagePath = docPath(finalPath.split("/").slice(3), OUTPUT_EXTENSION);

	// Try to find Edit on GitHub/GitLab links for raw source
	const editLinks = root.querySelectorAll('a[href*="github.com"], a[href*="gitlab.com"]');
	let sourceUrl: string | null = null;

	for (const link of editLinks) {
		const href = link.getAttribute("href");
		const text = link.textContent?.toLowerCase() || "";

		if (href && text.includes("edit")) {
			const fileMatch = href.match(/\/(?:blob|raw|edit)\/([^/]+)\/([^?#]+)/);
			// A body link can say "edit" too and point at any repository; only the
			// page's own Edit link names the file the page was built from.
			if (!fileMatch || !sourceFileBuildsPage(docPath(fileMatch[2].split("/"), SOURCE_EXTENSION), pagePath)) {
				continue;
			}
			const ref = fileMatch[1];
			const refMatches =
				versionSlug !== null && (versionSlug === "latest" || versionSlug === "stable" || ref === versionSlug);
			if (!refMatches) {
				notes.push(
					`Skipped raw source from ${href}: repository ref does not match documentation version ${versionSlug ?? "(unknown)"}`,
				);
				continue;
			}
			// Convert edit URL to raw URL
			if (href.includes("github.com")) {
				sourceUrl = href.replace("/blob/", "/raw/").replace("/edit/", "/raw/");
			} else if (href.includes("gitlab.com")) {
				sourceUrl = href.replace("/blob/", "/raw/").replace("/edit/", "/raw/");
			}
			break;
		}
	}

	let content = "";
	let fetchedRaw = false;

	// Try to fetch raw source if available
	if (sourceUrl) {
		try {
			const sourceResult = await loadPage(sourceUrl, { timeout: Math.min(timeout, 10), signal });
			if (sourceResult.ok && sourceResult.content.length > 0 && sourceResult.content.length < 1_000_000) {
				content = sourceResult.content;
				fetchedRaw = true;
				notes.push(`Fetched raw source from ${sourceUrl}`);
			}
		} catch {
			// Ignore errors, fall back to HTML
		}
	}

	// If no raw source, convert HTML to markdown
	if (!content && mainContent) {
		const html = mainContent.innerHTML;
		content = await htmlToBasicMarkdown(html);
	}

	if (!content) {
		content = "No content extracted from Read the Docs page";
		notes.push("Failed to extract content");
	}

	return buildResult(content, {
		url,
		finalUrl: result.finalUrl,
		method: "readthedocs",
		fetchedAt,
		notes,
		contentType: fetchedRaw ? "text/plain" : "text/html",
	});
};

interface DocPath {
	/** Decoded path segments without the file extension or a trailing index/README. */
	segments: string[];
	/** The path named an index or README file (or the docs root). */
	index: boolean;
}

function docPath(segments: string[], extension: RegExp): DocPath {
	const parts = segments.filter(Boolean).map(decodePathSegment);
	const last = parts.pop()?.replace(extension, "");
	const index = last === undefined || /^(?:index|readme)$/i.test(last);
	if (!index) parts.push(last);
	return { segments: parts, index };
}

function decodePathSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch (error) {
		if (error instanceof URIError) return segment;
		throw error;
	}
}

/** A page at docs/a/b builds from a/b.md, a/b/index.rst, …, under any docs root in the repository. */
function sourceFileBuildsPage(source: DocPath, page: DocPath): boolean {
	if (page.segments.length === 0) {
		return source.index && source.segments.every(segment => DOCS_ROOT_DIR.test(segment));
	}
	const offset = source.segments.length - page.segments.length;
	return offset >= 0 && page.segments.every((segment, i) => source.segments[offset + i] === segment);
}
