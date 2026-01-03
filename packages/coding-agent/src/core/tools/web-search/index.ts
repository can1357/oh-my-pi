/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, and Exa providers with
 * provider-specific parameters exposed conditionally.
 *
 * When EXA_API_KEY is available, additional specialized tools are exposed:
 * - web_search_deep: Natural language web search with synthesized results
 * - web_search_code_context: Search code snippets, docs, and examples
 * - web_search_crawl: Extract content from specific URLs
 * - web_search_linkedin: Search LinkedIn profiles and companies
 * - web_search_company: Comprehensive company research
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Theme } from "../../../modes/interactive/theme/theme";
import type { CustomTool, CustomToolContext, RenderResultOptions } from "../../custom-tools/types";
import { callExaTool, findApiKey as findExaKey, formatSearchResults, isSearchResponse } from "../exa/mcp-client";
import { renderExaCall, renderExaResult } from "../exa/render";
import type { ExaRenderDetails } from "../exa/types";
import { searchAnthropic } from "./providers/anthropic";
import { searchExa } from "./providers/exa";
import { findApiKey as findPerplexityKey, searchPerplexity } from "./providers/perplexity";
import { formatAge, renderWebSearchCall, renderWebSearchResult, type WebSearchRenderDetails } from "./render";
import type { WebSearchProvider, WebSearchResponse } from "./types";

/** Web search parameters schema */
export const webSearchSchema = Type.Object({
	// Common
	query: Type.String({ description: "Search query" }),
	provider: Type.Optional(
		Type.Union([Type.Literal("exa"), Type.Literal("anthropic"), Type.Literal("perplexity")], {
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
	provider?: "exa" | "anthropic" | "perplexity";
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

/** Detect provider based on available API keys (priority: exa > perplexity > anthropic) */
async function detectProvider(): Promise<WebSearchProvider> {
	// Exa takes highest priority if key exists
	const exaKey = await findExaKey();
	if (exaKey) return "exa";

	// Perplexity second priority
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
		if (provider === "exa") {
			response = await searchExa({
				query: params.query,
				num_results: params.num_results,
			});
		} else if (provider === "anthropic") {
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

const WEB_SEARCH_DESCRIPTION = `Allows OMP to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

Common: system_prompt (guides response style)
Anthropic-specific: max_tokens
Perplexity-specific: model (sonar/sonar-pro), search_recency_filter, search_domain_filter, search_context_size, return_related_questions
Exa-specific: num_results`;

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

// ============================================================================
// Exa-specific tools (available when EXA_API_KEY is present)
// ============================================================================

/** Schema for deep search */
const webSearchDeepSchema = Type.Object({
	query: Type.String({ description: "Research query" }),
	type: Type.Optional(
		Type.Union([Type.Literal("keyword"), Type.Literal("neural"), Type.Literal("auto")], {
			description: "Search type - neural (semantic), keyword (exact), or auto",
		}),
	),
	include_domains: Type.Optional(
		Type.Array(Type.String(), { description: "Only include results from these domains" }),
	),
	exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains" })),
	start_published_date: Type.Optional(
		Type.String({ description: "Filter results published after this date (ISO 8601)" }),
	),
	end_published_date: Type.Optional(
		Type.String({ description: "Filter results published before this date (ISO 8601)" }),
	),
	num_results: Type.Optional(
		Type.Number({ description: "Maximum results (default: 10, max: 100)", minimum: 1, maximum: 100 }),
	),
});

/** Schema for code context search */
const webSearchCodeContextSchema = Type.Object({
	query: Type.String({ description: "Code or technical search query" }),
	code_context: Type.Optional(Type.String({ description: "Additional context about what you're looking for" })),
});

/** Schema for URL crawling */
const webSearchCrawlSchema = Type.Object({
	url: Type.String({ description: "URL to crawl and extract content from" }),
	text: Type.Optional(Type.Boolean({ description: "Include full page text content (default: false)" })),
	highlights: Type.Optional(Type.Boolean({ description: "Include highlighted relevant snippets (default: false)" })),
});

/** Schema for LinkedIn search */
const webSearchLinkedinSchema = Type.Object({
	query: Type.String({ description: 'LinkedIn search query (e.g., "Software Engineer at OpenAI")' }),
});

/** Schema for company research */
const webSearchCompanySchema = Type.Object({
	company_name: Type.String({ description: "Name of the company to research" }),
});

/** Helper to execute Exa tool and format response */
async function executeExaTool(
	mcpToolName: string,
	params: Record<string, unknown>,
	toolName: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ExaRenderDetails }> {
	try {
		const apiKey = await findExaKey();
		if (!apiKey) {
			return {
				content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
				details: { error: "EXA_API_KEY not found", toolName },
			};
		}

		const response = await callExaTool(mcpToolName, params, apiKey);

		if (isSearchResponse(response)) {
			const formatted = formatSearchResults(response);
			return {
				content: [{ type: "text" as const, text: formatted }],
				details: { response, toolName },
			};
		}

		return {
			content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
			details: { raw: response, toolName },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { error: message, toolName },
		};
	}
}

/** Deep search - AI-synthesized research with multiple sources */
export const webSearchDeepTool: CustomTool<typeof webSearchDeepSchema, ExaRenderDetails> = {
	name: "web_search_deep",
	label: "Deep Search",
	description: `Natural language web search with synthesized results (requires Exa).

Performs AI-powered deep research that synthesizes information from multiple sources.
Best for complex research queries that need comprehensive answers.

Parameters:
- query: Research query (required)
- type: Search type - neural (semantic), keyword (exact), or auto
- include_domains/exclude_domains: Domain filters
- start/end_published_date: Date range filter (ISO 8601)
- num_results: Maximum results (default: 10)`,
	parameters: webSearchDeepSchema,

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		const { num_results, ...rest } = params as Record<string, unknown>;
		const args = { ...rest, type: "deep", numResults: num_results ?? 10 };
		return executeExaTool("web_search_exa", args, "web_search_deep");
	},

	renderCall(args, theme) {
		return renderExaCall(args as Record<string, unknown>, "Deep Search", theme);
	},

	renderResult(result, options, theme) {
		return renderExaResult(result, options, theme);
	},
};

/** Code context search - optimized for code snippets and documentation */
export const webSearchCodeContextTool: CustomTool<typeof webSearchCodeContextSchema, ExaRenderDetails> = {
	name: "web_search_code_context",
	label: "Code Search",
	description: `Search code snippets, documentation, and technical examples (requires Exa).

Optimized for finding:
- Code examples and snippets
- API documentation
- Technical tutorials
- Stack Overflow answers
- GitHub code references

Parameters:
- query: Code or technical search query (required)
- code_context: Additional context about what you're looking for`,
	parameters: webSearchCodeContextSchema,

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		return executeExaTool("get_code_context_exa", params as Record<string, unknown>, "web_search_code_context");
	},

	renderCall(args, theme) {
		return renderExaCall(args as Record<string, unknown>, "Code Search", theme);
	},

	renderResult(result, options, theme) {
		return renderExaResult(result, options, theme);
	},
};

/** URL crawl - extract content from specific URLs */
export const webSearchCrawlTool: CustomTool<typeof webSearchCrawlSchema, ExaRenderDetails> = {
	name: "web_search_crawl",
	label: "Crawl URL",
	description: `Extract content from a specific URL (requires Exa).

Fetches and extracts content from a URL with optional text and highlights.
Useful when you have a specific URL and want its content.

Parameters:
- url: URL to crawl (required)
- text: Include full page text content (default: false)
- highlights: Include highlighted snippets (default: false)`,
	parameters: webSearchCrawlSchema,

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		return executeExaTool("crawling", params as Record<string, unknown>, "web_search_crawl");
	},

	renderCall(args, theme) {
		const url = (args as { url: string }).url;
		return renderExaCall({ query: url }, "Crawl URL", theme);
	},

	renderResult(result, options, theme) {
		return renderExaResult(result, options, theme);
	},
};

/** LinkedIn search - search LinkedIn profiles and companies */
export const webSearchLinkedinTool: CustomTool<typeof webSearchLinkedinSchema, ExaRenderDetails> = {
	name: "web_search_linkedin",
	label: "LinkedIn Search",
	description: `Search LinkedIn for people, companies, and professional content (requires Exa + LinkedIn addon).

Returns LinkedIn profiles, company pages, posts, and professional content.

Examples:
- "Software Engineer at OpenAI"
- "Y Combinator companies"
- "CEO fintech startup San Francisco"

Parameters:
- query: LinkedIn search query (required)`,
	parameters: webSearchLinkedinSchema,

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		return executeExaTool("linkedin_search", params as Record<string, unknown>, "web_search_linkedin");
	},

	renderCall(args, theme) {
		return renderExaCall(args as Record<string, unknown>, "LinkedIn Search", theme);
	},

	renderResult(result, options, theme) {
		return renderExaResult(result, options, theme);
	},
};

/** Company research - comprehensive company information */
export const webSearchCompanyTool: CustomTool<typeof webSearchCompanySchema, ExaRenderDetails> = {
	name: "web_search_company",
	label: "Company Research",
	description: `Comprehensive company research (requires Exa + Company addon).

Returns detailed company information including:
- Company overview and description
- Recent news and announcements
- Key people and leadership
- Funding and financial information
- Products and services

Parameters:
- company_name: Name of the company to research (required)`,
	parameters: webSearchCompanySchema,

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		return executeExaTool("company_research", params as Record<string, unknown>, "web_search_company");
	},

	renderCall(args, theme) {
		const name = (args as { company_name: string }).company_name;
		return renderExaCall({ query: name }, "Company Research", theme);
	},

	renderResult(result, options, theme) {
		return renderExaResult(result, options, theme);
	},
};

/** All Exa-specific web search tools */
export const exaWebSearchTools: CustomTool<any, ExaRenderDetails>[] = [
	webSearchDeepTool,
	webSearchCodeContextTool,
	webSearchCrawlTool,
];

/** LinkedIn-specific tool (requires LinkedIn addon on Exa account) */
export const linkedinWebSearchTools: CustomTool<any, ExaRenderDetails>[] = [webSearchLinkedinTool];

/** Company-specific tool (requires Company addon on Exa account) */
export const companyWebSearchTools: CustomTool<any, ExaRenderDetails>[] = [webSearchCompanyTool];

export interface WebSearchToolsOptions {
	/** Enable LinkedIn search tool (requires Exa LinkedIn addon) */
	enableLinkedin?: boolean;
	/** Enable company research tool (requires Exa Company addon) */
	enableCompany?: boolean;
}

/**
 * Get all available web search tools based on API key availability.
 *
 * Returns:
 * - Always: web_search (unified, works with Anthropic/Perplexity/Exa)
 * - With EXA_API_KEY: web_search_deep, web_search_code_context, web_search_crawl
 * - With EXA_API_KEY + options.enableLinkedin: web_search_linkedin
 * - With EXA_API_KEY + options.enableCompany: web_search_company
 */
export async function getWebSearchTools(options: WebSearchToolsOptions = {}): Promise<CustomTool<any, any>[]> {
	const tools: CustomTool<any, any>[] = [webSearchCustomTool];

	// Check for Exa API key
	const exaKey = await findExaKey();
	if (exaKey) {
		tools.push(...exaWebSearchTools);

		if (options.enableLinkedin) {
			tools.push(...linkedinWebSearchTools);
		}
		if (options.enableCompany) {
			tools.push(...companyWebSearchTools);
		}
	}

	return tools;
}

/**
 * Check if Exa-specific web search tools are available.
 */
export async function hasExaWebSearch(): Promise<boolean> {
	const exaKey = await findExaKey();
	return exaKey !== null;
}

export type { WebSearchProvider, WebSearchResponse } from "./types";
