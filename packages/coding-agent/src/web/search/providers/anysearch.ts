/**
 * AnySearch Web Search Provider
 *
 * Calls AnySearch's search API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 */
import {
	type AuthStorage,
	type FetchImpl,
	getEnvApiKey,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	withAuth,
} from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const ANYSEARCH_SEARCH_URL = "https://api.anysearch.com/v1/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 10;

export interface AnySearchSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface AnySearchResult {
	title?: string | null;
	url?: string | null;
	snippet?: string | null;
	content?: string | null;
}

interface AnySearchSearchResponse {
	code?: number | null;
	message?: string | null;
	data?: {
		results?: AnySearchResult[] | null;
		metadata?: {
			search_time_ms?: number | null;
		} | null;
	} | null;
}

/** Resolve AnySearch API key through the shared auth storage pipeline. */
export function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return authStorage.getApiKey("anysearch", sessionId, { signal });
}

function buildRequestBody(params: AnySearchSearchParams): Record<string, unknown> {
	return {
		query: params.query,
		max_results: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	};
}

async function callAnySearch(
	apiKey: string | undefined,
	params: AnySearchSearchParams,
): Promise<AnySearchSearchResponse> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const response = await (params.fetch ?? fetch)(ANYSEARCH_SEARCH_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(buildRequestBody(params)),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("anysearch", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"anysearch",
			`AnySearch API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const data = (await response.json()) as AnySearchSearchResponse;
	if (typeof data.code === "number" && data.code !== 0) {
		throw new SearchProviderError("anysearch", data.message?.trim() || "AnySearch request failed");
	}
	return data;
}

/** Execute AnySearch web search. */
export async function searchAnysearch(params: SearchParams): Promise<SearchResponse> {
	const anysearchParams: AnySearchSearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
	const keyResolver = params.authStorage.resolver("anysearch", {
		sessionId: params.sessionId,
	});
	const numResults = clampNumResults(anysearchParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const resolvedKey = await resolveApiKeyOnce(keyResolver, params.signal);
	let data: AnySearchSearchResponse;
	if (resolvedKey) {
		// Reuse the preflight credential for the initial authenticated attempt.
		const seededResolver = seedApiKeyResolver(resolvedKey, keyResolver);
		data = await withAuth(seededResolver, key => callAnySearch(key, anysearchParams), {
			signal: params.signal,
		});
	} else {
		// Anonymous mode — omit Authorization header. Never fall back here after a 401.
		data = await callAnySearch(undefined, anysearchParams);
	}

	const sources: SearchSource[] = [];

	for (const result of data.data?.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.snippet ?? result.content ?? undefined,
		});
	}

	return {
		provider: "anysearch",
		sources: sources.slice(0, numResults),
		authMode: resolvedKey ? "api_key" : "anonymous",
	};
}

/** Search provider for AnySearch web search. */
export class AnySearchProvider extends SearchProvider {
	readonly id = "anysearch";
	readonly label = "AnySearch";

	/**
	 * Auto-chain admission requires a credential so unconfigured users' queries
	 * are not routed to a new third party by default. Anonymous mode stays
	 * explicit-only.
	 */
	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("anysearch") || !!getEnvApiKey("anysearch");
	}

	/**
	 * Explicit selection (`webSearch: anysearch`) works without a key via the
	 * anonymous tier.
	 */
	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnysearch(params);
	}
}
