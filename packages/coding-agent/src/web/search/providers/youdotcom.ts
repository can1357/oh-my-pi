/**
 * You.com Web Search Provider
 *
 * Calls You.com's Web Search API and maps the ranked web results into the
 * unified SearchResponse shape. Requests query-aware highlights, which are
 * included in the base call price.
 * Endpoint: POST https://ydc-index.io/v1/search
 * Docs: https://you.com/docs/api-reference/search/v1-search
 */
import { type ApiKey, type AuthStorage, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { truncate } from "@oh-my-pi/pi-utils";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import type { QuerySyntax, StructuredQuery } from "../query";
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, normalizeSearchText, readLimitedText, siteHosts, withHardTimeout } from "./utils";

const YOUDOTCOM_SEARCH_URL = "https://ydc-index.io/v1/search";
const DEFAULT_NUM_RESULTS = 10;
/** `extraction_mode: "highlights"` rejects `count` above 50 with a 422. */
const MAX_NUM_RESULTS = 50;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
/** Source URLs and titles reach tool output untruncated; bound them like the Brave adapter. */
const MAX_URL_CHARS = 2048;
const MAX_TITLE_CHARS = 300;

/**
 * You.com parses quoted phrases, `-term`, `OR`, and `filetype:` inline.
 * `site:`/`-site:` map onto the native domain lists and date bounds onto
 * `freshness`, so neither is re-emitted in the query string.
 */
const YOUDOTCOM_QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true, or: true, filetype: true };

/** `language` values the API accepts (BCP 47, uppercase); anything else is a 422. */
const YOUDOTCOM_LANGUAGES: Record<string, true> = {
	AR: true,
	EU: true,
	BN: true,
	BG: true,
	CA: true,
	"ZH-HANS": true,
	"ZH-HANT": true,
	HR: true,
	CS: true,
	DA: true,
	NL: true,
	EN: true,
	"EN-GB": true,
	ET: true,
	FI: true,
	FR: true,
	GL: true,
	DE: true,
	EL: true,
	GU: true,
	HE: true,
	HI: true,
	HU: true,
	IS: true,
	IT: true,
	JA: true,
	KN: true,
	KO: true,
	LV: true,
	LT: true,
	MS: true,
	ML: true,
	MR: true,
	NB: true,
	PL: true,
	"PT-BR": true,
	"PT-PT": true,
	PA: true,
	RO: true,
	RU: true,
	SR: true,
	SK: true,
	SL: true,
	ES: true,
	SV: true,
	TA: true,
	TE: true,
	TH: true,
	TR: true,
	UK: true,
	VI: true,
};

interface YouDotComWebResult {
	url?: unknown;
	title?: unknown;
	description?: unknown;
	snippets?: unknown;
	page_age?: unknown;
	contents?: { highlights?: unknown };
}

interface YouDotComSearchResponse {
	results?: { web?: unknown };
	metadata?: { search_uuid?: unknown };
}

/** Map a parsed `lang:` value onto an accepted `language`, trying the full tag before its primary subtag. */
function youDotComLanguage(lang: string | undefined): string | undefined {
	if (!lang) return undefined;
	const tag = lang.toUpperCase();
	if (Object.hasOwn(YOUDOTCOM_LANGUAGES, tag)) return tag;
	const primary = tag.split("-", 1)[0];
	return Object.hasOwn(YOUDOTCOM_LANGUAGES, primary) ? primary : undefined;
}

/**
 * `freshness`: explicit `after:`/`before:` bounds win over the recency period,
 * rendered as the absolute range `YYYY-MM-DDtoYYYY-MM-DD` with open ends filled.
 */
function youDotComFreshness(parsed: StructuredQuery, recency: SearchParams["recency"]): string | undefined {
	if (parsed.after || parsed.before) {
		const start = parsed.after ?? "1970-01-01";
		const end = parsed.before ?? new Date().toISOString().slice(0, 10);
		return `${start}to${end}`;
	}
	return recency;
}

/** Exported for testing. Builds the You.com request body from unified params. */
export function buildRequestBody(params: SearchParams): Record<string, unknown> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const body: Record<string, unknown> = {
		query: parsed.hasDirectives ? formatQuery(parsed, YOUDOTCOM_QUERY_SYNTAX) : params.query,
		count: Math.floor(clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS)),
		extraction: { extraction_mode: "highlights" },
	};
	// The API rejects include_domains combined with exclude_domains; the allow-list wins.
	const include = siteHosts(parsed.sites);
	const exclude = siteHosts(parsed.excludedSites);
	if (include.length) body.include_domains = include;
	else if (exclude.length) body.exclude_domains = exclude;
	const freshness = youDotComFreshness(parsed, params.recency);
	if (freshness) body.freshness = freshness;
	const language = youDotComLanguage(parsed.lang);
	if (language) body.language = language;
	return body;
}

function normalizeUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > MAX_URL_CHARS) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** Highlights first (query-relevant passages), then the description, then keyword snippets. */
function buildSnippet(result: YouDotComWebResult): string | undefined {
	for (const candidate of [result.contents?.highlights, result.description, result.snippets]) {
		const passages = (Array.isArray(candidate) ? candidate : [candidate]).flatMap(
			item => normalizeSearchText(item) ?? [],
		);
		if (passages.length) return passages.join("\n");
	}
	return undefined;
}

async function callYouDotComSearch(
	apiKey: string,
	body: Record<string, unknown>,
	params: SearchParams,
): Promise<YouDotComSearchResponse> {
	const fetchImpl = params.fetch ?? fetch;
	const response = await fetchImpl(YOUDOTCOM_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-API-Key": apiKey,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "youdotcom", MAX_ERROR_BYTES, true);
		const classified = classifyProviderHttpError("youdotcom", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"youdotcom",
			`You.com API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const raw = await readLimitedText(response, "youdotcom", MAX_RESPONSE_BYTES);
	try {
		return JSON.parse(raw) as YouDotComSearchResponse;
	} catch {
		throw new SearchProviderError("youdotcom", "You.com API returned invalid JSON", 500);
	}
}

/** Execute You.com web search. */
export async function searchYouDotCom(params: SearchParams): Promise<SearchResponse> {
	const body = buildRequestBody(params);
	const keyOrResolver: ApiKey = params.authStorage.keys.resolver("youdotcom", { sessionId: params.sessionId });
	const data = await withAuth(keyOrResolver, key => callYouDotComSearch(key, body, params), {
		signal: params.signal,
		missingKeyMessage:
			'You.com credentials not found. Set YDC_API_KEY or configure an API key for provider "youdotcom".',
	});

	const web = data.results?.web;
	const sources: SearchSource[] = [];
	for (const result of Array.isArray(web) ? (web as unknown[]) : []) {
		if (typeof result !== "object" || result === null) continue;
		const entry = result as YouDotComWebResult;
		const url = normalizeUrl(entry.url);
		if (!url) continue;
		const publishedDate = typeof entry.page_age === "string" && entry.page_age ? entry.page_age : undefined;
		sources.push({
			title: truncate(normalizeSearchText(entry.title) ?? url, MAX_TITLE_CHARS),
			url,
			snippet: buildSnippet(entry),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	const searchUuid = data.metadata?.search_uuid;
	return {
		provider: "youdotcom",
		sources: sources.slice(0, body.count as number),
		requestId: typeof searchUuid === "string" ? searchUuid : undefined,
		authMode: "api_key",
	};
}

/** Search provider for You.com's Web Search API. */
export class YouDotComProvider extends SearchProvider {
	readonly id = "youdotcom";
	readonly label = "You.com";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("youdotcom") !== undefined || !!getEnvApiKey("youdotcom");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchYouDotCom(params);
	}
}
