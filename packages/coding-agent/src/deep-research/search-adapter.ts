/**
 * Adapter from the omp web search subsystem to the deep-research search seam.
 *
 * Researcher sub-agents get a `web_search` tool that routes through the user's
 * configured search provider chain (tavily, exa, brave, …) via `runSearchQuery`,
 * so deep research works with whatever search the session already has set up.
 */

import type { AuthStorage } from "@pk-nerdsaver-ai/pi-ai";
import type { ResearchTool } from "@pk-nerdsaver-ai/pi-deep-research";
import { type } from "arktype";
import { runSearchQuery } from "../web/search";

const ompSearchParameters = type({
	queries: "string[]",
});

const QUERIES_PER_CALL_LIMIT = 5;
const RESULTS_PER_QUERY_LIMIT = 5;

export interface OmpSearchToolOptions {
	authStorage?: AuthStorage;
	sessionId?: string;
	signal?: AbortSignal;
}

async function searchOne(options: OmpSearchToolOptions, query: string): Promise<string> {
	const { content } = await runSearchQuery(
		{ query, limit: RESULTS_PER_QUERY_LIMIT },
		{ authStorage: options.authStorage, sessionId: options.sessionId, signal: options.signal },
	);
	return content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

export function createOmpSearchTool(options: OmpSearchToolOptions): ResearchTool {
	return {
		tool: {
			name: "web_search",
			description:
				"A search engine optimized for comprehensive, accurate, and trusted results. " +
				"Useful for when you need to answer questions about current events.",
			parameters: ompSearchParameters,
		},
		execute: async args => {
			const parsed = ompSearchParameters(args);
			if (parsed instanceof type.errors) {
				return `Error executing tool: invalid arguments: ${parsed.summary}`;
			}
			const queries = parsed.queries.slice(0, QUERIES_PER_CALL_LIMIT);
			const results = await Promise.all(queries.map(query => searchOne(options, query)));
			const combined = results.filter(text => text.length > 0).join(`\n\n${"-".repeat(80)}\n\n`);
			return combined.length > 0
				? combined
				: "No valid search results found. Please try different search queries or use a different search API.";
		},
	};
}
