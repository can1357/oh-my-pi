/**
 * Sofya Web Search Provider
 *
 * POST https://sofya.co/v1/search with bearer auth (`SOFYA_API_KEY` or a stored
 * `sofya` credential).
 * Docs: https://sofya.co/docs
 */
import { type AuthStorage, withAuth } from "@oh-my-pi/pi-ai";
import type { StructuredQuery } from "../query";
import { formatQuery, parseSearchQuery } from "../query";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import {
	classifyProviderHttpError,
	normalizeHttpUrl,
	normalizeSearchText,
	readLimitedText,
	siteHosts,
	withHardTimeout,
} from "./utils";

const SOFYA_SEARCH_URL = "https://sofya.co/v1/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
/** Sofya's `SearchRequest` takes at most 10 hosts in each of `include_domains` / `exclude_domains`. */
const MAX_DOMAIN_FILTERS = 10;

interface SofyaSearchBody {
	query: string;
	/** `snippets` returns search snippets only; `basic` would add page text the tool output truncates anyway. */
	search_depth: "snippets";
	max_results: number;
	include_domains?: string[];
	exclude_domains?: string[];
	/** `day` / `week` / `month` / `year`, or an inclusive `YYYY-MM-DD:YYYY-MM-DD` range. */
	freshness?: string;
}

interface SofyaSearchResult {
	title?: unknown;
	url?: unknown;
	content?: unknown;
	published_date?: unknown;
}

interface SofyaSearchResponse {
	results?: unknown;
}

/**
 * Sofya takes plain keywords, quoted phrases, and `-` exclusions; `site:` /
 * `-site:` hosts map to `include_domains` / `exclude_domains`, and date bounds
 * or `recency` to `freshness`. Everything else is left to the central post-filter.
 * Past 10 hosts per list, only the first 10 are sent: an include list then searches
 * a subset of the requested sites, and the post-filter drops hosts excluded past
 * the cap, so every returned source still meets the query's constraints.
 */
function buildSofyaBody(
	parsed: StructuredQuery,
	recency: SearchParams["recency"],
	maxResults: number,
): SofyaSearchBody {
	// Blanking `raw` makes a directives-only query fall back to its constraint
	// values (site hosts, intitle: words, …) as keywords, never to the operators.
	const query = parsed.hasDirectives
		? formatQuery({ ...parsed, raw: "" }, { phrases: true, negation: true })
		: parsed.raw.trim();
	if (!query) {
		throw new SearchProviderError("sofya", "Sofya needs search terms; date-only queries are not supported", 400);
	}
	const body: SofyaSearchBody = { query, search_depth: "snippets", max_results: maxResults };
	const include = siteHosts(parsed.sites).slice(0, MAX_DOMAIN_FILTERS);
	const exclude = siteHosts(parsed.excludedSites).slice(0, MAX_DOMAIN_FILTERS);
	if (include.length > 0) body.include_domains = include;
	if (exclude.length > 0) body.exclude_domains = exclude;
	if (parsed.after || parsed.before) {
		// Sofya only takes closed ranges; an open side spans to the epoch or today.
		body.freshness = `${parsed.after ?? "1970-01-01"}:${parsed.before ?? new Date().toISOString().slice(0, 10)}`;
	} else if (recency) {
		body.freshness = recency;
	}
	return body;
}

async function callSofyaSearch(
	apiKey: string,
	body: SofyaSearchBody,
	params: SearchParams,
): Promise<SofyaSearchResponse> {
	const response = await (params.fetch ?? fetch)(SOFYA_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "sofya", MAX_ERROR_BYTES, true);
		const classified = classifyProviderHttpError("sofya", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"sofya",
			`Sofya search API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const raw = await readLimitedText(response, "sofya", MAX_RESPONSE_BYTES);
	try {
		return JSON.parse(raw) as SofyaSearchResponse;
	} catch {
		throw new SearchProviderError("sofya", "Sofya search API returned invalid JSON", 500);
	}
}

/** Execute Sofya web search. */
export async function searchSofya(params: SearchParams): Promise<SearchResponse> {
	const maxResults = Math.floor(
		clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const body = buildSofyaBody(parsed, params.recency, maxResults);
	const data = await withAuth(
		params.authStorage.keys.resolver("sofya", { sessionId: params.sessionId }),
		key => callSofyaSearch(key, body, params),
		{
			signal: params.signal,
			missingKeyMessage:
				'Sofya credentials not found. Set SOFYA_API_KEY or configure an API key for provider "sofya".',
		},
	);

	if (typeof data !== "object" || data === null || !Array.isArray(data.results)) {
		throw new SearchProviderError("sofya", "Sofya search API returned an unexpected response shape", 500);
	}

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const entry of data.results as unknown[]) {
		if (typeof entry !== "object" || entry === null) continue;
		const result = entry as SofyaSearchResult;
		const url = normalizeHttpUrl(result.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const publishedDate =
			typeof result.published_date === "string" && result.published_date ? result.published_date : undefined;
		sources.push({
			title: normalizeSearchText(result.title) ?? url,
			url,
			snippet: normalizeSearchText(result.content),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	return { provider: "sofya", sources: sources.slice(0, maxResults), authMode: "api_key" };
}

/** Search provider for Sofya web search. */
export class SofyaProvider extends SearchProvider {
	readonly id = "sofya";
	readonly label = "Sofya";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("sofya") !== undefined;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSofya(params);
	}
}
