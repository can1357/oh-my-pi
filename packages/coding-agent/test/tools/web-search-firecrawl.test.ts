import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@pk-nerdsaver-ai/pi-ai";
import { searchFirecrawl } from "@pk-nerdsaver-ai/pi-coding-agent/web/search/providers/firecrawl";
import { SearchProviderError } from "@pk-nerdsaver-ai/pi-coding-agent/web/search/types";

const TEST_KEY = "test-firecrawl-key";

function makeAuthStorage(apiKey: string | undefined): AuthStorage {
	return {
		resolver(provider: string, options?: { sessionId?: string }) {
			expect(provider).toBe("firecrawl");
			expect(options?.sessionId).toBe("session-firecrawl-test");
			return async () => apiKey;
		},
		hasAuth(provider: string) {
			return provider === "firecrawl" && Boolean(apiKey);
		},
	} as unknown as AuthStorage;
}

function makeParams(query: string, authStorage: AuthStorage = makeAuthStorage(TEST_KEY)) {
	return {
		query,
		authStorage,
		systemPrompt: "Firecrawl test prompt",
		sessionId: "session-firecrawl-test",
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

describe("Firecrawl web search provider", () => {
	it("sends the Firecrawl POST request and maps web results", async () => {
		const captured: { url?: string; init?: RequestInit; body?: unknown } = {};

		const fetchMock: FetchImpl = async (input, init) => {
			captured.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			captured.init = init;
			captured.body = JSON.parse(String(init?.body ?? "null")) as unknown;
			return new Response(
				JSON.stringify({
					id: "firecrawl-request-123",
					data: {
						web: [
							{
								title: "Firecrawl result one",
								url: "https://example.com/one",
								description: "Description snippet",
								markdown: "Ignored markdown",
							},
							{
								title: "Firecrawl result two",
								url: "https://example.com/two",
								description: null,
								markdown: "Markdown fallback snippet",
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchFirecrawl({
			...makeParams("firecrawl query"),
			numSearchResults: 2,
			recency: "month",
			fetch: fetchMock,
		});

		expect(captured.url).toBe("https://api.firecrawl.dev/v2/search");
		expect(captured.init?.method).toBe("POST");
		expect(getHeader(captured.init?.headers, "Authorization")).toBe(`Bearer ${TEST_KEY}`);
		expect(getHeader(captured.init?.headers, "Content-Type")).toBe("application/json");
		expect(captured.body).toEqual({
			query: "firecrawl query",
			limit: 2,
			sources: [{ type: "web" }],
			tbs: "qdr:m",
		});
		expect(response).toEqual({
			provider: "firecrawl",
			sources: [
				{
					title: "Firecrawl result one",
					url: "https://example.com/one",
					snippet: "Description snippet",
				},
				{
					title: "Firecrawl result two",
					url: "https://example.com/two",
					snippet: "Markdown fallback snippet",
				},
			],
			requestId: "firecrawl-request-123",
			authMode: "api_key",
		});
	});

	it.each([
		[401, "firecrawl: 401 unauthorized"],
		[402, "firecrawl: 402 credits exhausted"],
	] as const)("maps HTTP %d to a SearchProviderError", async (status, message) => {
		const fetchMock: FetchImpl = async () => new Response("upstream rejected", { status });

		try {
			await searchFirecrawl({ ...makeParams("bad auth"), fetch: fetchMock });
			expect.unreachable("expected searchFirecrawl to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "firecrawl", status, message });
		}
	});

	it("throws a clear error when Firecrawl credentials are missing", async () => {
		const fetchMock: FetchImpl = async () => {
			throw new Error("fetch should not be called without credentials");
		};

		try {
			await searchFirecrawl({ ...makeParams("missing creds", makeAuthStorage(undefined)), fetch: fetchMock });
			expect.unreachable("expected searchFirecrawl to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(
				'Firecrawl credentials not found. Set FIRECRAWL_API_KEY or configure an API key for provider "firecrawl".',
			);
		}
	});
});
