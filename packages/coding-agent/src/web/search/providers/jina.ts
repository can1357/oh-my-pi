/**
 * Jina Reader Web Search Provider
 *
 * Uses the Jina Reader `s.jina.ai` endpoint to fetch search results with
 * cleaned content.
 */

import { type ApiKey, type AuthStorage, type FetchImpl, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const JINA_SEARCH_URL = "https://s.jina.ai";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;
type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

export interface JinaSearchParams {
	query: string;
	authStorage: AuthStorage;
	sessionId?: string;
	num_results?: number;
	/** Single bare host for Jina's `X-Site` in-site search header. */
	site?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface JinaSearchResult {
	title?: string | null;
	url?: string | null;
	description?: string | null;
	content?: string | null;
}

interface JinaSearchEnvelope {
	code?: unknown;
	data?: unknown;
}

type JinaSearchResponse = JinaSearchResult[];

/** Call Jina Reader search API. */
async function callJinaSearch(
	apiKey: string,
	query: string,
	numResults: number,
	site?: string,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = fetch,
	timeoutMs?: number,
): Promise<JinaSearchResponse> {
	const requestUrl = new URL(`${JINA_SEARCH_URL}/${encodeURIComponent(query)}`);
	requestUrl.searchParams.set("count", String(numResults));

	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
	if (site) headers["X-Site"] = site;
	headers["X-Respond-With"] = "no-content";
	headers["X-Retain-Images"] = "none";
	const response = await fetchImpl(requestUrl, {
		headers,
		signal: withHardTimeout(signal, timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("jina", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("jina", `Jina API error (${response.status}): ${errorText}`, response.status);
	}

	const payload = (await response.json()) as JinaSearchEnvelope | JinaSearchResponse | null;
	if (Array.isArray(payload)) return payload;
	if (!payload || typeof payload !== "object") {
		throw new SearchProviderError("jina", "Jina API returned invalid response: expected an object or array");
	}
	if (typeof payload.code === "number" && payload.code !== 200) {
		throw new SearchProviderError("jina", `Jina API response reported failure (${payload.code})`, payload.code);
	}
	if (!Array.isArray(payload.data)) {
		throw new SearchProviderError("jina", "Jina API returned invalid response: expected data array");
	}
	return payload.data as JinaSearchResponse;
}

/** Execute Jina web search. */
export async function searchJina(params: JinaSearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const keyOrResolver: ApiKey = params.authStorage.resolver("jina", {
		sessionId: params.sessionId,
	});
	const response = await withAuth(
		keyOrResolver,
		apiKey =>
			callJinaSearch(apiKey, params.query, numResults, params.site, params.signal, params.fetch, params.timeoutMs),
		{
			signal: params.signal,
			missingKeyMessage: 'Jina credentials not found. Set JINA_API_KEY or configure an API key for provider "jina".',
		},
	);
	const sources: SearchSource[] = [];

	for (const result of response) {
		if (!result?.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.description?.trim() || result.content?.trim() || undefined,
		});
	}

	const limitedSources = sources.slice(0, numResults);

	return {
		provider: "jina",
		sources: limitedSources,
	};
}

/** Search provider for Jina Reader. */
export class JinaProvider extends SearchProvider {
	readonly id = "jina";
	readonly label = "Jina";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("jina");
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
		let query = params.query;
		let site: string | undefined;
		if (parsed.hasDirectives) {
			// Jina's X-Site header takes a single domain; with exactly one
			// include site, send its host there and strip site: tokens from
			// the query. Multiple sites stay inline (Bing-backed, parses them).
			if (parsed.sites.length === 1) site = parsed.sites[0]!.split("/")[0];
			query = formatQuery(parsed, {
				phrases: true,
				negation: true,
				site: !site,
				inTitle: true,
				inUrl: true,
				filetype: true,
			});
		}

		return searchJina({
			query,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			num_results: params.numSearchResults ?? params.limit,
			site,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			fetch: params.fetch,
		});
	}
}
