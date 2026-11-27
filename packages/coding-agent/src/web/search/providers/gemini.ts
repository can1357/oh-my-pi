/**
 * Google Gemini Web Search Provider
 *
 * Uses Gemini's Google Search grounding via the Gemini Developer API; auth
 * uses the selected model's registry resolver.
 */
import { type Api, type AuthStorage, type FetchImpl, type Model, withAuth } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel, resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import { parseCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { type ConfiguredThinkingLevel } from "../../../utils/render-utils";
import { concreteThinkingLevel, toReasoningEffort } from "../../../thinking/levels";
import { fetchWithRetry, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";

import type { SearchCitation, SearchResponse, SearchSource } from "../types";
import type { ModelRegistry } from "../../../config/model-registry";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery, type StructuredQuery } from "../query";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;

interface GeminiDeveloperEndpoint {
	url: string;
	isCloudflareGateway: boolean;
}

function resolveGeminiDeveloperEndpoint(baseUrl: string): GeminiDeveloperEndpoint {
	const url = baseUrl.trim().replace(/\/+$/, "");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new SearchProviderError("gemini", `Gemini model base URL must be a valid absolute URL: ${baseUrl}`, 400);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new SearchProviderError("gemini", "Gemini model base URL must use HTTP or HTTPS", 400);
	}
	return {
		url,
		isCloudflareGateway: parsed.hostname === "gateway.ai.cloudflare.com",
	};
}

interface GeminiToolParams {
	google_search?: Record<string, unknown>;
	code_execution?: Record<string, unknown>;
	url_context?: Record<string, unknown>;
}

export interface GeminiSearchParams extends GeminiToolParams {
	query: string;
	/** Pre-parsed structured query; falls back to parsing `query` when omitted. */
	parsedQuery?: StructuredQuery;
	system_prompt?: string;
	num_results?: number;
	/** Maximum output tokens. */
	max_output_tokens?: number;
	/** Sampling temperature (0–1). Lower = more focused/factual. */
	temperature?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	authStorage: AuthStorage;
	model: Model<Api>;
	thinkingLevel?: ConfiguredThinkingLevel;
	modelRegistry: ModelRegistry;
	sessionId?: string;
	fetch?: FetchImpl;
}

export function buildGeminiRequestTools(params: GeminiToolParams): Array<Record<string, Record<string, unknown>>> {
	const tools: Array<Record<string, Record<string, unknown>>> = [{ googleSearch: params.google_search ?? {} }];
	if (params.code_execution !== undefined) {
		tools.push({ codeExecution: params.code_execution });
	}
	if (params.url_context !== undefined) {
		tools.push({ urlContext: params.url_context });
	}
	return tools;
}

interface GeminiSearchResult {
	answer: string;
	sources: SearchSource[];
	citations: SearchCitation[];
	searchQueries: string[];
	model: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** Gemini API response types */
interface GeminiGroundingChunk {
	web?: {
		uri?: string;
		title?: string;
	};
}

interface GeminiGroundingSupport {
	segment?: {
		startIndex?: number;
		endIndex?: number;
		text?: string;
	};
	groundingChunkIndices?: number[];
	confidenceScores?: number[];
}

interface GeminiGroundingMetadata {
	groundingChunks?: GeminiGroundingChunk[];
	groundingSupports?: GeminiGroundingSupport[];
	webSearchQueries?: string[];
}

interface GeminiModelResponse {
	candidates?: Array<{
		content?: {
			role: string;
			parts?: Array<{ text?: string }>;
		};
		finishReason?: string;
		groundingMetadata?: GeminiGroundingMetadata;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
	};
	modelVersion?: string;
}

async function parseGeminiSearchStream(
	body: ReadableStream<Uint8Array>,
	fallbackModel: string,
): Promise<GeminiSearchResult> {
	const answerParts: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const searchQueries: string[] = [];
	const seenUrls = new Set<string>();
	let model = fallbackModel;
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;

				const jsonStr = line.slice(5).trim();
				if (!jsonStr) continue;

				let responseData: GeminiModelResponse;
				try {
					responseData = JSON.parse(jsonStr) as GeminiModelResponse;
				} catch {
					continue;
				}

				const candidate = responseData.candidates?.[0];

				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text) {
							answerParts.push(part.text);
						}
					}
				}

				const groundingMetadata = candidate?.groundingMetadata;
				if (groundingMetadata) {
					if (groundingMetadata.groundingChunks) {
						for (const grChunk of groundingMetadata.groundingChunks) {
							if (grChunk.web?.uri) {
								const sourceUrl = grChunk.web.uri;
								if (!seenUrls.has(sourceUrl)) {
									seenUrls.add(sourceUrl);
									sources.push({
										title: grChunk.web.title ?? sourceUrl,
										url: sourceUrl,
									});
								}
							}
						}
					}

					if (groundingMetadata.groundingSupports && groundingMetadata.groundingChunks) {
						for (const support of groundingMetadata.groundingSupports) {
							const citedText = support.segment?.text;
							const chunkIndices = support.groundingChunkIndices ?? [];

							for (const idx of chunkIndices) {
								const grChunk = groundingMetadata.groundingChunks[idx];
								if (grChunk?.web?.uri) {
									citations.push({
										url: grChunk.web.uri,
										title: grChunk.web.title ?? grChunk.web.uri,
										citedText,
									});
								}
							}
						}
					}

					if (groundingMetadata.webSearchQueries) {
						for (const q of groundingMetadata.webSearchQueries) {
							if (!searchQueries.includes(q)) {
								searchQueries.push(q);
							}
						}
					}
				}

				if (responseData.usageMetadata) {
					usage = {
						inputTokens: responseData.usageMetadata.promptTokenCount ?? 0,
						outputTokens: responseData.usageMetadata.candidatesTokenCount ?? 0,
						totalTokens: responseData.usageMetadata.totalTokenCount ?? 0,
					};
				}

				if (responseData.modelVersion) {
					model = responseData.modelVersion;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return {
		answer: answerParts.join(""),
		sources,
		citations,
		searchQueries,
		model,
		usage,
	};
}

function isGroundingRedirectUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname === "vertexaisearch.cloud.google.com" && parsed.pathname.includes("/grounding-api-redirect")
		);
	} catch {
		return false;
	}
}

async function resolveGroundingRedirect(
	proxyUrl: string,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	try {
		const response = await (fetchImpl ?? fetch)(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: withHardTimeout(signal, 5000),
		});
		const location = response.headers.get("location");
		if (!location) return proxyUrl;
		const resolved = new URL(location, proxyUrl);
		return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : proxyUrl;
	} catch {
		return proxyUrl;
	}
}

async function finalizeGeminiSearchResult(
	result: GeminiSearchResult,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
): Promise<GeminiSearchResult> {
	if (!result.answer && result.sources.length === 0) {
		throw new SearchProviderError("gemini", "Gemini API returned an empty grounded response", 502);
	}

	const redirectUrls = new Set<string>();
	for (const source of result.sources) {
		if (isGroundingRedirectUrl(source.url)) redirectUrls.add(source.url);
	}
	for (const citation of result.citations) {
		if (isGroundingRedirectUrl(citation.url)) redirectUrls.add(citation.url);
	}
	if (redirectUrls.size === 0) return result;

	signal?.throwIfAborted();
	const resolvedEntries = await Promise.all(
		[...redirectUrls].map(async url => [url, await resolveGroundingRedirect(url, fetchImpl, signal)] as const),
	);
	signal?.throwIfAborted();
	const resolvedUrls = new Map(resolvedEntries);
	for (const source of result.sources) {
		source.url = resolvedUrls.get(source.url) ?? source.url;
	}
	for (const citation of result.citations) {
		citation.url = resolvedUrls.get(citation.url) ?? citation.url;
	}

	const seenUrls = new Set<string>();
	let writeIndex = 0;
	for (const source of result.sources) {
		if (seenUrls.has(source.url)) continue;
		seenUrls.add(source.url);
		result.sources[writeIndex++] = source;
	}
	result.sources.length = writeIndex;
	return result;
}

async function callGeminiDeveloperSearch(
	apiKey: string,
	endpoint: GeminiDeveloperEndpoint,
	configuredHeaders: Record<string, string> | undefined,
	model: string,
	query: string,
	systemPrompt: string | undefined,
	maxOutputTokens: number | undefined,
	temperature: number | undefined,
	toolParams: GeminiToolParams,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): Promise<GeminiSearchResult> {
	const normalizedSystemPrompt = systemPrompt?.toWellFormed();
	const requestBody: Record<string, unknown> = {
		contents: [
			{
				role: "user",
				parts: [{ text: query }],
			},
		],
		tools: buildGeminiRequestTools(toolParams),
		...(normalizedSystemPrompt && {
			systemInstruction: {
				parts: [{ text: normalizedSystemPrompt }],
			},
		}),
	};

	if (maxOutputTokens !== undefined || temperature !== undefined) {
		const generationConfig: Record<string, number> = {};
		if (maxOutputTokens !== undefined) {
			generationConfig.maxOutputTokens = maxOutputTokens;
		}
		if (temperature !== undefined) {
			generationConfig.temperature = temperature;
		}
		requestBody.generationConfig = generationConfig;
	}

	const response = await fetchWithRetry(() => `${endpoint.url}/models/${model}:streamGenerateContent?alt=sse`, {
		method: "POST",
		headers: {
			...configuredHeaders,
			...(endpoint.isCloudflareGateway
				? { "cf-aig-authorization": `Bearer ${apiKey}` }
				: { "x-goog-api-key": apiKey }),
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		body: JSON.stringify(requestBody),
		signal: withHardTimeout(signal, timeoutMs),
		fetch: fetchImpl,
		maxAttempts: MAX_RETRIES + 1,
		defaultDelayMs: attempt => BASE_DELAY_MS * 2 ** attempt,
		maxDelayMs: RATE_LIMIT_BUDGET_MS,
	});

	if (!response.ok) {
		const rawErrorText = await response.text();
		const errorText = apiKey ? rawErrorText.split(apiKey).join("[redacted]") : rawErrorText;
		const classified = classifyProviderHttpError("gemini", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"gemini",
			`Gemini Developer API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	if (!response.body) {
		throw new SearchProviderError("gemini", "Gemini API returned no response body", 500);
	}

	return finalizeGeminiSearchResult(await parseGeminiSearchStream(response.body, model), fetchImpl, signal);
}

/**
 * Executes a web search using Google Gemini with Google Search grounding.
 */
export async function searchGemini(params: GeminiSearchParams): Promise<SearchResponse> {
	// Clamp like chat does so an unsupported level (`:xhigh` on a high-capped
	// family) lands on the nearest routed tier instead of the default wire id.
	const selectedModel = resolveWireModelId(
		params.model,
		clampThinkingLevelForModel(params.model, toReasoningEffort(concreteThinkingLevel(params.thinkingLevel))),
	);
	// Gemini's googleSearch grounding forwards the query to Google Search, which
	// understands the classic operator set natively. Normalize directive aliases
	// (domain: → site:, since: → after:, …) to canonical Google forms; leave
	// directive-free queries byte-identical.
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const searchQuery = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;
	let result: GeminiSearchResult;

	if (params.model.api === "google-generative-ai") {
		const endpoint = resolveGeminiDeveloperEndpoint(params.model.baseUrl);
		const keyOrResolver = params.modelRegistry.resolver(params.model, params.sessionId);
		result = await withAuth(
			keyOrResolver,
			async storedApiKey => {
				const configuredHeaders = await params.modelRegistry.resolveModelHeaders(params.model, params.signal);
				const apiKey = endpoint.isCloudflareGateway ? parseCloudflareCredential(storedApiKey)?.token : storedApiKey;
				if (!apiKey) {
					throw new SearchProviderError("gemini", "Selected Gemini credential is empty", 401);
				}
				return callGeminiDeveloperSearch(
					apiKey,
					endpoint,
					configuredHeaders,
					selectedModel,
					searchQuery,
					params.system_prompt,
					params.max_output_tokens,
					params.temperature,
					{
						google_search: params.google_search,
						code_execution: params.code_execution,
						url_context: params.url_context,
					},
					params.fetch ?? wrapFetchForExtraCa(fetch),
					params.signal,
					params.timeoutMs,
				);
			},
			{
				signal: params.signal,
				missingKeyMessage: `No Gemini credentials found for selected provider "${params.model.provider}".`,
			},
		);
	} else {
		throw new SearchProviderError(
			"gemini",
			`Selected model ${params.model.provider}/${params.model.id} does not use a Gemini grounding transport`,
			400,
		);
	}

	let sources = result.sources;

	if (params.num_results && sources.length > params.num_results) {
		sources = sources.slice(0, params.num_results);
	}

	return {
		provider: "gemini",
		answer: result.answer || undefined,
		sources,
		citations: result.citations.length > 0 ? result.citations : undefined,
		searchQueries: result.searchQueries.length > 0 ? result.searchQueries : undefined,
		usage: result.usage,
		model: result.model,
	};
}

/** Search provider for Google Gemini web search. */
export class GeminiProvider extends SearchProvider {
	readonly id = "gemini";
	readonly label = "Gemini";

	isAvailable(authStorage: AuthStorage, model?: Model<Api>): boolean {
		if (model) {
			if (model.api === "google-generative-ai") return authStorage.keys.source(model.provider) !== undefined;
			return false;
		}
		return authStorage.keys.source("google") !== undefined;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchGemini({
			query: params.query,
			parsedQuery: params.parsedQuery,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
			max_output_tokens: params.maxOutputTokens,
			temperature: params.temperature,
			google_search: params.googleSearch,
			code_execution: params.codeExecution,
			url_context: params.urlContext,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			authStorage: params.authStorage,
			model: params.model,
			thinkingLevel: params.thinkingLevel,
			modelRegistry: params.modelRegistry,
			sessionId: params.sessionId,
			fetch: params.fetch,
		});
	}
}
