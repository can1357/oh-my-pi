import { afterAll, afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchHackerNews } from "@oh-my-pi/pi-coding-agent/web/search/providers/hackernews";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const { modelRegistry, model: hackerNewsModel } = (() => {
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("web", "hackernews");
	if (!model) throw new Error("Expected bundled web/hackernews model");
	return { modelRegistry, model };
})();

afterAll(() => {
	authStorage.close();
});

type Hit = Record<string, unknown>;

/** Serves `hits` per requested `tags` kind and records every request URL. */
function captureFetch(hits: { story?: Hit[]; comment?: Hit[] } = {}, status = 200) {
	const urls: URL[] = [];
	const fetchMock: FetchImpl = input => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		urls.push(url);
		const kind = url.searchParams.get("tags") === "comment" ? "comment" : "story";
		return Promise.resolve(
			new Response(JSON.stringify(status === 200 ? { hits: hits[kind] ?? [] } : { message: "Too many requests" }), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);
	};
	return { fetchMock, urls };
}

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage,
		model: hackerNewsModel,
		modelRegistry,
		systemPrompt: "Hacker News search test prompt",
		fetch,
	};
}

function ids(prefix: string, count: number): Hit[] {
	return Array.from({ length: count }, (_, index) => ({
		objectID: `${prefix}${index + 1}`,
		title: `${prefix}${index + 1}`,
	}));
}

describe("Hacker News search provider", () => {
	afterEach(() => {
		setSystemTime();
	});

	it("maps phrases, exclusions, OR alternatives, field directives, and date bounds onto Algolia parameters", async () => {
		const capture = captureFetch();

		await searchHackerNews({
			...makeParams(
				'"zig rewrite" (bun OR deno) -node intitle:compiler site:news.ycombinator.com after:2026-10-01 before:2026-10-08',
				capture.fetchMock,
			),
			limit: 6,
		});

		const shared = {
			query: '"zig rewrite" bun deno -node compiler',
			advancedSyntax: "true",
			hitsPerPage: "6",
			optionalWords: "bun deno",
			numericFilters: "created_at_i>=1790812800,created_at_i<1791417600",
		};
		expect(capture.urls.map(url => url.origin + url.pathname)).toEqual([
			"https://hn.algolia.com/api/v1/search",
			"https://hn.algolia.com/api/v1/search",
		]);
		expect(capture.urls.map(url => Object.fromEntries(url.searchParams))).toEqual([
			{ ...shared, tags: "story" },
			{ ...shared, tags: "comment" },
		]);
	});

	it.each<[string, string, string | null]>([
		["recency alone sets the lower bound", "tern", `created_at_i>=${Date.parse("2026-11-04") / 1000}`],
		["after: replaces the recency bound", "tern after:2026-01-01", "created_at_i>=1767225600"],
		["before: suppresses the recency bound", "tern before:2026-01-01", "created_at_i<1767225600"],
	])("%s", async (_caseName, query, numericFilters) => {
		setSystemTime(new Date("2026-11-11T12:00:00Z"));
		const capture = captureFetch();

		await searchHackerNews({ ...makeParams(query, capture.fetchMock), recency: "week" });

		expect(capture.urls[0]?.searchParams.get("numericFilters")).toBe(numericFilters);
	});

	it("lists stories only, unfiltered by keyword or date, for a query that carries only a site directive", async () => {
		const capture = captureFetch({ story: ids("s", 2) });

		const response = await searchHackerNews(makeParams("site:news.ycombinator.com", capture.fetchMock));

		expect(capture.urls.map(url => Object.fromEntries(url.searchParams))).toEqual([
			{ query: "", advancedSyntax: "true", hitsPerPage: "10", tags: "story" },
		]);
		expect(response.sources.map(source => source.title)).toEqual(["s1", "s2"]);
	});

	it("links HN item pages and renders story stats and comment HTML as text snippets", async () => {
		setSystemTime(new Date("2026-07-08T11:00:00Z"));
		const capture = captureFetch({
			story: [
				{
					objectID: "101",
					title: "Rewriting Bun in Rust",
					url: "https://bun.sh/blog/rust",
					author: "jarred",
					points: 795,
					num_comments: 534,
					created_at: "2026-07-08T10:00:00Z",
				},
				{
					objectID: "102",
					title: "Ask HN: Why rewrite?",
					author: "pg",
					points: 12,
					num_comments: 3,
					story_text: "I&#x27;m curious.<p>Why <i>now</i>?",
				},
				{ title: "Hit without an id" },
			],
			comment: [
				{
					objectID: "201",
					author: "simonw",
					story_title: "Cloudflare acquires Deno",
					comment_text:
						'&gt; a full rewrite<p>Considering <a href="https:&#x2F;&#x2F;example.com&#x2F;x" rel="nofollow">this</a> was fast.',
				},
			],
		});

		const response = await searchHackerNews(makeParams("bun rust rewrite", capture.fetchMock));

		expect(response.provider).toBe("hackernews");
		expect(response.sources).toEqual([
			{
				title: "Rewriting Bun in Rust",
				url: "https://news.ycombinator.com/item?id=101",
				snippet: "795 points, 534 comments, by jarred — https://bun.sh/blog/rust",
				publishedDate: "2026-07-08T10:00:00Z",
				ageSeconds: 3600,
				author: "jarred",
			},
			{
				title: "Ask HN: Why rewrite?",
				url: "https://news.ycombinator.com/item?id=102",
				snippet: "12 points, 3 comments, by pg — I'm curious. Why *now*?",
				publishedDate: undefined,
				ageSeconds: undefined,
				author: "pg",
			},
			{
				title: "Comment by simonw on: Cloudflare acquires Deno",
				url: "https://news.ycombinator.com/item?id=201",
				snippet: "> a full rewrite Considering [this](https://example.com/x) was fast.",
				publishedDate: undefined,
				ageSeconds: undefined,
				author: "simonw",
			},
		]);
	});

	it.each<[string, number, number, string[]]>([
		["splits the slots evenly, stories first", 4, 4, ["s1", "s2", "c1", "c2"]],
		["backfills missing stories with comments", 1, 4, ["s1", "c1", "c2", "c3"]],
		["backfills missing comments with stories", 4, 1, ["s1", "s2", "s3", "c1"]],
	])("%s", async (_caseName, storyCount, commentCount, expected) => {
		const capture = captureFetch({ story: ids("s", storyCount), comment: ids("c", commentCount) });

		const response = await searchHackerNews({ ...makeParams("tern", capture.fetchMock), limit: 4 });

		expect(response.sources.map(source => source.url.split("=")[1])).toEqual(expected);
	});

	it("surfaces a non-2xx response as a provider error carrying the status", async () => {
		const capture = captureFetch({}, 429);

		const failure = searchHackerNews(makeParams("tern", capture.fetchMock));

		await expect(failure).rejects.toBeInstanceOf(SearchProviderError);
		await expect(failure).rejects.toMatchObject({ provider: "hackernews", status: 429 });
	});
});
