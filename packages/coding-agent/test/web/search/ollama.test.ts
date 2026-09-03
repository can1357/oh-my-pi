import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { OllamaProvider, searchOllama } from "@oh-my-pi/pi-coding-agent/web/search/providers/ollama";
import { parseSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search/query";

const OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";

/** Build a fake AuthStorage that resolves an API key (or undefined). */
function makeAuthStorage(apiKey: string | undefined): AuthStorage {
	return {
		async getApiKey() {
			return apiKey;
		},
		resolver: vi.fn(() => async () => apiKey),
		hasAuth() {
			return Boolean(apiKey);
		},
	} as unknown as AuthStorage;
}

/** Build standard search params with sensible defaults. */
function makeParams(query: string, extras: Record<string, unknown> = {}) {
	return {
		query,
		authStorage: makeAuthStorage("test-key"),
		systemPrompt: "Ollama test prompt",
		...extras,
	};
}

/** Extract URL from fetch input (string | URL | Request). */
function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

describe("Ollama searchOllama request shape", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("POSTs to the Ollama web_search endpoint with Bearer auth and JSON body", async () => {
		let capturedInit: RequestInit | undefined;
		let capturedUrl: string | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			capturedUrl = urlOf(input);
			capturedInit = init;
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchOllama({ ...makeParams("what is ollama?"), fetch: fetchMock });

		expect(capturedUrl).toBe(OLLAMA_SEARCH_URL);
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-key");
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("sends query and max_results in the request body", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchOllama({ ...makeParams("rust async"), numSearchResults: 7, fetch: fetchMock });

		expect(capturedBody?.query).toBe("rust async");
		expect(capturedBody?.max_results).toBe(7);
	});

	it("formats queries containing directives (phrases, negation, site)", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchOllama({
			...makeParams('"machine learning" site:arxiv.org -deprecated python'),
			fetch: fetchMock,
		});

		expect(capturedBody?.query).toContain('"machine learning"');
		expect(capturedBody?.query).toContain("site:arxiv.org");
		expect(capturedBody?.query).toContain("-deprecated");
		expect(capturedBody?.query).toContain("python");
	});

	it("uses pre-parsed query when provided", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const parsedQuery = parseSearchQuery('"large language model" -obsolete site:ollama.com llama');

		await searchOllama({
			...makeParams("raw text that should be ignored", { parsedQuery }),
			fetch: fetchMock,
		});

		expect(capturedBody?.query).toContain('"large language model"');
		expect(capturedBody?.query).toContain("-obsolete");
		expect(capturedBody?.query).toContain("site:ollama.com");
		expect(capturedBody?.query).toContain("llama");
	});

	it("defaults max_results to 5 when no count is specified", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchOllama({ ...makeParams("test query"), fetch: fetchMock });

		expect(capturedBody?.max_results).toBe(5);
	});

	it("clamps max_results to the documented maximum of 10", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchOllama({ ...makeParams("test"), numSearchResults: 50, fetch: fetchMock });

		expect(capturedBody?.max_results).toBe(10);
	});

	it("falls back to default 5 when numSearchResults is 0", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchOllama({ ...makeParams("test"), numSearchResults: 0, fetch: fetchMock });

		expect(capturedBody?.max_results).toBe(5);
	});

	it("clamps max_results to minimum 1 for negative values", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchOllama({ ...makeParams("test"), numSearchResults: -1, fetch: fetchMock });

		expect(capturedBody?.max_results).toBe(1);
	});

	it("prefers numSearchResults over limit when both are set", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchOllama({
			...makeParams("test"),
			numSearchResults: 3,
			limit: 8,
			fetch: fetchMock,
		});

		expect(capturedBody?.max_results).toBe(3);
	});

	it("uses limit when numSearchResults is absent", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchOllama({ ...makeParams("test"), limit: 8, fetch: fetchMock });

		expect(capturedBody?.max_results).toBe(8);
	});
});

describe("Ollama searchOllama response mapping", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("maps results to SearchSource with title, url, and content→snippet", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					results: [
						{
							title: "Ollama",
							url: "https://ollama.com/",
							content: "Cloud models are now available...",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchOllama({ ...makeParams("what is ollama?"), fetch: fetchMock });

		expect(response.provider).toBe("ollama");
		expect(response.authMode).toBe("api_key");
		expect(response.answer).toBeUndefined();
		expect(response.relatedQuestions).toBeUndefined();
		expect(response.sources).toEqual([
			{
				title: "Ollama",
				url: "https://ollama.com/",
				snippet: "Cloud models are now available...",
				publishedDate: undefined,
				ageSeconds: undefined,
			},
		]);
	});

	it("uses url as title when title is missing or empty", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					results: [
						{ url: "https://example.com/no-title" },
						{ title: "", url: "https://example.com/empty-title", content: "text" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchOllama({ ...makeParams("test"), fetch: fetchMock });

		expect(response.sources).toHaveLength(2);
		expect(response.sources[0]?.title).toBe("https://example.com/no-title");
		expect(response.sources[1]?.title).toBe("https://example.com/empty-title");
	});

	it("skips results with missing or non-string url", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					results: [
						{ title: "Valid", url: "https://example.com/valid", content: "ok" },
						{ title: "No URL" },
						{ title: "Bad URL", url: 42 },
						{ title: "Empty URL", url: "" },
						{ title: "Null URL", url: null },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchOllama({ ...makeParams("test"), fetch: fetchMock });

		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]?.url).toBe("https://example.com/valid");
	});

	it("handles missing content field gracefully (snippet undefined)", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					results: [{ title: "No Content", url: "https://example.com/no-content" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchOllama({ ...makeParams("test"), fetch: fetchMock });

		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]?.snippet).toBeUndefined();
	});

	it("handles non-string content field gracefully", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					results: [{ title: "Bad Content", url: "https://example.com/bad", content: 123 }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchOllama({ ...makeParams("test"), fetch: fetchMock });

		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]?.snippet).toBeUndefined();
	});

	it("returns empty sources array when results is missing", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const response = await searchOllama({ ...makeParams("test"), fetch: fetchMock });

		expect(response.sources).toEqual([]);
	});

	it("returns empty sources array when results is null", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ results: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const response = await searchOllama({ ...makeParams("test"), fetch: fetchMock });

		expect(response.sources).toEqual([]);
	});

	it("slices sources to the requested max_results count", async () => {
		const results = Array.from({ length: 8 }, (_, i) => ({
			title: `Result ${i}`,
			url: `https://example.com/${i}`,
			content: `content ${i}`,
		}));
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ results }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const response = await searchOllama({
			...makeParams("test"),
			numSearchResults: 3,
			fetch: fetchMock,
		});

		expect(response.sources).toHaveLength(3);
		expect(response.sources[0]?.title).toBe("Result 0");
		expect(response.sources[2]?.title).toBe("Result 2");
	});
});

describe("Ollama searchOllama error handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("throws SearchProviderError with 401 status on unauthorized", async () => {
		const fetchMock: FetchImpl = async () => new Response("Unauthorized", { status: 401 });

		const promise = searchOllama({ ...makeParams("test"), fetch: fetchMock });

		const error = await promise.catch(e => e);
		expect(error).toBeInstanceOf(Error);
		expect(error.status).toBe(401);
		expect(error.provider).toBe("ollama");
	});

	it("throws SearchProviderError with 403 status on forbidden", async () => {
		const fetchMock: FetchImpl = async () => new Response("Forbidden", { status: 403 });

		const promise = searchOllama({ ...makeParams("test"), fetch: fetchMock });

		const error = await promise.catch(e => e);
		expect(error.status).toBe(403);
		expect(error.provider).toBe("ollama");
	});

	it("throws SearchProviderError with 402 status on credits exhausted", async () => {
		const fetchMock: FetchImpl = async () => new Response("credits exhausted", { status: 402 });

		const promise = searchOllama({ ...makeParams("test"), fetch: fetchMock });

		const error = await promise.catch(e => e);
		expect(error.status).toBe(402);
		expect(error.provider).toBe("ollama");
	});

	it("throws SearchProviderError on HTTP 500 with body text", async () => {
		const fetchMock: FetchImpl = async () => new Response("Internal Server Error", { status: 500 });

		const promise = searchOllama({ ...makeParams("test"), fetch: fetchMock });

		const error = await promise.catch(e => e);
		expect(error.status).toBe(500);
		expect(error.provider).toBe("ollama");
		expect(error.message).toContain("500");
	});

	it("throws SearchProviderError on invalid JSON response", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response("not json at all", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const promise = searchOllama({ ...makeParams("test"), fetch: fetchMock });

		const error = await promise.catch(e => e);
		expect(error.provider).toBe("ollama");
		expect(error.message).toMatch(/invalid JSON/i);
	});

	it("throws SearchProviderError when response body exceeds 2 MiB", async () => {
		const chunk = new Uint8Array(1024 * 1024);
		let sentChunks = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sentChunks < 3) {
					controller.enqueue(chunk);
					sentChunks++;
				} else {
					controller.close();
				}
			},
		});
		const fetchMock: FetchImpl = async () =>
			new Response(stream, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const promise = searchOllama({ ...makeParams("test"), fetch: fetchMock });

		const error = await promise.catch(e => e);
		expect(error.provider).toBe("ollama");
		expect(error.status).toBe(500);
		expect(error.message).toContain("exceeded 2 MiB");
	});
});

describe("Ollama searchOllama auth resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("throws when no API key is available", async () => {
		const noKeyStorage = makeAuthStorage(undefined);
		const fetchMock: FetchImpl = async () => new Response("{}", { status: 200 });

		const promise = searchOllama({
			query: "test",
			authStorage: noKeyStorage,
			systemPrompt: "",
			fetch: fetchMock,
		});

		const error = await promise.catch(e => e);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/OLLAMA_CLOUD_API_KEY/i);
	});

	it("resolves credentials for ollama-cloud provider", async () => {
		const resolverMock = vi.fn(() => async () => "test-key");
		const authStorage = {
			resolver: resolverMock,
			hasAuth: vi.fn(() => true),
		} as unknown as AuthStorage;
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		await searchOllama({ ...makeParams("test"), authStorage, fetch: fetchMock });

		expect(resolverMock).toHaveBeenCalledWith("ollama-cloud", expect.any(Object));
	});
});

describe("OllamaProvider", () => {
	const availableStorage = makeAuthStorage("test-key");
	const unavailableStorage = makeAuthStorage(undefined);

	it("is available when authStorage has credentials", () => {
		const hasAuthMock = vi.fn((provider: string) => provider === "ollama-cloud");
		const authStorage = { hasAuth: hasAuthMock } as unknown as AuthStorage;
		expect(new OllamaProvider().isAvailable(authStorage)).toBe(true);
		expect(hasAuthMock).toHaveBeenCalledWith("ollama-cloud");
	});

	it("is not available when no credential exists", () => {
		expect(new OllamaProvider().isAvailable(unavailableStorage)).toBe(false);
	});

	it("delegates isExplicitlyAvailable to isAvailable", () => {
		expect(new OllamaProvider().isExplicitlyAvailable(availableStorage)).toBe(true);
		expect(new OllamaProvider().isExplicitlyAvailable(unavailableStorage)).toBe(false);
	});
});
