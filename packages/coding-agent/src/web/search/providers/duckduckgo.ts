import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { QuerySyntax } from "../query";
import { formatScraperQuery, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

/**
 * DuckDuckGo's no-JS HTML search frontend. POST `q=…` to receive a static
 * results page we can parse without a real browser. The Instant Answer API
 * (`api.duckduckgo.com`) was tried first but it only returns content for
 * Wikipedia/Wolfram-Alpha-style topics — empty for the vast majority of
 * agent queries (see #3799).
 */
const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/**
 * Recency → DDG `df` form param. DDG accepts single letters for the time
 * filter; queries without a `df` value return the unfiltered default.
 */
const RECENCY_TO_DDG_DF: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "d",
	week: "w",
	month: "m",
	year: "y",
};

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
	/** ISO timestamp lifted from the result row, when DDG emits one. */
	publishedDate?: string;
}

/**
 * Decode an HTML-encoded fragment lifted from DDG markup. Strips inline tags
 * (the results page wraps query terms in `<b>`), unescapes the small set of
 * named entities DDG emits, and normalises whitespace.
 */
function decodeHtmlText(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Resolve a DDG result href back to the underlying target URL.
 *
 * DDG routes outbound clicks through `//duckduckgo.com/l/?uddg=<encoded>` so
 * it can record analytics; we want the unwrapped URL. Handles three shapes
 * the page mixes in practice: redirect wrappers, protocol-relative links,
 * and (rarely) absolute URLs on sponsored or instant answer rows.
 */
function unwrapResultUrl(href: string): string | undefined {
	if (!href) return undefined;
	const decoded = href.replace(/&amp;/gi, "&");
	const wrapMatch = decoded.match(/[?&]uddg=([^&]+)/);
	if (wrapMatch) {
		try {
			return decodeURIComponent(wrapMatch[1]);
		} catch {
			return undefined;
		}
	}
	if (decoded.startsWith("//")) return `https:${decoded}`;
	if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
	return undefined;
}

/**
 * Lift a result row's publication timestamp from DDG markup. Recent DDG HTML
 * renders it as a bare `<span>&nbsp; &nbsp; 2026-07-30T20:19:00.0000000</span>`
 * inside `result__extras__url`. Restrict the scan to that container so a
 * date-shaped value in a `<span class="result__snippet">` is not attributed
 * as publication metadata.
 */
function extractPublishedDate(block: string): string | undefined {
	const extrasUrl = /<div\b[^>]*\bclass="[^"]*\bresult__extras__url\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1];
	if (!extrasUrl) return undefined;
	for (const match of extrasUrl.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
		const text = decodeHtmlText(match[1]);
		if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/.test(text)) return text;
	}
	return undefined;
}

/**
 * Walk the HTML page and pull out result blocks in document order.
 *
 * DDG renders each result inside a `<div class="result …">` container with
 * `<a class="result__a" …>` for the title link and an optional sibling
 * `<a class="result__snippet">` (or `<div class="result__snippet">` in some
 * variants) for the preview text. Sponsored placements, missing snippets,
 * and the trailing pagination row are tolerated.
 */
function parseHtmlResults(html: string): ParsedResult[] {
	const results: ParsedResult[] = [];
	const blockRe =
		/<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
	const titleRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
	const snippetRe = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
	for (const match of html.matchAll(blockRe)) {
		const block = match[1];
		const title = titleRe.exec(block);
		if (!title) continue;
		const url = unwrapResultUrl(title[1]);
		if (!url) continue;
		const titleText = decodeHtmlText(title[2]);
		if (!titleText) continue;
		const snippet = snippetRe.exec(block);
		const snippetText = snippet ? decodeHtmlText(snippet[1]) : undefined;
		results.push({
			title: titleText,
			url,
			snippet: snippetText || undefined,
			publishedDate: extractPublishedDate(block),
		});
	}
	return results;
}
/**
 * Extract the hidden fields from DDG's next-page form.
 *
 * Attribute order varies across responses, so each input tag is parsed
 * independently instead of matching one fixed HTML layout.
 */
function parseContinuationForm(html: string): URLSearchParams | undefined {
	for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
		const form = new URLSearchParams();
		for (const inputMatch of formMatch[1].matchAll(/<input\b[^>]*>/gi)) {
			const input = inputMatch[0];
			const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
			const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
			if (name && value !== undefined) form.append(decodeHtmlText(name), decodeHtmlText(value));
		}
		if (form.has("s") && form.has("vqd")) return form;
	}
	return undefined;
}

/**
 * `true` when the page DDG returned is the bot-challenge modal instead of
 * real results. DDG mixes status codes (200 vs 202) on these so the body
 * check is the reliable signal.
 */
function isAnomalyResponse(html: string): boolean {
	return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

/**
 * Query syntax the DDG HTML frontend parses: quotes, `-`, OR, site:,
 * filetype:, intitle:, inurl:, intext:. Date bounds (`before:`/`after:`) are
 * deliberately off — DDG does not parse them, so they are stripped from the
 * query and enforced by the pipeline's lenient post-filter instead.
 */
const DDG_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	inUrl: true,
	inTitle: true,
	inText: true,
	filetype: true,
};

/**
 * DuckDuckGo's documented `kl` values.
 *
 * The codes resemble `region-language` locales but contain provider-specific
 * identifiers (`jp-jp`, `tw-tzh`, `uk-en`) that cannot be derived mechanically.
 */
const DDG_KL_CODES = new Set([
	"xa-ar",
	"xa-en",
	"ar-es",
	"au-en",
	"at-de",
	"be-fr",
	"be-nl",
	"br-pt",
	"bg-bg",
	"ca-en",
	"ca-fr",
	"ct-ca",
	"cl-es",
	"cn-zh",
	"co-es",
	"hr-hr",
	"cz-cs",
	"dk-da",
	"ee-et",
	"fi-fi",
	"fr-fr",
	"de-de",
	"gr-el",
	"hk-tzh",
	"hu-hu",
	"in-en",
	"id-id",
	"id-en",
	"ie-en",
	"il-he",
	"it-it",
	"jp-jp",
	"kr-kr",
	"lv-lv",
	"lt-lt",
	"xl-es",
	"my-ms",
	"my-en",
	"mx-es",
	"nl-nl",
	"nz-en",
	"no-no",
	"pe-es",
	"ph-en",
	"ph-tl",
	"pl-pl",
	"pt-pt",
	"ro-ro",
	"ru-ru",
	"sg-en",
	"sk-sk",
	"sl-sl",
	"za-en",
	"es-es",
	"se-sv",
	"ch-de",
	"ch-fr",
	"ch-it",
	"tw-tzh",
	"th-th",
	"tr-tr",
	"ua-uk",
	"uk-en",
	"us-en",
	"ue-es",
	"ve-es",
	"vn-vi",
	"wt-wt",
]);

/** BCP 47 locales whose DDG code does not follow a simple component swap. */
const DDG_LOCALE_ALIASES: Record<string, string> = {
	"ca-es": "ct-ca",
	"en-gb": "uk-en",
	"es-419": "xl-es",
	"es-us": "ue-es",
	"ja-jp": "jp-jp",
	"ko-kr": "kr-kr",
	"zh-hk": "hk-tzh",
	"zh-tw": "tw-tzh",
};

/**
 * Map a parsed `lang:` locale onto DuckDuckGo's documented `kl` values.
 *
 * Shared queries use `language-region` order while DDG generally uses
 * `region-language`. Provider-specific exceptions resolve through
 * {@link DDG_LOCALE_ALIASES}; all other values must survive the documented
 * allowlist after swapping or the caller keeps its default region.
 */
export function localeToKl(lang: string | undefined): string | undefined {
	if (!lang) return undefined;
	const locale = lang.toLowerCase().replaceAll("_", "-");
	const alias = DDG_LOCALE_ALIASES[locale];
	if (alias) return alias;
	const match = /^([a-z]{2})-([a-z]{2})$/.exec(locale);
	if (!match) return undefined;
	const candidate = `${match[2]}-${match[1]}`;
	return DDG_KL_CODES.has(candidate) ? candidate : undefined;
}

function createDuckDuckGoForm(params: SearchParams): URLSearchParams {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const form = new URLSearchParams({
		q: formatScraperQuery(params.query, parsed, DDG_QUERY_SYNTAX),
		kl: localeToKl(parsed.lang) ?? "us-en",
	});
	const df = params.recency ? RECENCY_TO_DDG_DF[params.recency] : undefined;
	if (df) form.set("df", df);
	// Add b: "" parameter as specified in the browser fetch template to match real browser form submission
	form.set("b", "");
	return form;
}

async function callDuckDuckGoHtml(params: SearchParams, form: URLSearchParams, signal: AbortSignal): Promise<string> {
	const page = await browserFetch(DUCKDUCKGO_HTML_URL, {
		fetch: params.fetch ?? fetch,
		signal,
		timeoutMs: params.timeoutMs,
		referer: "https://html.duckduckgo.com/",
		init: {
			method: "POST",
			body: form.toString(),
		},
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
	});

	const body = page.html;
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("duckduckgo", page.status, body);
		if (classified) throw classified;
		throw new SearchProviderError("duckduckgo", `DuckDuckGo HTML error (${page.status})`, page.status);
	}

	if (isAnomalyResponse(body)) {
		throw new SearchProviderError(
			"duckduckgo",
			"DuckDuckGo blocked the request with a bot-detection challenge. DuckDuckGo throttles automated HTML searches from datacenter/shared-egress IPs; configure a credentialed provider such as Brave, Tavily, Exa, or Kagi for reliable web search.",
			429,
		);
	}

	return body;
}

/** Execute a DuckDuckGo web search via the no-JS HTML frontend. */
export async function searchDuckDuckGo(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	let form: URLSearchParams | undefined = createDuckDuckGoForm(params);

	while (form && sources.length < numResults) {
		const html = await callDuckDuckGoHtml(params, form, signal);
		const sourceCount = sources.length;
		for (const result of parseHtmlResults(html)) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			sources.push({
				title: result.title,
				url: result.url,
				snippet: result.snippet,
				publishedDate: result.publishedDate,
				ageSeconds: dateToAgeSeconds(result.publishedDate),
			});
			if (sources.length >= numResults) break;
		}

		if (sources.length === sourceCount) break;
		form = parseContinuationForm(html);
	}

	return { provider: "duckduckgo", sources };
}

/** Search provider for DuckDuckGo (no API key required). */
export class DuckDuckGoProvider extends SearchProvider {
	readonly id = "duckduckgo";
	readonly label = "DuckDuckGo";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDuckDuckGo(params);
	}
}
