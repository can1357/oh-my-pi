import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { resolveFirecrawlUrl } from "@oh-my-pi/pi-coding-agent/web/firecrawl";
import { FirecrawlProvider, searchFirecrawl } from "@oh-my-pi/pi-coding-agent/web/search/providers/firecrawl";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

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
	it("maps before:/after: to a cdr tbs and strips dates from the operator query", async () => {
		const captured: { body?: unknown } = {};
		const fetchMock: FetchImpl = async (_input, init) => {
			captured.body = JSON.parse(String(init?.body ?? "null")) as unknown;
			return new Response(JSON.stringify({ data: { web: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchFirecrawl({
			...makeParams("bun runtime site:github.com/oven-sh intitle:install after:2024-01-01 before:2024-06-30"),
			recency: "month",
			fetch: fetchMock,
		});

		expect(captured.body).toEqual({
			query: "bun runtime site:github.com/oven-sh intitle:install",
			limit: 10,
			sources: [{ type: "web" }],
			// Explicit absolute bounds take precedence over the qdr:m recency window.
			tbs: "cdr:1,cd_min:01/01/2024,cd_max:06/30/2024",
		});
	});

	it("re-emits non-date operators in the query while keeping recency tbs", async () => {
		const captured: { body?: unknown } = {};
		const fetchMock: FetchImpl = async (_input, init) => {
			captured.body = JSON.parse(String(init?.body ?? "null")) as unknown;
			return new Response(JSON.stringify({ data: { web: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchFirecrawl({
			...makeParams('"exact phrase" -site:reddit.com filetype:pdf'),
			recency: "week",
			fetch: fetchMock,
		});

		expect(captured.body).toEqual({
			query: '"exact phrase" -site:reddit.com filetype:pdf',
			limit: 10,
			sources: [{ type: "web" }],
			tbs: "qdr:w",
		});
	});

	it("uses the initially resolved credential for the first authenticated request", async () => {
		let resolutionCount = 0;
		const authStorage = {
			resolver(provider: string, options?: { sessionId?: string }) {
				expect(provider).toBe("firecrawl");
				expect(options?.sessionId).toBe("session-firecrawl-test");
				return async () => {
					resolutionCount += 1;
					return resolutionCount === 1 ? "initial-firecrawl-key" : undefined;
				};
			},
		} as unknown as AuthStorage;
		const fetchMock: FetchImpl = async (_input, init) => {
			expect(getHeader(init?.headers, "Authorization")).toBe("Bearer initial-firecrawl-key");
			return new Response(JSON.stringify({ data: { web: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchFirecrawl({
			...makeParams("credential reuse", authStorage),
			fetch: fetchMock,
		});

		expect(response.authMode).toBe("api_key");
		expect(resolutionCount).toBe(1);
	});

	it("retries with a rotated credential after the seeded key is rejected", async () => {
		const resolvedKeys = ["initial-firecrawl-key", "rotated-firecrawl-key"] as const;
		let resolutionCount = 0;
		const authStorage = {
			resolver(provider: string, options?: { sessionId?: string }) {
				expect(provider).toBe("firecrawl");
				expect(options?.sessionId).toBe("session-firecrawl-test");
				return async () => resolvedKeys[resolutionCount++];
			},
		} as unknown as AuthStorage;
		const authorizationHeaders: Array<string | null> = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			authorizationHeaders.push(getHeader(init?.headers, "Authorization"));
			if (authorizationHeaders.length === 1) {
				return new Response("credential rejected", { status: 401 });
			}
			if (authorizationHeaders.length === 2) {
				return new Response(JSON.stringify({ id: "rotated-firecrawl-request", data: { web: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error("unexpected Firecrawl request");
		};

		const response = await searchFirecrawl({
			...makeParams("credential rotation", authStorage),
			fetch: fetchMock,
		});

		expect(authorizationHeaders).toEqual(["Bearer initial-firecrawl-key", "Bearer rotated-firecrawl-key"]);
		expect(resolutionCount).toBe(2);
		expect(response).toMatchObject({
			requestId: "rotated-firecrawl-request",
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

	it("keeps hosted keyless Firecrawl explicit-only but admits configured self-hosting", () => {
		const originalApiKey = process.env.FIRECRAWL_API_KEY;
		const originalBaseUrl = process.env.FIRECRAWL_BASE_URL;
		const originalApiUrl = process.env.FIRECRAWL_API_URL;
		delete process.env.FIRECRAWL_API_KEY;
		delete process.env.FIRECRAWL_BASE_URL;
		delete process.env.FIRECRAWL_API_URL;
		try {
			const provider = new FirecrawlProvider();
			const authStorage = makeAuthStorage(undefined);

			expect(provider.isAvailable(authStorage)).toBe(false);
			expect(provider.isExplicitlyAvailable(authStorage)).toBe(true);
			process.env.FIRECRAWL_BASE_URL = "http://localhost:3002";
			expect(provider.isAvailable(authStorage)).toBe(true);
		} finally {
			if (originalApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
			else process.env.FIRECRAWL_API_KEY = originalApiKey;
			if (originalBaseUrl === undefined) delete process.env.FIRECRAWL_BASE_URL;
			else process.env.FIRECRAWL_BASE_URL = originalBaseUrl;
			if (originalApiUrl === undefined) delete process.env.FIRECRAWL_API_URL;
			else process.env.FIRECRAWL_API_URL = originalApiUrl;
		}
	});

	it("uses a self-hosted endpoint and accepts Firecrawl v1 array responses", async () => {
		const originalBaseUrl = process.env.FIRECRAWL_BASE_URL;
		process.env.FIRECRAWL_BASE_URL = "http://localhost:3002/v1/";
		let requestUrl = "";
		try {
			const fetchMock: FetchImpl = async input => {
				requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				return new Response(
					JSON.stringify({
						success: true,
						data: [{ title: "Legacy result", url: "https://example.com/legacy", snippet: "Legacy snippet" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			};
			const response = await searchFirecrawl({
				...makeParams("legacy query", makeAuthStorage(undefined)),
				fetch: fetchMock,
			});

			expect(requestUrl).toBe("http://localhost:3002/v1/search");
			expect(response.sources).toEqual([
				{ title: "Legacy result", url: "https://example.com/legacy", snippet: "Legacy snippet" },
			]);
		} finally {
			if (originalBaseUrl === undefined) delete process.env.FIRECRAWL_BASE_URL;
			else process.env.FIRECRAWL_BASE_URL = originalBaseUrl;
		}
	});

	it("uses keyless mode when no API key is configured (no Authorization header)", async () => {
		const captured: { url?: string; init?: RequestInit; body?: unknown } = {};

		const fetchMock: FetchImpl = async (input, init) => {
			captured.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			captured.init = init;
			captured.body = JSON.parse(String(init?.body ?? "null")) as unknown;
			return new Response(
				JSON.stringify({
					id: "keyless-request-456",
					data: {
						web: [
							{
								title: "Keyless result",
								url: "https://example.com/keyless",
								description: "Result from keyless Firecrawl",
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchFirecrawl({
			...makeParams("keyless query", makeAuthStorage(undefined)),
			fetch: fetchMock,
		});

		expect(captured.url).toBe("https://api.firecrawl.dev/v2/search");
		expect(captured.init?.method).toBe("POST");
		expect(getHeader(captured.init?.headers, "Authorization")).toBeNull();
		expect(getHeader(captured.init?.headers, "Content-Type")).toBe("application/json");
		expect(response).toEqual({
			provider: "firecrawl",
			sources: [
				{
					title: "Keyless result",
					url: "https://example.com/keyless",
					snippet: "Result from keyless Firecrawl",
				},
			],
			requestId: "keyless-request-456",
			authMode: "keyless",
		});
	});
});

describe("resolveFirecrawlUrl", () => {
	const withBaseUrl = (baseUrl: string | undefined, run: () => void): void => {
		const originalBaseUrl = process.env.FIRECRAWL_BASE_URL;
		const originalApiUrl = process.env.FIRECRAWL_API_URL;
		delete process.env.FIRECRAWL_API_URL;
		if (baseUrl === undefined) delete process.env.FIRECRAWL_BASE_URL;
		else process.env.FIRECRAWL_BASE_URL = baseUrl;
		try {
			run();
		} finally {
			if (originalBaseUrl === undefined) delete process.env.FIRECRAWL_BASE_URL;
			else process.env.FIRECRAWL_BASE_URL = originalBaseUrl;
			if (originalApiUrl === undefined) delete process.env.FIRECRAWL_API_URL;
			else process.env.FIRECRAWL_API_URL = originalApiUrl;
		}
	};

	it("defaults to the hosted v2 API when no base URL is configured", () => {
		withBaseUrl(undefined, () => {
			expect(resolveFirecrawlUrl("/search")).toBe("https://api.firecrawl.dev/v2/search");
			expect(resolveFirecrawlUrl("/scrape")).toBe("https://api.firecrawl.dev/v2/scrape");
		});
	});

	it("appends /v2 without doubling the slash for a bare self-hosted origin", () => {
		withBaseUrl("http://localhost:3002", () => {
			expect(resolveFirecrawlUrl("/search")).toBe("http://localhost:3002/v2/search");
			expect(resolveFirecrawlUrl("/scrape")).toBe("http://localhost:3002/v2/scrape");
		});
	});

	it("appends /v2 without doubling the slash for a bare origin with a trailing slash", () => {
		withBaseUrl("http://localhost:3002/", () => {
			expect(resolveFirecrawlUrl("/search")).toBe("http://localhost:3002/v2/search");
			expect(resolveFirecrawlUrl("/scrape")).toBe("http://localhost:3002/v2/scrape");
		});
	});

	it("preserves an explicitly configured API version", () => {
		withBaseUrl("http://localhost:3002/v1/", () => {
			expect(resolveFirecrawlUrl("/search")).toBe("http://localhost:3002/v1/search");
			expect(resolveFirecrawlUrl("/scrape")).toBe("http://localhost:3002/v1/scrape");
		});
	});

	it("keeps a path prefix and appends /v2 under it", () => {
		withBaseUrl("http://localhost:3002/firecrawl/", () => {
			expect(resolveFirecrawlUrl("/search")).toBe("http://localhost:3002/firecrawl/v2/search");
			expect(resolveFirecrawlUrl("/scrape")).toBe("http://localhost:3002/firecrawl/v2/scrape");
		});
	});

	it("rejects a non-HTTP base URL or one carrying credentials", () => {
		withBaseUrl("ftp://localhost:3002", () => {
			expect(() => resolveFirecrawlUrl("/scrape")).toThrow("expected an HTTP or HTTPS URL");
		});
		withBaseUrl("http://user:pass@localhost:3002", () => {
			expect(() => resolveFirecrawlUrl("/scrape")).toThrow("URL credentials are not allowed");
		});
	});
});
