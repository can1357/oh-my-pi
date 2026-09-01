/**
 * Querit Web Search Provider
 *
 * Calls Querit's search API and maps its result envelope into OMP's unified
 * SearchResponse shape.
 */
import { type ApiKey, type AuthStorage, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { asRecord } from "@oh-my-pi/pi-utils";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const QUERIT_SEARCH_URL = "https://api.querit.ai/v1/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

interface QueritSearchRequest {
	query: string;
	count: number;
}

function optionalString(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function normalizeHttpUrl(value: unknown): string | undefined {
	const raw = optionalString(value);
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

async function callQueritSearch(
	apiKey: string,
	request: QueritSearchRequest,
	params: Pick<SearchParams, "fetch" | "signal" | "timeoutMs">,
): Promise<Record<string, unknown>> {
	const response = await (params.fetch ?? fetch)(QUERIT_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(request),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});
	const responseText = await response.text();

	if (!response.ok) {
		const classified = classifyProviderHttpError("querit", response.status, responseText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"querit",
			`Querit API error (${response.status}): ${responseText.trim() || response.statusText}`,
			response.status,
		);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(responseText);
	} catch {
		throw new SearchProviderError("querit", "Querit Search API returned invalid JSON", response.status);
	}
	const body = asRecord(payload);
	if (!body) {
		throw new SearchProviderError("querit", "Querit Search API returned an unexpected response shape");
	}

	const rawErrorCode = body.error_code;
	const errorCode =
		typeof rawErrorCode === "number"
			? rawErrorCode
			: typeof rawErrorCode === "string"
				? Number(rawErrorCode)
				: undefined;
	if (errorCode !== undefined && Number.isFinite(errorCode) && errorCode !== 200) {
		const message = optionalString(body.error_msg) ?? `Querit API error (${errorCode})`;
		const classified = classifyProviderHttpError("querit", errorCode, message);
		if (classified) throw classified;
		throw new SearchProviderError("querit", message, errorCode);
	}
	return body;
}

function toSearchSources(payload: Record<string, unknown>, numResults: number): SearchSource[] {
	const results = asRecord(payload.results)?.result;
	if (!Array.isArray(results)) {
		throw new SearchProviderError("querit", "Querit Search API returned an unexpected response shape");
	}

	const sources: SearchSource[] = [];
	const seenUrls = new Set<string>();
	for (const value of results) {
		const result = asRecord(value);
		if (!result) continue;
		const url = normalizeHttpUrl(result.url);
		if (!url || seenUrls.has(url)) continue;
		seenUrls.add(url);
		const publishedDate = optionalString(result.page_age);
		sources.push({
			title: optionalString(result.title) ?? url,
			url,
			snippet: optionalString(result.snippet)?.replace(/\s+/g, " "),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
			author: optionalString(result.site_name),
		});
		if (sources.length >= numResults) break;
	}
	return sources;
}

/** Execute Querit web search. Querit-specific filters stay at their broad API defaults. */
export async function searchQuerit(params: SearchParams): Promise<SearchResponse> {
	const request: QueritSearchRequest = {
		query: params.query,
		count: clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	};
	const keyOrResolver: ApiKey = params.authStorage.resolver("querit", {
		sessionId: params.sessionId,
	});
	const payload = await withAuth(keyOrResolver, key => callQueritSearch(key, request, params), {
		signal: params.signal,
		missingKeyMessage:
			'Querit credentials not found. Set QUERIT_API_KEY or configure an API key for provider "querit".',
	});

	return {
		provider: "querit",
		sources: toSearchSources(payload, request.count),
		requestId: optionalString(payload.search_id),
		authMode: "api_key",
	};
}

/** Search provider for Querit web search. */
export class QueritProvider extends SearchProvider {
	readonly id = "querit";
	readonly label = "Querit";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("querit") || !!getEnvApiKey("querit");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchQuerit(params);
	}
}
