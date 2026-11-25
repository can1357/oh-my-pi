/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Web search: the query as the head target, the provider and source count as
 * meta, the model as a badge; the answer as markdown, then the sources (site
 * letter, linked title, domain and age). When there is no answer, the
 * sources carry their own excerpts instead.
 *
 * Terminal look: `web_search` (`src/ui/styles/tools/web-search.ts`): a card
 * with Query / Answer / Sources / Metadata sections; plain-text results as a
 * `Response` tree.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { PREVIEW_LIMITS, sanitizeDisplayLines } from "../../utils/render-utils";
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
	readonly url?: string;
	readonly ageSeconds?: number;
	readonly publishedDate?: string;
	readonly snippet?: string;
}

/** A provider's response. */
export interface WebSearchResponse {
	readonly provider?: string;
	/** How the provider was reached (`api_key`, `oauth`). */
	readonly authMode?: string;
	readonly answer?: string;
	readonly searchQueries?: readonly string[];
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
	/** Publication date when a relative age is unavailable. */
	readonly publishedDate?: string;
	/** Sanitized page excerpts when no synthesized answer is available. */
	readonly excerpt?: readonly string[];
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
	/** Plain answer lines when neither an answer nor any sources were returned. */
	readonly fallback?: readonly string[];
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

const EXCERPT_LINES = PREVIEW_LIMITS.COLLAPSED_LINES;

function excerptLines(snippet: string | undefined): string[] | undefined {
	if (!snippet) return undefined;
	const lines: string[] = [];
	for (const raw of sanitizeDisplayLines(snippet)) {
		const line = raw.replace(/\s+/g, " ").trim();
		if (!/[\p{L}\p{N}]/u.test(line)) continue;
		lines.push(line);
		if (lines.length === EXCERPT_LINES) break;
	}
	return lines.length > 0 ? lines : undefined;
}

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

function searchHead(query: string | undefined, extra?: Partial<ToolHead>): ToolHead {
	return {
		title: "Web search",
		...(query ? { target: query } : {}),
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

/** Present search answers and linked sources in the transcript. */
export const webSearchPresenter: ToolPresenter<WebSearchArgs, WebSearchDetails> = {
	merge: true,
	call: args => ({
		head: searchHead(args?.query),
		inline: true,
		term: { look: "web_search", query: args?.query } satisfies WebSearchTerm,
	}),
	result(result, _state, args): ToolView {
		const response = result.details?.response;
		const rawQuery = args?.query || response?.searchQueries?.[0];
		const query = rawQuery ? flatText(sanitizeText(rawQuery)) : undefined;
		if (!response) {
			const text = resultText(result).trim();
			const message = text || "No response data";
			return {
				head: searchHead(query),
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
				head: searchHead(args?.query, { meta: [provider] }),
				tone: "error",
				body: <text role="omp.tool.error" spans={[{ s: "error", t: message }]} wrap="word" />,
				term: {
					look: "web_search",
					result: true,
					query: args?.query,
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
		// Without a synthesized answer the raw text repeats the source listing.
		let fallback: string[] | undefined;
		if (!answer && sources.length === 0) {
			fallback = sanitizeDisplayLines(resultText(result).trim()).filter(line => line.trim());
			if (fallback.length === 0) fallback.push("No answer text returned");
		}
		const termSources = sources.map((source): WebSearchTermSource => {
			const url = source.url?.trim() || undefined;
			const age = formatAge(source.ageSeconds);
			return {
				title: flatText(sanitizeText(source.title?.trim() || url || "Untitled")),
				domain: url ? flatText(sanitizeText(domainOf(url))) : "",
				age,
				publishedDate: !age && source.publishedDate ? flatText(sanitizeText(source.publishedDate)) : undefined,
				excerpt: answer ? undefined : excerptLines(source.snippet),
				url,
			};
		});
		return {
			head: searchHead(query, {
				meta: [`${provider} · ${sources.length} ${sources.length === 1 ? "source" : "sources"}`],
				...(response.model ? { badges: [{ text: response.model, title: detail }] } : {}),
			}),
			tone: sources.length === 0 ? "warning" : undefined,
			body: [
				answer ? (
					<md key="answer" text={answer} title={detail} />
				) : fallback ? (
					<text spans={[{ s: "muted", t: fallback.join("\n") }]} wrap="word" />
				) : undefined,
				sources.length > 0 ? (
					<col key="sources" role="omp.tool.sources">
						{termSources.map(({ title, domain, age, publishedDate, excerpt, url }, i) => {
							const date = age || publishedDate;
							const meta = domain && date ? `${domain} · ${date}` : domain || date;
							return (
								<row key={`${i}:${url ?? ""}`} role="omp.tool.source" gap="sm" align="baseline" href={url}>
									<badge text={domain[0]?.toUpperCase() ?? "?"} title={domain || undefined} />
									<text spans={[{ s: "link", t: title, href: url }]} lines={2} truncate="end" />
									{meta ? <text spans={[{ s: "muted", t: meta }]} lines={1} /> : undefined}
									{excerpt ? (
										<text
											role="omp.tool.excerpt"
											spans={[{ s: "muted", t: excerpt.join("\n") }]}
											wrap="word"
											lines={EXCERPT_LINES}
										/>
									) : undefined}
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
