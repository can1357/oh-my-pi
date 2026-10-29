/**
 * DeepSeek Web Search Provider
 *
 * Calls DeepSeek's Search API (in-house search engine) with the regular
 * DeepSeek API key and maps results into the unified SearchResponse shape.
 * Endpoint: POST https://api.deepseek.com/v1/tools/search
 * Docs: https://api-docs.deepseek.com/guides/search
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import type { StructuredQuery } from "../query";
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds, recencyAfterDate } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, normalizeSearchText, readLimitedText, siteHosts, withHardTimeout } from "./utils";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
/** The API rejects queries longer than 128 Unicode characters. */
const MAX_QUERY_CHARACTERS = 128;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

interface DeepSeekSearchResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	summary?: unknown;
	date?: unknown;
}

interface DeepSeekSearchResponse {
	results?: DeepSeekSearchResult[];
}

/**
 * Rebuild the query in DeepSeek's operator set: quoted phrases, `-term`,
 * `site:` clauses joined by `OR` (bare hosts; path parts are enforced by the
 * central post-filter), `-site:`, `lang:` (primary subtag), and
 * `after:`/`before:`. A relative recency becomes an `after:` bound unless the
 * query already carries one.
 */
function buildDeepSeekQuery(parsed: StructuredQuery, recency: SearchParams["recency"]): string {
	const after = parsed.after ?? (recency ? recencyAfterDate(recency) : undefined);
	if (!parsed.hasDirectives && !after) return parsed.raw.trim();

	// Terms only: directives are appended below in DeepSeek's dialect. `raw` is
	// blanked so a directives-only query does not fall back to the verbatim string.
	const text = formatQuery(
		{ ...parsed, raw: "", sites: [], excludedSites: [], after: undefined, before: undefined },
		{ phrases: true, negation: true },
	);
	const parts: string[] = [];
	if (text) parts.push(text);
	const sites = siteHosts(parsed.sites);
	if (sites.length) parts.push(sites.map(site => `site:${site}`).join(" OR "));
	parts.push(...siteHosts(parsed.excludedSites).map(site => `-site:${site}`));
	const lang = parsed.lang?.split("-", 1)[0];
	if (lang) parts.push(`lang:${lang}`);
	if (after) parts.push(`after:${after}`);
	if (parsed.before) parts.push(`before:${parsed.before}`);
	return parts.join(" ");
}

function normalizeUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

async function callDeepSeekSearch(
	apiKey: string,
	query: string,
	count: number,
	params: SearchParamsWithFetch,
): Promise<DeepSeekSearchResponse> {
	const fetchImpl = params.fetch ?? fetch;
	const response = await fetchImpl(DEEPSEEK_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ query, count }),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "deepseek", MAX_ERROR_BYTES, true);
		const classified = classifyProviderHttpError("deepseek", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"deepseek",
			`DeepSeek search API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const raw = await readLimitedText(response, "deepseek", MAX_RESPONSE_BYTES);
	try {
		return JSON.parse(raw) as DeepSeekSearchResponse;
	} catch {
		throw new SearchProviderError("deepseek", "DeepSeek search API returned invalid JSON", 500);
	}
}

/** Execute DeepSeek web search. */
export async function searchDeepSeek(params: SearchParamsWithFetch): Promise<SearchResponse> {
	const count = Math.floor(
		clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = buildDeepSeekQuery(parsed, params.recency);
	if ([...query].length > MAX_QUERY_CHARACTERS) {
		throw new SearchProviderError(
			"deepseek",
			`DeepSeek search queries cannot exceed ${MAX_QUERY_CHARACTERS} characters`,
			400,
		);
	}

	const keyOrResolver: ApiKey = params.authStorage.keys.resolver("deepseek", { sessionId: params.sessionId });
	const data = await withAuth(keyOrResolver, key => callDeepSeekSearch(key, query, count, params), {
		signal: params.signal,
		missingKeyMessage:
			'DeepSeek credentials not found. Set DEEPSEEK_API_KEY or configure an API key for provider "deepseek".',
	});

	const sources: SearchSource[] = [];
	for (const result of Array.isArray(data.results) ? data.results : []) {
		if (typeof result !== "object" || result === null) continue;
		const url = normalizeUrl(result.url);
		if (!url) continue;
		const publishedDate = typeof result.date === "string" && result.date ? result.date : undefined;
		sources.push({
			title: normalizeSearchText(result.title) ?? url,
			url,
			// `summary` is the long, model-oriented excerpt; `snippet` is the short UI blurb.
			snippet: normalizeSearchText(result.summary) ?? normalizeSearchText(result.snippet),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	return {
		provider: "deepseek",
		sources: sources.slice(0, count),
		authMode: "api_key",
	};
}

/** Search provider for DeepSeek's Search API. */
export class DeepSeekProvider extends SearchProvider {
	readonly id = "deepseek";
	readonly label = "DeepSeek";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("deepseek") !== undefined || !!getEnvApiKey("deepseek");
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		return searchDeepSeek(params);
	}
}
