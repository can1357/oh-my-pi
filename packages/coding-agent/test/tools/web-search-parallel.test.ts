import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { searchWithParallel } from "@oh-my-pi/pi-coding-agent/web/parallel";
import { searchParallel } from "@oh-my-pi/pi-coding-agent/web/search/providers/parallel";

describe("Parallel web search", () => {
	const fakeStorage = {
		listAuthCredentials: () => [
			{
				id: 1,
				credential: {
					type: "oauth",
					access: "test-access-token",
					expires: Date.now() + 600_000,
					accountId: "acct-test",
				},
			},
		],
		updateAuthCredential: () => undefined,
		get authStore() {
			return null as never;
		},
	} as unknown as AgentStorage;
	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.PARALLEL_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.PARALLEL_API_KEY);
		},
		resolver(_provider: string) {
			return async () => process.env.PARALLEL_API_KEY ?? undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	let capturedRequestBody: unknown;

	beforeEach(() => {
		capturedRequestBody = undefined;
		process.env.PARALLEL_API_KEY = "test-parallel-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
	});

	function mockFetch(responseBody: unknown, status = 200): FetchImpl {
		return (_url, init) => {
			if (typeof init?.body === "string") {
				capturedRequestBody = JSON.parse(init.body);
			}
			return Promise.resolve(
				new Response(JSON.stringify(responseBody), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};
	}

	it("sends the expected Parallel search request and parses results", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-1",
			results: [
				{
					title: "Parallel result",
					url: "https://example.com/article",
					publish_date: "2025-01-01",
					excerpts: ["First excerpt", "Second excerpt"],
				},
			],
			warnings: null,
			usage: [{ name: "sku_search", count: 1 }],
		});

		const result = await searchWithParallel("parallel query", ["parallel query"], { fetch: fetchMock }, fakeStorage);
		expect(capturedRequestBody).toEqual({
			objective: "parallel query",
			search_queries: ["parallel query"],
			mode: "fast",
			excerpts: { max_chars_per_result: 10_000 },
		});
		expect(result).toEqual({
			requestId: "search-parallel-1",
			sources: [
				{
					title: "Parallel result",
					url: "https://example.com/article",
					snippet: "First excerpt\n\nSecond excerpt",
					publishedDate: "2025-01-01",
					excerpts: ["First excerpt", "Second excerpt"],
				},
			],
			warnings: [],
			usage: [{ name: "sku_search", count: 1 }],
		});
	});

	it("maps Parallel search responses into SearchResponse", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-2",
			results: [
				{
					title: "Alpha",
					url: "https://alpha.example",
					publish_date: "2024-12-24",
					excerpts: ["Alpha excerpt"],
				},
			],
			errors: [],
			warnings: null,
			usage: null,
		});

		const result = await searchParallel({ query: "alpha search", fetch: fetchMock }, fakeAuthStorage);
		expect(result.provider).toBe("parallel");
		expect(result.requestId).toBe("search-parallel-2");
		expect(result.sources).toEqual([
			{
				title: "Alpha",
				url: "https://alpha.example",
				snippet: "Alpha excerpt",
				publishedDate: "2024-12-24",
				ageSeconds: expect.any(Number),
			},
		]);
	});

	it("maps site: directives onto source_policy.include_domains and strips them from the query", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-3",
			results: [],
			warnings: null,
			usage: null,
		});

		await searchParallel({ query: "web api site:parallel.ai", fetch: fetchMock }, fakeAuthStorage);
		expect(capturedRequestBody).toEqual({
			objective: "web api",
			search_queries: ["web api"],
			mode: "fast",
			excerpts: { max_chars_per_result: 10_000 },
			source_policy: { include_domains: ["parallel.ai"] },
		});
	});

	it("maps recency onto source_policy.after_date", async () => {
		setSystemTime(new Date("2026-08-10T12:00:00Z"));
		try {
			const fetchMock = mockFetch({
				search_id: "search-parallel-recency",
				results: [],
				warnings: null,
				usage: null,
			});

			await searchParallel({ query: "recent api changes", recency: "week", fetch: fetchMock }, fakeAuthStorage);
			expect(capturedRequestBody).toEqual({
				objective: "recent api changes",
				search_queries: ["recent api changes"],
				mode: "fast",
				excerpts: { max_chars_per_result: 10_000 },
				source_policy: { after_date: "2026-08-03" },
			});
		} finally {
			setSystemTime();
		}
	});

	it("maps -site: and after: onto exclude_domains/after_date, keeping phrases and negation", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-4",
			results: [],
			warnings: null,
			usage: null,
		});

		await searchParallel(
			{
				query: '"web api" -legacy -site:reddit.com/r/node after:2025-06-01',
				recency: "day",
				fetch: fetchMock,
			},
			fakeAuthStorage,
		);
		expect(capturedRequestBody).toEqual({
			objective: '"web api" -legacy',
			search_queries: ['"web api" -legacy'],
			mode: "fast",
			excerpts: { max_chars_per_result: 10_000 },
			source_policy: { exclude_domains: ["reddit.com"], after_date: "2025-06-01" },
		});
	});

	it("surfaces plain-text Parallel API errors", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(new Response("upstream unavailable", { status: 503 }));
		await expect(searchParallel({ query: "broken", fetch: fetchMock }, fakeAuthStorage)).rejects.toMatchObject({
			provider: "parallel",
			status: 503,
			message: "Parallel API error (503): upstream unavailable",
		});
	});

	it("classifies malformed successful responses as Parallel errors", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response("{not-json", { status: 200, headers: { "Content-Type": "application/json" } }));
		await expect(searchParallel({ query: "broken", fetch: fetchMock }, fakeAuthStorage)).rejects.toMatchObject({
			provider: "parallel",
			message: expect.stringContaining("Parallel search returned invalid JSON:"),
		});
	});
});
