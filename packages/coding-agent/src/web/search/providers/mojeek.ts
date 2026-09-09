import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import type { Page } from "puppeteer-core";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatScraperQuery, type QuerySyntax } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import type { LoadedHtmlPage } from "./browser-page";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const MOJEEK_ORIGIN = "https://www.mojeek.de";
const MOJEEK_HOME_URL = `${MOJEEK_ORIGIN}/?arc=none&lang=en&lb=en&theme=dark`;
const MOJEEK_SEARCH_URL = `${MOJEEK_ORIGIN}/search`;
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
/**
 * ALTCHA can complete quickly, but its verified redirect is occasionally
 * delayed by queueing on the challenge backend.
 */
const CAPTCHA_SOLVE_TIMEOUT_MS = 45_000;

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

/**
 * Validate a result href. Mojeek links results directly to the target site
 * (no redirect wrapper), so this only filters out non-HTTP schemes and
 * intra-Mojeek navigation rows (verticals, paging) that share the markup.
 */
function normalizeResultUrl(href: string): string | undefined {
	let url: URL;
	try {
		url = new URL(href, MOJEEK_HOME_URL);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (
		url.hostname === "mojeek.com" ||
		url.hostname.endsWith(".mojeek.com") ||
		url.hostname === "mojeek.co.uk" ||
		url.hostname.endsWith(".mojeek.co.uk") ||
		url.hostname === "mojeek.fr" ||
		url.hostname.endsWith(".mojeek.fr") ||
		url.hostname === "mojeek.de" ||
		url.hostname.endsWith(".mojeek.de")
	) {
		return undefined;
	}
	return url.href;
}

/**
 * Pull result blocks out of a Mojeek results page in document order.
 *
 * Each organic result renders as `ul.results-standard > li` with the title in
 * `h2 > a.title` (href is the direct target URL) and the preview text in
 * `p.s`. Clustered sub-results (`li.clu-result`) share the same shape; rows
 * without a title anchor (infoboxes, spelling suggestions) are skipped.
 */
function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const item of document.querySelectorAll("ul.results-standard > li")) {
		const anchor = item.querySelector("h2 a.title") ?? item.querySelector("a.title");
		const href = anchor?.getAttribute("href");
		if (!href) continue;
		const url = normalizeResultUrl(href);
		if (!url) continue;
		const title = (anchor?.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!title) continue;
		const snippet = (item.querySelector("p.s")?.textContent ?? "").replace(/\s+/g, " ").trim();
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

/**
 * Syntax re-emitted to Mojeek for directive-carrying queries. Mojeek's
 * support page (mojeek.com/support/search-operators.html) confirms `site:`,
 * and the community docs confirm quoted phrases and `-` exclusions. Mojeek
 * also parses `in*:` operators and its own date syntax (`since:`/`before:`
 * with YYYYMMDD), but the latter differs from Google's `after:`/`before:`
 * ISO form and `since` is already claimed by `recency`, so date bounds and
 * `in*` constraints are conservatively left to the pipeline's lenient
 * post-filter instead.
 */
const MOJEEK_QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true, site: true };

function buildSearchUrl(params: SearchParams, numResults: number): string {
	const url = new URL(MOJEEK_SEARCH_URL);
	url.searchParams.set("q", formatScraperQuery(params.query, params.parsedQuery, MOJEEK_QUERY_SYNTAX));
	url.searchParams.set("t", String(numResults));
	url.searchParams.set("arc", "none");
	url.searchParams.set("lang", "en");
	url.searchParams.set("lb", "en");
	url.searchParams.set("theme", "dark");
	// Mojeek's `since` filter accepts the relative tokens day/week/month/year
	// verbatim — the same vocabulary as `recency` (verified live: each window
	// returns a near-disjoint, fresher result set). Dates reflect crawl or
	// last-modification time per Mojeek's operator docs.
	if (params.recency) url.searchParams.set("since", params.recency);
	return url.href;
}

/** Solve Mojeek's ALTCHA interstitial and wait for its verified redirect to populate results. */
async function solveCaptcha(page: Page, signal: AbortSignal): Promise<void> {
	if (await untilAborted(signal, () => page.$("ul.results-standard li"))) return;

	const checkbox = await untilAborted(signal, () => page.$("altcha-widget input[type=checkbox]"));
	if (!checkbox) return;

	const navigation = page
		.waitForNavigation({ waitUntil: "domcontentloaded", timeout: CAPTCHA_SOLVE_TIMEOUT_MS })
		.catch(() => null);
	await untilAborted(signal, () => checkbox.click());
	await untilAborted(signal, () => navigation);
	await untilAborted(signal, () =>
		page.waitForSelector("ul.results-standard li", { timeout: CAPTCHA_SOLVE_TIMEOUT_MS }).catch(() => null),
	);
}

function isRobotPage(page: LoadedHtmlPage): boolean {
	return (
		(page.html.includes("altcha-widget") ||
			page.html.includes("captcha-wrap") ||
			/sending automated queries/i.test(page.html)) &&
		!page.html.includes("results-standard")
	);
}

async function callMojeekHtml(params: SearchParams, numResults: number): Promise<string> {
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const url = buildSearchUrl(params, numResults);
	let page: LoadedHtmlPage;
	try {
		page = await browserFetch(url, {
			fetch: params.fetch,
			signal,
			timeoutMs: params.timeoutMs,
			randomizeHeaders: false,
			referer: MOJEEK_HOME_URL,
			browser: {
				homeUrl: MOJEEK_HOME_URL,
				afterNavigation: solveCaptcha,
				shouldFallback: isRobotPage,
				attempts: 2,
				retryDelayMs: 1_000,
			},
		});
	} catch (error) {
		if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
		if (signal.aborted) {
			throw new SearchProviderError("mojeek", "Mojeek search timed out.", 504);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new SearchProviderError("mojeek", `Mojeek search failed: ${message}`, 503);
	}

	// Robot walls: the ALTCHA proof-of-work captcha page arrives as HTTP 200
	// (`<title>Captcha</title>`, `altcha-widget`) and the "automated queries"
	// refusal as HTTP 403. Both bodies are more actionable than their raw
	// statuses, so check them before the generic status handling.
	if (isRobotPage(page)) {
		throw new SearchProviderError(
			"mojeek",
			"Mojeek blocked the request with its automated-queries wall. Mojeek rate-limits scripted searches from datacenter/shared-egress IPs; retry later or configure another provider such as Brave, Tavily, Exa, or Kagi.",
			429,
		);
	}
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("mojeek", page.status, page.html);
		if (classified) throw classified;
		throw new SearchProviderError("mojeek", `Mojeek HTML error (${page.status})`, page.status);
	}
	return page.html;
}

/** Execute a Mojeek web search against the standard HTML results page. */
export async function searchMojeek(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const html = await callMojeekHtml(params, numResults);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "mojeek", sources };
}

/** Search provider for Mojeek (independent index, no API key required). */
export class MojeekProvider extends SearchProvider {
	readonly id = "mojeek";
	readonly label = "Mojeek";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchMojeek(params);
	}
}
