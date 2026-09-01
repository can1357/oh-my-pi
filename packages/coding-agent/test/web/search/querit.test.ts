import { describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { searchQuerit } from "@oh-my-pi/pi-coding-agent/web/search/providers/querit";

const TEST_API_KEY = "test-querit-key";

function makeAuthStorage(apiKey: string | undefined): AuthStorage {
	return {
		resolver() {
			return async () => apiKey;
		},
		hasAuth() {
			return apiKey !== undefined;
		},
	} as unknown as AuthStorage;
}

function makeRotatingAuthStorage(keys: string[]): AuthStorage {
	return {
		resolver() {
			return async ({ error, lastChance }: { error?: unknown; lastChance?: boolean }) => {
				if (error === undefined || !lastChance) return keys[0];
				return keys[1];
			};
		},
		hasAuth() {
			return keys.length > 0;
		},
	} as unknown as AuthStorage;
}

function makeParams(query: string, apiKey: string | null = TEST_API_KEY) {
	return {
		query,
		authStorage: makeAuthStorage(apiKey ?? undefined),
		systemPrompt: "Querit provider test prompt",
		sessionId: "querit-test-session",
	};
}

function headerValue(headers: RequestInit["headers"], name: string): string | null {
	return new Headers(headers).get(name);
}

describe("Querit web search provider", () => {
	it("leaves Querit filters at their broad defaults", async () => {
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		let capturedBody: unknown;
		const fetchMock: FetchImpl = async (input, init) => {
			capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			capturedInit = init;
			capturedBody = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ results: { result: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchQuerit({
			...makeParams(
				'"agent search" site:docs.example.com -site:reddit.com after:2026-01-01 before:2026-08-01 lang:en',
			),
			recency: "week",
			numSearchResults: 99,
			fetch: fetchMock,
		});

		expect(capturedUrl).toBe("https://api.querit.ai/v1/search");
		expect(capturedInit?.method).toBe("POST");
		expect(headerValue(capturedInit?.headers, "Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
		expect(headerValue(capturedInit?.headers, "Accept")).toBe("application/json");
		expect(headerValue(capturedInit?.headers, "Content-Type")).toBe("application/json");
		expect(capturedBody).toEqual({
			query: '"agent search" site:docs.example.com -site:reddit.com after:2026-01-01 before:2026-08-01 lang:en',
			count: 20,
		});
	});

	it("normalizes valid sources and discards duplicate or unsafe URLs", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					error_code: "200",
					search_id: "query-123",
					results: {
						result: [
							{
								title: "Querit docs",
								url: "https://example.com/docs",
								snippet: "Primary result",
								page_age: "2026-01-01T00:00:00Z",
								site_name: "Example",
							},
							{ title: "Duplicate", url: "https://example.com/docs", snippet: "Ignored" },
							{ url: "https://example.com/untitled" },
							{ title: "Unsafe", url: "javascript:alert(1)" },
							{ title: "Missing URL" },
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchQuerit({ ...makeParams("querit docs"), fetch: fetchMock });

		expect(response.provider).toBe("querit");
		expect(response.requestId).toBe("query-123");
		expect(response.authMode).toBe("api_key");
		expect(response.sources).toEqual([
			{
				title: "Querit docs",
				url: "https://example.com/docs",
				snippet: "Primary result",
				publishedDate: "2026-01-01T00:00:00Z",
				ageSeconds: expect.any(Number),
				author: "Example",
			},
			{
				title: "https://example.com/untitled",
				url: "https://example.com/untitled",
				snippet: undefined,
				publishedDate: undefined,
				ageSeconds: undefined,
				author: undefined,
			},
		]);
		expect(response.sources[0]?.ageSeconds).toBeGreaterThan(0);
	});

	it("surfaces Querit body errors returned with HTTP 200", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ error_code: "429", error_msg: "Daily quota exceeded" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		await expect(searchQuerit({ ...makeParams("quota"), fetch: fetchMock })).rejects.toMatchObject({
			name: "SearchProviderError",
			provider: "querit",
			status: 429,
			message: "querit: credits exhausted",
		});
	});

	it("classifies rejected credentials", async () => {
		const fetchMock: FetchImpl = async () => new Response("invalid key", { status: 401 });

		await expect(searchQuerit({ ...makeParams("auth"), fetch: fetchMock })).rejects.toMatchObject({
			name: "SearchProviderError",
			provider: "querit",
			status: 401,
			message: "querit: 401 unauthorized",
		});
	});

	it("rotates to a sibling credential after an HTTP 200 body 401", async () => {
		const firstKey = "querit-key-a";
		const secondKey = "querit-key-b";
		const bearers: string[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			const bearer = headerValue(init?.headers, "Authorization") ?? "";
			bearers.push(bearer);
			if (bearer === `Bearer ${firstKey}`) {
				return new Response(JSON.stringify({ error_code: 401, error_msg: "invalid api key" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					error_code: 200,
					results: { result: [{ title: "Sibling hit", url: "https://example.com/ok" }] },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchQuerit({
			query: "rotate",
			authStorage: makeRotatingAuthStorage([firstKey, secondKey]),
			systemPrompt: "Querit provider test prompt",
			sessionId: "querit-test-session",
			fetch: fetchMock,
		});

		expect(bearers).toEqual([`Bearer ${firstKey}`, `Bearer ${secondKey}`]);
		expect(response.provider).toBe("querit");
		expect(response.sources).toEqual([
			{
				title: "Sibling hit",
				url: "https://example.com/ok",
				snippet: undefined,
				publishedDate: undefined,
				ageSeconds: undefined,
				author: undefined,
			},
		]);
	});

	it("rejects malformed result envelopes", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		await expect(searchQuerit({ ...makeParams("malformed"), fetch: fetchMock })).rejects.toThrow(
			"Querit Search API returned an unexpected response shape",
		);
	});

	it("fails before transport when no credential resolves", async () => {
		const fetchMock: FetchImpl = async () => {
			throw new Error("transport must not run without a credential");
		};

		await expect(searchQuerit({ ...makeParams("missing key", null), fetch: fetchMock })).rejects.toThrow(
			"Set QUERIT_API_KEY",
		);
	});
});
