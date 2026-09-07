/**
 * Central directive pipeline: executeSearch parses the query once, hands the
 * StructuredQuery to the provider, then lenient-filters the returned sources
 * — enforcing constraints the provider ignored and relaxing (with a note)
 * any dimension that would eliminate every result.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchProviderId, SearchResponse, SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";

const SOURCES: SearchSource[] = [
	{ title: "Docs page", url: "https://docs.example.com/guide" },
	{ title: "Blog post", url: "https://blog.other.com/post" },
];

interface ProviderStub {
	id: SearchProviderId;
	behaviour: (params: SearchParams) => Promise<SearchResponse>;
	explicit?: boolean;
	available?: boolean;
	explicitlyAvailable?: boolean;
}

function stubProviders(stubs: ProviderStub[]): SearchProviderId[] {
	const requested: SearchProviderId[] = [];
	vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue(
		stubs.map(({ id, explicit = true }) => ({ id, explicit })),
	);
	vi.spyOn(provider, "getSearchProvider").mockImplementation(async providerId => {
		requested.push(providerId);
		const entry = stubs.find(({ id }) => id === providerId);
		if (!entry) throw new Error(`Unexpected provider: ${providerId}`);
		return {
			id: entry.id,
			label: provider.getSearchProviderLabel(entry.id),
			isAvailable: () => entry.available ?? true,
			isExplicitlyAvailable: () => entry.explicitlyAvailable ?? true,
			search: entry.behaviour,
		};
	});
	return requested;
}

async function initializeFanout(value: number): Promise<void> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "providers.webSearchFanout": value } });
}

describe("web search directive pipeline", () => {
	afterEach(() => vi.restoreAllMocks());

	it("passes the parsed query to the provider and post-filters sources it did not constrain", async () => {
		let seen: SearchParams | undefined;
		stubProviders([
			{
				id: "brave",
				behaviour: async params => {
					seen = params;
					return { provider: "brave", sources: SOURCES };
				},
			},
		]);

		const result = await runSearchQuery(
			{ query: "guide site:docs.example.com", provider: "brave" },
			{ authStorage: {} as AuthStorage },
		);

		expect(seen?.parsedQuery?.sites).toEqual(["docs.example.com"]);
		expect(seen?.parsedQuery?.text).toBe("guide");
		expect(result.details.response.sources.map(s => s.url)).toEqual(["https://docs.example.com/guide"]);
		expect(result.content[0]?.text).not.toContain("Note:");
	});

	it("relaxes a constraint that matches nothing and leads the LLM text with a note", async () => {
		stubProviders([
			{
				id: "brave",
				behaviour: async () => ({ provider: "brave", sources: SOURCES }),
			},
		]);
		const result = await runSearchQuery(
			{ query: "guide site:nowhere.example", provider: "brave" },
			{ authStorage: {} as AuthStorage },
		);

		// Leniency: nothing matched site:nowhere.example, so all sources survive
		// and the model is told the constraint was relaxed.
		expect(result.details.response.sources).toHaveLength(SOURCES.length);
		expect(result.content[0]?.text).toStartWith(
			"Note: no results matched `site:nowhere.example`; the constraint was relaxed",
		);
	});
});

describe("web search fanout", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps sequential fallback output byte-for-byte unchanged when fanout is one", async () => {
		await initializeFanout(1);
		const attempts: SearchProviderId[] = [];
		stubProviders([
			{
				id: "brave",
				behaviour: async () => {
					attempts.push("brave");
					throw new Error("Brave unavailable");
				},
			},
			{
				id: "tavily",
				behaviour: async () => {
					attempts.push("tavily");
					return {
						provider: "tavily",
						answer: "Tavily answer",
						sources: [{ title: "Tavily result", url: "https://tavily.example", snippet: "tavily" }],
					};
				},
			},
		]);

		const result = await runSearchQuery({ query: "provider fallback" }, { authStorage: {} as AuthStorage });

		expect(attempts).toEqual(["brave", "tavily"]);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Tavily answer\n\n## Sources\n1 source\n[1] Tavily result\n    https://tavily.example\n    tavily",
			},
		]);
		expect(result.details).toEqual({
			response: {
				provider: "tavily",
				answer: "Tavily answer",
				sources: [{ title: "Tavily result", url: "https://tavily.example", snippet: "tavily" }],
			},
		});
	});

	it("queries two providers concurrently and preserves configured section order", async () => {
		await initializeFanout(2);
		const braveResult = Promise.withResolvers<SearchResponse>();
		const braveStarted = Promise.withResolvers<void>();
		const tavilyResult = Promise.withResolvers<SearchResponse>();
		const requested = stubProviders([
			{
				id: "brave",
				behaviour: async () => {
					braveStarted.resolve();
					return braveResult.promise;
				},
			},
			{
				id: "tavily",
				behaviour: async () => tavilyResult.promise,
			},
		]);

		const resultPromise = runSearchQuery({ query: "parallel providers" }, { authStorage: {} as AuthStorage });
		await braveStarted.promise;
		const requestedBeforeEitherSettled = [...requested];
		braveResult.resolve({ provider: "brave", answer: "Brave answer", sources: [] });
		tavilyResult.resolve({ provider: "tavily", answer: "Tavily answer", sources: [] });
		const result = await resultPromise;

		expect(requestedBeforeEitherSettled).toEqual(["brave", "tavily"]);
		expect(result.content[0]?.text).toBe("## brave\nBrave answer\n\n## tavily\nTavily answer");
		expect(result.details.results?.map(entry => entry.details.response.provider)).toEqual(["brave", "tavily"]);
	});

	it("keeps a successful provider visible when its peer fails", async () => {
		await initializeFanout(2);
		stubProviders([
			{
				id: "brave",
				behaviour: async () => {
					throw new Error("Brave failed");
				},
			},
			{
				id: "tavily",
				behaviour: async () => ({ provider: "tavily", answer: "Tavily survived", sources: [] }),
			},
		]);

		const result = await runSearchQuery({ query: "partial failure" }, { authStorage: {} as AuthStorage });

		expect(result.content[0]?.text).toBe("## brave\nError: Brave failed\n\n## tavily\nTavily survived");
		expect(result.details.error).toBeUndefined();
		expect(result.details.results?.map(entry => entry.details.error)).toEqual(["Brave failed", undefined]);
	});

	it("returns an aggregate error only when every selected provider fails", async () => {
		await initializeFanout(2);
		stubProviders([
			{
				id: "brave",
				behaviour: async () => {
					throw new Error("Brave failed");
				},
			},
			{
				id: "tavily",
				behaviour: async () => {
					throw new Error("Tavily failed");
				},
			},
		]);

		const result = await runSearchQuery({ query: "total failure" }, { authStorage: {} as AuthStorage });

		expect(result.details.error).toBe("All web search providers failed: brave: Brave failed; tavily: Tavily failed");
		expect(result.content[0]?.text).toBe(
			"Error: All web search providers failed: brave: Brave failed; tavily: Tavily failed\n\n## brave\nError: Brave failed\n\n## tavily\nError: Tavily failed",
		);
	});

	it("skips unavailable implicit candidates without dropping explicit failures", async () => {
		await initializeFanout(2);
		const queried: SearchProviderId[] = [];
		stubProviders([
			{
				id: "brave",
				explicit: true,
				explicitlyAvailable: false,
				behaviour: async () => {
					queried.push("brave");
					return { provider: "brave", answer: "unexpected", sources: [] };
				},
			},
			{
				id: "perplexity",
				explicit: false,
				available: false,
				behaviour: async () => {
					queried.push("perplexity");
					return { provider: "perplexity", answer: "unexpected", sources: [] };
				},
			},
			{
				id: "gemini",
				explicit: false,
				available: true,
				behaviour: async () => {
					queried.push("gemini");
					return { provider: "gemini", answer: "Gemini answer", sources: [] };
				},
			},
		]);

		const result = await runSearchQuery({ query: "eligible providers" }, { authStorage: {} as AuthStorage });

		expect(queried).toEqual(["gemini"]);
		expect(result.details.results?.map(entry => entry.details.response.provider)).toEqual(["brave", "gemini"]);
		expect(result.details.results?.[0]?.details.error).toContain("Brave web search is unavailable");
		expect(result.details.results?.[1]?.details.error).toBeUndefined();
	});

	it("uses plain single-provider output when only one fan-out slot is eligible", async () => {
		await initializeFanout(2);
		stubProviders([
			{
				id: "perplexity",
				explicit: false,
				available: false,
				behaviour: async () => ({ provider: "perplexity", answer: "unexpected", sources: [] }),
			},
			{
				id: "gemini",
				explicit: false,
				available: true,
				behaviour: async () => ({ provider: "gemini", answer: "Gemini only", sources: [] }),
			},
		]);

		const result = await runSearchQuery({ query: "one eligible provider" }, { authStorage: {} as AuthStorage });

		expect(result.details.results).toBeUndefined();
		expect(result.content[0]?.text).toBe("Gemini only");
	});

	it("bounds an oversized fanout by the eligible provider list", async () => {
		await initializeFanout(99);
		const requested = stubProviders([
			{
				id: "brave",
				behaviour: async () => ({ provider: "brave", answer: "Brave answer", sources: [] }),
			},
			{
				id: "tavily",
				behaviour: async () => ({ provider: "tavily", answer: "Tavily answer", sources: [] }),
			},
			{
				id: "kagi",
				behaviour: async () => ({ provider: "kagi", answer: "Kagi answer", sources: [] }),
			},
			{
				id: "jina",
				behaviour: async () => ({ provider: "jina", answer: "Jina answer", sources: [] }),
			},
		]);

		const result = await runSearchQuery({ query: "bounded fanout" }, { authStorage: {} as AuthStorage });

		expect(requested).toEqual(["brave", "tavily", "kagi", "jina"]);
		expect(result.content[0]?.text).toBe(
			"## brave\nBrave answer\n\n## tavily\nTavily answer\n\n## kagi\nKagi answer\n\n## jina\nJina answer",
		);
	});
});
