/**
 * Hacker News search provider.
 *
 * Queries the public, keyless HN Search API (Algolia), which indexes every
 * story and comment; general web engines index HN threads sparsely and late.
 * The search pipeline routes queries scoped to `site:news.ycombinator.com`
 * here first.
 */
import { tryParseJson } from "@oh-my-pi/pi-utils";
import { decodeHNText } from "../../scrapers/hackernews";
import { formatQuery, parseSearchQuery, type QuerySyntax, type StructuredQuery } from "../query";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types";
import { clampNumResults, dateToAgeSeconds, recencyAfterDate } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, normalizeSearchText, readLimitedText, withHardTimeout } from "./utils";

/** Relevance-ranked endpoint; ties break on points, then comment count. */
const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search";
const HN_ITEM_URL = "https://news.ycombinator.com/item?id=";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 30;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

/** Item kinds searched, as Algolia `tags` values. */
type HNKind = "story" | "comment";

/** One hit of the HN Search API, as far as omp reads it. */
interface HNHit {
	objectID?: string | null;
	author?: string | null;
	created_at?: string | null;
	/** Stories only. */
	title?: string | null;
	/** Link a story submits; absent on text posts (Ask HN). */
	url?: string | null;
	story_text?: string | null;
	points?: number | null;
	num_comments?: number | null;
	/** Comments only. */
	comment_text?: string | null;
	/** Title of the story a comment belongs to. */
	story_title?: string | null;
}

/**
 * Algolia `advancedSyntax` parses quoted phrases and `-exclusions`. It has no
 * `OR` and requires every word, so alternatives are sent as plain keywords and
 * named in `optionalWords`.
 */
const HN_QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true };

/**
 * Keyword query for a parsed search. `intitle:`/`intext:`/`inurl:` values join
 * the keywords, since Algolia matches title, text, and link URL in one query.
 * Empty for a query that only carries directives, which lists the
 * highest-scored stories of the date range.
 */
function keywordQuery(parsed: StructuredQuery): string {
	const scoped = [...parsed.inTitle, ...parsed.inText, ...parsed.inUrl].map(text => ({ text }));
	const terms = [...parsed.terms, ...scoped];
	return terms.length > 0 ? formatQuery({ ...parsed, terms }, HN_QUERY_SYNTAX) : "";
}

/**
 * `created_at_i` bounds in epoch seconds, from UTC-midnight ISO dates:
 * `after:` is inclusive and `before:` exclusive, like the directives; without
 * either, `recency` sets the lower bound.
 */
function dateFilters(parsed: StructuredQuery, recency: SearchParams["recency"]): string[] {
	const start = parsed.after ?? (recency && !parsed.before ? recencyAfterDate(recency) : undefined);
	const filters: string[] = [];
	if (start) filters.push(`created_at_i>=${Date.parse(start) / 1000}`);
	if (parsed.before) filters.push(`created_at_i<${Date.parse(parsed.before) / 1000}`);
	return filters;
}

async function fetchHits(params: SearchParams, url: string): Promise<HNHit[]> {
	const response = await (params.fetch ?? fetch)(url, {
		headers: { Accept: "application/json" },
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});
	if (!response.ok) {
		const errorText = await readLimitedText(response, "hackernews", MAX_ERROR_BYTES, true);
		throw (
			classifyProviderHttpError("hackernews", response.status, errorText) ??
			new SearchProviderError(
				"hackernews",
				`Hacker News search error (${response.status}): ${errorText}`,
				response.status,
			)
		);
	}
	const data = tryParseJson<{ hits?: HNHit[] | null }>(
		await readLimitedText(response, "hackernews", MAX_RESPONSE_BYTES),
	);
	if (!data) throw new SearchProviderError("hackernews", "Hacker News search returned invalid JSON", 502);
	return data.hits ?? [];
}

/** Score, discussion size, and submitter, then the submitted link and any text body. */
function storySnippet(hit: HNHit, text: string | undefined): string {
	const stats = [`${hit.points ?? 0} points`, `${hit.num_comments ?? 0} comments`];
	if (hit.author) stats.push(`by ${hit.author}`);
	return [stats.join(", "), hit.url, text].filter(Boolean).join(" — ");
}

function commentTitle(hit: HNHit): string {
	const by = hit.author ? `Comment by ${hit.author}` : "Comment";
	return hit.story_title ? `${by} on: ${hit.story_title}` : by;
}

/**
 * Source for one hit, linking the HN item page rather than a story's
 * submitted link, so results satisfy the `site:` scope and `read` renders the
 * discussion. Undefined for a hit without an id.
 */
function toSource(hit: HNHit, kind: HNKind): SearchSource | undefined {
	if (!hit.objectID) return undefined;
	const url = `${HN_ITEM_URL}${hit.objectID}`;
	// Bodies are HTML; snippets are single-line text.
	const html = kind === "story" ? hit.story_text : hit.comment_text;
	const text = html ? normalizeSearchText(decodeHNText(html)) : undefined;
	return {
		title: kind === "story" ? hit.title || url : commentTitle(hit),
		url,
		snippet: kind === "story" ? storySnippet(hit, text) : text,
		publishedDate: hit.created_at ?? undefined,
		ageSeconds: dateToAgeSeconds(hit.created_at),
		author: hit.author ?? undefined,
	};
}

/** Stories lead and take half the slots, comments the rest; either kind backfills the other's shortfall. */
function mergeSources(stories: SearchSource[], comments: SearchSource[], count: number): SearchSource[] {
	const picked = stories.slice(0, Math.max(Math.ceil(count / 2), count - comments.length));
	return [...picked, ...comments.slice(0, count - picked.length)];
}

/**
 * Search Hacker News stories and comments by relevance.
 *
 * # Errors
 * {@link SearchProviderError} on a non-2xx response or an unparsable body;
 * transport failures and timeouts propagate from `fetch`.
 */
export async function searchHackerNews(params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const count = Math.floor(
		clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	);
	const keywords = keywordQuery(parsed);
	const query = new URLSearchParams({ query: keywords, advancedSyntax: "true", hitsPerPage: String(count) });
	// Words of `OR` alternatives: Algolia stops requiring them and ranks hits
	// matching more of them first. A quoted alternative degrades to its words.
	const optional = parsed.terms.filter(term => term.group !== undefined && !term.negated).map(term => term.text);
	if (optional.length > 0) query.set("optionalWords", optional.join(" "));
	const filters = dateFilters(parsed, params.recency);
	if (filters.length > 0) query.set("numericFilters", filters.join(","));

	const search = async (kind: HNKind): Promise<SearchSource[]> => {
		const hits = await fetchHits(params, `${HN_SEARCH_URL}?${query}&tags=${kind}`);
		return hits.flatMap(hit => toSource(hit, kind) ?? []);
	};
	// Stories and comments rank on separate scales, so each kind gets its own
	// request. Comments carry no score: a keyword-less listing is stories only.
	const [stories, comments] = await Promise.all([search("story"), keywords ? search("comment") : []]);
	return { provider: "hackernews", sources: mergeSources(stories, comments, count) };
}

/** Search provider for Hacker News stories and comments (HN Search API, no API key). */
export class HackerNewsProvider extends SearchProvider {
	readonly id = "hackernews";
	readonly label = "Hacker News";

	isAvailable(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchHackerNews(params);
	}
}
