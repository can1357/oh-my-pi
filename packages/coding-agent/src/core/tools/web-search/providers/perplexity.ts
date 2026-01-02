/**
 * Perplexity Web Search Provider
 *
 * Supports both sonar (fast) and sonar-pro (comprehensive) models.
 * Returns synthesized answers with citations and related questions.
 */

import * as os from "node:os";
import type {
	PerplexityRequest,
	PerplexityResponse,
	WebSearchCitation,
	WebSearchResponse,
	WebSearchSource,
} from "../types.js";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

export interface PerplexitySearchParams {
	query: string;
	model?: "sonar" | "sonar-pro";
	system_prompt?: string;
	search_recency_filter?: "day" | "week" | "month" | "year";
	search_domain_filter?: string[];
	search_context_size?: "low" | "medium" | "high";
	return_related_questions?: boolean;
	num_results?: number;
}

/** Parse a .env file and return key-value pairs */
async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	try {
		const file = Bun.file(filePath);
		if (!(await file.exists())) return result;

		const content = await file.text();
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;

			const key = trimmed.slice(0, eqIndex).trim();
			let value = trimmed.slice(eqIndex + 1).trim();

			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			result[key] = value;
		}
	} catch {
		// Ignore read errors
	}
	return result;
}

/** Find PERPLEXITY_API_KEY from environment or .env files */
export async function findApiKey(): Promise<string | null> {
	// 1. Check environment variable
	if (process.env.PERPLEXITY_API_KEY) {
		return process.env.PERPLEXITY_API_KEY;
	}

	// 2. Check .env in current directory
	const localEnv = await parseEnvFile(`${process.cwd()}/.env`);
	if (localEnv.PERPLEXITY_API_KEY) {
		return localEnv.PERPLEXITY_API_KEY;
	}

	// 3. Check ~/.env
	const homeEnv = await parseEnvFile(`${os.homedir()}/.env`);
	if (homeEnv.PERPLEXITY_API_KEY) {
		return homeEnv.PERPLEXITY_API_KEY;
	}

	return null;
}

/** Call Perplexity API */
async function callPerplexity(apiKey: string, request: PerplexityRequest): Promise<PerplexityResponse> {
	const response = await fetch(PERPLEXITY_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(request),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Perplexity API error (${response.status}): ${errorText}`);
	}

	return response.json() as Promise<PerplexityResponse>;
}

/** Calculate age in seconds from ISO date string */
function dateToAgeSeconds(dateStr: string | undefined): number | undefined {
	if (!dateStr) return undefined;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return undefined;
		return Math.floor((Date.now() - date.getTime()) / 1000);
	} catch {
		return undefined;
	}
}

/** Parse API response into unified WebSearchResponse */
function parseResponse(response: PerplexityResponse): WebSearchResponse {
	const answer = response.choices[0]?.message?.content ?? "";

	// Build sources by matching citations to search_results
	const sources: WebSearchSource[] = [];
	const citations: WebSearchCitation[] = [];

	const citationUrls = response.citations ?? [];
	const searchResults = response.search_results ?? [];

	for (const url of citationUrls) {
		const searchResult = searchResults.find((r) => r.url === url);
		sources.push({
			title: searchResult?.title ?? url,
			url,
			snippet: searchResult?.snippet,
			publishedDate: searchResult?.date,
			ageSeconds: dateToAgeSeconds(searchResult?.date),
		});
		citations.push({
			url,
			title: searchResult?.title ?? url,
		});
	}

	return {
		provider: "perplexity",
		answer: answer || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		relatedQuestions: response.related_questions,
		usage: {
			inputTokens: response.usage.prompt_tokens,
			outputTokens: response.usage.completion_tokens,
			totalTokens: response.usage.total_tokens,
		},
		model: response.model,
		requestId: response.id,
	};
}

/** Execute Perplexity web search */
export async function searchPerplexity(params: PerplexitySearchParams): Promise<WebSearchResponse> {
	const apiKey = await findApiKey();
	if (!apiKey) {
		throw new Error("PERPLEXITY_API_KEY not found. Set it in environment or .env file.");
	}

	const messages: PerplexityRequest["messages"] = [];
	if (params.system_prompt) {
		messages.push({ role: "system", content: params.system_prompt });
	}
	messages.push({ role: "user", content: params.query });

	const request: PerplexityRequest = {
		model: params.model ?? "sonar",
		messages,
		// Default to true for related questions (unlike original which hardcoded false)
		return_related_questions: params.return_related_questions ?? true,
	};

	// Add optional parameters
	if (params.search_recency_filter) {
		request.search_recency_filter = params.search_recency_filter;
	}
	if (params.search_domain_filter && params.search_domain_filter.length > 0) {
		request.search_domain_filter = params.search_domain_filter;
	}
	if (params.search_context_size) {
		request.search_context_size = params.search_context_size;
	}

	const response = await callPerplexity(apiKey, request);
	const result = parseResponse(response);

	// Apply num_results limit if specified
	if (params.num_results && result.sources.length > params.num_results) {
		result.sources = result.sources.slice(0, params.num_results);
	}

	return result;
}
