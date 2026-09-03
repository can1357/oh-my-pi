import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { searchTinyFish } from "@oh-my-pi/pi-coding-agent/web/search/providers/tinyfish";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const TEST_KEY = "test-tinyfish-key";

function makeAuthStorage(apiKey: string | undefined): AuthStorage {
	return {
		resolver(provider: string, options?: { sessionId?: string }) {
			expect(provider).toBe("tinyfish");
			expect(options?.sessionId).toBe("session-tinyfish-test");
			return async () => apiKey;
		},
		hasAuth(provider: string) {
			return provider === "tinyfish" && Boolean(apiKey);
		},
	} as unknown as AuthStorage;
}

function makeParams(query: string, authStorage: AuthStorage = makeAuthStorage(TEST_KEY)) {
	return {
		query,
		authStorage,
		systemPrompt: "TinyFish test prompt",
		sessionId: "session-tinyfish-test",
	} as const;
}

function getHeader(headers: RequestInit["headers"] | undefined, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);
	if (Array.isArray(headers)) {
		return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
	}
	const record = headers as Record<string, string>;
	return record[name] ?? record[name.toLowerCase()] ?? null;
}

interface TinyFishMockResult {
	title: string;
	url: string | null;
	snippet: string;
	site_name?: string;
}

function tinyFishResults(prefix: string, count: number, start = 0): TinyFishMockResult[] {
	return Array.from({ length: count }, (_, offset) => {
		const index = start + offset;
		return {
			title: `${prefix} result ${index}`,
			url: `https://example.com/${prefix}-${index}`,
			snippet: `${prefix} snippet ${index}`,
			site_name: index === 0 ? "Example Site" : undefined,
		};
	});
}

function tinyFishPage(results: TinyFishMockResult[], page = 0, totalResults = results.length) {
	return { results, total_results: totalResults, page };
}

function expectTinyFishParams(url: URL, expectedParams: readonly string[]): void {
	expect([...url.searchParams.keys()].sort()).toEqual([...expectedParams].sort());
}

describe("TinyFish web search provider", () => {
	it("rewrites directive queries with supported operators only", async () => {
		const captured: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			return new Response(JSON.stringify(tinyFishPage(tinyFishResults("tinyfish", 3))), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchTinyFish({
			...makeParams(
				'"error handling" rust site:github.com -site:gitlab.com filetype:pdf intitle:tokio after:2024-01-01',
			),
			fetch: fetchMock,
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].searchParams.get("query")).toBe('"error handling" rust filetype:pdf');
		expect(captured[0].searchParams.get("include_domains")).toBe("github.com");
		expect(captured[0].searchParams.get("exclude_domains")).toBe("gitlab.com");
		expectTinyFishParams(captured[0], ["query", "num_results", "page", "include_domains", "exclude_domains"]);
	});

	it("sends directive-free queries verbatim", async () => {
		const captured: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			return new Response(JSON.stringify(tinyFishPage(tinyFishResults("tinyfish", 3))), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchTinyFish({ ...makeParams("plain query with ordinary words"), fetch: fetchMock });

		expect(captured).toHaveLength(1);
		expect(captured[0].searchParams.get("query")).toBe("plain query with ordinary words");
	});

	it("maps a lang: locale directive onto location and language", async () => {
		const captured: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			return new Response(JSON.stringify(tinyFishPage(tinyFishResults("tinyfish", 3))), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchTinyFish({ ...makeParams("Best Cheap Android Tablet lang:it-it"), fetch: fetchMock });

		expect(captured).toHaveLength(1);
		expect(captured[0].searchParams.get("query")).toBe("Best Cheap Android Tablet");
		expect(captured[0].searchParams.get("location")).toBe("IT");
		expect(captured[0].searchParams.get("language")).toBe("it");
		expectTinyFishParams(captured[0], ["query", "num_results", "page", "location", "language"]);
	});

	it("sends language only when the lang: directive omits a region", async () => {
		const captured: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			return new Response(JSON.stringify(tinyFishPage(tinyFishResults("tinyfish", 3))), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchTinyFish({ ...makeParams("cheap tablets lang:it"), fetch: fetchMock });

		expect(captured).toHaveLength(1);
		expect(captured[0].searchParams.get("language")).toBe("it");
		expect(captured[0].searchParams.has("location")).toBe(false);
		expectTinyFishParams(captured[0], ["query", "num_results", "page", "language"]);
	});

	it("never maps a script subtag onto location", async () => {
		const captured: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			return new Response(JSON.stringify(tinyFishPage(tinyFishResults("tinyfish", 3))), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchTinyFish({ ...makeParams("cheap tablets lang:zh-hans"), fetch: fetchMock });

		expect(captured).toHaveLength(1);
		expect(captured[0].searchParams.get("language")).toBe("zh");
		expect(captured[0].searchParams.has("location")).toBe(false);
		expectTinyFishParams(captured[0], ["query", "num_results", "page", "language"]);
	});

	it("passes TinyFish num_results and applies numSearchResults across pages", async () => {
		const captured: { url: URL; init?: RequestInit }[] = [];
		const pages = new Map([
			["0", tinyFishResults("tinyfish", 10)],
			["1", tinyFishResults("tinyfish", 10, 10)],
		]);

		const fetchMock: FetchImpl = async (input, init) => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push({ url, init });
			const page = Number(url.searchParams.get("page") ?? 0);
			return new Response(JSON.stringify(tinyFishPage(pages.get(String(page)) ?? [], page, 20)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchTinyFish({
			...makeParams("fresh fish"),
			numSearchResults: 12,
			recency: "week",
			fetch: fetchMock,
		});

		expect(captured).toHaveLength(2);
		const [firstRequest, secondRequest] = captured;
		const endpoint = `${firstRequest.url.origin}${firstRequest.url.pathname === "/" ? "" : firstRequest.url.pathname}`;
		expect(endpoint).toBe("https://api.search.tinyfish.ai");
		expect(firstRequest.init?.method ?? "GET").toBe("GET");
		expect(getHeader(firstRequest.init?.headers, "X-API-Key")).toBe(TEST_KEY);
		expect(firstRequest.url.searchParams.get("query")).toBe("fresh fish");
		expect(firstRequest.url.searchParams.get("recency_minutes")).toBe("10080");
		expect(firstRequest.url.searchParams.get("page")).toBe("0");
		expect(firstRequest.url.searchParams.get("num_results")).toBe("10");
		expect(secondRequest.url.searchParams.get("query")).toBe("fresh fish");
		expect(secondRequest.url.searchParams.get("recency_minutes")).toBe("10080");
		expect(secondRequest.url.searchParams.get("page")).toBe("1");
		expect(secondRequest.url.searchParams.get("num_results")).toBe("10");

		expectTinyFishParams(firstRequest.url, ["query", "recency_minutes", "num_results", "page"]);
		expectTinyFishParams(secondRequest.url, ["query", "recency_minutes", "num_results", "page"]);

		expect(response.provider).toBe("tinyfish");
		expect(response.authMode).toBe("api_key");
		expect(response.sources).toHaveLength(12);
		expect(response.sources[0]).toEqual({
			title: "tinyfish result 0",
			url: "https://example.com/tinyfish-0",
			snippet: "tinyfish snippet 0",
			author: "Example Site",
		});
		expect(response.sources.at(-1)).toEqual({
			title: "tinyfish result 11",
			url: "https://example.com/tinyfish-11",
			snippet: "tinyfish snippet 11",
			author: undefined,
		});
		expect(response.sources.some(source => source.url === "https://example.com/tinyfish-12")).toBe(false);
	});

	it("requests two TinyFish pages for limit 20 with num_results", async () => {
		const captured: URL[] = [];
		const pages = new Map([
			["0", tinyFishResults("limit", 10)],
			["1", tinyFishResults("limit", 10, 10)],
		]);

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			const page = Number(url.searchParams.get("page") ?? 0);
			return new Response(JSON.stringify(tinyFishPage(pages.get(String(page)) ?? [], page, 20)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchTinyFish({
			...makeParams("limit fish"),
			limit: 20,
			recency: "day",
			fetch: fetchMock,
		});

		expect(captured).toHaveLength(2);
		expect(captured.map(url => url.searchParams.get("page"))).toEqual(["0", "1"]);
		for (const url of captured) {
			expect(url.searchParams.get("query")).toBe("limit fish");
			expect(url.searchParams.get("recency_minutes")).toBe("1440");
			expect(url.searchParams.get("num_results")).toBe("10");
			expectTinyFishParams(url, ["query", "recency_minutes", "num_results", "page"]);
		}

		expect(response.sources).toHaveLength(20);
		expect(response.sources.at(-1)?.url).toBe("https://example.com/limit-19");
	});

	it("requests page 1 when page 0 has 10 raw results but fewer usable sources", async () => {
		const captured: URL[] = [];
		const firstPageResults = tinyFishResults("raw-page", 10);
		firstPageResults[0] = { ...firstPageResults[0], url: null };
		const pages = new Map([
			["0", firstPageResults],
			["1", tinyFishResults("raw-page", 10, 10)],
		]);

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			const page = Number(url.searchParams.get("page") ?? 0);
			return new Response(JSON.stringify(tinyFishPage(pages.get(String(page)) ?? [], page, 20)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchTinyFish({ ...makeParams("raw page fish"), limit: 11, fetch: fetchMock });

		expect(captured.map(url => url.searchParams.get("page"))).toEqual(["0", "1"]);
		expect(captured.map(url => url.searchParams.get("num_results"))).toEqual(["10", "10"]);
		expect(response.sources).toHaveLength(11);
		expect(response.sources[0]?.url).toBe("https://example.com/raw-page-1");
		expect(response.sources.at(-1)?.url).toBe("https://example.com/raw-page-11");
	});

	it("deduplicates and normalizes results across pages", async () => {
		const captured: URL[] = [];
		const firstPage = tinyFishResults("dedupe", 10);
		firstPage[0] = {
			title: "  Primary title  ",
			url: "  https://example.com/dedupe-0  ",
			snippet: "  spaced \n snippet  ",
			site_name: "  Example  ",
		};
		firstPage[1] = {
			title: "Duplicate title",
			url: "https://example.com/dedupe-0",
			snippet: "duplicate snippet",
		};
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			const page = Number(url.searchParams.get("page") ?? 0);
			const results = page === 0 ? firstPage : tinyFishResults("dedupe", 1, 10);
			return new Response(JSON.stringify(tinyFishPage(results, page, 11)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchTinyFish({ ...makeParams("dedupe fish"), limit: 10, fetch: fetchMock });

		expect(captured.map(url => url.searchParams.get("page"))).toEqual(["0", "1"]);
		expect(response.sources).toHaveLength(10);
		expect(response.sources[0]).toMatchObject({
			title: "Primary title",
			url: "https://example.com/dedupe-0",
			snippet: "spaced snippet",
		});
		expect(response.sources.at(-1)?.url).toBe("https://example.com/dedupe-10");
	});

	it("stops early for limit 20 when page 0 returns fewer than 10 raw results", async () => {
		const captured: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			return new Response(JSON.stringify(tinyFishPage(tinyFishResults("short-page", 9), 0, 9)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchTinyFish({ ...makeParams("short page fish"), limit: 20, fetch: fetchMock });

		expect(captured.map(url => url.searchParams.get("page"))).toEqual(["0"]);
		expect(captured[0].searchParams.get("num_results")).toBe("10");
		expect(response.sources).toHaveLength(9);
		expect(response.sources.at(-1)?.url).toBe("https://example.com/short-page-8");
	});

	it("does not request a second page for the default 10-result page", async () => {
		const captured: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			return new Response(JSON.stringify(tinyFishPage(tinyFishResults("default", 10), 0, 10)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchTinyFish({ ...makeParams("default fish"), fetch: fetchMock });

		expect(captured).toHaveLength(1);
		expect(captured[0].searchParams.get("query")).toBe("default fish");
		expect(captured[0].searchParams.get("page")).toBe("0");
		expect(captured[0].searchParams.get("num_results")).toBe("10");
		expectTinyFishParams(captured[0], ["query", "num_results", "page"]);
		expect(response.sources).toHaveLength(10);
	});

	it("does not request a second page when the local limit is 10 or below", async () => {
		const captured: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			return new Response(JSON.stringify(tinyFishPage(tinyFishResults("small-limit", 10), 0, 10)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchTinyFish({ ...makeParams("small limit fish"), limit: 7, fetch: fetchMock });

		expect(captured).toHaveLength(1);
		expect(captured[0].searchParams.get("query")).toBe("small limit fish");
		expect(captured[0].searchParams.get("page")).toBe("0");
		expect(captured[0].searchParams.get("num_results")).toBe("7");
		expectTinyFishParams(captured[0], ["query", "num_results", "page"]);
		expect(response.sources).toHaveLength(7);
		expect(response.sources.at(-1)?.url).toBe("https://example.com/small-limit-6");
	});

	it("propagates second-page HTTP errors", async () => {
		const captured: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.push(url);
			if (url.searchParams.get("page") === "1") {
				return new Response("upstream rejected page 1", { status: 402 });
			}

			return new Response(JSON.stringify(tinyFishPage(tinyFishResults("page-error", 10), 0, 20)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		try {
			await searchTinyFish({ ...makeParams("page error fish"), limit: 20, fetch: fetchMock });
			expect.unreachable("expected searchTinyFish to throw");
		} catch (error) {
			expect(captured.map(url => url.searchParams.get("page"))).toEqual(["0", "1"]);
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "tinyfish", status: 402, message: "tinyfish: 402 credits exhausted" });
		}
	});

	it.each([
		[401, "tinyfish: 401 unauthorized"],
		[402, "tinyfish: 402 credits exhausted"],
	] as const)("maps HTTP %d to a SearchProviderError", async (status, message) => {
		const fetchMock: FetchImpl = async () => new Response("upstream rejected", { status });

		try {
			await searchTinyFish({ ...makeParams("bad auth"), fetch: fetchMock });
			expect.unreachable("expected searchTinyFish to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "tinyfish", status, message });
		}
	});

	it("throws a clear error when TinyFish credentials are missing", async () => {
		const fetchMock: FetchImpl = async () => {
			throw new Error("fetch should not be called without credentials");
		};

		try {
			await searchTinyFish({ ...makeParams("missing creds", makeAuthStorage(undefined)), fetch: fetchMock });
			expect.unreachable("expected searchTinyFish to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(
				'TinyFish credentials not found. Set TINYFISH_API_KEY or configure an API key for provider "tinyfish".',
			);
		}
	});
});
