/**
 * Keenable Web Search Provider
 *
 * Calls Keenable's search API and maps results into the unified SearchResponse
 * shape. With a `KEENABLE_API_KEY` (or stored `keenable` credential) it uses
 * the keyed endpoint; without one, an explicit selection falls back to the
 * keyless public endpoint, which is rate limited per IP and needs no account.
 * Endpoints: POST https://api.keenable.ai/v1/search (X-API-Key) and
 * POST https://api.keenable.ai/v1/search/public (X-Keenable-Title).
 * Docs: https://docs.keenable.ai/api-reference/search
 */
import { type AuthStorage, type FetchImpl, getEnvApiKey } from "@oh-my-pi/pi-ai";
import type { StructuredQuery } from "../query";
import { formatQuery, parseSearchQuery } from "../query";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, normalizeSearchText, readLimitedText, siteHosts, withHardTimeout } from "./utils";

const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
/** App identifier the keyless endpoint requires; requests without it are rejected with 400. */
const KEENABLE_APP_TITLE = "oh-my-pi";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

/** Keenable accepts relative deltas (`7d`, `1mo`, `1y`) on its date filters. */
const RECENCY_DELTAS: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "1d",
	week: "7d",
	month: "1mo",
	year: "1y",
};

type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

export interface KeenableSearchBody {
	query: string;
	max_results: number;
	site?: string;
	published_after?: string;
	published_before?: string;
}

interface KeenableSearchResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	description?: unknown;
	published_at?: unknown;
}

interface KeenableSearchResponse {
	results?: unknown;
}

/** Resolve a Keenable API key from AuthStorage, then the environment. */
async function resolveKeenableKey(params: SearchParamsWithFetch): Promise<string | undefined> {
	const stored = await params.authStorage.keys.get("keenable", params.sessionId, { signal: params.signal });
	return stored?.trim() || getEnvApiKey("keenable")?.trim() || undefined;
}

/**
 * Build the request body. Keenable takes plain keywords and quoted phrases;
 * a single `site:` host maps to the native `site` filter, and date bounds map
 * to `published_after` / `published_before`. Everything else is left to the
 * pipeline's lenient post-filter.
 */
export function buildKeenableBody(
	parsed: StructuredQuery,
	recency: SearchParams["recency"],
	maxResults: number,
): KeenableSearchBody {
	const query = parsed.hasDirectives
		? formatQuery({ ...parsed, sites: [], excludedSites: [], after: undefined, before: undefined }, { phrases: true })
		: parsed.raw.trim();
	const body: KeenableSearchBody = { query: query || parsed.raw.trim(), max_results: maxResults };
	const sites = siteHosts(parsed.sites);
	if (sites.length === 1) body.site = sites[0];
	const after = parsed.after ?? (recency ? RECENCY_DELTAS[recency] : undefined);
	if (after) body.published_after = after;
	if (parsed.before) body.published_before = parsed.before;
	return body;
}

function normalizeUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

async function callKeenableSearch(
	apiKey: string | undefined,
	body: KeenableSearchBody,
	params: SearchParamsWithFetch,
): Promise<KeenableSearchResponse> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	if (apiKey) headers["X-API-Key"] = apiKey;
	else headers["X-Keenable-Title"] = KEENABLE_APP_TITLE;

	const response = await (params.fetch ?? fetch)(apiKey ? KEENABLE_SEARCH_URL : KEENABLE_PUBLIC_SEARCH_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "keenable", MAX_ERROR_BYTES, true);
		const classified = classifyProviderHttpError("keenable", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"keenable",
			`Keenable search API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const raw = await readLimitedText(response, "keenable", MAX_RESPONSE_BYTES);
	try {
		return JSON.parse(raw) as KeenableSearchResponse;
	} catch {
		throw new SearchProviderError("keenable", "Keenable search API returned invalid JSON", 500);
	}
}

/** Execute Keenable web search. */
export async function searchKeenable(params: SearchParamsWithFetch): Promise<SearchResponse> {
	const maxResults = Math.floor(
		clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const body = buildKeenableBody(parsed, params.recency, maxResults);
	const apiKey = await resolveKeenableKey(params);
	const data = await callKeenableSearch(apiKey, body, params);

	if (!Array.isArray(data.results)) {
		throw new SearchProviderError("keenable", "Keenable search API returned an unexpected response shape", 500);
	}

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const entry of data.results as unknown[]) {
		if (typeof entry !== "object" || entry === null) continue;
		const result = entry as KeenableSearchResult;
		const url = normalizeUrl(result.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const publishedDate =
			typeof result.published_at === "string" && result.published_at ? result.published_at : undefined;
		sources.push({
			title: normalizeSearchText(result.title) ?? url,
			url,
			// `description` is deprecated and always empty; `snippet` carries the page excerpt.
			snippet: normalizeSearchText(result.snippet) ?? normalizeSearchText(result.description),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	return {
		provider: "keenable",
		sources: sources.slice(0, maxResults),
		authMode: apiKey ? "api_key" : "anonymous",
	};
}

/** Search provider for Keenable web search. */
export class KeenableProvider extends SearchProvider {
	readonly id = "keenable";
	readonly label = "Keenable";

	/** The auto chain admits Keenable only when a key is configured. */
	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("keenable") !== undefined || !!getEnvApiKey("keenable");
	}

	/** An explicit `web/keenable` selection works without a key via the public endpoint. */
	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		return searchKeenable(params);
	}
}
