import { type ApiKey, type ApiKeyResolver, type AuthStorage, withAuth } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import { resolveXAIHttpTransport, type XAIHttpProvider, type XAIHttpTransport } from "../../../lib/xai-http";
import type { SearchCitation, SearchResponse, SearchSource, SearchUsage } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
const XAI_WEB_SEARCH_MODEL = "grok-4.5";
// grok-4.5 defaults reasoning.effort to "high"; xAI documents "low" for
// latency-sensitive agentic use and simple tool calling
// (docs.x.ai/developers/model-capabilities/text/reasoning). Web search is
// latency-sensitive, so pin these calls low regardless of their configured timeout.
const XAI_WEB_SEARCH_REASONING_EFFORT = "low";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 30;

interface XAIUrlCitationAnnotation {
	type?: string;
	url?: string | null;
	title?: string | null;
	text?: string | null;
	cited_text?: string | null;
	start_index?: number | null;
	end_index?: number | null;
}

interface XAIResponseContentPart {
	type?: string;
	text?: string | null;
	output_text?: string | null;
	annotations?: XAIUrlCitationAnnotation[] | null;
}

interface XAIWebSearchSource {
	url?: string | null;
	source_website_url?: string | null;
	title?: string | null;
	caption?: string | null;
}

interface XAIResponseOutputItem {
	type?: string;
	content?: XAIResponseContentPart[] | null;
	annotations?: XAIUrlCitationAnnotation[] | null;
	action?: { sources?: XAIWebSearchSource[] | null } | null;
	sources?: XAIWebSearchSource[] | null;
	results?: XAIWebSearchSource[] | null;
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

/**
 * Query syntax re-emitted for the Grok search agent. `site:`/`-site:` are
 * stripped because hosts map natively onto the web_search domain filters;
 * `before:`/`after:` stay in the query text — the Responses web_search tool
 * has no date parameters (`from_date`/`to_date` exist only on `x_search` and
 * the deprecated Live Search `search_parameters`, which now returns 410) and
 * the agent honors the tokens as natural-language hints.
 */
const XAI_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	inUrl: true,
	inTitle: true,
	filetype: true,
	dateRange: true,
};

/** xAI web_search accepts at most 5 allowed or excluded domains per request. */
const MAX_DOMAIN_FILTERS = 5;

/** Bare hosts of `site:` values (`github.com/anthropics` → `github.com`), deduped, capped at 5; path parts are enforced by the central constraint filter. */
function domainFilterList(sites: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const site of sites) {
		const slash = site.indexOf("/");
		hosts.add(slash === -1 ? site : site.slice(0, slash));
		if (hosts.size === MAX_DOMAIN_FILTERS) break;
	}
	return [...hosts];
}

function buildRequestBody(params: SearchParams): Record<string, unknown> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const webSearchTool: Record<string, unknown> = { type: "web_search" };
	let query = params.query;
	if (parsed.hasDirectives) {
		query = formatQuery(parsed, XAI_QUERY_SYNTAX);
		// allowed_domains and excluded_domains are mutually exclusive per
		// request; prefer the allow list, the central filter enforces exclusions.
		if (parsed.sites.length > 0) {
			webSearchTool.filters = { allowed_domains: domainFilterList(parsed.sites) };
		} else if (parsed.excludedSites.length > 0) {
			webSearchTool.filters = { excluded_domains: domainFilterList(parsed.excludedSites) };
		}
	}

	const body: Record<string, unknown> = {
		model: XAI_WEB_SEARCH_MODEL,
		input: [
			{ role: "system", content: params.systemPrompt },
			{ role: "user", content: query },
		],
		tools: [webSearchTool],
		reasoning: { effort: XAI_WEB_SEARCH_REASONING_EFFORT },
	};

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
	transport: XAIHttpTransport,
): Promise<Response> {
	return (params.fetch ?? fetch)(`${transport.baseURL.replace(/\/+$/, "")}/responses`, {
		method: "POST",
		headers: {
			...transport.headers,
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});
}

function throwXAIResponsesError(status: number, errorText: string): never {
	const classified = classifyProviderHttpError("xai", status, errorText);
	if (classified) throw classified;
	throw new SearchProviderError("xai", `xAI Responses API error (${status}): ${errorText}`, status);
}

async function callXAIResponses(
	apiKey: string,
	params: SearchParams,
	transport: XAIHttpTransport,
): Promise<XAIResponsesResponse> {
	const requestBody = buildRequestBody(params);
	const response = await postXAIResponses(apiKey, params, requestBody, transport);

	if (!response.ok) {
		throwXAIResponsesError(response.status, await response.text());
	}

	try {
		return (await response.json()) as XAIResponsesResponse;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new SearchProviderError("xai", `xAI Responses API returned invalid JSON: ${message}`, response.status);
	}
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
function extractSnippetAround(
	text: string | null | undefined,
	start: number | null | undefined,
	end: number | null | undefined,
): string | undefined {
	if (!text || typeof start !== "number" || typeof end !== "number") return undefined;
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text
		.slice(before, after)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
	if (!snippet) return undefined;
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function collectAnnotationSources(
	annotations: readonly XAIUrlCitationAnnotation[] | null | undefined,
	sources: SearchSource[],
	citations: SearchCitation[],
	seenUrls: Set<string>,
	contentText?: string | null,
): void {
	if (!Array.isArray(annotations)) return;
	for (const annotation of annotations) {
		if (!annotation || typeof annotation !== "object") continue;
		if (annotation.type !== "url_citation" || typeof annotation.url !== "string") continue;
		addCitationSource(
			sources,
			citations,
			seenUrls,
			annotation.url,
			annotation.title,
			annotation.cited_text ??
				annotation.text ??
				extractSnippetAround(contentText, annotation.start_index, annotation.end_index),
		);
	}
}

function collectWebSearchSources(
	item: XAIResponseOutputItem,
	sources: SearchSource[],
	citations: SearchCitation[],
	seenUrls: Set<string>,
): void {
	if (item.type !== "web_search_call") return;
	for (const group of [item.action?.sources, item.sources, item.results]) {
		if (!Array.isArray(group)) continue;
		for (const source of group) {
			if (!source || typeof source !== "object") continue;
			const url = source.url ?? source.source_website_url;
			if (typeof url !== "string") continue;
			addCitationSource(sources, citations, seenUrls, url, source.title ?? source.caption);
		}
	}
}

function parseAnswer(response: XAIResponsesResponse): string | undefined {
	const topLevelText = response.output_text?.trim();
	if (topLevelText) return topLevelText;

	const answerParts: string[] = [];
	const output = Array.isArray(response.output) ? response.output : [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const content = Array.isArray(item.content) ? item.content : [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = part.output_text ?? part.text;
			if (text?.trim()) answerParts.push(text.trim());
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
	const output = Array.isArray(response.output) ? response.output : [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		collectAnnotationSources(item.annotations, sources, citations, seenUrls);
		const content = Array.isArray(item.content) ? item.content : [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			collectAnnotationSources(part.annotations, sources, citations, seenUrls, part.output_text ?? part.text);
		}
	}
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		collectWebSearchSources(item, sources, citations, seenUrls);
	}
	const topLevelCitations = Array.isArray(response.citations) ? response.citations : [];
	for (const url of topLevelCitations) {
		if (typeof url !== "string") continue;
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

/**
 * Prefer `xai-oauth` only when its resolver cannot be shadowed by the shared
 * `XAI_API_KEY` fallback before reaching a lower-priority dedicated source.
 */
function shouldPreferXAIOAuth(authStorage: AuthStorage): boolean {
	if ($env.XAI_OAUTH_TOKEN) return true;

	const origin = authStorage.getCredentialOrigin("xai-oauth");
	if (!origin || origin.kind === "env") return false;
	if ((origin.kind === "api_key" || origin.kind === "fallback") && $env.XAI_API_KEY) return false;
	return true;
}

interface XAIWebSearchAuth {
	provider: XAIHttpProvider;
	keyOrResolver: ApiKey;
}

function resolveXAIWebSearchAuth(params: SearchParams): XAIWebSearchAuth {
	const xaiResolver = params.authStorage.resolver("xai", {
		sessionId: params.sessionId,
	});
	const xaiOAuthOrigin = params.authStorage.getCredentialOrigin("xai-oauth");
	if (!shouldPreferXAIOAuth(params.authStorage)) {
		return { provider: "xai", keyOrResolver: xaiResolver };
	}

	const xaiOAuthResolver = params.authStorage.resolver("xai-oauth", {
		sessionId: params.sessionId,
	});
	const keyOrResolver: ApiKeyResolver = async ctx => {
		const xaiOAuthKey = await xaiOAuthResolver(ctx);
		if (xaiOAuthKey) {
			const borrowedSharedEnvKey =
				xaiOAuthOrigin?.kind === "oauth" &&
				Boolean($env.XAI_API_KEY) &&
				xaiOAuthKey === $env.XAI_API_KEY &&
				xaiOAuthKey !== $env.XAI_OAUTH_TOKEN;
			if (!borrowedSharedEnvKey) return xaiOAuthKey;
		}
		return xaiResolver(ctx);
	};
	return { provider: "xai-oauth", keyOrResolver };
}

/** Execute xAI Responses API web search. */
export async function searchXAI(params: SearchParams): Promise<SearchResponse> {
	const auth = resolveXAIWebSearchAuth(params);
	const transport = params.modelRegistry
		? resolveXAIHttpTransport(params.modelRegistry, auth.provider, XAI_WEB_SEARCH_MODEL)
		: { baseURL: XAI_DEFAULT_BASE_URL };
	const customEndpoint = transport.baseURL.replace(/\/+$/, "") !== XAI_DEFAULT_BASE_URL;
	const credentialOrigin = params.authStorage.getCredentialOrigin(auth.provider);
	if (
		customEndpoint &&
		auth.provider === "xai-oauth" &&
		(credentialOrigin?.kind === "oauth" || credentialOrigin?.kind === "env")
	) {
		throw new SearchProviderError(
			"xai",
			`Refusing to send official xAI OAuth credentials to custom endpoint ${transport.baseURL}. Configure an API key for provider "xai-oauth".`,
		);
	}
	const keyOrResolver: ApiKey = customEndpoint
		? params.authStorage.resolver(auth.provider, { sessionId: params.sessionId })
		: auth.keyOrResolver;

	const resultCap = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const response = await withAuth(keyOrResolver, (key: string) => callXAIResponses(key, params, transport), {
		signal: params.signal,
		missingKeyMessage: 'xAI credentials not found. Set XAI_API_KEY or configure an API key for provider "xai".',
	});
	const parsed = parseResponse(response, resultCap);
	if (!parsed.answer && parsed.sources.length === 0) {
		throw new SearchProviderError("xai", "xAI web_search returned no answer or sources", 502);
	}
	return parsed;
}

/** Search provider for xAI web search. */
export class XAIProvider extends SearchProvider {
	readonly id = "xai";
	readonly label = "xAI";

	isAvailable(authStorage: AuthStorage): boolean {
		return shouldPreferXAIOAuth(authStorage) || authStorage.hasAuth("xai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchXAI(params);
	}
}
