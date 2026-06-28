import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@pk-nerdsaver-ai/pi-ai";
import { searchDuckDuckGo } from "@pk-nerdsaver-ai/pi-coding-agent/web/search/providers/duckduckgo";
import { SearchProviderError } from "@pk-nerdsaver-ai/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("DuckDuckGo must not request API keys");
	},
	resolver() {
		throw new Error("DuckDuckGo must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("DuckDuckGo search must not check auth");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl) {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "DuckDuckGo test prompt",
		fetch,
	} as const;
}

describe("DuckDuckGo web search provider", () => {
	it("calls the official Instant Answer API with unauthenticated JSON query params", async () => {
		let capturedUrl: string | null = null;
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedInit = init;
			return Promise.resolve(
				new Response(JSON.stringify({ AbstractText: "Duck answer", Results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchDuckDuckGo(makeParams("instant answer", fetchMock));

		expect(capturedUrl).not.toBeNull();
		const url = new URL(capturedUrl ?? "");
		expect(`${url.origin}${url.pathname}`).toBe("https://api.duckduckgo.com/");
		expect(url.searchParams.get("q")).toBe("instant answer");
		expect(url.searchParams.get("format")).toBe("json");
		expect(url.searchParams.get("no_redirect")).toBe("1");
		expect(url.searchParams.get("no_html")).toBe("1");
		expect(url.searchParams.get("skip_disambig")).toBe("1");
		expect(url.searchParams.get("t")).toBe("oh-my-pi");
		expect(capturedInit?.method).toBe("GET");
		expect(capturedInit?.headers).toBeUndefined();
	});

	it("uses AbstractText as the answer and flattens abstract, result, and nested related topics within the local limit", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						AbstractText: "  DuckDuckGo <b>abstract</b> &amp; answer  ",
						AbstractURL: " https://example.com/abstract ",
						AbstractSource: " Example Abstract Source ",
						Heading: "Example Heading",
						Results: [
							{
								FirstURL: "https://example.com/result",
								Text: "Result <i>snippet</i>",
							},
						],
						RelatedTopics: [
							{
								FirstURL: "https://example.com/related",
								Text: "Related topic",
							},
							{
								Topics: [
									{
										FirstURL: "https://example.com/nested",
										Text: "Nested related topic",
									},
								],
							},
							{
								FirstURL: "https://example.com/omitted-by-limit",
								Text: "Should be omitted by local limit",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);

		const response = await searchDuckDuckGo({ ...makeParams("duck mapping", fetchMock), numSearchResults: 4 });

		expect(response).toMatchObject({
			provider: "duckduckgo",
			answer: "DuckDuckGo abstract & answer",
			sources: [
				{
					title: "Example Abstract Source",
					url: "https://example.com/abstract",
					snippet: "DuckDuckGo abstract & answer",
				},
				{
					title: "Result snippet",
					url: "https://example.com/result",
					snippet: "Result snippet",
				},
				{
					title: "Related topic",
					url: "https://example.com/related",
					snippet: "Related topic",
				},
				{
					title: "Nested related topic",
					url: "https://example.com/nested",
					snippet: "Nested related topic",
				},
			],
		});
		expect(response.sources).toHaveLength(4);
		expect(response.sources.some(source => source.url === "https://example.com/omitted-by-limit")).toBe(false);
	});

	it("clamps oversized local result limits to DuckDuckGo's provider maximum", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						RelatedTopics: Array.from({ length: 25 }, (_value, index) => ({
							FirstURL: `https://example.com/topic-${index}`,
							Text: `Topic ${index}`,
						})),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);

		const response = await searchDuckDuckGo({ ...makeParams("duck clamp", fetchMock), numSearchResults: 999 });

		expect(response.sources).toHaveLength(20);
		expect(response.sources.at(0)?.url).toBe("https://example.com/topic-0");
		expect(response.sources.at(-1)?.url).toBe("https://example.com/topic-19");
		expect(response.sources.some(source => source.url === "https://example.com/topic-20")).toBe(false);
	});

	it.each([
		["Answer", { Answer: "  Direct answer  " }, "Direct answer"],
		["Definition", { Definition: "  Definition answer  " }, "Definition answer"],
	] as const)("falls back to %s when AbstractText is absent", async (_field, payload, expectedAnswer) => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		const response = await searchDuckDuckGo(makeParams("fallback answer", fetchMock));
		expect(response).toMatchObject({
			provider: "duckduckgo",
			answer: expectedAnswer,
		});
	});

	it("throws a provider-tagged SearchProviderError for HTTP failures", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response("upstream unavailable", {
					status: 503,
				}),
			);

		try {
			await searchDuckDuckGo(makeParams("http failure", fetchMock));
			expect.unreachable("DuckDuckGo HTTP failure should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "duckduckgo",
				status: 503,
				message: "DuckDuckGo API error (503): upstream unavailable",
			});
		}
	});
});
