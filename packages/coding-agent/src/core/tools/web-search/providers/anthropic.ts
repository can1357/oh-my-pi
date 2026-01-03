/**
 * Anthropic Web Search Provider
 *
 * Uses Claude's built-in web_search_20250305 tool to search the web.
 * Returns synthesized answers with citations and source metadata.
 */

import { buildAnthropicHeaders, buildAnthropicUrl, findAnthropicAuth, getEnv } from "../auth";
import type {
	AnthropicApiResponse,
	AnthropicAuthConfig,
	AnthropicCitation,
	WebSearchCitation,
	WebSearchResponse,
	WebSearchSource,
} from "../types";

const DEFAULT_MODEL = "claude-sonnet-4-5-20250514";
const DEFAULT_MAX_TOKENS = 4096;

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

	// Build system blocks
	const systemBlocks: Array<{ type: string; text: string; cache_control?: { type: string } }> = [];

	if (auth.isOAuth) {
		// OAuth requires Claude Code identity with cache_control
		systemBlocks.push({
			type: "text",
			text: "You are a helpful AI assistant with web search capabilities.",
			cache_control: { type: "ephemeral" },
		});
	}

	if (systemPrompt) {
		systemBlocks.push({
			type: "text",
			text: systemPrompt,
			...(auth.isOAuth ? { cache_control: { type: "ephemeral" } } : {}),
		});
	}

	const body: Record<string, unknown> = {
		model,
		max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
		messages: [{ role: "user", content: query }],
		tools: [{ type: "web_search_20250305", name: "web_search" }],
	};

	if (systemBlocks.length > 0) {
		body.system = systemBlocks;
	}

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
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
		if (block.type === "server_tool_use" && block.name === "web_search") {
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
