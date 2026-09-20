/**
 * Serply Web Search Provider
 *
 * Calls Serply's Google SERP API and maps the organic results into the unified
 * SearchResponse shape used by the web search tool.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { asRecord, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import type { StructuredQuery } from "../query";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, normalizeSearchText, readLimitedText, withHardTimeout } from "./utils";

const SERPLY_SEARCH_URL = "https://api.serply.io/v1/search/";
const DEFAULT_NUM_RESULTS = 10;
/** Serply serves one Google result page per call, so `num` saturates at 10. */
const MAX_NUM_RESULTS = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

const RECENCY_MAP: Record<"day" | "week" | "month" | "year", "d" | "w" | "m" | "y"> = {
	day: "d",
	week: "w",
	month: "m",
	year: "y",
};

export interface SerplySearchParams {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	parsedQuery?: StructuredQuery;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface SerplySearchResponse {
	results?: unknown;
}

/** Serply reports failures as a `detail` string, occasionally as a nested object. */
function getErrorMessage(value: unknown): string | null {
	if (typeof value === "string") return value.trim() || null;

	const record = asRecord(value);
	if (!record) return null;

	for (const key of ["detail", "error", "message"]) {
		const message = getErrorMessage(record[key]);
		if (message) return message;
	}

	return null;
}

function normalizeUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 2048) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Exported for testing. Builds the Serply request URL from unified params. */
export function buildRequestUrl(params: SerplySearchParams): URL {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	// Serply proxies Google itself, so the classic operator set (quoted
	// phrases, OR groups, -exclusions, site:, inurl:, intitle:, intext:,
	// filetype:, and after:/before: bounds) is re-emitted into `q` rather than
	// translated onto side-channel request parameters.
	const url = new URL(SERPLY_SEARCH_URL);
	url.searchParams.set("q", parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query);
	url.searchParams.set("num", String(clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS)));
	// `tbs` is a pure time filter. Explicit after:/before: bounds already ride
	// along in `q`; stacking the relative window on top would intersect two
	// date filters and over-restrict the page.
	if (params.recency && !parsed.after && !parsed.before) {
		url.searchParams.set("tbs", `qdr:${RECENCY_MAP[params.recency]}`);
	}
	return url;
}

async function callSerplySearch(apiKey: string, params: SerplySearchParams): Promise<SerplySearchResponse> {
	const fetchImpl = params.fetch ?? fetch;
	const response = await fetchImpl(buildRequestUrl(params), {
		headers: {
			Accept: "application/json",
			"X-Api-Key": apiKey,
			"User-Agent": USER_AGENT,
		},
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "serply", MAX_ERROR_BYTES, true);
		const classified = classifyProviderHttpError("serply", response.status, errorText);
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
		throw new SearchProviderError("serply", `Serply API error (${response.status}): ${message}`, response.status);
	}

	const raw = await readLimitedText(response, "serply", MAX_RESPONSE_BYTES, false);
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new SearchProviderError("serply", "Serply API returned invalid JSON", 500);
	}
	return asRecord(payload) ?? {};
}

function toSearchResponse(response: SerplySearchResponse, numResults: number): SearchResponse {
	const sources: SearchSource[] = [];

	if (Array.isArray(response.results)) {
		for (const value of response.results) {
			const result = asRecord(value);
			if (!result) continue;
			const url = normalizeUrl(result.link);
			if (!url) continue;
			// Serply attaches the SERP-reported publish date under `metadata`,
			// as a human-readable string such as "Sep 17, 2023".
			const publishedDate = normalizeSearchText(asRecord(result.metadata)?.published_time);
			sources.push({
				title: normalizeSearchText(result.title) ?? url,
				url,
				snippet: normalizeSearchText(result.description),
				publishedDate,
				ageSeconds: dateToAgeSeconds(publishedDate),
			});
		}
	}

	// `num` is an upper hint Google rounds to a page, so trim client-side.
	return { provider: "serply", sources: sources.slice(0, numResults), authMode: "api_key" };
}

/** Execute Serply web search. */
export async function searchSerply(params: SearchParams): Promise<SearchResponse> {
	const serplyParams: SerplySearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		parsedQuery: params.parsedQuery,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
	const keyOrResolver: ApiKey = params.authStorage.resolver("serply", { sessionId: params.sessionId });
	const response = await withAuth(keyOrResolver, key => callSerplySearch(key, serplyParams), {
		signal: params.signal,
		missingKeyMessage:
			'Serply credentials not found. Set SERPLY_API_KEY or configure an API key for provider "serply".',
	});
	return toSearchResponse(response, clampNumResults(serplyParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS));
}

/** Search provider for Serply web search. */
export class SerplyProvider extends SearchProvider {
	readonly id = "serply";
	readonly label = "Serply";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("serply") || !!getEnvApiKey("serply");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSerply(params);
	}
}
