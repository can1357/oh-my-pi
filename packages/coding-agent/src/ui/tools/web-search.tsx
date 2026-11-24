/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Web search: the query as the head target, the provider and source count as
 * meta, the model as a badge; the answer as markdown, then the sources (site
 * letter, linked title, domain and age).
 *
 * Terminal look: `web_search` (`src/ui/styles/tools/web-search.ts`): a card
 * with Query / Answer / Sources / Metadata sections; plain-text results as a
 * `Response` tree.
 */
import type { ToolHead, ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";
import { flatText } from "./search-common";

/** The args web search shows. */
export interface WebSearchArgs {
	readonly query?: string;
	/** Answer rows shown while collapsed. */
	readonly maxAnswerLines?: number;
}

/** One cited source. */
export interface WebSearchSource {
	readonly title?: string;
	readonly url: string;
	readonly ageSeconds?: number;
}

/** A provider's response. */
export interface WebSearchResponse {
	readonly provider?: string;
	/** How the provider was reached (`api_key`, `oauth`). */
	readonly authMode?: string;
	readonly answer?: string;
	readonly sources?: readonly WebSearchSource[];
	readonly model?: string;
	readonly usage?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly totalTokens?: number;
		readonly searchRequests?: number;
	};
}

/** Result details web search reports. */
export interface WebSearchDetails {
	readonly response?: WebSearchResponse;
	readonly error?: string;
}

/** A source as the terminal lists it. */
export interface WebSearchTermSource {
	readonly title: string;
	readonly domain: string;
	/** `1d`, `3w`. */
	readonly age?: string;
	/** The page the title links to. */
	readonly url?: string;
}

/** Terminal facts of the `web_search` look. */
export type WebSearchTerm = {
	readonly look: "web_search";
	readonly result?: boolean;
	readonly query?: string;
	readonly provider?: string;
	readonly sourceCount?: number;
	/** Markdown answer. */
	readonly answer?: string;
	/** Plain answer text (no markdown answer). */
	readonly fallback?: string;
	readonly sources?: readonly WebSearchTermSource[];
	readonly maxAnswerLines?: number;
	/** `m @ Anthropic`. */
	readonly providerLine?: string;
	readonly usage?: string;
	readonly error?: string;
	/** Plain-text result lines (no response details). */
	readonly lines?: readonly string[];
};

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	openai: "OpenAI",
	xai: "xAI",
	perplexity: "Perplexity",
	anthropic: "Anthropic",
	exa: "Exa",
	gemini: "Gemini",
	brave: "Brave",
	kagi: "Kagi",
	jina: "Jina",
	tavily: "Tavily",
};

const AUTH_MODES: Readonly<Record<string, string>> = { api_key: "API", oauth: "OAuth" };

/** A provider id as people read it. */
export function providerName(provider: string | undefined): string {
	if (!provider) return "Web";
	return PROVIDER_NAMES[provider] ?? `${provider[0]!.toUpperCase()}${provider.slice(1)}`;
}

/** A source's age: `5m`, `3h`, `2d`, `1w`, `4mo`, `2y`; none when fresh. */
export function formatAge(seconds: number | undefined): string | undefined {
	if (!seconds || seconds < 60) return undefined;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function searchHead(args: WebSearchArgs | undefined, extra?: Partial<ToolHead>): ToolHead {
	return {
		title: "Web search",
		...(args?.query ? { target: args.query } : {}),
		targetKind: "query",
		...extra,
	};
}

function usageText(usage: WebSearchResponse["usage"]): string | undefined {
	if (!usage) return undefined;
	const parts: string[] = [];
	if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
	if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
	if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`);
	if (usage.searchRequests !== undefined) parts.push(`search ${usage.searchRequests}`);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export const webSearchPresenter: ToolPresenter<WebSearchArgs, WebSearchDetails> = {
	merge: true,
	call: args => ({
		head: searchHead(args),
		inline: true,
		term: { look: "web_search", query: args?.query } satisfies WebSearchTerm,
	}),
	result(result, _state, args): ToolView {
		const response = result.details?.response;
		const query = args?.query;
		if (!response) {
			const text = resultText(result).trim();
			const message = text || "No response data";
			return {
				head: searchHead(args),
				tone: "warning",
				body: <text spans={[{ s: "muted", t: message }]} wrap="word" />,
				term: {
					look: "web_search",
					result: true,
					lines: text ? text.split("\n") : [],
				} satisfies WebSearchTerm,
			};
		}
		const provider = providerName(response.provider);
		const error = result.details?.error;
		if (error) {
			const message = flatText(error);
			return {
				head: searchHead(args, { meta: [provider] }),
				tone: "error",
				body: <text role="omp.tool.error" spans={[{ s: "error", t: message }]} wrap="word" />,
				term: {
					look: "web_search",
					result: true,
					query,
					provider,
					error: message,
				} satisfies WebSearchTerm,
			};
		}
		const sources = response.sources ?? [];
		const usage = usageText(response.usage);
		const auth = response.authMode ? AUTH_MODES[response.authMode] : undefined;
		const reached = auth ? `${provider} (${auth})` : provider;
		const providerLine = response.model ? `${response.model} @ ${reached}` : reached;
		const detail = usage ? `${providerLine}\n${usage}` : providerLine;
		const answer = response.answer?.trimEnd();
		const fallback = answer ? undefined : resultText(result).trim();
		const termSources = sources.map(source => {
			const domain = domainOf(source.url);
			return {
				title: flatText(source.title || domain),
				domain,
				age: formatAge(source.ageSeconds),
				...(source.url ? { url: source.url } : {}),
			};
		});
		return {
			head: searchHead(args, {
				meta: [`${provider} · ${sources.length} ${sources.length === 1 ? "source" : "sources"}`],
				...(response.model ? { badges: [{ text: response.model, title: detail }] } : {}),
			}),
			...(answer ? {} : { tone: "warning" as const }),
			body: [
				answer ? (
					<md key="answer" text={answer} title={detail} />
				) : fallback ? (
					<text spans={[{ s: "muted", t: fallback }]} wrap="word" />
				) : undefined,
				sources.length > 0 ? (
					<col key="sources" role="omp.tool.sources">
						{sources.map((source, i) => {
							const { title, domain, age } = termSources[i]!;
							return (
								<row
									key={`${i}:${source.url}`}
									role="omp.tool.source"
									gap="sm"
									align="baseline"
									href={source.url}
								>
									<badge text={domain[0]?.toUpperCase() ?? "?"} title={domain} />
									<text spans={[{ s: "link", t: title, href: source.url }]} lines={2} truncate="end" />
									<text spans={[{ s: "muted", t: age ? `${domain} · ${age}` : domain }]} lines={1} />
								</row>
							);
						})}
					</col>
				) : (
					<text spans={[{ s: "muted", t: "No sources returned" }]} wrap="word" />
				),
			],
			term: {
				look: "web_search",
				result: true,
				query,
				provider,
				sourceCount: sources.length,
				answer,
				fallback,
				sources: termSources,
				maxAnswerLines: args?.maxAnswerLines,
				providerLine,
				usage,
			} satisfies WebSearchTerm,
		};
	},
};

registerToolPresenter("web_search", webSearchPresenter);
