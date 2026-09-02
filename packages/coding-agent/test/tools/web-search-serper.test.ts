import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SerperProvider, searchSerper } from "@oh-my-pi/pi-coding-agent/web/search/providers/serper";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const originalSerperApiKey = process.env.SERPER_API_KEY;

function createAuthStorage(authenticated = true): AuthStorage {
	return {
		hasAuth(provider: string) {
			return authenticated && provider === "serper";
		},
		resolver() {
			return async () => (authenticated ? "test-serper-key" : undefined);
		},
	} as unknown as AuthStorage;
}

beforeEach(() => {
	delete process.env.SERPER_API_KEY;
});
afterEach(() => {
	if (originalSerperApiKey === undefined) delete process.env.SERPER_API_KEY;
	else process.env.SERPER_API_KEY = originalSerperApiKey;
});

describe("Serper web search", () => {
	it("registers login, environment, and search-provider metadata", async () => {
		expect(getProviderDefinition("serper")).toMatchObject({
			id: "serper",
			name: "Serper",
			envKeys: "SERPER_API_KEY",
		});

		const provider = await getSearchProvider("serper");
		expect(provider).toBeInstanceOf(SerperProvider);
		expect(provider.label).toBe("Serper");
		expect(provider.isAvailable(createAuthStorage(false))).toBe(false);

		process.env.SERPER_API_KEY = "env-serper-key";
		expect(provider.isAvailable(createAuthStorage(false))).toBe(true);
	});

	it("posts the query and maps knowledge graph, organic, and related results", async () => {
		const fetchMock: FetchImpl = async (input, init) => {
			expect(String(input)).toBe("https://google.serper.dev/search");
			expect(init?.method).toBe("POST");
			const headers = new Headers(init?.headers);
			expect(headers.get("X-API-KEY")).toBe("test-serper-key");
			expect(headers.get("Content-Type")).toBe("application/json");
			expect(JSON.parse(String(init?.body))).toEqual({ q: "apple inc", num: 3, tbs: "qdr:w" });

			return new Response(
				JSON.stringify({
					knowledgeGraph: {
						title: "Apple Inc.",
						description: "American technology company",
						descriptionLink: "https://en.m.wikipedia.org/wiki/Apple_Inc/#history",
					},
					organic: [
						{
							title: "Apple",
							link: "https://www.apple.com/",
							snippet: "Official Apple site",
							date: "Aug 18, 2026",
						},
						{
							title: "Apple Inc. - Wikipedia",
							link: "https://www.en.wikipedia.org/wiki/Apple_Inc",
							snippet: "Duplicate knowledge graph source",
						},
						{ title: "Unsafe", link: "javascript:alert(1)" },
					],
					peopleAlsoAsk: [{ question: "Who founded Apple?" }],
					relatedSearches: [{ query: "Apple company history" }, { query: "Who founded Apple?" }],
				}),
				{ headers: { "Content-Type": "application/json", "x-request-id": "req-serper" } },
			);
		};

		const result = await searchSerper({
			query: "apple inc",
			num_results: 3,
			recency: "week",
			authStorage: createAuthStorage(),
			fetch: fetchMock,
		});

		expect(result).toEqual({
			provider: "serper",
			sources: [
				{
					title: "Apple Inc.",
					url: "https://en.wikipedia.org/wiki/Apple_Inc/#history",
					snippet: "American technology company",
					publishedDate: undefined,
				},
				{
					title: "Apple",
					url: "https://www.apple.com/",
					snippet: "Official Apple site",
					publishedDate: "Aug 18, 2026",
				},
			],
			relatedQuestions: ["Who founded Apple?", "Apple company history"],
			requestId: "req-serper",
			authMode: "api_key",
		});
	});

	it("classifies authentication failures", async () => {
		const fetchMock: FetchImpl = async () => new Response("invalid API key", { status: 401 });

		try {
			await searchSerper({ query: "apple", authStorage: createAuthStorage(), fetch: fetchMock });
			expect.unreachable("expected searchSerper to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "serper", status: 401 });
			expect((error as Error).message).toBe("serper: 401 unauthorized");
		}
	});

	it("returns direct answer boxes without source links", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ answerBox: { title: "2 + 2 =", answer: "4" } }), {
				headers: { "Content-Type": "application/json" },
			});

		const result = await searchSerper({ query: "2+2", authStorage: createAuthStorage(), fetch: fetchMock });

		expect(result.answer).toBe("2 + 2 =\n4");
		expect(result.sources).toEqual([]);
	});

	it("prioritizes linked answer boxes and sanitizes tabs", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					answerBox: {
						title: "Featured\tanswer",
						answer: "Direct\tanswer",
						link: "https://example.com/featured",
						snippet: "Source\tsnippet",
					},
					organic: [{ title: "Organic", link: "https://example.com/organic" }],
				}),
				{ headers: { "Content-Type": "application/json" } },
			);

		const result = await searchSerper({
			query: "featured answer",
			num_results: 1,
			authStorage: createAuthStorage(),
			fetch: fetchMock,
		});

		expect(result.answer).not.toContain("\t");
		expect(result.sources).toEqual([
			{
				title: "Featured   answer",
				url: "https://example.com/featured",
				snippet: "Source   snippet",
				publishedDate: undefined,
			},
		]);
	});

	it("rejects malformed success responses", async () => {
		const invalidJsonFetch: FetchImpl = async () =>
			new Response("<html>not json</html>", { headers: { "Content-Type": "text/html" } });
		const invalidEnvelopeFetch: FetchImpl = async () =>
			new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });

		await expect(
			searchSerper({ query: "invalid json", authStorage: createAuthStorage(), fetch: invalidJsonFetch }),
		).rejects.toThrow("Serper API returned invalid JSON");
		await expect(
			searchSerper({ query: "invalid envelope", authStorage: createAuthStorage(), fetch: invalidEnvelopeFetch }),
		).rejects.toThrow("Serper API returned an invalid response");
	});
});
