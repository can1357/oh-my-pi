import type { ToolRenderer } from "./renderer";
/**
 * Web Search TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for web search results.
 */

import type { Component } from "../index";
import { Markdown, Text } from "../index";
import type { RenderResultOptions } from "./renderer";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import {
	formatAge,
	formatCount,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	getDomain,
	PREVIEW_LIMITS,
	replaceTabs,
	truncateToWidth,
} from "../render/render-utils";
import { renderStatusLine, renderTreeList, urlHyperlink } from "../render";
import { framedToolCard } from "../render/tool-card";

const MAX_COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

function renderFallbackText(contentText: string, expanded: boolean, theme: Theme): Component {
	const lines = contentText.split("\n").filter(line => line.trim());
	const maxLines = expanded ? lines.length : 6;
	const displayLines = lines.slice(0, maxLines).map(line => truncateToWidth(line.trim(), 110));
	const remaining = lines.length - displayLines.length;

	const headerIcon = formatStatusIcon("warning", theme);
	const expandHint = formatExpandHint(theme, expanded, remaining > 0);
	let text = `${headerIcon} ${theme.fg("dim", "Response")}${expandHint}`;

	if (displayLines.length === 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", "No response data")}`;
		return new Text(text, 0, 0);
	}

	for (let i = 0; i < displayLines.length; i++) {
		const isLast = i === displayLines.length - 1 && remaining === 0;
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		text += `\n ${theme.fg("dim", branch)} ${theme.fg("dim", displayLines[i])}`;
	}

	if (!expanded && remaining > 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, "line"))}`;
	}

	return new Text(text, 0, 0);
}

/** Search response and optional failure shown in the transcript. */
export interface SearchRenderDetails {
	response: SearchResponse;
	error?: string;
}

/** Render a web search failure as a framed error panel, matching the success layout. */
function renderSearchErrorPanel(message: string, providerLabel: string | undefined, theme: Theme): Component {
	const header = renderStatusLine({ icon: "error", title: "Web Search", description: providerLabel }, theme);
	const body = theme.fg("error", `Error: ${replaceTabs(message)}`);
	return framedToolCard(theme, () => ({
		header,
		phase: "error",
		sections: [{ content: [body] }],
	}));
}

/** Render web search result with tree-based layout */
export function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
	args?: {
		query?: string;
		maxAnswerLines?: number;
	},
): Component {
	const details = result.details;

	// Handle error case as a framed panel, matching the success layout.
	if (details?.error) {
		const errorProvider = details.response?.provider;
		const errorProviderLabel =
			errorProvider && errorProvider !== "none" ? getSearchProviderLabel(errorProvider) : undefined;
		return renderSearchErrorPanel(details.error, errorProviderLabel, theme);
	}

	const rawText = result.content?.find(block => block.type === "text")?.text?.trim() ?? "";
	const response = details?.response;
	if (!response) {
		return renderFallbackText(rawText, options.expanded, theme);
	}

	const sources = Array.isArray(response.sources) ? response.sources : [];
	const sourceCount = sources.length;
	const searchQueries = Array.isArray(response.searchQueries)
		? response.searchQueries.filter(item => typeof item === "string")
		: [];
	const provider = response.provider;

	// Get answer text
	const answerText = typeof response.answer === "string" ? response.answer.trim() : "";
	const contentText = answerText || rawText;

	const providerLabel = provider !== "none" ? getSearchProviderLabel(provider) : "None";
	const queryPreview = args?.query
		? truncateToWidth(args.query, 80)
		: searchQueries[0]
			? truncateToWidth(searchQueries[0], 80)
			: undefined;
	const success = sourceCount > 0;
	const header = renderStatusLine(
		success
			? {
					iconOverride: theme.styledSymbol("tool.webSearch", "accent"),
					title: "Web Search",
					description: providerLabel,
					meta: [formatCount("source", sourceCount)],
				}
			: {
					icon: "warning",
					title: "Web Search",
					description: providerLabel,
					meta: [formatCount("source", sourceCount)],
				},
		theme,
	);

	const authShort =
		response.authMode === "oauth" ? "OAuth" : response.authMode === "api_key" ? "API" : response.authMode;
	let providerInfo = response.model ? `${response.model} @ ${providerLabel}` : providerLabel;
	if (authShort) providerInfo += ` (${authShort})`;
	const metaLines: string[] = [`${theme.fg("muted", "Provider:")} ${theme.fg("text", providerInfo)}`];
	if (response.usage) {
		const usageParts: string[] = [];
		if (response.usage.inputTokens !== undefined) usageParts.push(`in ${response.usage.inputTokens}`);
		if (response.usage.outputTokens !== undefined) usageParts.push(`out ${response.usage.outputTokens}`);
		if (response.usage.totalTokens !== undefined) usageParts.push(`total ${response.usage.totalTokens}`);
		if (response.usage.searchRequests !== undefined) usageParts.push(`search ${response.usage.searchRequests}`);
		if (usageParts.length > 0)
			metaLines.push(`${theme.fg("muted", "Usage:")} ${theme.fg("text", usageParts.join(theme.sep.dot))}`);
	}

	const answerMarkdown = contentText ? new Markdown(contentText, 0, 0, getMarkdownTheme()) : undefined;

	return framedToolCard(theme, ({ width, contentWidth }) => {
		// Read mutable state at render time
		const { expanded } = options;

		// Answer lines: full markdown when expanded, capped markdown preview when collapsed.
		const renderedAnswer = answerMarkdown ? answerMarkdown.render(contentWidth) : [];
		let answerLines: readonly string[];
		if (renderedAnswer.length === 0) {
			answerLines = [theme.fg("muted", "No answer text returned")];
		} else if (args?.maxAnswerLines !== undefined && !expanded) {
			// CLI compact mode (`omp q`) caps the answer; the TUI passes no cap and shows it in full.
			// `renderedAnswer` is the Markdown component's shared cache — slice copies before appending.
			const capped = renderedAnswer.slice(0, args.maxAnswerLines);
			const remaining = renderedAnswer.length - capped.length;
			if (remaining > 0) {
				capped.push(theme.fg("muted", formatMoreItems(remaining, "line")));
			}
			answerLines = capped;
		} else {
			answerLines = renderedAnswer;
		}

		const sourceTree = renderTreeList(
			{
				items: sources,
				expanded,
				maxCollapsed: MAX_COLLAPSED_ITEMS,
				itemType: "source",
				renderItem: src => {
					const titleText =
						typeof src.title === "string" && src.title.trim()
							? src.title
							: typeof src.url === "string" && src.url.trim()
								? src.url
								: "Untitled";
					const url = typeof src.url === "string" ? src.url : "";
					const domain = url ? getDomain(url) : "";
					const age =
						formatAge(src.ageSeconds) || (typeof src.publishedDate === "string" ? src.publishedDate : "");
					const metaParts: string[] = [];
					if (domain) metaParts.push(theme.fg("dim", `(${domain})`));
					if (age) metaParts.push(theme.fg("muted", age));
					const metaSep = theme.fg("dim", theme.sep.dot);
					const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
					// One line per source: the title links to its URL, followed by domain · age.
					// Reserve room for the box borders, the tree branch, and the meta suffix.
					const lineBudget = Math.max(24, width - 6);
					const titleBudget = Math.max(12, lineBudget - Bun.stringWidth(metaSuffix));
					const title = theme.fg("accent", truncateToWidth(titleText, titleBudget));
					const linkedTitle = url ? urlHyperlink(url, title) : title;
					return [`${linkedTitle}${metaSuffix}`];
				},
			},
			theme,
		);

		return {
			header,
			phase: sourceCount > 0 ? "success" : "warning",
			sections: [
				...(queryPreview
					? [
							{
								content: [`${theme.fg("muted", "Query:")} ${theme.fg("text", queryPreview)}`],
							},
						]
					: []),
				{
					label: theme.fg("toolTitle", "Answer"),
					content: answerLines,
				},
				{
					label: theme.fg("toolTitle", "Sources"),
					content: sourceTree.length > 0 ? sourceTree : [theme.fg("muted", "No sources returned")],
				},
				{ label: theme.fg("toolTitle", "Metadata"), content: metaLines },
			],
		};
	});
}

/** Render web search call (query preview) */
export function renderSearchCall(
	args: { query?: string; [key: string]: unknown },
	_options: RenderResultOptions,
	theme: Theme,
): Component {
	const query = truncateToWidth(args.query ?? "", 80);
	const text = renderStatusLine({ icon: "pending", title: "Web Search", description: query }, theme);
	return new Text(text, 0, 0);
}

/** Render web search queries, answers, and cited sources. */
export const webSearchToolRenderer = {
	renderCall: renderSearchCall,
	renderResult: renderSearchResult,
	mergeCallAndResult: true,
} satisfies ToolRenderer<{ query?: string; [key: string]: unknown }, SearchRenderDetails>;

/**
 * Web Search Types
 *
 * Unified types for web search responses across supported providers.
 */

export const SEARCH_PROVIDER_OPTIONS = [
	{
		value: "auto",
		label: "Auto",
		description: "Automatically uses the first configured web-search provider",
	},
	{
		value: "parallel",
		label: "Parallel",
		description: "Uses API auth when configured; otherwise searches through the keyless public MCP",
	},
	{
		value: "perplexity",
		label: "Perplexity",
		description: "Uses auth when configured; explicit selection falls back to anonymous search",
	},
	{
		value: "gemini",
		label: "Gemini",
		description: "Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)",
	},
	{
		value: "anthropic",
		label: "Anthropic",
		description: "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)",
	},
	{
		value: "codex",
		label: "OpenAI",
		description: "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)",
	},
	{
		value: "xai",
		label: "xAI",
		description:
			"Grok web search via xAI Responses API (uses SuperGrok/X Premium+ OAuth via /login xai-oauth, or XAI_API_KEY)",
	},
	{
		value: "openrouter",
		label: "OpenRouter",
		description: "OpenRouter plugins-based web search with model-selected grounding",
	},
	{ value: "zai", label: "Z.AI", description: "Calls Z.AI webSearchPrime MCP" },
	{ value: "exa", label: "Exa", description: "API via /login exa or EXA_API_KEY; explicit keyless fallback via MCP" },
	{ value: "tinyfish", label: "TinyFish", description: "Requires TINYFISH_API_KEY" },
	{ value: "jina", label: "Jina", description: "Requires JINA_API_KEY" },
	{ value: "kagi", label: "Kagi", description: "Requires KAGI_API_KEY and Kagi Search API beta access" },
	{ value: "tavily", label: "Tavily", description: "Requires TAVILY_API_KEY" },
	{
		value: "firecrawl",
		label: "Firecrawl",
		description: "Uses Firecrawl API when FIRECRAWL_API_KEY is set; falls back to keyless mode",
	},
	{ value: "brave", label: "Brave", description: "Requires BRAVE_API_KEY" },
	{
		value: "kimi",
		label: "Kimi",
		description:
			"Kimi Code search (requires a Kimi Code Console key via KIMI_SEARCH_API_KEY/MOONSHOT_SEARCH_API_KEY or /login kimi-code; not MOONSHOT_API_KEY)",
	},
	{ value: "synthetic", label: "Synthetic", description: "Requires SYNTHETIC_API_KEY" },
	{ value: "ollama", label: "Ollama", description: "Requires OLLAMA_CLOUD_API_KEY" },
	{ value: "searxng", label: "SearXNG", description: "Requires SEARXNG_ENDPOINT or searxng.endpoint" },
	{
		value: "startpage",
		label: "Startpage",
		description: "Credential-free scrape of Startpage (Google-backed) results; may be bot-challenged",
	},
	{
		value: "duckduckgo",
		label: "DuckDuckGo",
		description: "Credential-free best-effort fallback; may be bot-challenged on datacenter/shared-egress IPs",
	},
	{
		value: "ecosia",
		label: "Ecosia",
		description: "Credential-free browser-backed scrape of Ecosia (Google-backed) results",
	},
	{
		value: "google",
		label: "Google",
		description: "Credential-free browser-backed fallback; slower and may be bot-challenged",
	},
	{
		value: "mojeek",
		label: "Mojeek",
		description: "Credential-free browser-backed scrape of Mojeek's independent index",
	},
	{
		value: "public",
		label: "Public Web",
		description: "Queries every credential-free engine in parallel and consolidates deduplicated results",
	},
] as const;

/** Supported web search providers (every option except `auto`). */
export type SearchProviderId = Exclude<(typeof SEARCH_PROVIDER_OPTIONS)[number]["value"], "auto">;

/** Display labels, derived from {@link SEARCH_PROVIDER_OPTIONS}. */
export const SEARCH_PROVIDER_LABELS = Object.fromEntries(
	SEARCH_PROVIDER_OPTIONS.flatMap(option => (option.value === "auto" ? [] : [[option.value, option.label] as const])),
) as Record<SearchProviderId, string>;

/** Source returned by search (all providers) */
export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	/** ISO date string or relative ("2d ago") */
	publishedDate?: string;
	/** Age in seconds for consistent formatting */
	ageSeconds?: number;
	author?: string;
}

/** Citation with text reference (LLM-mediated providers) */
export interface SearchCitation {
	url: string;
	title: string;
	citedText?: string;
}

/** Usage metrics */
export interface SearchUsage {
	inputTokens?: number;
	outputTokens?: number;
	/** Anthropic: number of web search requests made */
	searchRequests?: number;
	/** Perplexity: combined token count */
	totalTokens?: number;
}

/** Unified response across providers */
export interface SearchResponse {
	provider: SearchProviderId | "none";
	/** Synthesized answer text (LLM-mediated providers) */
	answer?: string;
	/** Search result sources */
	sources: SearchSource[];
	/** Text citations with context */
	citations?: SearchCitation[];
	/** Intermediate search queries (anthropic) */
	searchQueries?: string[];
	/** Follow-up question suggestions (provider-dependent) */
	relatedQuestions?: string[];
	/** Token usage metrics */
	usage?: SearchUsage;
	/** Model used */
	model?: string;
	/** Request ID for debugging */
	requestId?: string;
	/** Authentication mode used by the provider (e.g. oauth, api-key) */
	authMode?: string;
}

/** Cheap, sync metadata accessor — never triggers a provider load. */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return SEARCH_PROVIDER_LABELS[id] ?? id;
}
