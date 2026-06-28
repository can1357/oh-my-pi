/**
 * Firecrawl Web Search Provider
 *
 * Calls Firecrawl's search API and maps web results into the unified
 * SearchResponse shape used by the web search tool.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@pk-nerdsaver-ai/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 100;

const RECENCY_TBS: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

export interface FirecrawlSearchParams {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

interface FirecrawlWebResult {
	title?: string | null;
	url?: string | null;
	description?: string | null;
	markdown?: string | null;
}

interface FirecrawlSearchResponse {
	id?: string | null;
	data?: {
		web?: FirecrawlWebResult[] | null;
	} | null;
}

/** Resolve Firecrawl API key through the shared auth storage pipeline. */
export function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return authStorage.getApiKey("firecrawl", sessionId, { signal });
}

function buildRequestBody(params: FirecrawlSearchParams): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: params.query,
		limit: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
		sources: [{ type: "web" }],
	};
	if (params.recency) {
		body.tbs = RECENCY_TBS[params.recency];
	}
	return body;
}

async function callFirecrawlSearch(apiKey: string, params: FirecrawlSearchParams): Promise<FirecrawlSearchResponse> {
	const response = await (params.fetch ?? fetch)(FIRECRAWL_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(buildRequestBody(params)),
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("firecrawl", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"firecrawl",
			`Firecrawl API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return (await response.json()) as FirecrawlSearchResponse;
}

/** Execute Firecrawl web search. */
export async function searchFirecrawl(params: SearchParams): Promise<SearchResponse> {
	const firecrawlParams: FirecrawlSearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal: params.signal,
		fetch: params.fetch,
	};
	const keyOrResolver: ApiKey = params.authStorage.resolver("firecrawl", {
		sessionId: params.sessionId,
	});
	const numResults = clampNumResults(firecrawlParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const data = await withAuth(keyOrResolver, key => callFirecrawlSearch(key, firecrawlParams), {
		signal: params.signal,
		missingKeyMessage:
			'Firecrawl credentials not found. Set FIRECRAWL_API_KEY or configure an API key for provider "firecrawl".',
	});
	const sources: SearchSource[] = [];

	for (const result of data.data?.web ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.description ?? result.markdown ?? undefined,
		});
	}

	return {
		provider: "firecrawl",
		sources: sources.slice(0, numResults),
		requestId: data.id ?? undefined,
		authMode: "api_key",
	};
}

/** Search provider for Firecrawl web search. */
export class FirecrawlProvider extends SearchProvider {
	readonly id = "firecrawl";
	readonly label = "Firecrawl";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("firecrawl") || !!getEnvApiKey("firecrawl");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchFirecrawl(params);
	}
}
