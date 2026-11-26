/**
 * SpecStream Web Search Provider
 *
 * POST https://api.specstream.ai/v1/web-search with bearer auth
 * (`SPECSTREAM_API_KEY` or a stored `specstream` credential).
 * Docs: https://specstream.ai/docs
 */
import { type AuthStorage, withAuth } from "@oh-my-pi/pi-ai";
import type { StructuredQuery } from "../query";
import { parseSearchQuery } from "../query";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import {
	classifyProviderHttpError,
	keywordQuery,
	normalizeHttpUrl,
	normalizeSearchText,
	readLimitedText,
	withHardTimeout,
} from "./utils";

const SPECSTREAM_SEARCH_URL = "https://api.specstream.ai/v1/web-search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

interface SpecStreamSearchBody {
	q: string;
	num: number;
	passages: boolean;
}

interface SpecStreamSourceItem {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	excerpt?: unknown;
	published?: unknown;
}

interface SpecStreamSearchResponse {
	sources?: unknown;
}

/**
 * SpecStream accepts plain keywords, quoted phrases, `-` exclusions, and
 * `site:` / `-site:` operators directly in `q`. SpecStream's `news: true` flag
 * switches to a news-only vertical rather than filtering web results by date,
 * so `recency` and `after:`/`before:` are left to the central post-filter.
 */
function buildSpecStreamBody(parsed: StructuredQuery, maxResults: number): SpecStreamSearchBody {
	return {
		q: keywordQuery("specstream", parsed, { phrases: true, negation: true, site: true }),
		num: maxResults,
		passages: true,
	};
}

async function callSpecStreamSearch(
	apiKey: string,
	body: SpecStreamSearchBody,
	params: SearchParams,
): Promise<SpecStreamSearchResponse> {
	const response = await (params.fetch ?? fetch)(SPECSTREAM_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "specstream", MAX_ERROR_BYTES, true);
		throw (
			classifyProviderHttpError("specstream", response.status, errorText) ??
			new SearchProviderError(
				"specstream",
				`SpecStream search API error (${response.status}): ${errorText}`,
				response.status,
			)
		);
	}

	const raw = await readLimitedText(response, "specstream", MAX_RESPONSE_BYTES);
	try {
		return JSON.parse(raw) as SpecStreamSearchResponse;
	} catch {
		throw new SearchProviderError("specstream", "SpecStream search API returned invalid JSON", 500);
	}
}

/** Execute SpecStream web search. */
export async function searchSpecStream(params: SearchParams): Promise<SearchResponse> {
	const maxResults = Math.floor(
		clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	);
	const body = buildSpecStreamBody(params.parsedQuery ?? parseSearchQuery(params.query), maxResults);
	const data = await withAuth(
		params.authStorage.keys.resolver("specstream", { sessionId: params.sessionId }),
		key => callSpecStreamSearch(key, body, params),
		{
			signal: params.signal,
			missingKeyMessage:
				'SpecStream credentials not found. Set SPECSTREAM_API_KEY or configure an API key for provider "specstream".',
		},
	);

	if (typeof data !== "object" || data === null || !Array.isArray(data.sources)) {
		throw new SearchProviderError("specstream", "SpecStream search API returned an unexpected response shape", 500);
	}

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const entry of data.sources as unknown[]) {
		if (typeof entry !== "object" || entry === null) continue;
		const item = entry as SpecStreamSourceItem;
		const url = normalizeHttpUrl(item.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const publishedDate = typeof item.published === "string" && item.published ? item.published : undefined;
		sources.push({
			title: normalizeSearchText(item.title) ?? url,
			url,
			snippet: normalizeSearchText(item.excerpt) ?? normalizeSearchText(item.snippet),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
		if (sources.length === maxResults) break;
	}

	return {
		provider: "specstream",
		sources,
		authMode: "api_key",
	};
}

/** Search provider for SpecStream web search. */
export class SpecStreamProvider extends SearchProvider {
	readonly id = "specstream";
	readonly label = "SpecStream";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("specstream") !== undefined;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSpecStream(params);
	}
}
