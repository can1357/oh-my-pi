import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type FetchImpl, getEnvApiKey, type ImageContent, type TextContent } from "@oh-my-pi/pi-ai";
import { htmlToMarkdown, notebookToEditableText } from "@oh-my-pi/pi-natives";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { $which, ptree, truncate } from "@oh-my-pi/pi-utils";
import { type ArchiveFormat, listArchiveRoot, sniffArchiveFormat } from "@oh-my-pi/pi-utils/ar";
import type { Settings } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { type Theme, theme } from "../modes/theme/theme";
import type { ToolSession } from "../sdk";
import type { AgentStorage } from "../session/agent-storage";
import { DEFAULT_MAX_BYTES, truncateHead } from "../session/streaming-output";
import { renderStatusLine, urlHyperlink } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import { webpExclusionForModel } from "../utils/image-loading";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import { CONVERTIBLE_EXTENSIONS } from "../utils/markit";
import { ensureTool } from "../utils/tools-manager";
import { findFirecrawlApiKey, scrapeWithFirecrawl } from "../web/firecrawl";
import { extractWithParallel, findParallelApiKey, getParallelExtractContent } from "../web/parallel";
import type { RenderResult, SpecialHandler } from "../web/scrapers/types";
import { finalizeOutput, loadPage, looksLikeHtml, MAX_BYTES, MAX_OUTPUT_CHARS } from "../web/scrapers/types";
import { convertWithMarkit, fetchBinary } from "../web/scrapers/utils";
import { findCredential } from "../web/search/providers/utils";
import { applyListLimit } from "./list-limit";
import { formatStyledArtifactReference, type OutputMeta } from "./output-meta";
import { isReadableUrlPath, type LineRange, parseLineRanges, parseTailCount } from "./path-utils";
import type { ParsedSelector } from "./read-selector";
import { formatBytes, formatExpandHint, getDomain, replaceTabs } from "./render-utils";
import { listTables, looksLikeSqlite, openSqliteReadConnection, renderTableList } from "./sqlite-reader";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

// =============================================================================
// Types and Constants
// =============================================================================

const FETCH_DEFAULT_MAX_LINES = 300;
// MIME types markit can convert — one per registered converter (pdf, docx,
// pptx, xlsx, epub). Legacy `application/msword`, `application/vnd.ms-*`, and
// `application/rtf` are intentionally absent: markit has no converter for them.
const CONVERTIBLE_MIMES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/epub+zip",
]);

const NOTEBOOK_MIMES = new Set(["application/x-ipynb+json"]);
const NOTEBOOK_EXTENSIONS = new Set([".ipynb"]);

const SQLITE_MIMES = new Set([
	"application/vnd.sqlite3",
	"application/x-sqlite3",
	"application/sqlite3",
	"application/sqlite",
]);
const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);

const ARCHIVE_MIMES = new Set([
	"application/zip",
	"application/x-zip-compressed",
	"application/x-tar",
	"application/tar",
	"application/gzip",
	"application/x-gzip",
]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tar.gz", ".tgz", ".gz"]);

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
]);
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_IMAGE_OUTPUT_BYTES = 300 * 1024;

// =============================================================================
// Utilities
// =============================================================================

/**
 * Check if a command exists (cross-platform)
 */
function hasCommand(cmd: string): boolean {
	return Boolean($which(cmd));
}

/**
 * Build llms.txt candidates scoped to the requested URL
 */
function buildLlmEndpointCandidates(url: string): string[] {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/") {
			return [`${parsed.origin}/.well-known/llms.txt`, `${parsed.origin}/llms.txt`, `${parsed.origin}/llms.md`];
		}

		const trimmedPath = parsed.pathname.replace(/\/+$/, "");
		const segments = trimmedPath.split("/").filter(Boolean);
		const scopeDepth = parsed.pathname.endsWith("/") ? segments.length : Math.max(segments.length - 1, 1);
		const endpoints: string[] = [];

		for (let depth = scopeDepth; depth >= 1; depth--) {
			const scope = `/${segments.slice(0, depth).join("/")}/`;
			endpoints.push(`${parsed.origin}${scope}llms.txt`, `${parsed.origin}${scope}llms.md`);
		}

		return endpoints;
	} catch {
		return [];
	}
}

/**
 * Repair a URL whose scheme `//` collapsed to a single `/`. Node's `path.normalize`/
 * `path.resolve` collapse `//` → `/`, so any URL routed through path normalization arrives
 * as `https:/host/x` instead of `https://host/x`. No local filesystem path begins with
 * `http:/` or `https:/`, so repairing the scheme back to `//` is unambiguous.
 */
function repairCollapsedScheme(value: string): string {
	const m = value.match(/^(https?):\/(?!\/)/i);
	return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

/**
 * Normalize URL (repair a collapsed scheme, then add a scheme if one is missing).
 */
function normalizeUrl(url: string): string {
	url = repairCollapsedScheme(url);
	if (!url.match(/^https?:\/\//i)) {
		return `https://${url}`;
	}
	return url;
}

// URL line selectors mirror the file form: `:50`, `:50-100`, `:50+150`, `:5-10,20-30`, `:-60`,
// `:raw`, or `:raw:N-M` / `:N-M:raw` to combine raw mode with a range. If a URL would otherwise
// look like `host:port`, add a trailing slash before the selector (e.g. `https://example.com/:80`
// to read line 80 of the document at `https://example.com/`).

/** A readable external URL split from its trailing read selector. */
export interface ParsedReadUrlTarget {
	path: string;
	sel: ParsedSelector;
}

/** Recognize a single selector token (`raw`, a tail, or one/many line ranges). */
function isUrlSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	try {
		return parseLineRanges(token) !== null || parseTailCount(token) !== null;
	} catch {
		// `parseLineRanges` throws `ToolError` for malformed ranges (e.g. `5+0`). Only treat the
		// token as a selector when it parses cleanly so URL ports like `:80` keep flowing
		// through to the URL path.
		return false;
	}
}

export function parseReadUrlTarget(readPath: string): ParsedReadUrlTarget | null {
	const repaired = repairCollapsedScheme(readPath);
	const embedded = tryExtractEmbeddedUrlSelector(repaired);
	const urlPath = embedded?.path ?? repaired;
	if (!isReadableUrlPath(urlPath)) {
		return null;
	}

	let raw = false;
	let ranges: [LineRange, ...LineRange[]] | undefined;
	let tail: number | undefined;
	for (const token of embedded?.sels ?? []) {
		if (token.toLowerCase() === "raw") {
			raw = true;
			continue;
		}
		if (ranges !== undefined || tail !== undefined) {
			// Two range groups on the same URL (`…:5-10:20-30`) — combine with commas instead.
			throw new ToolError(
				`URL selector has multiple range groups; combine them with commas (e.g. \`:5-10,20-30\`).`,
			);
		}
		ranges = parseLineRanges(token) ?? undefined;
		if (ranges !== undefined) continue;
		const count = parseTailCount(token);
		if (count === null) {
			// Shouldn't happen — isUrlSelectorToken vetted it. Belt-and-suspenders.
			throw new ToolError(`Invalid URL line selector: ${token}`);
		}
		tail = count;
	}

	const sel: ParsedSelector = ranges
		? { kind: "lines", ranges, raw }
		: tail !== undefined
			? { kind: "tail", count: tail, raw }
			: raw
				? { kind: "raw" }
				: { kind: "none" };
	return { path: urlPath, sel };
}

/**
 * Peel one or more selector tokens off the right of a URL string. Walks back through
 * trailing `:tok` segments while each token (a) looks like a selector and (b) leaves
 * behind a string that still parses as a URL. Returns selectors left-to-right so callers
 * can apply them in source order.
 */
function tryExtractEmbeddedUrlSelector(readPath: string): { path: string; sels: string[] } | null {
	let basePath = readPath;
	const sels: string[] = [];
	while (true) {
		const lastColonIndex = basePath.lastIndexOf(":");
		if (lastColonIndex <= 0) break;

		const candidate = basePath.slice(lastColonIndex + 1);
		const remainder = basePath.slice(0, lastColonIndex);
		if (!isReadableUrlPath(remainder)) break;
		if (!isUrlSelectorToken(candidate)) break;

		try {
			new URL(
				remainder.startsWith("http://") || remainder.startsWith("https://") ? remainder : `https://${remainder}`,
			);
		} catch {
			break;
		}

		sels.unshift(candidate);
		basePath = remainder;
	}
	if (sels.length === 0) return null;
	return { path: basePath, sels };
}

/**
 * Normalize MIME type (lowercase, strip charset/params)
 */
function normalizeMime(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

function getFilenameExtensionHint(filename: string): string {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".tar.gz")) return ".tar.gz";
	return path.extname(filename).toLowerCase();
}

/**
 * Get extension from URL or Content-Disposition
 */
function getExtensionHint(url: string, contentDisposition?: string): string {
	// Try Content-Disposition filename first
	if (contentDisposition) {
		const match = contentDisposition.match(/filename[*]?=["']?([^"';\n]+)/i);
		if (match) {
			const ext = getFilenameExtensionHint(match[1]);
			if (ext) return ext;
		}
	}

	// Fall back to URL path
	try {
		const pathname = new URL(url).pathname;
		const ext = getFilenameExtensionHint(pathname);
		if (ext) return ext;
	} catch {}

	return "";
}

/**
 * Check if content type is convertible via markit.
 */
function isConvertible(mime: string, extensionHint: string): boolean {
	if (CONVERTIBLE_MIMES.has(mime)) return true;
	if (mime === "application/octet-stream" && CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	if (CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	return false;
}

function resolveImageMimeType(mime: string, extensionHint: string): string | null {
	if (mime.startsWith("image/")) return mime;
	const shouldUseExtensionHint =
		mime.length === 0 || mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "unknown";
	if (!shouldUseExtensionHint) return null;
	return IMAGE_MIME_BY_EXTENSION.get(extensionHint) ?? null;
}

function isInlineImageMimeTypeSupported(mimeType: string): boolean {
	return SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Try fetching URL with .md appended (llms.txt convention)
 */
async function tryMdSuffix(url: string, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const candidates: string[] = [];

	try {
		const parsed = new URL(url);
		const pathname = parsed.pathname;

		if (pathname.endsWith("/")) {
			// /foo/bar/ -> /foo/bar/index.html.md
			candidates.push(`${parsed.origin}${pathname}index.html.md`);
		} else if (pathname.includes(".")) {
			// /foo/bar.html -> /foo/bar.html.md
			candidates.push(`${parsed.origin}${pathname}.md`);
		} else {
			// /foo/bar -> /foo/bar.md
			candidates.push(`${parsed.origin}${pathname}.md`);
		}
	} catch {
		return null;
	}

	if (signal?.aborted) {
		return null;
	}

	for (const candidate of candidates) {
		if (signal?.aborted) {
			return null;
		}
		const result = await loadPage(candidate, { timeout, signal });
		if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
			return result.content;
		}
	}

	return null;
}

/**
 * Try to fetch LLM-friendly endpoints
 */
async function tryLlmEndpoints(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; endpoint: string } | null> {
	const endpoints = buildLlmEndpointCandidates(url);

	if (signal?.aborted || endpoints.length === 0) {
		return null;
	}

	for (const endpoint of endpoints) {
		if (signal?.aborted) {
			return null;
		}
		const result = await loadPage(endpoint, { timeout: Math.min(timeout, 5), signal });
		if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
			return { content: result.content, endpoint };
		}
	}
	return null;
}

/**
 * Try content negotiation for markdown/plain
 */
async function tryContentNegotiation(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; type: string } | null> {
	if (signal?.aborted) {
		return null;
	}

	const result = await loadPage(url, {
		timeout,
		headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
		signal,
	});

	if (!result.ok) return null;

	const mime = normalizeMime(result.contentType);
	if ((mime.includes("markdown") || mime === "text/plain") && !looksLikeHtml(result.content)) {
		return { content: result.content, type: result.contentType };
	}

	return null;
}

/**
 * Read a single HTML attribute from a tag string
 */
function getHtmlAttribute(tag: string, attribute: string): string | null {
	const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
	const match = tag.match(pattern);
	if (!match) return null;
	return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/**
 * Extract bounded <head> markup to avoid expensive whole-page parsing
 */
function extractHeadHtml(html: string): string {
	const lower = html.toLowerCase();
	const headStart = lower.indexOf("<head");
	if (headStart === -1) {
		return html.slice(0, 32 * 1024);
	}

	const headTagEnd = html.indexOf(">", headStart);
	if (headTagEnd === -1) {
		return html.slice(headStart, headStart + 32 * 1024);
	}

	const headEnd = lower.indexOf("</head>", headTagEnd + 1);
	const fallbackEnd = Math.min(html.length, headTagEnd + 1 + 32 * 1024);
	return html.slice(headStart, headEnd === -1 ? fallbackEnd : headEnd + 7);
}

/**
 * Parse alternate links from HTML head
 */
function parseAlternateLinks(html: string, pageUrl: string): string[] {
	const links: string[] = [];

	try {
		const pagePath = new URL(pageUrl).pathname;
		const headHtml = extractHeadHtml(html);
		const linkTags = headHtml.match(/<link\b[^>]*>/gi) ?? [];

		for (const tag of linkTags) {
			const rel = getHtmlAttribute(tag, "rel")?.toLowerCase() ?? "";
			const relTokens = rel.split(/\s+/).filter(Boolean);
			if (!relTokens.includes("alternate")) continue;

			const href = getHtmlAttribute(tag, "href");
			const type = getHtmlAttribute(tag, "type")?.toLowerCase() ?? "";
			if (!href) continue;

			// Skip site-wide feeds
			if (
				href.includes("RecentChanges") ||
				href.includes("Special:") ||
				href.includes("/feed/") ||
				href.includes("action=feed")
			) {
				continue;
			}

			if (type.includes("markdown")) {
				links.push(href);
			} else if (
				(type.includes("rss") || type.includes("atom") || type.includes("feed")) &&
				(href.includes(pagePath) || href.includes("comments"))
			) {
				links.push(href);
			}
		}
	} catch {}

	return links;
}

/**
 * Extract document links from HTML (for PDF/DOCX wrapper pages)
 */
function extractDocumentLinks(html: string, baseUrl: string): string[] {
	const links: string[] = [];
	const seen = new Set<string>();

	try {
		const anchorTags = html.slice(0, 512 * 1024).match(/<a\b[^>]*>/gi) ?? [];
		for (const tag of anchorTags) {
			const href = getHtmlAttribute(tag, "href");
			if (!href) continue;

			const ext = path.extname(href).toLowerCase();
			if (!CONVERTIBLE_EXTENSIONS.has(ext)) continue;

			const resolved = href.startsWith("http") ? href : new URL(href, baseUrl).href;
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			links.push(resolved);
			if (links.length >= 20) break;
		}
	} catch {}

	return links;
}

/**
 * Strip CDATA wrapper and clean text
 */
function cleanFeedText(text: string): string {
	return text
		.replace(/<!\[CDATA\[/g, "")
		.replace(/\]\]>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/<[^>]+>/g, "") // Strip HTML tags
		.trim();
}

/**
 * Parse RSS/Atom feed to markdown
 */
async function parseFeedToMarkdown(content: string, maxItems = 10): Promise<string> {
	const { parseHTML } = await import("@oh-my-pi/pi-utils/dom");
	try {
		const doc = parseHTML(content).document;

		// Try RSS
		const channel = doc.querySelector("channel");
		if (channel) {
			const title = cleanFeedText(channel.querySelector("title")?.text || "RSS Feed");
			const items = channel.querySelectorAll("item").slice(0, maxItems);

			let md = `# ${title}\n\n`;
			for (const item of items) {
				const itemTitle = cleanFeedText(item.querySelector("title")?.text || "Untitled");
				const link = cleanFeedText(item.querySelector("link")?.text || "");
				const pubDate = cleanFeedText(item.querySelector("pubDate")?.text || "");
				const desc = cleanFeedText(item.querySelector("description")?.text || "");

				md += `## ${itemTitle}\n`;
				if (pubDate) md += `*${pubDate}*\n\n`;
				if (desc) md += `${desc.slice(0, 500)}${desc.length > 500 ? "..." : ""}\n\n`;
				if (link) md += `[Read more](${link})\n\n`;
				md += "---\n\n";
			}
			return md;
		}

		// Try Atom
		const feed = doc.querySelector("feed");
		if (feed) {
			const title = cleanFeedText(feed.querySelector("title")?.text || "Atom Feed");
			const entries = feed.querySelectorAll("entry").slice(0, maxItems);

			let md = `# ${title}\n\n`;
			for (const entry of entries) {
				const entryTitle = cleanFeedText(entry.querySelector("title")?.text || "Untitled");
				const link = entry.querySelector("link")?.getAttribute("href") || "";
				const updated = cleanFeedText(entry.querySelector("updated")?.text || "");
				const summary = cleanFeedText(
					entry.querySelector("summary")?.text || entry.querySelector("content")?.text || "",
				);

				md += `## ${entryTitle}\n`;
				if (updated) md += `*${updated}*\n\n`;
				if (summary) md += `${summary.slice(0, 500)}${summary.length > 500 ? "..." : ""}\n\n`;
				if (link) md += `[Read more](${link})\n\n`;
				md += "---\n\n";
			}
			return md;
		}
	} catch {}

	return content; // Fall back to raw content
}

/**
 * Cap on any single remote reader-mode request (Parallel, Firecrawl, Jina) so a
 * stalled remote endpoint cannot consume the whole reader-mode budget and starve
 * the local fallback renderers (trafilatura, lynx, native). See #1449.
 */
const REMOTE_READER_MAX_MS = 10_000;
const JINA_MARKDOWN_MARKER = "Markdown Content:";
const JINA_READER_MAX_BYTES = 2 * 1024 * 1024;

function parseJinaReaderContent(responseBody: string): string | null {
	const markerStart = responseBody.indexOf(JINA_MARKDOWN_MARKER);
	if (markerStart < 0) return null;

	const content = responseBody.slice(markerStart + JINA_MARKDOWN_MARKER.length).trim();
	if (content.length < 100 || content.startsWith("Loading...") || content.startsWith("Please enable JavaScript")) {
		return null;
	}
	return content;
}

/** Reader backends for {@link renderHtmlToText}, in default priority order. */
export type FetchProvider = "native" | "trafilatura" | "lynx" | "parallel" | "firecrawl" | "jina";

const FETCH_PROVIDER_ORDER: readonly FetchProvider[] = [
	"native",
	"trafilatura",
	"lynx",
	"parallel",
	"firecrawl",
	"jina",
];

/**
 * Render HTML to markdown by trying reader backends in priority order: native
 * (in-process), trafilatura, lynx, Parallel, Firecrawl, then Jina. The
 * `providers.fetch` setting picks the order — `auto` uses the default above; any
 * specific backend is tried first, then the remaining backends as fallbacks.
 * Every backend's output must clear the same quality gate (>100 non-whitespace
 * chars and not {@link isLowQualityOutput}) before it is accepted, otherwise the
 * next backend is tried.
 *
 * The overall `timeout` budget bounds the whole call; remote backends (Parallel,
 * Firecrawl, Jina) are additionally capped at `REMOTE_READER_MAX_MS` so a hung
 * endpoint cannot starve later renderers — especially the purely-local native
 * converter, which always works on already-loaded HTML. Only a real `userSignal`
 * cancellation aborts the chain (#1449).
 */
export async function renderHtmlToText(
	url: string,
	html: string,
	timeout: number,
	settings: Settings,
	userSignal: AbortSignal | undefined,
	storage: AgentStorage | null,
	fetchOverride?: FetchImpl,
): Promise<{ content: string; ok: boolean; method: string }> {
	const overallSignal = ptree.combineSignals(userSignal, timeout * 1000);
	const execOptions = {
		mode: "group" as const,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full" as const,
		signal: overallSignal,
	};
	const remoteBudgetMs = Math.min(timeout * 1000, REMOTE_READER_MAX_MS);
	// Per-attempt budget for remote endpoints so one stall cannot consume the
	// whole reader-mode budget and starve the local fallbacks.
	const remoteSignal = () => ptree.combineSignals(userSignal, remoteBudgetMs);
	const fetchImpl = fetchOverride ?? fetch;

	const runners: Record<FetchProvider, () => Promise<string | null>> = {
		// Purely local, no network/subprocess: still works on already-loaded HTML
		// even after remote/subprocess attempts are aborted by the budget.
		native: () => htmlToMarkdown(html, { cleanContent: true }),
		trafilatura: async () => {
			const trafilatura = await ensureTool("trafilatura", { signal: overallSignal, silent: true });
			if (!trafilatura) return null;
			const result = await ptree.exec([trafilatura, "-u", url, "--output-format", "markdown"], execOptions);
			return result.ok ? result.stdout : null;
		},
		lynx: async () => {
			if (!hasCommand("lynx")) return null;
			const result = await ptree.exec(["lynx", "-dump", "-nolist", "-width", "250", url], execOptions);
			return result.ok ? result.stdout : null;
		},
		parallel: async () => {
			if (!findParallelApiKey(storage)) return null;
			const parallelResult = await extractWithParallel(
				[url],
				{
					objective: "Extract the main content",
					excerpts: true,
					fullContent: false,
					signal: remoteSignal(),
					fetch: fetchImpl,
				},
				storage,
			);
			const firstDocument = parallelResult.results[0];
			return firstDocument ? getParallelExtractContent(firstDocument) : null;
		},
		firecrawl: async () => {
			if (!findFirecrawlApiKey(storage)) return null;
			return scrapeWithFirecrawl(url, { signal: remoteSignal(), fetch: fetchImpl }, storage);
		},
		jina: async () => {
			const apiKey = findCredential(storage, getEnvApiKey("jina"), "jina");
			const headers: Record<string, string> = {
				Accept: "text/markdown",
				"X-No-Cache": "true",
			};
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			const response = await fetchImpl(`https://r.jina.ai/${url}`, {
				headers,
				signal: remoteSignal(),
			});
			if (!response.ok) return null;
			const contentLength = Number(response.headers.get("content-length"));
			if (Number.isFinite(contentLength) && contentLength > JINA_READER_MAX_BYTES) return null;
			return parseJinaReaderContent(await response.text());
		},
	};

	const preference = settings.get("providers.fetch");
	const order: readonly FetchProvider[] =
		preference === "auto"
			? FETCH_PROVIDER_ORDER
			: [preference, ...FETCH_PROVIDER_ORDER.filter(method => method !== preference)];

	// Highest-priority output that is substantial but fails the low-quality gate.
	// Surfaced (ok: true) only when no backend clears the gate, so the caller's
	// targeted fallbacks (llms.txt / document extraction) still run and we beat
	// returning the unrendered raw HTML.
	let lowQuality: { content: string; method: FetchProvider } | null = null;

	for (const method of order) {
		// Honour real user cancellation between attempts; remote per-attempt and
		// overall-budget timeouts still fall through to later (local) renderers.
		userSignal?.throwIfAborted();
		try {
			const content = await runners[method]();
			if (!content || content.trim().length <= 100) continue;
			if (!isLowQualityOutput(content)) {
				return { content, ok: true, method };
			}
			lowQuality ??= { content, method };
		} catch {
			userSignal?.throwIfAborted();
		}
	}

	if (lowQuality) {
		return { content: lowQuality.content, ok: true, method: lowQuality.method };
	}
	return { content: "", ok: false, method: "none" };
}

/**
 * Check if lynx output looks JS-gated or mostly navigation
 */
function isLowQualityOutput(content: string): boolean {
	const lower = content.toLowerCase();

	// JS-gated indicators
	const jsGated = [
		"enable javascript",
		"javascript required",
		"turn on javascript",
		"please enable javascript",
		"browser not supported",
	];
	if (content.length < 1024 && jsGated.some(t => lower.includes(t))) {
		return true;
	}

	// Mostly navigation (high link/menu density)
	const lines = content.split("\n").filter(l => l.trim());
	const shortLines = lines.filter(l => l.trim().length < 40);
	if (lines.length > 10 && shortLines.length / lines.length > 0.7) {
		return true;
	}

	return false;
}

/**
 * Format JSON
 */
function formatJson(content: string): string {
	try {
		return JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		return content;
	}
}

interface FetchImagePayload {
	data: string;
	mimeType: string;
}

type FetchRenderResult = RenderResult & {
	image?: FetchImagePayload;
};

const BINARY_SAMPLE_CHARS = 4096;
const URL_ARCHIVE_LIST_LIMIT = 500;
const URL_SQLITE_LIST_LIMIT = 500;

function sampleLooksBinary(text: string): boolean {
	const limit = Math.min(text.length, BINARY_SAMPLE_CHARS);
	if (limit === 0) return false;

	let replacementCount = 0;
	for (let index = 0; index < limit; index++) {
		const code = text.charCodeAt(index);
		if (code === 0) return true;
		if (code === 0xfffd) replacementCount++;
	}

	return replacementCount >= 3 && replacementCount / limit > 0.01;
}

function isNotebookHint(mime: string, extensionHint: string): boolean {
	return NOTEBOOK_MIMES.has(mime) || NOTEBOOK_EXTENSIONS.has(extensionHint);
}

function isSqliteHint(mime: string, extensionHint: string): boolean {
	return SQLITE_MIMES.has(mime) || SQLITE_EXTENSIONS.has(extensionHint);
}

function isArchiveHint(mime: string, extensionHint: string): boolean {
	return ARCHIVE_MIMES.has(mime) || ARCHIVE_EXTENSIONS.has(extensionHint);
}

/**
 * Content types whose payload renderUrl always re-fetches via fetchBinary.
 * Skipping the initial body read for them avoids downloading and
 * string-decoding huge binaries (PDFs, archives, images) twice.
 */
function shouldSkipBodyDownload(contentType: string): boolean {
	return (
		CONVERTIBLE_MIMES.has(contentType) ||
		NOTEBOOK_MIMES.has(contentType) ||
		SQLITE_MIMES.has(contentType) ||
		ARCHIVE_MIMES.has(contentType) ||
		SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(contentType)
	);
}

function getArchiveFormatHint(mime: string, extensionHint: string): ArchiveFormat | undefined {
	if (extensionHint === ".zip" || mime === "application/zip" || mime === "application/x-zip-compressed") {
		return "zip";
	}
	if (extensionHint === ".tar" || mime === "application/x-tar" || mime === "application/tar") {
		return "tar";
	}
	if (
		extensionHint === ".tar.gz" ||
		extensionHint === ".tgz" ||
		extensionHint === ".gz" ||
		mime === "application/gzip" ||
		mime === "application/x-gzip"
	) {
		return "tar.gz";
	}
	return undefined;
}

function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function binaryContentType(mime: string): string {
	return mime || "application/octet-stream";
}

function buildBinaryNotice(finalUrl: string, mime: string, byteLength?: number): string {
	const size = byteLength === undefined ? "unknown size" : formatBytes(byteLength);
	return `[Binary content: ${binaryContentType(mime)}, ${size}] ${finalUrl}`;
}

function buildBinaryPayloadResult(
	url: string,
	finalUrl: string,
	mime: string,
	method: string,
	content: string,
	fetchedAt: string,
	notes: string[],
): FetchRenderResult {
	const output = finalizeOutput(content);
	return {
		url,
		finalUrl,
		contentType: binaryContentType(mime),
		method,
		content: output.content,
		fetchedAt,
		truncated: output.truncated,
		notes,
	};
}

async function withTempBinaryFile<T>(
	prefix: string,
	extension: string,
	bytes: Uint8Array,
	readTempFile: (tempPath: string) => Promise<T>,
): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const tempPath = path.join(tempDir, `payload${extension}`);
	try {
		await Bun.write(tempPath, bytes);
		return await readTempFile(tempPath);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

async function renderNotebookPayload(bytes: Uint8Array, displayUrl: string): Promise<string> {
	return withTempBinaryFile("omp-url-notebook-", ".ipynb", bytes, async tempPath =>
		notebookToEditableText(await Bun.file(tempPath).text(), displayUrl),
	);
}

async function renderSqlitePayload(bytes: Uint8Array): Promise<string> {
	return withTempBinaryFile("omp-url-sqlite-", ".sqlite", bytes, async tempPath => {
		let db: Database | null = null;
		try {
			db = await openSqliteReadConnection(tempPath);
			const listLimit = applyListLimit(listTables(db), { limit: URL_SQLITE_LIST_LIMIT });
			return renderTableList(listLimit.items);
		} finally {
			db?.close();
		}
	});
}

async function tryRenderBinaryPayload(
	url: string,
	finalUrl: string,
	mime: string,
	extHint: string,
	rawContent: string,
	bodySkipped: boolean,
	timeout: number,
	signal: AbortSignal | undefined,
	fetchedAt: string,
	notes: readonly string[],
): Promise<FetchRenderResult | null> {
	const hasNotebookHint = isNotebookHint(mime, extHint);
	const hasSqliteHint = isSqliteHint(mime, extHint);
	const hasArchiveHint = isArchiveHint(mime, extHint);
	const rawLooksBinary = bodySkipped || sampleLooksBinary(rawContent);
	if (!hasNotebookHint && !hasSqliteHint && !hasArchiveHint && !rawLooksBinary) {
		return null;
	}

	const resultNotes = [...notes];
	const binary = await fetchBinary(finalUrl, timeout, signal);
	if (!binary.ok) {
		resultNotes.push(binary.error ? `Binary fetch failed: ${binary.error}` : "Binary fetch failed");
		return buildBinaryPayloadResult(
			url,
			finalUrl,
			mime,
			"binary",
			buildBinaryNotice(finalUrl, mime),
			fetchedAt,
			resultNotes,
		);
	}

	const binaryExtHint = getExtensionHint(finalUrl, binary.contentDisposition) || extHint;
	if (isNotebookHint(mime, binaryExtHint)) {
		try {
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"notebook",
				await renderNotebookPayload(binary.buffer, finalUrl),
				fetchedAt,
				resultNotes,
			);
		} catch (error) {
			resultNotes.push(`Notebook rendering failed: ${formatErrorMessage(error)}`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime, binary.buffer.byteLength),
				fetchedAt,
				resultNotes,
			);
		}
	}

	if (isSqliteHint(mime, binaryExtHint) || looksLikeSqlite(binary.buffer)) {
		try {
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"sqlite",
				await renderSqlitePayload(binary.buffer),
				fetchedAt,
				resultNotes,
			);
		} catch (error) {
			resultNotes.push(`SQLite rendering failed: ${formatErrorMessage(error)}`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime, binary.buffer.byteLength),
				fetchedAt,
				resultNotes,
			);
		}
	}

	const hintedArchiveFormat = getArchiveFormatHint(mime, binaryExtHint);
	const shouldArchiveSniff = hintedArchiveFormat !== undefined || !isConvertible(mime, binaryExtHint);
	const archiveFormat = hintedArchiveFormat ?? (shouldArchiveSniff ? sniffArchiveFormat(binary.buffer) : undefined);
	if (archiveFormat) {
		try {
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"archive",
				await listArchiveRoot(binary.buffer, archiveFormat, { limit: URL_ARCHIVE_LIST_LIMIT }),
				fetchedAt,
				resultNotes,
			);
		} catch (error) {
			resultNotes.push(`Archive rendering failed: ${formatErrorMessage(error)}`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime, binary.buffer.byteLength),
				fetchedAt,
				resultNotes,
			);
		}
	}

	if (rawLooksBinary) {
		return buildBinaryPayloadResult(
			url,
			finalUrl,
			mime,
			"binary",
			buildBinaryNotice(finalUrl, mime, binary.buffer.byteLength),
			fetchedAt,
			resultNotes,
		);
	}

	return null;
}

// =============================================================================
// Unified Special Handler Dispatch
// =============================================================================

let specialHandlersPromise: Promise<SpecialHandler[]> | undefined;

/**
 * Lazily load the site-specific scraper handlers. The scrapers barrel eagerly
 * imports ~80 site modules, none of which are needed until the first fetch that
 * requires a special handler, so we keep them out of the cold-startup graph.
 */
function loadSpecialHandlers(): Promise<SpecialHandler[]> {
	specialHandlersPromise ??= import("../web/scrapers").then(m => m.specialHandlers);
	return specialHandlersPromise;
}

/**
 * Try all special handlers
 */
async function handleSpecialUrls(
	url: string,
	timeout: number,
	signal: AbortSignal | undefined,
	storage: AgentStorage | null,
): Promise<FetchRenderResult | null> {
	const specialHandlers = await loadSpecialHandlers();
	for (const handler of specialHandlers) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		const result = await handler(url, timeout, signal, storage);
		if (result) return result;
	}
	return null;
}

// =============================================================================
// Main Render Function
// =============================================================================

/**
 * Main render function implementing the full pipeline
 */
async function renderUrl(
	url: string,
	timeout: number,
	raw: boolean,
	settings: Settings,
	signal: AbortSignal | undefined,
	storage: AgentStorage | null,
	fetchOverride?: FetchImpl,
	excludeWebP?: true,
): Promise<FetchRenderResult> {
	const notes: string[] = [];
	const fetchedAt = new Date().toISOString();
	if (signal?.aborted) {
		throw new ToolAbortError();
	}

	// Handle internal protocol URLs (e.g., pi-internal://) - return empty
	if (url.startsWith("pi-internal://")) {
		return {
			url,
			finalUrl: url,
			contentType: "text/plain",
			method: "internal",
			content: "",
			fetchedAt,
			truncated: false,
			notes: ["Internal protocol URL - no external content"],
		};
	}

	// Step 0: Normalize URL (ensure scheme for special handlers)
	url = normalizeUrl(url);

	// Step 1: Try special handlers for known sites (unless raw mode)
	if (!raw) {
		const specialResult = await handleSpecialUrls(url, timeout, signal, storage);
		if (specialResult) return specialResult;
	}

	// Step 2: Fetch page
	const response = await loadPage(url, { timeout, signal, skipBodyForContentType: shouldSkipBodyDownload });
	if (signal?.aborted) {
		throw new ToolAbortError();
	}
	if (!response.ok) {
		return {
			url,
			finalUrl: response.finalUrl || url,
			contentType: response.contentType || "unknown",
			method: "failed",
			content: "",
			fetchedAt,
			truncated: false,
			notes: [
				response.status ? `Failed to fetch URL (HTTP ${response.status})` : "Failed to fetch URL",
				...(response.error ? [`Cause: ${response.error}`] : []),
			],
		};
	}

	const { finalUrl, content: rawContent } = response;
	if (response.truncated) {
		notes.push(`Response body exceeded ${formatBytes(MAX_BYTES)} and was cut mid-stream; content is incomplete`);
	}
	const mime = normalizeMime(response.contentType);
	const extHint = getExtensionHint(finalUrl);

	const imageMimeType = resolveImageMimeType(mime, extHint);
	let skipConvertibleBinaryRetry = false;
	if (imageMimeType) {
		if (!isInlineImageMimeTypeSupported(imageMimeType)) {
			notes.push(
				`Image MIME type ${imageMimeType} is unsupported for inline model serialization; returning text metadata only`,
			);
			notes.push("Falling back to textual rendering from initial response");
			skipConvertibleBinaryRetry = true;
		} else {
			const binary = await fetchBinary(finalUrl, timeout, signal);
			if (binary.ok) {
				notes.push("Fetched image binary");

				if (binary.buffer.byteLength > MAX_INLINE_IMAGE_SOURCE_BYTES) {
					notes.push(
						`Image exceeds inline source limit (${binary.buffer.byteLength} bytes > ${MAX_INLINE_IMAGE_SOURCE_BYTES} bytes)`,
					);
					const output = finalizeOutput(
						`Fetched image content (${imageMimeType}), but it is too large to inline render.`,
					);
					return {
						url,
						finalUrl,
						contentType: imageMimeType,
						method: "image-too-large",
						content: output.content,
						fetchedAt,
						truncated: output.truncated,
						notes,
					};
				}

				const resized = await resizeImage(
					{ type: "image", data: Buffer.from(binary.buffer).toBase64(), mimeType: imageMimeType },
					{ maxBytes: MAX_INLINE_IMAGE_OUTPUT_BYTES, excludeWebP },
				);
				const isDecodedImage =
					resized.originalWidth > 0 && resized.originalHeight > 0 && resized.width > 0 && resized.height > 0;
				if (!isDecodedImage) {
					notes.push(`Fetched payload could not be decoded as ${imageMimeType}; returning text metadata only`);
					const output = finalizeOutput(
						rawContent ?? `Fetched payload was labeled ${imageMimeType}, but bytes were not a valid image.`,
					);
					return {
						url,
						finalUrl,
						contentType: imageMimeType,
						method: "image-invalid",
						content: output.content,
						fetchedAt,
						truncated: output.truncated,
						notes,
					};
				}
				if (resized.buffer.length > MAX_INLINE_IMAGE_OUTPUT_BYTES) {
					notes.push(
						`Image exceeds inline output limit after resize (${resized.buffer.length} bytes > ${MAX_INLINE_IMAGE_OUTPUT_BYTES} bytes)`,
					);
					const output = finalizeOutput(
						`Fetched image content (${imageMimeType}), but it is too large to inline render.`,
					);
					return {
						url,
						finalUrl,
						contentType: imageMimeType,
						method: "image-too-large",
						content: output.content,
						fetchedAt,
						truncated: output.truncated,
						notes,
					};
				}

				const dimensionNote = formatDimensionNote(resized);
				let imageSummary = `Fetched image content (${resized.mimeType}).`;
				if (dimensionNote) {
					imageSummary += `\n${dimensionNote}`;
				}
				const output = finalizeOutput(imageSummary);
				return {
					url,
					finalUrl,
					contentType: resized.mimeType,
					method: "image",
					content: output.content,
					fetchedAt,
					truncated: output.truncated,
					notes,
					image: {
						data: resized.data,
						mimeType: resized.mimeType,
					},
				};
			}
			notes.push(binary.error ? `Binary fetch failed: ${binary.error}` : "Binary fetch failed");
			notes.push("Falling back to textual rendering from initial response");
			skipConvertibleBinaryRetry = true;
		}
	}

	// Step 3: Handle convertible binary files (PDF, DOCX, etc.)
	if (!skipConvertibleBinaryRetry && isConvertible(mime, extHint)) {
		const binary = await fetchBinary(finalUrl, timeout, signal);
		if (binary.ok) {
			const ext = getExtensionHint(finalUrl, binary.contentDisposition) || extHint;
			const converted = await convertWithMarkit(binary.buffer, ext, timeout, signal);
			if (converted.ok) {
				if (converted.content.trim().length > 50) {
					notes.push("Converted with markit");
					const output = finalizeOutput(converted.content);
					return {
						url,
						finalUrl,
						contentType: mime,
						method: "markit",
						content: output.content,
						fetchedAt,
						truncated: output.truncated,
						notes,
					};
				}
				notes.push("markit conversion produced no usable output");
			} else if (converted.error) {
				notes.push(`markit conversion failed: ${converted.error}`);
			} else {
				notes.push("markit conversion failed");
			}
		} else if (binary.error) {
			notes.push(`Binary fetch failed: ${binary.error}`);
		} else {
			notes.push("Binary fetch failed");
		}
	}

	const binaryPayloadResult = await tryRenderBinaryPayload(
		url,
		finalUrl,
		mime,
		extHint,
		rawContent,
		response.bodySkipped === true,
		timeout,
		signal,
		fetchedAt,
		notes,
	);
	if (binaryPayloadResult) return binaryPayloadResult;

	// Step 4: Handle non-HTML text content
	const isHtml = mime.includes("html") || mime.includes("xhtml");
	const isJson = mime.includes("json");
	const isXml = mime.includes("xml") && !isHtml;
	const isText = mime.includes("text/plain") || mime.includes("text/markdown");
	const isFeed = mime.includes("rss") || mime.includes("atom") || mime.includes("feed");

	// Raw mode skips every text-shaping branch below (JSON pretty-print, feed-to-markdown,
	// HTML extraction) and returns the response body verbatim. Binary-oriented branches
	// above already ran because raw isn't useful for binary payloads.
	if (raw) {
		const output = finalizeOutput(rawContent);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "raw",
			content: output.content,
			fetchedAt,
			truncated: output.truncated,
			notes,
		};
	}
	if (isJson) {
		const output = finalizeOutput(formatJson(rawContent));
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "json",
			content: output.content,
			fetchedAt,
			truncated: output.truncated,
			notes,
		};
	}

	if (isFeed || (isXml && (rawContent.includes("<rss") || rawContent.includes("<feed")))) {
		const parsed = await parseFeedToMarkdown(rawContent);
		const output = finalizeOutput(parsed);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "feed",
			content: output.content,
			fetchedAt,
			truncated: output.truncated,
			notes,
		};
	}

	if (isText && !looksLikeHtml(rawContent)) {
		const output = finalizeOutput(rawContent);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "text",
			content: output.content,
			fetchedAt,
			truncated: output.truncated,
			notes,
		};
	}

	// Step 5: For HTML, try digestible formats first (unless raw mode)
	if (isHtml && !raw) {
		// 5A: Check for page-specific markdown alternate
		const alternates = parseAlternateLinks(rawContent, finalUrl);
		const markdownAlt = alternates.find(alt => alt.endsWith(".md") || alt.includes("markdown"));
		if (markdownAlt) {
			const resolved = markdownAlt.startsWith("http") ? markdownAlt : new URL(markdownAlt, finalUrl).href;
			const altResult = await loadPage(resolved, { timeout, signal });
			if (altResult.ok && altResult.content.trim().length > 100 && !looksLikeHtml(altResult.content)) {
				notes.push(`Used markdown alternate: ${resolved}`);
				const output = finalizeOutput(altResult.content);
				return {
					url,
					finalUrl,
					contentType: "text/markdown",
					method: "alternate-markdown",
					content: output.content,
					fetchedAt,
					truncated: output.truncated,
					notes,
				};
			}
		}

		// 5B: Try URL.md suffix (llms.txt convention)
		const mdSuffix = await tryMdSuffix(finalUrl, timeout, signal);
		if (mdSuffix) {
			notes.push("Found .md suffix version");
			const output = finalizeOutput(mdSuffix);
			return {
				url,
				finalUrl,
				contentType: "text/markdown",
				method: "md-suffix",
				content: output.content,
				fetchedAt,
				truncated: output.truncated,
				notes,
			};
		}

		// 5C: Content negotiation
		const negotiated = await tryContentNegotiation(url, timeout, signal);
		if (negotiated) {
			notes.push(`Content negotiation returned ${negotiated.type}`);
			const output = finalizeOutput(negotiated.content);
			return {
				url,
				finalUrl,
				contentType: normalizeMime(negotiated.type),
				method: "content-negotiation",
				content: output.content,
				fetchedAt,
				truncated: output.truncated,
				notes,
			};
		}

		// 5D: Check for feed alternates
		const feedAlternates = alternates.filter(alt => !alt.endsWith(".md") && !alt.includes("markdown"));
		for (const altUrl of feedAlternates.slice(0, 2)) {
			const resolved = altUrl.startsWith("http") ? altUrl : new URL(altUrl, finalUrl).href;
			const altResult = await loadPage(resolved, { timeout, signal });
			if (altResult.ok && altResult.content.trim().length > 200) {
				notes.push(`Used feed alternate: ${resolved}`);
				const parsed = await parseFeedToMarkdown(altResult.content);
				const output = finalizeOutput(parsed);
				return {
					url,
					finalUrl,
					contentType: "application/feed",
					method: "alternate-feed",
					content: output.content,
					fetchedAt,
					truncated: output.truncated,
					notes,
				};
			}
		}

		if (signal?.aborted) {
			throw new ToolAbortError();
		}

		// 5E: Render HTML via the reader-backend chain
		// (native/trafilatura/lynx/parallel/firecrawl/jina)
		const htmlResult = await renderHtmlToText(
			finalUrl,
			rawContent,
			timeout,
			settings,
			signal,
			storage,
			fetchOverride,
		);
		if (!htmlResult.ok) {
			notes.push("html rendering failed (no reader backend produced usable output)");

			const llmResult = await tryLlmEndpoints(finalUrl, timeout, signal);
			if (llmResult) {
				notes.push(`Used llms.txt fallback: ${llmResult.endpoint}`);
				const output = finalizeOutput(llmResult.content);
				return {
					url,
					finalUrl,
					contentType: "text/plain",
					method: "llms.txt",
					content: output.content,
					fetchedAt,
					truncated: output.truncated,
					notes,
				};
			}

			const output = finalizeOutput(rawContent);
			return {
				url,
				finalUrl,
				contentType: mime,
				method: "raw-html",
				content: output.content,
				fetchedAt,
				truncated: output.truncated,
				notes,
			};
		}

		// Step 6: If rendered output is low quality, try more targeted fallbacks
		if (isLowQualityOutput(htmlResult.content)) {
			const docLinks = extractDocumentLinks(rawContent, finalUrl);
			if (docLinks.length > 0) {
				const docUrl = docLinks[0];
				const binary = await fetchBinary(docUrl, timeout, signal);
				if (binary.ok) {
					const ext = getExtensionHint(docUrl, binary.contentDisposition);
					const converted = await convertWithMarkit(binary.buffer, ext, timeout, signal);
					if (converted.ok && converted.content.trim().length > htmlResult.content.length) {
						notes.push(`Extracted and converted document: ${docUrl}`);
						const output = finalizeOutput(converted.content);
						return {
							url,
							finalUrl,
							contentType: "application/document",
							method: "extracted-document",
							content: output.content,
							fetchedAt,
							truncated: output.truncated,
							notes,
						};
					}
					if (!converted.ok && converted.error) {
						notes.push(`markit conversion failed: ${converted.error}`);
					}
				} else if (binary.error) {
					notes.push(`Binary fetch failed: ${binary.error}`);
				}
			}

			const llmResult = await tryLlmEndpoints(finalUrl, timeout, signal);
			if (llmResult) {
				notes.push(`Used llms.txt fallback: ${llmResult.endpoint}`);
				const output = finalizeOutput(llmResult.content);
				return {
					url,
					finalUrl,
					contentType: "text/plain",
					method: "llms.txt",
					content: output.content,
					fetchedAt,
					truncated: output.truncated,
					notes,
				};
			}

			notes.push("Page appears to require JavaScript or is mostly navigation");
		}

		const output = finalizeOutput(htmlResult.content);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: htmlResult.method,
			content: output.content,
			fetchedAt,
			truncated: output.truncated,
			notes,
		};
	}

	// Fallback: return raw content
	const output = finalizeOutput(rawContent);
	return {
		url,
		finalUrl,
		contentType: mime,
		method: "raw",
		content: output.content,
		fetchedAt,
		truncated: output.truncated,
		notes,
	};
}

// =============================================================================
// Tool Definition
// =============================================================================

export interface ReadUrlToolDetails {
	kind: "url";
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	truncated: boolean;
	notes: string[];
	meta?: OutputMeta;
}

interface ReadUrlEntry {
	artifactId?: string;
	artifactPath?: string;
	details: ReadUrlToolDetails;
	image?: FetchImagePayload;
	output: string;
	content: string;
}

async function findArtifactPath(session: ToolSession, artifactId: string): Promise<string | null> {
	const artifactsDir = session.getArtifactsDir?.();
	if (!artifactsDir) return null;

	try {
		const files = await fs.readdir(artifactsDir);
		const match = files.find(file => file.startsWith(`${artifactId}.`));
		return match ? path.join(artifactsDir, match) : null;
	} catch {
		return null;
	}
}

async function persistReadUrlArtifact(
	session: ToolSession,
	output: string,
): Promise<{ id?: string; path?: string } | undefined> {
	const artifact = await session.allocateOutputArtifact?.("read");
	if (!artifact?.path) return undefined;
	await Bun.write(artifact.path, output);
	return artifact;
}

async function ensureReadUrlArtifact(session: ToolSession, entry: ReadUrlEntry): Promise<ReadUrlEntry> {
	if (entry.artifactId && entry.artifactPath) return entry;
	if (entry.artifactId) {
		const artifactPath = await findArtifactPath(session, entry.artifactId);
		if (artifactPath) return { ...entry, artifactPath };
	}
	const artifact = await persistReadUrlArtifact(session, entry.output);
	return artifact?.id ? { ...entry, artifactId: artifact.id, artifactPath: artifact.path } : entry;
}

function readUrlContentExtension(finalUrl: string): string {
	try {
		const ext = getFilenameExtensionHint(new URL(finalUrl).pathname);
		return ext && /^\.[a-z0-9][a-z0-9+.-]{0,15}$/i.test(ext) ? ext : ".txt";
	} catch {
		return ".txt";
	}
}

async function materializeReadUrlContent(session: ToolSession, entry: ReadUrlEntry, raw: boolean): Promise<string> {
	const root = session.getArtifactsDir?.();
	if (!root) {
		throw new ToolError("Cannot search URL output because this session cannot materialize read artifacts.");
	}
	const dir = path.join(root, "url-search");
	await fs.mkdir(dir, { recursive: true });
	const hash = Bun.hash(`${raw ? "raw" : "rendered"}:${entry.details.finalUrl}`).toString(36);
	const contentPath = path.join(dir, `${hash}${readUrlContentExtension(entry.details.finalUrl)}`);
	await Bun.write(contentPath, entry.content);
	return contentPath;
}

/** Fetch and render a URL for a read or search operation. */
export async function fetchReadUrl(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
	options?: { ensureArtifact?: boolean },
): Promise<ReadUrlEntry> {
	const { path: url, raw = false } = params;

	const effectiveTimeout = clampTimeout("fetch", 30, session.settings.get("tools.maxTimeout"));

	if (signal?.aborted) {
		throw new ToolAbortError();
	}

	const storage = session.settings.getStorage();
	const result = await renderUrl(
		url,
		effectiveTimeout,
		raw,
		session.settings,
		signal,
		storage,
		session.fetch,
		webpExclusionForModel(session.getActiveModel?.()),
	);
	const output = buildUrlReadOutput(result, result.content);
	const artifact = options?.ensureArtifact ? await persistReadUrlArtifact(session, output) : undefined;

	return {
		artifactId: artifact?.id,
		artifactPath: artifact?.path,
		details: {
			kind: "url",
			url: result.url,
			finalUrl: result.finalUrl,
			contentType: result.contentType,
			method: result.method,
			truncated: Boolean(result.truncated),
			notes: result.notes,
		},
		image: result.image,
		output,
		content: result.content,
	};
}

/** Materialize rendered URL body text to a local file for tools that require filesystem paths. */
export async function materializeReadUrlToFile(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
): Promise<{ path: string; details: ReadUrlToolDetails }> {
	if (!session.settings.get("fetch.enabled")) {
		throw new ToolError("URL reads are disabled by settings.");
	}
	const entry = await fetchReadUrl(session, params, signal);
	const contentPath = await materializeReadUrlContent(session, entry, params.raw ?? false);
	return { path: contentPath, details: entry.details };
}

function buildUrlReadOutput(result: FetchRenderResult, content: string): string {
	let output = "";
	output += `URL: ${result.finalUrl}\n`;
	output += `Content-Type: ${result.contentType}\n`;
	output += `Method: ${result.method}\n`;
	if (result.notes.length > 0) {
		output += `Notes: ${result.notes.join("; ")}\n`;
	}
	output += `\n---\n\n`;
	output += content;
	return output;
}

export async function executeReadUrl(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadUrlToolDetails>> {
	let entry = await fetchReadUrl(session, params, signal);
	const truncation = truncateHead(entry.output, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: FETCH_DEFAULT_MAX_LINES,
	});
	const needsArtifact = truncation.truncated;
	if (needsArtifact && !entry.artifactId) {
		entry = await ensureReadUrlArtifact(session, entry);
	}
	const output = needsArtifact ? truncation.content : entry.output;
	const details: ReadUrlToolDetails = {
		...entry.details,
		truncated: Boolean(entry.details.truncated || needsArtifact),
	};

	const contentBlocks: Array<TextContent | ImageContent> = [{ type: "text", text: output }];
	if (entry.image) {
		contentBlocks.push({ type: "image", data: entry.image.data, mimeType: entry.image.mimeType });
	}

	const resultBuilder = toolResult(details).content(contentBlocks).sourceUrl(details.finalUrl);
	if (needsArtifact) {
		resultBuilder.truncation(truncation, { direction: "head", artifactId: entry.artifactId });
	} else if (entry.details.truncated) {
		const outputLines = entry.output.split("\n").length;
		const outputBytes = Buffer.byteLength(entry.output, "utf-8");
		const totalBytes = Math.max(outputBytes + 1, MAX_OUTPUT_CHARS + 1);
		const totalLines = outputLines + 1;
		resultBuilder.truncationFromText(entry.output, {
			direction: "tail",
			totalLines,
			totalBytes,
			maxBytes: MAX_OUTPUT_CHARS,
		});
	}

	return resultBuilder.done();
}

// =============================================================================
// TUI Rendering
// =============================================================================

/** Count non-empty lines */
function countNonEmptyLines(text: string): number {
	return text.split("\n").filter(l => l.trim()).length;
}

function readUrlLinkTarget(input: string): string {
	try {
		return parseReadUrlTarget(input)?.path ?? input;
	} catch {
		return input;
	}
}

function formatReadUrlDescription(input: string): string {
	const target = readUrlLinkTarget(input);
	const displayUrl = target.match(/^www\./i) ? `https://${target}` : target;
	const domain = getDomain(displayUrl);
	const urlPath = truncate(displayUrl.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	const label = `${domain}${urlPath ? ` ${urlPath}` : ""}`.trim();
	return urlHyperlink(target, label);
}

function formatReadUrlMetadataValue(url: string, uiTheme: Theme): string {
	return urlHyperlink(url, uiTheme.fg("mdLinkUrl", url));
}

/** Render URL read call (URL preview) */
export function renderReadUrlCall(
	args: { path?: string; url?: string; raw?: boolean },
	_options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const url = args.path ?? args.url ?? "";
	const description = formatReadUrlDescription(url);
	const meta: string[] = [];
	if (args.raw) meta.push("raw");
	const text = renderStatusLine({ icon: "pending", title: "Read", description, meta }, uiTheme);
	return new Text(text, 0, 0);
}

/** Render URL read result with tree-based layout */
export function renderReadUrlResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ReadUrlToolDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const details = result.details;

	if (result.isError || !details) {
		const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
		const errorText = (rawErrorText || "No response data").replace(/^Error:\s*/, "");
		const urlText = details?.finalUrl ?? details?.url ?? "";
		const description = urlText ? formatReadUrlDescription(urlText) : undefined;
		const header = renderStatusLine({ icon: "error", title: "Read", description }, uiTheme);
		const errorLines = errorText.split("\n").map(line => uiTheme.fg("error", replaceTabs(line)));
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render: (width: number) =>
				outputBlock.render({ header, state: "error", sections: [{ lines: errorLines }], width }, uiTheme),
			invalidate: () => outputBlock.invalidate(),
		});
	}

	const description = formatReadUrlDescription(details.finalUrl);
	const hasRedirect = details.url !== details.finalUrl;
	const hasNotes = details.notes.length > 0;
	const truncation = details.meta?.truncation;
	const truncated = Boolean(details.truncated || truncation);

	const header = renderStatusLine(
		{
			icon: truncated ? "warning" : "success",
			title: "Read",
			description,
		},
		uiTheme,
	);

	const contentText = result.content[0]?.text ?? "";
	const contentBody = contentText.includes("---\n\n")
		? contentText.split("---\n\n").slice(1).join("---\n\n")
		: contentText;
	const lineCount = countNonEmptyLines(contentBody);
	const charCount = contentBody.trim().length;
	const contentLines = contentBody.split("\n").filter(l => l.trim());

	const metadataLines: string[] = [
		`${uiTheme.fg("muted", "Content-Type:")} ${details.contentType || "unknown"}`,
		`${uiTheme.fg("muted", "Method:")} ${details.method}`,
	];
	if (hasRedirect) {
		metadataLines.push(
			`${uiTheme.fg("muted", "Final URL:")} ${formatReadUrlMetadataValue(details.finalUrl, uiTheme)}`,
		);
	}
	const lineLabel = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
	metadataLines.push(`${uiTheme.fg("muted", "Lines:")} ${lineLabel}`);
	metadataLines.push(`${uiTheme.fg("muted", "Chars:")} ${charCount}`);
	if (truncated) {
		metadataLines.push(uiTheme.fg("warning", `${uiTheme.status.warning} Output truncated`));
		if (truncation?.artifactId) metadataLines.push(formatStyledArtifactReference(truncation.artifactId, uiTheme));
	}
	if (hasNotes) {
		metadataLines.push(`${uiTheme.fg("muted", "Notes:")} ${details.notes.join("; ")}`);
	}

	const outputBlock = new CachedOutputBlock();
	let lastExpanded: boolean | undefined;
	let contentPreviewLines: string[] | undefined;

	return markFramedBlockComponent({
		render: (width: number) => {
			const { expanded } = options;

			if (contentPreviewLines === undefined || lastExpanded !== expanded) {
				const previewLimit = expanded ? 12 : 3;
				const previewList = applyListLimit(contentLines, { headLimit: previewLimit });
				const previewLines = previewList.items.map(line => line.trimEnd());
				const remaining = Math.max(0, contentLines.length - previewList.items.length);
				contentPreviewLines =
					previewLines.length > 0
						? previewLines.map(line => uiTheme.fg("dim", line))
						: [uiTheme.fg("dim", "(no content)")];
				if (remaining > 0) {
					const hint = formatExpandHint(uiTheme, expanded, true);
					contentPreviewLines.push(uiTheme.fg("muted", `… ${remaining} more lines${hint ? ` ${hint}` : ""}`));
				}
				lastExpanded = expanded;
				outputBlock.invalidate();
			}

			return outputBlock.render(
				{
					header,
					state: truncated ? "warning" : "success",
					sections: [
						{ label: uiTheme.fg("toolTitle", "Metadata"), lines: metadataLines },
						{ label: uiTheme.fg("toolTitle", "Content Preview"), lines: contentPreviewLines },
					],
					width,
					applyBg: false,
				},
				uiTheme,
			);
		},
		invalidate: () => {
			outputBlock.invalidate();
			contentPreviewLines = undefined;
			lastExpanded = undefined;
		},
	});
}
