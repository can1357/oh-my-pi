/**
 * Keenable Web Search Provider
 *
 * POST https://api.keenable.ai/v1/search with `X-API-Key` when a `keenable`
 * credential resolves; otherwise (explicit selection only) the keyless,
 * per-IP rate-limited https://api.keenable.ai/v1/search/public endpoint.
 * Docs: https://docs.keenable.ai/api-reference/search
 */
import { type AuthStorage, type FetchImpl, resolveApiKeyOnce, seedApiKeyResolver, withAuth } from "@oh-my-pi/pi-ai";
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

const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
/** App identifier the keyless endpoint requires; requests without it are rejected with 400. */
const KEENABLE_APP_TITLE = "oh-my-pi";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

/** Keenable accepts relative deltas on its date filters. */
const RECENCY_DELTAS: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "1d",
	week: "7d",
	month: "1mo",
	year: "1y",
};

type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

interface KeenableSearchBody {
	query: string;
	max_results: number;
	site?: string;
	published_after?: string;
	published_before?: string;
}

interface KeenableSearchResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	published_at?: unknown;
}

interface KeenableSearchResponse {
	results?: unknown;
}

/**
 * Keenable takes plain keywords and quoted phrases; a single `site:` host maps
 * to the native `site` filter and date bounds to `published_after` /
 * `published_before`. Everything else is left to the central post-filter.
 */
function buildKeenableBody(
	parsed: StructuredQuery,
	recency: SearchParams["recency"],
	maxResults: number,
): KeenableSearchBody {
	// Blanking `raw` makes a directives-only query fall back to its constraint
	// values (site hosts, intitle: words, …) as keywords, never to the operators.
	const query = parsed.hasDirectives ? formatQuery({ ...parsed, raw: "" }, { phrases: true }) : parsed.raw.trim();
	if (!query) {
		throw new SearchProviderError(
			"keenable",
			"Keenable needs search terms; date-only queries are not supported",
			400,
		);
	}
	const body: KeenableSearchBody = { query, max_results: maxResults };
	const sites = siteHosts(parsed.sites);
	if (sites.length === 1) body.site = sites[0];
	const after = parsed.after ?? (recency ? RECENCY_DELTAS[recency] : undefined);
	if (after) body.published_after = after;
	if (parsed.before) body.published_before = parsed.before;
	return body;
}

async function callKeenableSearch(
	apiKey: string | undefined,
	body: KeenableSearchBody,
	params: SearchParamsWithFetch,
): Promise<KeenableSearchResponse> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	if (apiKey) headers["X-API-Key"] = apiKey;
	else headers["X-Keenable-Title"] = KEENABLE_APP_TITLE;

	const response = await (params.fetch ?? fetch)(apiKey ? KEENABLE_SEARCH_URL : KEENABLE_PUBLIC_SEARCH_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "keenable", MAX_ERROR_BYTES, true);
		const classified = classifyProviderHttpError("keenable", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"keenable",
			`Keenable search API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const raw = await readLimitedText(response, "keenable", MAX_RESPONSE_BYTES);
	try {
		return JSON.parse(raw) as KeenableSearchResponse;
	} catch {
		throw new SearchProviderError("keenable", "Keenable search API returned invalid JSON", 500);
	}
}

/** Execute Keenable web search. */
export async function searchKeenable(params: SearchParamsWithFetch): Promise<SearchResponse> {
	const maxResults = Math.floor(
		clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const body = buildKeenableBody(parsed, params.recency, maxResults);
	const keyResolver = params.authStorage.keys.resolver("keenable", { sessionId: params.sessionId });
	const apiKey = await resolveApiKeyOnce(keyResolver, params.signal);
	let data: KeenableSearchResponse;
	if (apiKey) {
		// Reuse the preflight credential, then let withAuth refresh / rotate on 401/402.
		data = await withAuth(seedApiKeyResolver(apiKey, keyResolver), key => callKeenableSearch(key, body, params), {
			signal: params.signal,
		});
	} else if (params.authStorage.keys.source("keenable") !== undefined) {
		// A configured credential that fails to resolve must not silently downgrade to anonymous search.
		throw new SearchProviderError(
			"keenable",
			"Keenable credentials could not be resolved. Check your configured API key or credential helper.",
		);
	} else {
		data = await callKeenableSearch(undefined, body, params);
	}

	if (!Array.isArray(data.results)) {
		throw new SearchProviderError("keenable", "Keenable search API returned an unexpected response shape", 500);
	}

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const entry of data.results as unknown[]) {
		if (typeof entry !== "object" || entry === null) continue;
		const result = entry as KeenableSearchResult;
		const url = normalizeHttpUrl(result.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const publishedDate =
			typeof result.published_at === "string" && result.published_at ? result.published_at : undefined;
		sources.push({
			title: normalizeSearchText(result.title) ?? url,
			url,
			snippet: normalizeSearchText(result.snippet),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	return {
		provider: "keenable",
		sources: sources.slice(0, maxResults),
		authMode: apiKey ? "api_key" : "anonymous",
	};
}

/** Search provider for Keenable web search. */
export class KeenableProvider extends SearchProvider {
	readonly id = "keenable";
	readonly label = "Keenable";

	/** The auto chain admits Keenable only when a key is configured. */
	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("keenable") !== undefined;
	}

	/** An explicit `web/keenable` selection works without a key via the public endpoint. */
	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		return searchKeenable(params);
	}
}
