/**
 * Perplexity Web Search Provider
 *
 * Supports four auth modes:
 * - Cookies (`PERPLEXITY_COOKIES`) via `www.perplexity.ai/rest/sse/perplexity_ask`
 * - OAuth/session bearer via `AuthStorage` and `www.perplexity.ai/rest/sse/perplexity_ask`
 * - API key (`PERPLEXITY_API_KEY`) via `api.perplexity.ai/chat/completions`
 * - Anonymous via `www.perplexity.ai/rest/sse/perplexity_ask`
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthStorage,
	type Context,
	type FetchImpl,
	type Usage,
	withOAuthAccess,
} from "@pk-nerdsaver-ai/pi-ai";
import { streamOpenAICompletions } from "@pk-nerdsaver-ai/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@pk-nerdsaver-ai/pi-ai/providers/openai-responses";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import type { Model, ModelSpec } from "@pk-nerdsaver-ai/pi-catalog/types";
import { $env, readSseJson } from "@pk-nerdsaver-ai/pi-utils";
import type {
	PerplexityRequest,
	PerplexitySearchResult,
	SearchCitation,
	SearchResponse,
	SearchSource,
} from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { type ApiConfig, getAvailableAuthMethods } from "./perplexity-auth";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const PERPLEXITY_OAUTH_ASK_URL = "https://www.perplexity.ai/rest/sse/perplexity_ask";

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_NUM_SEARCH_RESULTS = 20;
const OAUTH_API_VERSION = "2.18";
const OAUTH_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const ANONYMOUS_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

interface PerplexityOAuthStreamMarkdownBlock {
	answer?: string;
	chunks?: string[];
	chunk_starting_offset?: number;
}
interface PerplexityOAuthStreamWebResult {
	name?: string;
	url?: string;
	snippet?: string;
	timestamp?: string;
}

interface PerplexityOAuthStreamWebResultBlock {
	web_results?: PerplexityOAuthStreamWebResult[];
}

interface PerplexityOAuthStreamBlock {
	intended_usage?: string;
	markdown_block?: PerplexityOAuthStreamMarkdownBlock;
	web_result_block?: PerplexityOAuthStreamWebResultBlock;
}

interface PerplexityOAuthStreamSource {
	title?: string;
	url?: string;
	snippet?: string;
	date?: string;
}

interface PerplexityOAuthStreamEvent {
	status?: string;
	final?: boolean;
	text?: string;
	blocks?: PerplexityOAuthStreamBlock[];
	sources_list?: PerplexityOAuthStreamSource[];
	error_code?: string;
	error_message?: string;
	display_model?: string;
	uuid?: string;
}

function mergeMarkdownBlock(
	existing: PerplexityOAuthStreamMarkdownBlock | undefined,
	incoming: PerplexityOAuthStreamMarkdownBlock,
): PerplexityOAuthStreamMarkdownBlock {
	if (!existing) return { ...incoming };

	const result: PerplexityOAuthStreamMarkdownBlock = { ...existing, ...incoming };
	if (incoming.chunks?.length) {
		const offset = incoming.chunk_starting_offset ?? 0;
		const existingChunks = existing.chunks ?? [];
		result.chunks = offset === 0 ? [...incoming.chunks] : [...existingChunks.slice(0, offset), ...incoming.chunks];
	}

	return result;
}

function mergeBlocks(
	existing: PerplexityOAuthStreamBlock[],
	incoming: PerplexityOAuthStreamBlock[],
): PerplexityOAuthStreamBlock[] {
	const blockMap = new Map<string, PerplexityOAuthStreamBlock>(
		existing
			.filter(block => typeof block.intended_usage === "string" && block.intended_usage.length > 0)
			.map(block => [block.intended_usage as string, block]),
	);

	for (const block of incoming) {
		if (!block.intended_usage) continue;
		const prev = blockMap.get(block.intended_usage);
		if (block.markdown_block) {
			blockMap.set(block.intended_usage, {
				...prev,
				...block,
				markdown_block: mergeMarkdownBlock(prev?.markdown_block, block.markdown_block),
			});
			continue;
		}

		blockMap.set(block.intended_usage, { ...prev, ...block });
	}

	return [...blockMap.values()];
}

function mergeOAuthEventSnapshot(
	existing: PerplexityOAuthStreamEvent,
	incoming: PerplexityOAuthStreamEvent,
): PerplexityOAuthStreamEvent {
	const merged: PerplexityOAuthStreamEvent = { ...existing, ...incoming };
	if (incoming.blocks && incoming.blocks.length > 0) {
		merged.blocks = mergeBlocks(existing.blocks ?? [], incoming.blocks);
	} else {
		merged.blocks = existing.blocks ?? [];
	}

	if (!merged.sources_list && existing.sources_list) {
		merged.sources_list = existing.sources_list;
	}

	return merged;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function parseJson(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function textFromChunks(value: unknown): string | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	let text = "";
	for (const chunk of value) {
		if (typeof chunk !== "string") return null;
		text += chunk;
	}
	return text.length > 0 ? text : null;
}

function textFromStructuredAnswer(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	for (const item of value) {
		const record = asRecord(item);
		if (!record) continue;
		const text = record.text;
		if (typeof text === "string" && text.length > 0) return text;
		const chunks = textFromChunks(record.chunks);
		if (chunks) return chunks;
	}
	return null;
}

function answerFromTextPayload(payload: Record<string, unknown>): string | null {
	const structured = textFromStructuredAnswer(payload.structured_answer);
	if (structured) return structured;
	const chunks = textFromChunks(payload.chunks);
	if (chunks) return chunks;
	const answer = payload.answer;
	return typeof answer === "string" && answer.length > 0 ? answer : null;
}

function parseOAuthTextPayload(text: string): Record<string, unknown> | null {
	const parsed = parseJson(text);
	const direct = asRecord(parsed);
	if (direct) return direct;
	if (!Array.isArray(parsed)) return null;

	for (const item of parsed) {
		const step = asRecord(item);
		const content = asRecord(step?.content);
		const answer = content?.answer;
		if (typeof answer !== "string" || answer.length === 0) continue;
		const payload = asRecord(parseJson(answer));
		if (payload) return payload;
	}
	return null;
}

function parseOAuthTextAnswer(text: string): string {
	const payload = parseOAuthTextPayload(text);
	if (payload) {
		const answer = answerFromTextPayload(payload);
		if (answer) return answer;
	}

	const parsed = parseJson(text);
	if (!Array.isArray(parsed)) return text;
	for (const item of parsed) {
		const step = asRecord(item);
		const content = asRecord(step?.content);
		const answer = content?.answer;
		if (typeof answer === "string" && answer.length > 0) return answer;
	}
	return text;
}

function sourcesFromTextPayload(text: string | undefined): SearchSource[] {
	if (!text) return [];
	const payload = parseOAuthTextPayload(text);
	const webResults = payload?.web_results;
	if (!Array.isArray(webResults) || webResults.length === 0) return [];

	const sources: SearchSource[] = [];
	for (const value of webResults) {
		const result = asRecord(value);
		if (!result) continue;
		const url = result.url;
		if (typeof url !== "string" || url.length === 0) continue;
		const name = result.name ?? result.title;
		const snippet = result.snippet;
		const timestamp = result.timestamp;
		sources.push({
			title: typeof name === "string" && name.length > 0 ? name : url,
			url,
			snippet: typeof snippet === "string" ? snippet : undefined,
			publishedDate: typeof timestamp === "string" ? timestamp : undefined,
			ageSeconds: dateToAgeSeconds(typeof timestamp === "string" ? timestamp : undefined),
		});
	}
	return sources;
}
export interface PerplexitySearchParams {
	signal?: AbortSignal;
	query: string;
	system_prompt?: string;
	search_recency_filter?: "hour" | "day" | "week" | "month" | "year";
	num_results?: number;
	/** Maximum output tokens. Defaults to 8192. */
	max_tokens?: number;
	/** Sampling temperature (0–1). Lower = more focused/factual. Defaults to 0.2. */
	temperature?: number;
	/** Number of search results to retrieve. Defaults to 20. */
	num_search_results?: number;
	authStorage: AuthStorage;
	sessionId?: string;
	fetch?: FetchImpl;
}

interface PerplexityApiStreamMetadata {
	id?: string;
	model?: string;
	citations?: unknown;
	search_results?: unknown;
	related_questions?: unknown;
}

function buildPerplexityCompletionsModel(config: ApiConfig, request: PerplexityRequest): Model<"openai-completions"> {
	const model = config.modelPrefix ? `${config.modelPrefix}${request.model}` : request.model;
	const spec: ModelSpec<"openai-completions"> = {
		id: model,
		name: model,
		api: "openai-completions",
		provider: config.provider,
		baseUrl: config.chatBaseUrl,
		reasoning: false,
		input: ["text"],
		supportsTools: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		compat: {
			supportsStore: false,
			supportsMultipleSystemMessages: true,
			supportsReasoningParams: false,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
		},
	};
	return buildModel(spec);
}

function buildPerplexityResponsesModel(config: ApiConfig, request: PerplexityRequest): Model<"openai-responses"> {
	const model = config.modelPrefix ? `${config.modelPrefix}${request.model}` : request.model;
	const spec: ModelSpec<"openai-responses"> = {
		id: model,
		name: model,
		api: "openai-responses",
		provider: config.provider,
		baseUrl: config.responsesBaseUrl,
		reasoning: false,
		input: ["text"],
		supportsTools: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		compat: {
			alwaysSendMaxTokens: true,
			supportsReasoningParams: false,
		},
	};
	return buildModel(spec);
}

function buildPerplexityContext(request: PerplexityRequest): Context {
	const systemPrompt: string[] = [];
	const messages: Context["messages"] = [];
	for (const message of request.messages) {
		if (typeof message.content !== "string" || message.content.length === 0) continue;
		if (message.role === "system") {
			systemPrompt.push(message.content);
			continue;
		}
		if (message.role === "user") {
			messages.push({ role: "user", content: message.content, timestamp: 0 });
		}
	}
	return { systemPrompt: systemPrompt.length > 0 ? systemPrompt : undefined, messages };
}

function buildPerplexityExtraBody(request: PerplexityRequest): Record<string, unknown> {
	return {
		search_mode: request.search_mode,
		num_search_results: request.num_search_results,
		web_search_options: request.web_search_options,
		enable_search_classifier: request.enable_search_classifier,
		reasoning_effort: request.reasoning_effort,
		language_preference: request.language_preference,
		return_related_questions: request.return_related_questions,
		search_recency_filter: request.search_recency_filter,
	};
}

function applyPerplexityExtraBody(payload: unknown, request: PerplexityRequest): void {
	const record = asRecord(payload);
	if (!record) return;
	Object.assign(record, buildPerplexityExtraBody(request));
}

function collectPerplexityOutputMetadata(metadata: PerplexityApiStreamMetadata, output: unknown): void {
	if (!Array.isArray(output)) return;
	for (const item of output) {
		const record = asRecord(item);
		if (!record) continue;
		if (Array.isArray(record.search_results)) metadata.search_results = record.search_results;
		if (Array.isArray(record.results)) metadata.search_results = record.results;
		if (Array.isArray(record.citations)) metadata.citations = record.citations;
		if (Array.isArray(record.related_questions)) metadata.related_questions = record.related_questions;
		collectPerplexityOutputMetadata(metadata, record.content);
	}
}

function collectPerplexityMetadataFromRecord(
	metadata: PerplexityApiStreamMetadata,
	record: Record<string, unknown>,
): void {
	const id = record.id;
	if (typeof id === "string" && id.length > 0) metadata.id = id;
	const model = record.model;
	if (typeof model === "string" && model.length > 0) metadata.model = model;
	if (Array.isArray(record.citations)) metadata.citations = record.citations;
	if (Array.isArray(record.search_results)) metadata.search_results = record.search_results;
	if (Array.isArray(record.related_questions)) metadata.related_questions = record.related_questions;
	if (Array.isArray(record.results)) metadata.search_results = record.results;
	collectPerplexityOutputMetadata(metadata, record.output);
	const response = asRecord(record.response);
	if (response) {
		collectPerplexityOutputMetadata(metadata, response.output);
		collectPerplexityMetadataFromRecord(metadata, response);
	}
}

function collectPerplexityMetadata(metadata: PerplexityApiStreamMetadata, data: string): void {
	if (data === "[DONE]") return;
	const record = asRecord(parseJson(data));
	if (record) collectPerplexityMetadataFromRecord(metadata, record);
}

async function drainAssistantStream(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
	let finalMessage: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "done") {
			finalMessage = event.message;
		} else if (event.type === "error") {
			finalMessage = event.error;
		}
	}
	return finalMessage ?? stream.result();
}

function throwPerplexityStreamError(message: AssistantMessage): never {
	const status = message.errorStatus ?? 500;
	const details = message.errorMessage ?? "Perplexity API stream failed";
	const classified = classifyProviderHttpError("perplexity", status, details);
	if (classified) throw classified;
	throw new SearchProviderError("perplexity", `Perplexity API error (${status}): ${details}`, status);
}

/** Call Perplexity API-key endpoint (or OpenRouter) through the shared OpenAI streaming providers. */
async function callPerplexityApi(
	config: ApiConfig,
	request: PerplexityRequest,
	fetchImpl: FetchImpl | undefined,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const metadata: PerplexityApiStreamMetadata = {};
	const context = buildPerplexityContext(request);
	const requestSignal = withHardTimeout(signal);
	const onSseEvent = (event: { data: string }): void => {
		collectPerplexityMetadata(metadata, event.data);
	};

	const message = config.useResponses
		? await drainAssistantStream(
				streamOpenAIResponses(buildPerplexityResponsesModel(config, request), context, {
					apiKey: config.apiKey,
					maxTokens: request.max_tokens ?? undefined,
					temperature: request.temperature ?? undefined,
					signal: requestSignal,
					fetch: fetchImpl,
					extraBody: buildPerplexityExtraBody(request),
					onSseEvent,
				}),
			)
		: await drainAssistantStream(
				streamOpenAICompletions(buildPerplexityCompletionsModel(config, request), context, {
					apiKey: config.apiKey,
					maxTokens: request.max_tokens ?? undefined,
					temperature: request.temperature ?? undefined,
					signal: requestSignal,
					fetch: fetchImpl,
					onPayload: payload => applyPerplexityExtraBody(payload, request),
					onSseEvent,
				}),
			);

	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throwPerplexityStreamError(message);
	}

	return parseStreamedApiResponse(message, metadata);
}

function buildOAuthSources(event: PerplexityOAuthStreamEvent): SearchSource[] {
	const results =
		event.blocks?.find(block => block.intended_usage === "web_results")?.web_result_block?.web_results ?? [];

	if (results.length > 0) {
		return results
			.filter(result => typeof result.url === "string" && result.url.length > 0)
			.map(result => ({
				title: result.name ?? result.url ?? "",
				url: result.url ?? "",
				snippet: result.snippet,
				publishedDate: result.timestamp,
				ageSeconds: dateToAgeSeconds(result.timestamp),
			}));
	}

	const sources = (event.sources_list ?? [])
		.filter(source => typeof source.url === "string" && source.url.length > 0)
		.map(source => ({
			title: source.title ?? source.url ?? "",
			url: source.url ?? "",
			snippet: source.snippet,
			publishedDate: source.date,
			ageSeconds: dateToAgeSeconds(source.date),
		}));
	if (sources.length > 0) return sources;
	return sourcesFromTextPayload(event.text);
}

function buildOAuthAnswer(event: PerplexityOAuthStreamEvent): string {
	if (!event.blocks?.length) {
		return typeof event.text === "string" ? parseOAuthTextAnswer(event.text) : "";
	}

	const markdownBlock = event.blocks.find(
		block => block.intended_usage?.includes("markdown") && block.markdown_block,
	)?.markdown_block;
	if (markdownBlock) {
		if (Array.isArray(markdownBlock.chunks) && markdownBlock.chunks.length > 0) {
			return markdownBlock.chunks.join("");
		}
		if (typeof markdownBlock.answer === "string" && markdownBlock.answer.length > 0) {
			return markdownBlock.answer;
		}
	}

	const textBlock = event.blocks.find(
		block => block.intended_usage === "ask_text" && block.markdown_block,
	)?.markdown_block;
	if (textBlock) {
		if (Array.isArray(textBlock.chunks) && textBlock.chunks.length > 0) {
			return textBlock.chunks.join("");
		}
		if (typeof textBlock.answer === "string" && textBlock.answer.length > 0) {
			return textBlock.answer;
		}
	}
	if (typeof event.text === "string" && event.text.length > 0) {
		return parseOAuthTextAnswer(event.text);
	}
	return "";
}

async function callPerplexityAsk(
	auth: { type: "oauth"; token: string } | { type: "cookies"; cookies: string } | { type: "anonymous" },
	params: PerplexitySearchParams,
): Promise<{ answer: string; sources: SearchSource[]; model?: string; requestId?: string }> {
	const requestId = crypto.randomUUID();
	// The consumer `perplexity_ask` endpoint is itself a research assistant and
	// has no system-message slot. Prepending the API-style system prompt to the
	// query makes the model read it as a meta-instruction and refuse with
	// "I don't have access to web-search tools in this turn", so ask-endpoint
	// searches send the bare query. (The API-key path still uses system_prompt
	// as a proper `system` message.)
	const effectiveQuery = params.query;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		Origin: "https://www.perplexity.ai",
		Referer: "https://www.perplexity.ai/",
		"User-Agent": auth.type === "anonymous" ? ANONYMOUS_USER_AGENT : OAUTH_USER_AGENT,
		"X-Request-ID": requestId,
	};
	if (auth.type === "oauth") {
		// The ask endpoint authenticates via the next-auth session cookie, NOT a
		// bearer header — a bearer (even a garbage one) is ignored and the request
		// silently falls back to the anonymous free `turbo` model regardless of
		// `model_preference`. The stored OAuth token IS the Perplexity session JWT
		// (the native app injects the same value as this cookie), so sending it as
		// the cookie is what unlocks the account's Pro model selection.
		headers.Cookie = `__Secure-next-auth.session-token=${auth.token}`;
	} else if (auth.type === "cookies") {
		headers.Cookie = auth.cookies;
	}
	if (auth.type !== "anonymous") {
		headers["X-App-ApiClient"] = "default";
		headers["X-App-ApiVersion"] = OAUTH_API_VERSION;
		headers["X-Perplexity-Request-Reason"] = "submit";
	}

	const requestParams: Record<string, unknown> = {
		query_str: effectiveQuery,
		search_focus: "internet",
		mode: "copilot",
		model_preference: "experimental",
		sources: ["web"],
		attachments: [],
		frontend_uuid: crypto.randomUUID(),
		frontend_context_uuid: crypto.randomUUID(),
		version: OAUTH_API_VERSION,
		language: "en-US",
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		search_recency_filter: params.search_recency_filter ?? null,
		is_incognito: true,
		use_schematized_api: true,
		skip_search_enabled: true,
	};
	if (auth.type === "anonymous") {
		requestParams.send_back_text_in_streaming_api = true;
		requestParams.source = "default";
	}

	const response = await (params.fetch ?? fetch)(PERPLEXITY_OAUTH_ASK_URL, {
		method: "POST",
		headers,
		body: JSON.stringify({
			query_str: effectiveQuery,
			params: requestParams,
		}),
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("perplexity", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"perplexity",
			`Perplexity ask API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	if (!response.body) {
		throw new SearchProviderError("perplexity", "Perplexity ask API returned no response body", 500);
	}

	let answer = "";
	let model: string | undefined;
	let finalRequestId: string | undefined;
	const sourcesByUrl = new Map<string, SearchSource>();
	let mergedEvent: PerplexityOAuthStreamEvent = { blocks: [] };

	for await (const event of readSseJson<PerplexityOAuthStreamEvent>(response.body, params.signal)) {
		if (event.error_code) {
			const message = event.error_message ?? event.error_code;
			throw new SearchProviderError("perplexity", `Perplexity ask stream error: ${message}`, 400);
		}

		mergedEvent = mergeOAuthEventSnapshot(mergedEvent, event);

		const eventAnswer = buildOAuthAnswer(mergedEvent);
		if (eventAnswer.length > 0) {
			answer = eventAnswer;
		}

		for (const source of buildOAuthSources(mergedEvent)) {
			sourcesByUrl.set(source.url, source);
		}

		if (mergedEvent.display_model) model = mergedEvent.display_model;
		if (mergedEvent.uuid) finalRequestId = mergedEvent.uuid;
		if (mergedEvent.final || mergedEvent.status === "COMPLETED") {
			break;
		}
	}

	return {
		answer,
		sources: [...sourcesByUrl.values()],
		model,
		requestId: finalRequestId ?? requestId,
	};
}

function assistantText(message: AssistantMessage): string {
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

function isPerplexitySearchResult(value: unknown): value is PerplexitySearchResult {
	const record = asRecord(value);
	return typeof record?.url === "string" && record.url.length > 0;
}

function searchResultsFromMetadata(metadata: PerplexityApiStreamMetadata): PerplexitySearchResult[] {
	return Array.isArray(metadata.search_results) ? metadata.search_results.filter(isPerplexitySearchResult) : [];
}

function citationUrlsFromMetadata(metadata: PerplexityApiStreamMetadata): string[] {
	return Array.isArray(metadata.citations)
		? metadata.citations.filter((url): url is string => typeof url === "string" && url.length > 0)
		: [];
}

function relatedQuestionsFromMetadata(metadata: PerplexityApiStreamMetadata): string[] {
	return Array.isArray(metadata.related_questions)
		? metadata.related_questions.filter(
				(question): question is string => typeof question === "string" && question.trim().length > 0,
			)
		: [];
}

function buildApiSources(metadata: PerplexityApiStreamMetadata): {
	sources: SearchSource[];
	citations: SearchCitation[];
} {
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const searchResults = searchResultsFromMetadata(metadata);
	const citationUrls = citationUrlsFromMetadata(metadata);

	if (citationUrls.length > 0) {
		for (const url of citationUrls) {
			const searchResult = searchResults.find(result => result.url === url);
			sources.push({
				title: searchResult?.title ?? url,
				url,
				snippet: searchResult?.snippet,
				publishedDate: searchResult?.date ?? undefined,
				ageSeconds: dateToAgeSeconds(searchResult?.date),
			});
			citations.push({ url, title: searchResult?.title ?? url });
		}
	} else {
		for (const searchResult of searchResults) {
			sources.push({
				title: searchResult.title ?? searchResult.url,
				url: searchResult.url,
				snippet: searchResult.snippet,
				publishedDate: searchResult.date ?? undefined,
				ageSeconds: dateToAgeSeconds(searchResult.date),
			});
		}
	}

	return { sources, citations };
}

function usageFromAssistant(usage: Usage): SearchResponse["usage"] | undefined {
	if (usage.input === 0 && usage.output === 0 && usage.totalTokens === 0) return undefined;
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		totalTokens: usage.totalTokens,
	};
}

function parseStreamedApiResponse(message: AssistantMessage, metadata: PerplexityApiStreamMetadata): SearchResponse {
	const { sources, citations } = buildApiSources(metadata);
	const relatedQuestions = relatedQuestionsFromMetadata(metadata);
	const answer = assistantText(message);

	return {
		provider: "perplexity",
		answer: answer || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		relatedQuestions: relatedQuestions.length > 0 ? relatedQuestions : undefined,
		usage: usageFromAssistant(message.usage),
		model: metadata.model ?? message.model,
		requestId: metadata.id ?? message.responseId,
	};
}

function applySourceLimit(result: SearchResponse, limit?: number): SearchResponse {
	if (limit && result.sources.length > limit) {
		result.sources = result.sources.slice(0, limit);
	}
	return result;
}

/** Execute Perplexity web search */
export async function searchPerplexity(params: PerplexitySearchParams): Promise<SearchResponse> {
	const systemPrompt = params.system_prompt;
	const messages: PerplexityRequest["messages"] = [];
	if (systemPrompt) {
		messages.push({ role: "system", content: systemPrompt });
	}
	messages.push({ role: "user", content: params.query });

	const request: PerplexityRequest = {
		model: "sonar-pro",
		messages,
		max_tokens: params.max_tokens ?? DEFAULT_MAX_TOKENS,
		temperature: params.temperature ?? DEFAULT_TEMPERATURE,
		search_mode: "web",
		num_search_results: params.num_search_results ?? DEFAULT_NUM_SEARCH_RESULTS,
		web_search_options: {
			search_type: "pro",
			search_context_size: "high",
		},
		enable_search_classifier: true,
		reasoning_effort: "medium",
		language_preference: "en",
		return_related_questions: true,
	};

	if (params.search_recency_filter) {
		request.search_recency_filter = params.search_recency_filter;
	}

	const authMethods = await getAvailableAuthMethods(params.authStorage, params.sessionId, { signal: params.signal });
	let lastError: unknown;

	for (const auth of authMethods) {
		if (auth.type === "api_key") {
			try {
				const result = await callPerplexityApi(auth, request, params.fetch, params.signal);
				result.authMode = "api_key";
				return applySourceLimit(result, params.num_results);
			} catch (error) {
				if (params.signal?.aborted) throw error;
				lastError = error;
			}
		} else {
			// Use OAuth/cookies/anonymous path
			try {
				const askResult =
					auth.type === "oauth"
						? await withOAuthAccess(
								params.authStorage,
								"perplexity",
								access => callPerplexityAsk({ type: "oauth", token: access.accessToken }, params),
								{ sessionId: params.sessionId, signal: params.signal, seed: auth.access },
							)
						: await callPerplexityAsk(auth, params);
				return applySourceLimit(
					{
						provider: "perplexity",
						answer: askResult.answer || undefined,
						sources: askResult.sources,
						model: askResult.model,
						requestId: askResult.requestId,
						authMode: auth.type === "anonymous" ? "anonymous" : "oauth",
					},
					params.num_results,
				);
			} catch (error) {
				if (params.signal?.aborted) throw error;
				lastError = error;
			}
		}
	}

	if (lastError) throw lastError;
	throw new SearchProviderError("perplexity", "No authentication method available.", 401);
}

/** Search provider for Perplexity. */
export class PerplexityProvider extends SearchProvider {
	readonly id = "perplexity";
	readonly label = "Perplexity";

	/**
	 * Auto-chain admission. Requires a direct Perplexity credential
	 * (`PERPLEXITY_COOKIES`, OAuth session, or `PERPLEXITY_API_KEY`).
	 *
	 * OpenRouter auth is intentionally NOT accepted here: silently using
	 * OpenRouter's `perplexity/sonar-pro` whenever any OpenRouter key is
	 * configured surprises users (and bills them) for a path they never
	 * asked for. The auto chain skips Perplexity in that case and falls
	 * through to the next configured provider. Users who DO want the
	 * OpenRouter-backed Perplexity path can still opt in by setting
	 * `webSearch: perplexity` explicitly — see {@link isExplicitlyAvailable}.
	 */
	isAvailable(authStorage: AuthStorage): boolean {
		return !!$env.PERPLEXITY_COOKIES?.trim() || authStorage.hasAuth("perplexity");
	}

	/**
	 * Perplexity accepts anonymous browser-style ask requests, and the
	 * OpenRouter-backed `perplexity/sonar-pro` path is opt-in through
	 * explicit selection. Keep auto-chain admission credential-gated so a
	 * configured provider keeps priority over the anonymous/OpenRouter
	 * fallbacks.
	 */
	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPerplexity({
			signal: params.signal,
			query: params.query,
			temperature: params.temperature,
			max_tokens: params.maxOutputTokens,
			num_search_results: params.numSearchResults,
			system_prompt: params.systemPrompt,
			search_recency_filter: params.recency,
			num_results: params.limit,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: params.fetch,
		});
	}
}
