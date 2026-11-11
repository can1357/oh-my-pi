/**
 * Sofya Web Search Provider
 *
 * POST https://sofya.co/v1/search with bearer auth (`SOFYA_API_KEY` or a stored
 * `sofya` credential).
 * Docs: https://sofya.co/docs#search
 */
import { type AuthStorage, withAuth } from "@oh-my-pi/pi-ai";
import type { StructuredQuery } from "../query";
import { parseSearchQuery } from "../query";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import {
	classifyProviderHttpError,
	keywordQuery,
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
/** Sofya rejects more than 10 hosts in either domain list with a 422. */
const MAX_DOMAIN_FILTERS = 10;
const DAY_MS = 86_400_000;

type Recency = NonNullable<SearchParams["recency"]>;

interface SofyaSearchBody {
	query: string;
	/** 1 credit; `basic` adds page text (2 credits) that the tool output would truncate anyway. */
	search_depth: "snippets";
	max_results: number;
	include_domains?: string[];
	exclude_domains?: string[];
	/** A relative window, or a closed `YYYY-MM-DD:YYYY-MM-DD` range inclusive on both ends. */
	freshness?: Recency | `${string}:${string}`;
}

interface SofyaSearchResult {
	title?: unknown;
	url?: unknown;
	description?: unknown;
	content?: unknown;
	published_date?: unknown;
}

interface SofyaSearchResponse {
	results?: unknown;
	/** The query auto-corrected by the engine, else null. */
	altered_query?: unknown;
	/** The query retried without its `site:` operators (else its quotes) after zero results, else null. */
	relaxed_query?: unknown;
}

/**
 * `after:` is inclusive and `before:` exclusive, so a range ends the day before
 * `before:`. Sofya takes no open ranges: a missing side spans to the epoch or today.
 */
function sofyaFreshness(parsed: StructuredQuery, recency: Recency | undefined): SofyaSearchBody["freshness"] {
	if (!parsed.after && !parsed.before) return recency;
	const end = parsed.before ? new Date(Date.parse(parsed.before) - DAY_MS) : new Date();
	return `${parsed.after ?? "1970-01-01"}:${end.toISOString().slice(0, 10)}`;
}

/**
 * Sofya takes keywords, quoted phrases, and `-` exclusions. `site:` / `-site:` hosts map
 * to `include_domains` / `exclude_domains`, which Sofya compiles into `site:` operators;
 * past the cap, the include list narrows to its first hosts and further exclusions fall
 * to the central post-filter. Everything else is left to that post-filter.
 */
function buildSofyaBody(parsed: StructuredQuery, recency: Recency | undefined, maxResults: number): SofyaSearchBody {
	const body: SofyaSearchBody = {
		query: keywordQuery("sofya", parsed, { phrases: true, negation: true }),
		search_depth: "snippets",
		max_results: maxResults,
	};
	const include = siteHosts(parsed.sites);
	if (include.length > 0) body.include_domains = include.slice(0, MAX_DOMAIN_FILTERS);
	const exclude = siteHosts(parsed.excludedSites);
	if (exclude.length > 0) body.exclude_domains = exclude.slice(0, MAX_DOMAIN_FILTERS);
	const freshness = sofyaFreshness(parsed, recency);
	if (freshness) body.freshness = freshness;
	return body;
}

async function callSofyaSearch(
	apiKey: string,
	body: SofyaSearchBody,
	params: SearchParams,
): Promise<SofyaSearchResponse> {
	const response = await (params.fetch ?? fetch)(SOFYA_SEARCH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "sofya", MAX_ERROR_BYTES, true);
		throw (
			classifyProviderHttpError("sofya", response.status, errorText) ??
			new SearchProviderError("sofya", `Sofya search API error (${response.status}): ${errorText}`, response.status)
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
	const body = buildSofyaBody(params.parsedQuery ?? parseSearchQuery(params.query), params.recency, maxResults);
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
			snippet: normalizeSearchText(result.description) ?? normalizeSearchText(result.content),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
		if (sources.length === maxResults) break;
	}

	// Report a query Sofya rewrote, so a dropped `site:` or quote is visible rather than silent.
	const executedQuery = normalizeSearchText(data.relaxed_query) ?? normalizeSearchText(data.altered_query);
	return {
		provider: "sofya",
		sources,
		searchQueries: executedQuery ? [executedQuery] : undefined,
		authMode: "api_key",
	};
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
