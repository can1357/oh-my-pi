/**
 * Anthropic Web Search Provider
 *
 * Uses Claude's built-in web_search_20250305 tool to search the web.
 * Returns synthesized answers with citations and source metadata.
 */

import { applyClaudeToolPrefix, buildAnthropicSystemBlocks, stripClaudeToolPrefix } from "@oh-my-pi/pi-ai";
import { buildAnthropicHeaders, buildAnthropicUrl, findAnthropicAuth, getEnv } from "../auth";
import type {
	AnthropicApiResponse,
	AnthropicAuthConfig,
	AnthropicCitation,
	WebSearchCitation,
	WebSearchResponse,
	WebSearchSource,
} from "../types";
import { WebSearchProviderError } from "../types";

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 4096;
const WEB_SEARCH_TOOL_NAME = "web_search";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

const applySearchToolPrefix = (name: string, isOAuth: boolean): string => {
	return isOAuth ? applyClaudeToolPrefix(name) : name;
};

export interface AnthropicSearchParams {
	query: string;
	system_prompt?: string;
	max_tokens?: number;
	num_results?: number;
}

/** Get model from env or use default */
async function getModel(): Promise<string> {
	return (await getEnv("ANTHROPIC_SEARCH_MODEL")) ?? DEFAULT_MODEL;
}

function buildSystemBlocks(
	auth: AnthropicAuthConfig,
	model: string,
	systemPrompt?: string,
): ReturnType<typeof buildAnthropicSystemBlocks> {
	const includeClaudeCode = !model.startsWith("claude-3-5-haiku");
	const extraInstructions = auth.isOAuth ? ["You are a helpful AI assistant with web search capabilities."] : [];

	return buildAnthropicSystemBlocks(systemPrompt, {
		includeClaudeCodeInstruction: includeClaudeCode,
		includeCacheControl: auth.isOAuth,
		extraInstructions,
	});
}

/** Call Anthropic API with web search */
async function callWebSearch(
	auth: AnthropicAuthConfig,
	model: string,
	query: string,
	systemPrompt?: string,
	maxTokens?: number,
): Promise<AnthropicApiResponse> {
	const url = buildAnthropicUrl(auth);
	const headers = buildAnthropicHeaders(auth);

	const systemBlocks = buildSystemBlocks(auth, model, systemPrompt);

	const body: Record<string, unknown> = {
		model,
		max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
		messages: [{ role: "user", content: query }],
		tools: [
			{
				type: WEB_SEARCH_TOOL_TYPE,
				name: applySearchToolPrefix(WEB_SEARCH_TOOL_NAME, auth.isOAuth),
			},
		],
	};

	if (systemBlocks && systemBlocks.length > 0) {
		body.system = systemBlocks;
	}

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new WebSearchProviderError(
			"anthropic",
			`Anthropic API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return response.json() as Promise<AnthropicApiResponse>;
}

/** Parse page_age string into seconds (e.g., "2 days ago", "3h ago", "1 week ago") */
function parsePageAge(pageAge: string | null | undefined): number | undefined {
	if (!pageAge) return undefined;

	const match = pageAge.match(/^(\d+)\s*(s|sec|second|m|min|minute|h|hour|d|day|w|week|mo|month|y|year)s?\s*(ago)?$/i);
	if (!match) return undefined;

	const value = parseInt(match[1], 10);
	const unit = match[2].toLowerCase();

	const multipliers: Record<string, number> = {
		s: 1,
		sec: 1,
		second: 1,
		m: 60,
		min: 60,
		minute: 60,
		h: 3600,
		hour: 3600,
		d: 86400,
		day: 86400,
		w: 604800,
		week: 604800,
		mo: 2592000,
		month: 2592000,
		y: 31536000,
		year: 31536000,
	};

	return value * (multipliers[unit] ?? 86400);
}

/** Parse API response into unified WebSearchResponse */
function parseResponse(response: AnthropicApiResponse): WebSearchResponse {
	const answerParts: string[] = [];
	const searchQueries: string[] = [];
	const sources: WebSearchSource[] = [];
	const citations: WebSearchCitation[] = [];

	for (const block of response.content) {
		if (
			block.type === "server_tool_use" &&
			block.name &&
			stripClaudeToolPrefix(block.name) === WEB_SEARCH_TOOL_NAME
		) {
			// Intermediate search query
			if (block.input?.query) {
				searchQueries.push(block.input.query);
			}
		} else if (block.type === "web_search_tool_result" && block.content) {
			// Search results
			for (const result of block.content) {
				if (result.type === "web_search_result") {
					sources.push({
						title: result.title,
						url: result.url,
						snippet: result.encrypted_content,
						publishedDate: result.page_age ?? undefined,
						ageSeconds: parsePageAge(result.page_age),
					});
				}
			}
		} else if (block.type === "text" && block.text) {
			// Synthesized answer with citations
			answerParts.push(block.text);
			if (block.citations) {
				for (const c of block.citations as AnthropicCitation[]) {
					citations.push({
						url: c.url,
						title: c.title,
						citedText: c.cited_text,
					});
				}
			}
		}
	}

	return {
		provider: "anthropic",
		answer: answerParts.join("\n\n") || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
		usage: {
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
			searchRequests: response.usage.server_tool_use?.web_search_requests,
		},
		model: response.model,
		requestId: response.id,
	};
}

/** Execute Anthropic web search */
export async function searchAnthropic(params: AnthropicSearchParams): Promise<WebSearchResponse> {
	const auth = await findAnthropicAuth();
	if (!auth) {
		throw new Error(
			"No Anthropic credentials found. Set ANTHROPIC_API_KEY or configure OAuth in ~/.omp/agent/auth.json",
		);
	}

	const model = await getModel();
	const response = await callWebSearch(auth, model, params.query, params.system_prompt, params.max_tokens);

	const result = parseResponse(response);

	// Apply num_results limit if specified
	if (params.num_results && result.sources.length > params.num_results) {
		result.sources = result.sources.slice(0, params.num_results);
	}

	return result;
}
