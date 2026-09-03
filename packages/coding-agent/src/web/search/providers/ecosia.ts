import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatScraperQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import type { LoadedHtmlPage } from "./browser-page";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

/**
 * Ecosia serves a server-rendered Vue/Nuxt results page (no `__NUXT_DATA__`
 * JSON island — probed 2026-07), so both load paths parse the same markup:
 * `<article data-test-id="organic-result">` blocks whose title anchor carries
 * the final target URL directly (no redirect wrapper). The site fronts search
 * with Cloudflare. Requests start with a browser-profiled fetch and escalate
 * to the shared stealth browser only when the response is blocked or fails.
 *
 * Recency is ignored: Ecosia's web results expose no date filter in the UI
 * and the legacy Bing-era `freshness` param is a server-side no-op (verified
 * live), so per the {@link SearchParams.recency} contract the field must not
 * be approximated.
 */
const ECOSIA_HOME_URL = "https://www.ecosia.org/";
const ECOSIA_SEARCH_URL = "https://www.ecosia.org/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const RESULT_RENDER_TIMEOUT_MS = 10_000;

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

/**
 * Validate a result anchor href. Organic anchors carry the target URL
 * directly; anything non-http(s) or pointing back at ecosia.org (internal
 * navigation such as the images/news verticals) is rejected.
 */
function resolveResultUrl(href: string): string | undefined {
	let url: URL;
	try {
		url = new URL(href, ECOSIA_HOME_URL);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.hostname === "ecosia.org" || url.hostname === "www.ecosia.org") return undefined;
	return url.href;
}

/**
 * Pull organic results out of the page in document order. Each result is an
 * `<article data-test-id="organic-result">` with the title inside
 * `<h2 data-test-id="result-title">` wrapped by the target link, and the
 * preview text inside `<p data-test-id="web-result-description">`. The inner
 * paragraph is preferred over its `result-description` container because the
 * container also holds screen-reader-only thumbnail captions on video rows.
 * Ad slots (`data-test-id="ad-google"`) and entity/infobox cards use
 * different test-ids and never match.
 */
function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const article of document.querySelectorAll('article[data-test-id="organic-result"]')) {
		const heading = article.querySelector('[data-test-id="result-title"]');
		const href = heading?.closest("a")?.getAttribute("href");
		if (!heading || !href) continue;
		const url = resolveResultUrl(href);
		if (!url) continue;
		const title = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!title) continue;
		const description =
			article.querySelector('[data-test-id="web-result-description"]') ??
			article.querySelector('[data-test-id="result-description"]');
		const snippet = (description?.textContent ?? "").replace(/\s+/g, " ").trim();
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

/**
 * `true` when Ecosia's Cloudflare front answered with the managed challenge
 * instead of results. The observed page is a 403 titled "Ecosia Firewall"
 * carrying the `_cf_chl_opt` bootstrap and the challenge-platform loader.
 */
function isBlockedPage(page: LoadedHtmlPage): boolean {
	return (
		page.status === 403 ||
		page.status === 429 ||
		page.html.includes("Ecosia Firewall") ||
		page.html.includes("_cf_chl_opt") ||
		page.html.includes("/cdn-cgi/challenge-platform/") ||
		/confirm you.{0,3}re not a robot/i.test(page.html)
	);
}

async function callEcosiaHtml(params: SearchParams): Promise<string> {
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const url = new URL(ECOSIA_SEARCH_URL);
	// Ecosia serves Google-backed results, so classic operators pass through
	// inline; canonicalize aliases (domain: -> site:, since: -> after:) and
	// demote scraper-hostile operators via the shared scraper formatter.
	url.searchParams.set("q", formatScraperQuery(params.query, params.parsedQuery));

	let page: LoadedHtmlPage;
	try {
		page = await browserFetch(url.href, {
			fetch: params.fetch,
			signal,
			timeoutMs: params.timeoutMs,
			referer: ECOSIA_HOME_URL,
			browser: {
				homeUrl: ECOSIA_HOME_URL,
				ready: {
					selector: 'article[data-test-id="organic-result"]',
					timeoutMs: RESULT_RENDER_TIMEOUT_MS,
				},
				shouldFallback: isBlockedPage,
			},
		});
	} catch (error) {
		if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
		if (signal.aborted) {
			throw new SearchProviderError("ecosia", "Ecosia search timed out.", 504);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new SearchProviderError("ecosia", `Ecosia search failed: ${message}`, 503);
	}

	if (isBlockedPage(page)) {
		throw new SearchProviderError(
			"ecosia",
			"Ecosia blocked the request with a Cloudflare bot challenge. Ecosia's firewall throttles automated searches from datacenter/shared-egress IPs; try another web search provider such as DuckDuckGo, Brave, or Tavily.",
			429,
		);
	}
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("ecosia", page.status, page.html);
		if (classified) throw classified;
		throw new SearchProviderError("ecosia", `Ecosia HTML error (${page.status})`, page.status);
	}
	return page.html;
}

/** Execute an Ecosia web search and parse the server-rendered result page. */
export async function searchEcosia(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const html = await callEcosiaHtml(params);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "ecosia", sources };
}

/** Search provider for Ecosia (no API key required). */
export class EcosiaProvider extends SearchProvider {
	readonly id = "ecosia";
	readonly label = "Ecosia";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchEcosia(params);
	}
}
