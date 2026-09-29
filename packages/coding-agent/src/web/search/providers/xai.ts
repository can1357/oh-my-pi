import { type Api, type AuthStorage, type Model, withAuth } from "@oh-my-pi/pi-ai";
import { resolveXaiBaseUrl, XAI_DEFAULT_BASE_URL } from "@oh-my-pi/pi-ai/providers/xai-base-url";
import type { XAIHttpTransport } from "../../../lib/xai-http";
import type { SearchCitation, SearchResponse, SearchSource, SearchUsage } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

// xAI web search is latency-sensitive, so keep reasoning effort low regardless
// of the selected model's configured timeout.
const XAI_WEB_SEARCH_REASONING_EFFORT = "low";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 30;
/** Messages at least this long are treated as substantive content, not relay narration. */
const SUBSTANTIVE_MIN_CHARS = 300;

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
	phase?: "commentary" | "final_answer" | null;
	content?: XAIResponseContentPart[] | null;
	annotations?: XAIUrlCitationAnnotation[] | null;
	action?: Record<string, unknown> | null;
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

/** xAI x_search accepts at most 20 handles on an allow or exclude list. */
const MAX_X_HANDLES = 20;

function assertIsoDate(value: string, field: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new SearchProviderError("xai", `${field} must be YYYY-MM-DD (got ${JSON.stringify(value)})`, 400);
	}
	const [year, month, day] = value.split("-").map(Number);
	const utc = new Date(Date.UTC(year, month - 1, day));
	if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
		throw new SearchProviderError("xai", `${field} must be YYYY-MM-DD (got ${JSON.stringify(value)})`, 400);
	}
	return value;
}

function normalizeHandles(handles: readonly string[] | undefined, field: string): string[] {
	const cleaned: string[] = [];
	const seen = new Set<string>();
	for (const raw of handles ?? []) {
		const handle = raw.trim().replace(/^@+/, "");
		if (!handle) continue;
		const key = handle.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		cleaned.push(handle);
		if (cleaned.length > MAX_X_HANDLES) {
			throw new SearchProviderError("xai", `${field} accepts at most ${MAX_X_HANDLES} handles`, 400);
		}
	}
	return cleaned;
}

function xSearchHasNarrowingFilters(params: SearchParams): boolean {
	const spec = params.xSearch;
	if (!spec) return false;
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const hasHandle = (handles: readonly string[] | undefined) =>
		handles?.some(handle => handle.trim().replace(/^@+/, "")) ?? false;
	return (
		hasHandle(spec.allowedHandles) ||
		hasHandle(spec.excludedHandles) ||
		Boolean(spec.fromDate?.trim() || spec.toDate?.trim() || parsed.after || parsed.before)
	);
}

function buildXSearchRequestBody(params: SearchParams): Record<string, unknown> {
	const spec = params.xSearch;
	if (!spec) throw new SearchProviderError("xai", "x_search options missing", 400);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const allowed = normalizeHandles(spec.allowedHandles, "allowed_x_handles");
	const excluded = normalizeHandles(spec.excludedHandles, "excluded_x_handles");
	if (allowed.length > 0 && excluded.length > 0) {
		throw new SearchProviderError("xai", "allowed_x_handles and excluded_x_handles cannot be used together", 400);
	}
	const fromDate = spec.fromDate?.trim() || parsed.after;
	const toDate = spec.toDate?.trim() || parsed.before;
	if (fromDate) assertIsoDate(fromDate, "from_date");
	if (toDate) assertIsoDate(toDate, "to_date");
	if (fromDate && toDate && fromDate > toDate) {
		throw new SearchProviderError("xai", "from_date must be on or before to_date", 400);
	}
	if (fromDate && fromDate > new Date().toISOString().slice(0, 10)) {
		throw new SearchProviderError("xai", "from_date must not be after today (UTC)", 400);
	}

	const tool: Record<string, unknown> = { type: "x_search" };
	if (allowed.length > 0) tool.allowed_x_handles = allowed;
	else if (excluded.length > 0) tool.excluded_x_handles = excluded;
	if (fromDate) tool.from_date = fromDate;
	if (toDate) tool.to_date = toDate;
	if (spec.enableImageUnderstanding) tool.enable_image_understanding = true;
	if (spec.enableVideoUnderstanding) tool.enable_video_understanding = true;

	// Dates are tool fields; x_search has no domain filter, so `site:` and
	// friends degrade to plain terms rather than literal syntax on the wire.
	const query = parsed.hasDirectives ? formatQuery(parsed, { ...XAI_QUERY_SYNTAX, dateRange: false }) : params.query;
	const body: Record<string, unknown> = {
		model: params.model.id,
		input: [
			{ role: "system", content: params.systemPrompt },
			{ role: "user", content: query },
		],
		tools: [tool],
		reasoning: { effort: XAI_WEB_SEARCH_REASONING_EFFORT },
		store: false,
	};
	if (params.maxOutputTokens !== undefined) body.max_output_tokens = params.maxOutputTokens;
	if (params.temperature !== undefined) body.temperature = params.temperature;
	return body;
}

function buildRequestBody(params: SearchParams): Record<string, unknown> {
	if (params.xSearch) return buildXSearchRequestBody(params);
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
		model: params.model.id,
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
		// x_search emits bare index labels ("1","2",…) as titles, not real titles.
		const title =
			typeof annotation.title === "string" && !/^\d+$/.test(annotation.title.trim()) ? annotation.title : undefined;
		addCitationSource(
			sources,
			citations,
			seenUrls,
			annotation.url,
			title,
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
	if (item.type !== "web_search_call" && item.type !== "x_search_call") return;
	const groups: unknown[] = [item.sources, item.results];
	if (item.action && typeof item.action === "object") {
		for (const value of Object.values(item.action)) groups.push(value);
	}
	for (const group of groups) {
		if (!Array.isArray(group)) continue;
		for (const source of group) {
			if (!source || typeof source !== "object") continue;
			const record = source as XAIWebSearchSource;
			const url = record.url ?? record.source_website_url;
			if (typeof url !== "string") continue;
			// x_search labels sources "1","2",… — index citations, not titles.
			const rawTitle = record.title ?? record.caption;
			const title = rawTitle && !/^\d+$/.test(rawTitle.trim()) ? rawTitle : undefined;
			addCitationSource(sources, citations, seenUrls, url, title);
		}
	}
}

function parseAnswer(response: XAIResponsesResponse): string | undefined {
	const output = Array.isArray(response.output) ? response.output : [];
	// A top-level aggregate can contain narration even without explicit phases.
	// Prefer filtered messages; use the aggregate only when no messages exist.

	// Explicit phases take precedence. Unphased relay messages use the last
	// message/citation/length heuristic; keep commentary positions so removing
	// one cannot promote preceding unphased narration into a final answer.
	const messages: Array<{ texts: string[]; hasCitations: boolean; phase: XAIResponseOutputItem["phase"] }> = [];
	for (const item of output) {
		if (!item || typeof item !== "object" || (item.type != null && item.type !== "message")) continue;
		const content = Array.isArray(item.content) ? item.content : null;
		if (content === null && item.type == null) continue;
		// Relays cast external JSON into the typed interface; normalize the
		// phase to a recognized value so "" or unknown strings cannot strand a
		// message outside both the final_answer branch and the unphased
		// heuristic.
		const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : null;
		const entry = { texts: [] as string[], hasCitations: false, phase };
		for (const part of content ?? []) {
			if (!part || typeof part !== "object") continue;
			const text = (part.output_text ?? part.text)?.trim();
			if (text) entry.texts.push(text);
			for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
				if (annotation?.type === "url_citation" && typeof annotation.url === "string" && annotation.url.trim()) {
					entry.hasCitations = true;
					break;
				}
			}
		}
		for (const annotation of Array.isArray(item.annotations) ? item.annotations : []) {
			if (annotation?.type === "url_citation" && typeof annotation.url === "string" && annotation.url.trim()) {
				entry.hasCitations = true;
				break;
			}
		}
		messages.push(entry);
	}
	const hasFinalAnswerContent = messages.some(m => m.phase === "final_answer" && m.texts.length > 0);
	if (!hasFinalAnswerContent) {
		// A tagged-but-empty final is authoritative: the relay uses the phase
		// protocol and produced no answer, so the aggregate — which mixes the
		// narration in — must not be promoted either.
		if (messages.some(m => m.phase === "final_answer")) return undefined;
		// Without authoritative phased content, an empty final message means
		// no answer — do not promote heuristic-kept earlier content.
		const lastMessage = messages.at(-1);
		if (!lastMessage) return response.output_text?.trim() || undefined;
		if (lastMessage.texts.length === 0 && lastMessage.phase !== "commentary") return undefined;
	}
	const kept = hasFinalAnswerContent
		? messages.filter(entry => entry.phase === "final_answer")
		: messages.filter(
				(entry, index) =>
					entry.phase == null &&
					(index === messages.length - 1 ||
						entry.hasCitations ||
						entry.texts.join("").length >= SUBSTANTIVE_MIN_CHARS),
			);

	const answer = kept
		.flatMap(entry => entry.texts)
		.join("\n")
		.trim();
	return answer || undefined;
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

function parseResponse(
	response: XAIResponsesResponse,
	resultCap: number,
	authMode: "api_key" | "oauth",
): SearchResponse {
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
		authMode,
	};
}

/** Execute xAI Responses API web search. */
export async function searchXAI(params: SearchParams): Promise<SearchResponse> {
	if (params.model.provider !== "xai" && params.model.provider !== "xai-oauth") {
		throw new SearchProviderError(
			"xai",
			`Selected model ${params.model.provider}/${params.model.id} is not an xAI model`,
			400,
		);
	}
	const transport: XAIHttpTransport = {
		baseURL: params.model.baseUrl,
		headers: await params.modelRegistry.resolveModelHeaders(params.model, params.signal),
	};
	const customEndpoint = transport.baseURL.replace(/\/+$/, "") !== XAI_DEFAULT_BASE_URL;
	const credentialOrigin = params.authStorage.keys.source(params.model.provider);
	const hasCommandBackedKey = params.modelRegistry.hasCommandBackedApiKey(params.model.provider);
	const officialOAuthCredential =
		params.model.provider === "xai-oauth" &&
		!hasCommandBackedKey &&
		(credentialOrigin?.kind === "oauth" || credentialOrigin?.kind === "env");
	if (customEndpoint && officialOAuthCredential) {
		throw new SearchProviderError(
			"xai",
			`Refusing to send official xAI OAuth credentials to custom endpoint ${transport.baseURL}. Configure an API key for provider "xai-oauth".`,
		);
	}
	const keyOrResolver = params.modelRegistry.resolver(params.model, params.sessionId);
	const resultCap = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const response = await withAuth(
		keyOrResolver,
		async key => {
			const requestTransport: XAIHttpTransport = {
				// XAI_BASE_URL never receives official OAuth credentials: neither an OAuth-origin
				// credential nor an OAuth access-token bearer leaves the bundled endpoint.
				baseURL: officialOAuthCredential
					? params.model.baseUrl
					: (resolveXaiBaseUrl(params.model.provider, params.model.baseUrl, key) ?? params.model.baseUrl),
				headers: await params.modelRegistry.resolveModelHeaders(params.model, params.signal),
			};
			return callXAIResponses(key, params, requestTransport);
		},
		{
			signal: params.signal,
			missingKeyMessage: `xAI credentials not found for selected provider "${params.model.provider}".`,
		},
	);
	const authMode =
		params.model.provider === "xai-oauth" && (credentialOrigin?.kind === "oauth" || credentialOrigin?.kind === "env")
			? "oauth"
			: "api_key";
	const parsed = parseResponse(response, resultCap, authMode);
	if (params.xSearch && xSearchHasNarrowingFilters(params) && parsed.sources.length === 0) {
		parsed.degraded = true;
	}
	if (!parsed.answer && parsed.sources.length === 0) {
		const tool = params.xSearch ? "x_search" : "web_search";
		throw new SearchProviderError("xai", `xAI ${tool} returned no answer or sources`, 502);
	}
	return parsed;
}

/** Search provider for xAI web search. */
export class XAIProvider extends SearchProvider {
	readonly id = "xai";
	readonly label = "xAI";

	isAvailable(authStorage: AuthStorage, model?: Model<Api>): boolean {
		return authStorage.keys.source(model?.provider ?? "xai") !== undefined;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchXAI(params);
	}
}
