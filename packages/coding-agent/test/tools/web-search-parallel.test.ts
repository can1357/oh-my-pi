import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { AuthStorage, type FetchImpl } from "@oh-my-pi/pi-ai";
import { resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { searchWithParallel } from "@oh-my-pi/pi-coding-agent/web/parallel";
import { ParallelProvider, searchParallel } from "@oh-my-pi/pi-coding-agent/web/search/providers/parallel";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const anonymousAuthStorage = createInMemoryAuthStorage();
afterAll(() => {
	anonymousAuthStorage.close();
});

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
		keys: {
			get: async () => process.env.PARALLEL_API_KEY ?? undefined,
			source: () => (process.env.PARALLEL_API_KEY ? { kind: "env", concrete: true } : undefined),
			resolver: (_provider: string) => async () => process.env.PARALLEL_API_KEY ?? undefined,
		},
		limits: {
			rotate: async () => ({ switched: false }),
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

	it("skips the automatic chain without a Parallel credential", () => {
		delete process.env.PARALLEL_API_KEY;

		expect(new ParallelProvider().isAvailable(anonymousAuthStorage)).toBe(false);
	});

	it("is available when a Parallel credential is configured", () => {
		const storedAuthStorage = {
			...fakeAuthStorage,
			keys: {
				get: async () => "stored-parallel-key",
				source: () => ({ kind: "api_key", concrete: true }),
				resolver: () => async () => "stored-parallel-key",
			},
		} as unknown as AuthStorage;

		expect(new ParallelProvider().isAvailable(storedAuthStorage)).toBe(true);
		expect(new ParallelProvider().isAvailable(fakeAuthStorage)).toBe(true);
	});

	it("rejects a keyless search instead of sending it anywhere", async () => {
		delete process.env.PARALLEL_API_KEY;
		const fetchMock = vi.fn();

		await expect(
			searchParallel({ query: "keyless search", fetch: fetchMock }, anonymousAuthStorage),
		).rejects.toMatchObject({
			provider: "parallel",
			message: expect.stringMatching(/PARALLEL_API_KEY/),
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("preserves authenticated REST precedence for a stored key without an environment key", async () => {
		delete process.env.PARALLEL_API_KEY;
		const storedAuthStorage = {
			...fakeAuthStorage,
			keys: {
				get: async () => "stored-parallel-key",
				source: () => ({ kind: "api_key", concrete: true }),
				resolver: () => async () => "stored-parallel-key",
			},
		} as unknown as AuthStorage;
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;
		const fetchMock: FetchImpl = (url, init) => {
			capturedUrl = url.toString();
			capturedHeaders = init?.headers as Record<string, string> | undefined;
			return Promise.resolve(
				new Response(JSON.stringify({ search_id: "search-stored-key", results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchParallel({ query: "stored credential", fetch: fetchMock }, storedAuthStorage);

		expect(capturedUrl).toBe("https://api.parallel.ai/v1beta/search");
		expect(capturedHeaders).toMatchObject({
			"x-api-key": "stored-parallel-key",
			"parallel-beta": "search-extract-2025-10-10",
		});
	});

	it("throws when a configured credential helper fails instead of falling back", async () => {
		delete process.env.PARALLEL_API_KEY;
		const authStorage = await AuthStorage.create(":memory:", { configValueResolver: resolveConfigValue });
		try {
			await authStorage.credentials.set("parallel", { type: "api_key", key: "!false" });
			const fetchMock = vi.fn();

			await expect(
				searchParallel({ query: "configured credential", fetch: fetchMock }, authStorage),
			).rejects.toMatchObject({
				provider: "parallel",
				message: expect.stringMatching(/credentials.*resolved/i),
			});
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			authStorage.close();
		}
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
