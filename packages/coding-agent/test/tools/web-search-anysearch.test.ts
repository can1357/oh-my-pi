import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { AnySearchProvider, searchAnysearch } from "@oh-my-pi/pi-coding-agent/web/search/providers/anysearch";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const TEST_KEY = "test-anysearch-key";

function makeAuthStorage(apiKey: string | undefined): AuthStorage {
	return {
		resolver(provider: string, options?: { sessionId?: string }) {
			expect(provider).toBe("anysearch");
			expect(options?.sessionId).toBe("session-anysearch-test");
			return async () => apiKey;
		},
		hasAuth(provider: string) {
			return provider === "anysearch" && Boolean(apiKey);
		},
	} as unknown as AuthStorage;
}

function makeParams(query: string, authStorage: AuthStorage = makeAuthStorage(TEST_KEY)) {
	return {
		query,
		authStorage,
		systemPrompt: "AnySearch test prompt",
		sessionId: "session-anysearch-test",
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

function okEnvelope(results: Array<Record<string, unknown>> = []) {
	return {
		code: 0,
		message: "ok",
		data: { results, metadata: { search_time_ms: 12 } },
	};
}

describe("AnySearch web search provider", () => {
	it("sends a keyless POST without Authorization", async () => {
		const captured: { url?: string; init?: RequestInit; body?: unknown } = {};

		const fetchMock: FetchImpl = async (input, init) => {
			captured.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			captured.init = init;
			captured.body = JSON.parse(String(init?.body ?? "null")) as unknown;
			return new Response(
				JSON.stringify(
					okEnvelope([
						{
							title: "Anonymous result",
							url: "https://example.com/anon",
							snippet: "From anonymous AnySearch",
						},
					]),
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchAnysearch({
			...makeParams("anonymous query", makeAuthStorage(undefined)),
			fetch: fetchMock,
		});

		expect(captured.url).toBe("https://api.anysearch.com/v1/search");
		expect(captured.init?.method).toBe("POST");
		expect(getHeader(captured.init?.headers, "Authorization")).toBeNull();
		expect(getHeader(captured.init?.headers, "Content-Type")).toBe("application/json");
		expect(captured.body).toEqual({
			query: "anonymous query",
			max_results: 10,
		});
		expect(response).toEqual({
			provider: "anysearch",
			sources: [
				{
					title: "Anonymous result",
					url: "https://example.com/anon",
					snippet: "From anonymous AnySearch",
				},
			],
			authMode: "anonymous",
		});
	});

	it("sends Bearer when an API key resolves", async () => {
		const captured: { init?: RequestInit; body?: unknown } = {};

		const fetchMock: FetchImpl = async (_input, init) => {
			captured.init = init;
			captured.body = JSON.parse(String(init?.body ?? "null")) as unknown;
			return new Response(
				JSON.stringify(
					okEnvelope([
						{
							title: "Keyed result",
							url: "https://example.com/keyed",
							snippet: "From keyed AnySearch",
						},
					]),
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchAnysearch({
			...makeParams("keyed query"),
			numSearchResults: 3,
			fetch: fetchMock,
		});

		expect(getHeader(captured.init?.headers, "Authorization")).toBe(`Bearer ${TEST_KEY}`);
		expect(captured.body).toEqual({
			query: "keyed query",
			max_results: 3,
		});
		expect(response.authMode).toBe("api_key");
		expect(response.sources).toEqual([
			{
				title: "Keyed result",
				url: "https://example.com/keyed",
				snippet: "From keyed AnySearch",
			},
		]);
	});

	it("does not fall back to anonymous after HTTP 401", async () => {
		const authorizationHeaders: Array<string | null> = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			authorizationHeaders.push(getHeader(init?.headers, "Authorization"));
			return new Response("invalid key", { status: 401 });
		};

		try {
			await searchAnysearch({ ...makeParams("bad auth"), fetch: fetchMock });
			expect.unreachable("expected searchAnysearch to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "anysearch",
				status: 401,
				message: "anysearch: 401 unauthorized",
			});
		}

		expect(authorizationHeaders.length).toBeGreaterThan(0);
		expect(authorizationHeaders.every(header => header === `Bearer ${TEST_KEY}`)).toBe(true);
	});

	it("throws on a non-zero API code", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					code: 1001,
					message: "quota exceeded",
					data: { results: [] },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		try {
			await searchAnysearch({ ...makeParams("quota"), fetch: fetchMock });
			expect.unreachable("expected searchAnysearch to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "anysearch", message: "quota exceeded" });
			expect((error as SearchProviderError).status).toBeUndefined();
		}
	});

	it("returns empty sources when the API returns no results", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify(okEnvelope([])), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const response = await searchAnysearch({
			...makeParams("empty query"),
			fetch: fetchMock,
		});

		expect(response).toEqual({
			provider: "anysearch",
			sources: [],
			authMode: "api_key",
		});
	});

	it.each([
		[undefined, 10],
		[0, 10],
		[1, 1],
		[10, 10],
		[11, 10],
		[100, 10],
	] as const)("clamps max_results from %s to %d", async (requested, expected) => {
		let body: unknown;
		const fetchMock: FetchImpl = async (_input, init) => {
			body = JSON.parse(String(init?.body ?? "null")) as unknown;
			return new Response(JSON.stringify(okEnvelope([])), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchAnysearch({
			...makeParams("clamp query"),
			numSearchResults: requested,
			fetch: fetchMock,
		});

		expect(body).toEqual({
			query: "clamp query",
			max_results: expected,
		});
	});

	it("falls back from snippet to content", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify(
					okEnvelope([
						{
							title: "Snippet result",
							url: "https://example.com/snippet",
							snippet: "Preferred snippet",
							content: "Ignored content",
						},
						{
							title: "Content result",
							url: "https://example.com/content",
							snippet: null,
							content: "Content fallback snippet",
						},
						{
							url: "https://example.com/untitled",
							content: "Untitled content",
						},
					]),
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchAnysearch({
			...makeParams("snippet query"),
			fetch: fetchMock,
		});

		expect(response.sources).toEqual([
			{
				title: "Snippet result",
				url: "https://example.com/snippet",
				snippet: "Preferred snippet",
			},
			{
				title: "Content result",
				url: "https://example.com/content",
				snippet: "Content fallback snippet",
			},
			{
				title: "https://example.com/untitled",
				url: "https://example.com/untitled",
				snippet: "Untitled content",
			},
		]);
	});

	it("joins the auto chain only with a credential; explicit selection works keyless", () => {
		const provider = new AnySearchProvider();
		const originalEnvKey = process.env.ANYSEARCH_API_KEY;
		delete process.env.ANYSEARCH_API_KEY;
		try {
			const keyless = makeAuthStorage(undefined);
			expect(provider.isAvailable(keyless)).toBe(false);
			expect(provider.isExplicitlyAvailable(keyless)).toBe(true);

			const keyed = makeAuthStorage(TEST_KEY);
			expect(provider.isAvailable(keyed)).toBe(true);

			process.env.ANYSEARCH_API_KEY = TEST_KEY;
			expect(provider.isAvailable(keyless)).toBe(true);
		} finally {
			if (originalEnvKey === undefined) delete process.env.ANYSEARCH_API_KEY;
			else process.env.ANYSEARCH_API_KEY = originalEnvKey;
		}
	});
});
