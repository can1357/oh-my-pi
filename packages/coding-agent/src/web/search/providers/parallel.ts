import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import {
	PARALLEL_BETA_HEADER,
	PARALLEL_SEARCH_URL,
	ParallelApiError,
	type ParallelSearchResult,
	parseParallelErrorResponse,
	parseParallelJsonResponse,
	parseParallelSearchPayload,
} from "../../parallel";
import { formatQuery, parseSearchQuery, type StructuredQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, toSearchSources, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

/** Query-string caps for Parallel: natural-language objective, no field operators. */
const PARALLEL_QUERY_SYNTAX = { phrases: true, negation: true, or: true } as const;

/** Parallel `source_policy` (beta Search API): bare-host allow/deny lists + freshness floor. */
interface ParallelSourcePolicy {
	include_domains?: string[];
	exclude_domains?: string[];
	after_date?: string;
}

const RECENCY_DAYS: Record<NonNullable<SearchParams["recency"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

/** Site values may carry paths (`github.com/anthropics`); Parallel takes bare hosts. */
function toHosts(sites: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const site of sites) {
		const host = site.split("/", 1)[0];
		if (host) hosts.add(host);
	}
	return [...hosts];
}

/**
 * Map parsed `site:`/`-site:`/`after:` directives and the relative recency
 * option onto Parallel's `source_policy`. An explicit `after:` bound wins.
 * Per Parallel docs, `exclude_domains` is ignored when `include_domains` is
 * set, so exclusions are only sent without an allow list (the central lenient
 * filter enforces them regardless).
 */
function toSourcePolicy(parsed: StructuredQuery, recency?: SearchParams["recency"]): ParallelSourcePolicy | undefined {
	const policy: ParallelSourcePolicy = {};
	const include = toHosts(parsed.sites);
	const exclude = toHosts(parsed.excludedSites);
	if (include.length) policy.include_domains = include;
	else if (exclude.length) policy.exclude_domains = exclude;
	if (parsed.after) policy.after_date = parsed.after;
	else if (recency) {
		policy.after_date = new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);
	}
	return policy.include_domains || policy.exclude_domains || policy.after_date ? policy : undefined;
}

async function searchWithAuthStorage(
	objective: string,
	queries: string[],
	params: {
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch?: FetchImpl;
	},
	authStorage: AuthStorage,
	sessionId?: string,
	sourcePolicy?: ParallelSourcePolicy,
): Promise<ParallelSearchResult> {
	const apiKey = await authStorage.getApiKey("parallel", sessionId, { signal: params.signal });
	if (!apiKey) {
		throw new ParallelApiError(
			"Parallel credentials not found. Set PARALLEL_API_KEY or login with 'omp /login parallel'.",
		);
	}

	// Drive the (already-present) credential through the central force-refresh /
	// sibling-rotate retry policy. The `ParallelApiError` thrown below carries a
	// `statusCode`, which `withAuth`'s default classifier reads to detect a
	// retryable 401 / usage-limit.
	const keyOrResolver: ApiKey = authStorage.resolver("parallel", { sessionId });
	return withAuth(
		keyOrResolver,
		async key => {
			const response = await (params.fetch ?? fetch)(PARALLEL_SEARCH_URL, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"x-api-key": key,
					"parallel-beta": PARALLEL_BETA_HEADER,
				},
				body: JSON.stringify({
					objective,
					search_queries: queries,
					mode: "fast",
					excerpts: {
						max_chars_per_result: 10_000,
					},
					...(sourcePolicy && { source_policy: sourcePolicy }),
				}),
				signal: withHardTimeout(params.signal, params.timeoutMs),
			});

			if (!response.ok) {
				throw parseParallelErrorResponse(response.status, await response.text());
			}

			const payload = await parseParallelJsonResponse(response, "search");
			return parseParallelSearchPayload(payload, { parseMetadata: false });
		},
		{ signal: params.signal },
	);
}

export async function searchParallel(
	params: {
		query: string;
		num_results?: number;
		recency?: SearchParams["recency"];
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch?: FetchImpl;
		parsedQuery?: StructuredQuery;
	},
	authStorage: AuthStorage,
	sessionId?: string,
): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	// Directives are removed only where Parallel has a native equivalent.
	const query = parsed.hasDirectives ? formatQuery(parsed, PARALLEL_QUERY_SYNTAX) : params.query;
	const sourcePolicy = toSourcePolicy(parsed, params.recency);

	try {
		const result = await searchWithAuthStorage(
			query,
			[query],
			{
				signal: params.signal,
				timeoutMs: params.timeoutMs,
				fetch: params.fetch,
			},
			authStorage,
			sessionId,
			sourcePolicy,
		);

		return {
			provider: "parallel",
			sources: toSearchSources(result.sources, numResults),
			requestId: result.requestId,
		};
	} catch (err) {
		if (err instanceof ParallelApiError) {
			if (typeof err.statusCode === "number") {
				const classified = classifyProviderHttpError("parallel", err.statusCode, err.message);
				if (classified) throw classified;
			}
			throw new SearchProviderError("parallel", err.message, err.statusCode);
		}
		throw err;
	}
}

export class ParallelProvider extends SearchProvider {
	readonly id = "parallel";
	readonly label = "Parallel";

	isAvailable(authStorage: AuthStorage) {
		return !!getEnvApiKey("parallel") || authStorage.hasAuth("parallel");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchParallel(
			{
				query: params.query,
				num_results: params.numSearchResults ?? params.limit,
				recency: params.recency,
				signal: params.signal,
				timeoutMs: params.timeoutMs,
				fetch: params.fetch,
				parsedQuery: params.parsedQuery,
			},
			params.authStorage,
			params.sessionId,
		);
	}
}
