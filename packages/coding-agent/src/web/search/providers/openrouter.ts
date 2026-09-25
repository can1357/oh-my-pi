import { type Api, type AuthStorage, type Model, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchCitation, SearchResponse, SearchSource, SearchUsage } from "../types";
import { asRecord } from "@oh-my-pi/pi-utils";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 5;

interface OpenRouterUrlCitation {
	url?: string;
	title?: string;
	content?: string;
}

interface OpenRouterAnnotation {
	type?: string;
	url_citation?: OpenRouterUrlCitation;
}

interface OpenRouterContentPart {
	type?: string;
	text?: string;
}

interface OpenRouterMessage {
	content?: string | OpenRouterContentPart[];
	annotations?: OpenRouterAnnotation[];
}

interface OpenRouterResponse {
	id?: string;
	model?: string;
	choices?: Array<{ message?: OpenRouterMessage }>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
	return value === undefined || typeof value === "number";
}

function isOpenRouterContentPart(value: unknown): value is OpenRouterContentPart {
	const part = asRecord(value);
	return part !== null && isOptionalString(part.type) && isOptionalString(part.text);
}

function isOpenRouterUrlCitation(value: unknown): value is OpenRouterUrlCitation {
	const citation = asRecord(value);
	return (
		citation !== null &&
		isOptionalString(citation.url) &&
		isOptionalString(citation.title) &&
		isOptionalString(citation.content)
	);
}

function isOpenRouterAnnotation(value: unknown): value is OpenRouterAnnotation {
	const annotation = asRecord(value);
	return (
		annotation !== null &&
		isOptionalString(annotation.type) &&
		(annotation.url_citation === undefined || isOpenRouterUrlCitation(annotation.url_citation))
	);
}

function isOpenRouterMessage(value: unknown): value is OpenRouterMessage {
	const message = asRecord(value);
	if (message === null || !isOptionalString(message.content)) {
		if (message === null || !Array.isArray(message.content) || !message.content.every(isOpenRouterContentPart)) {
			return false;
		}
	}
	return (
		message.annotations === undefined ||
		(Array.isArray(message.annotations) && message.annotations.every(isOpenRouterAnnotation))
	);
}

function isOpenRouterChoice(value: unknown): value is { message?: OpenRouterMessage } {
	const choice = asRecord(value);
	return choice !== null && (choice.message === undefined || isOpenRouterMessage(choice.message));
}

function isOpenRouterUsage(value: unknown): value is NonNullable<OpenRouterResponse["usage"]> {
	const usage = asRecord(value);
	return (
		usage !== null &&
		isOptionalNumber(usage.prompt_tokens) &&
		isOptionalNumber(usage.completion_tokens) &&
		isOptionalNumber(usage.total_tokens)
	);
}

function isOpenRouterResponse(value: unknown): value is OpenRouterResponse {
	const response = asRecord(value);
	return (
		response !== null &&
		isOptionalString(response.id) &&
		isOptionalString(response.model) &&
		(response.choices === undefined ||
			(Array.isArray(response.choices) && response.choices.every(isOpenRouterChoice))) &&
		(response.usage === undefined || isOpenRouterUsage(response.usage))
	);
}

function parseContent(content: OpenRouterMessage["content"]): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const answer = content
		.map(part => part.text?.trim())
		.filter((text): text is string => Boolean(text))
		.join("\n")
		.trim();
	return answer || undefined;
}

function parseUsage(usage: OpenRouterResponse["usage"]): SearchUsage | undefined {
	if (!usage) return undefined;
	const parsed: SearchUsage = {};
	let hasUsage = false;
	if (typeof usage.prompt_tokens === "number") {
		parsed.inputTokens = usage.prompt_tokens;
		hasUsage = true;
	}
	if (typeof usage.completion_tokens === "number") {
		parsed.outputTokens = usage.completion_tokens;
		hasUsage = true;
	}
	if (typeof usage.total_tokens === "number") {
		parsed.totalTokens = usage.total_tokens;
		hasUsage = true;
	}
	return hasUsage ? parsed : undefined;
}

function parseResponse(response: OpenRouterResponse, modelId: string): SearchResponse {
	const message = response.choices?.[0]?.message;
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const seenUrls = new Set<string>();
	for (const annotation of message?.annotations ?? []) {
		const citation = annotation.url_citation;
		if (!citation) continue;
		const url = citation.url?.trim();
		if (!url || seenUrls.has(url)) continue;
		seenUrls.add(url);
		const title = citation.title?.trim() || url;
		const citedText = citation.content?.trim() || undefined;
		sources.push({ title, url, snippet: citedText });
		citations.push({ title, url, citedText });
	}

	return {
		provider: "openrouter",
		answer: parseContent(message?.content),
		sources,
		citations: citations.length > 0 ? citations : undefined,
		usage: parseUsage(response.usage),
		model: response.model ?? modelId,
		requestId: response.id,
	};
}

/** Execute OpenRouter chat-completions grounding with the web plugin. */
export async function searchOpenRouterGrounded(params: SearchParams): Promise<SearchResponse> {
	const numSearchResults = params.numSearchResults ?? DEFAULT_NUM_RESULTS;
	const keyOrResolver = params.modelRegistry.resolver(params.model, params.sessionId);
	const response = await withAuth(
		keyOrResolver,
		async apiKey => {
			const configuredHeaders = await params.modelRegistry.resolveModelHeaders(params.model, params.signal);
			const httpResponse = await (params.fetch ?? fetch)(
				`${params.model.baseUrl.replace(/\/+$/, "")}/chat/completions`,
				{
					method: "POST",
					headers: {
						...configuredHeaders,
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: params.model.id,
						plugins: [{ id: "web", max_results: numSearchResults }],
						messages: [{ role: "user", content: params.query }],
					}),
					signal: withHardTimeout(params.signal, params.timeoutMs),
				},
			);
			if (!httpResponse.ok) {
				const errorText = await httpResponse.text();
				const classified = classifyProviderHttpError("openrouter", httpResponse.status, errorText);
				if (classified) throw classified;
				throw new SearchProviderError(
					"openrouter",
					`OpenRouter web search error (${httpResponse.status}): ${errorText}`,
					httpResponse.status,
				);
			}
			try {
				const payload: unknown = await httpResponse.json();
				if (!isOpenRouterResponse(payload)) {
					throw new Error("response did not match the expected chat-completion shape");
				}
				return parseResponse(payload, params.model.id);
			} catch (error) {
				if (error instanceof SearchProviderError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				throw new SearchProviderError("openrouter", `OpenRouter returned an invalid response: ${message}`, 502);
			}
		},
		{
			signal: params.signal,
			missingKeyMessage: `OpenRouter credentials not found for selected provider "${params.model.provider}".`,
		},
	);

	if (!response.answer && response.sources.length === 0) {
		throw new SearchProviderError("openrouter", "OpenRouter web search returned no answer or citations", 502);
	}
	return response;
}

/** Search provider for OpenRouter's web plugin grounding. */
export class OpenRouterGroundedProvider extends SearchProvider {
	readonly id = "openrouter";
	readonly label = "OpenRouter";

	isAvailable(authStorage: AuthStorage, model?: Model<Api>): boolean {
		return authStorage.keys.source(model?.provider ?? "openrouter") !== undefined;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchOpenRouterGrounded(params);
	}
}
