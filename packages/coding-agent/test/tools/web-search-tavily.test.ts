import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { searchTavily, TavilyProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/tavily";
import type { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

describe("Tavily web search provider", () => {
	beforeEach(() => {
		process.env.TAVILY_API_KEY = "test-tavily-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.TAVILY_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.TAVILY_API_KEY);
		},
		resolver(_provider: string) {
			return async () => process.env.TAVILY_API_KEY ?? undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Tavily test prompt",
		} as const;
	}

	it("maps Tavily responses into SearchResponse and forwards recency filters", async () => {
		let requestBody: Record<string, unknown> | null = null;
		let requestHeaders: Headers | undefined;

		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			requestHeaders = new Headers(init?.headers);
			return new Response(
				JSON.stringify({
					answer: "Synthesized Tavily answer",
					request_id: "req-tavily-123",
					results: [
						{
							title: "Result One",
							url: "https://example.com/one",
							content: "First snippet",
							published_date: "2026-03-01T00:00:00Z",
						},
						{
							url: "https://example.com/two",
							content: "Second snippet",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchTavily({
			...makeParams("latest ai news"),
			numSearchResults: 2,
			recency: "week",
			fetch: fetchMock,
		});
		// Recency must not couple to topic — topic should be absent (Tavily defaults to general)
		expect(requestBody).toMatchObject({
			query: "latest ai news",
			max_results: 2,
			time_range: "week",
			include_answer: "advanced",
			include_raw_content: false,
		});
		expect(requestBody).not.toHaveProperty("topic");
		expect(requestHeaders?.get("Authorization")).toBe("Bearer test-tavily-key");
		expect(requestHeaders?.has("X-Tavily-Access-Mode")).toBe(false);
		expect(response).toMatchObject({
			provider: "tavily",
			answer: "Synthesized Tavily answer",
			requestId: "req-tavily-123",
			authMode: "api_key",
			sources: [
				{
					title: "Result One",
					url: "https://example.com/one",
					snippet: "First snippet",
					publishedDate: "2026-03-01T00:00:00Z",
				},
				{
					title: "https://example.com/two",
					url: "https://example.com/two",
					snippet: "Second snippet",
				},
			],
		});
		expect(response.sources[0]?.ageSeconds).toBeTypeOf("number");
	});

	it("retries recency-filtered empty responses without time_range", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const responses = [
			new Response(JSON.stringify({ answer: "", request_id: "empty-month", results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
			new Response(
				JSON.stringify({
					answer: "Fallback Tavily answer",
					request_id: "fallback-without-time-range",
					results: [
						{
							title: "Latest release notes",
							url: "https://example.com/release-notes",
							content: "Release note snippet",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		];

		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBodies.push(JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>);
			const response = responses.shift();
			if (!response) throw new Error("unexpected extra Tavily request");
			return response;
		};

		const response = await searchTavily({
			...makeParams("Oh My Pi omp latest release notes advisor"),
			numSearchResults: 5,
			recency: "month",
			fetch: fetchMock,
		});

		expect(requestBodies).toHaveLength(2);
		expect(requestBodies[0]).toMatchObject({
			query: "Oh My Pi omp latest release notes advisor",
			max_results: 5,
			time_range: "month",
		});
		expect(requestBodies[1]).toMatchObject({
			query: "Oh My Pi omp latest release notes advisor",
			max_results: 5,
		});
		expect(requestBodies[1]).not.toHaveProperty("time_range");
		expect(response).toMatchObject({
			provider: "tavily",
			answer: "Fallback Tavily answer",
			requestId: "fallback-without-time-range",
			sources: [
				{
					title: "Latest release notes",
					url: "https://example.com/release-notes",
					snippet: "Release note snippet",
				},
			],
		});
	});

	it("surfaces structured API errors", async () => {
		const fetchMock = (): Promise<Response> =>
			Promise.resolve(
				new Response(JSON.stringify({ detail: { error: "invalid api key" } }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
			);

		await expect(searchTavily({ ...makeParams("bad auth"), fetch: fetchMock })).rejects.toEqual(
			expect.objectContaining({
				provider: "tavily",
				status: 401,
				message: "tavily: 401 unauthorized",
			}) satisfies Partial<SearchProviderError>,
		);
	});

	it("retries with a rotated credential after the seeded key is rejected", async () => {
		const resolvedKeys = ["initial-tavily-key", "rotated-tavily-key"] as const;
		let resolutionCount = 0;
		const authStorage = {
			resolver(provider: string, options?: { sessionId?: string }) {
				expect(provider).toBe("tavily");
				expect(options?.sessionId).toBe("session-tavily-test");
				return async () => resolvedKeys[resolutionCount++];
			},
		} as unknown as AuthStorage;
		const authorizationHeaders: Array<string | null> = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			authorizationHeaders.push(new Headers(init?.headers).get("Authorization"));
			if (authorizationHeaders.length === 1) {
				return new Response("credential rejected", { status: 401 });
			}
			if (authorizationHeaders.length === 2) {
				return new Response(JSON.stringify({ request_id: "rotated-tavily-request", results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error("unexpected Tavily request");
		};

		const response = await searchTavily({
			...makeParams("credential rotation"),
			authStorage,
			sessionId: "session-tavily-test",
			fetch: fetchMock,
		});

		expect(authorizationHeaders).toEqual(["Bearer initial-tavily-key", "Bearer rotated-tavily-key"]);
		expect(resolutionCount).toBe(2);
		expect(response).toMatchObject({
			requestId: "rotated-tavily-request",
			authMode: "api_key",
		});
	});

	it("uses keyless access only when Tavily is explicitly selected without credentials", async () => {
		delete process.env.TAVILY_API_KEY;
		const provider = new TavilyProvider();
		expect(provider.isAvailable(fakeAuthStorage)).toBe(false);
		expect(provider.isExplicitlyAvailable(fakeAuthStorage)).toBe(true);

		let requestHeaders: Headers | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestHeaders = new Headers(init?.headers);
			return new Response(
				JSON.stringify({
					results: [{ title: "Keyless result", url: "https://example.com/keyless", content: "Free tier" }],
					request_id: "req-keyless-123",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchTavily({ ...makeParams("keyless search"), fetch: fetchMock });

		expect(requestHeaders?.has("Authorization")).toBe(false);
		expect(requestHeaders?.get("X-Client-Name")).toBe("oh-my-pi");
		expect(requestHeaders?.get("X-Client-Source")).toBe("oh-my-pi-keyless");
		expect(requestHeaders?.get("X-Tavily-Access-Mode")).toBe("keyless");
		expect(response).toMatchObject({
			provider: "tavily",
			authMode: "keyless",
			requestId: "req-keyless-123",
			sources: [{ title: "Keyless result", url: "https://example.com/keyless", snippet: "Free tier" }],
		});
	});
});
