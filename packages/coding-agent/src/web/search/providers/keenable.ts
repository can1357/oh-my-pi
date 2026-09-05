/**
 * Keenable Web Search Provider
 *
 * POST https://api.keenable.ai/v1/search with X-API-Key. Explicit selection
 * falls back to the keyless /v1/search/public twin.
 */
import {
	type AuthStorage,
	type FetchImpl,
	getEnvApiKey,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	withAuth,
} from "@oh-my-pi/pi-ai";
import { asRecord } from "@oh-my-pi/pi-utils";
import { keenableAuthHeaders, keenableSearchUrl } from "../../../web/keenable";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;

const RECENCY_PUBLISHED_AFTER = {
	day: "1d",
	week: "7d",
	month: "1mo",
	year: "1y",
} as const;

export interface KeenableSearchParams {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	site?: string;
	published_after?: string;
	published_before?: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

interface KeenableSearchHit {
	title?: unknown;
	url?: unknown;
	description?: unknown;
	snippet?: unknown;
	published_at?: unknown;
}

interface KeenableSearchPayload {
	query?: unknown;
	results?: unknown;
}

/** Exported for testing. Builds the Keenable search JSON body. */
export function buildRequestBody(params: KeenableSearchParams): Record<string, unknown> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const body: Record<string, unknown> = {
		query: params.query,
		max_results: numResults,
	};
	if (params.site) body.site = params.site;
	if (params.published_after) body.published_after = params.published_after;
	if (params.published_before) body.published_before = params.published_before;
	if (params.recency && !params.published_after && !params.published_before) {
		body.published_after = RECENCY_PUBLISHED_AFTER[params.recency];
	}
	return body;
}

function publishedDate(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function snippetOf(hit: KeenableSearchHit): string | undefined {
	if (typeof hit.snippet === "string" && hit.snippet.trim()) return hit.snippet.trim();
	if (typeof hit.description === "string" && hit.description.trim()) return hit.description.trim();
	return undefined;
}

async function callKeenableSearch(
	apiKey: string | undefined,
	params: KeenableSearchParams,
): Promise<KeenableSearchPayload> {
	const response = await (params.fetch ?? fetch)(keenableSearchUrl(apiKey), {
		method: "POST",
		headers: {
			...keenableAuthHeaders(apiKey),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(buildRequestBody(params)),
		signal: params.signal,
	});
	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("keenable", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"keenable",
			`Keenable API error (${response.status}): ${errorText.trim() || response.statusText}`,
			response.status,
		);
	}

	const payload: unknown = await response.json();
	return asRecord(payload) ?? {};
}

function toSearchResponse(
	payload: KeenableSearchPayload,
	numResults: number,
	authMode: "api_key" | "keyless",
): SearchResponse {
	const sources: SearchSource[] = [];
	const results = Array.isArray(payload.results) ? payload.results : [];
	for (const value of results) {
		const hit = asRecord(value);
		if (!hit || typeof hit.url !== "string" || !hit.url) continue;
		const published = publishedDate(hit.published_at);
		sources.push({
			title: typeof hit.title === "string" && hit.title ? hit.title : hit.url,
			url: hit.url,
			snippet: snippetOf(hit),
			publishedDate: published,
			ageSeconds: dateToAgeSeconds(published),
		});
	}
	return {
		provider: "keenable",
		sources: sources.slice(0, numResults),
		authMode,
	};
}

function hasRenderableResponse(response: SearchResponse): boolean {
	return response.sources.length > 0;
}

/** Execute Keenable web search. */
export async function searchKeenable(params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const keenableParams: KeenableSearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal,
		fetch: params.fetch,
	};
	if (parsed.hasDirectives) {
		// Native `site` is host-only. Strip a bare host only when there are no
		// exclusions: formatQuery's site capability controls both polarities.
		// Paths, exclusions, and multiple sites must retain query syntax.
		const siteValue = parsed.sites.length === 1 ? parsed.sites[0] : undefined;
		const nativeHost = siteValue?.split("/", 1)[0] || undefined;
		keenableParams.site = nativeHost;
		keenableParams.query = formatQuery(parsed, {
			phrases: true,
			negation: true,
			or: true,
			site: !nativeHost || nativeHost !== siteValue || parsed.excludedSites.length > 0,
			inTitle: true,
			inUrl: true,
			filetype: true,
		});
		if (parsed.after) keenableParams.published_after = parsed.after;
		if (parsed.before) keenableParams.published_before = parsed.before;
	}

	const keyResolver = params.authStorage.resolver("keenable", {
		sessionId: params.sessionId,
	});
	const numResults = clampNumResults(keenableParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const resolvedKey = await resolveApiKeyOnce(keyResolver, signal);
	const seeded = resolvedKey ? seedApiKeyResolver(resolvedKey, keyResolver) : undefined;

	const call = (searchParams: KeenableSearchParams) => {
		if (seeded) {
			return withAuth(seeded, key => callKeenableSearch(key, searchParams), {
				signal,
			});
		}
		return callKeenableSearch(undefined, searchParams);
	};

	const authMode = resolvedKey ? "api_key" : "keyless";
	const response = toSearchResponse(await call(keenableParams), numResults, authMode);
	const shouldRelaxRecency =
		keenableParams.recency !== undefined &&
		keenableParams.published_after === undefined &&
		keenableParams.published_before === undefined;
	if (!shouldRelaxRecency || hasRenderableResponse(response)) return response;

	return toSearchResponse(
		await call({
			...keenableParams,
			recency: undefined,
		}),
		numResults,
		authMode,
	);
}

/** Search provider for Keenable web search. */
export class KeenableProvider extends SearchProvider {
	readonly id = "keenable";
	readonly label = "Keenable";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("keenable") || !!getEnvApiKey("keenable");
	}

	/**
	 * Keyless `/public` search is explicit-only so the auto chain does not
	 * consume the shared per-IP pool.
	 */
	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchKeenable(params);
	}
}
