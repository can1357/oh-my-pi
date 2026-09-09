/**
 * Synthetic Web Search Provider
 *
 * Uses Synthetic's zero-data-retention web search API for coding agents.
 * Endpoint: POST https://api.synthetic.new/v2/search
 */

import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

const SYNTHETIC_SEARCH_URL = "https://api.synthetic.new/v2/search";

interface SyntheticSearchResult {
	url: string;
	title: string;
	text?: string;
	published?: string;
}

interface SyntheticSearchResponse {
	results: SyntheticSearchResult[];
}

/** Resolve Synthetic API key through the shared auth storage pipeline. */
export function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return authStorage.getApiKey("synthetic", sessionId, { signal });
}

/** Call Synthetic search API. */
async function callSyntheticSearch(
	apiKey: string,
	query: string,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = fetch,
	timeoutMs?: number,
): Promise<SyntheticSearchResponse> {
	const response = await fetchImpl(SYNTHETIC_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ query }),
		signal: withHardTimeout(signal, timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("synthetic", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"synthetic",
			`Synthetic API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return (await response.json()) as SyntheticSearchResponse;
}

/** Execute Synthetic web search. */
export async function searchSynthetic(params: SearchParamsWithFetch): Promise<SearchResponse> {
	const keyOrResolver: ApiKey = params.authStorage.resolver("synthetic", {
		sessionId: params.sessionId,
	});

	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives
		? formatQuery(parsed, { phrases: true, negation: true, site: true })
		: params.query;

	const fetchImpl = params.fetch;
	const data = await withAuth(
		keyOrResolver,
		key => callSyntheticSearch(key, query, params.signal, fetchImpl, params.timeoutMs),
		{
			signal: params.signal,
			missingKeyMessage:
				"Synthetic credentials not found. Set SYNTHETIC_API_KEY or login with 'omp /login synthetic'.",
		},
	);
	const sources: SearchSource[] = [];

	for (const result of data.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.text ?? undefined,
			publishedDate: result.published ?? undefined,
		});
	}

	const numResults = params.numSearchResults ?? params.limit;
	const limitedSources = numResults ? sources.slice(0, numResults) : sources;

	return {
		provider: "synthetic",
		sources: limitedSources,
	};
}

/** Search provider for Synthetic. */
export class SyntheticProvider extends SearchProvider {
	readonly id = "synthetic";
	readonly label = "Synthetic";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("synthetic") || !!getEnvApiKey("synthetic");
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		return searchSynthetic(params);
	}
}
