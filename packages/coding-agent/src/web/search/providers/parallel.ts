import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@pk-nerdsaver-ai/pi-ai";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import {
	PARALLEL_BETA_HEADER,
	PARALLEL_SEARCH_URL,
	ParallelApiError,
	type ParallelSearchResult,
	parseParallelErrorResponse,
	parseParallelSearchPayload,
} from "../../parallel";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, toSearchSources, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

async function searchWithAuthStorage(
	objective: string,
	queries: string[],
	params: {
		signal?: AbortSignal;
		fetch?: FetchImpl;
	},
	authStorage: AuthStorage,
	sessionId?: string,
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
				}),
				signal: withHardTimeout(params.signal),
			});

			if (!response.ok) {
				throw parseParallelErrorResponse(response.status, await response.text());
			}

			const payload: unknown = await response.json();
			return parseParallelSearchPayload(payload, { parseMetadata: false });
		},
		{ signal: params.signal },
	);
}

export async function searchParallel(
	params: {
		query: string;
		num_results?: number;
		signal?: AbortSignal;
		fetch?: FetchImpl;
	},
	authStorage: AuthStorage,
	sessionId?: string,
): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	try {
		const result = await searchWithAuthStorage(
			params.query,
			[params.query],
			{
				signal: params.signal,
				fetch: params.fetch,
			},
			authStorage,
			sessionId,
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
				signal: params.signal,
				fetch: params.fetch,
			},
			params.authStorage,
			params.sessionId,
		);
	}
}
