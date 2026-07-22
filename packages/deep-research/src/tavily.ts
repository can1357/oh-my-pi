import { z } from "@pk-nerdsaver-ai/pi-ai";
import type { RunContext } from "./config";
import { accumulateUsage, userMessage } from "./messages";
import { prompts } from "./prompts";
import { completeStructured } from "./tools";
import type { ResearchTool } from "./types";
import { getTodayStr } from "./utils";

const TAVILY_API_URL = "https://api.tavily.com/search";
const SUMMARIZE_TIMEOUT_MS = 60_000;

const TAVILY_SEARCH_DESCRIPTION =
	"A search engine optimized for comprehensive, accurate, and trusted results. " +
	"Useful for when you need to answer questions about current events.";

const tavilyResultSchema = z.object({
	title: z.string(),
	url: z.string(),
	content: z.string().default(""),
	raw_content: z.string().nullish(),
});

const tavilyResponseSchema = z.object({
	query: z.string(),
	results: z.array(tavilyResultSchema).default([]),
});

type TavilyResponse = z.infer<typeof tavilyResponseSchema>;

async function tavilySearchOne(run: RunContext, query: string): Promise<TavilyResponse> {
	const { config } = run;
	const apiKey = config.tavilyApiKey ?? Bun.env.TAVILY_API_KEY;
	if (!apiKey) {
		throw new Error(
			"Tavily search requires an API key: set config.tavilyApiKey or the TAVILY_API_KEY environment variable.",
		);
	}
	const response = await config.fetch(TAVILY_API_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			api_key: apiKey,
			query,
			max_results: config.tavilyMaxResults,
			include_raw_content: true,
			topic: config.tavilyTopic,
		}),
	});
	if (!response.ok) {
		throw new Error(`Tavily search failed with status ${response.status}: ${await response.text()}`);
	}
	return tavilyResponseSchema.parse(await response.json());
}

const webpageSummaryStructuredSchema = z.object({
	summary: z.string(),
	key_excerpts: z.string(),
});

/** Summarize one webpage; on timeout or model failure, fall back to the raw content (Python behavior). */
async function summarizeWebpage(run: RunContext, rawContent: string): Promise<string> {
	try {
		const { value, message } = await completeStructured({
			model: run.models.summarization,
			context: {
				messages: [userMessage(prompts.summarizeWebpage({ webpage_content: rawContent, date: getTodayStr() }))],
			},
			tool: {
				name: "Summary",
				description: "Research summary with key findings.",
				parameters: webpageSummaryStructuredSchema,
			},
			schema: webpageSummaryStructuredSchema,
			maxTokens: run.config.summarizationModelMaxTokens,
			maxRetries: run.config.maxStructuredOutputRetries,
			options: { ...run.config.modelOptions, signal: AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS) },
		});
		accumulateUsage(run.usage, message);
		return `<summary>\n${value.summary}\n</summary>\n\n<key_excerpts>\n${value.key_excerpts}\n</key_excerpts>`;
	} catch {
		return rawContent;
	}
}

/** Execute the search: fetch, dedupe by URL, summarize, and format — mirrors tavily_search() in the Python source. */
export async function tavilySearch(run: RunContext, queries: string[]): Promise<string> {
	const responses = await Promise.all(queries.map(query => tavilySearchOne(run, query)));

	const uniqueResults = new Map<string, { title: string; rawContent: string | null; fallback: string }>();
	for (const response of responses) {
		for (const result of response.results) {
			if (!uniqueResults.has(result.url)) {
				uniqueResults.set(result.url, {
					title: result.title,
					rawContent: result.raw_content ?? null,
					fallback: result.content,
				});
			}
		}
	}

	const entries = [...uniqueResults.entries()];
	const summaries = await Promise.all(
		entries.map(([, result]) =>
			result.rawContent ? summarizeWebpage(run, result.rawContent.slice(0, run.config.maxContentLength)) : null,
		),
	);

	const formatted = entries
		.map(([url, result], index) => ({ url, title: result.title, content: summaries[index] ?? result.fallback }))
		.filter(result => result.content.length > 0);

	if (formatted.length === 0) {
		return "No valid search results found. Please try different search queries or use a different search API.";
	}

	let output = "Search results: \n\n";
	formatted.forEach((result, index) => {
		output += `\n\n--- SOURCE ${index + 1}: ${result.title} ---\n`;
		output += `URL: ${result.url}\n\n`;
		output += `SUMMARY:\n${result.content}\n\n`;
		output += `\n\n${"-".repeat(80)}\n`;
	});
	return output;
}

const tavilySearchParameters = z.object({
	queries: z.array(z.string()).describe("List of search queries to execute"),
});

/** The tavily_search tool exposed to researcher sub-agents (max_results/topic are injected, as in the Python source). */
export function createTavilySearchTool(run: RunContext): ResearchTool {
	return {
		tool: {
			name: "tavily_search",
			description: TAVILY_SEARCH_DESCRIPTION,
			parameters: tavilySearchParameters,
		},
		execute: args => tavilySearch(run, tavilySearchParameters.parse(args).queries),
	};
}
