import type { AuthStorage } from "@pk-nerdsaver-ai/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DUCKDUCKGO_SEARCH_URL = "https://api.duckduckgo.com/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

interface DuckDuckGoTopic {
	FirstURL?: string | null;
	Text?: string | null;
	Topics?: DuckDuckGoTopic[] | null;
}

interface DuckDuckGoResponse {
	AbstractText?: string | null;
	AbstractURL?: string | null;
	AbstractSource?: string | null;
	Answer?: string | null;
	Definition?: string | null;
	Heading?: string | null;
	Results?: DuckDuckGoTopic[] | null;
	RelatedTopics?: DuckDuckGoTopic[] | null;
}

function cleanText(value: string | null | undefined): string | undefined {
	const cleaned = value
		?.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned ? cleaned : undefined;
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!source.url || sources.some(existing => existing.url === source.url)) return;
	sources.push(source);
}

function addTopicSource(sources: SearchSource[], topic: DuckDuckGoTopic): void {
	const url = topic.FirstURL?.trim();
	if (!url) return;
	const text = cleanText(topic.Text);
	addSource(sources, {
		title: text ?? url,
		url,
		snippet: text,
	});
}

function collectTopicSources(sources: SearchSource[], topics: readonly DuckDuckGoTopic[] | null | undefined): void {
	if (!topics) return;
	for (const topic of topics) {
		addTopicSource(sources, topic);
		collectTopicSources(sources, topic.Topics);
	}
}

async function callDuckDuckGoSearch(params: SearchParams): Promise<DuckDuckGoResponse> {
	const queryString = [
		["q", params.query],
		["format", "json"],
		["no_redirect", "1"],
		["no_html", "1"],
		["skip_disambig", "1"],
		["t", "oh-my-pi"],
	]
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join("&");
	const response = await (params.fetch ?? fetch)(`${DUCKDUCKGO_SEARCH_URL}?${queryString}`, {
		method: "GET",
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("duckduckgo", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"duckduckgo",
			`DuckDuckGo API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return (await response.json()) as DuckDuckGoResponse;
}

/** Execute DuckDuckGo Instant Answer API search. */
export async function searchDuckDuckGo(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const data = await callDuckDuckGoSearch(params);
	const answer = cleanText(data.AbstractText) ?? cleanText(data.Answer) ?? cleanText(data.Definition);
	const sources: SearchSource[] = [];

	const abstractUrl = data.AbstractURL?.trim();
	if (abstractUrl) {
		addSource(sources, {
			title: cleanText(data.AbstractSource) ?? cleanText(data.Heading) ?? abstractUrl,
			url: abstractUrl,
			snippet: cleanText(data.AbstractText),
		});
	}

	collectTopicSources(sources, data.Results);
	collectTopicSources(sources, data.RelatedTopics);

	return {
		provider: "duckduckgo",
		answer,
		sources: sources.slice(0, numResults),
	};
}

/** Search provider for DuckDuckGo Instant Answer API. */
export class DuckDuckGoProvider extends SearchProvider {
	readonly id = "duckduckgo";
	readonly label = "DuckDuckGo";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDuckDuckGo(params);
	}
}
