import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { KEENABLE_SEARCH_PUBLIC_URL, KEENABLE_SEARCH_URL } from "@oh-my-pi/pi-coding-agent/web/keenable";
import {
	buildRequestBody,
	KeenableProvider,
	searchKeenable,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/keenable";
import type { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { APP_NAME } from "@oh-my-pi/pi-utils";

const originalKeenableApiKey = process.env.KEENABLE_API_KEY;

describe("Keenable web search provider", () => {
	beforeEach(() => {
		process.env.KEENABLE_API_KEY = "test-keenable-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalKeenableApiKey === undefined) delete process.env.KEENABLE_API_KEY;
		else process.env.KEENABLE_API_KEY = originalKeenableApiKey;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.KEENABLE_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.KEENABLE_API_KEY);
		},
		resolver(_provider: string) {
			return async () => process.env.KEENABLE_API_KEY ?? undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Keenable test prompt",
		} as const;
	}

	it("keeps a rotated credential across the recency fallback", async () => {
		let key = "rejected-key";
		const sentKeys: (string | null)[] = [];
		vi.spyOn(fakeAuthStorage, "resolver").mockReturnValue(async () => key);
		const response = await searchKeenable({
			...makeParams("ai chips"),
			recency: "day",
			fetch: async (_input, init) => {
				const sent = new Headers(init?.headers).get("x-api-key");
				sentKeys.push(sent);
				if (sent === "rejected-key") {
					key = "working-key";
					return Response.json({ error: "invalid key" }, { status: 401 });
				}
				return Response.json({
					results: sentKeys.length === 2 ? [] : [{ title: "Found", url: "https://example.com/found" }],
				});
			},
		});
		expect(sentKeys).toEqual(["rejected-key", "working-key", "working-key"]);
		expect(response.sources[0]?.url).toBe("https://example.com/found");
	});

	it("maps Keenable hits into SearchResponse and forwards recency as published_after", async () => {
		let requestUrl = "";
		let requestHeaders: Headers | undefined;
		let requestBody: Record<string, unknown> | null = null;

		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					query: "latest ai news",
					results: [
						{
							title: "Result One",
							url: "https://example.com/one",
							description: "Short blurb",
							snippet: "Longer excerpt",
							published_at: "2026-03-01T00:00:00Z",
						},
						{
							url: "https://example.com/two",
							description: "Second blurb",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchKeenable({
			...makeParams("latest ai news"),
			numSearchResults: 2,
			recency: "week",
			fetch: fetchMock,
		});

		expect(requestUrl).toBe(KEENABLE_SEARCH_URL);
		expect(requestHeaders?.get("x-api-key")).toBe("test-keenable-key");
		expect(requestBody).toMatchObject({
			query: "latest ai news",
			max_results: 2,
			published_after: "7d",
		});
		expect(response).toMatchObject({
			provider: "keenable",
			authMode: "api_key",
			sources: [
				{
					title: "Result One",
					url: "https://example.com/one",
					snippet: "Longer excerpt",
					publishedDate: "2026-03-01T00:00:00Z",
				},
				{
					title: "https://example.com/two",
					url: "https://example.com/two",
					snippet: "Second blurb",
				},
			],
		});
		expect(response.sources[0]?.ageSeconds).toBeTypeOf("number");
	});

	it.each([
		{
			name: "maps a bare positive site natively",
			query: "typescript site:github.com",
			expectedQuery: "typescript",
		},
		{
			name: "preserves excluded sites alongside the native positive host",
			query: "typescript site:github.com -site:gist.github.com",
			expectedQuery: "typescript site:github.com -site:gist.github.com",
		},
	])("$name", async ({ query, expectedQuery }) => {
		let requestBody: Record<string, unknown> | null = null;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchKeenable({
			...makeParams(query),
			fetch: fetchMock,
		});

		expect(requestBody).toMatchObject({
			query: expectedQuery,
			site: "github.com",
		});
	});

	it("keeps a path-scoped site: in the query while mapping the host natively", async () => {
		let requestBody: Record<string, unknown> | null = null;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchKeenable({
			...makeParams("claude sdk site:github.com/anthropics"),
			fetch: fetchMock,
		});

		expect(requestBody).toMatchObject({
			query: "claude sdk site:github.com/anthropics",
			site: "github.com",
		});
	});

	it("leaves multiple site: directives in the query without a native site field", async () => {
		let requestBody: Record<string, unknown> | null = null;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchKeenable({
			...makeParams("cve site:nvd.nist.gov site:mitre.org"),
			fetch: fetchMock,
		});

		expect(requestBody).toMatchObject({
			query: "cve (site:nvd.nist.gov OR site:mitre.org)",
		});
		expect(requestBody).not.toHaveProperty("site");
	});

	it("maps after:/before: to published_after/published_before instead of recency", async () => {
		expect(
			buildRequestBody({
				query: "rust",
				recency: "week",
				published_after: "2026-01-01",
				published_before: "2026-02-01",
			}),
		).toEqual({
			query: "rust",
			max_results: 10,
			published_after: "2026-01-01",
			published_before: "2026-02-01",
		});
	});

	it("retries recency-filtered empty responses without published_after", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBodies.push(JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>);
			if (requestBodies.length === 1) {
				return new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					results: [{ title: "Untimed", url: "https://example.com/untimed" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchKeenable({
			...makeParams("ai chips"),
			recency: "day",
			fetch: fetchMock,
		});

		expect(requestBodies).toEqual([
			{ query: "ai chips", max_results: 10, published_after: "1d" },
			{ query: "ai chips", max_results: 10 },
		]);
		expect(response.sources).toEqual([
			{
				title: "Untimed",
				url: "https://example.com/untimed",
				snippet: undefined,
				publishedDate: undefined,
				ageSeconds: undefined,
			},
		]);
	});

	it("expires the recency fallback at the original deadline", async () => {
		const deadlines: AbortController[] = [];
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
			const deadline = new AbortController();
			deadlines.push(deadline);
			return deadline.signal;
		});
		let attempts = 0;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (++attempts === 1) {
				return Response.json({ results: [] });
			}
			deadlines[0]!.abort(new DOMException("Search deadline expired", "TimeoutError"));
			init?.signal?.throwIfAborted();
			return Response.json({ results: [{ title: "Too late", url: "https://example.com/late" }] });
		};
		await expect(
			searchKeenable({
				...makeParams("ai chips"),
				recency: "day",
				timeoutMs: 1_000,
				fetch: fetchMock,
			}),
		).rejects.toThrow("Search deadline expired");
	});

	it("propagates caller abort through the shared recency-fallback deadline", async () => {
		const ac = new AbortController();
		const signals: AbortSignal[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			signals.push(init?.signal as AbortSignal);
			if (signals.length === 1) {
				return new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			ac.abort(new Error("user-cancel"));
			throw init?.signal?.reason ?? new DOMException("Aborted", "AbortError");
		};

		await expect(
			searchKeenable({
				...makeParams("ai chips"),
				recency: "day",
				signal: ac.signal,
				timeoutMs: 60_000,
				fetch: fetchMock,
			}),
		).rejects.toThrow("user-cancel");
	});

	it("preserves explicit after:/before: bounds when results are empty", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBodies.push(JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchKeenable({
			...makeParams("ai chips after:2026-01-01 before:2026-02-01"),
			recency: "day",
			fetch: fetchMock,
		});

		expect(requestBodies).toEqual([
			{
				query: "ai chips",
				max_results: 10,
				published_after: "2026-01-01",
				published_before: "2026-02-01",
			},
		]);
		expect(response.sources).toEqual([]);
	});

	it("uses the public search endpoint when no credential is configured", async () => {
		delete process.env.KEENABLE_API_KEY;
		let requestUrl = "";
		let requestHeaders: Headers | undefined;
		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			requestHeaders = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [{ title: "Public", url: "https://example.com/public" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchKeenable({
			...makeParams("public search"),
			fetch: fetchMock,
		});

		expect(requestUrl).toBe(KEENABLE_SEARCH_PUBLIC_URL);
		expect(requestHeaders?.get("x-api-key")).toBeNull();
		expect(requestHeaders?.get("x-keenable-title")).toBe(APP_NAME);
		expect(response.authMode).toBe("keyless");
	});

	it("surfaces classified 402 credit exhaustion", async () => {
		const fetchMock = async (): Promise<Response> => new Response("no credits available", { status: 402 });

		await expect(searchKeenable({ ...makeParams("quota"), fetch: fetchMock })).rejects.toEqual(
			expect.objectContaining({
				provider: "keenable",
				status: 402,
				message: "keenable: 402 credits exhausted",
			}) satisfies Partial<SearchProviderError>,
		);
	});

	it("rejects auto-chain admission without credentials", () => {
		delete process.env.KEENABLE_API_KEY;
		expect(new KeenableProvider().isAvailable(fakeAuthStorage)).toBe(false);
	});

	it("admits the auto chain when KEENABLE_API_KEY is set", () => {
		expect(new KeenableProvider().isAvailable(fakeAuthStorage)).toBe(true);
	});

	it("stays explicitly available without credentials for the public pool", () => {
		delete process.env.KEENABLE_API_KEY;
		expect(new KeenableProvider().isExplicitlyAvailable(fakeAuthStorage)).toBe(true);
	});
});
