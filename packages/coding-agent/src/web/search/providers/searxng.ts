/**
 * SearXNG Web Search Provider
 *
 * Calls a SearXNG instance's JSON search API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 *
 * SearXNG is a free, open-source metasearch engine that aggregates results from
 * multiple sources without tracking users. It supports self-hosted instances
 * and various authentication methods (bearer token, basic auth, or none).
 *
 * Configuration via settings:
 *   searxng.endpoint      - Base URL of the SearXNG instance (e.g. https://searx.example.org)
 *   searxng.token         - Optional bearer token for authentication
 *   searxng.basicUsername - Optional RFC 7617 Basic auth username
 *   searxng.basicPassword - Optional RFC 7617 Basic auth password
 *   searxng.categories    - Optional comma-separated categories filter
 *   searxng.engines       - Optional comma-separated engine names or shortcuts
 *                           (e.g. "duckduckgo, br, sp"); shortcuts resolve via
 *                           the instance's /config endpoint
 *   searxng.language      - Optional language code (e.g. en, zh-CN)
 *
 * Environment variable fallbacks:
 *   SEARXNG_ENDPOINT       - Base URL of the SearXNG instance
 *   SEARXNG_TOKEN          - Optional bearer token
 *   SEARXNG_BASIC_USERNAME - Optional RFC 7617 Basic auth username
 *   SEARXNG_BASIC_PASSWORD - Optional RFC 7617 Basic auth password
 *
 * Bang syntax in queries is passed through: `!ddg foo` selects an engine or
 * category server-side and the bang token is stripped from the upstream query.
 * External bangs (`!!g`) are removed client-side because SearXNG answers them
 * with an HTTP redirect even for JSON requests.
 *
 * Reference: https://docs.searxng.org/dev/search_api.html
 */

import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";

import { settings } from "../../../config/settings";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { StructuredQuery } from "../query";
import { formatScraperQuery, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/** Map our recency filter to SearXNG time_range parameter.
 *  SearXNG only supports day/month/year, so week maps to month. */
const RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
	day: "day",
	week: "month",
	month: "month",
	year: "year",
};

/** SearXNG JSON API response types */
interface SearXNGResult {
	title?: string;
	url?: string;
	content?: string;
	snippet?: string;
	engine?: string;
	publishedDate?: string;
	/** SearXNG sometimes uses publishedDate, sometimes just date */
	published_date?: string;
	score?: number;
}

interface SearXNGResponse {
	query?: string;
	number_of_results?: number;
	results?: SearXNGResult[];
	suggestions?: string[];
	corrections?: string[];
	unresponsive_engines?: Array<[string, string]>;
	answers?: unknown[];
}

interface SearXNGAuth {
	type: "basic" | "bearer";
	value: string;
}

/** Subset of the SearXNG /config payload used for engine shortcut resolution. */
interface SearXNGConfig {
	engines?: Array<{ name?: string; shortcut?: string }>;
}

/** Find SearXNG endpoint from settings or environment. */
function findEndpoint(): string | null {
	try {
		const endpoint = settings.get("searxng.endpoint");
		if (endpoint) return endpoint;
	} catch {
		// Settings not initialized yet
	}
	return process.env.SEARXNG_ENDPOINT ?? null;
}

/** Find SearXNG bearer token from settings or environment. */
function findToken(): string | null {
	try {
		const token = settings.get("searxng.token");
		if (token) return token;
	} catch {
		// Settings not initialized yet
	}
	return process.env.SEARXNG_TOKEN ?? null;
}

/** Find SearXNG Basic auth username from settings or environment. */
function findBasicUsername(): string | null {
	try {
		const username = settings.get("searxng.basicUsername");
		if (username !== undefined) return username;
	} catch {
		// Settings not initialized yet
	}
	return process.env.SEARXNG_BASIC_USERNAME ?? null;
}

/** Find SearXNG Basic auth password from settings or environment. */
function findBasicPassword(): string | null {
	try {
		const password = settings.get("searxng.basicPassword");
		if (password !== undefined) return password;
	} catch {
		// Settings not initialized yet
	}
	return process.env.SEARXNG_BASIC_PASSWORD ?? null;
}

/** Build the RFC 7617 Basic auth credential using UTF-8 bytes. */
function buildBasicAuthValue(username: string, password: string): string {
	return Buffer.from(`${username}:${password}`, "utf-8").toString("base64");
}

/** RFC 7617 forbids C0 and C1 control characters in Basic auth credentials. */
function hasControlCharacters(value: string): boolean {
	return /[\u0000-\u001F\u007F-\u009F]/u.test(value);
}

/** Find SearXNG authentication from settings or environment. Basic auth takes precedence over bearer tokens. */
function findAuth(): SearXNGAuth | null {
	const basicUsername = findBasicUsername();
	const basicPassword = findBasicPassword();
	if (basicUsername !== null || basicPassword !== null) {
		if (basicUsername === null || basicPassword === null) {
			throw new Error(
				"SearXNG Basic auth requires both searxng.basicUsername and searxng.basicPassword, or SEARXNG_BASIC_USERNAME and SEARXNG_BASIC_PASSWORD.",
			);
		}
		if (basicUsername.includes(":")) {
			throw new Error("SearXNG Basic auth username cannot contain ':' because RFC 7617 uses it as the separator.");
		}
		if (hasControlCharacters(basicUsername) || hasControlCharacters(basicPassword)) {
			throw new Error("SearXNG Basic auth credentials must not contain RFC 7617 control characters.");
		}
		return { type: "basic", value: buildBasicAuthValue(basicUsername, basicPassword) };
	}

	const token = findToken();
	return token ? { type: "bearer", value: token } : null;
}

/** Find configured engine names/shortcuts from settings. */
function findEngines(): string | null {
	try {
		const engines = settings.get("searxng.engines");
		if (engines) return engines;
	} catch {
		// Settings not initialized yet
	}
	return null;
}

/** Build request headers including authentication. */
function buildHeaders(auth: SearXNGAuth | null): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (auth?.type === "basic") {
		headers.Authorization = `Basic ${auth.value}`;
	} else if (auth?.type === "bearer") {
		headers.Authorization = `Bearer ${auth.value}`;
	}
	return headers;
}

/** Per-endpoint cache of shortcut/name → canonical engine name maps. */
const engineNameMapCache = new Map<string, Promise<Map<string, string> | null>>();

/** Fetch the instance's /config and build a lookup of lowercased engine names
 *  and shortcuts to canonical engine names. Returns null on any failure. */
async function fetchEngineNameMap(
	base: string,
	auth: SearXNGAuth | null,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
	timeoutMs?: number,
): Promise<Map<string, string> | null> {
	try {
		const response = await (fetchImpl ?? fetch)(`${base}/config`, {
			headers: buildHeaders(auth),
			signal: withHardTimeout(signal, timeoutMs),
		});
		if (!response.ok) return null;
		const config = (await response.json()) as SearXNGConfig;
		const map = new Map<string, string>();
		for (const engine of config.engines ?? []) {
			if (!engine.name) continue;
			map.set(engine.name.toLowerCase(), engine.name);
			if (engine.shortcut) map.set(engine.shortcut.toLowerCase(), engine.name);
		}
		return map.size ? map : null;
	} catch {
		return null;
	}
}

/** Get the engine name map for an endpoint, cached for the process lifetime.
 *  Failures are not cached so a transient error retries on the next search. */
function getEngineNameMap(
	endpoint: string,
	auth: SearXNGAuth | null,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
	timeoutMs?: number,
): Promise<Map<string, string> | null> {
	const base = endpoint.replace(/\/+$/, "");
	let cached = engineNameMapCache.get(base);
	if (!cached) {
		cached = fetchEngineNameMap(base, auth, fetchImpl, signal, timeoutMs).then(map => {
			if (!map) engineNameMapCache.delete(base);
			return map;
		});
		engineNameMapCache.set(base, cached);
	}
	return cached;
}

/** Resolve configured engine entries (canonical names or shortcuts like `ddg`)
 *  to canonical names for SearXNG's `engines=` parameter, which accepts names
 *  only — shortcuts resolve exclusively through bang syntax. Unknown entries
 *  pass through verbatim; the server drops them and falls back to categories. */
async function resolveEngineNames(
	raw: string,
	endpoint: string,
	auth: SearXNGAuth | null,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
	timeoutMs?: number,
): Promise<string | undefined> {
	const entries = raw
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
	if (!entries.length) return undefined;
	const map = await getEngineNameMap(endpoint, auth, fetchImpl, signal, timeoutMs);
	if (!map) return entries.join(",");
	return entries.map(entry => map.get(entry.toLowerCase()) ?? entry).join(",");
}

/** Strip external bang tokens (`!!g`, bare `!!`): SearXNG answers them with an
 *  HTTP redirect even for JSON requests, which breaks response parsing.
 *  Single-bang engine/category selectors (`!ddg`, `!images`) are kept — the
 *  instance resolves and removes them server-side. */
function stripExternalBangs(query: string): string {
	return query
		.split(/\s+/)
		.filter(part => !part.startsWith("!!"))
		.join(" ");
}

/** Extract displayable text from both legacy string answers and modern
 *  structured answer plugins (legacy, translations, weather). */
function extractAnswerText(answer: unknown): string | undefined {
	if (typeof answer === "string") return answer.trim() || undefined;
	if (!answer || typeof answer !== "object") return undefined;

	const record = answer as Record<string, unknown>;
	if (typeof record.answer === "string") return record.answer.trim() || undefined;

	if (Array.isArray(record.translations)) {
		const translations: string[] = [];
		for (const item of record.translations) {
			if (!item || typeof item !== "object") continue;
			const text = (item as Record<string, unknown>).text;
			if (typeof text === "string" && text.trim()) translations.push(text.trim());
			if (translations.length === 3) break;
		}
		if (translations.length) return translations.join("\n");
	}

	if (record.current && typeof record.current === "object") {
		const current = record.current as Record<string, unknown>;
		if (typeof current.summary === "string" && current.summary.trim()) return current.summary.trim();
		const location =
			current.location && typeof current.location === "object"
				? (current.location as Record<string, unknown>).name
				: undefined;
		const temperature =
			current.temperature && typeof current.temperature === "object"
				? (current.temperature as Record<string, unknown>)
				: undefined;
		const temperatureText =
			temperature && (typeof temperature.val === "string" || typeof temperature.val === "number")
				? `${temperature.val}${typeof temperature.unit === "string" ? temperature.unit : ""}`
				: undefined;
		const condition = typeof current.condition === "string" ? current.condition : undefined;
		const parts = [location, temperatureText, condition].filter(
			(part): part is string => typeof part === "string" && part.trim().length > 0,
		);
		if (parts.length) return parts.join(": ");
	}

	return undefined;
}

function formatAnswers(answers: unknown[] | undefined): string | undefined {
	const texts: string[] = [];
	for (const answer of answers ?? []) {
		const text = extractAnswerText(answer);
		if (text) texts.push(text);
		if (texts.length === 3) break;
	}
	return texts.length ? texts.join("\n\n") : undefined;
}

/** Build the search URL and headers for a SearXNG request */
function buildRequest(
	endpoint: string,
	params: {
		query: string;
		num_results?: number;
		recency?: "day" | "week" | "month" | "year";
		categories?: string;
		engines?: string;
		language?: string;
		safesearch?: 0 | 1 | 2;
		signal?: AbortSignal;
	},
	auth: SearXNGAuth | null,
): { url: URL; headers: Record<string, string> } {
	const base = endpoint.replace(/\/+$/, "");
	const url = new URL(`${base}/search`);

	url.searchParams.set("q", params.query);
	url.searchParams.set("format", "json");

	if (params.num_results) {
		url.searchParams.set("pageno", "1");
	}

	if (params.recency) {
		url.searchParams.set("time_range", RECENCY_MAP[params.recency]);
	}

	if (params.categories) {
		url.searchParams.set("categories", params.categories);
	}

	if (params.engines) {
		url.searchParams.set("engines", params.engines);
	}

	if (params.safesearch !== undefined) {
		url.searchParams.set("safesearch", String(params.safesearch));
	}

	if (params.language) {
		url.searchParams.set("language", params.language);
	}

	const headers = buildHeaders(auth);

	return { url, headers };
}

async function callSearXNGSearch(
	endpoint: string,
	params: {
		query: string;
		num_results?: number;
		recency?: "day" | "week" | "month" | "year";
		categories?: string;
		engines?: string;
		language?: string;
		safesearch?: 0 | 1 | 2;
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch?: FetchImpl;
	},
	auth: SearXNGAuth | null,
): Promise<SearXNGResponse> {
	const { url, headers } = buildRequest(endpoint, params, auth);

	const response = await (params.fetch ?? fetch)(url, {
		headers,
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("searxng", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("searxng", `SearXNG API error (${response.status}): ${errorText}`, response.status);
	}

	return (await response.json()) as SearXNGResponse;
}

/** Execute SearXNG web search. */
export async function searchSearXNG(params: {
	query: string;
	parsedQuery?: StructuredQuery;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const endpoint = findEndpoint();
	if (!endpoint) {
		throw new Error(
			"SearXNG endpoint not configured. Set searxng.endpoint in settings or SEARXNG_ENDPOINT in environment.",
		);
	}

	const auth = findAuth();

	let categories: string | undefined;
	let language: string | undefined;
	let configuredSafesearch: number | undefined;
	try {
		categories = settings.get("searxng.categories") ?? undefined;
		language = settings.get("searxng.language") ?? undefined;
		configuredSafesearch = settings.get("searxng.safesearch");
	} catch {
		// Settings not initialized yet
	}
	if (
		configuredSafesearch !== undefined &&
		configuredSafesearch !== 0 &&
		configuredSafesearch !== 1 &&
		configuredSafesearch !== 2
	) {
		throw new Error("searxng.safesearch must be 0 (off), 1 (moderate), or 2 (strict).");
	}
	const safesearch = configuredSafesearch;
	const configuredEngines = findEngines();

	// SearXNG forwards `q` to downstream engines, so build it with the shared
	// scraper formatter: operators are canonicalized and scraper-hostile ones
	// (path-carrying `site:`, `inurl:`) are structurally demoted to plain
	// terms before formatting, so paren-grouped `site:` filters are covered
	// too. `lang:` maps onto the native `language` param (overriding the
	// configured default).
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = formatScraperQuery(params.query, parsed);
	if (parsed.lang) language = parsed.lang;

	const engines = configuredEngines
		? await resolveEngineNames(configuredEngines, endpoint, auth, params.fetch, params.signal, params.timeoutMs)
		: undefined;

	const response = await callSearXNGSearch(
		endpoint,
		{
			...params,
			query: stripExternalBangs(query),
			categories,
			engines,
			language,
			safesearch,
			fetch: params.fetch,
		},
		auth,
	);

	const sources: SearchSource[] = [];

	for (const result of response.results ?? []) {
		if (!result.url) continue;
		const publishedDate = result.publishedDate ?? result.published_date;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: (result.content ?? result.snippet)?.trim() || undefined,
			publishedDate: publishedDate ?? undefined,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	const limitedSources = sources.slice(0, numResults);
	if (limitedSources.length === 0 && response.unresponsive_engines?.length) {
		const upstreamFailures = response.unresponsive_engines
			.map(([engine, reason]) => `${engine}: ${reason}`)
			.join("; ");
		throw new SearchProviderError(
			"searxng",
			`SearXNG returned no usable results; upstream engines failed: ${upstreamFailures}`,
			503,
		);
	}

	return {
		provider: "searxng",
		answer: formatAnswers(response.answers),
		sources: limitedSources,
		relatedQuestions: response.suggestions?.length ? response.suggestions : undefined,
	};
}

/** Search provider for SearXNG web search. */
export class SearXNGProvider extends SearchProvider {
	readonly id = "searxng";
	readonly label = "SearXNG";

	isAvailable(_authStorage: AuthStorage): boolean {
		try {
			return !!findEndpoint();
		} catch {
			return false;
		}
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSearXNG({
			parsedQuery: params.parsedQuery,
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			fetch: params.fetch,
		});
	}
}
