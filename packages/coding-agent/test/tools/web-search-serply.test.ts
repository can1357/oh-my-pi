import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { searchSerply } from "@oh-my-pi/pi-coding-agent/web/search/providers/serply";
import type { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

describe("Serply web search provider", () => {
	// `searchSerply` takes its key from the injected `authStorage` resolver, so the fixture
	// holds it here instead of in `process.env` and the suite stays parallel-safe.
	let apiKey: string | undefined;

	beforeEach(() => {
		apiKey = "test-serply-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		apiKey = undefined;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return apiKey;
		},
		hasAuth() {
			return Boolean(apiKey);
		},
		resolver(_provider: string) {
			return async () => apiKey;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Serply test prompt",
		} as const;
	}

	/** Captures the request URL and replies with a canned Serply payload. */
	function mockFetch(payload: unknown, status = 200) {
		const seen: { url?: URL; apiKey?: string } = {};
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			seen.url = new URL(String(input));
			seen.apiKey = new Headers(init?.headers).get("x-api-key") ?? undefined;
			return new Response(JSON.stringify(payload), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		};
		return { seen, fetchImpl };
	}

	it("maps Serply results into SearchResponse and clamps the page size", async () => {
		const { seen, fetchImpl } = mockFetch({
			results: [
				{
					title: "Result One",
					link: "https://example.com/one",
					description: "First  snippet",
					metadata: { display_url: "example.com", published_time: "Mar 1, 2026" },
				},
				{ link: "https://example.com/two", description: "Second snippet", metadata: {} },
				{ title: "No link", description: "dropped" },
			],
		});

		const response = await searchSerply({ ...makeParams("latest ai news"), numSearchResults: 25, fetch: fetchImpl });

		expect(seen.apiKey).toBe("test-serply-key");
		expect(`${seen.url?.origin}${seen.url?.pathname}`).toBe("https://api.serply.io/v1/search/");
		expect(seen.url?.searchParams.get("q")).toBe("latest ai news");
		// Serply serves a single Google page, so an over-cap request is clamped to 10.
		expect(seen.url?.searchParams.get("num")).toBe("10");
		expect(seen.url?.searchParams.has("tbs")).toBe(false);
		expect(response).toMatchObject({
			provider: "serply",
			authMode: "api_key",
			sources: [
				{
					title: "Result One",
					url: "https://example.com/one",
					snippet: "First snippet",
					publishedDate: "Mar 1, 2026",
				},
				{
					title: "https://example.com/two",
					url: "https://example.com/two",
					snippet: "Second snippet",
				},
			],
		});
		// The third row carries no usable link and is dropped.
		expect(response.sources).toHaveLength(2);
		expect(response.sources[0]?.ageSeconds).toBeTypeOf("number");
	});

	it("passes Google operators through and maps recency onto tbs", async () => {
		const { seen, fetchImpl } = mockFetch({ results: [] });

		await searchSerply({
			...makeParams('omp release notes site:github.com -site:reddit.com filetype:md intitle:"release notes"'),
			numSearchResults: 5,
			recency: "week",
			fetch: fetchImpl,
		});

		const query = seen.url?.searchParams.get("q") ?? "";
		expect(query).toContain("site:github.com");
		expect(query).toContain("-site:reddit.com");
		expect(query).toContain("filetype:md");
		expect(query).toContain('intitle:"release notes"');
		expect(seen.url?.searchParams.get("num")).toBe("5");
		expect(seen.url?.searchParams.get("tbs")).toBe("qdr:w");
	});

	it("keeps explicit date bounds in the query and drops the relative window", async () => {
		const { seen, fetchImpl } = mockFetch({ results: [] });

		await searchSerply({
			...makeParams("bun release notes after:2026-08-01 before:2026-09-01"),
			recency: "day",
			fetch: fetchImpl,
		});

		const query = seen.url?.searchParams.get("q") ?? "";
		expect(query).toContain("after:2026-08-01");
		expect(query).toContain("before:2026-09-01");
		// Stacking qdr on top of an absolute range would intersect two filters.
		expect(seen.url?.searchParams.has("tbs")).toBe(false);
	});

	it("surfaces structured API errors", async () => {
		const { fetchImpl } = mockFetch({ detail: "Invalid API key" }, 401);

		await expect(searchSerply({ ...makeParams("bad auth"), fetch: fetchImpl })).rejects.toEqual(
			expect.objectContaining({
				provider: "serply",
				status: 401,
				message: "serply: 401 unauthorized",
			}) satisfies Partial<SearchProviderError>,
		);
	});

	it("throws a clear error when Serply credentials are missing", async () => {
		apiKey = undefined;
		await expect(searchSerply(makeParams("missing creds"))).rejects.toThrow(
			'Serply credentials not found. Set SERPLY_API_KEY or configure an API key for provider "serply".',
		);
	});
});
