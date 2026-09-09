import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
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
 * Startpage proxies Google's index behind a privacy frontend and serves fully
 * server-rendered result pages — no JS challenge on the happy path. Its bot
 * defense keys on requests that skip the homepage handshake: the search form
 * carries a session token (`sc`) plus sibling hidden inputs, and posting the
 * form with a stale/absent token 302s to the `/en/errors/` CAPTCHA shell.
 * The robust flow is therefore the same dance a real browser performs: GET
 * the homepage, lift the form's hidden inputs, POST them back with the query.
 */
const STARTPAGE_HOME_URL = "https://www.startpage.com/";
const STARTPAGE_SEARCH_URL = "https://www.startpage.com/sp/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/**
 * Recency → Startpage `with_date` param. Accepts single letters; an absent
 * value returns the unfiltered default.
 */
const RECENCY_TO_STARTPAGE_WITH_DATE: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "d",
	week: "w",
	month: "m",
	year: "y",
};

/** One organic result lifted from the Startpage results page. */
interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * `true` when Startpage answered with its CAPTCHA/error shell instead of
 * results. Rejected requests 302 to `/en/errors/` (legacy: `/sp/captcha`), a
 * Gatsby SPA whose chunk map names the captcha page components; the body
 * marker matters because mocked fetch responses carry no final URL. A bare
 * "captcha" substring is deliberately not used — result snippets for
 * captcha-related queries would false-positive.
 */
function isChallengeResponse(page: LoadedHtmlPage): boolean {
	if (/\/(?:errors|captcha)\//.test(page.url) || page.url.includes("/sp/captcha")) return true;
	return page.html.includes("component---src-pages-captcha") || page.html.includes("/sp/captcha");
}

/**
 * Lift the hidden inputs from the homepage's `/sp/search` form. Returns
 * `undefined` when the form or its `sc` anti-bot token cannot be found so the
 * caller can degrade to a tokenless GET instead of posting a doomed form.
 */
function parseSearchFormInputs(html: string): Record<string, string> | undefined {
	const { document } = parseHTML(html);
	const form = document.querySelector('form[action="/sp/search"]');
	if (!form) return undefined;
	const inputs: Record<string, string> = {};
	for (const input of form.querySelectorAll('input[type="hidden"]')) {
		const name = input.getAttribute("name");
		if (name) inputs[name] = input.getAttribute("value") ?? "";
	}
	return inputs.sc ? inputs : undefined;
}

/** Accept only http(s) result targets that point away from Startpage itself. */
function sanitizeResultUrl(href: string | null | undefined): string | undefined {
	if (!href) return undefined;
	let url: URL;
	try {
		url = new URL(href, STARTPAGE_HOME_URL);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.hostname === "startpage.com" || url.hostname.endsWith(".startpage.com")) return undefined;
	return url.href;
}

/**
 * Walk the server-rendered results page in document order.
 *
 * Each organic hit lives in a `div.result` container holding the title
 * anchor `a.result-link` (with an `h2.wgl-title` heading) and an optional
 * `p.description` snippet. Hrefs are direct target URLs — Startpage does not
 * wrap outbound clicks. The offscreen adblock-honeypot div uses the class
 * token `a-bg-result`, which a CSS class selector correctly ignores, and
 * sponsored placements render outside `div.result` containers.
 */
function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const block of document.querySelectorAll("div.result")) {
		const anchor = block.querySelector("a.result-link");
		if (!anchor) continue;
		const url = sanitizeResultUrl(anchor.getAttribute("href"));
		if (!url) continue;
		const title = normalizeText(anchor.querySelector("h2, h3")?.textContent ?? anchor.textContent);
		if (!title) continue;
		const snippet = normalizeText(block.querySelector("p.description")?.textContent);
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

/**
 * Fetch the homepage and lift the search form's hidden inputs. Best effort:
 * any failure (network, non-OK status, challenge shell, markup drift) yields
 * `undefined` and the caller falls back to a direct GET.
 */
async function fetchFormInputs(
	fetchImpl: FetchImpl,
	signal: AbortSignal,
	timeoutMs?: number,
): Promise<Record<string, string> | undefined> {
	let page: LoadedHtmlPage;
	try {
		page = await browserFetch(STARTPAGE_HOME_URL, { fetch: fetchImpl, signal, timeoutMs });
	} catch (error) {
		if (signal.aborted) throw error;
		return undefined;
	}
	if (page.status < 200 || page.status >= 300 || isChallengeResponse(page)) return undefined;
	return parseSearchFormInputs(page.html);
}

async function callStartpageHtml(params: SearchParams): Promise<string> {
	const fetchImpl = params.fetch ?? fetch;
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const withDate = params.recency ? RECENCY_TO_STARTPAGE_WITH_DATE[params.recency] : undefined;
	// Startpage proxies Google, so the operator set works inline; rebuild via
	// the shared scraper formatter to canonicalize aliases (domain: → site:,
	// since: → after:, …) and demote scraper-hostile operators. Directive-free
	// queries pass through byte-identical.
	const query = formatScraperQuery(params.query, params.parsedQuery);

	const formInputs = await fetchFormInputs(fetchImpl, signal, params.timeoutMs);
	let page: LoadedHtmlPage;
	if (formInputs) {
		const form = new URLSearchParams(formInputs);
		form.set("query", query);
		if (withDate) form.set("with_date", withDate);
		page = await browserFetch(STARTPAGE_SEARCH_URL, {
			fetch: fetchImpl,
			signal,
			timeoutMs: params.timeoutMs,
			referer: STARTPAGE_HOME_URL,
			init: { method: "POST", body: form.toString() },
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
		});
	} else {
		const url = new URL(STARTPAGE_SEARCH_URL);
		url.searchParams.set("query", query);
		if (withDate) url.searchParams.set("with_date", withDate);
		page = await browserFetch(url.href, {
			fetch: fetchImpl,
			signal,
			timeoutMs: params.timeoutMs,
			referer: STARTPAGE_HOME_URL,
		});
	}

	if (isChallengeResponse(page)) {
		throw new SearchProviderError(
			"startpage",
			"Startpage blocked the request with a CAPTCHA challenge. Startpage rate-limits automated searches from datacenter/shared-egress IPs; try another provider such as DuckDuckGo or Mojeek, or retry later.",
			429,
		);
	}
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("startpage", page.status, page.html);
		if (classified) throw classified;
		throw new SearchProviderError("startpage", `Startpage HTML error (${page.status})`, page.status);
	}
	return page.html;
}

/** Execute a Startpage web search via the homepage-token form flow. */
export async function searchStartpage(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const html = await callStartpageHtml(params);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "startpage", sources };
}

/** Search provider for Startpage (no API key required). */
export class StartpageProvider extends SearchProvider {
	readonly id = "startpage";
	readonly label = "Startpage";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchStartpage(params);
	}
}
