/**
 * Keenable Web Search Provider
 *
 * Calls Keenable's search REST API and maps results into the unified
 * SearchResponse shape used by the web search tool. A credential admits the
 * provider to the auto chain; explicit selection falls back to the keyless
 * `/public` endpoint, which is rate limited per IP and consumes no credits.
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
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
/** Required app identifier on the keyless endpoint. */
const KEENABLE_APP_TITLE = "oh-my-pi";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;

/** Relative `published_after` deltas in Keenable's `<number><unit>` syntax. */
const RECENCY_DELTA: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "1d",
	week: "7d",
	month: "1mo",
	year: "1y",
};

export interface KeenableSearchParams {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	/** Single `site:` host mapped to Keenable's `site` filter. */
	site?: string;
	/** `after:` inclusive lower publish bound, ISO `YYYY-MM-DD`. */
	published_after?: string;
	/** `before:` exclusive upper publish bound, ISO `YYYY-MM-DD`. */
	published_before?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface KeenableSearchResponse {
	results?: unknown;
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

/** Exported for testing. Builds the Keenable request body from unified params. */
export function buildRequestBody(params: KeenableSearchParams): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: params.query,
		max_results: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	};
	if (params.site) body.site = params.site;
	if (params.published_after) body.published_after = params.published_after;
	// The parsed `before:` bound is exclusive; a bare date on Keenable's
	// `_before` filter covers the whole day, so cut at midnight instead.
	if (params.published_before) body.published_before = `${params.published_before}T00:00:00Z`;
	// Explicit before:/after: bounds take precedence over the relative recency
	// window; sending both would over-restrict.
	if (params.recency && !params.published_after && !params.published_before) {
		body.published_after = RECENCY_DELTA[params.recency];
	}
	return body;
}

async function callKeenableSearch(
	apiKey: string | undefined,
	params: KeenableSearchParams,
): Promise<{ response: KeenableSearchResponse; requestId?: string }> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers["X-API-Key"] = apiKey;
	else headers["X-Keenable-Title"] = KEENABLE_APP_TITLE;

	const response = await (params.fetch ?? fetch)(apiKey ? KEENABLE_SEARCH_URL : KEENABLE_PUBLIC_SEARCH_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(buildRequestBody(params)),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("keenable", response.status, errorText);
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
		throw new SearchProviderError("keenable", `Keenable API error (${response.status}): ${message}`, response.status);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new SearchProviderError("keenable", "Keenable API returned invalid JSON", 500);
	}
	const requestId = response.headers.get("x-request-id") ?? undefined;
	return { response: asRecord(payload) ?? {}, requestId };
}

function toSearchResponse(
	response: KeenableSearchResponse,
	numResults: number,
	requestId: string | undefined,
	authMode: "api_key" | "keyless",
): SearchResponse {
	const sources: SearchSource[] = [];
	if (Array.isArray(response.results)) {
		for (const value of response.results) {
			const result = asRecord(value);
			if (!result || typeof result.url !== "string" || !result.url) continue;
			const title = typeof result.title === "string" && result.title ? result.title : result.url;
			const snippet =
				typeof result.snippet === "string" && result.snippet
					? result.snippet
					: typeof result.description === "string" && result.description
						? result.description
						: undefined;
			const publishedDate = typeof result.published_at === "string" ? result.published_at : undefined;
			sources.push({
				title,
				url: result.url,
				snippet,
				publishedDate,
				ageSeconds: dateToAgeSeconds(publishedDate),
			});
		}
	}
	return {
		provider: "keenable",
		sources: sources.slice(0, numResults),
		requestId,
		authMode,
	};
}

/** Execute Keenable web search. */
export async function searchKeenable(params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const keenableParams: KeenableSearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
	if (parsed.hasDirectives) {
		// Keenable ranks natural text; re-emit only phrases and -exclusions.
		keenableParams.query = formatQuery(parsed, { phrases: true, negation: true });
		// `site` accepts one host; several `site:` values are any-of, so leave
		// those (and every -site:) to the central lenient post-filter.
		if (parsed.sites.length === 1) {
			const host = parsed.sites[0].split("/", 1)[0];
			if (host) keenableParams.site = host;
		}
		if (parsed.after) keenableParams.published_after = parsed.after;
		if (parsed.before) keenableParams.published_before = parsed.before;
	}

	const numResults = clampNumResults(keenableParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const keyResolver = params.authStorage.resolver("keenable", { sessionId: params.sessionId });
	const resolvedKey = await resolveApiKeyOnce(keyResolver, params.signal);
	const authMode = resolvedKey ? "api_key" : "keyless";
	const call = (searchParams: KeenableSearchParams) =>
		resolvedKey
			? withAuth(seedApiKeyResolver(resolvedKey, keyResolver), key => callKeenableSearch(key, searchParams), {
					signal: params.signal,
				})
			: callKeenableSearch(undefined, searchParams);

	const first = await call(keenableParams);
	const response = toSearchResponse(first.response, numResults, first.requestId, authMode);
	const hasTimeFilter = Boolean(
		keenableParams.recency || keenableParams.published_after || keenableParams.published_before,
	);
	if (!hasTimeFilter || response.sources.length > 0) return response;

	// Publish-date filters drop pages without a known `published_at`; retry once without them.
	const retry = await call({
		...keenableParams,
		recency: undefined,
		published_after: undefined,
		published_before: undefined,
	});
	return toSearchResponse(retry.response, numResults, retry.requestId, authMode);
}

/** Search provider for Keenable web search. */
export class KeenableProvider extends SearchProvider {
	readonly id = "keenable";
	readonly label = "Keenable";

	/** Auto-chain admission requires a credential (`/login keenable` or KEENABLE_API_KEY). */
	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("keenable") || !!getEnvApiKey("keenable");
	}

	/** Explicit selection runs keyless against the public endpoint when no credential resolves. */
	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchKeenable(params);
	}
}
