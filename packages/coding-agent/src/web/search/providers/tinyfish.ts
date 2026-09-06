/**
 * TinyFish Web Search Provider
 *
 * Calls TinyFish's search API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MAX_PAGE = 10;

/** TinyFish is SERP-backed: common Google-style operators pass through. */
const TINYFISH_QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true, filetype: true };

const RECENCY_MINUTES: Record<NonNullable<SearchParams["recency"]>, number> = {
	day: 1440,
	week: 10080,
	month: 43200,
	year: 525600,
};

export interface TinyFishSearchParams {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	page?: number;
	include_domains?: string[];
	exclude_domains?: string[];
	/** ISO 3166-1 alpha-2 region, e.g. `IT`. Geolocates results. */
	location?: string;
	/** ISO 639-1 language, e.g. `it`. */
	language?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface TinyFishSearchResult {
	title?: string | null;
	url?: string | null;
	snippet?: string | null;
	site_name?: string | null;
}

interface TinyFishSearchResponse {
	total_results?: number | null;
	page?: number | null;
	results?: TinyFishSearchResult[] | null;
}

/** Resolve TinyFish API key through the shared auth storage pipeline. */
export function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return authStorage.getApiKey("tinyfish", sessionId, { signal });
}

async function callTinyFishSearch(apiKey: string, params: TinyFishSearchParams): Promise<TinyFishSearchResponse> {
	const url = new URL(TINYFISH_SEARCH_URL);
	url.searchParams.set("query", params.query);
	if (params.recency) {
		url.searchParams.set("recency_minutes", String(RECENCY_MINUTES[params.recency]));
	}
	if (params.include_domains?.length) {
		url.searchParams.set("include_domains", params.include_domains.join(","));
	}
	if (params.exclude_domains?.length) {
		url.searchParams.set("exclude_domains", params.exclude_domains.join(","));
	}
	if (params.location) {
		url.searchParams.set("location", params.location);
	}
	if (params.language) {
		url.searchParams.set("language", params.language);
	}
	if (params.num_results !== undefined) {
		url.searchParams.set("num_results", String(params.num_results));
	}
	if (params.page !== undefined) {
		url.searchParams.set("page", String(params.page));
	}

	const response = await (params.fetch ?? fetch)(url, {
		method: "GET",
		headers: {
			Accept: "application/json",
			"X-API-Key": apiKey,
		},
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("tinyfish", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"tinyfish",
			`TinyFish API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return (await response.json()) as TinyFishSearchResponse;
}

function appendTinyFishSources(
	sources: SearchSource[],
	results: readonly TinyFishSearchResult[],
	seenUrls: Set<string>,
): void {
	for (const result of results) {
		const url = result.url?.trim();
		if (!url || seenUrls.has(url)) continue;
		seenUrls.add(url);
		const siteName = result.site_name?.trim();
		sources.push({
			title: result.title?.trim() || siteName || url,
			url,
			snippet: result.snippet?.replace(/\s+/g, " ").trim() || undefined,
			author: siteName || undefined,
		});
	}
}

/** Bare hosts from `site:` values; path constraints remain centrally post-filtered. */
function siteHosts(sites: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const site of sites) {
		const host = site.split("/", 1)[0];
		if (host) hosts.add(host);
	}
	return [...hosts];
}

/**
 * Derive TinyFish `location` (ISO 3166-1 alpha-2, uppercase) and `language`
 * (ISO 639-1, lowercase) from a parsed `lang:` directive. The region subtag is
 * optional: `lang:it` yields language only, `lang:it-it` yields both. Non-region
 * subtags (e.g. the script in `zh-hans`) never become a location.
 */
function tinyFishLocale(lang: string | undefined): { location?: string; language?: string } {
	if (!lang) return {};
	const match = /^([a-z]{2})(?:[-_]([a-z]{2}))?(?:[-_]|$)/.exec(lang.toLowerCase());
	if (!match) return {};
	return { language: match[1], location: match[2]?.toUpperCase() };
}

/** Execute TinyFish web search. */
export async function searchTinyFish(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const pageSize = Math.min(numResults, DEFAULT_NUM_RESULTS);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const tinyFishParams: TinyFishSearchParams = {
		query: parsed.hasDirectives ? formatQuery(parsed, TINYFISH_QUERY_SYNTAX) : params.query,
		num_results: pageSize,
		recency: params.recency,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
	if (parsed.hasDirectives) {
		const includeDomains = siteHosts(parsed.sites);
		const excludeDomains = siteHosts(parsed.excludedSites);
		if (includeDomains.length > 0) tinyFishParams.include_domains = includeDomains;
		if (excludeDomains.length > 0) tinyFishParams.exclude_domains = excludeDomains;
	}
	const { location, language } = tinyFishLocale(parsed.lang);
	if (location) tinyFishParams.location = location;
	if (language) tinyFishParams.language = language;
	const keyOrResolver: ApiKey = params.authStorage.resolver("tinyfish", {
		sessionId: params.sessionId,
	});
	const sources = await withAuth(
		keyOrResolver,
		async key => {
			const collected: SearchSource[] = [];
			const seenUrls = new Set<string>();
			for (let page = 0; page <= MAX_PAGE && collected.length < numResults; page += 1) {
				const searchPage = await callTinyFishSearch(key, { ...tinyFishParams, page });
				if (!Array.isArray(searchPage.results)) {
					throw new Error("TinyFish Search API returned an unexpected response shape");
				}
				appendTinyFishSources(collected, searchPage.results, seenUrls);
				if (searchPage.results.length < pageSize) break;
			}

			return collected.slice(0, numResults);
		},
		{
			signal: params.signal,
			missingKeyMessage:
				'TinyFish credentials not found. Set TINYFISH_API_KEY or configure an API key for provider "tinyfish".',
		},
	);

	return {
		provider: "tinyfish",
		sources,
		authMode: "api_key",
	};
}

/** Search provider for TinyFish web search. */
export class TinyFishProvider extends SearchProvider {
	readonly id = "tinyfish";
	readonly label = "TinyFish";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("tinyfish") || !!getEnvApiKey("tinyfish");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchTinyFish(params);
	}
}
