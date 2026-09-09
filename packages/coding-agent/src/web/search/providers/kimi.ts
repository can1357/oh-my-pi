/**
 * Kimi Web Search Provider
 *
 * Uses the Kimi Code search API to retrieve web results. This is the Kimi Code
 * membership service, distinct from the Moonshot Open Platform — it requires a
 * Kimi Code Console credential (`omp /login kimi-code` or an explicit
 * `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY`), not `MOONSHOT_API_KEY`.
 * Endpoint: POST https://api.kimi.com/coding/v1/search
 */
import { type ApiKey, type AuthStorage, type FetchImpl, withAuth } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";

import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax, type StructuredQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

const KIMI_SEARCH_URL = "https://api.kimi.com/coding/v1/search";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const DEFAULT_TIMEOUT_SECONDS = 30;

/** Kimi Code search is Bing-flavored: re-emit the operators Bing parses; dates/lang stay with the central filter. */
const KIMI_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	site: true,
	inTitle: true,
	inUrl: true,
	filetype: true,
};

export interface KimiSearchParams {
	query: string;
	parsedQuery?: StructuredQuery;
	num_results?: number;
	include_content?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
	authStorage: AuthStorage;
	sessionId?: string;
	fetch?: FetchImpl;
}

interface KimiSearchResult {
	site_name?: string;
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
	date?: string;
	icon?: string;
	mime?: string;
}

interface KimiSearchResponse {
	search_results?: KimiSearchResult[];
}

function asTrimmed(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveBaseUrl(): string {
	return asTrimmed($env.MOONSHOT_SEARCH_BASE_URL) ?? asTrimmed($env.KIMI_SEARCH_BASE_URL) ?? KIMI_SEARCH_URL;
}

/**
 * Resolve the Kimi Code search credential. Highest precedence is the explicit
 * search-key env override; otherwise an AuthStorage-backed resolver for a
 * stored `kimi-code` credential (from `omp /login kimi-code`), so a stale token
 * triggers the central force-refresh / sibling-rotate retry. Returns
 * `undefined` when neither is configured.
 *
 * The endpoint (`https://api.kimi.com/coding/v1/search`) is the Kimi Code
 * membership service, which has a different credential system from the Moonshot
 * Open Platform (`https://api.moonshot.ai`). A stored `moonshot` credential
 * (or `MOONSHOT_API_KEY`) is NOT accepted here — it 401s against Kimi Code
 * (issue #5762).
 */
async function resolveKey(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<ApiKey | undefined> {
	const envKey = asTrimmed($env.MOONSHOT_SEARCH_API_KEY) ?? asTrimmed($env.KIMI_SEARCH_API_KEY);
	if (envKey) return envKey;

	const stored = await authStorage.getApiKey("kimi-code", sessionId, { signal });
	if (stored) return authStorage.resolver("kimi-code", { sessionId });
	return undefined;
}

async function callKimiSearch(
	apiKey: string,
	params: {
		query: string;
		limit: number;
		includeContent: boolean;
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch?: FetchImpl;
	},
): Promise<{ response: KimiSearchResponse; requestId?: string }> {
	const fetchImpl = params.fetch ?? fetch;
	const response = await fetchImpl(resolveBaseUrl(), {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			text_query: params.query,
			limit: params.limit,
			enable_page_crawling: params.includeContent,
			timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
		}),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("kimi", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"kimi",
			`Kimi search API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const data = (await response.json()) as KimiSearchResponse;
	const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-msh-request-id") ?? undefined;
	return { response: data, requestId };
}

/** Execute Kimi web search. */
export async function searchKimi(params: KimiSearchParams): Promise<SearchResponse> {
	const keyOrResolver = await resolveKey(params.authStorage, params.sessionId, params.signal);
	if (!keyOrResolver) {
		throw new Error(
			"Kimi search credentials not found. Kimi web search uses the Kimi Code service (api.kimi.com); set MOONSHOT_SEARCH_API_KEY / KIMI_SEARCH_API_KEY to a Kimi Code Console key, or login with 'omp /login kimi-code'. A Moonshot Open Platform key (MOONSHOT_API_KEY) is not accepted here.",
		);
	}

	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, KIMI_QUERY_SYNTAX) : params.query;
	const limit = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const { response, requestId } = await withAuth(
		keyOrResolver,
		key =>
			callKimiSearch(key, {
				query,
				limit,
				includeContent: params.include_content ?? false,
				signal: params.signal,
				timeoutMs: params.timeoutMs,
				fetch: params.fetch,
			}),
		{ signal: params.signal },
	);
	const sources: SearchSource[] = [];

	for (const result of response.search_results ?? []) {
		if (!result.url) continue;
		const publishedDate = asTrimmed(result.date);
		const snippet = asTrimmed(result.snippet) ?? asTrimmed(result.content);
		sources.push({
			title: asTrimmed(result.title) ?? result.url,
			url: result.url,
			snippet,
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
			author: asTrimmed(result.site_name),
		});
	}

	return {
		provider: "kimi",
		sources: sources.slice(0, limit),
		requestId,
	};
}

/** Search provider for Kimi web search. */
export class KimiProvider extends SearchProvider {
	readonly id = "kimi";
	readonly label = "Kimi";

	isAvailable(authStorage: AuthStorage): boolean {
		return (
			!!asTrimmed($env.MOONSHOT_SEARCH_API_KEY) ||
			!!asTrimmed($env.KIMI_SEARCH_API_KEY) ||
			authStorage.hasAuth("kimi-code")
		);
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		const fetchImpl = params.fetch;

		return searchKimi({
			query: params.query,
			parsedQuery: params.parsedQuery,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: fetchImpl,
		});
	}
}
