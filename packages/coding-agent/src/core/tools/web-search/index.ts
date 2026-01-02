/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic and Perplexity providers with
 * provider-specific parameters exposed conditionally.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import type { CustomTool, CustomToolContext, RenderResultOptions } from "../../custom-tools/types.js";
import { searchAnthropic } from "./providers/anthropic.js";
import { findApiKey as findPerplexityKey, searchPerplexity } from "./providers/perplexity.js";
import { formatAge, renderWebSearchCall, renderWebSearchResult, type WebSearchRenderDetails } from "./render.js";
import type { WebSearchProvider, WebSearchResponse } from "./types.js";

/** Web search parameters schema */
export const webSearchSchema = Type.Object({
	// Common
	query: Type.String({ description: "Search query" }),
	provider: Type.Optional(
		Type.Union([Type.Literal("anthropic"), Type.Literal("perplexity")], {
			description: "Search provider (auto-detected if omitted based on API keys)",
		}),
	),
	num_results: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),

	// Common (Anthropic & Perplexity)
	system_prompt: Type.Optional(
		Type.String({
			description: "System prompt to guide response style",
		}),
	),
	max_tokens: Type.Optional(
		Type.Number({
			description: "Maximum tokens in response, 1-16384, default 4096 (Anthropic only)",
			minimum: 1,
			maximum: 16384,
		}),
	),

	// Perplexity-specific
	model: Type.Optional(
		Type.Union([Type.Literal("sonar"), Type.Literal("sonar-pro")], {
			description: "Perplexity model - sonar (fast) or sonar-pro (comprehensive research)",
		}),
	),
	search_recency_filter: Type.Optional(
		Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
			description: "Filter results by recency (Perplexity only)",
		}),
	),
	search_domain_filter: Type.Optional(
		Type.Array(Type.String(), {
			description: "Domain filter - include domains, prefix with - to exclude (Perplexity only)",
		}),
	),
	search_context_size: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
			description: "Context size for cost control (Perplexity only)",
		}),
	),
	return_related_questions: Type.Optional(
		Type.Boolean({
			description: "Include follow-up question suggestions, default true (Perplexity only)",
		}),
	),
});

export type WebSearchParams = {
	query: string;
	provider?: "anthropic" | "perplexity";
	num_results?: number;
	// Anthropic
	system_prompt?: string;
	max_tokens?: number;
	// Perplexity
	model?: "sonar" | "sonar-pro";
	search_recency_filter?: "day" | "week" | "month" | "year";
	search_domain_filter?: string[];
	search_context_size?: "low" | "medium" | "high";
	return_related_questions?: boolean;
};

/** Detect provider based on available API keys */
async function detectProvider(): Promise<WebSearchProvider> {
	// Perplexity takes priority if key exists (more specialized)
	const perplexityKey = await findPerplexityKey();
	if (perplexityKey) return "perplexity";

	// Default to Anthropic
	return "anthropic";
}

/** Format response for LLM consumption */
function formatForLLM(response: WebSearchResponse): string {
	const parts: string[] = [];

	// Add synthesized answer
	if (response.answer) {
		parts.push(response.answer);
	}

	// Add sources
	if (response.sources.length > 0) {
		parts.push("\n## Sources");
		for (const [i, src] of response.sources.entries()) {
			const age = formatAge(src.ageSeconds) || src.publishedDate;
			const agePart = age ? ` (${age})` : "";
			parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		}
	}

	// Add related questions (Perplexity)
	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related Questions");
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	return parts.join("\n");
}

/** Execute web search */
async function executeWebSearch(
	_toolCallId: string,
	params: WebSearchParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WebSearchRenderDetails }> {
	try {
		const provider = params.provider ?? (await detectProvider());

		let response: WebSearchResponse;
		if (provider === "anthropic") {
			response = await searchAnthropic({
				query: params.query,
				system_prompt: params.system_prompt,
				max_tokens: params.max_tokens,
				num_results: params.num_results,
			});
		} else {
			response = await searchPerplexity({
				query: params.query,
				model: params.model,
				system_prompt: params.system_prompt,
				search_recency_filter: params.search_recency_filter,
				search_domain_filter: params.search_domain_filter,
				search_context_size: params.search_context_size,
				return_related_questions: params.return_related_questions,
				num_results: params.num_results,
			});
		}

		const text = formatForLLM(response);

		return {
			content: [{ type: "text" as const, text }],
			details: { response },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "anthropic", sources: [] }, error: message },
		};
	}
}

const WEB_SEARCH_DESCRIPTION = `Search the web using Anthropic or Perplexity. Returns synthesized answers with citations.

Provider auto-detected by API key presence, or specify explicitly.

Common: system_prompt (guides response style)
Anthropic-specific: max_tokens
Perplexity-specific: model (sonar/sonar-pro), search_recency_filter, search_domain_filter, search_context_size, return_related_questions`;

/** Web search tool as AgentTool (for allTools export) */
export const webSearchTool: AgentTool<typeof webSearchSchema> = {
	name: "web_search",
	label: "Web Search",
	description: WEB_SEARCH_DESCRIPTION,
	parameters: webSearchSchema,
	execute: async (toolCallId, params) => {
		return executeWebSearch(toolCallId, params as WebSearchParams);
	},
};

/** Web search tool as CustomTool (for TUI rendering support) */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, WebSearchRenderDetails> = {
	name: "web_search",
	label: "Web Search",
	description: WEB_SEARCH_DESCRIPTION,
	parameters: webSearchSchema,

	async execute(
		toolCallId: string,
		params: WebSearchParams,
		_onUpdate,
		_ctx: CustomToolContext,
		_signal?: AbortSignal,
	) {
		return executeWebSearch(toolCallId, params);
	},

	renderCall(args: WebSearchParams, theme: Theme) {
		return renderWebSearchCall(args, theme);
	},

	renderResult(result, options: RenderResultOptions, theme: Theme) {
		return renderWebSearchResult(result, options, theme);
	},
};

/** Factory function for backward compatibility */
export function createWebSearchTool(_cwd: string): AgentTool<typeof webSearchSchema> {
	return webSearchTool;
}

export type { WebSearchProvider, WebSearchResponse } from "./types.js";
