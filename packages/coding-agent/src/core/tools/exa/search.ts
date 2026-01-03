/**
 * Exa Search Tools
 *
 * Basic neural/keyword search, deep research, code search, and URL crawling.
 */

import { Type } from "@sinclair/typebox";
import type { CustomTool } from "../../custom-tools/types";
import type { ExaRenderDetails } from "./types";

/** exa_search - Basic neural/keyword search */
const exaSearchTool: CustomTool<any, ExaRenderDetails> = {
	name: "exa_search",
	label: "Exa Search",
	description: `Search the web using Exa's neural or keyword search.

Returns structured search results with optional text content and highlights.

Parameters:
- query: Search query (required)
- type: Search type - "neural" (semantic), "keyword" (exact), or "auto" (default: auto)
- include_domains: Array of domains to include in results
- exclude_domains: Array of domains to exclude from results
- start_published_date: Filter results published after this date (ISO 8601)
- end_published_date: Filter results published before this date (ISO 8601)
- use_autoprompt: Let Exa optimize your query automatically (default: true)
- text: Include page text content in results (default: false, costs more)
- highlights: Include highlighted relevant snippets (default: false)
- num_results: Maximum number of results to return (default: 10, max: 100)`,

	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		type: Type.Optional(
			Type.Union([Type.Literal("keyword"), Type.Literal("neural"), Type.Literal("auto")], {
				description: "Search type - neural (semantic), keyword (exact), or auto",
			}),
		),
		include_domains: Type.Optional(
			Type.Array(Type.String(), {
				description: "Only include results from these domains",
			}),
		),
		exclude_domains: Type.Optional(
			Type.Array(Type.String(), {
				description: "Exclude results from these domains",
			}),
		),
		start_published_date: Type.Optional(
			Type.String({
				description: "Filter results published after this date (ISO 8601 format)",
			}),
		),
		end_published_date: Type.Optional(
			Type.String({
				description: "Filter results published before this date (ISO 8601 format)",
			}),
		),
		use_autoprompt: Type.Optional(
			Type.Boolean({
				description: "Let Exa optimize your query automatically (default: true)",
			}),
		),
		text: Type.Optional(
			Type.Boolean({
				description: "Include page text content in results (costs more, default: false)",
			}),
		),
		highlights: Type.Optional(
			Type.Boolean({
				description: "Include highlighted relevant snippets (default: false)",
			}),
		),
		num_results: Type.Optional(
			Type.Number({
				description: "Maximum number of results to return (default: 10, max: 100)",
				minimum: 1,
				maximum: 100,
			}),
		),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		try {
			// Dynamic imports to avoid circular dependencies
			const { findApiKey, callExaTool, formatSearchResults, isSearchResponse } = await import("./mcp-client.js");

			const apiKey = await findApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
					details: { error: "EXA_API_KEY not found", toolName: "exa_search" },
				};
			}
			const response = await callExaTool("web_search_exa", params, apiKey);

			if (isSearchResponse(response)) {
				const formatted = formatSearchResults(response);
				return {
					content: [{ type: "text" as const, text: formatted }],
					details: { response, toolName: "exa_search" },
				};
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
				details: { raw: response, toolName: "exa_search" },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message, toolName: "exa_search" },
			};
		}
	},
};

/** exa_search_deep - AI-synthesized deep research */
const exaSearchDeepTool: CustomTool<any, ExaRenderDetails> = {
	name: "exa_search_deep",
	label: "Exa Deep Search",
	description: `Perform AI-synthesized deep research using Exa.

Returns comprehensive research with synthesized answers and multiple sources.

Similar parameters to exa_search, optimized for research depth.`,

	parameters: Type.Object({
		query: Type.String({ description: "Research query" }),
		type: Type.Optional(
			Type.Union([Type.Literal("keyword"), Type.Literal("neural"), Type.Literal("auto")], {
				description: "Search type - neural (semantic), keyword (exact), or auto",
			}),
		),
		include_domains: Type.Optional(
			Type.Array(Type.String(), {
				description: "Only include results from these domains",
			}),
		),
		exclude_domains: Type.Optional(
			Type.Array(Type.String(), {
				description: "Exclude results from these domains",
			}),
		),
		start_published_date: Type.Optional(
			Type.String({
				description: "Filter results published after this date (ISO 8601 format)",
			}),
		),
		end_published_date: Type.Optional(
			Type.String({
				description: "Filter results published before this date (ISO 8601 format)",
			}),
		),
		use_autoprompt: Type.Optional(
			Type.Boolean({
				description: "Let Exa optimize your query automatically (default: true)",
			}),
		),
		text: Type.Optional(
			Type.Boolean({
				description: "Include page text content in results (costs more, default: false)",
			}),
		),
		highlights: Type.Optional(
			Type.Boolean({
				description: "Include highlighted relevant snippets (default: false)",
			}),
		),
		num_results: Type.Optional(
			Type.Number({
				description: "Maximum number of results to return (default: 10, max: 100)",
				minimum: 1,
				maximum: 100,
			}),
		),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		try {
			const { findApiKey, callExaTool, formatSearchResults, isSearchResponse } = await import("./mcp-client.js");

			const apiKey = await findApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
					details: { error: "EXA_API_KEY not found", toolName: "exa_search_deep" },
				};
			}
			const args = { ...params, type: "deep" };
			const response = await callExaTool("web_search_exa", args, apiKey);

			if (isSearchResponse(response)) {
				const formatted = formatSearchResults(response);
				return {
					content: [{ type: "text" as const, text: formatted }],
					details: { response, toolName: "exa_search_deep" },
				};
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
				details: { raw: response, toolName: "exa_search_deep" },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message, toolName: "exa_search_deep" },
			};
		}
	},
};

/** exa_search_code - Code-focused search */
const exaSearchCodeTool: CustomTool<any, ExaRenderDetails> = {
	name: "exa_search_code",
	label: "Exa Code Search",
	description: `Search for code examples and technical documentation using Exa.

Optimized for finding code snippets, API documentation, and technical content.

Parameters:
- query: Code or technical search query (required)
- code_context: Additional context about what you're looking for`,

	parameters: Type.Object({
		query: Type.String({ description: "Code or technical search query" }),
		code_context: Type.Optional(
			Type.String({
				description: "Additional context about what you're looking for",
			}),
		),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		try {
			const { findApiKey, callExaTool, formatSearchResults, isSearchResponse } = await import("./mcp-client.js");

			const apiKey = await findApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
					details: { error: "EXA_API_KEY not found", toolName: "exa_search_code" },
				};
			}
			const response = await callExaTool("get_code_context_exa", params, apiKey);

			if (isSearchResponse(response)) {
				const formatted = formatSearchResults(response);
				return {
					content: [{ type: "text" as const, text: formatted }],
					details: { response, toolName: "exa_search_code" },
				};
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
				details: { raw: response, toolName: "exa_search_code" },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message, toolName: "exa_search_code" },
			};
		}
	},
};

/** exa_crawl - URL content extraction */
const exaCrawlTool: CustomTool<any, ExaRenderDetails> = {
	name: "exa_crawl",
	label: "Exa Crawl",
	description: `Extract content from a specific URL using Exa.

Returns the page content with optional text and highlights.

Parameters:
- url: URL to crawl (required)
- text: Include full page text content (default: false)
- highlights: Include highlighted relevant snippets (default: false)`,

	parameters: Type.Object({
		url: Type.String({ description: "URL to crawl and extract content from" }),
		text: Type.Optional(
			Type.Boolean({
				description: "Include full page text content (default: false)",
			}),
		),
		highlights: Type.Optional(
			Type.Boolean({
				description: "Include highlighted relevant snippets (default: false)",
			}),
		),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		try {
			const { findApiKey, callExaTool, formatSearchResults, isSearchResponse } = await import("./mcp-client.js");

			const apiKey = await findApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
					details: { error: "EXA_API_KEY not found", toolName: "exa_crawl" },
				};
			}
			const response = await callExaTool("crawling", params, apiKey);

			if (isSearchResponse(response)) {
				const formatted = formatSearchResults(response);
				return {
					content: [{ type: "text" as const, text: formatted }],
					details: { response, toolName: "exa_crawl" },
				};
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
				details: { raw: response, toolName: "exa_crawl" },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message, toolName: "exa_crawl" },
			};
		}
	},
};

export const searchTools: CustomTool<any, ExaRenderDetails>[] = [
	exaSearchTool,
	exaSearchDeepTool,
	exaSearchCodeTool,
	exaCrawlTool,
];
