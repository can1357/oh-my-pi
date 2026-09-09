/**
 * Tavily Web Search Provider
 *
 * Uses Tavily's agent-focused search API to return structured results with an
 * optional synthesized answer.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
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
	/** `site:` hosts mapped to Tavily's `include_domains`. */
	include_domains?: string[];
	/** `-site:` hosts mapped to Tavily's `exclude_domains`. */
	exclude_domains?: string[];
	/** `after:` inclusive lower bound, ISO `YYYY-MM-DD`, mapped to `start_date`. */
	start_date?: string;
	/** `before:` upper bound, ISO `YYYY-MM-DD`, mapped to `end_date`. */
	end_date?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface TavilySearchResponse {
	answer?: unknown;
	results?: unknown;
	request_id?: unknown;
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
	if (params.include_domains?.length) {
		body.include_domains = params.include_domains;
	}
	if (params.exclude_domains?.length) {
		body.exclude_domains = params.exclude_domains;
	}
	if (params.start_date) {
		body.start_date = params.start_date;
	}
	if (params.end_date) {
		body.end_date = params.end_date;
	}
	// Explicit before:/after: bounds take precedence over the relative recency
	// window; sending both would over-restrict.
	if (params.recency && !params.start_date && !params.end_date) {
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
		signal: withHardTimeout(params.signal, params.timeoutMs),
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

	const payload: unknown = await response.json();
	return asRecord(payload) ?? {};
}

function toSearchResponse(response: TavilySearchResponse, numResults: number): SearchResponse {
	const sources: SearchSource[] = [];

	if (Array.isArray(response.results)) {
		for (const value of response.results) {
			const result = asRecord(value);
			if (!result || typeof result.url !== "string" || !result.url) continue;
			const title = typeof result.title === "string" && result.title ? result.title : result.url;
			const snippet = typeof result.content === "string" ? result.content : undefined;
			const publishedDate = typeof result.published_date === "string" ? result.published_date : undefined;
			sources.push({
				title,
				url: result.url,
				snippet,
				publishedDate,
				ageSeconds: dateToAgeSeconds(publishedDate),
			});
		}
	}

	const answer = typeof response.answer === "string" ? response.answer.trim() || undefined : undefined;
	return {
		provider: "tavily",
		answer,
		sources: sources.slice(0, numResults),
		requestId: typeof response.request_id === "string" ? response.request_id : undefined,
		authMode: "api_key",
	};
}

function hasRenderableResponse(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	return response.sources.length > 0;
}

/** Bare hosts from `site:` values (path parts are enforced by the central lenient filter). */
function siteHosts(sites: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const site of sites) {
		const host = site.split("/", 1)[0];
		if (host) hosts.add(host);
	}
	return [...hosts];
}

/** Execute Tavily web search. */
export async function searchTavily(params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const tavilyParams: TavilySearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
	if (parsed.hasDirectives) {
		// Tavily prefers clean natural text; re-emit only phrases and -exclusions.
		tavilyParams.query = formatQuery(parsed, { phrases: true, negation: true });
		const include = siteHosts(parsed.sites);
		const exclude = siteHosts(parsed.excludedSites);
		if (include.length > 0) tavilyParams.include_domains = include;
		if (exclude.length > 0) tavilyParams.exclude_domains = exclude;
		if (parsed.after) tavilyParams.start_date = parsed.after;
		if (parsed.before) tavilyParams.end_date = parsed.before;
	}
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
	const hasTimeFilter = Boolean(tavilyParams.recency || tavilyParams.start_date || tavilyParams.end_date);
	if (!hasTimeFilter || hasRenderableResponse(response)) {
		return response;
	}

	// Time filters commonly zero out results; retry once without them.
	return toSearchResponse(
		await callWithAuth({ ...tavilyParams, recency: undefined, start_date: undefined, end_date: undefined }),
		numResults,
	);
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
