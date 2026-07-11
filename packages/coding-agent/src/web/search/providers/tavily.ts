/**
 * Tavily Web Search Provider
 *
 * Uses Tavily's agent-focused search API to return structured results with an
 * optional synthesized answer.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@pk-nerdsaver-ai/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;

export interface TavilySearchParams {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

interface TavilySearchResult {
	title?: string | null;
	url?: string | null;
	content?: string | null;
	published_date?: string | null;
}

interface TavilySearchResponse {
	answer?: string | null;
	results?: TavilySearchResult[];
	request_id?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	return value as Record<string, unknown>;
}

function getErrorMessage(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	const record = asRecord(value);
	if (!record) return null;

	for (const key of ["detail", "error", "message"]) {
		const message = getErrorMessage(record[key]);
		if (message) return message;
	}

	return null;
}

/** Find Tavily API key through AuthStorage's unified refresh pipeline. */
export async function findApiKey(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	return (await authStorage.getApiKey("tavily", sessionId, { signal })) ?? null;
}

/** Exported for testing. Builds the Tavily request body from unified params. */
export function buildRequestBody(params: TavilySearchParams): Record<string, unknown> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	// Tavily's `topic` (general/news/finance) and `time_range` are orthogonal
	// dimensions in the upstream API. Recency is a temporal filter only; it must
	// not narrow the index to news-only, which would break technical queries
	// (release notes, docs, GitHub) whenever a user sets --recency. Always use
	// the default "general" topic and only send `time_range` when recency is set.
	const body: Record<string, unknown> = {
		query: params.query,
		search_depth: "basic",
		max_results: numResults,
		include_answer: "advanced",
		include_raw_content: false,
	};
	if (params.recency) {
		body.time_range = params.recency;
	}
	return body;
}

async function callTavilySearch(apiKey: string, params: TavilySearchParams): Promise<TavilySearchResponse> {
	const response = await (params.fetch ?? fetch)(TAVILY_SEARCH_URL, {
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
		const classified = classifyProviderHttpError("tavily", response.status, errorText);
		if (classified) throw classified;
		let message = errorText.trim();
		if (message.length === 0) {
			message = response.statusText;
		} else {
			try {
				message = getErrorMessage(JSON.parse(errorText)) ?? message;
			} catch {
				// Keep raw text fallback.
			}
		}
		throw new SearchProviderError("tavily", `Tavily API error (${response.status}): ${message}`, response.status);
	}

	return (await response.json()) as TavilySearchResponse;
}

function toSearchResponse(response: TavilySearchResponse, numResults: number): SearchResponse {
	const sources: SearchSource[] = [];

	for (const result of response.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.content ?? undefined,
			publishedDate: result.published_date ?? undefined,
			ageSeconds: dateToAgeSeconds(result.published_date ?? undefined),
		});
	}

	return {
		provider: "tavily",
		answer: response.answer?.trim() || undefined,
		sources: sources.slice(0, numResults),
		requestId: response.request_id ?? undefined,
		authMode: "api_key",
	};
}

function hasRenderableResponse(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	return response.sources.length > 0;
}

/** Execute Tavily web search. */
export async function searchTavily(params: SearchParams): Promise<SearchResponse> {
	const tavilyParams: TavilySearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal: params.signal,
		fetch: params.fetch,
	};
	const keyOrResolver: ApiKey = params.authStorage.resolver("tavily", {
		sessionId: params.sessionId,
	});

	const numResults = clampNumResults(tavilyParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const authOptions = {
		signal: params.signal,
		missingKeyMessage:
			'Tavily credentials not found. Set TAVILY_API_KEY or configure an API key for provider "tavily".',
	};
	const callWithAuth = (searchParams: TavilySearchParams) =>
		withAuth(keyOrResolver, key => callTavilySearch(key, searchParams), authOptions);

	const response = toSearchResponse(await callWithAuth(tavilyParams), numResults);
	if (!tavilyParams.recency || hasRenderableResponse(response)) {
		return response;
	}

	return toSearchResponse(await callWithAuth({ ...tavilyParams, recency: undefined }), numResults);
}

/** Search provider for Tavily web search. */
export class TavilyProvider extends SearchProvider {
	readonly id = "tavily";
	readonly label = "Tavily";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("tavily") || !!getEnvApiKey("tavily");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchTavily(params);
	}
}
