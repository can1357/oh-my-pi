import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { StructuredQuery } from "../query";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { canonicalSearchUrlKey, classifyProviderHttpError, withHardTimeout } from "./utils";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 100;

const RECENCY_TBS: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = replaceTabs(value).trim();
	return normalized || undefined;
}

function httpUrl(value: unknown): string | undefined {
	const raw = text(value);
	if (!raw || raw.length > 2_048) return undefined;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.hostname.endsWith(".m.wikipedia.org")) {
			url.hostname = url.hostname.replace(/\.m\.wikipedia\.org$/, ".wikipedia.org");
		}
		return url.toString();
	} catch {
		return undefined;
	}
}

function sourceFrom(value: unknown): SearchSource | undefined {
	const result = asObject(value);
	if (!result) return undefined;
	const url = httpUrl(result.link);
	if (!url) return undefined;
	return {
		title: text(result.title) ?? url,
		url,
		snippet: text(result.snippet),
		publishedDate: text(result.date),
	};
}

function parseResponse(
	value: unknown,
	numResults: number,
): Pick<SearchResponse, "answer" | "sources" | "relatedQuestions"> {
	const data = asObject(value);
	if (!data) throw new SearchProviderError("serper", "Serper API returned an invalid response", 500);

	const sources: SearchSource[] = [];
	const seenSources = new Set<string>();
	const addSource = (source: SearchSource | undefined) => {
		if (!source || sources.length >= numResults) return;
		const key = canonicalSearchUrlKey(source.url);
		if (seenSources.has(key)) return;
		seenSources.add(key);
		sources.push(source);
	};

	const answerBox = asObject(data.answerBox);
	if (answerBox) addSource(sourceFrom(answerBox));

	const knowledgeGraph = asObject(data.knowledgeGraph);
	if (knowledgeGraph) {
		addSource(
			sourceFrom({
				title: knowledgeGraph.title,
				link: knowledgeGraph.descriptionLink ?? knowledgeGraph.website,
				snippet: knowledgeGraph.description,
			}),
		);
	}
	if (Array.isArray(data.organic)) {
		for (const result of data.organic) addSource(sourceFrom(result));
	}

	let answer: string | undefined;
	if (answerBox) {
		const title = text(answerBox.title);
		let detail = text(answerBox.answer) ?? text(answerBox.snippet);
		if (!detail && Array.isArray(answerBox.snippetHighlighted)) {
			const lines = answerBox.snippetHighlighted.flatMap(value => {
				const line = text(value);
				return line ? [line] : [];
			});
			detail = lines.length ? lines.join("\n") : undefined;
		}
		if (detail) answer = title ? `${title}\n${detail}` : detail;
		else answer = title;
	}

	const relatedQuestions = new Set<string>();
	if (Array.isArray(data.peopleAlsoAsk)) {
		for (const item of data.peopleAlsoAsk) {
			const question = text(asObject(item)?.question);
			if (question) relatedQuestions.add(question);
		}
	}
	if (Array.isArray(data.relatedSearches)) {
		for (const item of data.relatedSearches) {
			const query = text(asObject(item)?.query);
			if (query) relatedQuestions.add(query);
		}
	}

	return {
		...(answer && { answer }),
		sources,
		relatedQuestions: relatedQuestions.size ? [...relatedQuestions] : undefined,
	};
}

export interface SerperSearchParams {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	parsedQuery?: StructuredQuery;
	authStorage: AuthStorage;
	sessionId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

async function callSerperSearch(apiKey: string, params: SerperSearchParams): Promise<SearchResponse> {
	const numResults = Math.floor(clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS));
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;
	const response = await (params.fetch ?? fetch)(SERPER_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-API-KEY": apiKey,
		},
		body: JSON.stringify({
			q: query,
			num: numResults,
			...(params.recency && { tbs: RECENCY_TBS[params.recency] }),
		}),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = (await response.text()).slice(0, 8_192);
		const classified = classifyProviderHttpError("serper", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("serper", `Serper API error (${response.status}): ${errorText}`, response.status);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new SearchProviderError("serper", "Serper API returned invalid JSON", 500);
	}
	const result = parseResponse(payload, numResults);
	return {
		provider: "serper",
		...result,
		requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
		authMode: "api_key",
	};
}

export async function searchSerper(params: SerperSearchParams): Promise<SearchResponse> {
	const keyOrResolver: ApiKey = params.authStorage.resolver("serper", { sessionId: params.sessionId });
	return withAuth(keyOrResolver, key => callSerperSearch(key, params), {
		signal: params.signal,
		missingKeyMessage:
			'Serper credentials not found. Set SERPER_API_KEY or configure an API key for provider "serper".',
	});
}

export class SerperProvider extends SearchProvider {
	readonly id = "serper";
	readonly label = "Serper";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("serper") || !!getEnvApiKey("serper");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSerper({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			parsedQuery: params.parsedQuery,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			fetch: params.fetch,
		});
	}
}
