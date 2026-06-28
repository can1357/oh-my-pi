import { type ApiKey, type AuthStorage, withAuth } from "@pk-nerdsaver-ai/pi-ai";
import type { SearchCitation, SearchResponse, SearchSource, SearchUsage } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const XAI_WEB_SEARCH_MODEL = "grok-4.3";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 30;
const RECENCY_DAYS: Record<NonNullable<SearchParams["recency"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

function formatUtcDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function buildRecencyDateBounds(
	recency: NonNullable<SearchParams["recency"]>,
	now = new Date(),
): {
	from_date: string;
	to_date: string;
} {
	const toDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const fromDate = new Date(toDate);
	fromDate.setUTCDate(fromDate.getUTCDate() - RECENCY_DAYS[recency]);
	return {
		from_date: formatUtcDate(fromDate),
		to_date: formatUtcDate(toDate),
	};
}

interface XAIUrlCitationAnnotation {
	type?: string;
	url?: string | null;
	title?: string | null;
	text?: string | null;
	cited_text?: string | null;
}

interface XAIResponseContentPart {
	type?: string;
	text?: string | null;
	output_text?: string | null;
	annotations?: XAIUrlCitationAnnotation[] | null;
}

interface XAIResponseOutputItem {
	content?: XAIResponseContentPart[] | null;
	annotations?: XAIUrlCitationAnnotation[] | null;
}

interface XAIResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

interface XAIResponsesResponse {
	id?: string;
	model?: string;
	output_text?: string | null;
	output?: XAIResponseOutputItem[] | null;
	annotations?: XAIUrlCitationAnnotation[] | null;
	citations?: string[] | null;
	usage?: XAIResponsesUsage | null;
}

function buildRequestBody(params: SearchParams): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: XAI_WEB_SEARCH_MODEL,
		input: [
			{ role: "system", content: params.systemPrompt },
			{ role: "user", content: params.query },
		],
		tools: [{ type: "web_search" }],
	};

	const requestedSearchResults = params.numSearchResults ?? params.limit;
	const searchParameters: Record<string, unknown> = {};
	if (requestedSearchResults !== undefined) {
		searchParameters.max_search_results = clampNumResults(
			requestedSearchResults,
			DEFAULT_NUM_RESULTS,
			MAX_NUM_RESULTS,
		);
	}
	if (params.recency) {
		Object.assign(searchParameters, buildRecencyDateBounds(params.recency));
	}
	if (Object.keys(searchParameters).length > 0) {
		body.search_parameters = searchParameters;
	}

	if (params.maxOutputTokens !== undefined) {
		body.max_output_tokens = params.maxOutputTokens;
	}
	if (params.temperature !== undefined) {
		body.temperature = params.temperature;
	}

	return body;
}

async function postXAIResponses(
	apiKey: string,
	params: SearchParams,
	body: Record<string, unknown>,
): Promise<Response> {
	return (params.fetch ?? fetch)(XAI_RESPONSES_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal),
	});
}

function throwXAIResponsesError(status: number, errorText: string): never {
	const classified = classifyProviderHttpError("xai", status, errorText);
	if (classified) throw classified;
	throw new SearchProviderError("xai", `xAI Responses API error (${status}): ${errorText}`, status);
}

async function callXAIResponses(apiKey: string, params: SearchParams): Promise<XAIResponsesResponse> {
	const requestBody = buildRequestBody(params);
	const response = await postXAIResponses(apiKey, params, requestBody);

	if (!response.ok) {
		throwXAIResponsesError(response.status, await response.text());
	}

	return (await response.json()) as XAIResponsesResponse;
}

function addCitationSource(
	sources: SearchSource[],
	citations: SearchCitation[],
	seenUrls: Set<string>,
	url: string,
	title?: string | null,
	citedText?: string | null,
): void {
	const trimmedUrl = url.trim();
	if (!trimmedUrl || seenUrls.has(trimmedUrl)) return;
	seenUrls.add(trimmedUrl);
	const sourceTitle = title?.trim() || trimmedUrl;
	const sourceSnippet = citedText?.trim() || undefined;

	sources.push({
		title: sourceTitle,
		url: trimmedUrl,
		snippet: sourceSnippet,
	});
	citations.push({
		title: sourceTitle,
		url: trimmedUrl,
		citedText: sourceSnippet,
	});
}

function collectAnnotationSources(
	annotations: readonly XAIUrlCitationAnnotation[] | null | undefined,
	sources: SearchSource[],
	citations: SearchCitation[],
	seenUrls: Set<string>,
): void {
	if (!annotations) return;
	for (const annotation of annotations) {
		if (annotation.type !== "url_citation" || !annotation.url) continue;
		addCitationSource(
			sources,
			citations,
			seenUrls,
			annotation.url,
			annotation.title,
			annotation.cited_text ?? annotation.text,
		);
	}
}

function parseAnswer(response: XAIResponsesResponse): string | undefined {
	const topLevelText = response.output_text?.trim();
	if (topLevelText) return topLevelText;

	const answerParts: string[] = [];
	for (const item of response.output ?? []) {
		for (const part of item.content ?? []) {
			const text = part.output_text ?? part.text;
			if ((part.type === "output_text" || part.type === "text") && text?.trim()) {
				answerParts.push(text.trim());
			}
		}
	}

	const answer = answerParts.join("\n").trim();
	return answer ? answer : undefined;
}

function parseUsage(usage: XAIResponsesUsage | null | undefined): SearchUsage | undefined {
	if (!usage) return undefined;
	const parsed: SearchUsage = {};
	const inputTokens = usage.input_tokens ?? usage.inputTokens;
	const outputTokens = usage.output_tokens ?? usage.outputTokens;
	const totalTokens = usage.total_tokens ?? usage.totalTokens;

	if (typeof inputTokens === "number") parsed.inputTokens = inputTokens;
	if (typeof outputTokens === "number") parsed.outputTokens = outputTokens;
	if (typeof totalTokens === "number") parsed.totalTokens = totalTokens;

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function applyResultCap(
	sources: SearchSource[],
	citations: SearchCitation[],
	resultCap: number,
): { sources: SearchSource[]; citations: SearchCitation[] } {
	return {
		sources: sources.slice(0, resultCap),
		citations: citations.slice(0, resultCap),
	};
}

function parseResponse(response: XAIResponsesResponse, resultCap: number): SearchResponse {
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const seenUrls = new Set<string>();

	collectAnnotationSources(response.annotations, sources, citations, seenUrls);
	for (const item of response.output ?? []) {
		collectAnnotationSources(item.annotations, sources, citations, seenUrls);
		for (const part of item.content ?? []) {
			collectAnnotationSources(part.annotations, sources, citations, seenUrls);
		}
	}
	for (const url of response.citations ?? []) {
		addCitationSource(sources, citations, seenUrls, url);
	}
	const limited = applyResultCap(sources, citations, resultCap);

	return {
		provider: "xai",
		answer: parseAnswer(response),
		sources: limited.sources,
		citations: limited.citations.length > 0 ? limited.citations : undefined,
		usage: parseUsage(response.usage),
		model: response.model,
		requestId: response.id,
		authMode: "api_key",
	};
}

/** Execute xAI Responses API web search. */
export async function searchXAI(params: SearchParams): Promise<SearchResponse> {
	const keyOrResolver: ApiKey = params.authStorage.resolver("xai", {
		sessionId: params.sessionId,
	});

	const resultCap = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const response = await withAuth(keyOrResolver, (key: string) => callXAIResponses(key, params), {
		signal: params.signal,
		missingKeyMessage: 'xAI credentials not found. Set XAI_API_KEY or configure an API key for provider "xai".',
	});
	return parseResponse(response, resultCap);
}

/** Search provider for xAI web search. */
export class XAIProvider extends SearchProvider {
	readonly id = "xai";
	readonly label = "xAI";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("xai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchXAI(params);
	}
}
